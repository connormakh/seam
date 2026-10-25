import { describe, expect, it } from 'vitest'
import type { TerminalInfo } from '@shared/ipc'
import { groupUnits, initialTabs, nextShellTitle, tabsReducer, type TabsModel } from '../src/renderer/src/tabs-model'

const term = (id: string, o: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id,
  kind: 'shell',
  title: id,
  cwd: '/',
  currentCommand: 'zsh',
  createdAt: 0,
  attached: false,
  open: true,
  pairId: null,
  ...o
})

/** A Claude + shell pair, listed in creation order (Claude first). */
const pair = (claudeId: string, shellId: string, open = true): TerminalInfo[] => [
  term(claudeId, { kind: 'claude', pairId: shellId, open }),
  term(shellId, { pairId: claudeId, open })
]

const keys = (m: TabsModel): string[] => m.tabs.map((t) => t.key)
const members = (m: TabsModel, key: string): string[] =>
  m.tabs.find((t) => t.key === key)?.members.map((x) => x.id) ?? []

describe('groupUnits', () => {
  it('keeps pairs together, Claude first, in list order', () => {
    const units = groupUnits([term('a'), ...pair('c1', 's1'), term('b')])
    expect(units.map((u) => u.members.map((m) => m.id))).toEqual([['a'], ['c1', 's1'], ['b']])
  })

  it('puts Claude on the left even when the shell is listed first', () => {
    const [c, s] = pair('c1', 's1')
    expect(groupUnits([s!, c!])[0]?.members.map((m) => m.kind)).toEqual(['claude', 'shell'])
  })

  it('shows the survivor alone when its partner is gone', () => {
    const [c] = pair('c1', 's1')
    expect(groupUnits([c!]).map((u) => u.members.map((m) => m.id))).toEqual([['c1']])
  })

  it('ignores a one-sided link', () => {
    const units = groupUnits([term('x', { pairId: 'y' }), term('y')])
    expect(units).toHaveLength(2)
  })
})

describe('tabsReducer', () => {
  const restored = tabsReducer(initialTabs, {
    type: 'restore',
    terminals: [term('a'), ...pair('c1', 's1'), term('b', { open: false }), ...pair('c2', 's2', false)]
  })

  it('restores open units as tabs and the rest as background', () => {
    expect(keys(restored)).toEqual(['a', 'c1'])
    expect(members(restored, 'c1')).toEqual(['c1', 's1'])
    expect(restored.background.map((b) => b.key)).toEqual(['b', 'c2'])
    expect(restored.activeKey).toBe('a')
  })

  it('focuses Claude in a new pair, and toggles focus between the two sides', () => {
    let s = tabsReducer(restored, { type: 'activate', key: 'c1' })
    expect(s.tabs[1]?.focusId).toBe('c1')
    s = tabsReducer(s, { type: 'toggle-focus' })
    expect(s.tabs[1]?.focusId).toBe('s1')
    s = tabsReducer(s, { type: 'toggle-focus' })
    expect(s.tabs[1]?.focusId).toBe('c1')
  })

  it('does nothing on toggle-focus for a single terminal', () => {
    expect(tabsReducer(restored, { type: 'toggle-focus' })).toBe(restored)
  })

  it('moves focus when a pane is clicked', () => {
    const s = tabsReducer(restored, { type: 'focus', id: 's1' })
    expect(s.tabs[1]?.focusId).toBe('s1')
  })

  it('keeps the other side when one side of a pair ends', () => {
    let s = tabsReducer(restored, { type: 'focus', id: 's1' })
    s = tabsReducer({ ...s, activeKey: 'c1' }, { type: 'remove-terminal', id: 's1' })
    expect(members(s, 'c1')).toEqual(['c1'])
    expect(s.tabs[1]?.focusId).toBe('c1')
    expect(s.activeKey).toBe('c1')
  })

  it('drops the tab and picks a neighbour once both sides end', () => {
    let s: TabsModel = { ...restored, activeKey: 'c1' }
    s = tabsReducer(s, { type: 'remove-terminal', id: 'c1' })
    expect(keys(s)).toEqual(['a', 'c1']) // shell still running, same tab
    s = tabsReducer(s, { type: 'remove-terminal', id: 's1' })
    expect(keys(s)).toEqual(['a'])
    expect(s.activeKey).toBe('a')
  })

  it('removes a whole unit and activates its neighbour', () => {
    const s = tabsReducer({ ...restored, activeKey: 'a' }, { type: 'remove-unit', key: 'a' })
    expect(keys(s)).toEqual(['c1'])
    expect(s.activeKey).toBe('c1')
  })

  it('opens a background pair as one tab', () => {
    const s = tabsReducer(restored, { type: 'open-from-background', key: 'c2' })
    expect(keys(s)).toEqual(['a', 'c1', 'c2'])
    expect(members(s, 'c2')).toEqual(['c2', 's2'])
    expect(s.background.map((b) => b.key)).toEqual(['b'])
    expect(s.activeKey).toBe('c2')
    expect(s.tabs.at(-1)?.members.every((m) => m.open)).toBe(true)
  })

  it('never lists a terminal in both tabs and background', () => {
    const s = tabsReducer(restored, {
      type: 'set-background',
      terminals: [term('a'), ...pair('c1', 's1'), term('b'), term('z')]
    })
    expect(s.background.map((b) => b.key)).toEqual(['b', 'z'])
  })

  it('remounts only the member whose client dropped', () => {
    const s = tabsReducer(restored, { type: 'remount', id: 's1' })
    expect(s.tabs[1]?.generations).toEqual({ s1: 1 })
  })

  it('selects tabs by index within range', () => {
    expect(tabsReducer(restored, { type: 'select-index', index: 1 }).activeKey).toBe('c1')
    expect(tabsReducer(restored, { type: 'select-index', index: 8 })).toBe(restored)
  })
})

describe('nextShellTitle', () => {
  it('picks the first free title', () => {
    expect(nextShellTitle([])).toBe('shell')
    expect(nextShellTitle(['shell', 'shell 3'])).toBe('shell 2')
  })
})
