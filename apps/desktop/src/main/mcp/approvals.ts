import { randomUUID } from 'node:crypto'
import type { ApprovalRequest, ApprovalDecision } from '@shared/ipc'

/**
 * The approval card's half of the conversation.
 *
 * A write tool calls `ask`, which parks the tool call until the user answers
 * on the shell's own pane or the request times out. Nothing is typed into a
 * shell until that promise resolves, so an unanswered card is a refusal that
 * happens to be slow.
 */

export interface ApprovalOptions {
  /** Show the card. The renderer answers through `resolve`. */
  present: (request: ApprovalRequest) => void
  /** Take the card down again, however it ended. */
  dismiss: (id: string) => void
  /** How long a card waits before refusing on its own. */
  timeoutMs?: number
}

export interface Granted {
  approved: boolean
  /** The user chose "approve similar", so this prefix is free for the session. */
  remember: string | null
  why: string
}

interface Pending {
  request: ApprovalRequest
  settle: (granted: Granted) => void
  timer: NodeJS.Timeout
}

/** Long enough to walk back to the keyboard, short enough that Claude is not stuck. */
const DEFAULT_TIMEOUT = 2 * 60 * 1000

export class Approvals {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly o: ApprovalOptions) {}

  /** What is on screen now, so a reopened tab can show its card again. */
  open(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request)
  }

  ask(request: Omit<ApprovalRequest, 'id' | 'askedAt'>): Promise<Granted> {
    const id = randomUUID()
    const full: ApprovalRequest = { ...request, id, askedAt: Date.now() }
    return new Promise<Granted>((resolve) => {
      const settle = (granted: Granted): void => {
        const entry = this.pending.get(id)
        if (!entry) return
        clearTimeout(entry.timer)
        this.pending.delete(id)
        this.o.dismiss(id)
        resolve(granted)
      }
      const timer = setTimeout(
        () => settle({ approved: false, remember: null, why: 'nobody answered the approval card' }),
        this.o.timeoutMs ?? DEFAULT_TIMEOUT
      )
      // Unref so a forgotten card cannot keep the app from quitting.
      timer.unref?.()
      this.pending.set(id, { request: full, settle, timer })
      this.o.present(full)
    })
  }

  /** The user's answer, from the card on the shell's pane. */
  resolve(id: string, decision: ApprovalDecision): void {
    const entry = this.pending.get(id)
    if (!entry) return // already answered, or timed out
    if (decision === 'deny') {
      entry.settle({ approved: false, remember: null, why: 'you denied it' })
      return
    }
    entry.settle({
      approved: true,
      remember: decision === 'approve-similar' ? entry.request.similar : null,
      why: 'you approved it'
    })
  }

  /** Refuse everything waiting on a session, e.g. once its terminal has gone. */
  cancelSession(sessionId: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.request.sessionId === sessionId) {
        entry.settle({ approved: false, remember: null, why: 'the session ended' })
      }
    }
  }
}
