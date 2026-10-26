import { execFile } from 'node:child_process'

/**
 * Is Claude Code there, and is it new enough?
 *
 * Asked once at startup rather than discovered when a pane opens and prints
 * a message into itself. Seam is a wrapper around a binary it does not ship,
 * so "which binary, and does it still have the flags I rely on" is a thing
 * the user should be told plainly rather than left to infer from a pane that
 * dropped to a shell.
 */

export interface ClaudeCheck {
  /** Found on the login shell's PATH. */
  found: boolean
  /** As reported by `claude --version`, or null when it could not be read. */
  version: string | null
  /** Found, readable, and at least MINIMUM. */
  ok: boolean
  /** Said to the user when it is not ok. */
  problem: string | null
}

/**
 * The oldest Claude Code Seam works with.
 *
 * Everything Seam does to a session is a launch flag or a hook: --mcp-config
 * and --settings for the two halves of Claude to shell, --disallowedTools for
 * the shared terminal, and hooks returning hookSpecificOutput.additionalContext
 * for auto sync. A Claude without those does not fail loudly; it just quietly
 * does none of it, which is worse.
 */
export const MINIMUM = '2.0.0'

/** -1, 0 or 1, comparing dotted numbers and ignoring whatever follows them. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => (v.match(/\d+/g) ?? []).map(Number)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

/** The first dotted number in `claude --version` output. */
export function parseVersion(output: string): string | null {
  return /(\d+\.\d+(?:\.\d+)?)/.exec(output)?.[1] ?? null
}

/**
 * Through the login shell, because that is how Seam starts Claude: a
 * Finder-launched app has barely any PATH, and asking any other way would
 * answer a question nobody asked.
 */
export async function checkClaude(shell: string, timeoutMs = 5000): Promise<ClaudeCheck> {
  const output = await new Promise<string | null>((resolve) => {
    const child = execFile(
      shell,
      ['-l', '-c', 'command -v claude >/dev/null 2>&1 && claude --version'],
      { timeout: timeoutMs, encoding: 'utf8' },
      (err, stdout) => resolve(err && !stdout ? null : stdout)
    )
    child.on('error', () => resolve(null))
  })

  const raw = output?.trim() ?? ''
  if (!raw) {
    return {
      found: false,
      version: null,
      ok: false,
      problem: 'Claude Code is not on your PATH. Seam runs the real `claude` binary; install it and restart Seam.'
    }
  }
  const version = parseVersion(raw)
  if (!version) {
    // It ran and said something unreadable: let it through rather than
    // refuse over a version string that changed shape.
    return { found: true, version: null, ok: true, problem: null }
  }
  if (compareVersions(version, MINIMUM) < 0) {
    return {
      found: true,
      version,
      ok: false,
      problem: `Claude Code ${version} is older than ${MINIMUM}, which is the oldest Seam can drive. Update it, or Seam's shell tools and auto sync will quietly do nothing.`
    }
  }
  return { found: true, version, ok: true, problem: null }
}
