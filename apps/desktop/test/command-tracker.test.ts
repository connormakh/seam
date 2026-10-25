import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CommandSummary } from '@shared/ipc'
import { CommandTracker } from '../src/main/shell/command-tracker'
import { installShellIntegration, shellLaunch } from '../src/main/shell/integration'
import type { Tmux } from '../src/main/tmux/tmux'
import { makeTestTmux, waitFor } from './helpers'

describe('CommandTracker (real bash in tmux)', () => {
  let tmux: Tmux
  let dir: string
  let tracker: CommandTracker
  const changes: CommandSummary[] = []
  const id = 'track-1'

  beforeAll(async () => {
    ;({ tmux, dir } = makeTestTmux())
    const home = join(dir, 'home')
    const eventsDir = join(dir, 'events')
    mkdirSync(home)
    mkdirSync(eventsDir)
    writeFileSync(join(home, '.bash_profile'), 'PS1="$ "\n')
    tracker = new CommandTracker({ tmux, eventsDir, onChange: (_id, s) => changes.push(s), maxOutputLines: 50 })
    tracker.start()
    const launch = shellLaunch({
      shell: execFileSync('which', ['bash'], { encoding: 'utf8' }).trim(),
      integrationDir: installShellIntegration(join(dir, 'integration')),
      eventsFile: tracker.eventsFile(id),
      tmuxBinary: tmux.opts.binary,
      homeDir: home
    })
    await tmux.newSession({ id, kind: 'shell', cwd: home, command: launch.command, env: { ...launch.env, HOME: home }, cols: 100, rows: 15 })
    await waitFor(async () => (await tmux.capturePane(id)).includes('$'))
  })

  afterAll(async () => {
    tracker.stop()
    await tmux.killServer()
    rmSync(dir, { recursive: true, force: true })
  })

  const runAndWait = async (cmd: string) => {
    const before = (await tracker.list(id)).length
    await tmux.sendKeys(id, cmd, { literal: true, enter: true })
    return waitFor(async () => {
      const all = await tracker.list(id)
      const last = all.at(-1)
      return all.length > before && last?.endedAt && last.output !== null ? last : null
    })
  }

  it('records a command with its output and exit code', async () => {
    const r = await runAndWait('printf "one\\ntwo\\nthree\\n"; exit_code_probe=1; (exit 4)')
    expect(r).toMatchObject({ exitCode: 4, output: 'one\ntwo\nthree', droppedLines: 0 })
    expect(r.command).toContain('printf')
  })

  it('keeps output that scrolled off the visible screen', async () => {
    // 15-row pane, 40 lines of output: most of it is only in tmux history.
    const r = await runAndWait('seq 1 40')
    expect(r.output?.split('\n')).toEqual(Array.from({ length: 40 }, (_, i) => String(i + 1)))
  })

  it('keeps only the tail of very long output', async () => {
    const r = await runAndWait('seq 1 120')
    const lines = r.output?.split('\n') ?? []
    expect(lines).toHaveLength(50)
    expect(lines[0]).toBe('71')
    expect(lines.at(-1)).toBe('120')
    expect(r.droppedLines).toBe(70)
  })

  it('reports started and finished commands to listeners', async () => {
    changes.length = 0
    await runAndWait('sleep 0.3; echo done')
    await waitFor(async () => changes.some((c) => !c.running && c.outputLines === 1))
    expect(changes[0]).toMatchObject({ running: true, command: 'sleep 0.3; echo done' })
    expect(changes.at(-1)).toMatchObject({ running: false, exitCode: 0, outputLines: 1 })
  })

  it('finds the last finished command, and forgets a terminal', async () => {
    const last = await tracker.lastFinished(id)
    expect(last?.output).toBe('done')
    tracker.forget(id)
    expect(existsSync(tracker.eventsFile(id))).toBe(false)
    expect(await tracker.list(id)).toEqual([])
  })
})
