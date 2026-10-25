import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type SeamApi } from '@shared/ipc'

const api: SeamApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo)
}

contextBridge.exposeInMainWorld('seam', api)
