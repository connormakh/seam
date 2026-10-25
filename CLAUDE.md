# Seam

Seam (working name, final name undecided) is a macOS Electron app where each project's Claude Code session and a companion shell live side by side and share context in both directions. The goal is cohesion: the user can always do the work themselves in the shell or hand it to Claude, and switching between the two is one keystroke.

Design doc (goals, features, data model, risks): https://claude.ai/artifact/PAdnktf3DnACQBw1q9n3XP

## Status

Done:
- **Terminal skeleton:** tabs backed by a private tmux server; closing a tab keeps it running; relaunch restores tabs with screens intact.
- **Paired workspaces:** Cmd+T picks a folder and opens Claude Code (left) + shell (right) with a draggable divider; Ctrl+` switches focus.
- **Shell to Claude:** zsh/bash integration records every command (exit code, cwd, timing, output range); "Send to Claude" / "Ask Claude" / Cmd+Shift+Enter pastes the last command and its output into Claude's prompt, unsent.
- **Claude to shell:** a `seam` MCP server over a control socket, with `list_shells`, `read_shell`, `list_commands`, `read_command_output`, `run_in_shell`, `send_keys` and `wait_for_output`. Writes go through an approval card on the target shell's pane; policy is ask (default) / allowlist / read-only, with a denylist that always asks. Every call is audited.

Next, in order:
1. **Finish Claude to shell.** The tools, policy and approval card are in. Still missing: UI for the private-shell toggle (`@seam-private` exists, nothing sets it), an Activity panel over the audit log, per-workspace policy (one default until workspaces exist), and the "by Claude" gutter mark on commands Seam typed.
2. **Claude Code hooks**, installed per session with `--settings` (never in the user's repo or global settings): status badges (Working / Waiting for you / Idle) from `UserPromptSubmit`, `Notification`, `PermissionRequest`, `Stop`; **attach mode** (queue shell context, delivered via `UserPromptSubmit` `additionalContext`); **auto sync** (per-pair toggle, digest of new shell activity via `UserPromptSubmit` and `PostToolUse`, capped at 2 KB, errors only for long-running processes). Ignore turn events that carry `agent_id` (subagents). Use `last_assistant_message`, not the transcript file, which lags.
3. **Session browser:** index `~/.claude/projects/*/*.jsonl` by project and cwd, FTS search, resume into a pair (`claude --resume <id>`, branch with `--fork-session`).
4. Quick run (Cmd+;) and quick ask (Cmd+'), per-command gutter marks, final name, packaging (signing, bundled tmux, auto-update).

## Commands

Node 22.12 or newer; `engine-strict` in `.npmrc` refuses anything older, because
an older one installs with only a warning and then drops the packages that need
22, leaving `node_modules` broken.

```bash
pnpm install       # postinstall makes node-pty's spawn-helper executable
pnpm dev           # run the app with hot reload; the first run downloads Electron
pnpm test          # vitest; integration tests drive real tmux, zsh and bash
pnpm typecheck
pnpm build
```

Electron 45 has no install script: it fetches its binary the first time something
requires it, so the download lands on the first `pnpm dev`, not on `pnpm install`.

Headless check of the real app, with a screenshot you can read back:

```bash
cd apps/desktop
SEAM_SMOKE_SCREENSHOT=/tmp/seam.png scripts/smoke.sh '(async () => document.body.innerText)()'
```

Useful env vars: `SEAM_TMUX_SOCKET` (socket name; dev default `seam-dev`, packaged `seam`), `SEAM_TMUX` (tmux binary), `SEAM_CLAUDE_COMMAND` (JSON argv for the Claude side, e.g. `'["python3","scripts/fake-claude.py"]'` for a stand-in), and for smoke tests `SEAM_SMOKE_MENU` (menu item ids to click) and `SEAM_SMOKE_PICK_FOLDER` (answer for the folder picker).

## Architecture

Everything lives in `apps/desktop` (electron-vite, React 19, TypeScript strict, xterm.js, node-pty).

- `src/shared/ipc.ts` is the single IPC contract. Add channels and types here first.
- `src/preload/index.ts` exposes it as `window.seam`. The renderer has no Node access (contextIsolation, sandbox, no nodeIntegration).
- `src/main/ipc.ts` registers handlers. **Every renderer payload is validated** with `src/main/validate.ts` before it reaches tmux or a pty. Fire-and-forget channels swallow bad input instead of throwing.
- `src/main/menu.ts` owns every shortcut (menu accelerators fire before the page sees keys). The renderer reacts to `MenuCommand`s; it has no keydown shortcut handler.
- `src/main/runtime.ts` wires everything at startup.

Terminals:
- **tmux is the source of truth.** A Seam terminal is one tmux session on a private server (`tmux -S <userData>/tmux/<name>.sock`, generated config in `tmux/config.ts`). Seam's metadata is tmux user options: `@seam-kind` (shell|claude), `@seam-title`, `@seam-open` (has a tab), `@seam-pair` (the other half's id). Seam keeps no separate database yet.
- `terminals/terminal-service.ts`: opening a tab attaches a tmux client inside a node-pty; closing detaches (kills only the client); ending kills the session. Output to the renderer is batched (`output-batcher.ts`). A view attaches only once it is visible, at its real size.
- `terminals/claude-command.ts`: the Claude pane runs `claude` via the user's login shell (Finder-launched apps get a minimal PATH), falling back to a shell if Claude is missing or exits.

Shell to Claude:
- `shell/integration.ts` writes zsh and bash integration files and the launch command. zsh: a Seam-owned ZDOTDIR whose files source the user's own first. bash: `--init-file` that replays login files. Each command appends `S` and `E` lines to `$SEAM_EVENTS` (tab-separated: absolute tmux history line, `$EPOCHREALTIME`, cwd/command or exit code; fields escaped).
- `shell/command-tracker.ts` follows those files and captures each finished command's output from tmux history immediately.
- `context/shell-context.ts` formats the `<shell-context>` block (tail of output, 200 lines / 16 KB, secrets masked). `context/send.ts` pastes it into the Claude pane as one bracketed paste, and refuses unless the target is a real pair and Claude Code (not a shell) is in the foreground.

Claude to shell:
- `control/server.ts` is the only way in from a process Seam does not own (the MCP server now, hooks later): one JSON object per line on a 0600 socket, every request carrying a per-session token. The token is issued when the pair starts, carried in the Claude pane's environment, and revoked when the terminal ends.
- `mcp/install.ts` writes `seam-mcp.mjs` into app-support and a per-session `--mcp-config`. The server is deliberately dumb: it asks the socket for the tool list and forwards calls, so nothing that decides anything runs in a process Claude controls.
- `mcp/tools.ts` holds the tools. `shells()` is the only place scope is decided: same `@seam-root`, not `@seam-private`. Output is masked and wrapped in `<shell-output>`.
- `mcp/policy.ts` decides allow/ask/deny before anything is typed; `mcp/approvals.ts` parks the tool call until the card on the shell's pane is answered.

Renderer: `tabs-model.ts` is a pure reducer of tabs, background units and focus. A unit is one terminal or a [claude, shell] pair. Keep state changes there and test them.

## Conventions

- Small, meaningful commits; conventional prefixes (`feat(main):`, `fix(renderer):`, `docs:`...). Commit message bodies explain why.
- A bug fix comes with a test that fails without it.
- Prefer integration tests against real tmux, real shells and real ptys (`test/helpers.ts` gives each test file a throwaway tmux server). Mock only what cannot run in a test.
- Check UI changes with `scripts/smoke.sh` and a screenshot, not just tests.
- Writing (docs, README, UI text): plain and specific; avoid em dashes.

## Gotchas learned the hard way

- tmux escapes control characters in `-F` output, so the field separator is `␟`, not `\x1f` or tab.
- `set-option` and `capture-pane` take a pane target: use `=<id>:` (trailing colon). `has-session` and `kill-session` take `=<id>`.
- tmux expands formats in `-c` start directories (`#(cmd)` runs a command). Escape `#` as `##` (`escapeFormat`).
- `exit-empty off` is required; otherwise ending the last terminal and creating one immediately can race the server shutting down.
- With no sessions left, `kill-session` says "no current target"; treat it as already gone.
- node-pty's darwin prebuild ships `spawn-helper` without the executable bit ("posix_spawnp failed"). Fixed by `scripts/fix-node-pty.mjs` and a startup check.
- Attach must register before its first await (React StrictMode mounts, unmounts and remounts), or two tmux clients attach and output doubles.
- bash: use `PS0` (4.4+) to detect a command starting. macOS's bash 3.2 has no `PS0` and falls back to the DEBUG trap, which never fires for a line that is only a subshell, like `(exit 3)`, because bash runs no simple command in that shell. Those are reported from the prompt instead, spotted by the history number advancing, and their output is not captured: S and E share one line, so the range is empty.
- macOS's bash 3.2 calls an empty array unbound under `set -u`. In scripts write `${a[@]+"${a[@]}"}`, not `"${a[@]}"`.
- Editors that are themselves Electron apps export `ELECTRON_RUN_AS_NODE=1`. Inherited, it makes `electron .` run the main entry as plain node, where `electron.app` is undefined. `pnpm dev` and `scripts/smoke.sh` strip it.
- `paste-buffer` without `-r`, so newlines arrive as CR like a real terminal paste.
- Records rebuilt after a restart need shell-reported timestamps (`$EPOCHREALTIME`, either decimal separator), not arrival time. bash before 5.0 has none, so on the bash macOS ships those records fall back to arrival time and a rebuild cannot reproduce them. Tests ask `reportsTime` (`test/helpers.ts`) and assert timings only on a shell that has a clock.
- `$TMPDIR` on macOS is reached through a symlink (`/var/folders` -> `/private/var/folders`), and tmux and the shells report resolved paths. Tests make temp dirs with `makeTempDir` (`test/helpers.ts`), which resolves them, or nothing compares equal.
- BSD and GNU tools disagree on exit codes (`ls` on a missing path is 1 on macOS, 2 on GNU). Tests use commands that agree, like `cat`.
- `pane_current_command` is the name of the pane's foreground process group leader, not of its deepest child. A shell that runs a program as a child, without job control or `exec`, stays the leader and is what tmux reports. `claudeCommand` sets `set -m` for this reason.
- tmux hands a pane the server's PATH and ignores `new-session -e PATH=...`. To control it, put `env PATH=...` in the command itself.
- Python's `tty.setraw` flushes unread input (TCSAFLUSH). A stand-in for Claude must say when it is ready, or a paste sent during its startup is silently dropped.
- Terminals outlive the app, so anything Seam keeps in memory about a running session has to be recoverable at startup. Control-socket tokens live in the Claude session's own tmux environment and are read back by `adoptRunningSessions`; without that, every session started before the last restart is told "not authorised" for the rest of its life.
- A shell is reachable by Claude only if its `@seam-root` matches the session's. Terminals created before that option existed have an empty root and are invisible to every tool, which is the intended bias: an unreadable root must never widen what a session can see.
- An allowlisted or session-approved prefix only matches a single simple command. Anything carrying `;`, `&`, `|`, a backtick, `$(`, or a redirect always asks, or `git status && rm -rf ~` would ride in on `git status`.
- Electron's default macOS menu binds Cmd+W to close the window; Seam installs its own menu.
