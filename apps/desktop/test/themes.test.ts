import { describe, expect, it } from 'vitest'
import { DEFAULTS, SettingsStore } from '../src/main/settings'
import { applyTheme, DEFAULT_THEME, THEMES, THEME_NAMES } from '../src/renderer/src/terminal/themes'
import { makeTempDir } from './helpers'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HEX = /^#[0-9a-f]{6}$/i

describe('themes', () => {
  it('each one defines every colour the others do', () => {
    // A theme missing a key does not fail: it inherits whatever the last one
    // set, and looks almost right. This is the check that catches that.
    const uiKeys = Object.keys(THEMES[DEFAULT_THEME].ui).sort()
    const termKeys = Object.keys(THEMES[DEFAULT_THEME].terminal).sort()
    for (const name of THEME_NAMES) {
      expect(Object.keys(THEMES[name].ui).sort(), `${name} chrome`).toEqual(uiKeys)
      expect(Object.keys(THEMES[name].terminal).sort(), `${name} terminal`).toEqual(termKeys)
    }
  })

  it('uses colours a browser and xterm both understand', () => {
    for (const name of THEME_NAMES) {
      for (const [key, value] of Object.entries(THEMES[name].ui)) {
        expect(value, `${name}.${key}`).toMatch(HEX)
      }
      for (const [key, value] of Object.entries(THEMES[name].terminal)) {
        expect(String(value), `${name}.terminal.${key}`).toMatch(HEX)
      }
    }
  })

  it('keeps the chrome and the terminal on the same background', () => {
    // A light sidebar around a dark pane is the failure this prevents.
    for (const name of THEME_NAMES) {
      expect(THEMES[name].terminal.background, name).toBe(THEMES[name].ui.bg)
    }
  })

  it('paints the root, and falls back rather than leaving it half painted', () => {
    const root = { style: new Map<string, string>() } as unknown as HTMLElement
    ;(root.style as unknown as { setProperty(k: string, v: string): void }).setProperty = (k, v) =>
      void (root.style as unknown as Map<string, string>).set(k, v)

    applyTheme('light', root)
    const set = root.style as unknown as Map<string, string>
    expect(set.get('--bg')).toBe(THEMES.light.ui.bg)
    expect(set.get('color-scheme')).toBe('light')

    applyTheme('not-a-theme' as never, root)
    expect(set.get('--bg')).toBe(THEMES[DEFAULT_THEME].ui.bg)
  })

  it('remembers the choice, and ignores one that is not a theme', () => {
    const dir = makeTempDir('seam-theme-')
    const path = join(dir, 'settings.json')
    new SettingsStore(path).update({ theme: 'ember' })
    expect(new SettingsStore(path).get().theme).toBe('ember')

    writeFileSync(path, JSON.stringify({ theme: 'chartreuse' }))
    expect(new SettingsStore(path).get().theme).toBe(DEFAULTS.theme)
  })
})
