# Seam

Seam (working name, final name undecided) is a macOS Electron app where each project's Claude Code session and a companion shell live side by side and share context in both directions. The goal is cohesion: the user can always do the work themselves in the shell or hand it to Claude, and switching between the two is one keystroke.

Design doc (goals, features, data model, risks): https://claude.ai/artifact/PAdnktf3DnACQBw1q9n3XP

## Status

Done:
- **Terminal skeleton:** tabs backed by a private tmux server; closing a tab keeps it running; relaunch restores tabs with screens intact.
- **Paired workspaces:** Cmd+T picks a folder and opens Claude Code (left) + shell (right) with a draggable divider; Ctrl+` switches focus.
- **Shell to Claude:** zsh/bash integration records every command (exit code, cwd, timing, output range); "Send to Claude" / "Ask Claude" / Cmd+Shift+Enter pastes the last command and its output into Claude's prompt, unsent.

Next, in order:
1. **Claude to shell.** A `seam` MCP server (stdio, passed with `--mcp-config` when Seam starts Claude) with tools `list_shells`, `read_shell`, `list_commands`, `run_in_shell`, `send_keys`, `wait_for_output`. Write tools go through an approval card on the target shell pane. Policy per workspace: ask (default), allowlisted prefixes, read-only. Private shells are hidden from all tools. Hard denylist always asks (`rm -rf`, `git push --force`, `sudo`, `DROP`, writes to `~/.ssh`). Every call is audited. Shell output is untrusted input to Claude: wrap it in tags.
2. **Claude Code hooks**, installed per session with `--settings` (never in the user's repo or global settings): status badges (Working / Waiting for you / Idle) from `UserPromptSubmit`, `Notification`, `PermissionRequest`, `Stop`; **attach mode** (queue shell context, delivered via `UserPromptSubmit` `additionalContext`); **auto sync** (per-pair toggle, digest of new shell activity via `UserPromptSubmit` and `PostToolUse`, capped at 2 KB, errors only for long-running processes). Ignore turn events that carry `agent_id` (subagents). Use `last_assistant_message`, not the transcript file, which lags.
3. **Session browser:** index `~/.claude/projects/*/*.jsonl` by project and cwd, FTS search, resume into a pair (`claude --resume <id>`, branch with `--fork-session`).
4. Quick run (Cmd+;) and quick ask (Cmd+'), per-command gutter marks, final name, packaging (signing, bundled tmux, auto-update).

## Commands

```bash
pnpm install       # postinstall makes node-pty's spawn-helper executable
pnpm dev           # run the app with hot reload
pnpm test          # vitest; integration tests drive real tmux, zsh and bash
pnpm typecheck
pnpm build
```

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
- bash: use `PS0` (4.4+) to detect a command starting; the DEBUG trap misses lines that are only a subshell, like `(exit 3)`. macOS's bash 3.2 falls back to DEBUG.
- `paste-buffer` without `-r`, so newlines arrive as CR like a real terminal paste.
- Records rebuilt after a restart need shell-reported timestamps (`$EPOCHREALTIME`, either decimal separator), not arrival time.
- Electron's default macOS menu binds Cmd+W to close the window; Seam installs its own menu.
