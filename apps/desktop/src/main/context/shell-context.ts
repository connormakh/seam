import type { CommandRecord } from '../shell/command-tracker'

/**
 * Secrets that commonly end up in terminal output. Masking is best-effort:
 * it catches the usual shapes, not everything, which is why Seam also
 * offers private shells (later) and never sends anything on its own.
 */
const SECRET_PATTERNS: Array<{ re: RegExp; keep?: number }> = [
  // -----BEGIN ... PRIVATE KEY----- blocks
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // Provider tokens with recognisable prefixes
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { re: /\bgithub_pat_[A-Za-z0-9_]{30,}/g },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Authorization: Bearer <token>
  { re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, keep: 1 },
  // KEY=value / key: value where the name says secret
  {
    re: /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*\s*[=:]\s*["']?)[^\s"']{4,}/gi,
    keep: 1
  },
  // URLs with credentials: scheme://user:pass@host
  { re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi, keep: 2 }
]

export const MASK = '[masked]'

export function maskSecrets(text: string): { text: string; masked: number } {
  let masked = 0
  let out = text
  for (const { re, keep } of SECRET_PATTERNS) {
    out = out.replace(re, (...args: unknown[]) => {
      masked++
      if (!keep) return MASK
      const groups = args.slice(1, 1 + keep) as string[]
      // Keep the label (and a trailing "@" for URLs), drop the secret.
      return keep === 2 ? `${groups[0]}${MASK}${groups[1]}` : `${groups[0]}${MASK}`
    })
  }
  return { text: out, masked }
}

export interface ShellContextOptions {
  /** How the shell is named to Claude, e.g. "shell" or "tests". */
  shellName: string
  homeDir: string
  maxLines?: number
  maxBytes?: number
  /** Where the complete output was saved, when the payload holds only part of it. */
  fullOutputPath?: string | null
  mask?: boolean
}

export interface ShellContext {
  text: string
  /** True when the payload holds only the tail of the output. */
  truncated: boolean
  /** How many secrets were masked. */
  masked: number
  /** Lines of output in the payload. */
  lines: number
}

function attr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function tildify(path: string, home: string): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/**
 * The block Seam hands to Claude for one command: what ran, where, how it
 * ended, and its output (the tail, if long), wrapped in a tag so Claude can
 * tell it apart from the user's own words.
 */
export function formatShellContext(r: CommandRecord, o: ShellContextOptions): ShellContext {
  const maxLines = o.maxLines ?? 200
  const maxBytes = o.maxBytes ?? 16 * 1024
  const mask = o.mask ?? true

  let lines = r.output === null ? [] : r.output === '' ? [] : r.output.split('\n')
  const totalLines = lines.length + r.droppedLines
  let truncated = r.droppedLines > 0
  if (lines.length > maxLines) {
    lines = lines.slice(-maxLines)
    truncated = true
  }
  let body = lines.join('\n')
  while (Buffer.byteLength(body) > maxBytes && lines.length > 1) {
    lines = lines.slice(Math.ceil(lines.length / 10))
    body = lines.join('\n')
    truncated = true
  }
  if (Buffer.byteLength(body) > maxBytes) {
    body = body.slice(-maxBytes)
    truncated = true
  }

  let masked = 0
  let command = r.command
  if (mask) {
    const b = maskSecrets(body)
    const c = maskSecrets(command)
    body = b.text
    command = c.text
    masked = b.masked + c.masked
  }

  const attrs = [
    `shell="${attr(o.shellName)}"`,
    `cwd="${attr(tildify(r.cwd, o.homeDir))}"`,
    `exit="${r.exitCode ?? '?'}"`,
    ...(r.endedAt !== null ? [`duration="${duration(Math.max(0, r.endedAt - r.startedAt))}"`] : [])
  ]

  const out = [`<shell-context ${attrs.join(' ')}>`, `$ ${command}`]
  if (r.output === null) out.push('[output not available: the screen was cleared or the terminal closed]')
  else if (body) out.push(body)
  else out.push('[no output]')
  if (truncated) {
    const where = o.fullOutputPath ? `; full output: ${o.fullOutputPath}` : ''
    out.push(`[last ${lines.length} of ${totalLines} lines${where}]`)
  }
  if (masked) out.push(`[${masked} secret${masked === 1 ? '' : 's'} masked]`)
  out.push('</shell-context>')

  return { text: `${out.join('\n')}\n`, truncated, masked, lines: lines.length }
}
