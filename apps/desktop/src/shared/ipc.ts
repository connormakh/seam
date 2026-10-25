/**
 * The contract between the renderer and the main process.
 *
 * Every channel name and payload lives here so main, preload and renderer
 * cannot drift apart. The renderer only ever sees `SeamApi`; it never gets
 * ipcRenderer or any Node API directly.
 */

export const IPC = {
  appInfo: 'app:info',
  terminalList: 'terminal:list',
  terminalCreate: 'terminal:create',
  terminalAttach: 'terminal:attach',
  terminalDetach: 'terminal:detach',
  terminalKill: 'terminal:kill',
  /** renderer -> main, fire and forget */
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  /** main -> renderer events */
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit'
} as const

export interface AppInfo {
  name: string
  version: string
  platform: string
  electron: string
  tmux: string | null
}

export type TerminalKind = 'shell' | 'claude'

/** A terminal Seam knows about. It may be running with or without a tab open. */
export interface TerminalInfo {
  id: string
  kind: TerminalKind
  title: string
  cwd: string
  /** Foreground program in the terminal, e.g. "zsh" or "npm". */
  currentCommand: string
  createdAt: number
  /** True while this window has a live attachment to it. */
  attached: boolean
}

export interface CreateTerminalOptions {
  kind?: TerminalKind
  cwd?: string
  title?: string
}

export interface TerminalSize {
  cols: number
  rows: number
}

export interface TerminalDataEvent {
  id: string
  data: string
}

export interface TerminalExitEvent {
  id: string
  /** True when the underlying session is gone, not just this tab's client. */
  ended: boolean
}

export interface TerminalApi {
  list(): Promise<TerminalInfo[]>
  create(opts?: CreateTerminalOptions): Promise<TerminalInfo>
  /** Start streaming a terminal into this window. Resolves once attached. */
  attach(id: string, size: TerminalSize): Promise<void>
  /** Stop streaming; the terminal keeps running in the background. */
  detach(id: string): Promise<void>
  /** End the terminal and its processes. */
  kill(id: string): Promise<void>
  write(id: string, data: string): void
  resize(id: string, size: TerminalSize): void
  onData(id: string, listener: (data: string) => void): () => void
  onExit(listener: (event: TerminalExitEvent) => void): () => void
}

export interface SeamApi {
  appInfo(): Promise<AppInfo>
  terminals: TerminalApi
}
