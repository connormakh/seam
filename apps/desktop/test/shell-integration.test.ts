import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installShellIntegration, shellLaunch } from '../src/main/shell/integration'
import type { Tmux } from '../src/main/tmux/tmux'
import { hasShell, makeTestTmux, reportsTime, shellPath, waitFor } from './helpers'

interface Event {
  type: 'S' | 'E'
  line: number
  rest: string[]
}

function readEvents(file: string): Event[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [type, line, ...rest] = l.split('\t')
      return { type: type as 'S' | 'E', line: Number(line), rest }
    })
}

/** Output lines for a command, from tmux history, given absolute start/end lines. */
async function outputBetween(tmux: Tmux, id: string, start: number, end: number): Promise<string> {
  const history = Number((await tmux.run(['display-message', '-p', '-t', `=${id}:`, '#{history_size}'])).trim())
  if (end <= start) return ''
  const text = await tmux.capturePane(id, { start: start - history, end: end - 1 - history })
  return text.replace(/\n$/, '')
}

for (const shell of ['zsh', 'bash'] as const) {
  describe.skipIf(!hasShell(shell))(`${shell} integration`, () => {
    let tmux: Tmux
    let dir: string
    let home: string
    let events: string
    const id = `int-${shell}`

    beforeAll(async () => {
      ;({ tmux, dir } = makeTestTmux())
      home = join(dir, 'home')
      mkdirSync(home)
      // The user's own startup files must still run.
      writeFileSync(join(home, '.zshrc'), 'export USER_RC=zshrc-loaded\nPROMPT="$ "\n')
      writeFileSync(join(home, '.bash_profile'), 'export USER_RC=bash-profile-loaded\nPS1="$ "\n')
      const integrationDir = installShellIntegration(join(dir, 'integration'))
      events = join(dir, `${shell}.events`)
      const launch = shellLaunch({
        shell: shellPath(shell),
        integrationDir,
        eventsFile: events,
        tmuxBinary: tmux.opts.binary,
        homeDir: home
      })
      expect(launch.integrated).toBe(true)
      await tmux.newSession({
        id,
        kind: 'shell',
        cwd: home,
        command: launch.command,
        env: { ...launch.env, HOME: home, ZDOTDIR: launch.env['ZDOTDIR'] ?? '' },
        cols: 100,
        rows: 20
      })
      await waitFor(async () => (await tmux.capturePane(id)).includes('$'))
    })

    afterAll(async () => {
      await tmux.killServer()
      rmSync(dir, { recursive: true, force: true })
    })

    const run = async (cmd: string, count: number): Promise<Event[]> => {
      await tmux.sendKeys(id, cmd, { literal: true, enter: true })
      return waitFor(async () => {
        const all = readEvents(events)
        return all.filter((e) => e.type === 'E').length >= count ? all : null
      })
    }

    it('still loads the user startup file', async () => {
      await tmux.sendKeys(id, 'echo "rc=$USER_RC"', { literal: true, enter: true })
      await waitFor(async () => /rc=(zshrc|bash-profile)-loaded/.test(await tmux.capturePane(id)))
    })

    it('reports start and end with cwd, command and exit code', async () => {
      const all = await run('echo first; echo second', 2)
      const start = all.filter((e) => e.type === 'S').at(-1)!
      const end = all.filter((e) => e.type === 'E').at(-1)!
      expect(start.rest.slice(1)).toEqual([home, 'echo first; echo second'])
      expect(end.rest[1]).toBe('0')
      if (reportsTime(shell)) {
        // Unix seconds with a fraction, end at or after start.
        const [t0, t1] = [Number(start.rest[0]), Number(end.rest[0])]
        expect(t0).toBeGreaterThan(1_600_000_000)
        expect(t1).toBeGreaterThanOrEqual(t0)
      } else {
        expect([start.rest[0], end.rest[0]]).toEqual(['', ''])
      }
      expect(await outputBetween(tmux, id, start.line, end.line)).toBe('first\nsecond')
    })

    it('reports a failing exit code', async () => {
      const all = await run('(exit 3)', 3)
      expect(all.at(-1)?.type).toBe('E')
      expect(all.at(-1)?.rest[1]).toBe('3')
      // A line that is only a subshell is still reported, with its command:
      // bash before 4.4 reaches it from the prompt, not from the DEBUG trap.
      expect(all.filter((e) => e.type === 'S').at(-1)?.rest[2]).toBe('(exit 3)')
    })

    it('reports a command with no output as an empty range', async () => {
      const all = await run('true', 4)
      const start = all.filter((e) => e.type === 'S').at(-1)!
      const end = all.at(-1)!
      expect(await outputBetween(tmux, id, start.line, end.line)).toBe('')
    })

    it('escapes tabs, newlines and backslashes in the command line', async () => {
      const all = await run("printf 'a\\tb\\\\c\\n'", 5)
      const start = all.filter((e) => e.type === 'S').at(-1)!
      expect(start.rest[2]).toBe("printf 'a\\\\tb\\\\\\\\c\\\\n'")
    })

    it('does not report the prompt itself as a command', () => {
      const all = readEvents(events)
      const starts = all.filter((e) => e.type === 'S').length
      const ends = all.filter((e) => e.type === 'E').length
      // "echo rc", then the four commands above: one start and one end each.
      expect(starts).toBe(5)
      expect(ends).toBe(5)
    })
  })
}
