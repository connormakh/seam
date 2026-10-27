import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node-pty'
import { IPC, type Workspace } from '@shared/ipc'
import { tmpdir } from 'node:os'
import { ContextSender } from './context/send'
import { adoptRunningSessions } from './control/adopt'
import { ControlServer } from './control/server'
import { AutoSync } from './hooks/auto-sync'
import { installHook, writeHookSettings } from './hooks/install'
import { HookRouter } from './hooks/router'
import { Approvals } from './mcp/approvals'
import { AuditLog } from './mcp/audit'
import { installMcpServer, writeMcpConfig } from './mcp/install'
import type { PolicySettings } from './mcp/policy'
import { Tools } from './mcp/tools'
import { SettingsStore, type SeamSettings } from './settings'
import { CommandTracker } from './shell/command-tracker'
import { installShellIntegration, shellLaunch } from './shell/integration'
import { checkClaude, type ClaudeCheck } from './terminals/claude-check'
import { claudeCommand, shellOnlyArgs, userShell } from './terminals/claude-command'
import { ensureSpawnHelpersExecutable } from './terminals/spawn-helper'
import { TerminalService } from './terminals/terminal-service'
import { resolveTmuxBinary } from './tmux/binary'
import { TMUX_CONFIG } from './tmux/config'
import { Tmux } from './tmux/tmux'

export interface RuntimeOptions {
  userDataDir: string
  homeDir: string
  isPackaged: boolean
  resourcesDir: string
  /** Deliver an event to the renderer. */
  send: (channel: string, payload: unknown) => void
}

/** Everything the main process wires together at startup. */
export interface Runtime {
  tmux: Tmux | null
  /** Where integrated shells append their command reports; null without tmux. */
  eventsDir: string | null
  /** Commands run in Seam shells, with their output; null without tmux. */
  commands: CommandTracker | null
  /** Shell to Claude; null without tmux. */
  context: ContextSender | null
  /** Claude to shell: the socket its MCP server calls in on; null without tmux. */
  control: ControlServer | null
  /** Cards waiting on the user before Claude may touch a shell; null without tmux. */
  approvals: Approvals | null
  /** What Claude asked for and what happened; null without tmux. */
  audit: AuditLog | null
  /** Shell activity told to Claude without being asked; null without tmux. */
  autoSync: AutoSync | null
  /** Session status and the attach queue, fed by hooks; null without tmux. */
  hooks: HookRouter | null
  tmuxVersion: string | null
  /** Whether Claude Code is there and new enough, as found at startup. */
  claude: ClaudeCheck
  /** Null when tmux is missing; the renderer explains how to install it. */
  terminals: TerminalService | null
  /** Settings that take effect when the next pair starts. */
  settings: RuntimeSettings
}

/**
 * Settings, read through so a change is written to disk as it is made rather
 * than at some later moment that might never come.
 */
export interface RuntimeSettings {
  /** Take Bash away, so every command Claude runs goes through the shell. */
  shellOnly: () => boolean
  /** Takes effect for the next pair: Claude Code reads the flag at launch. */
  setShellOnly: (value: boolean) => void
  /** The policy for a workspace root, falling back to the default. */
  policy: (root: string) => PolicySettings
  setPolicy: (root: string, mode: PolicySettings['mode']) => void
  /** The whole of it, for the settings screen. */
  all: () => SeamSettings
  replace: (patch: Partial<SeamSettings>) => SeamSettings
  /** Folders worked in, newest first; they outlive their terminals. */
  workspaces: () => Workspace[]
  rememberWorkspace: (root: string, name?: string) => Workspace[]
  forgetWorkspace: (root: string) => Workspace[]
}

