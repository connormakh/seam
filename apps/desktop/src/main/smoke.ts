import { app, type BrowserWindow } from 'electron'

/**
 * Headless smoke test hook. When SEAM_SMOKE_TEST is set, the app waits for
 * the renderer to settle, runs the given script in the page, prints the
 * result as one JSON line prefixed with SMOKE:, and quits.
 *
 * Used by scripts/smoke.sh under xvfb; never active in normal runs.
 */
export function attachSmokeTest(win: BrowserWindow): void {
  const script = process.env['SEAM_SMOKE_TEST']
  if (!script) return

  const delayMs = Number(process.env['SEAM_SMOKE_DELAY_MS'] ?? 1500)
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      win.webContents
        .executeJavaScript(script)
        .then((result: unknown) => {
          process.stdout.write(`SMOKE:${JSON.stringify({ ok: true, result })}\n`)
        })
        .catch((err: unknown) => {
          process.stdout.write(`SMOKE:${JSON.stringify({ ok: false, error: String(err) })}\n`)
        })
        .finally(() => app.exit(0))
    }, delayMs)
  })
}
