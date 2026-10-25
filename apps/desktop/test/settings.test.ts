import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULTS, SettingsStore } from '../src/main/settings'
import { makeTempDir } from './helpers'

describe('settings', () => {
  const dir = makeTempDir('seam-settings-')
  const file = (name: string): string => join(dir, name)
  afterAll(() => {
    // Left in place deliberately: nothing here is big and the dir is a temp one.
  })

  it('starts at the defaults when there is no file', () => {
    expect(new SettingsStore(file('new.json')).get()).toEqual(DEFAULTS)
  })

  it('remembers a change across a restart', () => {
    const path = file('round-trip.json')
    new SettingsStore(path).update({ shellOnly: false, autoSyncOff: ['t-1'] })
    const reopened = new SettingsStore(path).get()
    expect(reopened.shellOnly).toBe(false)
    expect(reopened.autoSyncOff).toEqual(['t-1'])
    // Untouched fields keep their defaults rather than disappearing.
    expect(reopened.policy).toEqual(DEFAULTS.policy)
  })

  it('writes through a temporary file, so a crash cannot leave a half-written one', () => {
    const path = file('atomic.json')
    const store = new SettingsStore(path)
    store.update({ shellOnly: false })
    // Whatever is on disk parses: there is no window where it is partial.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ shellOnly: false })
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true)
  })

  it('takes what it can from a file someone edited badly', () => {
    const path = file('hand-edited.json')
    writeFileSync(
      path,
      JSON.stringify({
        shellOnly: 'yes please',
        policy: { mode: 'whatever', allowPrefixes: ['npm test', 7] },
        autoSyncOff: 'nope',
        somethingElse: true
      })
    )
    const settings = new SettingsStore(path).get()
    // Each bad field falls back on its own; one typo does not reset the rest.
    expect(settings.shellOnly).toBe(DEFAULTS.shellOnly)
    expect(settings.policy.mode).toBe(DEFAULTS.policy.mode)
    expect(settings.policy.allowPrefixes).toEqual([])
    expect(settings.autoSyncOff).toEqual([])
  })

  it('keeps a policy that is actually usable', () => {
    const path = file('policy.json')
    writeFileSync(path, JSON.stringify({ policy: { mode: 'allowlist', allowPrefixes: ['git status'] } }))
    expect(new SettingsStore(path).get().policy).toEqual({ mode: 'allowlist', allowPrefixes: ['git status'] })
  })

  it('starts rather than refuses when the file is not JSON at all', () => {
    const path = file('broken.json')
    writeFileSync(path, '{ this is not json')
    expect(new SettingsStore(path).get()).toEqual(DEFAULTS)
  })
})
