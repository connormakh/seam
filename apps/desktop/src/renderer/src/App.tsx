import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc'

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.seam.appInfo().then(setInfo)
  }, [])

  return (
    <div className="app">
      <header className="titlebar">
        <span className="titlebar-name">Seam</span>
      </header>
      <main className="empty">
        <p>No terminals yet.</p>
        {info && (
          <p className="muted">
            v{info.version} · Electron {info.electron} · {info.platform}
          </p>
        )}
      </main>
    </div>
  )
}
