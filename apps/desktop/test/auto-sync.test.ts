import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ControlServer, type Caller } from '../src/main/control/server'
import { AutoSync } from '../src/main/hooks/auto-sync'
import { installHook, writeHookSettings } from '../src/main/hooks/install'
import { CommandTracker } from '../src/main/shell/command-tracker'
import { installShellIntegration, shellLaunch } from '../src/main/shell/integration'
import type { Tmux } from '../src/main/tmux/tmux'
import { makeTestTmux, shellPath, waitFor } from './helpers'

/**
 * Run the real hook the way Claude Code does: event JSON in, maybe JSON out.
 *
 * Asynchronously, and that matters. The control server lives in this process,
 * so a synchronous child would hold the event loop the server needs to answer
 * and every hook would time out against a Seam that was never given a chance
 * to reply. Claude Code runs it as its own process, with Seam free to serve.
 */
function runHook(hookPath: string, event: Record<string, unknown>, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(hookPath, { env: { ...process.env, ...env } }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    )
    child.stdin!.end(JSON.stringify(event))
  })
}

describe('auto sync (real hook, real socket, real bash)', () => {
  let tmux: Tmux
  let dir: string
  let control: ControlServer
  let tracker: CommandTracker
  let autoSync: AutoSync
  let hookPath: string
  let env: Record<string, string>
  let caller: Caller
  const shellId = 'sync-shell'

  const run = async (command: string): Promise<void> => {
    const before = (await tracker.list(shellId)).length
    await tmux.sendKeys(shellId, command, { literal: true, enter: true })
    await waitFor(async () => {
      const all = await tracker.list(shellId)
      return all.length > before && all.at(-1)?.endedAt !== null && all.at(-1)?.output !== null
    })
  }

  const prompt = (): Record<string, unknown> => ({
    session_id: 'claude-1',
    hook_event_name: 'UserPromptSubmit',
    cwd: dir
  })

  beforeAll(async () => {
    ;({ tmux, dir } = makeTestTmux())
    const home = join(dir, 'home')
    const eventsDir = join(dir, 'events')
    mkdirSync(home)
    mkdirSync(eventsDir)
    writeFileSync(join(home, '.bash_profile'), 'PS1="$ "\n')
    tracker = new CommandTracker({ tmux, eventsDir, onChange: () => {} })
    tracker.start()

    const root = join(dir, 'project')
    mkdirSync(root)
    autoSync = new AutoSync({ tmux, commands: tracker, homeDir: home, contextDir: join(dir, 'ctx') })
    control = new ControlServer({
      socketPath: join(dir, 'control.sock'),
      methods: {
        hook: async (c, params) => {
          const event = (params['event'] as Record<string, unknown>) ?? {}
          if (event['agent_id']) return {}
          const additionalContext = await autoSync.digest(c)
          return additionalContext ? { additionalContext } : {}
        }
      }
    })
    await control.start()

    const launch = shellLaunch({
      shell: shellPath('bash'),
      integrationDir: installShellIntegration(join(dir, 'integration')),
      eventsFile: tracker.eventsFile(shellId),
      tmuxBinary: tmux.opts.binary,
      homeDir: home
    })
    await tmux.newSession({
      id: shellId,
      kind: 'shell',
      cwd: root,
      root,
      title: 'shell',
      command: launch.command,
      env: { ...launch.env, HOME: home },
      cols: 100,
      rows: 20
    })
    await waitFor(async () => (await tmux.capturePane(shellId)).includes('$'))

    caller = { sessionId: 'claude-1', root }
    const token = control.issueToken(caller)
    hookPath = installHook(join(dir, 'claude'), process.execPath)
    env = { SEAM_SOCKET: control.socketPath, SEAM_SESSION_TOKEN: token }
    // First call adopts the shell at its current point rather than replaying
    // everything that happened before Claude existed.
    await runHook(hookPath, prompt(), env)
  })

  afterAll(async () => {
    tracker.stop()
    await control.stop()
    await tmux.killServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a settings file Claude Code can load, blocking only where context comes back', () => {
    const file = writeHookSettings({ dir: join(dir, 'claude'), sessionId: 'claude-1', hookPath })
    const settings = JSON.parse(readFileSync(file, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string; async: boolean }[] }[]>
    }
    expect(Object.keys(settings.hooks).sort()).toEqual([
      'Notification',
      'PermissionRequest',
      'PostToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'UserPromptSubmit'
    ])
    for (const [name, event] of Object.entries(settings.hooks)) {
      // Quoted: Claude Code runs this through a shell, and the real path is
      // under "Application Support", which unquoted is two words.
      expect(event[0]!.hooks[0]!.command).toBe(`'${hookPath}'`)
      // Only the two that return context may hold the turn up; an async
      // hook's output is never read, so those two must not be async.
      const returnsContext = ['SessionStart', 'UserPromptSubmit', 'PostToolUse'].includes(name)
      expect(event[0]!.hooks[0]!.async).toBe(!returnsContext)
    }

    // The quoting has to survive a path with a space in it, which is the
    // only kind this ever has in the installed app.
    const spaced = writeHookSettings({
      dir: join(dir, 'claude'),
      sessionId: 'spaced',
      hookPath: '/Users/someone/Library/Application Support/Seam/claude/seam-hook'
    })
    const command = JSON.parse(readFileSync(spaced, 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command as string
    expect(command).toBe(`'/Users/someone/Library/Application Support/Seam/claude/seam-hook'`)
    // And actually run as one word.
    expect(execFileSync('/bin/sh', ['-c', `printf %s ${command.replace('seam-hook', 'seam-hook-x')}`], { encoding: 'utf8' })).toBe(
      '/Users/someone/Library/Application Support/Seam/claude/seam-hook-x'
    )
  })

  it('says nothing at all when the shell has been quiet', async () => {
    expect((await runHook(hookPath, prompt(), env)).trim()).toBe('')
  })

  it('tells Claude what the user ran, as the shape Claude Code expects', async () => {
    await run('echo building')
    const out = await runHook(hookPath, prompt(), env)
    const parsed = JSON.parse(out) as { hookSpecificOutput: Record<string, string> }
    expect(parsed.hookSpecificOutput).toMatchObject({ hookEventName: 'UserPromptSubmit' })

    const context = parsed.hookSpecificOutput['additionalContext']!
    expect(context).toContain('<shell-activity>')
    expect(context).toContain('$ echo building · exit 0')
    // Said once: the next turn hears only what is newer.
    expect((await runHook(hookPath, prompt(), env)).trim()).toBe('')
  })

  it('carries the tail of a failure, and where the rest of it is', async () => {
    await run('printf "line %s\\n" $(seq 1 60); false')
    const context = JSON.parse(await runHook(hookPath, prompt(), env)).hookSpecificOutput.additionalContext as string
    expect(context).toContain('· exit 1')
    expect(context).toContain('line 60')
    // Capped at the tail, with the whole thing left on disk to read.
    expect(context).not.toContain('line 1\n')
    const path = /full output: (\S+)\]/.exec(context)?.[1]
    expect(path && readFileSync(path, 'utf8')).toContain('line 1')
  })

  it('does not tell Claude about its own commands', async () => {
    tracker.attribute(shellId, 'echo claude-did-this')
    await run('echo claude-did-this')
    await run('echo user-did-this')
    const context = JSON.parse(await runHook(hookPath, prompt(), env)).hookSpecificOutput.additionalContext as string
    expect(context).toContain('user-did-this')
    expect(context).not.toContain('claude-did-this')
  })

  it('stays under its cap however much the shell printed', async () => {
    await run('seq 1 4000; false')
    const context = JSON.parse(await runHook(hookPath, prompt(), env)).hookSpecificOutput.additionalContext as string
    expect(context.length).toBeLessThan(2500)
  })

  it('carries a running task\u2019s errors, and none of its chatter', async () => {
    // A stand-in for a dev server: it never finishes, so the finished-command
    // path never sees it, and the test decides exactly what it prints.
    const log = join(dir, 'dev.log')
    writeFileSync(log, '')
    await tmux.sendKeys(shellId, `tail -f ${log}`, { literal: true, enter: true })
    await waitFor(async () => (await tracker.latest(shellId))?.running === true)

    appendFileSync(log, 'ready on :3000\ncompiled 42 modules in 180ms\n')
    await waitFor(async () => (await tmux.capturePane(shellId)).includes('compiled 42 modules'))
    // It is working, so there is nothing to say: progress is not trouble.
    expect((await runHook(hookPath, prompt(), env)).trim()).toBe('')

    appendFileSync(log, 'Error: Cannot find module "./missing"\n    at Object.<anonymous> (/app/x.js:4:11)\n')
    await waitFor(async () => (await tmux.capturePane(shellId)).includes('Cannot find module'))

    const context = JSON.parse(await runHook(hookPath, prompt(), env)).hookSpecificOutput.additionalContext as string
    expect(context).toContain('Still running: $ tail -f')
    expect(context).toContain('Cannot find module')
    // The stack frame comes too: it is what says where.
    expect(context).toContain('at Object.<anonymous> (/app/x.js:4:11)')
    // The chatter does not.
    expect(context).not.toContain('compiled 42 modules')
    expect(context).not.toContain('ready on :3000')

    // Said once. The same error is not repeated every turn from here on.
    expect((await runHook(hookPath, prompt(), env)).trim()).toBe('')

    appendFileSync(log, 'FAIL src/auth.test.ts\n')
    await waitFor(async () => (await tmux.capturePane(shellId)).includes('FAIL src/auth'))
    const later = JSON.parse(await runHook(hookPath, prompt(), env)).hookSpecificOutput.additionalContext as string
    expect(later).toContain('FAIL src/auth.test.ts')
    expect(later).not.toContain('Cannot find module')

    await tmux.sendKeys(shellId, 'C-c')
    await waitFor(async () => (await tracker.latest(shellId))?.running === false)
  })

  it('says nothing for a subagent, whose turn is not the pair’s', async () => {
    await run('echo from-a-subagent-turn')
    const out = await runHook(hookPath, { ...prompt(), agent_id: 'sub-1' }, env)
    expect(out.trim()).toBe('')
  })

  it('exits quietly when Seam is not there, rather than stalling the turn', async () => {
    await run('echo while-seam-is-gone')
    const out = await runHook(hookPath, prompt(), {
      SEAM_SOCKET: join(dir, 'no-such.sock'),
      SEAM_SESSION_TOKEN: 'x'
    })
    expect(out.trim()).toBe('')
  })

  it('remembers which sessions were silenced, for the next launch', async () => {
    const saved: string[][] = []
    const fresh = new AutoSync({
      tmux,
      commands: tracker,
      homeDir: dir,
      contextDir: join(dir, 'ctx'),
      disabled: ['from-last-time'],
      onDisabledChanged: (ids) => saved.push(ids)
    })
    // What was written down last time is still off.
    expect(fresh.enabled('from-last-time')).toBe(false)
    expect(fresh.enabled('someone-else')).toBe(true)

    fresh.setEnabled('someone-else', false)
    expect(saved.at(-1)).toEqual(['from-last-time', 'someone-else'])
    fresh.setEnabled('from-last-time', true)
    expect(saved.at(-1)).toEqual(['someone-else'])
    // A session that ended is not coming back, so its entry goes too.
    fresh.forget('someone-else')
    expect(saved.at(-1)).toEqual([])
  })

  it('can be turned off for a session', async () => {
    autoSync.setEnabled('claude-1', false)
    await run('echo not-wanted')
    expect((await runHook(hookPath, prompt(), env)).trim()).toBe('')
    autoSync.setEnabled('claude-1', true)
    expect(existsSync(hookPath)).toBe(true)
  })
})
