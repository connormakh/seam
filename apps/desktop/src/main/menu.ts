import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { IPC, type MenuCommand } from '@shared/ipc'

/**
 * The application menu owns every app shortcut. Menu accelerators fire
 * before the page sees a key, so a shortcut must either be here or not
 * exist; Electron's default menu would make Cmd+W close the whole window.
 *
 * macOS uses Cmd. Elsewhere Ctrl+Shift, because plain Ctrl+W, Ctrl+T and
 * friends belong to the shell (Ctrl+W deletes a word).
 */
export interface MenuSettings {
  /** Current value, read when the menu is built. */
  shellOnly: () => boolean
  /** The user flipped it; takes effect on the next pair. */
  setShellOnly: (value: boolean) => void
}

export function installMenu(
  getWindow: () => BrowserWindow | null,
  opts: { isDev: boolean; settings?: MenuSettings }
): void {
  const mac = process.platform === 'darwin'
  const key = (k: string, extra = ''): string => (mac ? `Cmd+${extra}${k}` : `Ctrl+Shift+${extra}${k}`)
  const send = (command: MenuCommand): void => getWindow()?.webContents.send(IPC.menuCommand, command)

  const tabItems: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    id: `select-tab-${i + 1}`,
    label: `Tab ${i + 1}`,
    accelerator: mac ? `Cmd+${i + 1}` : `Alt+${i + 1}`,
    click: () => send({ type: 'select-tab', index: i })
  }))

  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              {
                id: 'open-settings',
                label: 'Settings…',
                accelerator: 'Cmd+,',
                click: () => send({ type: 'open-settings' })
              },
              { type: 'separator' },
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ] satisfies MenuItemConstructorOptions[]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          id: 'new-pair',
          label: 'New Claude + Shell Pair…',
          accelerator: key('T'),
          click: () => send({ type: 'new-pair' })
        },
        {
          // For a question that is not about a project: no folder to pick,
          // and nothing added to the workspace list afterwards.
          id: 'new-home-pair',
          label: 'New Session in Home',
          accelerator: mac ? 'Cmd+Shift+T' : 'Ctrl+Shift+Alt+T',
          click: () => send({ type: 'new-home-pair' })
        },
        {
          // A terminal on its own, with no Claude beside it.
          id: 'new-shell',
          label: 'New Shell',
          accelerator: mac ? 'Cmd+Ctrl+T' : 'Ctrl+Alt+T',
          click: () => send({ type: 'new-shell' })
        },
        { type: 'separator' },
        {
          id: 'close-tab',
          label: 'Close Tab (Keep Running)',
          accelerator: key('W'),
          click: () => send({ type: 'close-tab' })
        },
        {
          id: 'end-terminal',
          label: 'End Tab and Its Terminals',
          accelerator: mac ? 'Cmd+Shift+W' : 'Ctrl+Shift+Alt+W',
          click: () => send({ type: 'end-terminal' })
        },
        ...(mac ? [] : ([{ type: 'separator' }, { role: 'quit' }] satisfies MenuItemConstructorOptions[]))
      ]
    },
    {
      label: 'Shell',
      submenu: [
        {
          id: 'send-last',
          label: 'Send Last Command to Claude',
          accelerator: mac ? 'Cmd+Shift+Enter' : 'Ctrl+Shift+Enter',
          click: () => send({ type: 'send-last' })
        },
        {
          id: 'attach-last',
          label: 'Attach Last Command to Next Prompt',
          accelerator: mac ? 'Cmd+Alt+Enter' : 'Ctrl+Alt+Enter',
          click: () => send({ type: 'attach-last' })
        },
        {
          id: 'toggle-sidebar',
          label: 'Workspaces',
          accelerator: mac ? 'Cmd+Ctrl+S' : 'Ctrl+Shift+S',
          click: () => send({ type: 'toggle-sidebar' })
        },
        {
          // Showing the sidebar and getting into it are different wishes:
          // one is to read the status dots, the other to pick a session.
          id: 'focus-sidebar',
          label: 'Go to Workspaces',
          accelerator: mac ? 'Cmd+0' : 'Ctrl+Shift+0',
          click: () => send({ type: 'focus-sidebar' })
        },
        {
          id: 'toggle-activity',
          label: 'Activity',
          accelerator: key('A', 'Shift+'),
          click: () => send({ type: 'toggle-activity' })
        },
        { type: 'separator' },
        {
          id: 'shell-only',
          // Claude Code takes the flag at launch, so this cannot change a
          // session already running. The label says so rather than looking broken.
          label: 'Run Claude Commands in This Shell (New Pairs)',
          type: 'checkbox',
          checked: opts.settings?.shellOnly() ?? false,
          enabled: Boolean(opts.settings),
          click: (item) => opts.settings?.setShellOnly(item.checked)
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        {
          // Not the native role: a terminal's selection lives inside its
          // xterm instance, where the native copy cannot see it. The window
          // falls back to the native command for Seam's own text fields.
          id: 'copy',
          label: 'Copy',
          accelerator: 'CmdOrCtrl+C',
          click: () => send({ type: 'copy' })
        },
        { role: 'paste' },
        {
          // The native one would select the whole window, both panes and
          // the chrome around them.
          id: 'select-all',
          label: 'Select All',
          accelerator: 'CmdOrCtrl+A',
          click: () => send({ type: 'select-all' })
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          id: 'clear-screen',
          label: 'Clear Shell',
          accelerator: mac ? 'Cmd+K' : 'Ctrl+Shift+K',
          click: () => send({ type: 'clear-screen' })
        },
        { type: 'separator' },
        ...(opts.isDev
          ? ([{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] satisfies MenuItemConstructorOptions[])
          : []),
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      // Built by hand: the stock window menu also binds Cmd+W to close the window.
      submenu: [
        {
          id: 'toggle-focus',
          // Ctrl+` on every platform: one key to hop between Claude and the shell.
          label: 'Switch Between Claude and Shell',
          accelerator: 'Ctrl+`',
          click: () => send({ type: 'toggle-focus' })
        },
        // And by side, for anyone who would rather say where than alternate.
        // A pair is drawn Claude on the left, shell on the right.
        {
          id: 'focus-left',
          label: 'Focus Claude',
          accelerator: mac ? 'Cmd+[' : 'Ctrl+[',
          click: () => send({ type: 'focus-side', side: 'left' })
        },
        {
          id: 'focus-right',
          label: 'Focus Shell',
          accelerator: mac ? 'Cmd+]' : 'Ctrl+]',
          click: () => send({ type: 'focus-side', side: 'right' })
        },
        { type: 'separator' },
        {
          id: 'prev-tab',
          label: 'Previous Tab',
          accelerator: mac ? 'Cmd+Shift+[' : 'Ctrl+Shift+PageUp',
          click: () => send({ type: 'select-tab-relative', delta: -1 })
        },
        {
          id: 'next-tab',
          label: 'Next Tab',
          accelerator: mac ? 'Cmd+Shift+]' : 'Ctrl+Shift+PageDown',
          click: () => send({ type: 'select-tab-relative', delta: 1 })
        },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        ...tabItems,
        ...(mac ? ([{ type: 'separator' }, { role: 'front' }] satisfies MenuItemConstructorOptions[]) : [])
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
