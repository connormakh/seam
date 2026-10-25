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
 *
 * `set -m` matters more than it looks. Without job control, /bin/sh runs
 * claude in the shell's own process group, so the pane's foreground process
 * group leader is /bin/sh and tmux reports `pane_current_command` as the
 * shell. Seam reads that to tell a running Claude from a bare prompt it must
 * not paste into, so every send was refused. With it, claude leads its own
 * foreground group, exactly as if the user had typed `claude` at a prompt.
 */
/**
 * Flags that make the companion shell the only way Claude can run anything.
 *
 * Taking Bash away is what does it: with no shell tool of its own, Claude
 * reaches for seam's run_in_shell, which types into the terminal the user is
 * watching and keeps whatever that shell is holding. The sentence is there so
 * it knows which shell without having to look first, and so it says what it
 * is about to run before a card appears.
 *
 * No apostrophes or dollars in the prompt: it is quoted into a /bin/sh -c.
 */
export function shellOnlyArgs(shellName: string): string[] {
  return [
    '--disallowedTools',
    'Bash',
    '--append-system-prompt',
    `Seam: your Bash tool is off in this session. Run shell commands with the seam MCP tool run_in_shell, on the shell named ${shellName}. That is a terminal the user is watching, and it keeps its state between commands: running servers, activated environments, exported variables. The user may be asked to approve each command, so say what you are about to run before you run it.`
  ]
}

export function claudeCommand(shell: string = userShell(), claudeArgs: string[] = []): string[] {
  if (!/^\/[\w./+-]+$/.test(shell)) throw new Error(`unexpected shell path: ${shell}`)
  // Arguments carry paths now (--mcp-config), and on macOS those contain
  // spaces: "Application Support". So they are double-quoted below, and what
  // is rejected is whatever would end the quoting or run something inside it.
  for (const a of claudeArgs) {
    if (!a || /["'`$\\\n\r]/.test(a)) throw new Error(`unsafe claude argument: ${a}`)
  }
  const args = claudeArgs.length ? ` ${claudeArgs.map((a) => `"${a}"`).join(' ')}` : ''
  // Inside single quotes for the login shell, so only double quotes here.
  const script = [
    'set -m;',
    'if command -v claude >/dev/null 2>&1; then',
    `  claude${args};`,
    'else',
    '  printf "\\n  Claude Code (the claude command) is not on your PATH.\\n  Install it, then run claude in this pane.\\n\\n";',
    'fi;',
    `exec "${shell}" -l`
  ].join(' ')
  return [shell, '-l', '-c', `exec /bin/sh -c '${script}' seam-claude`]
}
