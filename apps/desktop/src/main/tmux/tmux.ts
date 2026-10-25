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
  /**
   * Socket path for `tmux -S`. Keeps Seam's server apart from the user's
   * tmux, and out of /tmp, where macOS periodically deletes old files.
   */
  socketPath: string
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
  /** Whether a tab should show this terminal. Defaults to true. */
  open?: boolean
  /** The other half of a Claude + shell pair, if this terminal belongs to one. */
  pairId?: string
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
  /** Whether Seam shows this terminal in a tab (vs. running in the background). */
  open: boolean
  /** tmux's own session number, increasing in creation order. */
  serial: number
  /** The other half of a Claude + shell pair, or null. */
  pairId: string | null
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

/** Variables that belong to the app process, not to a user's shell. */
const APP_ONLY_ENV = /^(ELECTRON_|VITE_|CHROME_|NODE_OPTIONS$|NODE_ENV$|TMUX$|TMUX_PANE$)/

/**
 * tmux expands formats in `-c` start directories: "#(cmd)" runs a command
 * and "#S" becomes the session name. Doubling '#' makes the path literal.
 */
export function escapeFormat(value: string): string {
  return value.replaceAll('#', '##')
}

/** Option values are listed one per line; keep them on one line. */
function oneLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f\u241f]/g, ' ')
}

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

  /**
   * Environment for tmux processes, including pty-spawned clients. The
   * server copies it into every session, so the app's own variables
   * (Electron, Vite, Node flags) are left out of users' shells.
   */
  processEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || APP_ONLY_ENV.test(k)) continue
      env[k] = v
    }
    return { ...env, ...this.opts.env }
  }

  /**
   * Re-apply the config to a server that was already running (e.g. started
   * by an older Seam). A no-op when no server is running yet.
   */
  async reloadConfig(): Promise<void> {
    try {
      await this.run(['source-file', this.opts.configPath])
    } catch (err) {
      if (err instanceof TmuxError && isNoServer(err.stderr)) return
      throw err
    }
  }

  private baseArgs(): string[] {
    return ['-u', '-S', this.opts.socketPath, '-f', this.opts.configPath]
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
    const args = ['new-session', '-d', '-s', o.id, '-c', escapeFormat(o.cwd)]
    args.push('-x', String(o.cols ?? 120), '-y', String(o.rows ?? 32))
    for (const [k, v] of Object.entries(o.env ?? {})) args.push('-e', `${k}=${v}`)
    if (o.command?.length) args.push(...o.command)
    await this.run(args)

    if (o.pairId !== undefined) assertId(o.pairId)
    // set-option takes a pane target, so the exact-match session form needs a
    // trailing ':'. A lone ';' argument separates commands in one tmux call.
    const target = `=${o.id}:`
    await this.run([
      ...['set-option', '-t', target, '@seam-kind', o.kind, ';'],
      ...['set-option', '-t', target, '@seam-title', oneLine(o.title ?? ''), ';'],
      ...['set-option', '-t', target, '@seam-open', o.open === false ? '0' : '1', ';'],
      ...['set-option', '-t', target, '@seam-pair', o.pairId ?? '']
    ])
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
      '#{pane_dead}',
      '#{@seam-open}',
      '#{session_id}',
      '#{@seam-pair}'
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
      const [id, kind, title, cwd, cmd, pid, created, attached, dead, open, sessionId, pair] = line.split(SEP)
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
        dead: dead === '1',
        open: open !== '0',
        // "$12" -> 12; tmux hands these out in creation order.
        serial: Number((sessionId ?? '').replace('$', '')) || 0,
        pairId: pair && ID_PATTERN.test(pair) ? pair : null
      })
    }
    // session_created has 1 s resolution; the serial breaks ties.
    return sessions.sort((a, b) => a.createdAt - b.createdAt || a.serial - b.serial)
  }

  async setTitle(id: string, title: string): Promise<void> {
    assertId(id)
    await this.run(['set-option', '-t', `=${id}:`, '@seam-title', oneLine(title)])
  }

  async setOpen(id: string, open: boolean): Promise<void> {
    assertId(id)
    await this.run(['set-option', '-t', `=${id}:`, '@seam-open', open ? '1' : '0'])
  }

  async killSession(id: string): Promise<void> {
    assertId(id)
    try {
      await this.run(['kill-session', '-t', `=${id}`])
    } catch (err) {
      // Already gone is fine: the goal state is reached.
      // With no sessions left on the server tmux says "no current target".
      if (err instanceof TmuxError && (isNoServer(err.stderr) || /can't find session|no current target/.test(err.stderr))) return
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
