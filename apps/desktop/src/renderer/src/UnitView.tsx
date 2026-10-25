import { useCallback, useRef, useState } from 'react'
import type { CommandSummary, TerminalInfo } from '@shared/ipc'
import { CommandStatus } from './CommandStatus'
import { TerminalView } from './terminal/TerminalView'
import { isPair, type Unit } from './tabs-model'

interface Props {
  unit: Unit
  visible: boolean
  /** Latest command per terminal id. */
  latest: Record<string, CommandSummary>
  onFocus(id: string): void
  onSend(unit: Unit): void
}

const MIN_RATIO = 0.2
const MAX_RATIO = 0.8

// The split is a per-window convenience, not shared state; storage can be unavailable.
function readRatio(key: string): number {
  try {
    const v = Number(window.localStorage.getItem(`seam.split.${key}`))
    if (v >= MIN_RATIO && v <= MAX_RATIO) return v
  } catch {
    // fall through
  }
  return 0.5
}

function saveRatio(key: string, ratio: number): void {
  try {
    window.localStorage.setItem(`seam.split.${key}`, String(ratio))
  } catch {
    // not persisted; fine
  }
}

/** A tab's content: one terminal, or Claude and its shell side by side. */
export function UnitView({ unit, visible, latest, onFocus, onSend }: Props): React.JSX.Element {
  const [ratio, setRatio] = useState(() => readRatio(unit.key))
  const [dragging, setDragging] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }, [])

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging || !rowRef.current) return
      const rect = rowRef.current.getBoundingClientRect()
      const next = Math.min(MAX_RATIO, Math.max(MIN_RATIO, (e.clientX - rect.left) / rect.width))
      setRatio(next)
    },
    [dragging]
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.releasePointerCapture(e.pointerId)
      setDragging(false)
      saveRatio(unit.key, ratio)
    },
    [ratio, unit.key]
  )

  const pane = (m: TerminalInfo, style?: React.CSSProperties): React.JSX.Element => (
    <section key={m.id} className={`pane${unit.focusId === m.id && isPair(unit) ? ' pane-focused' : ''}`} style={style}>
      <header className="pane-header">
        <span className="pane-label">{m.kind === 'claude' ? 'Claude Code' : m.title === 'shell' && isPair(unit) ? 'Shell' : m.title}</span>
        {/* A shell's last command knows where it ran; that beats where the shell started. */}
        <span className="pane-path">{shortPath(latest[m.id]?.cwd ?? m.cwd)}</span>
        {m.kind === 'shell' && (
          <CommandStatus latest={latest[m.id]} {...(isPair(unit) ? { onSend: () => onSend(unit) } : {})} />
        )}
      </header>
      <div className="pane-body">
        <TerminalView
          key={`${m.id}:${unit.generations[m.id] ?? 0}`}
          id={m.id}
          visible={visible}
          focused={unit.focusId === m.id}
          onFocus={onFocus}
        />
      </div>
    </section>
  )

  const [left, right] = unit.members
  return (
    <div className={`unit${dragging ? ' unit-dragging' : ''}`} ref={rowRef} hidden={!visible}>
      {left && right ? (
        <>
          {pane(left, { flexBasis: `${ratio * 100}%` })}
          <div
            className="divider"
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={Math.round(ratio * 100)}
            title="Drag to resize · double-click to reset"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={() => {
              setRatio(0.5)
              saveRatio(unit.key, 0.5)
            }}
          />
          {pane(right, { flexBasis: `${(1 - ratio) * 100}%` })}
        </>
      ) : (
        left && pane(left, { flexBasis: '100%' })
      )}
    </div>
  )
}

export function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p || '/'
}
