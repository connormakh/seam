import { liveTerminal } from './terminal/registry'

/**
 * Moving the keyboard around Seam's own chrome.
 *
 * Shortcuts come from the menu, so a command can arrive in the same tick
 * that mounts the thing it is about: a panel asked to take the focus may
 * not be on the page yet. Everything here waits a few frames for its
 * target and then gives up, rather than focusing nothing or hunting for
 * ever.
 */

/** What Tab reaches, which is also what a panel hands the keyboard to first. */
export const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')

function whenReady<T>(pick: () => T | null | undefined, use: (value: T) => void, tries = 4): void {
  const attempt = (left: number): void => {
    const value = pick()
    if (value) {
      use(value)
      return
    }
    if (left > 0) requestAnimationFrame(() => attempt(left - 1))
  }
  attempt(tries)
}

export function focusWhenReady(pick: () => HTMLElement | null | undefined): void {
  whenReady(pick, (el) => el.focus())
}

export function firstFocusable(root: HTMLElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>(FOCUSABLE) ?? null
}

/** The pane the keyboard is in, or null when it is in Seam's own chrome. */
export function focusedTerminalId(): string | null {
  const host = document.activeElement?.closest('.terminal-host')
  return host instanceof HTMLElement ? (host.dataset.terminalId ?? null) : null
}

/** Hand the keyboard to a pane, waiting for its view if it is still mounting. */
export function focusPane(id: string | null | undefined): void {
  if (!id) return
  whenReady(
    () => liveTerminal(id),
    (term) => term.focus()
  )
}

/**
 * Keep Tab inside a dialog.
 *
 * A modal that lets Tab wander ends with the keyboard behind it, on a pane
 * the user cannot see the cursor in, and no way back but the mouse.
 */
export function trapTab(e: React.KeyboardEvent, root: HTMLElement | null): void {
  const stops = [...(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
  if (stops.length === 0) return
  const first = stops[0]
  const last = stops[stops.length - 1]
  const at = document.activeElement
  if (e.shiftKey && (at === first || !root?.contains(at))) {
    e.preventDefault()
    last?.focus()
  } else if (!e.shiftKey && at === last) {
    e.preventDefault()
    first?.focus()
  }
}
