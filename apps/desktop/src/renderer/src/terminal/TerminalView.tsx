import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { registerTerminal } from './registry'
import { terminalOptions } from './theme'
import { DEFAULT_THEME, THEMES } from './themes'
import type { ThemeName } from '@shared/ipc'

interface Props {
  id: string
  theme: ThemeName
  /** On screen (its tab is active). */
  visible: boolean
  /** Should hold the keyboard while visible. */
  focused: boolean
  onFocus?: (id: string) => void
}

/**
 * One xterm.js instance bound to one Seam terminal.
 *
 * The tmux client is attached the first time the view is visible, at its
 * real size, so tabs restored in the background cost nothing until opened
 * and never draw at a placeholder size. Unmounting detaches (the terminal
 * keeps running). Hidden views stay mounted to keep their screen.
 */
export function TerminalView({ id, theme, visible, focused, onFocus }: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const showRef = useRef<() => void>(() => {})
  const onFocusRef = useRef(onFocus)
  onFocusRef.current = onFocus
  // Read when a terminal is created; the effect below handles later changes.
  const themeRef = useRef<ThemeName>(theme)
  themeRef.current = THEMES[theme] ? theme : DEFAULT_THEME

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const api = window.seam.terminals

    // The palette is set here rather than in the shared options, so a theme
    // change repaints a terminal that is already running.
    const term = new Terminal({ ...terminalOptions, theme: THEMES[themeRef.current].terminal })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term

    // App shortcuts come from the menu; keep Cmd combos away from the shell.
    term.attachCustomKeyEventHandler((e) => !(e.metaKey && e.type === 'keydown' && !['c', 'v'].includes(e.key)))

    const unregister = registerTerminal(id, term)

    // Programs copy by asking the terminal to, with OSC 52, and that is the
    // only way text selected inside tmux's copy mode can reach the Mac's
    // clipboard. A read request is never answered: a program that can ask
    // for the clipboard can read whatever was last copied anywhere.
    const osc = term.parser.registerOscHandler(52, (data) => {
      const payload = data.slice(data.indexOf(';') + 1)
      if (payload === '?' || payload === '') return true
      try {
        const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
        void window.seam.edit.copy(new TextDecoder().decode(bytes))
      } catch {
        // Not valid base64: not something we can put on a clipboard.
      }
      return true
    })

    // tmux is not handling the mouse, so that dragging selects text, which
    // leaves the wheel to be forwarded to tmux's history from here. This
    // runs instead of xterm's own handling, which with no scrollback of its
    // own turns the wheel into arrow keys, and so would walk the shell's
    // command history. xterm does not ask at all when the program in the
    // pane has requested wheel events itself: then it gets them.
    let carry = 0
    let inFlight = false
    let backlog = 0
    const drain = (): void => {
      if (inFlight || backlog === 0) return
      const lines = backlog
      backlog = 0
      inFlight = true
      void api.scroll(id, lines).catch(noop).finally(() => {
        inFlight = false
        drain()
      })
    }
    term.attachCustomWheelEventHandler((e) => {
      // A program reading the mouse itself gets the wheel, which xterm sends
      // on once this hands the event back. Whether the pane is showing a
      // program's own screen is a question only tmux can answer, since from
      // out here tmux is always on the alternate screen itself.
      if (term.modes.mouseTrackingMode !== 'none') return true
      e.preventDefault()
      // deltaMode 0 is pixels, which only a row height turns into lines.
      const rowPx = Math.max(1, host.clientHeight / Math.max(1, term.rows))
      carry += e.deltaMode === 0 ? e.deltaY / rowPx : e.deltaY
      const lines = Math.trunc(carry)
      if (lines !== 0) {
        carry -= lines
        backlog += lines
        drain()
      }
      return false
    })

    // Clicking into a pane makes it the focused side of its pair.
    const textarea = term.textarea
    const reportFocus = (): void => onFocusRef.current?.(id)
    textarea?.addEventListener('focus', reportFocus)

    // Listen before attaching so the initial redraw from tmux is not missed.
    const offData = api.onData(id, (data) => term.write(data))
    const input = term.onData((data) => api.write(id, data))
    const resized = term.onResize(({ cols, rows }) => api.resize(id, { cols, rows }))

    let attached = false
    let disposed = false
    const show = (): void => {
      if (disposed || !safeFit(fit, host)) return
      if (attached) return
      attached = true
      void api.attach(id, { cols: term.cols, rows: term.rows }).catch((err: unknown) => {
        term.write(`\r\n\x1b[31mCould not attach: ${String(err)}\x1b[0m\r\n`)
      })
    }
    showRef.current = show
    show()

    // Refits on window and divider resizes, and catches a hidden tab being shown.
    const observer = new ResizeObserver(() => show())
    observer.observe(host)

    return () => {
      disposed = true
      observer.disconnect()
      osc.dispose()
      unregister()
      textarea?.removeEventListener('focus', reportFocus)
      offData()
      input.dispose()
      resized.dispose()
      if (attached) void api.detach(id)
      term.dispose()
      termRef.current = null
      showRef.current = () => {}
    }
  }, [id])

  // Repaint a terminal that is already open. xterm takes a whole palette, so
  // this is the one place a theme change has to reach into a live instance.
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = THEMES[theme]?.terminal ?? THEMES[DEFAULT_THEME].terminal
  }, [theme])

  useEffect(() => {
    if (!visible) return
    showRef.current()
    if (focused) termRef.current?.focus()
  }, [visible, focused])

  return <div ref={hostRef} className="terminal-host" data-terminal-id={id} />
}

function noop(): void {}

/** Fits the terminal to its host. Returns false while the host is hidden or has no size. */
function safeFit(fit: FitAddon, host: HTMLElement): boolean {
  if (host.offsetParent === null || host.clientWidth === 0 || host.clientHeight === 0) return false
  try {
    fit.fit()
    return true
  } catch {
    // The terminal can be disposed mid-resize during unmount.
    return false
  }
}
