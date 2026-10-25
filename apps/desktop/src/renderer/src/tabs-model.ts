import type { TerminalInfo } from '@shared/ipc'

/**
 * Which terminals have tabs, which run in the background, and which tab is
 * active. A pure reducer so every change is computed from the latest state
 * in one step (no setState inside another setState's updater).
 */

export interface Tab {
  info: TerminalInfo
  /** Bumped to remount the view, which re-attaches a fresh client. */
  generation: number
}

export interface TabsModel {
  tabs: Tab[]
  background: TerminalInfo[]
  activeId: string | null
  restored: boolean
}

export type TabsAction =
  | { type: 'restore'; terminals: TerminalInfo[] }
  | { type: 'add'; info: TerminalInfo }
  | { type: 'open-from-background'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'set-background'; terminals: TerminalInfo[] }
  | { type: 'activate'; id: string }
  | { type: 'select-index'; index: number }
  | { type: 'remount'; id: string }

export const initialTabs: TabsModel = { tabs: [], background: [], activeId: null, restored: false }

export function tabsReducer(state: TabsModel, action: TabsAction): TabsModel {
  switch (action.type) {
    case 'restore': {
      const open = action.terminals.filter((t) => t.open)
      return {
        tabs: open.map((info) => ({ info, generation: 0 })),
        background: action.terminals.filter((t) => !t.open),
        activeId: open[0]?.id ?? null,
        restored: true
      }
    }

    case 'add': {
      if (state.tabs.some((t) => t.info.id === action.info.id)) return { ...state, activeId: action.info.id }
      return {
        ...state,
        tabs: [...state.tabs, { info: action.info, generation: 0 }],
        background: state.background.filter((b) => b.id !== action.info.id),
        activeId: action.info.id
      }
    }

    case 'open-from-background': {
      const info = state.background.find((b) => b.id === action.id)
      if (!info) return state
      return tabsReducer(state, { type: 'add', info: { ...info, open: true } })
    }

    case 'remove': {
      const i = state.tabs.findIndex((t) => t.info.id === action.id)
      const tabs = state.tabs.filter((t) => t.info.id !== action.id)
      let activeId = state.activeId
      if (activeId === action.id) {
        // The tab that slides into the closed one's place, or the new last tab.
        activeId = (tabs[Math.min(Math.max(i, 0), tabs.length - 1)] ?? null)?.info.id ?? null
      }
      return { ...state, tabs, activeId, background: state.background.filter((b) => b.id !== action.id) }
    }

    case 'set-background': {
      const inTabs = new Set(state.tabs.map((t) => t.info.id))
      return { ...state, background: action.terminals.filter((t) => !inTabs.has(t.id)) }
    }

    case 'activate':
      return state.tabs.some((t) => t.info.id === action.id) ? { ...state, activeId: action.id } : state

    case 'select-index': {
      const tab = state.tabs[action.index]
      return tab ? { ...state, activeId: tab.info.id } : state
    }

    case 'remount':
      return {
        ...state,
        tabs: state.tabs.map((t) => (t.info.id === action.id ? { ...t, generation: t.generation + 1 } : t))
      }
  }
}

/** First free "shell", "shell 2", ... among the given titles. */
export function nextShellTitle(taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has('shell')) return 'shell'
  for (let n = 2; ; n++) if (!used.has(`shell ${n}`)) return `shell ${n}`
}
