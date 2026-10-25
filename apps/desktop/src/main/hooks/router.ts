import type { SessionState, SessionStatus } from '@shared/ipc'
import type { Caller } from '../control/server'
import type { AutoSync } from './auto-sync'

/**
 * Every hook event arrives here.
 *
 * Two jobs. It keeps what each Claude session is doing, so a tab that is not
 * in front can still say whether it is working or waiting on an answer; and
 * at the start of a turn it hands over whatever the session should be told,
 * which is anything the user attached plus the shell activity auto sync has
 * not mentioned yet.
 */

export interface HookRouterOptions {
  autoSync: AutoSync
  /** The shells this session may reach, for the line it gets at the start. */
  shellNames: (caller: Caller) => Promise<string[]>
  onStatus: (status: SessionStatus) => void
  onAttachChanged: (sessionId: string, queued: number) => void
}

/** How long a preview of Claude's last message is worth keeping. */
const PREVIEW = 200

export class HookRouter {
  private readonly statuses = new Map<string, SessionStatus>()
  private readonly attached = new Map<string, string[]>()

  constructor(private readonly o: HookRouterOptions) {}

  statusList(): SessionStatus[] {
    return [...this.statuses.values()]
  }

  queued(sessionId: string): number {
    return this.attached.get(sessionId)?.length ?? 0
  }

  /** Hold this until the session's next prompt, then hand it over. */
  attach(sessionId: string, text: string): number {
    const queue = this.attached.get(sessionId) ?? []
    queue.push(text)
    this.attached.set(sessionId, queue)
    this.o.onAttachChanged(sessionId, queue.length)
    return queue.length
  }

  clearAttached(sessionId: string): void {
    this.attached.delete(sessionId)
    this.o.onAttachChanged(sessionId, 0)
  }

  /** The user has looked at this session, so it is no longer unseen. */
  seen(sessionId: string): void {
    const status = this.statuses.get(sessionId)
    if (!status || !status.unseen) return
    this.set(sessionId, status.state, { unseen: false, preview: status.preview })
  }

  forget(sessionId: string): void {
    this.statuses.delete(sessionId)
    this.attached.delete(sessionId)
  }

  /**
   * One hook event. Returns what to put in front of Claude, if anything.
   *
   * Subagents are ignored throughout: `Stop` fires for them too, and a
   * subagent finishing is not the pair's turn ending.
   */
  async handle(caller: Caller, event: Record<string, unknown>): Promise<{ additionalContext?: string }> {
    if (event['agent_id']) return {}
    const id = caller.sessionId
    const name = String(event['hook_event_name'] ?? '')

    switch (name) {
      case 'SessionStart': {
        this.set(id, 'idle', { unseen: false, preview: null })
        const names = await this.o.shellNames(caller)
        if (names.length === 0) return {}
        return {
          additionalContext:
            `Seam: this session shares a terminal with the user. The shells you can reach are ` +
            `${names.map((n) => `"${n}"`).join(', ')}. What they run there is reported to you as it happens.`
        }
      }
      case 'UserPromptSubmit': {
        this.set(id, 'working', { unseen: false, preview: null })
        // Attached context first: the user chose it, so it leads.
        const parts = this.attached.get(id) ?? []
        if (parts.length > 0) this.clearAttached(id)
        const digest = await this.o.autoSync.digest(caller)
        if (digest) parts.push(digest)
        return parts.length > 0 ? { additionalContext: parts.join('\n\n') } : {}
      }
      case 'PostToolUse': {
        const digest = await this.o.autoSync.digest(caller)
        return digest ? { additionalContext: digest } : {}
      }
      case 'Notification':
      case 'PermissionRequest':
        // Claude has asked something and nothing moves until the user looks.
        this.set(id, 'waiting', { unseen: true, preview: this.statuses.get(id)?.preview ?? null })
        return {}
      case 'Stop': {
        // last_assistant_message, because the transcript file lags behind it.
        const message = event['last_assistant_message']
        const preview = typeof message === 'string' ? message.slice(0, PREVIEW).trim() : null
        this.set(id, 'idle', { unseen: true, preview })
        return {}
      }
      case 'SessionEnd':
        this.forget(id)
        return {}
      default:
        return {}
    }
  }

  private set(sessionId: string, state: SessionState, o: { unseen: boolean; preview: string | null }): void {
    const status: SessionStatus = { sessionId, state, preview: o.preview, unseen: o.unseen, changedAt: Date.now() }
    this.statuses.set(sessionId, status)
    this.o.onStatus(status)
  }
}
