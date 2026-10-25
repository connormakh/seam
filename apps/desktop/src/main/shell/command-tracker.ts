import { closeSync, existsSync, fstatSync, openSync, readSync, rmSync, watch, type FSWatcher } from 'node:fs'
import { basename, join } from 'node:path'
import type { CommandSummary } from '@shared/ipc'
import type { Tmux } from '../tmux/tmux'

/** A command run in a Seam shell, with the output captured once it finished. */
export interface CommandRecord {
  id: number
  terminalId: string
  command: string
  cwd: string
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  /** Absolute tmux history lines; output is [startLine, endLine). */
  startLine: number
  endLine: number | null
  /** Captured output, ANSI-free; null while running or when it could not be read. */
  output: string | null
  /** Lines of output dropped from the front because the command printed more than we keep. */
  droppedLines: number
}

export interface CommandTrackerOptions {
  tmux: Tmux
  eventsDir: string
  /** Called whenever a terminal's latest command changes (started or finished). */
  onChange: (terminalId: string, latest: CommandSummary) => void
  /** Most recent commands kept per terminal. */
  keep?: number
  /** Most output lines kept per command (the tail). */
  maxOutputLines?: number
}

const EVENTS_SUFFIX = '.events'

function unescapeField(s: string): string {
  return s.replace(/\\(\\|t|n|r)/g, (_m, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : c === 'r' ? '\r' : '\\'))
}

export function summarize(r: CommandRecord): CommandSummary {
  return {
    id: r.id,
    terminalId: r.terminalId,
    command: r.command,
    cwd: r.cwd,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    exitCode: r.exitCode,
    running: r.endedAt === null,
    outputLines: r.output === null ? null : (r.output ? r.output.split('\n').length : 0) + r.droppedLines
  }
}

/**
 * Follows every shell's events file (see shell/integration.ts), turns the
 * reports into command records, and captures each command's output from
 * tmux history as soon as it finishes, before it can scroll away.
 */
export class CommandTracker {
  private readonly records = new Map<string, CommandRecord[]>()
  private readonly offsets = new Map<string, number>()
  private readonly partial = new Map<string, string>()
  private readonly captures = new Map<string, Promise<void>>()
  private watcher: FSWatcher | null = null
  private nextId = 1

  constructor(private readonly o: CommandTrackerOptions) {}

  start(): void {
    if (this.watcher) return
    this.watcher = watch(this.o.eventsDir, (_event, filename) => {
      if (filename && filename.endsWith(EVENTS_SUFFIX)) void this.poll(basename(filename, EVENTS_SUFFIX))
    })
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
  }

  eventsFile(terminalId: string): string {
    return join(this.o.eventsDir, `${terminalId}${EVENTS_SUFFIX}`)
  }

  /** Commands for a terminal, oldest first. Reads any reports not yet seen. */
  async list(terminalId: string): Promise<CommandRecord[]> {
    await this.poll(terminalId)
    return [...(this.records.get(terminalId) ?? [])]
  }

  /** The most recent finished command, with its output captured. */
  async lastFinished(terminalId: string): Promise<CommandRecord | null> {
    const all = await this.list(terminalId)
    return [...all].reverse().find((r) => r.endedAt !== null) ?? null
  }

  async latest(terminalId: string): Promise<CommandSummary | null> {
    const all = await this.list(terminalId)
    const last = all.at(-1)
    return last ? summarize(last) : null
  }

  /** Drop a terminal's records and its events file once it has ended. */
  forget(terminalId: string): void {
    this.records.delete(terminalId)
    this.offsets.delete(terminalId)
    this.partial.delete(terminalId)
    rmSync(this.eventsFile(terminalId), { force: true })
  }

  /** Read new report lines for a terminal and wait for any output captures they start. */
  async poll(terminalId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(terminalId)) return
    const file = this.eventsFile(terminalId)
    if (!existsSync(file)) return
    const fd = openSync(file, 'r')
    let chunk = ''
    try {
      const size = fstatSync(fd).size
      let offset = this.offsets.get(terminalId) ?? 0
      if (size < offset) offset = 0 // file was replaced
      if (size > offset) {
        const buf = Buffer.alloc(size - offset)
        readSync(fd, buf, 0, buf.length, offset)
        this.offsets.set(terminalId, size)
        chunk = buf.toString('utf8')
      }
    } finally {
      closeSync(fd)
    }

    const text = (this.partial.get(terminalId) ?? '') + chunk
    const lines = text.split('\n')
    this.partial.set(terminalId, lines.pop() ?? '')
    for (const line of lines) if (line) this.apply(terminalId, line)
    await this.captures.get(terminalId)
  }

  private apply(terminalId: string, line: string): void {
    const [type, pos, ...rest] = line.split('\t')
    const at = Number(pos)
    const list = this.records.get(terminalId) ?? []
    this.records.set(terminalId, list)

    if (type === 'S') {
      const record: CommandRecord = {
        id: this.nextId++,
        terminalId,
        cwd: unescapeField(rest[0] ?? ''),
        command: unescapeField(rest.slice(1).join('\t')),
        startedAt: Date.now(),
        endedAt: null,
        exitCode: null,
        startLine: at,
        endLine: null,
        output: null,
        droppedLines: 0
      }
      list.push(record)
      const keep = this.o.keep ?? 50
      if (list.length > keep) list.splice(0, list.length - keep)
      this.o.onChange(terminalId, summarize(record))
      return
    }

    if (type === 'E') {
      const record = list.at(-1)
      if (!record || record.endedAt !== null) return
      record.endedAt = Date.now()
      record.exitCode = Number(rest[0])
      record.endLine = at
      // Captures run one at a time per terminal, in order.
      const previous = this.captures.get(terminalId) ?? Promise.resolve()
      const capture = previous.then(() => this.capture(record)).finally(() => {
        if (this.captures.get(terminalId) === capture) this.captures.delete(terminalId)
      })
      this.captures.set(terminalId, capture)
    }
  }

  private async capture(record: CommandRecord): Promise<void> {
    const { startLine, endLine } = record
    try {
      if (endLine === null || startLine < 0 || endLine < startLine) throw new Error('no usable line range')
      if (endLine === startLine) {
        record.output = ''
        return
      }
      const history = Number(
        (await this.o.tmux.run(['display-message', '-p', '-t', `=${record.terminalId}:`, '#{history_size}'])).trim()
      )
      const maxLines = this.o.maxOutputLines ?? 2000
      const from = Math.max(startLine, endLine - maxLines)
      // capture-pane counts from the top of the visible screen: 0 is its first line.
      const text = await this.o.tmux.capturePane(record.terminalId, { start: from - history, end: endLine - 1 - history })
      record.output = text.replace(/\n$/, '')
      record.droppedLines = from - startLine
    } catch {
      record.output = null // e.g. the screen was cleared or the terminal is gone
    } finally {
      this.o.onChange(record.terminalId, summarize(record))
    }
  }
}
