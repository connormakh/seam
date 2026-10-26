import { useEffect, useRef } from 'react'
import type { AuditEntry, PolicyMode } from '@shared/ipc'

interface Props {
  entries: AuditEntry[]
  /** The focused pair's Claude session, if there is one; null disables the switch. */
  sessionId: string | null
  autoSync: boolean
  onAutoSync(on: boolean): void
  /** The focused pair's workspace, and what Claude may run in it. */
  policy: PolicyMode
  onPolicy(mode: PolicyMode): void
  onClose(): void
}

/** 14:03:51, which is all anyone needs to line a row up with their terminal. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false })
}

/**
 * What Claude has done in the shells.
 *
 * Nothing stands between Claude and the shell any more, so this is where the
 * question "what has it been doing in there" is answered. It reads bottom-up
 * like the terminals it describes: newest last, and it follows.
 */
export function ActivityPanel({
  entries,
  sessionId,
  autoSync,
  onAutoSync,
  policy,
  onPolicy,
  onClose
}: Props): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Follow the end, unless the user has scrolled back to read something.
  useEffect(() => {
    const el = listRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [entries])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside className="activity" aria-label="Claude activity">
      <header className="activity-header">
        <span className="activity-title">Activity</span>
        <span className="activity-count">{entries.length > 0 ? `${entries.length}` : ''}</span>
        {/* Auto sync is the other direction: what the shell tells Claude. */}
        <label
          className="activity-toggle"
          title={
            sessionId
              ? 'Tell Claude what you run in this shell, without being asked'
              : 'Open a Claude and shell pair to change this'
          }
        >
          <input
            type="checkbox"
            checked={autoSync}
            disabled={!sessionId}
            onChange={(e) => onAutoSync(e.currentTarget.checked)}
          />
          auto sync
        </label>
        {/* Allow is the point of a shared shell; the rest are here for
            anyone who wants the stricter thing back, per project. */}
        <select
          className="activity-policy"
          value={policy}
          disabled={!sessionId}
          title="What Claude may run in this project's shells"
          onChange={(e) => onPolicy(e.currentTarget.value as PolicyMode)}
        >
          <option value="allow">run freely</option>
          <option value="ask">ask first</option>
          <option value="allowlist">allowlist only</option>
          <option value="readonly">read only</option>
        </select>
        <button className="activity-close" onClick={onClose} title="Close (Esc)" aria-label="Close activity">
          ×
        </button>
      </header>
      <div
        className="activity-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {entries.length === 0 ? (
          <p className="activity-empty">
            Nothing yet. What Claude reads and runs in your shells shows up here.
          </p>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className="activity-row" data-outcome={entry.outcome}>
              <span className="activity-time">{clock(entry.at)}</span>
              <span className="activity-tool">{entry.tool}</span>
              <span className="activity-detail" title={entry.detail}>
                {entry.detail}
              </span>
              <span className="activity-outcome" title={entry.why}>
                {entry.outcome}
              </span>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}
