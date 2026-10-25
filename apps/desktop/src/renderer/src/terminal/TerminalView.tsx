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
 * One xterm.js instance bound to one Seam terminal. Mounting attaches a tmux
 * client in main; unmounting detaches it (the terminal keeps running).
 * Inactive tabs stay mounted but hidden so their screen state is kept.
 */
export function TerminalView({ id, active }: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const api = window.seam.terminals

    const term = new Terminal(terminalOptions)
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    // App shortcuts (Cmd+T, Cmd+W, Cmd+1..9) must not reach the shell.
    term.attachCustomKeyEventHandler((e) => !(e.metaKey && e.type === 'keydown' && !['c', 'v'].includes(e.key)))

    // Listen before attaching so the initial redraw from tmux is not missed.
    const offData = api.onData(id, (data) => term.write(data))
    const input = term.onData((data) => api.write(id, data))
    const resized = term.onResize(({ cols, rows }) => api.resize(id, { cols, rows }))

    safeFit(fit, host)
    void api.attach(id, { cols: term.cols, rows: term.rows }).catch((err: unknown) => {
      term.write(`\r\n\x1b[31mCould not attach: ${String(err)}\x1b[0m\r\n`)
    })

    const observer = new ResizeObserver(() => safeFit(fit, host))
    observer.observe(host)

    return () => {
      observer.disconnect()
      offData()
      input.dispose()
      resized.dispose()
      void api.detach(id)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [id])

  useEffect(() => {
    if (!active) return
    const host = hostRef.current
    if (host && fitRef.current) safeFit(fitRef.current, host)
    termRef.current?.focus()
  }, [active])

  return <div ref={hostRef} className="terminal-host" data-terminal-id={id} hidden={!active} />
}

/** Fitting a hidden element yields a zero size; skip until it is visible. */
function safeFit(fit: FitAddon, host: HTMLElement): void {
  if (host.offsetParent === null || host.clientWidth === 0 || host.clientHeight === 0) return
  try {
    fit.fit()
  } catch {
    // The terminal can be disposed mid-resize during unmount.
  }
}
