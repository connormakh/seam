import { describe, expect, it } from 'vitest'
import { resolveTmuxBinary } from '../src/main/tmux/binary'

describe('resolveTmuxBinary', () => {
  const only = (...files: string[]) => (f: string) => files.includes(f)

  it('prefers an explicit override', () => {
    const found = resolveTmuxBinary({
      override: '/custom/tmux',
      isExecutable: only('/custom/tmux', '/opt/homebrew/bin/tmux')
    })
    expect(found).toBe('/custom/tmux')
  })

  it('prefers the bundled binary over system installs', () => {
    const found = resolveTmuxBinary({
      bundledDir: '/App/Resources/bin',
      isExecutable: only('/App/Resources/bin/tmux', '/opt/homebrew/bin/tmux')
    })
    expect(found).toBe('/App/Resources/bin/tmux')
  })

  it('finds Homebrew tmux even when PATH is minimal', () => {
    const found = resolveTmuxBinary({ path: '/usr/bin:/bin', isExecutable: only('/opt/homebrew/bin/tmux') })
    expect(found).toBe('/opt/homebrew/bin/tmux')
  })

  it('falls back to PATH', () => {
    const found = resolveTmuxBinary({ path: '/a:/b', isExecutable: only('/b/tmux') })
    expect(found).toBe('/b/tmux')
  })

  it('returns null when tmux is missing', () => {
    expect(resolveTmuxBinary({ path: '/a', isExecutable: () => false })).toBeNull()
  })
})
