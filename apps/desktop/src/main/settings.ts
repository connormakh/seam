import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_POLICY, type PolicyMode, type PolicySettings } from './mcp/policy'

/**
 * The few things Seam remembers between launches.
 *
 * A JSON file, not the design doc's SQLite: these are a handful of fields
 * that change when someone clicks a menu item, and a native module that has
 * to be rebuilt per Electron version is not worth carrying for them. The
 * database arrives with the session browser, which needs one for search.
 *
 * It is also the only way to reach a setting that has no UI yet, so it is
 * meant to be edited by hand, and a file edited by hand is a file that will
 * sometimes be wrong: every field is validated on the way in, and anything
 * unreadable falls back to the default rather than stopping the app.
 */

export interface SeamSettings {
  /** Claude runs its commands in the companion shell rather than its own Bash. */
  shellOnly: boolean
  policy: PolicySettings
  /** Claude sessions the user turned auto sync off for. */
  autoSyncOff: string[]
}

export const DEFAULTS: SeamSettings = {
  shellOnly: true,
  policy: DEFAULT_POLICY,
  autoSyncOff: []
}

const MODES: PolicyMode[] = ['allow', 'ask', 'allowlist', 'readonly']

function asStrings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : null
}

/** Take what is usable and leave the rest at its default. */
function parse(raw: unknown): SeamSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULTS }
  const o = raw as Record<string, unknown>
  const policyRaw = (o['policy'] as Record<string, unknown> | undefined) ?? {}
  const mode = MODES.includes(policyRaw['mode'] as PolicyMode) ? (policyRaw['mode'] as PolicyMode) : DEFAULTS.policy.mode
  return {
    shellOnly: typeof o['shellOnly'] === 'boolean' ? o['shellOnly'] : DEFAULTS.shellOnly,
    policy: { mode, allowPrefixes: asStrings(policyRaw['allowPrefixes']) ?? [] },
    autoSyncOff: asStrings(o['autoSyncOff']) ?? []
  }
}

export class SettingsStore {
  private current: SeamSettings

  constructor(private readonly file: string) {
    this.current = this.read()
  }

  get(): SeamSettings {
    return this.current
  }

  /** Change some of it and write the lot. Returns what the settings now are. */
  update(patch: Partial<SeamSettings>): SeamSettings {
    this.current = { ...this.current, ...patch }
    this.write()
    return this.current
  }

  private read(): SeamSettings {
    try {
      return parse(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      // Missing is the normal case on a first run; unreadable is someone's
      // half-finished edit. Neither is worth refusing to start over.
      return { ...DEFAULTS }
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      // Through a temporary file, so a crash mid-write cannot leave behind
      // a settings file that is neither the old one nor the new one.
      const temp = join(dirname(this.file), `.${Date.now().toString(36)}.settings.tmp`)
      writeFileSync(temp, `${JSON.stringify(this.current, null, 2)}\n`, { mode: 0o600 })
      renameSync(temp, this.file)
    } catch {
      // Nothing to do about a read-only home but carry on with the setting
      // applied for this run.
    }
  }
}
