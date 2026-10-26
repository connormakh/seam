import { describe, expect, it } from 'vitest'
import type { TerminalInfo, Workspace } from '@shared/ipc'
import { groupByWorkspace, makeUnit, type TabsModel } from '../src/renderer/src/tabs-model'

const term = (id: string, root: string, kind: TerminalInfo['kind'] = 'claude'): TerminalInfo => ({
  id,
  kind,
  title: id,
  cwd: root,
  currentCommand: 'zsh',
  private: false,
  root,
  createdAt: 0,
  attached: false,
  open: true,
  pairId: null
})

const model = (tabs: TerminalInfo[][], background: TerminalInfo[][] = []): TabsModel => ({
  tabs: tabs.map(makeUnit),
  background: background.map(makeUnit),
  activeKey: null,
  restored: true
})

const saved: Workspace[] = [
  { root: '/w/app', name: 'app' },
  { root: '/w/docs', name: 'docs' }
]

describe('grouping sessions by workspace', () => {
  it('puts every session under the folder it was opened on', () => {
    const groups = groupByWorkspace(model([[term('a1', '/w/app')], [term('d1', '/w/docs')]]), saved)
    expect(groups.map((g) => [g.workspace.name, g.tabs.length])).toEqual([
      ['app', 1],
      ['docs', 1]
    ])
  })

  it('holds more than one session in a workspace, which is the point', () => {
    const groups = groupByWorkspace(model([[term('a1', '/w/app')], [term('a2', '/w/app')]]), saved)
    expect(groups[0]!.tabs.map((u) => u.key)).toEqual(['a1', 'a2'])
    expect(groups[1]!.tabs).toEqual([])
  })

  it('keeps a workspace with nothing running, in its saved order', () => {
    const groups = groupByWorkspace(model([]), saved)
    expect(groups.map((g) => g.workspace.root)).toEqual(['/w/app', '/w/docs'])
    expect(groups.every((g) => g.tabs.length === 0 && g.background.length === 0)).toBe(true)
  })

  it('separates what is open from what is only running', () => {
    const groups = groupByWorkspace(model([[term('a1', '/w/app')]], [[term('a2', '/w/app')]]), saved)
    expect(groups[0]!.tabs.map((u) => u.key)).toEqual(['a1'])
    expect(groups[0]!.background.map((u) => u.key)).toEqual(['a2'])
  })

  it('still shows a terminal whose workspace was never saved', () => {
    const groups = groupByWorkspace(model([[term('x1', '/w/scratch')]]), saved)
    expect(groups.at(-1)).toMatchObject({ workspace: { root: '/w/scratch', name: 'scratch' } })
    expect(groups.at(-1)!.tabs).toHaveLength(1)
  })

  it('gathers rootless terminals rather than losing them', () => {
    const groups = groupByWorkspace(model([[term('old', '')]]), saved)
    expect(groups.at(-1)).toMatchObject({ workspace: { root: '', name: 'Elsewhere' } })
  })

  it('lists no empty group for a workspace that was never saved', () => {
    expect(groupByWorkspace(model([]), [])).toEqual([])
  })
})
