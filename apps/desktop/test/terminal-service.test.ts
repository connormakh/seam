import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { spawn } from 'node-pty'
import type { TerminalExitEvent } from '@shared/ipc'
import { TerminalService } from '../src/main/terminals/terminal-service'
import type { Tmux } from '../src/main/tmux/tmux'
import { makeTestTmux, waitFor } from './helpers'

describe('TerminalService (real tmux + node-pty)', () => {
  let tmux: Tmux
  let dir: string
  let service: TerminalService
  const output = new Map<string, string>()
  const exits: TerminalExitEvent[] = []

  beforeAll(() => {
    ;({ tmux, dir } = makeTestTmux())
    service = new TerminalService({
      tmux,
      spawnPty: spawn,
      defaultCwd: dir,
      events: {
        data: (id, data) => output.set(id, (output.get(id) ?? '') + data),
        exit: (e) => exits.push(e)
      }
    })
  })

  afterAll(async () => {
    service.detachAll()
    await tmux.killServer()
    rmSync(dir, { recursive: true, force: true })
  })

  const seen = (id: string, text: string) => waitFor(async () => (output.get(id) ?? '').includes(text))

  it('creates a shell and streams what is typed into it', async () => {
    const t = await service.create({ title: 'tests' })
    expect(t).toMatchObject({ kind: 'shell', title: 'tests', attached: false })

    await service.attach(t.id, { cols: 100, rows: 30 })
    expect(service.isAttached(t.id)).toBe(true)

    service.write(t.id, 'echo "attach-$((6*7))"\r')
    await seen(t.id, 'attach-42')
  })

  it('keeps the terminal running after detaching, with its screen intact', async () => {
    const t = await service.create()
    await service.attach(t.id, { cols: 80, rows: 24 })
    service.write(t.id, 'echo before-detach\r')
    await seen(t.id, 'before-detach')

    service.detach(t.id)
    expect(service.isAttached(t.id)).toBe(false)
    const listed = (await service.list()).find((x) => x.id === t.id)
    expect(listed).toMatchObject({ attached: false })

    // A fresh attach redraws the screen from tmux.
    output.delete(t.id)
    await service.attach(t.id, { cols: 80, rows: 24 })
    await seen(t.id, 'before-detach')
    expect(exits.find((e) => e.id === t.id)).toBeUndefined()
  })

  it('treats a second attach as a resize, not a second client', async () => {
    const t = await service.create()
    await service.attach(t.id, { cols: 80, rows: 24 })
    await service.attach(t.id, { cols: 120, rows: 40 })
    // tmux applies the resize asynchronously; wait for it, then check there is one client.
    const clients = await waitFor(async () => {
      const out = await tmux.run(['list-clients', '-t', `=${t.id}`, '-F', '#{client_width}x#{client_height}'])
      return out.includes('120x40') ? out : null
    })
    expect(clients.trim().split('\n')).toEqual(['120x40'])
  })

  it('reports ended when the shell exits', async () => {
    const t = await service.create()
    await service.attach(t.id, { cols: 80, rows: 24 })
    service.write(t.id, 'exit\r')
    const e = await waitFor(async () => exits.find((x) => x.id === t.id))
    expect(e.ended).toBe(true)
    expect((await service.list()).some((x) => x.id === t.id)).toBe(false)
  })

  it('kills a terminal and reports it ended', async () => {
    const t = await service.create()
    await service.attach(t.id, { cols: 80, rows: 24 })
    await service.kill(t.id)
    const e = await waitFor(async () => exits.find((x) => x.id === t.id))
    expect(e.ended).toBe(true)
    expect(service.isAttached(t.id)).toBe(false)
  })

  it('refuses to attach to a terminal that is not running', async () => {
    await expect(service.attach('t-missing', { cols: 80, rows: 24 })).rejects.toThrow(/not running/)
  })
})
