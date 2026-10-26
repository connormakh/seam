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
  // Selecting is xterm's job, not tmux's. Option+drag selects even when the
  // program in the pane is reading the mouse itself, and right-clicking
  // takes the word under the pointer rather than doing nothing.
  macOptionClickForcesSelection: true,
  rightClickSelectsWord: true,
  // The palette comes from the active theme, applied when the view mounts
  // and again whenever it changes.
}
