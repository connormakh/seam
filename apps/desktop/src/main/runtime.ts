import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node-pty'
import { IPC } from '@shared/ipc'
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
  if (!binary) return { tmux: null, tmuxVersion: null, terminals: null }

  mkdirSync(o.userDataDir, { recursive: true })
  const configPath = join(o.userDataDir, 'tmux.conf')
  writeFileSync(configPath, TMUX_CONFIG)

  const tmux = new Tmux({
    binary,
    // Dev builds get their own server so they never touch a running install.
    socketName: process.env['SEAM_TMUX_SOCKET'] ?? (o.isPackaged ? 'seam' : 'seam-dev'),
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
  } catch {
    return { tmux: null, tmuxVersion: null, terminals: null }
  }

  const terminals = new TerminalService({
    tmux,
    spawnPty: spawn,
    defaultCwd: o.homeDir,
    events: {
      data: (id, data) => o.send(IPC.terminalData, { id, data }),
      exit: (event) => o.send(IPC.terminalExit, event)
    }
  })

  return { tmux, tmuxVersion, terminals }
}
