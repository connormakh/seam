import type { TerminalInfo } from '@shared/ipc'

/**
 * What the window shows: tabs, terminals running in the background, and
 * which tab is active. A tab holds a unit: one terminal, or a Claude + shell
 * pair shown side by side. A pure reducer, so every change is computed from
 * the latest state in one step.
 */

export interface Unit {
  /** Stable for the unit's lifetime: the first member's id (Claude, for a pair). */
  key: string
  /** [claude, shell] for a pair, a single terminal otherwise. */
  members: TerminalInfo[]
  /** Bumped per member to remount its view, which re-attaches a fresh client. */
  generations: Record<string, number>
  /** The member that gets the keyboard when this tab is shown. */
  focusId: string
}

export interface TabsModel {
  tabs: Unit[]
  background: Unit[]
  activeKey: string | null
  restored: boolean
}

export type TabsAction =
  | { type: 'restore'; terminals: TerminalInfo[] }
  | { type: 'add'; members: TerminalInfo[] }
  | { type: 'open-from-background'; key: string }
  | { type: 'remove-unit'; key: string }
  | { type: 'remove-terminal'; id: string }
  | { type: 'set-background'; terminals: TerminalInfo[] }
  /** Fresh facts about terminals already on screen, without regrouping them. */
  | { type: 'refresh'; terminals: TerminalInfo[] }
  | { type: 'activate'; key: string }
  | { type: 'select-index'; index: number }
  | { type: 'remount'; id: string }
  | { type: 'focus'; id: string }
  | { type: 'toggle-focus' }

export const initialTabs: TabsModel = { tabs: [], background: [], activeKey: null, restored: false }

export function makeUnit(members: TerminalInfo[]): Unit {
  const first = members[0]
  if (!first) throw new Error('a unit needs at least one terminal')
  // Claude first, so the pair reads left to right as Claude, then shell.
  const ordered = [...members].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'claude' ? -1 : 1))
  const lead = ordered[0] ?? first
  return { key: lead.id, members: ordered, generations: {}, focusId: lead.id }
}

/** Groups terminals into units, keeping pairs together and the list's order. */
export function groupUnits(terminals: TerminalInfo[]): Unit[] {
  const byId = new Map(terminals.map((t) => [t.id, t]))
  const placed = new Set<string>()
  const units: Unit[] = []
  for (const t of terminals) {
    if (placed.has(t.id)) continue
    const partner = t.pairId ? byId.get(t.pairId) : undefined
    const members = partner && partner.pairId === t.id && !placed.has(partner.id) ? [t, partner] : [t]
    for (const m of members) placed.add(m.id)
    units.push(makeUnit(members))
  }
  return units
}

export function unitTitle(u: Unit): string {
  return u.members[0]?.title ?? ''
}

export function isPair(u: Unit): boolean {
  return u.members.length === 2
}

const hasMember = (u: Unit, id: string): boolean => u.members.some((m) => m.id === id)

/** The tab that slides into a removed one's place, or the new last tab. */
function neighbour(tabs: Unit[], removedIndex: number): string | null {
  return tabs[Math.min(Math.max(removedIndex, 0), tabs.length - 1)]?.key ?? null
}

function withoutMember(u: Unit, id: string): Unit | null {
  const members = u.members.filter((m) => m.id !== id)
  if (members.length === 0) return null
  const generations = { ...u.generations }
  delete generations[id]
  const focusId = u.focusId === id ? (members[0]?.id ?? u.focusId) : u.focusId
  return { ...u, members, generations, focusId }
}

