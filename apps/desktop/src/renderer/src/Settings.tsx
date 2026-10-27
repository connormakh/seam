import { useEffect, useRef, useState } from 'react'
import type { AppInfo, PolicyMode, SeamSettingsView, ThemeName } from '@shared/ipc'
import { firstFocusable, focusWhenReady, trapTab } from './focus'
import { THEMES, THEME_NAMES } from './terminal/themes'

interface Props {
  info: AppInfo | null
  theme: ThemeName
  /** Applied as you click, so the choice is visible before it is saved. */
  onTheme(theme: ThemeName): void
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
export function Settings({ info, theme, onTheme, onClose }: Props): React.JSX.Element {
  const [settings, setSettings] = useState<SeamSettingsView | null>(null)
  const [prefixes, setPrefixes] = useState('')
  const dialog = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.seam.settings.get().then((s) => {
      setSettings(s)
      setPrefixes(s.policy.allowPrefixes.join('\n'))
    })
  }, [])

  // The dialog takes the keyboard when it opens, so Escape and Tab below
  // have something to act on. Listening on the window instead would make
  // Escape in a pane close the dialog, and Escape belongs to Claude's TUI
  // and to vim.
  //
  // Twice: once on the empty dialog, which has nothing to focus but itself,
  // and again when the settings arrive and the controls exist.
  const loaded = settings !== null
  useEffect(() => {
    // The body, not the header: the first thing in the dialog is the close
    // button, and landing on that makes Enter shut what was just opened.
    focusWhenReady(() => firstFocusable(body.current) ?? dialog.current)
  }, [loaded])

  const save = (patch: Partial<SeamSettingsView>): void => {
    void window.seam.settings.set(patch).then((s) => setSettings(s))
  }

  return (
    <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label="Settings" onClick={onClose}>
      <div
        className="settings"
        ref={dialog}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          } else if (e.key === 'Tab') trapTab(e, dialog.current)
        }}
      >
        <header className="settings-header">
          <h2>Settings</h2>
          <button className="activity-close" onClick={onClose} title="Close (Esc)" aria-label="Close settings">
            ×
          </button>
        </header>

        {settings === null ? (
          <p className="settings-note">Loading…</p>
        ) : (
          <div className="settings-body" ref={body}>
            <section className="settings-group">
              <h3>Appearance</h3>
              <div className="theme-grid">
                {THEME_NAMES.map((name) => {
                  const t = THEMES[name]
                  return (
                    <button
                      key={name}
                      className={`theme-card${theme === name ? ' theme-card-on' : ''}`}
                      onClick={() => {
                        // Painted straight away, saved straight away: there is
                        // no apply button, so these must not drift apart.
                        onTheme(name)
                        save({ theme: name })
                      }}
                    >
                      <span className="theme-swatch" style={{ background: t.ui.bg, borderColor: t.ui.border }}>
                        <i style={{ background: t.ui.accent }} />
                        <i style={{ background: t.terminal.green }} />
                        <i style={{ background: t.ui.danger }} />
                        <i style={{ background: t.ui.text }} />
                      </span>
                      {t.name}
                    </button>
                  )
                })}
              </div>
            </section>

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
