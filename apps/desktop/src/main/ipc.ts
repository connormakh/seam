import { app, ipcMain } from 'electron'
import {
  IPC,
  type AppInfo,
  type CreateTerminalOptions,
  type TerminalSize
} from '@shared/ipc'
import type { TerminalService } from './terminals/terminal-service'
import type { Runtime } from './runtime'

function requireTerminals(rt: Runtime): TerminalService {
  if (!rt.terminals) throw new Error('tmux is not installed')
  return rt.terminals
}

// Payloads come from the renderer; check shapes before they reach tmux or a pty.
function asId(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new Error('invalid terminal id')
  return v
}

function asSize(v: unknown): TerminalSize {
  const s = v as Partial<TerminalSize> | null
  if (!s || typeof s.cols !== 'number' || typeof s.rows !== 'number') throw new Error('invalid size')
  return { cols: s.cols, rows: s.rows }
}

function asCreateOptions(v: unknown): CreateTerminalOptions {
  const o = (v ?? {}) as Record<string, unknown>
  const out: CreateTerminalOptions = {}
  if (o['kind'] === 'shell' || o['kind'] === 'claude') out.kind = o['kind']
  if (typeof o['cwd'] === 'string') out.cwd = o['cwd']
  if (typeof o['title'] === 'string') out.title = o['title'].slice(0, 200)
  return out
}

export function registerIpc(rt: Runtime): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron ?? 'unknown',
    tmux: rt.tmuxVersion
  }))

  ipcMain.handle(IPC.terminalList, () => (rt.terminals ? rt.terminals.list() : []))
  ipcMain.handle(IPC.terminalCreate, (_e, opts: unknown) => requireTerminals(rt).create(asCreateOptions(opts)))
  ipcMain.handle(IPC.terminalAttach, (_e, id: unknown, size: unknown) =>
    requireTerminals(rt).attach(asId(id), asSize(size))
  )
  ipcMain.handle(IPC.terminalDetach, (_e, id: unknown) => requireTerminals(rt).detach(asId(id)))
  ipcMain.handle(IPC.terminalKill, (_e, id: unknown) => requireTerminals(rt).kill(asId(id)))
  ipcMain.handle(IPC.terminalSetOpen, (_e, id: unknown, open: unknown) =>
    requireTerminals(rt).setOpen(asId(id), open === true)
  )

  ipcMain.on(IPC.terminalWrite, (_e, id: unknown, data: unknown) => {
    if (typeof data === 'string') rt.terminals?.write(asId(id), data)
  })
  ipcMain.on(IPC.terminalResize, (_e, id: unknown, size: unknown) => {
    rt.terminals?.resize(asId(id), asSize(size))
  })
}
