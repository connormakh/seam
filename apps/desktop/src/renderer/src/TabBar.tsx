import type { SessionStatus } from '@shared/ipc'
import { isPair, unitTitle, type Unit } from './tabs-model'

/** What a dot on a tab says, when the tab is not the one in front. */
const SAYS: Record<SessionStatus['state'], string> = {
  working: 'Claude is working',
  waiting: 'Claude is waiting for you',
  idle: 'Claude is idle'
}

interface Props {
  tabs: Unit[]
  statuses: Record<string, SessionStatus>
  activeKey: string | null
  onSelect(key: string): void
  onClose(key: string): void
  onNewPair(): void
}

export function TabBar({ tabs, statuses, activeKey, onSelect, onClose, onNewPair }: Props): React.JSX.Element {
  return (
    <nav className="tabbar" aria-label="Tabs">
      <div className="tabs" role="tablist">
        {tabs.map((t, i) => {
          const title = unitTitle(t)
          const cwd = t.members[0]?.cwd ?? ''
          const claude = t.members.find((m) => m.kind === 'claude')
          const status = claude ? statuses[claude.id] : undefined
          return (
            <div
              key={t.key}
              role="tab"
              aria-selected={t.key === activeKey}
              className={`tab${t.key === activeKey ? ' tab-active' : ''}`}
              onMouseDown={(e) => {
                // Middle click closes, like a browser tab.
                if (e.button === 1) {
                  e.preventDefault()
                  onClose(t.key)
                }
              }}
              onClick={() => onSelect(t.key)}
              title={`${isPair(t) ? 'Claude + shell' : title} · ${cwd}${i < 9 ? ` · ⌘${i + 1}` : ''}`}
            >
              {isPair(t) && <span className="tab-pair" aria-label="Claude and shell pair" />}
              {/* The point of the dot is the tab you are not looking at. */}
              {status && (
                <span
                  className="tab-state"
                  data-state={status.state}
                  data-unseen={status.unseen ? '1' : '0'}
                  title={status.preview ? `${SAYS[status.state]} · ${status.preview}` : SAYS[status.state]}
                  aria-label={SAYS[status.state]}
                />
              )}
              <span className="tab-title">{title}</span>
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${title}`}
                title="Close tab (keeps running) · ⌘W"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(t.key)
                }}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
      <button type="button" className="tab-new" aria-label="New pair" title="New Claude + shell pair · ⌘T" onClick={onNewPair}>
        +
      </button>
    </nav>
  )
}
