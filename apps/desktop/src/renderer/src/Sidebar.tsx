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
  onSettings
}: Props): React.JSX.Element {
  const row = (unit: Unit, background: boolean): React.JSX.Element => {
    const claude = unit.members.find((m) => m.kind === 'claude')
    const status = claude ? statuses[claude.id] : undefined
    const shell = unit.members.find((m) => m.kind === 'shell')
    return (
      <button
        key={unit.key}
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
    <aside className="sidebar" aria-label="Workspaces">
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
