import type { ITerminalOptions } from '@xterm/xterm'

export const terminalOptions: ITerminalOptions = {
  fontFamily: '"SF Mono", Menlo, "JetBrains Mono", monospace',
  fontSize: 13,
  lineHeight: 1.15,
  cursorBlink: true,
  // tmux keeps the history; xterm.js only needs the visible screen.
  scrollback: 0,
  macOptionIsMeta: true,
  allowProposedApi: false,
  theme: {
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
