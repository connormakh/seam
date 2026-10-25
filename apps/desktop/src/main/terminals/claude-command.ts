import { userInfo } from 'node:os'

/** The user's login shell, falling back to the macOS default. */
export function userShell(): string {
  const fromEnv = process.env['SHELL']
  if (fromEnv && /^\/[\w./+-]+$/.test(fromEnv)) return fromEnv
  try {
    const fromUser = userInfo().shell
    if (fromUser && /^\/[\w./+-]+$/.test(fromUser)) return fromUser
  } catch {
    // no passwd entry; use the default
  }
  return '/bin/zsh'
}

/**
 * argv for the Claude side of a pair.
 *
 * It runs through the user's login shell so `claude` is found wherever they
 * installed it (Homebrew, npm global, ~/.local/bin): apps launched from
 * Finder get a minimal PATH, but a login shell rebuilds the real one. The
 * logic itself runs in /bin/sh so it works whatever the login shell is
 * (zsh, bash or fish). When Claude Code exits, or is not installed, the
 * pane drops into a normal shell instead of disappearing.
 */
export function claudeCommand(shell: string = userShell(), claudeArgs: string[] = []): string[] {
  if (!/^\/[\w./+-]+$/.test(shell)) throw new Error(`unexpected shell path: ${shell}`)
  for (const a of claudeArgs) {
    if (!/^[\w./:=@+-]+$/.test(a)) throw new Error(`unsafe claude argument: ${a}`)
  }
  const args = claudeArgs.length ? ` ${claudeArgs.join(' ')}` : ''
  // Inside single quotes for the login shell, so only double quotes here.
  const script = [
    'if command -v claude >/dev/null 2>&1; then',
    `  claude${args};`,
    'else',
    '  printf "\\n  Claude Code (the claude command) is not on your PATH.\\n  Install it, then run claude in this pane.\\n\\n";',
    'fi;',
    `exec "${shell}" -l`
  ].join(' ')
  return [shell, '-l', '-c', `exec /bin/sh -c '${script}' seam-claude`]
}
