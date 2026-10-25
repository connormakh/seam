import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Tmux } from '../src/main/tmux/tmux'
import { makeTestTmux, waitFor } from './helpers'

describe('Tmux (real server)', () => {
  let tmux: Tmux
  let dir: string

  beforeAll(() => {
    ;({ tmux, dir } = makeTestTmux())
  })

  afterAll(async () => {
    await tmux.killServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists nothing before the server exists', async () => {
    expect(await tmux.listSessions()).toEqual([])
  })

  it('creates a tagged session and lists it', async () => {
    await tmux.newSession({ id: 'shell-a', kind: 'shell', cwd: dir, command: ['sh'], title: 'tests' })
    expect(await tmux.hasSession('shell-a')).toBe(true)

    const [s] = await tmux.listSessions()
    expect(s).toMatchObject({ id: 'shell-a', kind: 'shell', title: 'tests', attachedClients: 0, dead: false })
    expect(s?.panePid).toBeGreaterThan(0)
  })

  it('ignores sessions Seam did not create', async () => {
    await tmux.run(['new-session', '-d', '-s', 'foreign', 'sh'])
    const ids = (await tmux.listSessions()).map((s) => s.id)
    expect(ids).toContain('shell-a')
    expect(ids).not.toContain('foreign')
    await tmux.killSession('foreign')
  })

  it('types into a pane and captures the output', async () => {
    await tmux.sendKeys('shell-a', 'echo seam-$((40+2))', { literal: true, enter: true })
    const screen = await waitFor(async () => {
      const text = await tmux.capturePane('shell-a')
      return text.includes('seam-42') ? text : null
    })
    expect(screen).toContain('seam-42')
  })

  it('passes environment variables to the session', async () => {
    await tmux.newSession({ id: 'env-test', kind: 'claude', cwd: dir, command: ['sh'], env: { SEAM_PROBE: 'hello-env' } })
    await tmux.sendKeys('env-test', 'echo "probe=$SEAM_PROBE"', { literal: true, enter: true })
    await waitFor(async () => (await tmux.capturePane('env-test')).includes('probe=hello-env'))
    await tmux.killSession('env-test')
  })

  it('treats # in a start directory literally instead of as a tmux format', async () => {
    const odd = join(dir, 'C#S')
    mkdirSync(odd)
    // Expanded, this would run a command and the cwd would not match the literal path.
    const evil = join(dir, '#(echo pwned)')
    mkdirSync(evil)

    await tmux.newSession({ id: 'hash-a', kind: 'shell', cwd: odd, command: ['sh'] })
    await tmux.newSession({ id: 'hash-b', kind: 'shell', cwd: evil, command: ['sh'] })
    const byId = new Map((await tmux.listSessions()).map((s) => [s.id, s]))
    expect(byId.get('hash-a')?.cwd).toBe(odd)
    expect(byId.get('hash-b')?.cwd).toBe(evil)
    await tmux.killSession('hash-a')
    await tmux.killSession('hash-b')
  })

  it('keeps a listing intact when a title contains a newline', async () => {
    await tmux.newSession({ id: 'nl', kind: 'shell', cwd: dir, command: ['sh'], title: 'a\nb' })
    const s = (await tmux.listSessions()).find((x) => x.id === 'nl')
    expect(s?.title).toBe('a b')
    expect(s?.cwd).toBe(dir)
    await tmux.killSession('nl')
  })

  it('updates the title', async () => {
    await tmux.setTitle('shell-a', 'renamed')
    const [s] = await tmux.listSessions()
    expect(s?.title).toBe('renamed')
  })

  it('kills sessions, and killing twice is harmless', async () => {
    await tmux.killSession('shell-a')
    await tmux.killSession('shell-a')
    expect(await tmux.hasSession('shell-a')).toBe(false)
  })

  it('rejects ids tmux would misparse', async () => {
    await expect(tmux.killSession('a:b')).rejects.toThrow(/invalid terminal id/)
    expect(() => tmux.attachCommand('x.y')).toThrow(/invalid terminal id/)
  })

  it('builds an attach command on the private socket', () => {
    const { args } = tmux.attachCommand('abc')
    expect(args).toEqual(['-u', '-L', tmux.opts.socketName, '-f', tmux.opts.configPath, 'attach-session', '-t', '=abc'])
  })
})

describe('Tmux ordering', () => {
  it('lists sessions in creation order even within the same second', async () => {
    const { tmux, dir } = makeTestTmux()
    try {
      const ids = ['o-1', 'o-2', 'o-3', 'o-4', 'o-5']
      for (const id of ids) await tmux.newSession({ id, kind: 'shell', cwd: dir, command: ['sh'] })
      expect((await tmux.listSessions()).map((s) => s.id)).toEqual(ids)
    } finally {
      await tmux.killServer()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
