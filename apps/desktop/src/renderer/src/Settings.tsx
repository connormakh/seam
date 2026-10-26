import { useEffect, useState } from 'react'
import type { AppInfo, PolicyMode, SeamSettingsView } from '@shared/ipc'

interface Props {
  info: AppInfo | null
  onClose(): void
}

const MODES: { value: PolicyMode; label: string; what: string }[] = [
  { value: 'allow', label: 'Run freely', what: 'Claude types into the shell like you do.' },
  { value: 'ask', label: 'Ask first', what: 'A card on the shell before anything is typed.' },
  { value: 'allowlist', label: 'Allowlist only', what: 'Only commands starting with a listed prefix run unasked.' },
  { value: 'readonly', label: 'Read only', what: 'Claude can read the shells and run nothing.' }
]

/**
 * Everything Seam remembers, in one place.
 *
 * It writes the same file that can be edited by hand, and shows the version
 * of what Seam is driving, because "which claude, which tmux" is the first
 * question when something behaves oddly.
 */
export function Settings({ info, onClose }: Props): React.JSX.Element {
  const [settings, setSettings] = useState<SeamSettingsView | null>(null)
  const [prefixes, setPrefixes] = useState('')

  useEffect(() => {
    void window.seam.settings.get().then((s) => {
      setSettings(s)
      setPrefixes(s.policy.allowPrefixes.join('\n'))
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = (patch: Partial<SeamSettingsView>): void => {
    void window.seam.settings.set(patch).then((s) => setSettings(s))
  }

  return (
    <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label="Settings" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <header className="settings-header">
          <h2>Settings</h2>
          <button className="activity-close" onClick={onClose} title="Close (Esc)" aria-label="Close settings">
            ×
          </button>
        </header>

        {settings === null ? (
          <p className="settings-note">Loading…</p>
        ) : (
          <div className="settings-body">
            <section className="settings-group">
              <label className="settings-row">
                <input
                  type="checkbox"
                  checked={settings.shellOnly}
                  onChange={(e) => save({ shellOnly: e.currentTarget.checked })}
                />
                <span>
                  <strong>Run Claude&apos;s commands in the shell</strong>
                  <em>
                    Takes Claude&apos;s own Bash away, so everything it runs lands in the terminal you are watching.
                    Takes effect for pairs opened after this.
                  </em>
                </span>
              </label>
            </section>

            <section className="settings-group">
              <h3>What Claude may run</h3>
              <p className="settings-note">The default. A project can be set differently from the Activity panel.</p>
              {MODES.map((m) => (
                <label className="settings-row" key={m.value}>
                  <input
                    type="radio"
                    name="policy"
                    checked={settings.policy.mode === m.value}
                    onChange={() => save({ policy: { ...settings.policy, mode: m.value } })}
                  />
                  <span>
                    <strong>{m.label}</strong>
                    <em>{m.what}</em>
                  </span>
                </label>
              ))}
              <label className="settings-field">
                <span>Allowlisted prefixes, one per line</span>
                <textarea
                  rows={4}
                  value={prefixes}
                  placeholder={'git status\nnpm test'}
                  onChange={(e) => setPrefixes(e.currentTarget.value)}
                  onBlur={() =>
                    save({
                      policy: {
                        ...settings.policy,
                        allowPrefixes: prefixes
                          .split('\n')
                          .map((l) => l.trim())
                          .filter(Boolean)
                      }
                    })
                  }
                />
              </label>
              <p className="settings-note">
                A prefix only ever matches one simple command. Anything with <code>;</code>, <code>&amp;&amp;</code>,
                a pipe or a redirect is always asked about, and so are the destructive few.
              </p>
            </section>

            <section className="settings-group">
              <h3>What Seam is driving</h3>
              <dl className="settings-facts">
                <dt>Claude Code</dt>
                <dd className={info?.claude.ok === false ? 'settings-bad' : ''}>
                  {info?.claude.found ? (info.claude.version ?? 'installed') : 'not found'}
                </dd>
                <dt>tmux</dt>
                <dd className={info?.tmux ? '' : 'settings-bad'}>{info?.tmux ?? 'not found'}</dd>
                <dt>Seam</dt>
                <dd>
                  {info?.version} · Electron {info?.electron}
                </dd>
              </dl>
              {info?.claude.problem && <p className="settings-note settings-bad">{info.claude.problem}</p>}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