export function tabsReducer(state: TabsModel, action: TabsAction): TabsModel {
  switch (action.type) {
    case 'restore': {
      const units = groupUnits(action.terminals)
      const tabs = units.filter((u) => u.members.some((m) => m.open))
      return {
        tabs,
        background: units.filter((u) => !tabs.includes(u)),
        activeKey: tabs[0]?.key ?? null,
        restored: true
      }
    }

    case 'add': {
      const unit = makeUnit(action.members)
      if (state.tabs.some((t) => t.key === unit.key)) return { ...state, activeKey: unit.key }
      const ids = new Set(unit.members.map((m) => m.id))
      return {
        ...state,
        tabs: [...state.tabs, unit],
        background: state.background.filter((b) => !b.members.some((m) => ids.has(m.id))),
        activeKey: unit.key
      }
    }

    case 'open-from-background': {
      const unit = state.background.find((b) => b.key === action.key)
      if (!unit) return state
      return tabsReducer(state, { type: 'add', members: unit.members.map((m) => ({ ...m, open: true })) })
    }

    case 'remove-unit': {
      const i = state.tabs.findIndex((t) => t.key === action.key)
      const tabs = state.tabs.filter((t) => t.key !== action.key)
      const activeKey = state.activeKey === action.key ? neighbour(tabs, i) : state.activeKey
      return { ...state, tabs, activeKey, background: state.background.filter((b) => b.key !== action.key) }
    }

    case 'remove-terminal': {
      // One side of a pair ending leaves the other side as a single tab.
      const i = state.tabs.findIndex((t) => hasMember(t, action.id))
      const tabs: Unit[] = []
      let removedKey: string | null = null
      for (const t of state.tabs) {
        if (!hasMember(t, action.id)) {
          tabs.push(t)
          continue
        }
        const rest = withoutMember(t, action.id)
        if (rest) tabs.push(rest)
        else removedKey = t.key
      }
      const background = state.background.flatMap((b) => {
        if (!hasMember(b, action.id)) return [b]
        const rest = withoutMember(b, action.id)
        return rest ? [rest] : []
      })
      const activeKey = removedKey !== null && state.activeKey === removedKey ? neighbour(tabs, i) : state.activeKey
      return { ...state, tabs, background, activeKey }
    }

    case 'set-background': {
      const inTabs = new Set(state.tabs.flatMap((t) => t.members.map((m) => m.id)))
      const background = groupUnits(action.terminals).filter((u) => !u.members.some((m) => inTabs.has(m.id)))
      return { ...state, background }
    }

    case 'refresh': {
      const byId = new Map(action.terminals.map((t) => [t.id, t]))
      // Only what is already here is updated: a terminal that appeared since
      // belongs to 'restore', which decides where it goes.
      const swap = (u: Unit): Unit => ({ ...u, members: u.members.map((m) => byId.get(m.id) ?? m) })
      return { ...state, tabs: state.tabs.map(swap), background: state.background.map(swap) }
    }

    case 'activate':
      return state.tabs.some((t) => t.key === action.key) ? { ...state, activeKey: action.key } : state

    case 'select-index': {
      const tab = state.tabs[action.index]
      return tab ? { ...state, activeKey: tab.key } : state
    }

    case 'remount':
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          hasMember(t, action.id)
            ? { ...t, generations: { ...t.generations, [action.id]: (t.generations[action.id] ?? 0) + 1 } }
            : t
        )
      }

    case 'focus':
      return {
        ...state,
        tabs: state.tabs.map((t) => (hasMember(t, action.id) && t.focusId !== action.id ? { ...t, focusId: action.id } : t))
      }

    case 'toggle-focus': {
      const active = state.tabs.find((t) => t.key === state.activeKey)
      if (!active || !isPair(active)) return state
      const other = active.members.find((m) => m.id !== active.focusId)
      if (!other) return state
      return { ...state, tabs: state.tabs.map((t) => (t === active ? { ...t, focusId: other.id } : t)) }
    }
  }
}

/** First free "shell", "shell 2", ... among the given titles. */
export function nextShellTitle(taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has('shell')) return 'shell'
  for (let n = 2; ; n++) if (!used.has(`shell ${n}`)) return `shell ${n}`
}
