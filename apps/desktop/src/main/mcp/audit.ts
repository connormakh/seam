import type { AuditEntry } from '@shared/ipc'

/**
 * What Claude asked for and what happened to it.
 *
 * Every tool call that could change something lands here, approved or not,
 * so "what has it been doing in my shells" has an answer that does not
 * depend on anyone having watched the cards go by. It is in memory for now,
 * like the rest of Seam's state; the design doc's SQLite table is where this
 * goes when there is one.
 */
export interface AuditOptions {
  onAppend: (entry: AuditEntry) => void
  /** Entries kept before the oldest is dropped. */
  keep?: number
}

const DEFAULT_KEEP = 500

export class AuditLog {
  private readonly entries: AuditEntry[] = []
  private nextId = 1

  constructor(private readonly o: AuditOptions) {}

  append(entry: Omit<AuditEntry, 'id' | 'at'>): AuditEntry {
    const full: AuditEntry = { ...entry, id: this.nextId++, at: Date.now() }
    this.entries.push(full)
    const keep = this.o.keep ?? DEFAULT_KEEP
    if (this.entries.length > keep) this.entries.splice(0, this.entries.length - keep)
    this.o.onAppend(full)
    return full
  }

  /** Oldest first, as the panel reads them. */
  list(): AuditEntry[] {
    return [...this.entries]
  }
}
