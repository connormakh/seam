import type { ControlServer } from './server'
import type { Tmux } from '../tmux/tmux'

/**
 * Give back their tokens to the Claude sessions that were already running.
 *
 * Seam's terminals outlive the app on purpose, so after a restart there are
 * Claude sessions still going, each holding the token Seam gave it in its
 * environment. tmux has kept that environment, so it is the store: read the
 * token back and the session keeps its shell tools instead of being told it
 * is nobody for the rest of its life.
 */
export async function adoptRunningSessions(tmux: Tmux, control: ControlServer): Promise<number> {
  let adopted = 0
  for (const session of await tmux.listSessions()) {
    if (session.kind !== 'claude') continue
    const token = await tmux.sessionEnv(session.id, 'SEAM_SESSION_TOKEN')
    if (!token) continue
    control.adoptToken(token, { sessionId: session.id, root: session.root })
    adopted++
  }
  return adopted
}
