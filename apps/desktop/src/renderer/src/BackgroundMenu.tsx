import { useEffect, useRef, useState } from 'react'
import { isPair, unitTitle, type Unit } from './tabs-model'
import { shortPath } from './UnitView'

interface Props {
  units: Unit[]
  onOpen(key: string): void
  onEnd(key: string): void
}

/** Tabs still running without being shown: reopen them or end them. */
export function BackgroundMenu({ units, onOpen, onEnd }: Props): React.JSX.Element | null {
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

  if (units.length === 0) return null

  return (
    <div className="bg-menu" ref={ref}>
      <button type="button" className="bg-menu-button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {units.length} in background
      </button>
      {open && (
        <div className="bg-menu-panel" role="menu">
          <BackgroundList
            units={units}
            onOpen={(key) => {
              setOpen(false)
              onOpen(key)
            }}
            onEnd={onEnd}
          />
        </div>
      )}
    </div>
  )
}

export function BackgroundList({ units, onOpen, onEnd }: Props): React.JSX.Element {
  return (
    <ul className="bg-list">
      {units.map((u) => {
        const lead = u.members[0]
        const detail = isPair(u) ? 'Claude + shell' : (lead?.currentCommand ?? '')
        return (
          <li key={u.key} className="bg-item">
            <div className="bg-item-text">
              <span className="bg-item-title">
                {isPair(u) && <span className="tab-pair" aria-hidden="true" />}
                {unitTitle(u)}
              </span>
              <span className="muted">
                {detail} · {shortPath(lead?.cwd ?? '')}
              </span>
            </div>
            <button type="button" className="button button-small" onClick={() => onOpen(u.key)}>
              Open
            </button>
            <button type="button" className="button button-small button-danger" onClick={() => onEnd(u.key)}>
              End
            </button>
          </li>
        )
      })}
    </ul>
  )
}
