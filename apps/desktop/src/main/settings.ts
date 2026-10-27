import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ThemeName, Workspace } from '@shared/ipc'
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
  /** Which colours the window and its terminals use. */
  theme: ThemeName
  /** Claude runs its commands in the companion shell rather than its own Bash. */
  shellOnly: boolean
  /** The default, for any workspace without one of its own. */
  policy: PolicySettings
  /** Per workspace root, which is what Seam has instead of a workspace table. */
  policies: Record<string, PolicySettings>
  /** Claude sessions the user turned auto sync off for. */
  autoSyncOff: string[]
  /**
   * Folders the user has worked in, newest first. Kept so a workspace is
   * still there once its last terminal has gone: closing everything in a
   * project should not be the same as never having opened it.
   */
  workspaces: Workspace[]
}

export const DEFAULTS: SeamSettings = {
  theme: 'dark',
  shellOnly: true,
  policy: DEFAULT_POLICY,
  policies: {},
  autoSyncOff: [],
  workspaces: []
}

const MODES: PolicyMode[] = ['allow', 'ask', 'allowlist', 'readonly']
const THEMES: ThemeName[] = ['dark', 'midnight', 'ember', 'light']

function asStrings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : null
}

/** Take what is usable and leave the rest at its default. */
function parsePolicy(raw: unknown, fallback: PolicySettings): PolicySettings {
  const o = (raw as Record<string, unknown> | undefined) ?? {}
  const mode = MODES.includes(o['mode'] as PolicyMode) ? (o['mode'] as PolicyMode) : fallback.mode
  return { mode, allowPrefixes: asStrings(o['allowPrefixes']) ?? [] }
}

function parseWorkspaces(raw: unknown): Workspace[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Workspace[] = []
  for (const value of raw) {
    const o = value as Record<string, unknown> | null
    const root = typeof o?.['root'] === 'string' ? o['root'] : ''
    // A root is the key, so one without one is not a workspace, and the
    // first of a duplicate pair wins rather than both surviving.
    if (!root || seen.has(root)) continue
    seen.add(root)
    out.push({ root, name: typeof o?.['name'] === 'string' && o['name'] ? o['name'] : basename(root) || root })
  }
  return out
}

function parse(raw: unknown): SeamSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULTS }
  const o = raw as Record<string, unknown>
  const policy = parsePolicy(o['policy'], DEFAULTS.policy)
  const perRoot = (o['policies'] as Record<string, unknown> | undefined) ?? {}
  const policies: Record<string, PolicySettings> = {}
  if (typeof perRoot === 'object' && perRoot !== null) {
    for (const [root, value] of Object.entries(perRoot)) {
      // An entry that says nothing usable is the same as not being there.
      if (root) policies[root] = parsePolicy(value, policy)
    }
  }
  return {
    theme: THEMES.includes(o['theme'] as ThemeName) ? (o['theme'] as ThemeName) : DEFAULTS.theme,
    shellOnly: typeof o['shellOnly'] === 'boolean' ? o['shellOnly'] : DEFAULTS.shellOnly,
    policy,
    policies,
    autoSyncOff: asStrings(o['autoSyncOff']) ?? [],
    workspaces: parseWorkspaces(o['workspaces'])
  }
}

export class SettingsStore {
  private current: SeamSettings

  /**
   * `home` is the one folder that never becomes a workspace, however a
   * session comes to be running in it. It is where a session with no
   * project of its own goes, and listing an account name beside real
   * projects would say nothing about any of them.
   */
  constructor(
    private readonly file: string,
    private readonly home = ''
  ) {
    this.current = this.read()
  }

  get(): SeamSettings {
    return this.current
  }

  /** Note that a folder is being worked in, newest first. */
  rememberWorkspace(root: string, name?: string): Workspace[] {
    if (!root || (this.home !== '' && root === this.home)) return this.current.workspaces
    const rest = this.current.workspaces.filter((w) => w.root !== root)
    const existing = this.current.workspaces.find((w) => w.root === root)
    const workspaces = [{ root, name: name ?? existing?.name ?? basename(root) ?? root }, ...rest]
    return this.update({ workspaces }).workspaces
  }

  forgetWorkspace(root: string): Workspace[] {
    return this.update({ workspaces: this.current.workspaces.filter((w) => w.root !== root) }).workspaces
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
