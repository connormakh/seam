import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import {
  IPC,
  type AppInfo,
  type ApprovalDecision,
  type ApprovalRequest,
  type AuditEntry,
  type SendContextResult,
  type SessionStatus
} from '@shared/ipc'
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
  // Claude to shell. A reopened tab asks what is already waiting, because the
  // card lives in main: it must outlive the view it is drawn on.
  ipcMain.handle(IPC.approvalsOpen, async (): Promise<ApprovalRequest[]> => rt.approvals?.open() ?? [])
  ipcMain.handle(IPC.auditList, async (): Promise<AuditEntry[]> => rt.audit?.list() ?? [])
  ipcMain.handle(IPC.sessionStatuses, async (): Promise<SessionStatus[]> => rt.hooks?.statusList() ?? [])
  ipcMain.handle(IPC.autoSyncGet, async (_e, id: unknown): Promise<boolean> =>
    typeof id === 'string' ? (rt.autoSync?.enabled(id) ?? false) : false
  )
  ipcMain.on(IPC.autoSyncSet, (_e, id: unknown, on: unknown) =>
    quietly(() => {
      if (typeof id === 'string' && typeof on === 'boolean') rt.autoSync?.setEnabled(id, on)
    })
  )
  ipcMain.on(IPC.attachClear, (_e, id: unknown) =>
    quietly(() => {
      if (typeof id === 'string') rt.hooks?.clearAttached(id)
    })
  )
  // Attach mode: hold the shell's last command for Claude's next prompt
  // rather than typing it in, which also works while Claude is mid-turn.
  ipcMain.handle(IPC.contextAttachLast, async (_e, shellId: unknown, claudeId: unknown): Promise<SendContextResult> => {
    if (!rt.context || !rt.hooks) throw new Error('tmux is not installed')
    const result = await rt.context.attachLast(asId(shellId), asId(claudeId))
    rt.hooks.attach(asId(claudeId), result.text)
    const { text: _text, ...summary } = result
    return summary
  })
  ipcMain.on(IPC.approvalsResolve, (_e, id: unknown, decision: unknown) =>
    quietly(() => {
      if (typeof id !== 'string') return
      if (decision !== 'approve' && decision !== 'approve-similar' && decision !== 'deny') return
      rt.approvals?.resolve(id, decision as ApprovalDecision)
    })
  )

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

  ipcMain.handle(IPC.contextSendLast, (_e, shellId: unknown, claudeId: unknown) => {
    if (!rt.context) throw new Error('tmux is not installed')
    return rt.context.sendLast(asId(shellId), asId(claudeId))
  })
  ipcMain.handle(IPC.commandsLatest, (_e, id: unknown) => rt.commands?.latest(asId(id)) ?? null)

  ipcMain.handle(IPC.terminalList, () => (rt.terminals ? rt.terminals.list() : []))
  ipcMain.handle(IPC.terminalCreate, (_e, opts: unknown) => requireTerminals(rt).create(asCreateOptions(opts)))
  ipcMain.handle(IPC.terminalCreatePair, (_e, opts: unknown) =>
    requireTerminals(rt).createPair(asCreatePairOptions(opts))
  )
  ipcMain.handle(IPC.terminalAttach, (_e, id: unknown, size: unknown) =>
    requireTerminals(rt).attach(asId(id), asSize(size))
  )
  ipcMain.handle(IPC.terminalDetach, (_e, id: unknown) => requireTerminals(rt).detach(asId(id)))
  ipcMain.handle(IPC.terminalKill, async (_e, id: unknown) => {
    const terminalId = asId(id)
    await requireTerminals(rt).kill(terminalId)
    // A terminal without a tab has no client to report its exit; forget it here too.
    rt.commands?.forget(terminalId)
  })
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
