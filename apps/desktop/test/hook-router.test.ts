import { describe, expect, it, vi } from 'vitest'
import type { SessionStatus } from '@shared/ipc'
import type { Caller } from '../src/main/control/server'
import type { AutoSync } from '../src/main/hooks/auto-sync'
import { HookRouter } from '../src/main/hooks/router'

const caller: Caller = { sessionId: 'c1', root: '/p' }

function make(digest: string | null = null) {
  const statuses: SessionStatus[] = []
  const attach: { sessionId: string; queued: number }[] = []
  const router = new HookRouter({
    autoSync: { digest: vi.fn(async () => digest) } as unknown as AutoSync,
    shellNames: async () => ['shell', 'server'],
    onStatus: (s) => statuses.push(s),
    onAttachChanged: (sessionId, queued) => attach.push({ sessionId, queued })
  })
  const fire = (hook_event_name: string, extra: Record<string, unknown> = {}) =>
    router.handle(caller, { hook_event_name, ...extra })
  return { router, statuses, attach, fire }
}

describe('hook router', () => {
  it('follows a turn from working to waiting to idle', async () => {
    const { statuses, fire } = make()
    await fire('UserPromptSubmit')
    await fire('PermissionRequest')
    await fire('Stop', { last_assistant_message: 'Ran the tests; two failed.' })
    expect(statuses.map((s) => s.state)).toEqual(['working', 'waiting', 'idle'])
    // The preview comes from the message on the event, not the transcript file.
    expect(statuses.at(-1)).toMatchObject({ unseen: true, preview: 'Ran the tests; two failed.' })
  })

  it('ignores a subagent, whose turn is not the pair’s', async () => {
    const { statuses, fire } = make()
    await fire('Stop', { agent_id: 'sub-1', last_assistant_message: 'done' })
    expect(statuses).toEqual([])
  })

  it('stops being unseen once the user has looked', async () => {
    const { router, statuses, fire } = make()
    await fire('Stop', { last_assistant_message: 'done' })
    router.seen('c1')
    expect(statuses.at(-1)).toMatchObject({ state: 'idle', unseen: false })
    // Nothing more to report the second time.
    const count = statuses.length
    router.seen('c1')
    expect(statuses).toHaveLength(count)
  })

  it('hands over what was attached at the next prompt, once', async () => {
    const { router, fire, attach } = make()
    router.attach('c1', '<shell-context>one</shell-context>')
    router.attach('c1', '<shell-context>two</shell-context>')
    expect(router.queued('c1')).toBe(2)
    expect(attach.map((a) => a.queued)).toEqual([1, 2])

    const first = await fire('UserPromptSubmit')
    expect(first.additionalContext).toContain('one')
    expect(first.additionalContext).toContain('two')
    expect(router.queued('c1')).toBe(0)
    // The next turn starts empty again.
    expect(await fire('UserPromptSubmit')).toEqual({})
  })

  it('leads with what the user attached, then the shell activity', async () => {
    const { router, fire } = make('<shell-activity>since last time</shell-activity>')
    router.attach('c1', 'ATTACHED')
    const result = await fire('UserPromptSubmit')
    const text = result.additionalContext!
    expect(text.indexOf('ATTACHED')).toBeLessThan(text.indexOf('since last time'))
  })

  it('carries shell activity mid-turn too, but nothing attached', async () => {
    const { router, fire } = make('<shell-activity>a build broke</shell-activity>')
    router.attach('c1', 'ATTACHED')
    const result = await fire('PostToolUse')
    expect(result.additionalContext).toContain('a build broke')
    // Attached context belongs to a prompt, so it waits for one.
    expect(result.additionalContext).not.toContain('ATTACHED')
    expect(router.queued('c1')).toBe(1)
  })

  it('says what shells are there when a session starts', async () => {
    const { fire, statuses } = make()
    const result = await fire('SessionStart')
    expect(result.additionalContext).toContain('"shell", "server"')
    expect(statuses.at(-1)).toMatchObject({ state: 'idle', unseen: false })
  })

  it('forgets a session that ended, queue and all', async () => {
    const { router, fire } = make()
    router.attach('c1', 'ATTACHED')
    await fire('SessionEnd')
    expect(router.queued('c1')).toBe(0)
    expect(router.statusList()).toEqual([])
  })
})
