import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ControlServer } from '../src/main/control/server'
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
    const tools = new Tools({ tmux, commands: tracker, homeDir: home })
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
    expect(names).toEqual(['list_shells', 'read_shell', 'list_commands', 'read_command_output'])
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
