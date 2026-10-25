import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { terminalOptions } from './theme'

interface Props {
  id: string
  active: boolean
}

/**
 * One xterm.js instance bound to one Seam terminal.
 *
 * The tmux client is attached the first time the view is visible, at its
 * real size, so tabs restored in the background cost nothing until opened
 * and never draw at a placeholder size. Unmounting detaches (the terminal
 * keeps running). Inactive tabs stay mounted but hidden to keep their screen.
 */
export function TerminalView({ id, active }: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const showRef = useRef<() => void>(() => {})

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const api = window.seam.terminals

    const term = new Terminal(terminalOptions)
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term

    // App shortcuts come from the menu; keep Cmd combos away from the shell.
    term.attachCustomKeyEventHandler((e) => !(e.metaKey && e.type === 'keydown' && !['c', 'v'].includes(e.key)))

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

    // Refits on window resizes, and catches the moment a hidden tab is shown.
    const observer = new ResizeObserver(() => show())
    observer.observe(host)

    return () => {
      disposed = true
      observer.disconnect()
      offData()
      input.dispose()
      resized.dispose()
      if (attached) void api.detach(id)
      term.dispose()
      termRef.current = null
      showRef.current = () => {}
    }
  }, [id])

  useEffect(() => {
    if (!active) return
    showRef.current()
    termRef.current?.focus()
  }, [active])

  return <div ref={hostRef} className="terminal-host" data-terminal-id={id} hidden={!active} />
}

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
