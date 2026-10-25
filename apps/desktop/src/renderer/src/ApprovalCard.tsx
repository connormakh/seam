import { useEffect, useRef } from 'react'
import type { ApprovalDecision, ApprovalRequest } from '@shared/ipc'

interface Props {
  request: ApprovalRequest
  onDecide(id: string, decision: ApprovalDecision): void
}

/**
 * Claude asking to touch this shell, on the pane where it would happen.
 *
 * It shows the command exactly as it would be typed, never shortened: the
 * whole point is that the user reads what they are agreeing to, and an
 * ellipsis in the middle of a command is where something hides.
 */
export function ApprovalCard({ request, onDecide }: Props): React.JSX.Element {
  const denyRef = useRef<HTMLButtonElement>(null)

  // Deny takes focus, so a stray Return does nothing and Escape is a refusal.
  useEffect(() => {
    denyRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onDecide(request.id, 'deny')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request.id, onDecide])

  const verb = request.tool === 'send_keys' ? 'send these keys to' : 'run this in'

  return (
    <div className="approval-backdrop" role="dialog" aria-modal="true" aria-label="Claude wants to use this shell">
      <div className="approval-card">
        <p className="approval-lead">
          Claude wants to {verb} <strong>{request.shellTitle}</strong>.
        </p>
        <pre className="approval-command">{request.command}</pre>
        <p className="approval-why">{request.why}</p>
        <div className="approval-actions">
          <button ref={denyRef} className="approval-deny" onClick={() => onDecide(request.id, 'deny')}>
            Deny
          </button>
          <button className="approval-approve" onClick={() => onDecide(request.id, 'approve')}>
            Approve once
          </button>
          {request.tool === 'run_in_shell' && (
            <button
              className="approval-similar"
              title={`Runs anything starting with "${request.similar}" without asking, until this Claude session ends`}
              onClick={() => onDecide(request.id, 'approve-similar')}
            >
              Approve <code>{request.similar}</code> this session
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
