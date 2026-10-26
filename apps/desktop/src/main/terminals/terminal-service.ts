import type { IPty, IPtyForkOptions } from 'node-pty'
import { basename } from 'node:path'
import type {
  CreatePairOptions,
  CreateTerminalOptions,
  PairInfo,
  TerminalExitEvent,
  TerminalInfo,
  TerminalSize
} from '@shared/ipc'
import type { ShellLaunch } from '../shell/integration'
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
  /** argv that starts Claude Code for the Claude side of a pair. */
  /**
   * How to start the Claude side of a pair. Takes the terminal's id because
   * each session gets its own MCP config and its own control-socket token.
   */
  claudeLaunch: (sessionId: string, root: string) => { command: string[]; env?: Record<string, string> }
  /** Whether a command is running in a terminal, which decides how it clears. */
  isBusy?: (id: string) => Promise<boolean>
  /** How to start an integrated shell for a terminal; tmux's default shell when absent. */
  shellLaunch?: (terminalId: string) => ShellLaunch
}

interface Attachment {
  /** Null while attach() is still checking the session; set once spawned. */
  pty: IPty | null
  batcher: OutputBatcher
  /** Set when Seam ended the client on purpose, so its exit is not reported. */
  detaching: boolean
  /** Latest size asked for, applied when the pty spawns. */
  size: TerminalSize
  /** Set while a write is waiting on tmux, so later writes keep their order. */
  queue: Promise<void> | null
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
  /** Terminals left showing history by a scroll, so typing can leave it. */
  private readonly scrolled = new Set<string>()

  constructor(private readonly o: TerminalServiceOptions) {}

  async list(): Promise<TerminalInfo[]> {
    const sessions = await this.o.tmux.listSessions()
    return sessions.map((s) => this.toInfo(s))
  }

  async create(opts: CreateTerminalOptions = {}): Promise<TerminalInfo> {
    const id = newTerminalId()
    const kind = opts.kind ?? 'shell'
    const launch = kind === 'shell' ? this.o.shellLaunch?.(id) : undefined
    await this.o.tmux.newSession({
      id,
      kind,
      cwd: opts.cwd ?? this.o.defaultCwd,
      title: opts.title ?? (kind === 'shell' ? 'shell' : 'claude'),
      ...(launch ? { command: launch.command } : {}),
      env: { ...launch?.env, SEAM_TERMINAL_ID: id }
    })
    const info = (await this.list()).find((t) => t.id === id)
    if (!info) throw new Error(`terminal ${id} exited immediately after starting`)
    return info
  }

  /**
   * A Claude Code session and its companion shell, both rooted at `cwd`
   * and linked through @seam-pair so they reopen together.
   */
  async createPair(opts: CreatePairOptions): Promise<PairInfo> {
    const claudeId = newTerminalId()
    const shellId = newTerminalId()
    const title = opts.title ?? (basename(opts.cwd) || opts.cwd)
    const env = (self: string, other: string) => ({ SEAM_TERMINAL_ID: self, SEAM_PAIR_ID: other })

    // The folder decides which shells this session may reach, so it is what
    // the control-socket token is bound to.
    const claudeLaunch = this.o.claudeLaunch(claudeId, opts.cwd)
    await this.o.tmux.newSession({
      id: claudeId,
      kind: 'claude',
      cwd: opts.cwd,
      title,
      command: claudeLaunch.command,
      env: { ...claudeLaunch.env, ...env(claudeId, shellId) },
      pairId: shellId
    })
    try {
      const launch = this.o.shellLaunch?.(shellId)
      await this.o.tmux.newSession({
        id: shellId,
        kind: 'shell',
        cwd: opts.cwd,
        title: 'shell',
        ...(launch ? { command: launch.command } : {}),
        env: { ...launch?.env, ...env(shellId, claudeId) },
        pairId: claudeId
      })
    } catch (err) {
      await this.o.tmux.killSession(claudeId)
      throw err
    }

    const byId = new Map((await this.list()).map((t) => [t.id, t]))
    const claude = byId.get(claudeId)
    const shell = byId.get(shellId)
    if (!claude || !shell) throw new Error('the pair exited immediately after starting')
    return { claude, shell }
  }

