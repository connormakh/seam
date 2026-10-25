import type { IPty, IPtyForkOptions } from 'node-pty'
import type {
  CreateTerminalOptions,
  TerminalExitEvent,
  TerminalInfo,
  TerminalSize
} from '@shared/ipc'
import type { Tmux, TmuxSession } from '../tmux/tmux'
import { newTerminalId } from './ids'
import { OutputBatcher } from './output-batcher'

export type SpawnPty = (file: string, args: string[], options: IPtyForkOptions) => IPty

export interface TerminalEvents {
  data(id: string, data: string): void
  exit(event: TerminalExitEvent): void
}

export interface TerminalServiceOptions {
  tmux: Tmux
  spawnPty: SpawnPty
  events: TerminalEvents
  defaultCwd: string
}

interface Attachment {
  pty: IPty
  batcher: OutputBatcher
  /** Set when Seam ended the client on purpose, so its exit is not reported. */
  detaching: boolean
}

const MIN_COLS = 2
const MIN_ROWS = 1

function clampSize(size: TerminalSize): TerminalSize {
  return {
    cols: Math.max(MIN_COLS, Math.floor(size.cols) || MIN_COLS),
    rows: Math.max(MIN_ROWS, Math.floor(size.rows) || MIN_ROWS)
  }
}

/**
 * Owns the link between tmux sessions and what the window shows.
 *
 * A terminal is a tmux session and outlives any tab. Opening a tab attaches
 * a tmux client inside a pty and streams its output; closing the tab kills
 * only that client. Ending a terminal kills the tmux session itself.
 */
export class TerminalService {
  private readonly attachments = new Map<string, Attachment>()

  constructor(private readonly o: TerminalServiceOptions) {}

  async list(): Promise<TerminalInfo[]> {
    const sessions = await this.o.tmux.listSessions()
    return sessions.map((s) => this.toInfo(s))
  }

  async create(opts: CreateTerminalOptions = {}): Promise<TerminalInfo> {
    const id = newTerminalId()
    const kind = opts.kind ?? 'shell'
    await this.o.tmux.newSession({
      id,
      kind,
      cwd: opts.cwd ?? this.o.defaultCwd,
      title: opts.title ?? (kind === 'shell' ? 'shell' : 'claude'),
      env: { SEAM_TERMINAL_ID: id }
    })
    const info = (await this.list()).find((t) => t.id === id)
    if (!info) throw new Error(`terminal ${id} exited immediately after starting`)
    return info
  }

  async attach(id: string, size: TerminalSize): Promise<void> {
    const existing = this.attachments.get(id)
    if (existing) {
      // Already streaming (e.g. a re-mounted view): just take the new size.
      this.resize(id, size)
      return
    }
    if (!(await this.o.tmux.hasSession(id))) {
      throw new Error(`terminal ${id} is not running`)
    }

    const { cols, rows } = clampSize(size)
    const { file, args } = this.o.tmux.attachCommand(id)
    const pty = this.o.spawnPty(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.o.defaultCwd,
      env: { ...this.o.tmux.processEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    })

    const attachment: Attachment = {
      pty,
      batcher: new OutputBatcher((data) => this.o.events.data(id, data)),
      detaching: false
    }
    this.attachments.set(id, attachment)

    pty.onData((chunk) => attachment.batcher.push(chunk))
    pty.onExit(() => {
      attachment.batcher.dispose()
      // A newer attachment may already have replaced this one.
      if (this.attachments.get(id) === attachment) this.attachments.delete(id)
      if (attachment.detaching) return
      void this.o.tmux.hasSession(id).then((alive) => this.o.events.exit({ id, ended: !alive }))
    })
  }

  detach(id: string): void {
    const a = this.attachments.get(id)
    if (!a) return
    a.detaching = true
    a.batcher.flush()
    this.attachments.delete(id)
    a.pty.kill()
  }

  async kill(id: string): Promise<void> {
    const a = this.attachments.get(id)
    if (a) a.batcher.flush()
    // The attached client exits on its own once the session is gone and
    // reports ended: true through its exit handler.
    await this.o.tmux.killSession(id)
  }

  write(id: string, data: string): void {
    this.attachments.get(id)?.pty.write(data)
  }

  resize(id: string, size: TerminalSize): void {
    const a = this.attachments.get(id)
    if (!a) return
    const { cols, rows } = clampSize(size)
    try {
      a.pty.resize(cols, rows)
    } catch {
      // The pty can close between the lookup and the call; nothing to resize.
    }
  }

  async setOpen(id: string, open: boolean): Promise<void> {
    await this.o.tmux.setOpen(id, open)
  }

  isAttached(id: string): boolean {
    return this.attachments.has(id)
  }

  /** Drop every client, leaving the terminals running. Called on quit. */
  detachAll(): void {
    for (const id of [...this.attachments.keys()]) this.detach(id)
  }

  private toInfo(s: TmuxSession): TerminalInfo {
    return {
      id: s.id,
      kind: s.kind,
      title: s.title,
      cwd: s.cwd,
      currentCommand: s.currentCommand,
      createdAt: s.createdAt,
      attached: this.attachments.has(s.id),
      open: s.open
    }
  }
}
