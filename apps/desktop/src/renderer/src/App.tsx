import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { AppInfo } from '@shared/ipc'
import { BackgroundList, BackgroundMenu } from './BackgroundMenu'
import { TabBar } from './TabBar'
import { initialTabs, nextShellTitle, tabsReducer } from './tabs-model'
import { TerminalView } from './terminal/TerminalView'

const api = (): typeof window.seam.terminals => window.seam.terminals

/** More client drops than this within the window means something is wrong; stop remounting. */
const MAX_REMOUNTS = 3
const REMOUNT_WINDOW_MS = 10_000

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [model, dispatch] = useReducer(tabsReducer, initialTabs)
  const [error, setError] = useState<string | null>(null)

  // Latest committed model, for event handlers that should not re-subscribe on every change.
  const modelRef = useRef(model)
  modelRef.current = model
  // Titles handed out but not yet in the model, so rapid Cmd+T never repeats one.
  const reservedTitles = useRef(new Set<string>())
  const remounts = useRef(new Map<string, number[]>())

  const refreshBackground = useCallback(async () => {
    dispatch({ type: 'set-background', terminals: await api().list() })
  }, [])

  // On launch, reopen the tabs that were open last time; the rest stay in
  // the background list.
  useEffect(() => {
    void (async () => {
      setInfo(await window.seam.appInfo())
      dispatch({ type: 'restore', terminals: await api().list() })
    })().catch((err: unknown) => setError(String(err)))
  }, [])

  const newShell = useCallback(async () => {
    const m = modelRef.current
    const title = nextShellTitle([
      ...m.tabs.map((t) => t.info.title),
      ...m.background.map((b) => b.title),
      ...reservedTitles.current
    ])
    reservedTitles.current.add(title)
    try {
      dispatch({ type: 'add', info: await api().create({ kind: 'shell', title }) })
      setError(null)
    } catch (err) {
      setError(String(err))
    } finally {
      reservedTitles.current.delete(title)
    }
  }, [])

  const openTab = useCallback(async (id: string) => {
    await api().setOpen(id, true)
    dispatch({ type: 'open-from-background', id })
  }, [])

  /** Close the tab; the terminal keeps running in the background. */
  const closeTab = useCallback(
    (id: string) => {
      dispatch({ type: 'remove', id })
      void api()
        .setOpen(id, false)
        .then(refreshBackground)
    },
    [refreshBackground]
  )

  /** End the terminal and everything running in it. */
  const endTerminal = useCallback((id: string) => {
    dispatch({ type: 'remove', id })
    void api().kill(id)
  }, [])

  // A terminal that ends (shell exited, killed) loses its tab. A client that
  // dropped while the terminal still runs is re-attached by remounting, a
  // few times at most, so a persistent failure cannot loop forever.
  useEffect(() => {
    return api().onExit(({ id, ended }) => {
      if (ended) {
        remounts.current.delete(id)
        dispatch({ type: 'remove', id })
        return
      }
      const now = Date.now()
      const recent = (remounts.current.get(id) ?? []).filter((t) => now - t < REMOUNT_WINDOW_MS)
      recent.push(now)
      remounts.current.set(id, recent)
      if (recent.length <= MAX_REMOUNTS) {
        dispatch({ type: 'remount', id })
        return
      }
      remounts.current.delete(id)
      const title = modelRef.current.tabs.find((t) => t.info.id === id)?.info.title ?? 'a terminal'
      setError(`Lost the connection to "${title}" repeatedly. It is still running; reopen it from the background list.`)
      closeTab(id)
    })
  }, [closeTab])

  // Shortcuts live in the application menu (main), which sends commands here.
  useEffect(() => {
    return window.seam.onMenuCommand((command) => {
      const activeId = modelRef.current.activeId
      switch (command.type) {
        case 'new-shell':
          void newShell()
          break
        case 'close-tab':
          if (activeId) closeTab(activeId)
          break
        case 'end-terminal':
          if (activeId) endTerminal(activeId)
          break
        case 'select-tab':
          dispatch({ type: 'select-index', index: command.index })
          break
      }
    })
  }, [closeTab, endTerminal, newShell])

  const { tabs, background, activeId, restored } = model
  const tmuxMissing = info !== null && info.tmux === null

  return (
    <div className="app">
      <header className="titlebar">
        <span className="titlebar-name">Seam</span>
        {tabs.length > 0 && (
          <TabBar
            tabs={tabs.map((t) => t.info)}
            activeId={activeId}
            onSelect={(id) => dispatch({ type: 'activate', id })}
            onClose={closeTab}
            onNew={() => void newShell()}
          />
        )}
        {tabs.length > 0 && <BackgroundMenu terminals={background} onOpen={(id) => void openTab(id)} onEnd={endTerminal} />}
      </header>

      {error && tabs.length > 0 && (
        <div className="banner" role="alert">
          <span>{error}</span>
          <button type="button" className="banner-dismiss" aria-label="Dismiss" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

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
