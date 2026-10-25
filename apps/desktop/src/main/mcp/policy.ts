/**
 * What Claude is allowed to run in a shell, before anything is typed.
 *
 * The default is `allow`, because the shell is meant to be one terminal that
 * both the user and Claude work in; a card in front of every command would
 * make it Claude asking to borrow the user's terminal instead. What Claude
 * ran is answered after the fact, by the audit log and the marks beside each
 * command, rather than before it by a prompt.
 *
 * The denylist is the exception, and stays on under `allow`: a handful of
 * commands whose cost cannot be undone, which a working session never hits.
 * `ask` is there for anyone who wants the stricter thing back.
 */

export type PolicyMode = 'allow' | 'ask' | 'allowlist' | 'readonly'

export interface PolicySettings {
  mode: PolicyMode
  /** Commands starting with one of these run without asking, under `allowlist`. */
  allowPrefixes: string[]
}

export const DEFAULT_POLICY: PolicySettings = { mode: 'allow', allowPrefixes: [] }

export type Decision =
  | { verdict: 'allow'; why: string }
  | { verdict: 'ask'; why: string }
  | { verdict: 'deny'; why: string }

/**
 * Always worth a human look, whatever the policy says, including `allow`.
 * These are the cases where being wrong is unrecoverable, so a false ask
 * costs a click and a false allow costs something that cannot be got back.
 * Nothing in ordinary work matches them, so they do not interrupt anyone.
 */
const ALWAYS_ASK: { test: RegExp; why: string }[] = [
  // rm carrying both recursive and force, in either spelling or order.
  { test: /\brm\b(?=[^|;&]*\s-[a-z]*r)(?=[^|;&]*\s-[a-z]*f)/i, why: 'a recursive, forced delete' },
  { test: /\brm\b[^|;&]*--recursive[^|;&]*--force|\brm\b[^|;&]*--force[^|;&]*--recursive/i, why: 'a recursive, forced delete' },
  { test: /\bgit\b[^|;&]*\bpush\b[^|;&]*(--force\b|--force-with-lease\b|\s-f\b)/i, why: 'a force push' },
  { test: /(^|[\s|;&(])sudo\b/i, why: 'sudo' },
  { test: /\bdrop\s+(table|database|schema|index|view)\b/i, why: 'a SQL drop' },
  // Anything that could write into ~/.ssh, by redirect or by a copying verb.
  { test: /(>>?|\btee\b)\s*\S*\.ssh\//i, why: 'a write into ~/.ssh' },
  { test: /\b(cp|mv|ln|install|chmod|chown|rm)\b[^|;&]*\.ssh\b/i, why: 'a change to ~/.ssh' }
]

/**
 * Shell syntax that makes a command more than the prefix it starts with.
 * `git status && rm -rf ~` begins with an allowlisted `git status`, so no
 * command carrying any of this can be matched by prefix at all. Redirects
 * count: an allowlisted `ls` is a read, `ls > ~/.ssh/authorized_keys` is not.
 */
const COMPOUND = /[;&|`<>\n\r]|\$\(/

/** True when a command is a single simple command, safe to match by prefix. */
export function isSimpleCommand(command: string): boolean {
  return !COMPOUND.test(command)
}

/**
 * What "approve similar for this session" remembers. The design doc left the
 * choice open between the whole command, its first word, and the prefix up
 * to the first argument; this is the last, because the first makes the
 * button pointless and the second turns one approved `git status` into a
 * standing permission for `git reset --hard`.
 *
 * So the verb plus its subcommand when there is one: `git status --short`
 * becomes `git status`, `ls -la /tmp` becomes `ls`.
 */
export function similarPrefix(command: string): string {
  const words = command.trim().split(/\s+/)
  const [verb, next] = words
  if (!verb) return ''
  // A second bare word is a subcommand (git status); a flag or a path is an argument.
  if (next && /^[a-z][\w-]*$/i.test(next)) return `${verb} ${next}`
  return verb
}

function matchesPrefix(command: string, prefix: string): boolean {
  const clean = prefix.trim()
  if (!clean) return false
  if (command === clean) return true
  // A prefix must end at a word boundary: "git s" must not match "git status".
  return command.startsWith(`${clean} `)
}

/**
 * Decide what happens to a command Claude wants to run.
 *
 * `sessionAllowed` is what the user already approved for this session with
 * "approve similar"; it never overrides the denylist.
 */
export function decide(
  command: string,
  settings: PolicySettings,
  sessionAllowed: readonly string[] = []
): Decision {
  const trimmed = command.trim()
  if (!trimmed) return { verdict: 'deny', why: 'empty command' }

  if (settings.mode === 'readonly') {
    return { verdict: 'deny', why: 'this workspace is read-only: Claude can read shells but not run anything' }
  }

  const dangerous = ALWAYS_ASK.find((rule) => rule.test.test(trimmed))
  if (dangerous) return { verdict: 'ask', why: `${dangerous.why}, which always needs a look` }

  // The shared terminal: Claude types into it like the user does.
  if (settings.mode === 'allow') return { verdict: 'allow', why: 'this shell is shared with Claude' }

  // Only a single simple command can be judged by its prefix.
  if (isSimpleCommand(trimmed)) {
    if (sessionAllowed.some((p) => matchesPrefix(trimmed, p))) {
      return { verdict: 'allow', why: 'approved earlier in this session' }
    }
    if (settings.mode === 'allowlist' && settings.allowPrefixes.some((p) => matchesPrefix(trimmed, p))) {
      return { verdict: 'allow', why: 'on this workspace’s allowlist' }
    }
  }

  return { verdict: 'ask', why: 'this workspace asks before Claude runs anything' }
}
