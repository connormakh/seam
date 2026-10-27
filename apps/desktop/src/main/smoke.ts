import { writeFileSync } from 'node:fs'
import { app, Menu, type BrowserWindow } from 'electron'

/**
 * Headless smoke test hook. When SEAM_SMOKE_TEST is set, the app waits for
 * the renderer to settle, runs the given script in the page, prints the
 * result as one JSON line prefixed with SMOKE:, and quits. With
 * SEAM_SMOKE_SCREENSHOT set to a path, it also saves a PNG of the window.
 * SEAM_SMOKE_MENU is a comma-separated list of menu item ids to click
 * first, SEAM_SMOKE_MENU_DELAY_MS apart (600 ms by default), to exercise
 * the menu and its shortcuts.
 *
 * Used by scripts/smoke.sh under xvfb; never active in normal runs.
 */
export function attachSmokeTest(win: BrowserWindow): void {
  const script = process.env['SEAM_SMOKE_TEST']
  if (!script) return

  const delayMs = Number(process.env['SEAM_SMOKE_DELAY_MS'] ?? 1500)
  // Between menu clicks. A command that acts on what an earlier one created
  // needs long enough for that to have settled, or the test measures a race.
  const menuGapMs = Number(process.env['SEAM_SMOKE_MENU_DELAY_MS'] ?? 600)
  const screenshotPath = process.env['SEAM_SMOKE_SCREENSHOT']

  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void (async () => {
        let line: string
        try {
          for (const id of (process.env['SEAM_SMOKE_MENU'] ?? '').split(',').filter(Boolean)) {
            const item = Menu.getApplicationMenu()?.getMenuItemById(id)
            if (!item) throw new Error(`no menu item ${id}`)
            item.click()
            await new Promise((r) => setTimeout(r, menuGapMs))
          }
          const result: unknown = await win.webContents.executeJavaScript(script)
          line = JSON.stringify({ ok: true, result })
        } catch (err) {
          line = JSON.stringify({ ok: false, error: String(err) })
        }
        if (screenshotPath) {
          const image = await win.webContents.capturePage()
          writeFileSync(screenshotPath, image.toPNG())
        }
        process.stdout.write(`SMOKE:${line}\n`)
        app.exit(0)
      })()
    }, delayMs)
  })
}
