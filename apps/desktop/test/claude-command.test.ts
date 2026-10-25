import { execFileSync } from 'node:child_process'
import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { claudeCommand, shellOnlyArgs } from '../src/main/terminals/claude-command'
import { makeTempDir } from './helpers'

/** Run the command once, swapping the final "exec login shell" for an exit so it returns. */
function runOnce(argv: string[], env: Record<string, string>): string {
  const [file, ...args] = argv
  const last = args.length - 1
  args[last] = args[last]!.replace(/exec "[^"]+" -l/, 'exit 0')
  return execFileSync(file!, args, { encoding: 'utf8', env: { HOME: process.env['HOME'] ?? '/', ...env } })
}

describe('claudeCommand', () => {
  const dir = makeTempDir('seam-claude-')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('runs claude with its arguments when it is on PATH', () => {
    const bin = join(dir, 'bin')
    execFileSync('mkdir', ['-p', bin])
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "claude ran: $*"\n')
    chmodSync(join(bin, 'claude'), 0o755)
    // Not a login shell here (-l would rebuild PATH from the profile).
    const argv = claudeCommand('/bin/sh', ['--resume', 'abc-123']).filter((a) => a !== '-l')
    expect(runOnce(argv, { PATH: `${bin}:/usr/bin:/bin` })).toContain('claude ran: --resume abc-123')
  })

  it('explains what is missing when claude is not installed', () => {
    const argv = claudeCommand('/bin/sh').filter((a) => a !== '-l')
    expect(runOnce(argv, { PATH: '/usr/bin:/bin' })).toContain('Claude Code (the claude command) is not on your PATH')
  })

  it('falls back to a login shell when Claude exits', () => {
    expect(claudeCommand('/bin/zsh').at(-1)).toMatch(/exec "\/bin\/zsh" -l' seam-claude$/)
  })

  it('takes Bash away, so the only way to run anything is the paired shell', () => {
    const args = shellOnlyArgs('shell')
    expect(args.slice(0, 2)).toEqual(['--disallowedTools', 'Bash'])
    expect(args[2]).toBe('--append-system-prompt')
    expect(args[3]).toContain('run_in_shell')
    expect(args[3]).toContain('shell named shell')

    // It is quoted into a /bin/sh -c, so none of these may appear in it.
    expect(args[3]).not.toMatch(/["'`$\\]/)
    // And the whole thing survives the argument check.
    const argv = claudeCommand('/bin/sh', ['--mcp-config', '/tmp/x.json', ...args])
    expect(argv.at(-1)).toContain('"--disallowedTools" "Bash"')
  })

  it('refuses shell paths and arguments that could break out of the quoting', () => {
    expect(() => claudeCommand("/bin/sh'; rm -rf ~")).toThrow()
    expect(() => claudeCommand('/bin/sh', ["x'; echo pwned"])).toThrow()
    expect(() => claudeCommand('/bin/sh', ['$(whoami)'])).toThrow()
  })
})