export async function createRuntime(o: RuntimeOptions): Promise<Runtime> {
  // Asked once, through the login shell, because that is how Claude is started.
  const claude = await checkClaude(userShell())
  const store = new SettingsStore(join(o.userDataDir, 'settings.json'), o.homeDir)
  // The shell is the one terminal both the user and Claude work in, so a
  // command Claude runs belongs there and not in a hidden subprocess, which
  // is why it defaults on. SEAM_SHELL_ONLY overrides the saved value for one
  // run without writing it back.
  const override = process.env['SEAM_SHELL_ONLY']
  const settings: RuntimeSettings = {
    shellOnly: () => (override === undefined ? store.get().shellOnly : override !== '0'),
    setShellOnly: (value) => void store.update({ shellOnly: value }),
    policy: (root) => store.get().policies[root] ?? store.get().policy,
    all: () => store.get(),
    replace: (patch) => store.update(patch),
    workspaces: () => store.get().workspaces,
    rememberWorkspace: (root, name) => store.rememberWorkspace(root, name),
    forgetWorkspace: (root) => store.forgetWorkspace(root),
    setPolicy: (root, mode) => {
      const saved = store.get()
      const current = saved.policies[root] ?? saved.policy
      void store.update({ policies: { ...saved.policies, [root]: { ...current, mode } } })
    }
  }

  const binary = resolveTmuxBinary({
    override: process.env['SEAM_TMUX'],
    bundledDir: o.isPackaged ? join(o.resourcesDir, 'bin') : undefined,
    path: process.env['PATH']
  })
  if (!binary)
    return {
      tmux: null,
      eventsDir: null,
      commands: null,
      context: null,
      control: null,
      approvals: null,
      audit: null,
      autoSync: null,
      hooks: null,
      tmuxVersion: null,
      terminals: null,
      settings,
      claude
    }

  const tmuxDir = join(o.userDataDir, 'tmux')
  mkdirSync(tmuxDir, { recursive: true, mode: 0o700 })
  const configPath = join(tmuxDir, 'tmux.conf')
  writeFileSync(configPath, TMUX_CONFIG)

  // Dev builds get their own server so they never touch a running install.
  const socketName = process.env['SEAM_TMUX_SOCKET'] ?? (o.isPackaged ? 'seam' : 'seam-dev')
  const tmux = new Tmux({
    binary,
    socketPath: join(tmuxDir, `${socketName}.sock`),
    configPath,
    env: {
      // Finder-launched apps often have no locale, and tmux then mangles UTF-8.
      LANG: process.env['LANG'] || 'en_US.UTF-8',
      SEAM: '1'
    }
  })

  let tmuxVersion: string | null = null
  try {
    tmuxVersion = await tmux.version()
    await tmux.reloadConfig()
  } catch {
    return {
      tmux: null,
      eventsDir: null,
      commands: null,
      context: null,
      control: null,
      approvals: null,
      audit: null,
      autoSync: null,
      hooks: null,
      tmuxVersion: null,
      terminals: null,
      settings,
      claude
    }
  }

  // Belt and braces for the postinstall fix; a no-op once it has run.
  try {
    ensureSpawnHelpersExecutable(dirname(require.resolve('node-pty/package.json')))
  } catch {
    // node-pty resolved from an unusual location; spawning will report it.
  }

  // Shells report their commands through files in eventsDir (see shell/integration.ts).
  const integrationDir = installShellIntegration(join(o.userDataDir, 'shell-integration'))
  const eventsDir = join(o.userDataDir, 'events')
  mkdirSync(eventsDir, { recursive: true, mode: 0o700 })
  const shell = userShell()

  const commands = new CommandTracker({
    tmux,
    eventsDir,
    onChange: (terminalId, latest) => o.send(IPC.commandsChanged, { terminalId, latest })
  })
  commands.start()

  const context = new ContextSender({
    tmux,
    commands,
    homeDir: o.homeDir,
    contextDir: join(tmpdir(), 'seam-context')
  })

  // Claude to shell. The tools read tmux and the command records; the control
  // server is the only way in, and a token is the only way to be heard.
  const audit = new AuditLog({ onAppend: (entry) => o.send(IPC.auditAppended, entry) })
  const approvals = new Approvals({
    present: (request) => o.send(IPC.approvalAsked, request),
    dismiss: (id) => o.send(IPC.approvalDone, { id })
  })
  const tools = new Tools({
    tmux,
    commands,
    homeDir: o.homeDir,
    approvals,
    audit,
    policy: settings.policy
  })
  const autoSync = new AutoSync({
    tmux,
    commands,
    homeDir: o.homeDir,
    contextDir: join(tmpdir(), 'seam-context'),
    // A session outlives the app, so which ones the user silenced has to as well.
    disabled: store.get().autoSyncOff,
    onDisabledChanged: (ids) => void store.update({ autoSyncOff: ids })
  })
  const hooks = new HookRouter({
    autoSync,
    shellNames: async (caller) =>
      (await tmux.listSessions())
        .filter((x) => x.kind === 'shell' && !x.private && x.root !== '' && x.root === caller.root)
        .map((x) => x.title),
    onStatus: (status) => o.send(IPC.sessionStatusChanged, status),
    onAttachChanged: (sessionId, queued) => o.send(IPC.attachQueueChanged, { sessionId, queued })
  })
  const control = new ControlServer({
    socketPath: join(o.userDataDir, 'control.sock'),
    methods: {
      'tools/list': async () => tools.list(),
      'tools/call': async (caller, params) =>
        tools.call(caller, String(params['name'] ?? ''), (params['arguments'] as Record<string, unknown>) ?? {}),
      hook: async (caller, params) => hooks.handle(caller, (params['event'] as Record<string, unknown>) ?? {})
    }
  })
  try {
    await control.start()
  } catch (err) {
    // Claude simply has no shell tools then, and everything else still works,
    // but say so: a silent failure here looks like the tools never existed.
    console.error('[seam] control socket unavailable, Claude gets no shell tools:', err)
  }

  // Claude sessions from before this launch are still running and still hold
  // the token Seam gave them; tmux kept it, so take it back.
  try {
    await adoptRunningSessions(tmux, control)
  } catch {
    // Those sessions lose their tools until restarted; nothing else breaks.
  }

  const claudeDir = join(o.userDataDir, 'claude')
  const mcpServerPath = installMcpServer(claudeDir)
  const hookPath = installHook(claudeDir, process.execPath)

  const terminals = new TerminalService({
    tmux,
    spawnPty: spawn,
    defaultCwd: o.homeDir,
    claudeLaunch: (sessionId, root) => {
      // The token is this session's alone and dies with it, so a transcript
      // that leaks one cannot be replayed into a session still running.
      const token = control.issueToken({ sessionId, root })
      const env = { SEAM_SOCKET: control.socketPath, SEAM_SESSION_TOKEN: token }
      // A stand-in Claude still gets the socket and a token, so the whole
      // Claude-to-shell path can be driven in dev without the real binary.
      const override = claudeOverride()
      if (override) return { command: override, env }
      const configPath = writeMcpConfig({
        dir: claudeDir,
        sessionId,
        serverPath: mcpServerPath,
        nodePath: process.execPath
      })
      const hooksPath = writeHookSettings({ dir: claudeDir, sessionId, hookPath })
      const args = [
        '--mcp-config',
        configPath,
        '--settings',
        hooksPath,
        ...(settings.shellOnly() ? shellOnlyArgs('shell') : [])
      ]
      return { command: claudeCommand(shell, args), env }
    },
    isBusy: async (id) => (await commands.latest(id))?.running === true,
    shellLaunch: (id) =>
      shellLaunch({
        shell,
        integrationDir,
        eventsFile: join(eventsDir, `${id}.events`),
        tmuxBinary: binary,
        homeDir: o.homeDir,
        userZdotdir: process.env['ZDOTDIR']
      }),
    events: {
      data: (id, data) => o.send(IPC.terminalData, { id, data }),
      exit: (event) => {
        if (event.ended) {
          commands.forget(event.id)
          // Whatever still holds this session's token stops being anyone, and
          // a card nobody can answer for stops waiting.
          control.revokeSession(event.id)
          approvals.cancelSession(event.id)
          tools.forgetSession(event.id)
          autoSync.forget(event.id)
          hooks.forget(event.id)
        }
        o.send(IPC.terminalExit, event)
      }
    }
  })

  return {
    tmux,
    eventsDir,
    commands,
    context,
    control,
    approvals,
    audit,
    autoSync,
    hooks,
    tmuxVersion,
    terminals,
    settings,
    claude
  }
}

/**
 * Dev and demo hook: SEAM_CLAUDE_COMMAND='["python3", "scripts/fake-claude.py"]'
 * runs a stand-in on the Claude side of new pairs instead of Claude Code.
 */
function claudeOverride(): string[] | null {
  const raw = process.env['SEAM_CLAUDE_COMMAND']
  if (!raw) return null
  try {
    const argv: unknown = JSON.parse(raw)
    if (Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string')) return argv as string[]
  } catch {
    // fall through
  }
  return null
}
