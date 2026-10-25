import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC, type AppInfo } from '@shared/ipc'
import type { TerminalService } from './terminals/terminal-service'
import type { Runtime } from './runtime'
import { asCreateOptions, asCreatePairOptions, asId, asSize } from './validate'

function requireTerminals(rt: Runtime): TerminalService {
  if (!rt.terminals) throw new Error('tmux is not installed')
  return rt.terminals
}

/**
 * Fire-and-forget channels have no caller to report errors to, and a throw
 * inside ipcMain.on is an uncaught exception in main. Drop bad input instead.
 */
function quietly(fn: () => void): void {
  try {
    fn()
  } catch {
    // Invalid payload or a terminal that just closed: nothing useful to do.
  }
}

export function registerIpc(rt: Runtime, opts: { homeDir: string }): void {
  // The picker opens where the last pick was, which is usually the next project's neighbour.
  let lastFolder = opts.homeDir
  ipcMain.handle(IPC.pickFolder, async (e): Promise<string | null> => {
    // Headless smoke tests cannot click a native dialog.
    const smoke = process.env['SEAM_SMOKE_PICK_FOLDER']
    if (smoke) return smoke
    const win = BrowserWindow.fromWebContents(e.sender)
    const pickOpts: Electron.OpenDialogOptions = {
      title: 'Choose a project folder',
      buttonLabel: 'Open Pair',
      defaultPath: lastFolder,
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win ? await dialog.showOpenDialog(win, pickOpts) : await dialog.showOpenDialog(pickOpts)
    const picked = result.canceled ? undefined : result.filePaths[0]
    if (!picked) return null
    lastFolder = picked
    return picked
  })

  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron ?? 'unknown',
    tmux: rt.tmuxVersion
  }))

  ipcMain.handle(IPC.terminalList, () => (rt.terminals ? rt.terminals.list() : []))
  ipcMain.handle(IPC.terminalCreate, (_e, opts: unknown) => requireTerminals(rt).create(asCreateOptions(opts)))
  ipcMain.handle(IPC.terminalCreatePair, (_e, opts: unknown) =>
    requireTerminals(rt).createPair(asCreatePairOptions(opts))
  )
  ipcMain.handle(IPC.terminalAttach, (_e, id: unknown, size: unknown) =>
    requireTerminals(rt).attach(asId(id), asSize(size))
  )
  ipcMain.handle(IPC.terminalDetach, (_e, id: unknown) => requireTerminals(rt).detach(asId(id)))
  ipcMain.handle(IPC.terminalKill, (_e, id: unknown) => requireTerminals(rt).kill(asId(id)))
  ipcMain.handle(IPC.terminalSetOpen, (_e, id: unknown, open: unknown) =>
    requireTerminals(rt).setOpen(asId(id), open === true)
  )

  ipcMain.on(IPC.terminalWrite, (_e, id: unknown, data: unknown) =>
    quietly(() => {
      if (typeof data === 'string') rt.terminals?.write(asId(id), data)
    })
  )
  ipcMain.on(IPC.terminalResize, (_e, id: unknown, size: unknown) =>
    quietly(() => rt.terminals?.resize(asId(id), asSize(size)))
  )
}
