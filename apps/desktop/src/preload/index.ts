import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type ApprovalRequest,
  type AuditEntry,
  type SessionStatus,
  type CommandsChangedEvent,
  type MenuCommand,
  type SeamApi,
  type TerminalDataEvent,
  type TerminalExitEvent
} from '@shared/ipc'

// One IPC listener per channel, fanned out by terminal id, instead of one
// ipcRenderer listener per open tab.
const dataListeners = new Map<string, Set<(data: string) => void>>()
const exitListeners = new Set<(event: TerminalExitEvent) => void>()

ipcRenderer.on(IPC.terminalData, (_e, event: TerminalDataEvent) => {
  for (const fn of dataListeners.get(event.id) ?? []) fn(event.data)
})
ipcRenderer.on(IPC.terminalExit, (_e, event: TerminalExitEvent) => {
  for (const fn of exitListeners) fn(event)
})

const menuListeners = new Set<(command: MenuCommand) => void>()
ipcRenderer.on(IPC.menuCommand, (_e, command: MenuCommand) => {
  for (const fn of menuListeners) fn(command)
})

const approvalAskedListeners = new Set<(request: ApprovalRequest) => void>()
ipcRenderer.on(IPC.approvalAsked, (_e, request: ApprovalRequest) => {
  for (const l of approvalAskedListeners) l(request)
})

const approvalDoneListeners = new Set<(event: { id: string }) => void>()
ipcRenderer.on(IPC.approvalDone, (_e, event: { id: string }) => {
  for (const l of approvalDoneListeners) l(event)
})

const auditListeners = new Set<(entry: AuditEntry) => void>()
ipcRenderer.on(IPC.auditAppended, (_e, entry: AuditEntry) => {
  for (const l of auditListeners) l(entry)
})

const statusListeners = new Set<(status: SessionStatus) => void>()
ipcRenderer.on(IPC.sessionStatusChanged, (_e, status: SessionStatus) => {
  for (const l of statusListeners) l(status)
})

const attachListeners = new Set<(event: { sessionId: string; queued: number }) => void>()
ipcRenderer.on(IPC.attachQueueChanged, (_e, event: { sessionId: string; queued: number }) => {
  for (const l of attachListeners) l(event)
})

const commandListeners = new Set<(event: CommandsChangedEvent) => void>()
ipcRenderer.on(IPC.commandsChanged, (_e, event: CommandsChangedEvent) => {
  for (const fn of commandListeners) fn(event)
})

const api: SeamApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  commands: {
    latest: (terminalId) => ipcRenderer.invoke(IPC.commandsLatest, terminalId),
    sendLastToClaude: (shellId, claudeId) => ipcRenderer.invoke(IPC.contextSendLast, shellId, claudeId),
    onChanged: (listener) => {
      commandListeners.add(listener)
      return () => commandListeners.delete(listener)
    }
  },
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  approvals: {
    open: () => ipcRenderer.invoke(IPC.approvalsOpen),
    resolve: (id, decision) => ipcRenderer.send(IPC.approvalsResolve, id, decision),
    onAsked: (listener) => {
      approvalAskedListeners.add(listener)
      return () => approvalAskedListeners.delete(listener)
    },
    onDone: (listener) => {
      approvalDoneListeners.add(listener)
      return () => approvalDoneListeners.delete(listener)
    }
  },
  sessions: {
    statuses: () => ipcRenderer.invoke(IPC.sessionStatuses),
    onStatus: (listener) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    }
  },
  attach: {
    last: (shellId, claudeId) => ipcRenderer.invoke(IPC.contextAttachLast, shellId, claudeId),
    clear: (sessionId) => ipcRenderer.send(IPC.attachClear, sessionId),
    onChanged: (listener) => {
      attachListeners.add(listener)
      return () => attachListeners.delete(listener)
    }
  },
  autoSync: {
    get: (sessionId) => ipcRenderer.invoke(IPC.autoSyncGet, sessionId),
    set: (sessionId, on) => ipcRenderer.send(IPC.autoSyncSet, sessionId, on)
  },
  policy: {
    get: (root) => ipcRenderer.invoke(IPC.policyGet, root),
    set: (root, mode) => ipcRenderer.send(IPC.policySet, root, mode)
  },
  workspaces: {
    list: () => ipcRenderer.invoke(IPC.workspaceList),
    forget: (root) => ipcRenderer.invoke(IPC.workspaceForget, root)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch)
  },
  audit: {
    list: () => ipcRenderer.invoke(IPC.auditList),
    onAppended: (listener) => {
      auditListeners.add(listener)
      return () => auditListeners.delete(listener)
    }
  },
  onMenuCommand: (listener) => {
    menuListeners.add(listener)
    return () => menuListeners.delete(listener)
  },
  terminals: {
    list: () => ipcRenderer.invoke(IPC.terminalList),
    create: (opts) => ipcRenderer.invoke(IPC.terminalCreate, opts ?? {}),
    createPair: (opts) => ipcRenderer.invoke(IPC.terminalCreatePair, opts),
    attach: (id, size) => ipcRenderer.invoke(IPC.terminalAttach, id, size),
    detach: (id) => ipcRenderer.invoke(IPC.terminalDetach, id),
    kill: (id) => ipcRenderer.invoke(IPC.terminalKill, id),
    setOpen: (id, open) => ipcRenderer.invoke(IPC.terminalSetOpen, id, open),
    setPrivate: (id, isPrivate) => ipcRenderer.invoke(IPC.terminalSetPrivate, id, isPrivate),
    write: (id, data) => ipcRenderer.send(IPC.terminalWrite, id, data),
    resize: (id, size) => ipcRenderer.send(IPC.terminalResize, id, size),
    onData: (id, listener) => {
      let set = dataListeners.get(id)
      if (!set) dataListeners.set(id, (set = new Set()))
      set.add(listener)
      return () => {
        set.delete(listener)
        if (set.size === 0) dataListeners.delete(id)
      }
    },
    onExit: (listener) => {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    }
  }
}

contextBridge.exposeInMainWorld('seam', api)
