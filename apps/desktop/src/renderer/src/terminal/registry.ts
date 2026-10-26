import type { Terminal } from '@xterm/xterm'

/**
 * The live xterm instances, by terminal id.
 *
 * Copy and Select All arrive from the application menu and mean "the pane
 * you are looking at", but only the xterm instance in that pane knows what
 * is selected in it. Views register themselves here while mounted so the
 * window's command handler can reach the right one.
 */
const live = new Map<string, Terminal>()

export function registerTerminal(id: string, term: Terminal): () => void {
  live.set(id, term)
  return () => {
    if (live.get(id) === term) live.delete(id)
  }
}

export function liveTerminal(id: string | null | undefined): Terminal | undefined {
  return id ? live.get(id) : undefined
}
