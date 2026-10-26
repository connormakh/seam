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
  terminalSetPrivate: 'terminal:set-private',
  /** renderer -> main, fire and forget */
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  /** main -> renderer events */
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  menuCommand: 'menu:command',
  commandsLatest: 'commands:latest',
  contextSendLast: 'context:send-last',
  /** main -> renderer: a terminal's latest command started or finished */
  commandsChanged: 'commands:changed',
  /** Claude to shell: cards waiting, the user's answer, and the audit feed */
  approvalsOpen: 'approvals:open',
  approvalsResolve: 'approvals:resolve',
  /** main -> renderer */
  approvalAsked: 'approvals:asked',
  approvalDone: 'approvals:done',
  auditAppended: 'audit:appended',
  auditList: 'audit:list',
  /** Hooks: what each Claude session is doing, and what is queued for it */
  sessionStatuses: 'session:statuses',
  sessionStatusChanged: 'session:status-changed',
  contextAttachLast: 'context:attach-last',
  attachQueueChanged: 'attach:changed',
  attachClear: 'attach:clear',
  autoSyncSet: 'autosync:set',
  autoSyncGet: 'autosync:get',
  policyGet: 'policy:get',
  policySet: 'policy:set'
} as const

/** Commands the application menu (and its shortcuts) sends to the window. */
export type MenuCommand =
  | { type: 'new-pair' }
  | { type: 'new-shell' }
  | { type: 'toggle-focus' }
  /** A pair reads left to right as Claude, then shell. */
  | { type: 'focus-side'; side: 'left' | 'right' }
  | { type: 'send-last' }
  | { type: 'attach-last' }
  | { type: 'toggle-activity' }
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
  /** Hidden from Claude entirely: not listed, not readable, not writable. */
  private: boolean
  /** The folder the pair was opened on; what policy and scope are keyed by. */
  root: string
}

/**
 * What a Claude session is doing, from its hooks.
 *
 * `waiting` is the one that matters: it means Claude has asked the user
 * something and nothing moves until they look.
 */
export type SessionState = 'working' | 'waiting' | 'idle'

export interface SessionStatus {
  sessionId: string
  state: SessionState
  /** The start of Claude's last message, for a tab that is not in front. */
  preview: string | null
  /** True once a turn has finished that the user has not looked at. */
  unseen: boolean
  changedAt: number
}

/** What Claude wants to do in a shell, waiting on the user's answer. */
export interface ApprovalRequest {
  id: string
  /** The Claude terminal that asked. */
  sessionId: string
  /** The shell it wants to act on; the card appears on this pane. */
  shellId: string
  shellTitle: string
  /** What it would run, or the keys it would send, exactly as given. */
  command: string
  tool: 'run_in_shell' | 'send_keys'
  /** What "approve similar" would remember, e.g. "git status". */
  similar: string
  /** Why it is being asked rather than just run, in the card's own words. */
  why: string
  askedAt: number
}

export type ApprovalDecision = 'approve' | 'approve-similar' | 'deny'

/** What Claude may run in a workspace's shells without being asked. */
export type PolicyMode = 'allow' | 'ask' | 'allowlist' | 'readonly'

/** One line of the record of what Claude asked for and what happened. */
export interface AuditEntry {
  id: number
  at: number
  sessionId: string
  shellId: string | null
  tool: string
  detail: string
  outcome: 'allowed' | 'approved' | 'denied' | 'failed'
  why: string
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
  /** Who typed it. The shell is shared, so this is how you tell them apart. */
  actor: 'user' | 'claude'
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
  setPrivate(id: string, isPrivate: boolean): Promise<TerminalInfo[]>
  write(id: string, data: string): void
  resize(id: string, size: TerminalSize): void
  onData(id: string, listener: (data: string) => void): () => void
  onExit(listener: (event: TerminalExitEvent) => void): () => void
}

/** What Shell to Claude pasted into Claude's prompt. */
export interface SendContextResult {
  command: string
  exitCode: number | null
  /** Output lines included. */
  lines: number
  truncated: boolean
  masked: number
}

export interface CommandsChangedEvent {
  terminalId: string
  latest: CommandSummary
}

export interface CommandsApi {
  /** The latest command in a terminal, running or finished. */
  latest(terminalId: string): Promise<CommandSummary | null>
  onChanged(listener: (event: CommandsChangedEvent) => void): () => void
  /**
   * Paste the shell's last finished command, with its output, into the
   * paired Claude session's prompt (not sent).
   */
  sendLastToClaude(shellId: string, claudeId: string): Promise<SendContextResult>
}

export interface SeamApi {
  approvals: {
    open: () => Promise<ApprovalRequest[]>
    resolve: (id: string, decision: ApprovalDecision) => void
    onAsked: (listener: (request: ApprovalRequest) => void) => () => void
    onDone: (listener: (event: { id: string }) => void) => () => void
  }
  sessions: {
    statuses: () => Promise<SessionStatus[]>
    onStatus: (listener: (status: SessionStatus) => void) => () => void
  }
  attach: {
    last: (shellId: string, claudeId: string) => Promise<SendContextResult>
    clear: (sessionId: string) => void
    onChanged: (listener: (event: { sessionId: string; queued: number }) => void) => () => void
  }
  autoSync: {
    get: (sessionId: string) => Promise<boolean>
    set: (sessionId: string, on: boolean) => void
  }
  policy: {
    get: (root: string) => Promise<PolicyMode>
    set: (root: string, mode: PolicyMode) => void
  }
  audit: {
    list: () => Promise<AuditEntry[]>
    onAppended: (listener: (entry: AuditEntry) => void) => () => void
  }
  appInfo(): Promise<AppInfo>
  commands: CommandsApi
  /** Native folder picker. Resolves null when cancelled. */
  pickFolder(): Promise<string | null>
  terminals: TerminalApi
  onMenuCommand(listener: (command: MenuCommand) => void): () => void
}
