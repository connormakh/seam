// node-pty's macOS prebuilds ship spawn-helper without the executable bit,
// which makes every pty spawn fail with "posix_spawnp failed". Fix it after
// install so dev runs and packaged builds (which copy the file mode) work.
import { accessSync, chmodSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(join(process.cwd(), 'apps/desktop/package.json'))

let ptyDir
try {
  ptyDir = dirname(require.resolve('node-pty/package.json'))
} catch {
  process.exit(0) // node-pty not installed yet; nothing to do
}

const files = [join(ptyDir, 'build', 'Release', 'spawn-helper')]
const prebuilds = join(ptyDir, 'prebuilds')
if (existsSync(prebuilds)) for (const d of readdirSync(prebuilds)) files.push(join(prebuilds, d, 'spawn-helper'))

for (const file of files) {
  if (!existsSync(file)) continue
  try {
    accessSync(file, constants.X_OK)
  } catch {
    chmodSync(file, statSync(file).mode | 0o755)
    console.log(`made executable: ${file}`)
  }
}
