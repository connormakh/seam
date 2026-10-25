import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

export interface ResolveOptions {
  /** Explicit override, e.g. from SEAM_TMUX. */
  override?: string | undefined
  /** Directory holding a bundled tmux (packaged app resources). */
  bundledDir?: string | undefined
  /** PATH to search last. */
  path?: string | undefined
  /** Injected for tests. */
  isExecutable?: (file: string) => boolean
}

const WELL_KNOWN = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']

function defaultIsExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Find a tmux binary. Apps launched from Finder get a minimal PATH, so the
 * Homebrew locations are checked explicitly before falling back to PATH.
 */
export function resolveTmuxBinary(opts: ResolveOptions = {}): string | null {
  const isExec = opts.isExecutable ?? defaultIsExecutable
  const candidates: string[] = []
  if (opts.override) candidates.push(opts.override)
  if (opts.bundledDir) candidates.push(join(opts.bundledDir, 'tmux'))
  candidates.push(...WELL_KNOWN)
  for (const dir of (opts.path ?? '').split(delimiter)) {
    if (dir) candidates.push(join(dir, 'tmux'))
  }
  return candidates.find((c) => isExec(c)) ?? null
}
