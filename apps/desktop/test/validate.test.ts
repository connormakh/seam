import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { asCreateOptions, asId, asSize, cleanTitle } from '../src/main/validate'
import { makeTempDir } from './helpers'

describe('renderer input validation', () => {
  const dir = makeTempDir('seam-validate-')
  const file = join(dir, 'file.txt')
  writeFileSync(file, '')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('accepts tmux-safe ids only', () => {
    expect(asId('t-abc_123')).toBe('t-abc_123')
    for (const bad of ['', 'a:b', 'a.b', 'a b', 'x'.repeat(65), 7, null]) expect(() => asId(bad)).toThrow()
  })

  it('accepts finite sizes within bounds', () => {
    expect(asSize({ cols: 80.6, rows: 24 })).toEqual({ cols: 80, rows: 24 })
    for (const bad of [{ cols: NaN, rows: 1 }, { cols: Infinity, rows: 1 }, { cols: 0, rows: 1 }, { cols: 1, rows: 5000 }, null, {}]) {
      expect(() => asSize(bad)).toThrow()
    }
  })

  it('keeps titles on one line and bounded', () => {
    expect(cleanTitle('  a\nb\tc␟d  ')).toBe('a b c d')
    expect(cleanTitle('x'.repeat(500))).toHaveLength(200)
  })

  it('requires cwd to be an existing absolute directory', () => {
    expect(asCreateOptions({ cwd: dir }).cwd).toBe(dir)
    expect(() => asCreateOptions({ cwd: 'relative/path' })).toThrow(/absolute/)
    expect(() => asCreateOptions({ cwd: join(dir, 'missing') })).toThrow(/not a directory/)
    expect(() => asCreateOptions({ cwd: file })).toThrow(/not a directory/)
    expect(() => asCreateOptions({ cwd: 42 })).toThrow()
  })

  it('drops unknown kinds and empty titles', () => {
    expect(asCreateOptions({ kind: 'root', title: '\n\n' })).toEqual({})
  })
})
