import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CommandSummary } from '@shared/ipc'
import { CommandTracker } from '../src/main/shell/command-tracker'
import { installShellIntegration, shellLaunch } from '../src/main/shell/integration'
import type { Tmux } from '../src/main/tmux/tmux'
import { hasShell, makeTestTmux, reportsTime, shellPath, waitFor } from './helpers'

// Both shells, because on macOS only one of them reports its own clock.
for (const shell of ['zsh', 'bash'] as const) {
  describe.skipIf(!hasShell(shell))(`CommandTracker (real ${shell} in tmux)`, () => {
    let tmux: Tmux
    let dir: string
    let tracker: CommandTracker
    const changes: CommandSummary[] = []
    const id = `track-${shell}`

    beforeAll(async () => {
      ;({ tmux, dir } = makeTestTmux())
      const home = join(dir, 'home')
      const eventsDir = join(dir, 'events')
      mkdirSync(home)
      mkdirSync(eventsDir)
      writeFileSync(join(home, '.bash_profile'), 'PS1="$ "\n')
      writeFileSync(join(home, '.zshrc'), 'PROMPT="$ "\n')
      tracker = new CommandTracker({ tmux, eventsDir, onChange: (_id, s) => changes.push(s), maxOutputLines: 50 })
      tracker.start()
      const launch = shellLaunch({
        shell: shellPath(shell),
        integrationDir: installShellIntegration(join(dir, 'integration')),
        eventsFile: tracker.eventsFile(id),
        tmuxBinary: tmux.opts.binary,
        homeDir: home
      })
      const env = { ...launch.env, HOME: home, ZDOTDIR: launch.env['ZDOTDIR'] ?? '' }
      await tmux.newSession({ id, kind: 'shell', cwd: home, command: launch.command, env, cols: 100, rows: 15 })
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

    it('times commands with the shell-reported clock', async () => {
      const r = await runAndWait('sleep 0.4')
      expect(r.endedAt! - r.startedAt).toBeGreaterThanOrEqual(380)
      expect(r.endedAt! - r.startedAt).toBeLessThan(3000)
    })

    it('rebuilds records from the events file after a restart', async () => {
      const fresh = new CommandTracker({ tmux, eventsDir: join(dir, 'events'), onChange: () => {}, maxOutputLines: 50 })
      const original = await tracker.list(id)
      const rebuilt = await fresh.list(id)
      expect(rebuilt.map((r) => [r.command, r.exitCode])).toEqual(original.map((r) => [r.command, r.exitCode]))
      expect(rebuilt.at(-1)?.output).toBe(original.at(-1)?.output)
      if (reportsTime(shell)) {
        // The timings are the shell's own, so a rebuild reproduces them. Read
        // from arrival time instead, they would all be the time of the rebuild.
        expect(rebuilt.map((r) => [r.startedAt, r.endedAt])).toEqual(original.map((r) => [r.startedAt, r.endedAt]))
      }
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
}
