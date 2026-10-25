import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'

/**
 * The control socket: the one way into Seam from the processes it does not
 * own. The `seam` MCP server runs under Claude Code, and hooks will run under
 * it too; neither can be trusted to be the session it claims to be, so every
 * request carries a token Seam issued when it started that session, and the
 * token is what decides which terminals the request can reach.
 *
 * One JSON object per line in each direction, so a caller needs no library:
 *
 *   -> {"id":1,"token":"...","method":"list_shells","params":{}}
 *   <- {"id":1,"ok":true,"result":{...}}
 *   <- {"id":1,"ok":false,"error":"shell not found"}
 *
 * The socket sits in Seam's app-support folder with mode 0600, so only the
 * user can open it at all; the token guards against anything they run.
 */

/** Who a request turned out to be, once its token checked out. */
export interface Caller {
  /** The Claude terminal the token was issued to. */
  sessionId: string
  /** The workspace root that session was opened on; its reachable shells share it. */
  root: string
}

export type ControlMethod = (caller: Caller, params: Record<string, unknown>) => Promise<unknown>

export interface ControlServerOptions {
  socketPath: string
  methods: Record<string, ControlMethod>
}

/** A line longer than this is a bug or an attack; drop the connection. */
const MAX_LINE = 1 << 20

export class ControlServer {
  private server: Server | null = null
  private readonly tokens = new Map<string, Caller>()
  private readonly bySession = new Map<string, string>()

  constructor(private readonly o: ControlServerOptions) {}

  async start(): Promise<void> {
    if (this.server) return
    mkdirSync(dirname(this.o.socketPath), { recursive: true, mode: 0o700 })
    // A socket left behind by a crash would make listen() fail with EADDRINUSE.
    rmSync(this.o.socketPath, { force: true })
    const server = createServer((socket) => this.serve(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.o.socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    // Until this runs the socket is world-writable on some systems.
    chmodSync(this.o.socketPath, 0o600)
    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.tokens.clear()
    this.bySession.clear()
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(this.o.socketPath, { force: true })
  }

  get socketPath(): string {
    return this.o.socketPath
  }

  /** Issue the token a Claude session's MCP server and hooks authenticate with. */
  issueToken(caller: Caller): string {
    this.revokeSession(caller.sessionId)
    const token = randomBytes(32).toString('hex')
    this.tokens.set(token, caller)
    this.bySession.set(caller.sessionId, token)
    return token
  }

  /** Drop a session's token, so anything still holding it can no longer act. */
  revokeSession(sessionId: string): void {
    const existing = this.bySession.get(sessionId)
    if (existing !== undefined) this.tokens.delete(existing)
    this.bySession.delete(sessionId)
  }

  private serve(socket: Socket): void {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_LINE) {
        socket.destroy()
        return
      }
      let cut = buffer.indexOf('\n')
      while (cut !== -1) {
        const line = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 1)
        void this.handle(socket, line)
        cut = buffer.indexOf('\n')
      }
    })
    // A caller that dies mid-request is normal; nothing to clean up.
    socket.on('error', () => socket.destroy())
  }

  private async handle(socket: Socket, line: string): Promise<void> {
    if (!line.trim()) return
    let id: unknown = null
    try {
      const request: unknown = JSON.parse(line)
      if (typeof request !== 'object' || request === null) throw new Error('bad request')
      const { id: rid, token, method, params } = request as Record<string, unknown>
      id = rid ?? null
      if (typeof token !== 'string' || typeof method !== 'string') throw new Error('bad request')

      const caller = this.tokens.get(token)
      // The same answer for an unknown token and an unknown method, so a
      // caller cannot use the difference to learn which methods exist.
      if (!caller) throw new Error('not authorised')
      const handler = this.o.methods[method]
      if (!handler) throw new Error(`unknown method: ${method}`)

      const result = await handler(caller, (params as Record<string, unknown>) ?? {})
      this.reply(socket, { id, ok: true, result })
    } catch (e) {
      this.reply(socket, { id, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  private reply(socket: Socket, payload: unknown): void {
    if (socket.destroyed) return
    socket.write(`${JSON.stringify(payload)}\n`)
  }
}
