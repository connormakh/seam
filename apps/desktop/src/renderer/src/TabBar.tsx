import { isPair, unitTitle, type Unit } from './tabs-model'

interface Props {
  tabs: Unit[]
  activeKey: string | null
  onSelect(key: string): void
  onClose(key: string): void
  onNewPair(): void
}

export function TabBar({ tabs, activeKey, onSelect, onClose, onNewPair }: Props): React.JSX.Element {
  return (
    <nav className="tabbar" aria-label="Tabs">
      <div className="tabs" role="tablist">
        {tabs.map((t, i) => {
          const title = unitTitle(t)
          const cwd = t.members[0]?.cwd ?? ''
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
