import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { CreateTerminalOptions, TerminalSize } from '@shared/ipc'

/**
 * Checks for everything that crosses from the renderer into main. Anything
 * that reaches tmux or a pty goes through one of these first.
 */

export class InvalidInput extends Error {
  override name = 'InvalidInput'
}

const ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_DIMENSION = 1000
const MAX_TITLE = 200

export function asId(v: unknown): string {
  if (typeof v !== 'string' || !ID.test(v)) throw new InvalidInput('invalid terminal id')
  return v
}

export function asSize(v: unknown): TerminalSize {
  const s = v as Partial<TerminalSize> | null
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= MAX_DIMENSION
  if (!s || !ok(s.cols) || !ok(s.rows)) throw new InvalidInput('invalid size')
  return { cols: Math.floor(s.cols), rows: Math.floor(s.rows) }
}

/**
 * A title as Seam stores it: no control characters (a newline would split a
 * tmux listing line), no field separator, trimmed and bounded.
 */
export function cleanTitle(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f␟]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
}

/** An absolute path to a directory that exists; tmux would silently fall back to $HOME otherwise. */
export function asDirectory(v: unknown): string {
  if (typeof v !== 'string' || !isAbsolute(v)) throw new InvalidInput('cwd must be an absolute path')
  let isDir = false
  try {
    isDir = statSync(v).isDirectory()
  } catch {
    // fall through
  }
  if (!isDir) throw new InvalidInput(`not a directory: ${v}`)
  return v
}

export function asCreateOptions(v: unknown): CreateTerminalOptions {
  const o = (v ?? {}) as Record<string, unknown>
  const out: CreateTerminalOptions = {}
  if (o['kind'] === 'shell' || o['kind'] === 'claude') out.kind = o['kind']
  if (o['cwd'] !== undefined) out.cwd = asDirectory(o['cwd'])
  if (typeof o['title'] === 'string') {
    const title = cleanTitle(o['title'])
    if (title) out.title = title
  }
  return out
}
