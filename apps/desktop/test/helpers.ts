import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTmuxBinary } from '../src/main/tmux/binary'
import { TMUX_CONFIG } from '../src/main/tmux/config'
import { Tmux } from '../src/main/tmux/tmux'

/** A Tmux bound to a throwaway server so tests never touch a real one. */
export function makeTestTmux(): { tmux: Tmux; dir: string } {
  const binary = resolveTmuxBinary({ override: process.env['SEAM_TMUX'], path: process.env['PATH'] })
  if (!binary) throw new Error('tmux not found; install tmux to run integration tests')
  const dir = mkdtempSync(join(tmpdir(), 'seam-test-'))
  const configPath = join(dir, 'tmux.conf')
  writeFileSync(configPath, TMUX_CONFIG)
  return { tmux: new Tmux({ binary, socketPath: join(dir, 'tmux.sock'), configPath }), dir }
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
