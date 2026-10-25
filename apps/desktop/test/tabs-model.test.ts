import { describe, expect, it } from 'vitest'
import type { TerminalInfo } from '@shared/ipc'
import { initialTabs, nextShellTitle, tabsReducer, type TabsModel } from '../src/renderer/src/tabs-model'

const term = (id: string, open = true): TerminalInfo => ({
  id,
  kind: 'shell',
  title: id,
  cwd: '/',
  currentCommand: 'zsh',
  createdAt: 0,
  attached: false,
  open,
  pairId: null
})

const ids = (m: TabsModel): string[] => m.tabs.map((t) => t.info.id)

describe('tabsReducer', () => {
  const restored = tabsReducer(initialTabs, {
    type: 'restore',
    terminals: [term('a'), term('b', false), term('c'), term('d')]
  })

  it('restores open terminals as tabs and the rest as background', () => {
    expect(ids(restored)).toEqual(['a', 'c', 'd'])
    expect(restored.background.map((b) => b.id)).toEqual(['b'])
    expect(restored.activeId).toBe('a')
    expect(restored.restored).toBe(true)
  })

  it('activates the tab that slides into a closed active tab', () => {
    const s = tabsReducer({ ...restored, activeId: 'c' }, { type: 'remove', id: 'c' })
    expect(ids(s)).toEqual(['a', 'd'])
    expect(s.activeId).toBe('d')
  })

  it('activates the new last tab when the last tab closes', () => {
    const s = tabsReducer({ ...restored, activeId: 'd' }, { type: 'remove', id: 'd' })
    expect(s.activeId).toBe('c')
  })

  it('keeps the active tab when another one closes', () => {
    const s = tabsReducer({ ...restored, activeId: 'a' }, { type: 'remove', id: 'd' })
    expect(s.activeId).toBe('a')
  })

  it('has no active tab once every tab is gone', () => {
    let s = restored
    for (const id of ['a', 'c', 'd']) s = tabsReducer(s, { type: 'remove', id })
    expect(s.tabs).toEqual([])
    expect(s.activeId).toBeNull()
  })

  it('moves a background terminal into a tab and activates it', () => {
    const s = tabsReducer(restored, { type: 'open-from-background', id: 'b' })
    expect(ids(s)).toEqual(['a', 'c', 'd', 'b'])
    expect(s.background).toEqual([])
    expect(s.activeId).toBe('b')
    expect(s.tabs.at(-1)?.info.open).toBe(true)
  })

  it('never lists a terminal in both tabs and background', () => {
    const s = tabsReducer(restored, { type: 'set-background', terminals: [term('a'), term('b'), term('z')] })
    expect(s.background.map((b) => b.id)).toEqual(['b', 'z'])
  })

  it('ignores a duplicate add, and selects tabs by index within range', () => {
    expect(ids(tabsReducer(restored, { type: 'add', info: term('a') }))).toEqual(['a', 'c', 'd'])
    expect(tabsReducer(restored, { type: 'select-index', index: 2 }).activeId).toBe('d')
    expect(tabsReducer(restored, { type: 'select-index', index: 8 })).toBe(restored)
  })

  it('bumps only the remounted tab', () => {
    const s = tabsReducer(restored, { type: 'remount', id: 'c' })
    expect(s.tabs.map((t) => t.generation)).toEqual([0, 1, 0])
  })
})

describe('nextShellTitle', () => {
  it('picks the first free title', () => {
    expect(nextShellTitle([])).toBe('shell')
    expect(nextShellTitle(['shell', 'shell 3'])).toBe('shell 2')
    expect(nextShellTitle(['shell', 'shell 2'])).toBe('shell 3')
  })
})
