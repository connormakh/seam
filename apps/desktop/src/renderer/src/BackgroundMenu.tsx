import { useEffect, useRef, useState } from 'react'
import type { TerminalInfo } from '@shared/ipc'

interface Props {
  terminals: TerminalInfo[]
  onOpen(id: string): void
  onEnd(id: string): void
}

/** Terminals still running without a tab: reopen them or end them. */
export function BackgroundMenu({ terminals, onOpen, onEnd }: Props): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (terminals.length === 0) return null

  return (
    <div className="bg-menu" ref={ref}>
      <button type="button" className="bg-menu-button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {terminals.length} in background
      </button>
      {open && (
        <div className="bg-menu-panel" role="menu">
          <BackgroundList
            terminals={terminals}
            onOpen={(id) => {
              setOpen(false)
              onOpen(id)
            }}
            onEnd={onEnd}
          />
        </div>
      )}
    </div>
  )
}

export function BackgroundList({ terminals, onOpen, onEnd }: Props): React.JSX.Element {
  return (
    <ul className="bg-list">
      {terminals.map((t) => (
        <li key={t.id} className="bg-item">
          <div className="bg-item-text">
            <span className="bg-item-title">{t.title}</span>
            <span className="muted">
              {t.currentCommand} · {shortPath(t.cwd)}
            </span>
          </div>
          <button type="button" className="button button-small" onClick={() => onOpen(t.id)}>
            Open
          </button>
          <button type="button" className="button button-small button-danger" onClick={() => onEnd(t.id)}>
            End
          </button>
        </li>
      ))}
    </ul>
  )
}

function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p || '/'
}
