import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node-pty'
import { IPC } from '@shared/ipc'
import { tmpdir } from 'node:os'
import { ContextSender } from './context/send'
import { CommandTracker } from './shell/command-tracker'
import { installShellIntegration, shellLaunch } from './shell/integration'
import { claudeCommand, userShell } from './terminals/claude-command'
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
  tmuxVersion: string | null
  /** Null when tmux is missing; the renderer explains how to install it. */
  terminals: TerminalService | null
}

export async function createRuntime(o: RuntimeOptions): Promise<Runtime> {
  const binary = resolveTmuxBinary({
    override: process.env['SEAM_TMUX'],
    bundledDir: o.isPackaged ? join(o.resourcesDir, 'bin') : undefined,
    path: process.env['PATH']
  })
  if (!binary) return { tmux: null, eventsDir: null, commands: null, context: null, tmuxVersion: null, terminals: null }

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
    return { tmux: null, eventsDir: null, commands: null, context: null, tmuxVersion: null, terminals: null }
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

  const terminals = new TerminalService({
    tmux,
    spawnPty: spawn,
    defaultCwd: o.homeDir,
    claudeCommand: () => claudeOverride() ?? claudeCommand(shell),
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
        if (event.ended) commands.forget(event.id)
        o.send(IPC.terminalExit, event)
      }
    }
  })

  return { tmux, eventsDir, commands, context, tmuxVersion, terminals }
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
