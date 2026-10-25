import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ContextSender } from '../src/main/context/send'
import { claudeCommand } from '../src/main/terminals/claude-command'
import { CommandTracker } from '../src/main/shell/command-tracker'
import { installShellIntegration, shellLaunch } from '../src/main/shell/integration'
import type { Tmux } from '../src/main/tmux/tmux'
import { makeTestTmux, waitFor } from './helpers'

/** What send.ts treats as a bare prompt rather than Claude Code. */
const SHELL_COMMANDS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'login'])

/**
 * The Claude side exactly as the app starts it, with `bin` as the only place
 * a `claude` could come from. /bin/sh and not a login shell, because -l would
 * rebuild PATH from the profile; `env` and not the session environment,
 * because tmux hands the pane the server's PATH whatever it is told.
 */
const withPath = (bin: string): string[] => [
  '/usr/bin/env',
  `PATH=${bin}:/usr/bin:/bin`,
  ...claudeCommand('/bin/sh').filter((a) => a !== '-l')
]

describe('ContextSender (real bash + a fake Claude in tmux)', () => {
  let tmux: Tmux
  let dir: string
  let tracker: CommandTracker
  let sender: ContextSender
  let received: string
  let ready: string
  let bin: string
  const shellId = 'pair-shell'
  const claudeId = 'pair-claude'

  beforeAll(async () => {
    ;({ tmux, dir } = makeTestTmux())
    const home = join(dir, 'home')
    const eventsDir = join(dir, 'events')
    mkdirSync(home)
    mkdirSync(eventsDir)
    writeFileSync(join(home, '.bash_profile'), 'PS1="$ "\n')
    received = join(dir, 'claude-received.txt')
    ready = join(dir, 'claude-ready')
    tracker = new CommandTracker({ tmux, eventsDir, onChange: () => {} })
    sender = new ContextSender({ tmux, commands: tracker, homeDir: home, contextDir: join(dir, 'ctx') })

    // Stand-in for Claude Code: a non-shell program that turns on bracketed
    // paste and records what it is given. It is named `claude` on a PATH of
    // its own, because the pair starts it through claudeCommand, the way the
    // app does, and that is what decides the pane's foreground command.
    bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'claude'),
      [
        '#!/usr/bin/env python3',
        'import sys, os, tty',
        'sys.stdout.write("\\x1b[?2004h"); sys.stdout.flush()',
        'tty.setraw(0)',
        `out = open(${JSON.stringify(received)}, "ab", buffering=0)`,
        // Only now is a paste safe: tty.setraw flushes whatever has not been
        // read yet, so anything sent before this line is thrown away.
        `open(${JSON.stringify(ready)}, "w").close()`,
        'while True:',
        '    b = os.read(0, 4096)',
        '    if not b: break',
        '    out.write(b)'
      ].join('\n'),
      { mode: 0o755 }
    )
    await tmux.newSession({ id: claudeId, kind: 'claude', cwd: home, command: withPath(bin), pairId: shellId })
    await waitFor(async () => existsSync(ready))

    const launch = shellLaunch({
      shell: execFileSync('which', ['bash'], { encoding: 'utf8' }).trim(),
      integrationDir: installShellIntegration(join(dir, 'integration')),
      eventsFile: tracker.eventsFile(shellId),
      tmuxBinary: tmux.opts.binary,
      homeDir: home
    })
    await tmux.newSession({ id: shellId, kind: 'shell', cwd: home, command: launch.command, env: { ...launch.env, HOME: home }, pairId: claudeId })
    await waitFor(async () => (await tmux.capturePane(shellId)).includes('$'))
  })

  afterAll(async () => {
    await tmux.killServer()
    rmSync(dir, { recursive: true, force: true })
  })

  const runInShell = async (cmd: string, n: number) => {
    await tmux.sendKeys(shellId, cmd, { literal: true, enter: true })
    await waitFor(async () => (await tracker.list(shellId)).filter((r) => r.endedAt && r.output !== null).length >= n)
  }

  it('leaves Claude, not the shell that starts it, as the pane foreground command', async () => {
    // claudeCommand runs claude from /bin/sh. Without job control that shell
    // leads the foreground process group, tmux reports it as the pane's
    // command, and send.ts refuses every paste as "Claude Code is not running".
    const claude = (await tmux.listSessions()).find((x) => x.id === claudeId)
    expect(SHELL_COMMANDS.has(claude?.currentCommand ?? '')).toBe(false)
  })

  it('refuses when the shell has not finished a command yet', async () => {
    await expect(sender.sendLast(shellId, claudeId)).rejects.toThrow(/no command has finished/)
  })

  it('pastes the last command and its output into Claude as one bracketed paste', async () => {
    // `cat` on a missing file exits 1 on both BSD and GNU; `ls` differs (1 vs 2).
    await runInShell('echo "TOKEN=supersecretvalue"; cat /definitely-missing', 1)
    const result = await sender.sendLast(shellId, claudeId)
    // Once in the command line, once in its output.
    expect(result).toMatchObject({ exitCode: 1, truncated: false, masked: 2 })

    const got = await waitFor(async () => {
      const t = existsSync(received) ? readFileSync(received, 'utf8') : ''
      return t.includes('\x1b[201~') ? t : null
    })
    expect(got.startsWith('\x1b[200~<shell-context shell="shell" cwd="~" exit="1"')).toBe(true)
    expect(got).toContain('$ echo "TOKEN=[masked]"; cat /definitely-missing')
    expect(got).toContain('TOKEN=[masked]\r')
    expect(got).toContain('No such file or directory')
    expect(got).not.toContain('supersecretvalue')
    // Nothing was submitted: no Enter outside the paste.
    expect(got.endsWith('</shell-context>\r\x1b[201~')).toBe(true)
  })

  it('saves the full output to a file when only the tail is pasted', async () => {
    await runInShell('seq 1 500', 2)
    const result = await sender.sendLast(shellId, claudeId)
    expect(result).toMatchObject({ lines: 200, truncated: true })
    const got = await waitFor(async () => {
      const t = readFileSync(received, 'utf8')
      return t.includes('full output:') ? t : null
    })
    const path = /full output: (\S+)\]/.exec(got)?.[1]
    expect(path && readFileSync(path, 'utf8').split('\n')).toContain('1')
  })

  it('refuses terminals that are not a pair', async () => {
    await expect(sender.sendLast(claudeId, shellId)).rejects.toThrow(/not a Claude \+ shell pair/)
  })

  it('refuses to paste once Claude has exited to a shell prompt', async () => {
    // Same launch as the pair above, but with nothing named claude on PATH:
    // the pane says so and falls back to a shell, which must not be pasted into.
    const empty = join(dir, 'empty-bin')
    mkdirSync(empty, { recursive: true })
    await tmux.newSession({ id: 'gone-claude', kind: 'claude', cwd: dir, command: withPath(empty), pairId: 'gone-shell' })
    await tmux.newSession({ id: 'gone-shell', kind: 'shell', cwd: dir, command: ['bash', '--norc'], pairId: 'gone-claude' })
    await waitFor(async () => (await tmux.capturePane('gone-claude')).includes('is not on your PATH'))
    await waitFor(async () => SHELL_COMMANDS.has((await tmux.listSessions()).find((x) => x.id === 'gone-claude')?.currentCommand ?? ''))
    await expect(sender.sendLast('gone-shell', 'gone-claude')).rejects.toThrow(/Claude Code is not running/)
  })
})
