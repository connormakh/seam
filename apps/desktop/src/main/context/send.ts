import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SendContextResult } from '@shared/ipc'
import type { CommandTracker } from '../shell/command-tracker'
import type { Tmux } from '../tmux/tmux'
import { formatShellContext } from './shell-context'

/** Foreground programs that mean "a shell prompt", not Claude Code. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'login'])

export class SendError extends Error {
  override name = 'SendError'
}

export interface ContextSenderOptions {
  tmux: Tmux
  commands: CommandTracker
  homeDir: string
  /** Where complete outputs are saved when the payload carries only their tail. */
  contextDir: string
}

/**
 * Shell to Claude: hands a pair's Claude session the last command from its
 * shell, pasted into Claude's prompt without sending it, so the user can
 * add a sentence before pressing Enter.
 */
export class ContextSender {
  constructor(private readonly o: ContextSenderOptions) {}

  async sendLast(shellId: string, claudeId: string): Promise<SendContextResult> {
    const sessions = new Map((await this.o.tmux.listSessions()).map((s) => [s.id, s]))
    const shell = sessions.get(shellId)
    const claude = sessions.get(claudeId)
    if (!shell || !claude || shell.kind !== 'shell' || claude.kind !== 'claude' || shell.pairId !== claudeId || claude.pairId !== shellId) {
      throw new SendError('Those terminals are not a Claude + shell pair.')
    }
    // Pasting into a bare shell could run the pasted lines; only paste into Claude Code.
    if (SHELLS.has(claude.currentCommand.replace(/^-/, ''))) {
      throw new SendError('Claude Code is not running in this pair. Start it with `claude` in the left pane, then send again.')
    }

    const record = await this.o.commands.lastFinished(shellId)
    if (!record) throw new SendError('Nothing to send yet: no command has finished in this shell.')

    const base = { shellName: shell.title || 'shell', homeDir: this.o.homeDir }
    let ctx = formatShellContext(record, base)
    if (ctx.truncated && record.output) {
      mkdirSync(this.o.contextDir, { recursive: true, mode: 0o700 })
      const file = join(this.o.contextDir, `${shellId}-${record.id}.log`)
      writeFileSync(file, `$ ${record.command}\n${record.output}\n`, { mode: 0o600 })
      ctx = formatShellContext(record, { ...base, fullOutputPath: file })
    }

    await this.o.tmux.pasteText(claudeId, ctx.text)
    return {
      command: record.command,
      exitCode: record.exitCode,
      lines: ctx.lines,
      truncated: ctx.truncated,
      masked: ctx.masked
    }
  }
}
