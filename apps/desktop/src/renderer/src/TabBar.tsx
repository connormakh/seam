import type { TerminalInfo } from '@shared/ipc'

interface Props {
  tabs: TerminalInfo[]
  activeId: string | null
  onSelect(id: string): void
  onClose(id: string): void
  onNew(): void
}

export function TabBar({ tabs, activeId, onSelect, onClose, onNew }: Props): React.JSX.Element {
  return (
    <nav className="tabbar" aria-label="Terminals">
      <div className="tabs" role="tablist">
        {tabs.map((t, i) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === activeId}
            className={`tab${t.id === activeId ? ' tab-active' : ''}`}
            onMouseDown={(e) => {
              // Middle click closes, like a browser tab.
              if (e.button === 1) {
                e.preventDefault()
                onClose(t.id)
              }
            }}
            onClick={() => onSelect(t.id)}
            title={`${t.title} · ${t.cwd}${i < 9 ? ` · ⌘${i + 1}` : ''}`}
          >
            <span className="tab-title">{t.title}</span>
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${t.title}`}
              title="Close tab (keeps running) · ⌘W"
              onClick={(e) => {
                e.stopPropagation()
                onClose(t.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="tab-new" aria-label="New shell" title="New shell · ⌘T" onClick={onNew}>
        +
      </button>
    </nav>
  )
}
