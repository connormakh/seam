import { execFile, spawn } from 'node:child_process'
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
  /** The folder this terminal's pair was opened on; scopes what Claude can reach. */
  root?: string
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
  /**
   * The folder the pair was opened on. Seam has no workspace table yet, so
   * this is what says which terminals belong together: a Claude session can
   * only reach shells that share its root.
   */
  root: string
  /** Hidden from Claude entirely, for shells holding credentials. */
  private: boolean
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

/** A wheel flick is a few lines; anything past a screenful is a runaway. */
const MAX_SCROLL = 200

/** Arrow keys a program is sent for one flick; it is reading them one by one. */
const MAX_KEY_REPEAT = 20

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

  /** Like run(), with `input` on stdin (for load-buffer -). */
  async runWithInput(args: string[], input: string): Promise<string> {
    const full = [...this.baseArgs(), ...args]
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.binary, full, { env: this.processEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
      child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve(stdout)
        else reject(new TmuxError(stderr.trim() || `tmux exited with ${code}`, args, stderr.trim()))
      })
      child.stdin.end(input, 'utf8')
    })
  }

  /**
   * Paste text into a pane as one bracketed paste: programs that support it
   * (Claude Code, modern shells) take it as typed-in text, not as keys to
   * run line by line. Goes through a uniquely named tmux buffer that is
   * deleted after use.
   */
  async pasteText(id: string, text: string): Promise<void> {
    assertId(id)
    const buffer = `seam-paste-${id}-${Date.now().toString(36)}`
    await this.runWithInput(['load-buffer', '-b', buffer, '-'], text)
    // Without -r, tmux turns LF into CR, as a terminal does for a real paste.
    await this.run(['paste-buffer', '-p', '-d', '-b', buffer, '-t', `=${id}:`])
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
      ...['set-option', '-t', target, '@seam-pair', o.pairId ?? '', ';'],
      // escapeFormat because a path may contain '#', which tmux would expand.
      ...['set-option', '-t', target, '@seam-root', escapeFormat(o.root ?? o.cwd), ';'],
      ...['set-option', '-t', target, '@seam-private', '0']
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

  /**
   * One variable from a session's own environment, or null. tmux keeps this
   * for as long as the session lives, which is longer than Seam does.
   */
  async sessionEnv(id: string, name: string): Promise<string | null> {
    assertId(id)
    try {
      const out = await this.run(['show-environment', '-t', `=${id}`, name])
      const value = out.trim().slice(name.length + 1)
      return out.startsWith(`${name}=`) && value ? value : null
    } catch {
      // "unknown variable", or the session has gone.
      return null
    }
  }

  /**
   * Where the cursor is in the pane's whole history, and how much of that
   * history is above the screen. Together they turn an absolute line number
   * into the offset capturePane wants.
   */
  async position(id: string): Promise<{ history: number; cursor: number }> {
    assertId(id)
    const out = await this.run(['display-message', '-p', '-t', `=${id}:`, '#{history_size}␟#{cursor_y}'])
    const [history, cursor] = out.trim().split(SEP)
    return { history: Number(history) || 0, cursor: Number(cursor) || 0 }
  }

  /**
   * Wipe a pane: the screen, then the scrollback behind it.
   *
   * Two ways, because the right one depends on what is in the pane. C-l is
   * input: a shell at a prompt clears and draws its prompt again, which is
   * what leaves somewhere to type. A program that does not handle it echoes
   * the control character into its own output instead, so for those the
   * terminal state is reset with `-R`, which never reaches the program and
   * leaves the pane blank because there is no prompt to put back.
   */
  async clearPane(id: string, opts: { viaProgram?: boolean } = {}): Promise<void> {
    assertId(id)
    const target = `=${id}:`
    if (opts.viaProgram) await this.run(['send-keys', '-t', target, 'C-l'])
    else await this.run(['send-keys', '-R', '-t', target])
    await this.run(['clear-history', '-t', target])
  }

  /**
   * Scroll a pane's history, negative for older lines. Returns whether the
   * pane is still showing history afterwards.
   *
   * tmux's own mouse handling is off so that dragging makes a selection, so
   * the wheel arrives here instead. Scrolling back puts the pane in copy
   * mode; -e makes it leave again by itself on reaching the bottom, so
   * scrolling down to the end needs no cleanup.
   */
  async scrollPane(id: string, lines: number): Promise<boolean> {
    assertId(id)
    const target = `=${id}:`
    const n = Math.min(Math.abs(Math.trunc(lines)), MAX_SCROLL)
    if (n === 0) return await this.inMode(id)
    const state = await this.paneState(id)

    // A program drawing its own screen has no history behind it. The arrow
    // keys are what `less` and `man` scroll with, and what tmux's own wheel
    // handling sends them, so that is what the wheel becomes.
    if (state.alternate) {
      const repeat = Math.min(n, MAX_KEY_REPEAT)
      await this.run(['send-keys', '-t', target, '-N', String(repeat), lines < 0 ? 'Up' : 'Down'])
      return false
    }

    if (lines < 0) await this.run(['copy-mode', '-e', '-t', target])
    // Nothing to scroll down to from the live screen.
    else if (!state.inMode) return false
    try {
      const key = lines < 0 ? 'scroll-up' : 'scroll-down'
      await this.run(['send-keys', '-X', '-N', String(n), '-t', target, key])
    } catch {
      // The pane can leave copy mode between the check and the keys.
      return false
    }
    return await this.inMode(id)
  }

  /** Whether the pane is showing history rather than its live screen. */
  async inMode(id: string): Promise<boolean> {
    return (await this.paneState(id)).inMode
  }

  /** What the wheel has to know: who owns the screen, and where it is. */
  private async paneState(id: string): Promise<{ inMode: boolean; alternate: boolean }> {
    assertId(id)
    const out = await this.run(['display-message', '-p', '-t', `=${id}:`, `#{pane_in_mode}${SEP}#{alternate_on}`])
    const [inMode, alternate] = out.trim().split(SEP)
    return { inMode: inMode === '1', alternate: alternate === '1' }
  }

  /** Put a pane back on its live screen, wherever it was scrolled to. */
  async exitCopyMode(id: string): Promise<void> {
    assertId(id)
    try {
      await this.run(['send-keys', '-X', '-t', `=${id}:`, 'cancel'])
    } catch {
      // Not in a mode: already where we want it.
    }
  }

  /** Hide a shell from Claude, or show it again. */
  async setPrivate(id: string, isPrivate: boolean): Promise<void> {
    assertId(id)
    await this.run(['set-option', '-t', `=${id}:`, '@seam-private', isPrivate ? '1' : '0'])
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
      '#{@seam-pair}',
      '#{@seam-root}',
      '#{@seam-private}'
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
      const [id, kind, title, cwd, cmd, pid, created, attached, dead, open, sessionId, pair, root, isPrivate] =
        line.split(SEP)
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
        pairId: pair && ID_PATTERN.test(pair) ? pair : null,
        root: root ?? '',
        // Anything but a plain "0" counts as private: an option Seam cannot
        // read should hide a shell, never expose one.
        private: (isPrivate ?? '') !== '' && isPrivate !== '0'
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
