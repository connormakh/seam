import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTmuxBinary } from '../src/main/tmux/binary'
import { TMUX_CONFIG } from '../src/main/tmux/config'
import { Tmux } from '../src/main/tmux/tmux'

/**
 * A throwaway directory, with its path already resolved. macOS's $TMPDIR is
 * reached through a symlink (/var/folders -> /private/var/folders), and tmux
 * and the shells report resolved paths, so an unresolved one never compares
 * equal to what they say.
 */
export function makeTempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

/** A Tmux bound to a throwaway server so tests never touch a real one. */
export function makeTestTmux(): { tmux: Tmux; dir: string } {
  const binary = resolveTmuxBinary({ override: process.env['SEAM_TMUX'], path: process.env['PATH'] })
  if (!binary) throw new Error('tmux not found; install tmux to run integration tests')
  const dir = makeTempDir('seam-test-')
  const configPath = join(dir, 'tmux.conf')
  writeFileSync(configPath, TMUX_CONFIG)
  return { tmux: new Tmux({ binary, socketPath: join(dir, 'tmux.sock'), configPath }), dir }
}

/** Whether a shell is installed, for the suites that drive a real one. */
export const hasShell = (shell: string): boolean => {
  try {
    execFileSync('which', [shell])
    return true
  } catch {
    return false
  }
}

/** The absolute path of a shell. */
export const shellPath = (shell: string): string => execFileSync('which', [shell], { encoding: 'utf8' }).trim()

/**
 * Whether the shell reports the time a command started and ended.
 * $EPOCHREALTIME comes from zsh/datetime in zsh and from bash 5.0; macOS ships
 * bash 3.2, where Seam leaves the field empty and falls back to arrival time.
 */
export const reportsTime = (shell: string): boolean => {
  if (shell !== 'bash') return true
  return Number(execFileSync('bash', ['-c', 'echo "${BASH_VERSINFO[0]}"'], { encoding: 'utf8' }).trim()) >= 5
}

/** Poll until `check` returns a truthy value or the timeout passes. */
export async function waitFor<T>(check: () => Promise<T | undefined | null | false>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined | null | false
  while (Date.now() < deadline) {
    last = await check()
    if (last) return last
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`waitFor timed out (last value: ${String(last)})`)
}
