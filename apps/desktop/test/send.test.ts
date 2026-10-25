import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ContextSender } from '../src/main/context/send'
import { CommandTracker } from '../src/main/shell/command-tracker'
import { installShellIntegration, shellLaunch } from '../src/main/shell/integration'
import type { Tmux } from '../src/main/tmux/tmux'
import { makeTestTmux, waitFor } from './helpers'

describe('ContextSender (real bash + a fake Claude in tmux)', () => {
  let tmux: Tmux
  let dir: string
  let tracker: CommandTracker
  let sender: ContextSender
  let received: string
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
    tracker = new CommandTracker({ tmux, eventsDir, onChange: () => {} })
    sender = new ContextSender({ tmux, commands: tracker, homeDir: home, contextDir: join(dir, 'ctx') })

    // Stand-in for Claude Code: a non-shell program that turns on bracketed
    // paste and records what it is given.
    const fakeClaude = join(dir, 'fake-claude.py')
    writeFileSync(
      fakeClaude,
      [
        'import sys, os, tty',
        'sys.stdout.write("\\x1b[?2004h"); sys.stdout.flush()',
        'tty.setraw(0)',
        `out = open(${JSON.stringify(received)}, "ab", buffering=0)`,
        'while True:',
        '    b = os.read(0, 4096)',
        '    if not b: break',
        '    out.write(b)'
      ].join('\n')
    )
    await tmux.newSession({ id: claudeId, kind: 'claude', cwd: home, command: ['python3', fakeClaude], pairId: shellId })

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
    await tmux.newSession({ id: 'gone-claude', kind: 'claude', cwd: dir, command: ['bash', '--norc'], pairId: 'gone-shell' })
    await tmux.newSession({ id: 'gone-shell', kind: 'shell', cwd: dir, command: ['bash', '--norc'], pairId: 'gone-claude' })
    await expect(sender.sendLast('gone-shell', 'gone-claude')).rejects.toThrow(/Claude Code is not running/)
  })
})
