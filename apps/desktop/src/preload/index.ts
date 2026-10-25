import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
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

const api: SeamApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  terminals: {
    list: () => ipcRenderer.invoke(IPC.terminalList),
    create: (opts) => ipcRenderer.invoke(IPC.terminalCreate, opts ?? {}),
    attach: (id, size) => ipcRenderer.invoke(IPC.terminalAttach, id, size),
    detach: (id) => ipcRenderer.invoke(IPC.terminalDetach, id),
    kill: (id) => ipcRenderer.invoke(IPC.terminalKill, id),
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
