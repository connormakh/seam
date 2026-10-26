# Seam

Seam is a macOS Electron app where each project's Claude Code session and a companion shell live side by side and share context in both directions. The goal is cohesion: the user can always do the work themselves in the shell or hand it to Claude, and switching between the two is one keystroke.

## Goals

- Every Claude Code session on this Mac shows up under its project, readable and resumable, with no import step.
- Shells and Claude sessions survive closing the tab or quitting the app.
- A failed command reaches Claude with its command line, exit code, cwd and output in one action.
- Claude can use the shells you already have running (dev server, REPL, ssh, activated venv) instead of spawning fresh ones.
- What Claude does in your shells is governed by a policy you set, and recorded whatever that policy is. The original design said ask before every command; that became allow by default once the shell was genuinely shared, since a card in front of each one makes it Claude borrowing your terminal rather than working in it.
- Zero changes to your repo: nothing written into the project, no global settings edited.

Not for v1: other agent CLIs (the shape leaves room, only Claude Code is wired up), ssh hosts and remote workspaces, a custom chat UI (Claude runs in its real TUI in a terminal tab), Windows and Linux (Electron keeps the door open; macOS is the only tested target), team or cloud sync.

## Status

Done:
- **Terminal skeleton:** tabs backed by a private tmux server; closing a tab keeps it running; relaunch restores tabs with screens intact.
- **Themes:** Dark, Midnight, Ember and Light, chosen in Settings and saved. `renderer/terminal/themes.ts` holds both halves of each one, the CSS variables and the xterm palette, because a theme that defines only one ends up as a light sidebar around a dark pane; a test checks every theme defines every key.
- **Settings (Cmd+,):** shell-only, the default policy and its allowlist prefixes, and what Seam is driving (the Claude Code and tmux it found). Writes the same `settings.json` that can be edited by hand.
- **First-run check:** Claude Code is looked for through the login shell at startup, with its version compared to the oldest Seam can drive, and said in a banner rather than discovered inside a pane later.
- **Workspaces:** a sidebar (Cmd+Ctrl+S) groups sessions by the folder they were opened on, with a status dot each. A workspace is remembered the moment a pair opens on a folder and outlives everything running in it, so a project is one click from being open again; `+` adds another session to the same folder, which is what makes more than one per project possible.
- **Paired workspaces:** Cmd+T picks a folder and opens Claude Code (left) + shell (right) with a draggable divider; Ctrl+` switches focus.
- **Shell to Claude:** zsh/bash integration records every command (exit code, cwd, timing, output range); "Send to Claude" / "Ask Claude" / Cmd+Shift+Enter pastes the last command and its output into Claude's prompt, unsent.
- **Private shells:** the chip on a shell's header (shared / private). Private means Claude cannot list, read or touch it: for a shell holding credentials.
- **Per-project policy:** the selector in the Activity header, saved per `@seam-root`. Allow by default; ask, allowlist and read-only are there for anyone who wants them.
- **Status badges:** a dot on each tab from the session's hooks: working, waiting for you (nothing moves until you look), or idle with a preview of Claude's last message.
- **Attach mode:** Cmd+Opt+Enter queues the shell's last command for Claude's next prompt instead of pasting it, so it works mid-turn and does not depend on the input box taking a paste. The chip on the Claude pane drops it.
- **Activity panel:** Shell menu > Activity (Cmd+Shift+A). Every tool call Claude makes, reading included, with its time and what the policy decided. With nothing standing between Claude and the shell, this is where "what has it been doing in there" is answered.
- **Auto sync:** a `seam-hook` on `UserPromptSubmit` and `PostToolUse` tells Claude what the user ran in the shell, without anyone asking. Successful commands collapse to one line, failures carry their last 40 lines and a path to the rest, only what is new since the last delivery goes, capped at 2 KB. Claude's own commands are left out, and a quiet shell costs nothing. A command that has not finished, such as a dev server, is watched instead of waited for: only lines that look like trouble, only since the last delivery, so Claude sees a build break while it is still running.
- **One shared terminal:** by default a pair starts Claude with `--disallowedTools Bash`, so every command it runs goes through `run_in_shell` into the companion terminal, and the policy is `allow`, so it just runs. Commands Seam typed are marked "by Claude" in the shell's header. `SEAM_SHELL_ONLY=0`, or the Shell menu, gives Claude its own Bash back for new pairs; the menu remembers, the env var is for one run.
- **Hooks:
- `hooks/install.ts` writes `seam-hook` and a per-session `--settings` file. The hook forwards its stdin event to the control socket and prints what comes back; no socket, no answer or a bad one all mean print nothing and exit 0, because a hook that fails loudly stalls the user's turn.
- `hooks/auto-sync.ts` builds the digest and remembers what each session has already been told.
- `hooks/router.ts` takes every event: it keeps what each session is doing (working, waiting, idle) and, at the start of a turn, hands over what the user attached followed by the auto sync digest. Only `SessionStart`, `UserPromptSubmit` and `PostToolUse` block, because an async hook's output is never read.

Claude to shell:** a `seam` MCP server over a control socket, with `list_shells`, `read_shell`, `list_commands`, `read_command_output`, `run_in_shell`, `send_keys` and `wait_for_output`. Policy is allow by default, because the shell is shared; `ask`, `allowlist` and `readonly` are there for anyone who wants them. A short denylist always asks, whatever the policy. Every call is audited and shown in the Activity panel.

Next, in order:
1. **Milestone 2 is done** (hooks, status badges, attach mode, auto sync). What is left from Claude to shell: per-command gutter marks. The shell can mark its own commands with OSC 133 through tmux passthrough (verified), but xterm's decorations render at zero size here, most likely because `scrollback: 0` leaves no buffer for a marker to live in; it needs a different approach, or a small scrollback. For now "by Claude" is on the pane header for the latest command and in the Activity panel for all of them.
2. ~~**Claude Code hooks**~~, installed per session with `--settings` (never in the user's repo or global settings): status badges (Working / Waiting for you / Idle) from `UserPromptSubmit`, `Notification`, `PermissionRequest`, `Stop`; **attach mode** (queue shell context, delivered via `UserPromptSubmit` `additionalContext`); **auto sync** (per-pair toggle, digest of new shell activity via `UserPromptSubmit` and `PostToolUse`, capped at 2 KB, errors only for long-running processes). Ignore turn events that carry `agent_id` (subagents). Use `last_assistant_message`, not the transcript file, which lags.
3. **Session browser:** the workspace sidebar is in. Still to do: index `~/.claude/projects/*/*.jsonl` by project and cwd, FTS search, resume into a pair (`claude --resume <id>`, branch with `--fork-session`). Resume needs Seam to pass `--session-id` at launch so it knows which transcript belongs to which tab; it does not yet.

   This is where SQLite earns its place (`better-sqlite3`, WAL, `seam.db` beside the other app-support files): sessions keyed by Claude's own UUID with their transcript path and cwd, command records, an audit log, and message text in an FTS5 table for search. Migrations as numbered SQL run at startup against `PRAGMA user_version`. Two rules carried over from the design: output is stored **by reference**, as line numbers into tmux's history rather than copied text, so a record older than the 50,000-line limit keeps its metadata and is marked scrolled out; and transcripts are read where Claude Code already writes them, never copied or modified.
4. Quick run (Cmd+;) and quick ask (Cmd+'), per-command gutter marks. Packaging is in, unsigned; signing, notarization and auto-update wait on a certificate and a repo.

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

pnpm --filter @seam/desktop bundle:tmux   # copy tmux and its libraries into resources/bin
pnpm --filter @seam/desktop package       # an unsigned .app and .dmg in apps/desktop/release
```

Packaging is unsigned on purpose: Seam is built from source, and notarizing
needs a paid certificate. electron-builder still ad-hoc signs, which is what
Apple Silicon requires to run anything at all. `bundle-tmux.sh` rewrites the
binary's library paths and re-signs it for the same reason; skip it and the
packaged app falls back to tmux on PATH.

Electron 45 has no install script: it fetches its binary the first time something
requires it, so the download lands on the first `pnpm dev`, not on `pnpm install`.

Headless check of the real app, with a screenshot you can read back:

```bash
cd apps/desktop
SEAM_SMOKE_SCREENSHOT=/tmp/seam.png scripts/smoke.sh '(async () => document.body.innerText)()'
```

Shortcuts live in `src/main/menu.ts`. Ctrl+` alternates between Claude and the shell; Cmd+[ and Cmd+] say which side instead, a pair being drawn Claude then shell.

Useful env vars: `SEAM_TMUX_SOCKET` (socket name; dev default `seam-dev`, packaged `seam`), `SEAM_TMUX` (tmux binary), `SEAM_CLAUDE_COMMAND` (JSON argv for the Claude side, e.g. `'["python3","scripts/fake-claude.py"]'` for a stand-in), and for smoke tests `SEAM_SMOKE_MENU` (menu item ids to click) and `SEAM_SMOKE_PICK_FOLDER` (answer for the folder picker).

Settings live in `<userData>/settings.json` (`src/main/settings.ts`): `shellOnly`, the run `policy`, and which sessions have auto sync off. A JSON file rather than the design doc's SQLite, because these are a handful of fields and a native module rebuilt per Electron version is not worth carrying for them; the database arrives with the session browser, which needs one for search. It is also the only way to reach a setting with no UI yet, so it is meant to be hand-edited: every field is validated separately and anything unreadable falls back to its default rather than stopping the app.

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
- A hook `command` is run through a shell by Claude Code, so its path needs quoting: Seam's lives under "Application Support", which unquoted is two words and neither exists.
- The shell is shared, so a command record carries an `actor`. Seam calls `commands.attribute()` before typing, not after, because the shell reports a command the instant it starts and afterwards would race its own record.
- Taking Bash away is all it takes to move Claude onto the paired shell: with no shell tool of its own it reads the seam tool descriptions and uses `run_in_shell`. No prompt engineering was needed, though `--append-system-prompt` saves it a `list_shells` round trip.
- Terminals outlive the app, so anything Seam keeps in memory about a running session has to be recoverable at startup. Control-socket tokens live in the Claude session's own tmux environment and are read back by `adoptRunningSessions`; without that, every session started before the last restart is told "not authorised" for the rest of its life.
- A shell is reachable by Claude only if its `@seam-root` matches the session's. Terminals created before that option existed have an empty root and are invisible to every tool, which is the intended bias: an unreadable root must never widen what a session can see.
- An allowlisted or session-approved prefix only matches a single simple command. Anything carrying `;`, `&`, `|`, a backtick, `$(`, or a redirect always asks, or `git status && rm -rf ~` would ride in on `git status`.
- Cmd+K clears the shell only. Claude's pane is a transcript being read, not a screen someone is done with, and clearing it loses what it said while Claude goes on holding it.
- Clearing a pane takes one of two routes, because neither works for both cases. At a prompt it is `C-l`, which is input: the shell clears and draws its prompt again, so the pane has somewhere to type. Mid-command it is `send-keys -R`, which resets the terminal state without reaching the program, because a `tail -f` handed `C-l` echoes `^L` into its own output instead. `clear-history` follows either way.
- Electron's default macOS menu binds Cmd+W to close the window; Seam installs its own menu.
