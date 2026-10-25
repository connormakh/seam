import { randomBytes } from 'node:crypto'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** Short, tmux-safe terminal id, e.g. "t-k3v9q2m8xa". */
export function newTerminalId(): string {
  const bytes = randomBytes(10)
  let out = 't-'
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}
