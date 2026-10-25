import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ensureSpawnHelpersExecutable } from '../src/main/terminals/spawn-helper'
import { makeTempDir } from './helpers'

const isExecutable = (f: string): boolean => {
  try {
    accessSync(f, constants.X_OK)
    return true
  } catch {
    return false
  }
}

describe('ensureSpawnHelpersExecutable', () => {
  const dir = makeTempDir('seam-pty-')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('sets the executable bit on prebuilt helpers that lack it', () => {
    for (const arch of ['darwin-arm64', 'darwin-x64']) {
      mkdirSync(join(dir, 'prebuilds', arch), { recursive: true })
      writeFileSync(join(dir, 'prebuilds', arch, 'spawn-helper'), '', { mode: 0o644 })
    }
    const fixed = ensureSpawnHelpersExecutable(dir)
    expect(fixed).toHaveLength(2)
    expect(isExecutable(join(dir, 'prebuilds', 'darwin-arm64', 'spawn-helper'))).toBe(true)
  })

  it('leaves helpers that are already executable alone', () => {
    expect(ensureSpawnHelpersExecutable(dir)).toEqual([])
  })

  it('ignores a node-pty install without helpers', () => {
    const empty = makeTempDir('seam-pty-empty-')
    expect(ensureSpawnHelpersExecutable(empty)).toEqual([])
    rmSync(empty, { recursive: true, force: true })
  })
})
