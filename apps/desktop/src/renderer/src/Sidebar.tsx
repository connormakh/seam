import { useRef } from 'react'
import type { SessionStatus } from '@shared/ipc'
import { isPair, unitTitle, type Unit, type WorkspaceGroup } from './tabs-model'

interface Props {
  groups: WorkspaceGroup[]
  activeKey: string | null
  statuses: Record<string, SessionStatus>
  onSelect(unit: Unit, background: boolean): void
  onNewSession(root: string): void
  onForget(root: string): void
  onSettings(): void
  /** Escape: the keyboard goes back to the terminal it came from. */
  onLeave(): void
}

const SAYS: Record<SessionStatus['state'], string> = {
  working: 'working',
  waiting: 'waiting for you',
  idle: 'idle'
}

/**
 * Workspaces down the side, each holding its sessions.
 *
 * A workspace is a folder, and it outlives whatever is running in it, so a
 * project you closed everything in is still listed and one click from being
 * open again. Tabs still show what is open; this says what exists.
 */
export function Sidebar({
  groups,
  activeKey,
  statuses,
  onSelect,
  onNewSession,
  onForget,
  onSettings,
  onLeave
}: Props): React.JSX.Element {
  const listRef = useRef<HTMLElement>(null)

  /**
   * Up and down walk the sessions, across workspaces, because what the eye
   * sees is one list however it is grouped. Arrowing only moves the
   * keyboard; Enter opens, so passing over a session does not attach a
   * terminal nobody asked for.
   */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onLeave()
      return
    }
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-nav-row]') ?? [])]
    if (rows.length === 0) return
    // -1 while the keyboard is on a workspace's own buttons, from where
    // down means the first session and up the last.
    const at = rows.indexOf(document.activeElement as HTMLElement)
    const go = (to: number): void => {
      e.preventDefault()
      rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus()
    }
    if (e.key === 'ArrowDown') go(at + 1)
    else if (e.key === 'ArrowUp') go(at === -1 ? rows.length - 1 : at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(rows.length - 1)
  }

  const row = (unit: Unit, background: boolean): React.JSX.Element => {
    const claude = unit.members.find((m) => m.kind === 'claude')
    const status = claude ? statuses[claude.id] : undefined
    const shell = unit.members.find((m) => m.kind === 'shell')
    return (
      <button
        key={unit.key}
        data-nav-row={unit.key}
        // Only the open one is a Tab stop; the arrows reach the rest.
        tabIndex={unit.key === activeKey ? 0 : -1}
        aria-current={unit.key === activeKey ? 'true' : undefined}
        className={`ws-session${unit.key === activeKey ? ' ws-session-active' : ''}`}
        title={[
          isPair(unit) ? 'Claude and shell' : 'Shell',
          status ? SAYS[status.state] : null,
          background ? 'running in the background' : null,
          status?.preview
        ]
          .filter(Boolean)
          .join(' · ')}
        onClick={() => onSelect(unit, background)}
      >
        {status ? (
          <span className="tab-state" data-state={status.state} data-unseen={status.unseen ? '1' : '0'} />
        ) : (
          <span className="tab-state" data-state="none" />
        )}
        <span className="ws-session-name">{unitTitle(unit)}</span>
        {shell?.private && <span className="ws-private">private</span>}
        {background && <span className="ws-background">closed</span>}
      </button>
    )
  }

  return (
    <aside className="sidebar" aria-label="Workspaces" ref={listRef} onKeyDown={onKeyDown}>
      <div className="sidebar-scroll">
      {groups.length === 0 && <p className="ws-empty">No workspaces yet. ⌘T opens one.</p>}
      {groups.map((group) => (
        <section className="ws" key={group.workspace.root || 'elsewhere'}>
          <header className="ws-header">
            <span className="ws-name" title={group.workspace.root}>
              {group.workspace.name}
            </span>
            <button
              className="ws-add"
              title={`New Claude and shell in ${group.workspace.name}`}
              aria-label={`New session in ${group.workspace.name}`}
              disabled={!group.workspace.root}
              onClick={() => onNewSession(group.workspace.root)}
            >
              +
            </button>
            {/* Forgetting is only about the list: nothing running is touched. */}
            <button
              className="ws-forget"
              title="Forget this workspace. Anything running in it keeps running."
              aria-label={`Forget ${group.workspace.name}`}
              disabled={!group.workspace.root}
              onClick={() => onForget(group.workspace.root)}
            >
              ×
            </button>
          </header>
          {group.tabs.length + group.background.length === 0 ? (
            <p className="ws-none">nothing open</p>
          ) : (
            <>
              {group.tabs.map((u) => row(u, false))}
              {group.background.map((u) => row(u, true))}
            </>
          )}
        </section>
      ))}
      </div>
      {/* Pinned to the bottom, where a settings button is looked for. */}
      <footer className="sidebar-footer">
        <button className="sidebar-settings" onClick={onSettings} title="Settings (⌘,)">
          <span aria-hidden="true">⚙</span> Settings
        </button>
      </footer>
    </aside>
  )
}
