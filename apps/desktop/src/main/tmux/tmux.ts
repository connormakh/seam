import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Field separator for -F formats. tmux escapes control characters in format
 * output (\x1f prints as "\037", tabs as "_"), so use a printable character
 * that will not appear in names or realistic paths.
 */
const SEP = '\u241f'

/** Seam's own metadata, stored as tmux user options on each session. */
export type TerminalKind = 'shell' | 'claude'

export interface TmuxOptions {
  binary: string
  /** Name for `tmux -L`; keeps Seam's server apart from the user's tmux. */
  socketName: string
  configPath: string
  /**
   * Extra environment for every tmux process. The first call starts the
   * server, which keeps this environment for all sessions it creates.
   */
  env?: Record<string, string>
}

export interface NewSessionOptions {
  /** Seam terminal id; also becomes the tmux session name. */
  id: string
  kind: TerminalKind
  cwd: string
  /** Program to run instead of the default login shell. */
  command?: string[]
  env?: Record<string, string>
  cols?: number
  rows?: number
  title?: string
}

export interface TmuxSession {
  id: string
  kind: TerminalKind
  title: string
  cwd: string
  /** Command currently in the foreground of the pane, e.g. "zsh" or "node". */
  currentCommand: string
  panePid: number
  createdAt: number
  attachedClients: number
  /** True once the pane's program has exited (only kept with remain-on-exit). */
  dead: boolean
}

export class TmuxError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string
  ) {
    super(message)
    this.name = 'TmuxError'
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

function assertId(id: string): void {
  // tmux treats ':' and '.' as target separators; keep ids boring.
  if (!ID_PATTERN.test(id)) throw new Error(`invalid terminal id: ${JSON.stringify(id)}`)
}

/**
 * Thin, typed wrapper over the tmux CLI for Seam's private server.
 * Every call is a short-lived `tmux -L <socket> ...` process; no state is
 * kept here, so tmux stays the single source of truth for what is running.
 */
export class Tmux {
  constructor(readonly opts: TmuxOptions) {}

  /** Environment for tmux processes, including pty-spawned clients. */
  processEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    return { ...env, ...this.opts.env }
  }

  private baseArgs(): string[] {
    return ['-u', '-L', this.opts.socketName, '-f', this.opts.configPath]
  }

  async run(args: string[]): Promise<string> {
    const full = [...this.baseArgs(), ...args]
    try {
      const { stdout } = await execFileAsync(this.opts.binary, full, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: this.processEnv()
      })
      return stdout
    } catch (err) {
      const e = err as { stderr?: string; message: string }
      const stderr = (e.stderr ?? '').trim()
      throw new TmuxError(stderr || e.message, args, stderr)
    }
  }

  /** argv for a tmux client attached to a session, for spawning in a pty. */
  attachCommand(id: string): { file: string; args: string[] } {
    assertId(id)
    return { file: this.opts.binary, args: [...this.baseArgs(), 'attach-session', '-t', `=${id}`] }
  }

  async version(): Promise<string> {
    const { stdout } = await execFileAsync(this.opts.binary, ['-V'], { encoding: 'utf8' })
    return stdout.trim()
  }

  async newSession(o: NewSessionOptions): Promise<void> {
    assertId(o.id)
    const args = ['new-session', '-d', '-s', o.id, '-c', o.cwd]
    args.push('-x', String(o.cols ?? 120), '-y', String(o.rows ?? 32))
    for (const [k, v] of Object.entries(o.env ?? {})) args.push('-e', `${k}=${v}`)
    if (o.command?.length) args.push(...o.command)
    await this.run(args)

    // set-option takes a pane target, so the exact-match session form needs a trailing ':'.
    const target = `=${o.id}:`
    await this.run(['set-option', '-t', target, '@seam-kind', o.kind])
    await this.run(['set-option', '-t', target, '@seam-title', o.title ?? ''])
  }

  async hasSession(id: string): Promise<boolean> {
    assertId(id)
    try {
      await this.run(['has-session', '-t', `=${id}`])
      return true
    } catch {
      return false
    }
  }

  /** Sessions created by Seam on this server. Empty if the server is not running. */
  async listSessions(): Promise<TmuxSession[]> {
    const fields = [
      '#{session_name}',
      '#{@seam-kind}',
      '#{@seam-title}',
      '#{pane_current_path}',
      '#{pane_current_command}',
      '#{pane_pid}',
      '#{session_created}',
      '#{session_attached}',
      '#{pane_dead}'
    ]
    let out: string
    try {
      out = await this.run(['list-panes', '-a', '-F', fields.join(SEP)])
    } catch (err) {
      if (err instanceof TmuxError && isNoServer(err.stderr)) return []
      throw err
    }

    const seen = new Set<string>()
    const sessions: TmuxSession[] = []
    for (const line of out.split('\n')) {
      if (!line) continue
      const [id, kind, title, cwd, cmd, pid, created, attached, dead] = line.split(SEP)
      if (!id || seen.has(id)) continue // one entry per session (first pane)
      if (kind !== 'shell' && kind !== 'claude') continue // not ours
      seen.add(id)
      sessions.push({
        id,
        kind,
        title: title ?? '',
        cwd: cwd ?? '',
        currentCommand: cmd ?? '',
        panePid: Number(pid),
        createdAt: Number(created) * 1000,
        attachedClients: Number(attached),
        dead: dead === '1'
      })
    }
    return sessions.sort((a, b) => a.createdAt - b.createdAt)
  }

  async setTitle(id: string, title: string): Promise<void> {
    assertId(id)
    await this.run(['set-option', '-t', `=${id}:`, '@seam-title', title])
  }

  async killSession(id: string): Promise<void> {
    assertId(id)
    try {
      await this.run(['kill-session', '-t', `=${id}`])
    } catch (err) {
      // Already gone is fine: the goal state is reached.
      if (err instanceof TmuxError && (isNoServer(err.stderr) || /can't find session/.test(err.stderr))) return
      throw err
    }
  }

  /**
   * Pane text. Lines are relative to the visible screen: 0 is the top line,
   * negative numbers reach into history. Defaults to the visible screen.
   */
  async capturePane(id: string, opts: { start?: number | '-'; end?: number | '-'; escapes?: boolean } = {}): Promise<string> {
    assertId(id)
    const args = ['capture-pane', '-p', '-J', '-t', `=${id}:`]
    if (opts.escapes) args.push('-e')
    if (opts.start !== undefined) args.push('-S', String(opts.start))
    if (opts.end !== undefined) args.push('-E', String(opts.end))
    return this.run(args)
  }

  /** Type text into the pane. `literal` sends characters as-is (no key names). */
  async sendKeys(id: string, keys: string, opts: { literal?: boolean; enter?: boolean } = {}): Promise<void> {
    assertId(id)
    const target = `=${id}:`
    if (keys) await this.run(['send-keys', '-t', target, ...(opts.literal ? ['-l'] : []), keys])
    if (opts.enter) await this.run(['send-keys', '-t', target, 'Enter'])
  }

  async killServer(): Promise<void> {
    try {
      await this.run(['kill-server'])
    } catch (err) {
      if (err instanceof TmuxError && isNoServer(err.stderr)) return
      throw err
    }
  }
}

function isNoServer(stderr: string): boolean {
  return /no server running|error connecting|No such file or directory/.test(stderr)
}
