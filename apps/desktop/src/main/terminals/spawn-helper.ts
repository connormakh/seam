import { accessSync, chmodSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * node-pty's macOS prebuilds ship `spawn-helper` without the executable
 * bit, and node-pty's own install scripts never set it. Without it every
 * pty spawn fails with "posix_spawnp failed". Returns the helpers it fixed.
 */
export function ensureSpawnHelpersExecutable(nodePtyDir: string): string[] {
  const candidates: string[] = [join(nodePtyDir, 'build', 'Release', 'spawn-helper')]
  const prebuilds = join(nodePtyDir, 'prebuilds')
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds)) candidates.push(join(prebuilds, entry, 'spawn-helper'))
  }

  const fixed: string[] = []
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      accessSync(file, constants.X_OK)
    } catch {
      try {
        chmodSync(file, statSync(file).mode | 0o755)
        fixed.push(file)
      } catch {
        // Read-only location (e.g. inside a signed app): packaging must fix it.
      }
    }
  }
  return fixed
}
