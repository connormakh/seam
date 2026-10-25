import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppInfo, TerminalInfo } from '@shared/ipc'
import { BackgroundList, BackgroundMenu } from './BackgroundMenu'
import { TabBar } from './TabBar'
import { TerminalView } from './terminal/TerminalView'

interface Tab {
  info: TerminalInfo
  /** Bumped to remount the view, which re-attaches a fresh client. */
  generation: number
}

const api = (): typeof window.seam.terminals => window.seam.terminals

function nextShellTitle(taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has('shell')) return 'shell'
  for (let n = 2; ; n++) if (!used.has(`shell ${n}`)) return `shell ${n}`
}

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [background, setBackground] = useState<TerminalInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restored, setRestored] = useState(false)

  const tabIds = useRef(new Set<string>())
  tabIds.current = new Set(tabs.map((t) => t.info.id))

  const refreshBackground = useCallback(async () => {
    const all = await api().list()
    setBackground(all.filter((t) => !tabIds.current.has(t.id)))
  }, [])

  // On launch, reopen the tabs that were open last time; the rest stay in
  // the background menu.
  useEffect(() => {
    void (async () => {
      const appInfo = await window.seam.appInfo()
      setInfo(appInfo)
      const all = await api().list()
      const open = all.filter((t) => t.open)
      setTabs(open.map((t) => ({ info: t, generation: 0 })))
      setActiveId(open[0]?.id ?? null)
      setBackground(all.filter((t) => !t.open))
      setRestored(true)
    })().catch((err: unknown) => setError(String(err)))
  }, [])

  const openTab = useCallback(
    async (id: string) => {
      const t = background.find((b) => b.id === id)
      if (!t) return
      await api().setOpen(id, true)
      setTabs((prev) => (prev.some((p) => p.info.id === id) ? prev : [...prev, { info: { ...t, open: true }, generation: 0 }]))
      setBackground((prev) => prev.filter((b) => b.id !== id))
      setActiveId(id)
    },
    [background]
  )

  const newShell = useCallback(async () => {
    try {
      const taken = [...tabs.map((t) => t.info.title), ...background.map((b) => b.title)]
      const t = await api().create({ kind: 'shell', title: nextShellTitle(taken) })
      setTabs((prev) => [...prev, { info: t, generation: 0 }])
      setActiveId(t.id)
      setError(null)
    } catch (err) {
      setError(String(err))
    }
  }, [tabs, background])

  const removeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const i = prev.findIndex((t) => t.info.id === id)
      if (i === -1) return prev
      const next = prev.filter((t) => t.info.id !== id)
      setActiveId((current) => {
        if (current !== id) return current
        const neighbour = next[Math.min(i, next.length - 1)]
        return neighbour ? neighbour.info.id : null
      })
      return next
    })
  }, [])

  /** Close the tab; the terminal keeps running in the background. */
  const closeTab = useCallback(
    (id: string) => {
      removeTab(id)
      void api()
        .setOpen(id, false)
        .then(refreshBackground)
    },
    [removeTab, refreshBackground]
  )

  /** End the terminal and everything running in it. */
  const endTerminal = useCallback(
    (id: string) => {
      removeTab(id)
      setBackground((prev) => prev.filter((b) => b.id !== id))
      void api().kill(id)
    },
    [removeTab]
  )

  // A terminal that ends (shell exited, killed) loses its tab. A client that
  // dropped while the terminal still runs is re-attached by remounting.
  useEffect(() => {
    return api().onExit(({ id, ended }) => {
      if (ended) {
        removeTab(id)
        setBackground((prev) => prev.filter((b) => b.id !== id))
      } else {
        setTabs((prev) => prev.map((t) => (t.info.id === id ? { ...t, generation: t.generation + 1 } : t)))
      }
    })
  }, [removeTab])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!e.metaKey || e.altKey || e.ctrlKey) return
      const key = e.key.toLowerCase()
      if (key === 't' && !e.shiftKey) {
        e.preventDefault()
        void newShell()
      } else if (key === 'w' && activeId) {
        e.preventDefault()
        if (e.shiftKey) endTerminal(activeId)
        else closeTab(activeId)
      } else if (/^[1-9]$/.test(e.key)) {
        const tab = tabs[Number(e.key) - 1]
        if (tab) {
          e.preventDefault()
          setActiveId(tab.info.id)
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [activeId, closeTab, endTerminal, newShell, tabs])

  const tmuxMissing = info !== null && info.tmux === null

  return (
    <div className="app">
      <header className="titlebar">
        <span className="titlebar-name">Seam</span>
        {tabs.length > 0 && (
          <TabBar
            tabs={tabs.map((t) => t.info)}
            activeId={activeId}
            onSelect={setActiveId}
            onClose={closeTab}
            onNew={() => void newShell()}
          />
        )}
        {tabs.length > 0 && <BackgroundMenu terminals={background} onOpen={(id) => void openTab(id)} onEnd={endTerminal} />}
      </header>

      <main className="workspace">
        {tabs.map((t) => (
          <TerminalView key={`${t.info.id}:${t.generation}`} id={t.info.id} active={t.info.id === activeId} />
        ))}

        {restored && tabs.length === 0 && (
          <div className="empty">
            {tmuxMissing ? (
              <>
                <p>Seam needs tmux to keep terminals running.</p>
                <p className="muted">
                  Install it with <code>brew install tmux</code>, then restart Seam.
                </p>
              </>
            ) : (
              <>
                <p>No terminals open.</p>
                <button type="button" className="button" onClick={() => void newShell()}>
                  New shell <kbd>⌘T</kbd>
                </button>
                {background.length > 0 && (
                  <div className="empty-background">
                    <p className="muted">Still running in the background</p>
                    <BackgroundList terminals={background} onOpen={(id) => void openTab(id)} onEnd={endTerminal} />
                  </div>
                )}
              </>
            )}
            {error && <p className="error">{error}</p>}
            {info && (
              <p className="muted small">
                v{info.version} · Electron {info.electron} · {info.tmux ?? 'no tmux'}
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
