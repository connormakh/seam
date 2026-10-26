import { writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkClaude, compareVersions, MINIMUM, parseVersion } from '../src/main/terminals/claude-check'
import { makeTempDir } from './helpers'

/** A login shell whose PATH holds only what the test puts there. */
function shellWith(dir: string, claude: string | null): string {
  const bin = join(dir, 'bin')
  writeFileSync(join(dir, 'profile'), `PATH=${bin}:/usr/bin:/bin\n`)
  if (claude !== null) {
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\n${claude}\n`)
    chmodSync(join(bin, 'claude'), 0o755)
  }
  const shell = join(dir, 'login-shell')
  // Stands in for a login shell: -l makes it read the profile above.
  writeFileSync(shell, `#!/bin/sh\n. ${join(dir, 'profile')}\nexec /bin/sh "$@"\n`)
  chmodSync(shell, 0o755)
  return shell
}

describe('checking Claude Code at startup', () => {
  it('compares versions by their numbers, not their text', () => {
    expect(compareVersions('2.1.310', '2.0.0')).toBe(1)
    expect(compareVersions('1.9.99', '2.0.0')).toBe(-1)
    expect(compareVersions('2.0', '2.0.0')).toBe(0)
    // 10 is after 9, which string comparison gets wrong.
    expect(compareVersions('2.10.0', '2.9.0')).toBe(1)
  })

  it('finds the version in whatever else the line says', () => {
    expect(parseVersion('2.1.310 (Claude Code)')).toBe('2.1.310')
    expect(parseVersion('claude version 3.0')).toBe('3.0')
    expect(parseVersion('no numbers here')).toBeNull()
  })

  it('says so when there is no claude on the PATH', async () => {
    const dir = makeTempDir('seam-claude-none-')
    writeFileSync(join(dir, 'x'), '')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'bin'))
    const result = await checkClaude(shellWith(dir, null))
    expect(result).toMatchObject({ found: false, ok: false })
    expect(result.problem).toContain('not on your PATH')
  })

  it('accepts one that is new enough', async () => {
    const { mkdirSync } = await import('node:fs')
    const dir = makeTempDir('seam-claude-ok-')
    mkdirSync(join(dir, 'bin'))
    const result = await checkClaude(shellWith(dir, 'echo "2.1.310 (Claude Code)"'))
    expect(result).toMatchObject({ found: true, version: '2.1.310', ok: true, problem: null })
  })

  it('refuses one that is too old, and says what to do', async () => {
    const { mkdirSync } = await import('node:fs')
    const dir = makeTempDir('seam-claude-old-')
    mkdirSync(join(dir, 'bin'))
    const result = await checkClaude(shellWith(dir, 'echo "1.0.42 (Claude Code)"'))
    expect(result).toMatchObject({ found: true, version: '1.0.42', ok: false })
    expect(result.problem).toContain(MINIMUM)
  })

  it('lets through a version string it cannot read, rather than refusing over it', async () => {
    const { mkdirSync } = await import('node:fs')
    const dir = makeTempDir('seam-claude-odd-')
    mkdirSync(join(dir, 'bin'))
    const result = await checkClaude(shellWith(dir, 'echo "claude, the newest one"'))
    expect(result).toMatchObject({ found: true, version: null, ok: true })
  })

  it('does not hang when claude never answers', async () => {
    const { mkdirSync } = await import('node:fs')
    const dir = makeTempDir('seam-claude-hang-')
    mkdirSync(join(dir, 'bin'))
    const started = Date.now()
    const result = await checkClaude(shellWith(dir, 'sleep 30'), 700)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result.ok).toBe(false)
  })
})
