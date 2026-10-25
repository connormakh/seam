import { useCallback, useEffect, useState } from 'react'
import type { AppInfo, TerminalInfo } from '@shared/ipc'
import { TabBar } from './TabBar'
import { TerminalView } from './terminal/TerminalView'

interface Tab {
  info: TerminalInfo
  /** Bumped to remount the view, which re-attaches a fresh client. */
  generation: number
}

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.seam.appInfo().then(setInfo)
  }, [])

  const newShell = useCallback(async () => {
    try {
      const t = await window.seam.terminals.create({ kind: 'shell' })
      setTabs((prev) => [...prev, { info: t, generation: 0 }])
      setActiveId(t.id)
      setError(null)
    } catch (err) {
      setError(String(err))
    }
  }, [])

  const closeTab = useCallback((id: string) => {
    // Unmounting the view detaches; the terminal keeps running in tmux.
    setTabs((prev) => {
      const i = prev.findIndex((t) => t.info.id === id)
      const next = prev.filter((t) => t.info.id !== id)
      setActiveId((current) => {
        if (current !== id) return current
        const neighbour = next[Math.min(i, next.length - 1)]
        return neighbour ? neighbour.info.id : null
      })
      return next
    })
  }, [])

  // A terminal that ends (shell exited, killed) loses its tab. A client that
  // dropped while the terminal still runs is re-attached by remounting.
  useEffect(() => {
    return window.seam.terminals.onExit(({ id, ended }) => {
      if (ended) closeTab(id)
      else setTabs((prev) => prev.map((t) => (t.info.id === id ? { ...t, generation: t.generation + 1 } : t)))
    })
  }, [closeTab])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!e.metaKey || e.altKey || e.ctrlKey) return
      if (e.key === 't') {
        e.preventDefault()
        void newShell()
      } else if (e.key === 'w' && activeId) {
        e.preventDefault()
        closeTab(activeId)
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
  }, [activeId, closeTab, newShell, tabs])

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
      </header>

      <main className="workspace">
        {tabs.map((t) => (
          <TerminalView key={`${t.info.id}:${t.generation}`} id={t.info.id} active={t.info.id === activeId} />
        ))}

        {tabs.length === 0 && (
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
