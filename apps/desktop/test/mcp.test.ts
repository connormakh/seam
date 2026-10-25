import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ApprovalDecision, ApprovalRequest, AuditEntry } from '@shared/ipc'
import { adoptRunningSessions } from '../src/main/control/adopt'
import { ControlServer } from '../src/main/control/server'
import { Approvals } from '../src/main/mcp/approvals'
import { AuditLog } from '../src/main/mcp/audit'
import { installMcpServer } from '../src/main/mcp/install'
import { Tools } from '../src/main/mcp/tools'
import { CommandTracker } from '../src/main/shell/command-tracker'
import { installShellIntegration, shellLaunch } from '../src/main/shell/integration'
import type { Tmux } from '../src/main/tmux/tmux'
import { makeTestTmux, shellPath, waitFor } from './helpers'

/** Speaks MCP to the real server the way Claude Code does: JSON-RPC over stdio. */
class McpClient {
  private readonly child: ChildProcess
  private readonly pending = new Map<number, (m: Record<string, unknown>) => void>()
  private buffer = ''
  private nextId = 1

  constructor(serverPath: string, env: Record<string, string>) {
    this.child = spawn(process.execPath, [serverPath], { env: { ...process.env, ...env }, stdio: 'pipe' })
    this.child.stdout!.setEncoding('utf8')
    this.child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk
      let cut = this.buffer.indexOf('\n')
      while (cut !== -1) {
        const line = this.buffer.slice(0, cut)
        this.buffer = this.buffer.slice(cut + 1)
        if (line.trim()) {
          const message = JSON.parse(line) as Record<string, unknown>
          this.pending.get(message['id'] as number)?.(message)
        }
        cut = this.buffer.indexOf('\n')
      }
    })
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 5000)
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve(message)
      })
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  /** The text of a tools/call result, which is where every tool's answer lands. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    const message = await this.request('tools/call', { name, arguments: args })
    const result = message['result'] as { content: { text: string }[]; isError?: boolean }
    return { text: result.content[0]!.text, isError: result.isError === true }
  }

  stop(): void {
    this.child.kill()
  }
}

describe('seam MCP server (real socket, real tmux, real bash)', () => {
  let tmux: Tmux
  let dir: string
  let control: ControlServer
  let tracker: CommandTracker
  let client: McpClient
  let serverPath: string
  let audit: AuditLog
  /** How the test answers the card Claude's write tools put up. */
  let answer: ApprovalDecision | 'ignore'
  let asked: ApprovalRequest[]
  const shellId = 'mcp-shell'

  beforeAll(async () => {
    ;({ tmux, dir } = makeTestTmux())
    const home = join(dir, 'home')
    const eventsDir = join(dir, 'events')
    mkdirSync(home)
    mkdirSync(eventsDir)
    writeFileSync(join(home, '.bash_profile'), 'PS1="$ "\n')
    tracker = new CommandTracker({ tmux, eventsDir, onChange: () => {} })
    tracker.start()

    control = new ControlServer({
      socketPath: join(dir, 'control.sock'),
      methods: {
        'tools/list': async () => tools.list(),
        'tools/call': async (caller, params) =>
          tools.call(caller, String(params['name'] ?? ''), (params['arguments'] as Record<string, unknown>) ?? {})
      }
    })
    audit = new AuditLog({ onAppend: () => {} })
    asked = []
    answer = 'deny'
    const approvals = new Approvals({
      // Stands in for the card on the shell's pane: same promise, same answers.
      present: (request) => {
        asked.push(request)
        if (answer !== 'ignore') setTimeout(() => approvals.resolve(request.id, answer as ApprovalDecision), 0)
      },
      dismiss: () => {},
      timeoutMs: 1500
    })
    const tools = new Tools({
      tmux,
      commands: tracker,
      homeDir: home,
      approvals,
      audit,
      policy: () => ({ mode: 'ask', allowPrefixes: [] }),
      pollMs: 25
    })
    await control.start()

    // The session's workspace, and three shells: one in it, one somewhere
    // else, one in it but private.
    const root = join(dir, 'project')
    mkdirSync(root)
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
    await tmux.newSession({ id: 'other-root', kind: 'shell', cwd: home, root: home, title: 'elsewhere' })
    await tmux.newSession({ id: 'secret', kind: 'shell', cwd: root, root, title: 'vault' })
    await tmux.setPrivate('secret', true)
    await waitFor(async () => (await tmux.capturePane(shellId)).includes('$'))

    serverPath = installMcpServer(join(dir, 'claude'))
    const token = control.issueToken({ sessionId: 'mcp-claude', root })
    client = new McpClient(serverPath, { SEAM_SOCKET: control.socketPath, SEAM_SESSION_TOKEN: token })
  })

  afterAll(async () => {
    client?.stop()
    tracker.stop()
    await control.stop()
    await tmux.killServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it('completes the MCP handshake and lists its tools', async () => {
    const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
    expect((init['result'] as Record<string, unknown>)['serverInfo']).toMatchObject({ name: 'seam' })

    const listed = await client.request('tools/list')
    const names = ((listed['result'] as { tools: { name: string }[] }).tools ?? []).map((t) => t.name)
    expect(names).toEqual([
      'list_shells',
      'read_shell',
      'list_commands',
      'run_in_shell',
      'send_keys',
      'wait_for_output',
      'read_command_output'
    ])
  })

  it('lists only the shells in the session workspace, never a private one', async () => {
    const { text } = await client.callTool('list_shells')
    expect(text).toContain('shell')
    // A shell opened on another folder, and one the user locked, are both
    // invisible: not listed, and not reachable by name either.
    expect(text).not.toContain('elsewhere')
    expect(text).not.toContain('vault')

    const denied = await client.callTool('read_shell', { shell: 'vault' })
    expect(denied.isError).toBe(true)
    expect(denied.text).toMatch(/no shell called "vault"/)
  })

  it('reads a shell and its command records, with secrets masked', async () => {
    await tmux.sendKeys(shellId, 'echo "TOKEN=supersecretvalue"; false', { literal: true, enter: true })
    await waitFor(async () => (await tracker.list(shellId)).some((r) => r.endedAt && r.output !== null))

    const screen = await client.callTool('read_shell', { shell: 'shell' })
    expect(screen.text).toContain('<shell-output shell="shell">')
    expect(screen.text).not.toContain('supersecretvalue')

    const commands = await client.callTool('list_commands', { shell: 'shell' })
    expect(commands.text).toMatch(/#\d+\s+exit 1/)
    expect(commands.text).not.toContain('supersecretvalue')

    const id = Number(/#(\d+)\s+exit 1/.exec(commands.text)![1])
    const output = await client.callTool('read_command_output', { shell: 'shell', command_id: id })
    expect(output.text).toContain('TOKEN=[masked]')
    expect(output.text).not.toContain('supersecretvalue')
  })


  it('runs a command once the user approves, and hands back its exit code and output', async () => {
    answer = 'approve'
    asked = []
    const result = await client.callTool('run_in_shell', { shell: 'shell', command: 'echo hello-from-claude; (exit 7)' })

    // The card named the shell it would act on, and the command verbatim.
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ shellId, shellTitle: 'shell', tool: 'run_in_shell' })
    expect(asked[0]!.command).toBe('echo hello-from-claude; (exit 7)')

    expect(result.isError).toBe(false)
    expect(result.text).toContain('hello-from-claude')
    expect(result.text).toContain('exit 7')
    // It was typed into the user's own shell, so it is in their history too.
    expect(await tmux.capturePane(shellId)).toContain('hello-from-claude')
  })

  it('types nothing when the user denies', async () => {
    answer = 'deny'
    const result = await client.callTool('run_in_shell', { shell: 'shell', command: 'echo should-never-appear' })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/you denied it/)
    expect(await tmux.capturePane(shellId)).not.toContain('should-never-appear')
  })

  it('refuses rather than waits when nobody answers the card', async () => {
    answer = 'ignore'
    const result = await client.callTool('run_in_shell', { shell: 'shell', command: 'echo nobody-home' })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/nobody answered/)
    expect(await tmux.capturePane(shellId)).not.toContain('nobody-home')
  })

  it('stops asking once the user approves similar, but never for the dangerous ones', async () => {
    answer = 'approve-similar'
    asked = []
    // The card offers the verb here, because -la is an argument and not a
    // subcommand; it says so on the button, so what is granted is what was read.
    await client.callTool('run_in_shell', { shell: 'shell', command: 'ls -la' })
    expect(asked).toHaveLength(1)
    expect(asked[0]!.similar).toBe('ls')

    // A second ls needs no card now.
    answer = 'ignore'
    const second = await client.callTool('run_in_shell', { shell: 'shell', command: 'ls -R' })
    expect(second.isError).toBe(false)
    expect(asked).toHaveLength(1)

    // Chaining off the remembered prefix does not inherit it. (That a
    // remembered prefix never covers a denylisted command is in policy.test.ts,
    // where there is a destructive command that actually starts with one.)
    answer = 'deny'
    const chained = await client.callTool('run_in_shell', { shell: 'shell', command: 'ls && echo smuggled' })
    expect(chained.isError).toBe(true)
    expect(asked).toHaveLength(2)
    expect(await tmux.capturePane(shellId)).not.toContain('smuggled')
  })

  it('will not type into a shell that is in the middle of something', async () => {
    await tmux.sendKeys(shellId, 'sleep 4', { literal: true, enter: true })
    await waitFor(async () => (await tracker.latest(shellId))?.running === true)
    answer = 'approve'
    const result = await client.callTool('run_in_shell', { shell: 'shell', command: 'echo too-soon' })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/shell busy: sleep 4/)

    // send_keys is how you reach a shell that is busy.
    answer = 'approve'
    const keys = await client.callTool('send_keys', { shell: 'shell', keys: 'C-c' })
    expect(keys.isError).toBe(false)
    await waitFor(async () => (await tracker.latest(shellId))?.running === false)
  })

  it('waits for a pattern to appear, and gives up when it does not', async () => {
    answer = 'approve'
    void client.callTool('run_in_shell', { shell: 'shell', command: 'echo waited-for-this' })
    const hit = await client.callTool('wait_for_output', { shell: 'shell', pattern: 'waited-for-\\w+', timeout_s: 10 })
    expect(hit.isError).toBe(false)
    expect(hit.text).toContain('waited-for-this')

    const missed = await client.callTool('wait_for_output', { shell: 'shell', pattern: 'never-ever', timeout_s: 1 })
    expect(missed.isError).toBe(true)
    expect(missed.text).toMatch(/nothing matched/)
  })

  it('refuses a pattern that could hang the app', async () => {
    const result = await client.callTool('wait_for_output', { shell: 'shell', pattern: 'x'.repeat(201) })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/too long/)
  })

  it('records what was asked for and what happened, with secrets masked', async () => {
    answer = 'deny'
    await client.callTool('run_in_shell', { shell: 'shell', command: 'echo "TOKEN=supersecretvalue"' })
    const entries: AuditEntry[] = audit.list()
    const last = entries.at(-1)!
    expect(last).toMatchObject({ sessionId: 'mcp-claude', shellId, tool: 'run_in_shell', outcome: 'denied' })
    expect(last.detail).toContain('TOKEN=[masked]')
    expect(last.detail).not.toContain('supersecretvalue')
    // Approvals and denials both land here, not just the refusals.
    expect(entries.some((e) => e.outcome === 'approved')).toBe(true)
  })

  it('marks the commands it ran, so a shared shell says who typed what', async () => {
    answer = 'approve'
    await client.callTool('run_in_shell', { shell: 'shell', command: 'echo who-ran-this' })
    const records = await tracker.list(shellId)
    const mine = records.find((r) => r.command === 'echo who-ran-this')
    expect(mine?.actor).toBe('claude')
    // The user's own commands are still theirs.
    expect(records.find((r) => r.command.includes('TOKEN='))?.actor).toBe('user')
  })

  it('answers an unknown shell and an unknown tool as errors Claude can read', async () => {
    const missing = await client.callTool('read_shell', { shell: 'nope' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('There is: shell')

    const unknown = await client.callTool('does_not_exist')
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain('unknown tool')
  })

  it('refuses a caller whose token Seam did not issue', async () => {
    const impostor = new McpClient(serverPath, { SEAM_SOCKET: control.socketPath, SEAM_SESSION_TOKEN: 'made-up' })
    try {
      const result = await impostor.callTool('list_shells')
      expect(result.isError).toBe(true)
      expect(result.text).toContain('not authorised')
    } finally {
      impostor.stop()
    }
  })


  /**
   * The bug this caught in the real app: terminals outlive Seam by design, so
   * after a restart a Claude session is still running with a token the new
   * process has never seen, and every tool call comes back "not authorised".
   */
  it('gives a session its tools back after Seam restarts under it', async () => {
    const root = join(dir, 'project')
    // A Claude pane started by the "previous" run, with its token in tmux.
    const oldToken = control.issueToken({ sessionId: 'restarted', root })
    await tmux.newSession({
      id: 'restarted',
      kind: 'claude',
      cwd: root,
      root,
      title: 'claude',
      env: { SEAM_SESSION_TOKEN: oldToken }
    })

    // Seam quits and comes back: a new server, which has never heard of it.
    await control.stop()
    const fresh = new ControlServer({ socketPath: join(dir, 'control.sock'), methods: control['o'].methods })
    await fresh.start()
    const before = new McpClient(serverPath, { SEAM_SOCKET: fresh.socketPath, SEAM_SESSION_TOKEN: oldToken })
    try {
      expect((await before.callTool('list_shells')).text).toContain('not authorised')
    } finally {
      before.stop()
    }

    expect(await adoptRunningSessions(tmux, fresh)).toBeGreaterThan(0)
    const after = new McpClient(serverPath, { SEAM_SOCKET: fresh.socketPath, SEAM_SESSION_TOKEN: oldToken })
    try {
      const result = await after.callTool('list_shells')
      expect(result.isError).toBe(false)
      expect(result.text).toContain('shell')
    } finally {
      after.stop()
      await tmux.killSession('restarted')
      await fresh.stop()
      await control.start()
    }
  })

  it('stops answering a session once its terminal has gone', async () => {
    const token = control.issueToken({ sessionId: 'doomed', root: dir })
    const doomed = new McpClient(serverPath, { SEAM_SOCKET: control.socketPath, SEAM_SESSION_TOKEN: token })
    try {
      expect((await doomed.callTool('list_shells')).isError).toBe(false)
      control.revokeSession('doomed')
      const after = await doomed.callTool('list_shells')
      expect(after.isError).toBe(true)
      expect(after.text).toContain('not authorised')
    } finally {
      doomed.stop()
    }
  })
})
