import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { AppInfo, ApprovalDecision, ApprovalRequest, CommandSummary } from '@shared/ipc'
import { BackgroundList, BackgroundMenu } from './BackgroundMenu'
import { TabBar } from './TabBar'
import { initialTabs, isPair, nextShellTitle, tabsReducer, type Unit } from './tabs-model'
import { UnitView } from './UnitView'

const api = (): typeof window.seam.terminals => window.seam.terminals

/** More client drops than this within the window means something is wrong; stop remounting. */
const MAX_REMOUNTS = 3
const REMOUNT_WINDOW_MS = 10_000

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [model, dispatch] = useReducer(tabsReducer, initialTabs)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [latest, setLatest] = useState<Record<string, CommandSummary>>({})
  // Keyed by the shell a card targets: one pane shows at most one at a time.
  const [approvals, setApprovals] = useState<Record<string, ApprovalRequest>>({})

  // Latest committed model, for event handlers that should not re-subscribe on every change.
  const modelRef = useRef(model)
  modelRef.current = model
  // Titles handed out but not yet in the model, so rapid new shells never repeat one.
  const reservedTitles = useRef(new Set<string>())
  const remounts = useRef(new Map<string, number[]>())

  // Each shell's latest command, live.
  useEffect(() => {
    return window.seam.commands.onChanged(({ terminalId, latest: l }) =>
      setLatest((prev) => (prev[terminalId]?.id === l.id && prev[terminalId]?.running === l.running && prev[terminalId]?.outputLines === l.outputLines ? prev : { ...prev, [terminalId]: l }))
    )
  }, [])

  // Shells already running (restored, or reopened) report their last command once.
  const shellIds = model.tabs.flatMap((u) => u.members.filter((m) => m.kind === 'shell').map((m) => m.id)).join(',')
  useEffect(() => {
    for (const id of shellIds ? shellIds.split(',') : []) {
      if (latest[id]) continue
      void window.seam.commands.latest(id).then((l) => l && setLatest((prev) => (prev[id] ? prev : { ...prev, [id]: l })))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellIds])

  // Cards live in main, so a window that opens late still sees what is waiting.
  useEffect(() => {
    void window.seam.approvals.open().then((open) => {
      setApprovals(Object.fromEntries(open.map((r) => [r.shellId, r])))
    })
    const offAsked = window.seam.approvals.onAsked((request) =>
      setApprovals((prev) => ({ ...prev, [request.shellId]: request }))
    )
    const offDone = window.seam.approvals.onDone(({ id }) =>
      setApprovals((prev) => Object.fromEntries(Object.entries(prev).filter(([, r]) => r.id !== id)))
    )
    return () => {
      offAsked()
      offDone()
    }
  }, [])

  const decideApproval = useCallback((id: string, decision: ApprovalDecision) => {
    window.seam.approvals.resolve(id, decision)
    // Main confirms with approvalDone, but take it down now: the user answered.
    setApprovals((prev) => Object.fromEntries(Object.entries(prev).filter(([, r]) => r.id !== id)))
  }, [])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
  }, [notice])

  /** Shell to Claude: paste the shell's last command into Claude's prompt, then hand Claude the keyboard. */
  const sendLast = useCallback(async (unit: Unit) => {
    const claude = unit.members.find((m) => m.kind === 'claude')
    const shell = unit.members.find((m) => m.kind === 'shell')
    if (!claude || !shell) return
    try {
      const r = await window.seam.commands.sendLastToClaude(shell.id, claude.id)
      dispatch({ type: 'focus', id: claude.id })
      const cmd = r.command.length > 40 ? `${r.command.slice(0, 39)}…` : r.command
      const details = [`exit ${r.exitCode ?? '?'}`, `${r.lines} line${r.lines === 1 ? '' : 's'}${r.truncated ? ' (tail)' : ''}`]
      if (r.masked) details.push(`${r.masked} secret${r.masked === 1 ? '' : 's'} masked`)
      setNotice(`Pasted “${cmd}” (${details.join(', ')}) into Claude's prompt. Add a note and press Enter.`)
      setError(null)
    } catch (err) {
      setError(remoteMessage(err))
    }
  }, [])

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

  const membersOf = (key: string) =>
    [...modelRef.current.tabs, ...modelRef.current.background].find((u) => u.key === key)?.members ?? []

  /** Claude Code and a shell, side by side, in a folder the user picks. */
  const newPair = useCallback(async () => {
    try {
      const cwd = await window.seam.pickFolder()
      if (!cwd) return
      const { claude, shell } = await api().createPair({ cwd })
      dispatch({ type: 'add', members: [claude, shell] })
      setError(null)
    } catch (err) {
      setError(String(err))
    }
  }, [])

  const newShell = useCallback(async () => {
    const m = modelRef.current
    // Only standalone shells compete for "shell N"; a pair's shell is named by its pair.
    const title = nextShellTitle([
      ...[...m.tabs, ...m.background].filter((u) => !isPair(u)).flatMap((u) => u.members.map((t) => t.title)),
      ...reservedTitles.current
    ])
    reservedTitles.current.add(title)
    try {
      dispatch({ type: 'add', members: [await api().create({ kind: 'shell', title })] })
      setError(null)
    } catch (err) {
      setError(String(err))
    } finally {
      reservedTitles.current.delete(title)
    }
  }, [])

  const openTab = useCallback(async (key: string) => {
    await Promise.all(membersOf(key).map((m) => api().setOpen(m.id, true)))
    dispatch({ type: 'open-from-background', key })
  }, [])

  /** Close the tab; its terminals keep running in the background. */
  const closeTab = useCallback(
    (key: string) => {
      const members = membersOf(key)
      dispatch({ type: 'remove-unit', key })
      void Promise.all(members.map((m) => api().setOpen(m.id, false))).then(refreshBackground)
    },
    [refreshBackground]
  )

  /** End the tab's terminals and everything running in them. */
  const endUnit = useCallback((key: string) => {
    const members = membersOf(key)
    dispatch({ type: 'remove-unit', key })
    for (const m of members) void api().kill(m.id)
  }, [])

  // A terminal that ends (shell exited, killed) leaves its tab; the other
  // side of a pair stays. A client that dropped while its terminal still
  // runs is re-attached by remounting, a few times at most.
  useEffect(() => {
    return api().onExit(({ id, ended }) => {
      if (ended) {
        remounts.current.delete(id)
        dispatch({ type: 'remove-terminal', id })
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
      const unit = modelRef.current.tabs.find((u) => u.members.some((m) => m.id === id))
      setError(`Lost the connection to "${unit?.members[0]?.title ?? 'a terminal'}" repeatedly. It is still running; reopen it from the background list.`)
      if (unit) closeTab(unit.key)
    })
  }, [closeTab])

  // Shortcuts live in the application menu (main), which sends commands here.
  useEffect(() => {
    return window.seam.onMenuCommand((command) => {
      const activeKey = modelRef.current.activeKey
      switch (command.type) {
        case 'new-pair':
          void newPair()
          break
        case 'new-shell':
          void newShell()
          break
        case 'close-tab':
          if (activeKey) closeTab(activeKey)
          break
        case 'end-terminal':
          if (activeKey) endUnit(activeKey)
          break
        case 'select-tab':
          dispatch({ type: 'select-index', index: command.index })
          break
        case 'toggle-focus':
          dispatch({ type: 'toggle-focus' })
          break
        case 'send-last': {
          const unit = modelRef.current.tabs.find((u) => u.key === activeKey)
          if (unit && isPair(unit)) void sendLast(unit)
          break
        }
      }
    })
  }, [closeTab, endUnit, newPair, newShell, sendLast])

  const onFocus = useCallback((id: string) => dispatch({ type: 'focus', id }), [])

  const { tabs, background, activeKey, restored } = model
  const tmuxMissing = info !== null && info.tmux === null

  return (
    <div className="app">
      <header className="titlebar">
        <span className="titlebar-name">Seam</span>
        {tabs.length > 0 && (
          <TabBar
            tabs={tabs}
            activeKey={activeKey}
            onSelect={(key) => dispatch({ type: 'activate', key })}
            onClose={closeTab}
            onNewPair={() => void newPair()}
          />
        )}
        {tabs.length > 0 && <BackgroundMenu units={background} onOpen={(key) => void openTab(key)} onEnd={endUnit} />}
      </header>

      {error && tabs.length > 0 && (
        <div className="banner" role="alert">
          <span>{error}</span>
          <button type="button" className="banner-dismiss" aria-label="Dismiss" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      {notice && tabs.length > 0 && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}

      <main className="workspace">
        {tabs.map((u) => (
          <UnitView
            key={u.key}
            unit={u}
            visible={u.key === activeKey}
            latest={latest}
            approvals={approvals}
            onFocus={onFocus}
            onSend={(unit) => void sendLast(unit)}
            onDecide={decideApproval}
          />
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
                <p>Open a project to start Claude Code with a shell beside it.</p>
                <div className="empty-actions">
                  <button type="button" className="button button-primary" onClick={() => void newPair()}>
                    New pair… <kbd>⌘T</kbd>
                  </button>
                  <button type="button" className="button" onClick={() => void newShell()}>
                    New shell <kbd>⌘⇧T</kbd>
                  </button>
                </div>
                {background.length > 0 && (
                  <div className="empty-background">
                    <p className="muted">Still running in the background</p>
                    <BackgroundList units={background} onOpen={(key) => void openTab(key)} onEnd={endUnit} />
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

/** Electron prefixes errors thrown in main; show only the message itself. */
function remoteMessage(err: unknown): string {
  return String(err instanceof Error ? err.message : err)
    .replace(/^Error invoking remote method '[^']+': /, '')
    .replace(/^\w*Error: /, '')
}
