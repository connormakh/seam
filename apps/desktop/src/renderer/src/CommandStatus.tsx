import type { CommandSummary } from '@shared/ipc'

interface Props {
  latest: CommandSummary | undefined
  /** Present in a pair: sends the last finished command to Claude. */
  onSend?: () => void
}

function shorten(command: string, max = 48): string {
  const oneLine = command.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

/** The last command in a shell, and (in a pair) the button that hands it to Claude. */
export function CommandStatus({ latest, onSend }: Props): React.JSX.Element | null {
  if (!latest) return null
  const failed = !latest.running && latest.exitCode !== 0
  const state = latest.running ? 'running' : failed ? 'failed' : 'ok'

  return (
    <span className="command-status" data-state={state}>
      {/* The shell is shared, so say whose command this was. */}
      {latest.actor === 'claude' && (
        <span className="command-actor" title="Claude ran this">
          by Claude
        </span>
      )}
      <span className="command-mark" aria-hidden="true">
        {latest.running ? '●' : failed ? '✗' : '✓'}
      </span>
      <span className="command-text" title={latest.command}>
        {shorten(latest.command)}
      </span>
      <span className="command-meta">
        {latest.running
          ? 'running'
          : [failed ? `exit ${latest.exitCode ?? '?'}` : null, latest.endedAt !== null ? duration(latest.endedAt - latest.startedAt) : null]
              .filter(Boolean)
              .join(' · ')}
      </span>
      {onSend && !latest.running && (
        <button
          type="button"
          className={`command-send${failed ? ' command-send-failed' : ''}`}
          onClick={onSend}
          title="Paste this command and its output into Claude's prompt · ⌘⇧↩"
        >
          {failed ? 'Ask Claude' : 'Send to Claude'} <kbd>⌘⇧↩</kbd>
        </button>
      )}
    </span>
  )
}
