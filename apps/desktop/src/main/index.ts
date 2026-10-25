import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { registerIpc } from './ipc'
import { installMenu } from './menu'
import { attachSmokeTest } from './smoke'
import { createRuntime, type Runtime } from './runtime'

let mainWindow: BrowserWindow | null = null
let runtime: Runtime | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Seam',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#16181d',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())
  attachSmokeTest(win)

  // Links open in the user's browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  // A reload or a closed window leaves no view behind; drop the clients so
  // the renderer can attach again cleanly. Terminals keep running.
  win.webContents.on('did-start-loading', () => runtime?.terminals?.detachAll())
  win.on('closed', () => {
    runtime?.terminals?.detachAll()
    if (mainWindow === win) mainWindow = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

void app.whenReady().then(async () => {
  runtime = await createRuntime({
    userDataDir: app.getPath('userData'),
    homeDir: app.getPath('home'),
    isPackaged: app.isPackaged,
    resourcesDir: process.resourcesPath,
    send: (channel, payload) => mainWindow?.webContents.send(channel, payload)
  })
  registerIpc(runtime, { homeDir: app.getPath('home') })
  installMenu(() => mainWindow, {
    isDev: !app.isPackaged,
    settings: {
      shellOnly: () => runtime?.settings.shellOnly() ?? false,
      setShellOnly: (value) => runtime?.settings.setShellOnly(value)
    }
  })
  mainWindow = createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('before-quit', () => runtime?.terminals?.detachAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