  async attach(id: string, size: TerminalSize): Promise<void> {
    const existing = this.attachments.get(id)
    if (existing) {
      // Already streaming or about to (e.g. a re-mounted view): take the new size.
      existing.size = size
      this.resize(id, size)
      return
    }

    // Register before the first await, so a detach() or a second attach()
    // during the session check sees this attachment instead of racing it.
    const attachment: Attachment = {
      pty: null,
      batcher: new OutputBatcher((data) => {
        // Only the current attachment may speak for this terminal.
        if (this.attachments.get(id) === attachment) this.o.events.data(id, data)
      }),
      detaching: false,
      size,
      queue: null
    }
    this.attachments.set(id, attachment)
    const isCurrent = (): boolean => !attachment.detaching && this.attachments.get(id) === attachment

    let alive: boolean
    try {
      alive = await this.o.tmux.hasSession(id)
    } catch (err) {
      if (this.attachments.get(id) === attachment) this.attachments.delete(id)
      throw err
    }
    if (!isCurrent()) return // detached while we were checking: nothing to do
    if (!alive) {
      this.attachments.delete(id)
      throw new Error(`terminal ${id} is not running`)
    }

    const { cols, rows } = clampSize(attachment.size)
    const { file, args } = this.o.tmux.attachCommand(id)
    let pty: IPty
    try {
      pty = this.o.spawnPty(file, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: this.o.defaultCwd,
        env: { ...this.o.tmux.processEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' }
      })
    } catch (err) {
      this.attachments.delete(id)
      throw new Error(`could not start a terminal client: ${String(err)}`)
    }
    attachment.pty = pty

    pty.onData((chunk) => attachment.batcher.push(chunk))
    pty.onExit(() => {
      const wasCurrent = isCurrent()
      attachment.batcher.dispose()
      if (this.attachments.get(id) === attachment) this.attachments.delete(id)
      // Report only exits nobody asked for, from the client that was live.
      if (!wasCurrent) return
      void this.o.tmux.hasSession(id).then((stillAlive) => this.o.events.exit({ id, ended: !stillAlive }))
    })
  }

  detach(id: string): void {
    const a = this.attachments.get(id)
    if (!a) return
    a.batcher.flush()
    a.detaching = true
    this.attachments.delete(id)
    a.pty?.kill()
  }

  async kill(id: string): Promise<void> {
    const a = this.attachments.get(id)
    if (a) a.batcher.flush()
    this.scrolled.delete(id)
    // The attached client exits on its own once the session is gone and
    // reports ended: true through its exit handler.
    await this.o.tmux.killSession(id)
  }

  /**
   * Type into a terminal.
   *
   * A pane scrolled back is in tmux's copy mode, where a keystroke is a
   * copy-mode command rather than input, so it is put back on its live
   * screen first. That takes a tmux call, so the rest of a fast "ls" queues
   * behind it instead of racing past it and arriving as "sl".
   */
  write(id: string, data: string): void {
    const a = this.attachments.get(id)
    if (!a) return
    if (this.scrolled.delete(id)) a.queue = this.o.tmux.exitCopyMode(id)
    if (!a.queue) {
      a.pty?.write(data)
      return
    }
    const queue = a.queue.then(() => {
      a.pty?.write(data)
      if (a.queue === queue) a.queue = null
    })
    a.queue = queue
  }

  /**
   * Scroll a terminal's history, negative for older lines.
   *
   * The wheel comes from the renderer because tmux is not handling the
   * mouse, which is what leaves dragging free to make a selection.
   */
  async scroll(id: string, lines: number): Promise<void> {
    if (await this.o.tmux.scrollPane(id, lines)) this.scrolled.add(id)
    else this.scrolled.delete(id)
  }

  resize(id: string, size: TerminalSize): void {
    const a = this.attachments.get(id)
    if (!a) return
    a.size = size
    if (!a.pty) return
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
      open: s.open,
      pairId: s.pairId,
      private: s.private,
      root: s.root
    }
  }

  /**
   * Wipe a pane, screen and scrollback.
   *
   * A shell sitting at a prompt is asked to clear itself, so it draws the
   * prompt again and the pane is not left blank with nowhere to type. One
   * that is mid-command has no prompt to redraw and would echo the keystroke
   * into its output, so its screen is reset instead.
   */
  async clear(id: string): Promise<void> {
    // A pane showing history has no live screen to clear yet.
    if (this.scrolled.delete(id)) await this.o.tmux.exitCopyMode(id)
    const busy = (await this.o.isBusy?.(id)) ?? false
    await this.o.tmux.clearPane(id, { viaProgram: !busy })
  }

  /** Hide a shell from Claude, or show it again. */
  async setPrivate(id: string, isPrivate: boolean): Promise<void> {
    await this.o.tmux.setPrivate(id, isPrivate)
  }
}
