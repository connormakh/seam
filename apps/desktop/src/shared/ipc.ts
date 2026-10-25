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
  terminalCreatePair: 'terminal:create-pair',
  pickFolder: 'dialog:pick-folder',
  terminalAttach: 'terminal:attach',
  terminalDetach: 'terminal:detach',
  terminalKill: 'terminal:kill',
  terminalSetOpen: 'terminal:set-open',
  /** renderer -> main, fire and forget */
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  /** main -> renderer events */
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  menuCommand: 'menu:command',
  commandsLatest: 'commands:latest',
  /** main -> renderer: a terminal's latest command started or finished */
  commandsChanged: 'commands:changed'
} as const

/** Commands the application menu (and its shortcuts) sends to the window. */
export type MenuCommand =
  | { type: 'new-pair' }
  | { type: 'new-shell' }
  | { type: 'toggle-focus' }
  | { type: 'close-tab' }
  | { type: 'end-terminal' }
  | { type: 'select-tab'; index: number }

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
  /** Shown in a tab. False means it runs in the background until reopened. */
  open: boolean
  /** The other half of a Claude + shell pair, or null for a standalone terminal. */
  pairId: string | null
}

/** A command run in a Seam shell, without its output. */
export interface CommandSummary {
  id: number
  terminalId: string
  command: string
  cwd: string
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  running: boolean
  /** Lines of output, once captured; null while running or if unreadable. */
  outputLines: number | null
}

export interface CreatePairOptions {
  /** Project folder; both sides start here. */
  cwd: string
  /** Defaults to the folder name. */
  title?: string
}

export interface PairInfo {
  claude: TerminalInfo
  shell: TerminalInfo
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
  /** Claude Code and its companion shell, side by side in one folder. */
  createPair(opts: CreatePairOptions): Promise<PairInfo>
  /** Start streaming a terminal into this window. Resolves once attached. */
  attach(id: string, size: TerminalSize): Promise<void>
  /** Stop streaming; the terminal keeps running in the background. */
  detach(id: string): Promise<void>
  /** End the terminal and its processes. */
  kill(id: string): Promise<void>
  /** Remember whether the terminal has a tab, so relaunch restores the same tabs. */
  setOpen(id: string, open: boolean): Promise<void>
  write(id: string, data: string): void
  resize(id: string, size: TerminalSize): void
  onData(id: string, listener: (data: string) => void): () => void
  onExit(listener: (event: TerminalExitEvent) => void): () => void
}

export interface CommandsChangedEvent {
  terminalId: string
  latest: CommandSummary
}

export interface CommandsApi {
  /** The latest command in a terminal, running or finished. */
  latest(terminalId: string): Promise<CommandSummary | null>
  onChanged(listener: (event: CommandsChangedEvent) => void): () => void
}

export interface SeamApi {
  appInfo(): Promise<AppInfo>
  commands: CommandsApi
  /** Native folder picker. Resolves null when cancelled. */
  pickFolder(): Promise<string | null>
  terminals: TerminalApi
  onMenuCommand(listener: (command: MenuCommand) => void): () => void
}
