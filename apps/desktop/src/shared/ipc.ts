/**
 * The contract between the renderer and the main process.
 *
 * Every channel name and payload lives here so main, preload and renderer
 * cannot drift apart. The renderer only ever sees `SeamApi`; it never gets
 * ipcRenderer or any Node API directly.
 */

export const IPC = {
  appInfo: 'app:info'
} as const

export interface AppInfo {
  name: string
  version: string
  platform: string
  electron: string
}

export interface SeamApi {
  appInfo(): Promise<AppInfo>
}
