import { useRef } from 'react'
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
  const listRef = useRef<HTMLDivElement>(null)

  /**
   * Left and right walk the tabs, Enter opens the one you land on. Moving
   * the keyboard without opening is the slower half of the ARIA pattern and
   * the right one here: passing over a tab would attach its terminals.
   */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const stops = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-nav-tab]') ?? [])]
    const at = stops.indexOf(document.activeElement as HTMLElement)
    if (at === -1) return
    const go = (to: number): void => {
      e.preventDefault()
      stops[Math.max(0, Math.min(stops.length - 1, to))]?.focus()
    }
    if (e.key === 'ArrowRight') go(at + 1)
    else if (e.key === 'ArrowLeft') go(at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(stops.length - 1)
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const key = stops[at]?.dataset.navTab
      if (key) onSelect(key)
    }
  }

  return (
    <nav className="tabbar" aria-label="Tabs">
      <div className="tabs" role="tablist" ref={listRef} onKeyDown={onKeyDown}>
        {tabs.map((t, i) => {
          const title = unitTitle(t)
          const cwd = t.members[0]?.cwd ?? ''
          const claude = t.members.find((m) => m.kind === 'claude')
          const status = claude ? statuses[claude.id] : undefined
          return (
            <div
              key={t.key}
              role="tab"
              data-nav-tab={t.key}
              // Only the open tab is a Tab stop; the arrows reach the rest.
              tabIndex={t.key === activeKey ? 0 : -1}
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
