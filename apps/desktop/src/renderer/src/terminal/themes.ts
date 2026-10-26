import type { ITheme } from '@xterm/xterm'
import type { ThemeName } from '@shared/ipc'

/**
 * Every colour in Seam, in one table.
 *
 * A theme has two halves that have to agree: the chrome, as CSS variables,
 * and the terminal, as an xterm palette. They are declared together so a
 * theme cannot end up with a light sidebar around a dark pane, and the test
 * checks that each one defines every key, so a half-finished theme cannot
 * ship looking almost right.
 */

export interface Theme {
  name: string
  /** What the OS should assume, for scrollbars and form controls. */
  scheme: 'dark' | 'light'
  /** CSS custom properties, without the leading dashes. */
  ui: {
    bg: string
    'bg-raised': string
    'bg-hover': string
    border: string
    text: string
    'text-muted': string
    accent: string
    danger: string
  }
  terminal: ITheme
}

const dark: Theme = {
  name: 'Dark',
  scheme: 'dark',
  ui: {
    bg: '#16181d',
    'bg-raised': '#1d2027',
    'bg-hover': '#252933',
    border: '#2b2f38',
    text: '#e6e8ee',
    'text-muted': '#8a909c',
    accent: '#6aa2ff',
    danger: '#ef6b73'
  },
  terminal: {
    background: '#16181d',
    foreground: '#e6e8ee',
    cursor: '#6aa2ff',
    cursorAccent: '#16181d',
    selectionBackground: '#3a4a6b',
    black: '#1d2027',
    red: '#ef6b73',
    green: '#7fd18b',
    yellow: '#e8c56a',
    blue: '#6aa2ff',
    magenta: '#c49cff',
    cyan: '#5ec4d6',
    white: '#c9ced8',
    brightBlack: '#5c6370',
    brightRed: '#ff8a91',
    brightGreen: '#9be3a5',
    brightYellow: '#f5d78a',
    brightBlue: '#8fb9ff',
    brightMagenta: '#d7b8ff',
    brightCyan: '#86dbe8',
    brightWhite: '#f3f5f9'
  }
}

/** Near-black and cooler, for a dim room or an OLED screen. */
const midnight: Theme = {
  name: 'Midnight',
  scheme: 'dark',
  ui: {
    bg: '#0b0d12',
    'bg-raised': '#12151c',
    'bg-hover': '#1b1f29',
    border: '#222733',
    text: '#dfe4ee',
    'text-muted': '#79818f',
    accent: '#7aa7ff',
    danger: '#f4727a'
  },
  terminal: {
    background: '#0b0d12',
    foreground: '#dfe4ee',
    cursor: '#7aa7ff',
    cursorAccent: '#0b0d12',
    selectionBackground: '#2c3a57',
    black: '#12151c',
    red: '#f4727a',
    green: '#79d08c',
    yellow: '#e6c26a',
    blue: '#7aa7ff',
    magenta: '#bb9bff',
    cyan: '#5bc3d8',
    white: '#c3c9d4',
    brightBlack: '#515867',
    brightRed: '#ff9097',
    brightGreen: '#97e2a6',
    brightYellow: '#f3d68c',
    brightBlue: '#9cbcff',
    brightMagenta: '#d3b7ff',
    brightCyan: '#84daea',
    brightWhite: '#eef1f7'
  }
}

/** Warm and low contrast, in the Solarized tradition. */
const ember: Theme = {
  name: 'Ember',
  scheme: 'dark',
  ui: {
    bg: '#1c1917',
    'bg-raised': '#242020',
    'bg-hover': '#2e2928',
    border: '#38322f',
    text: '#ece3d8',
    'text-muted': '#9a8d82',
    accent: '#e0a458',
    danger: '#e06c62'
  },
  terminal: {
    background: '#1c1917',
    foreground: '#ece3d8',
    cursor: '#e0a458',
    cursorAccent: '#1c1917',
    selectionBackground: '#4a3f33',
    black: '#242020',
    red: '#e06c62',
    green: '#a7b86a',
    yellow: '#e0a458',
    magenta: '#c98fb0',
    blue: '#7ba6c4',
    cyan: '#7fbfae',
    white: '#cfc4b6',
    brightBlack: '#6b5f57',
    brightRed: '#f08d84',
    brightGreen: '#c0cf8a',
    brightYellow: '#f0c17e',
    brightBlue: '#9cc0d9',
    brightMagenta: '#dcabc6',
    brightCyan: '#9fd4c6',
    brightWhite: '#f7f1e8'
  }
}

/** Daylight. The one people ask for and the one most apps get wrong. */
const light: Theme = {
  name: 'Light',
  scheme: 'light',
  ui: {
    bg: '#ffffff',
    'bg-raised': '#f5f6f8',
    'bg-hover': '#e8eaee',
    border: '#d8dbe1',
    text: '#1c2026',
    'text-muted': '#6a7280',
    accent: '#2563c9',
    danger: '#c0392f'
  },
  terminal: {
    background: '#ffffff',
    foreground: '#1c2026',
    cursor: '#2563c9',
    cursorAccent: '#ffffff',
    selectionBackground: '#cfe0fa',
    black: '#1c2026',
    red: '#c0392f',
    green: '#2f7d4a',
    yellow: '#95701a',
    blue: '#2563c9',
    magenta: '#8a3fbf',
    cyan: '#1f7b8c',
    white: '#d8dbe1',
    brightBlack: '#6a7280',
    brightRed: '#d9544a',
    brightGreen: '#3f9960',
    brightYellow: '#b08a28',
    brightBlue: '#4680de',
    brightMagenta: '#a258d4',
    brightCyan: '#2f93a6',
    brightWhite: '#ffffff'
  }
}

export const THEMES: Record<ThemeName, Theme> = { dark, midnight, ember, light }

export const THEME_NAMES = Object.keys(THEMES) as ThemeName[]

export const DEFAULT_THEME: ThemeName = 'dark'

/** Paint the chrome. The terminals follow through their own options. */
export function applyTheme(name: ThemeName, root: HTMLElement): void {
  const theme = THEMES[name] ?? THEMES[DEFAULT_THEME]
  for (const [key, value] of Object.entries(theme.ui)) root.style.setProperty(`--${key}`, value)
  root.style.setProperty('color-scheme', theme.scheme)
}
