# Seam

Seam (working name) is a macOS app where each project's Claude Code sessions and your shells live in one workspace and share context in both directions:

- **Paired workspaces.** A Claude session and its companion shell, side by side, rooted at the same directory, surviving app restarts.
- **Shell to Claude.** Send a command, its exit code and output to Claude in one keystroke, or let auto sync keep Claude informed.
- **Claude to shell.** Claude can see your live shells and run commands in them, behind an approval policy you control.

You can always do the work yourself or hand it to Claude; switching between the two is one keystroke.

## Building it

macOS, Node 22.12 or newer, and tmux (`brew install tmux`).

```bash
pnpm install
pnpm dev
```

To build an app bundle:

```bash
pnpm --filter @seam/desktop bundle:tmux   # optional: makes the app carry its own tmux
pnpm --filter @seam/desktop package       # apps/desktop/release/Seam.dmg
```

The build is unsigned, so the first launch needs right-click > Open, or
`xattr -dr com.apple.quarantine` on the app. Signing and notarization need a
paid Apple certificate; building from source does not.

Without `bundle:tmux` the app uses whatever tmux is on your PATH, and says so
at startup if there is none. It also expects the real `claude` binary on your
PATH and checks its version when it starts.

## Status

**M0, terminal skeleton: done. Paired workspaces and Shell to Claude: in.**

- **Pairs:** Cmd+T picks a project folder and opens Claude Code on the left with a shell on the right, both in that folder, split by a draggable divider. Ctrl+` hops between them.
- **Shell to Claude:** Seam shells (zsh, bash) report every command, its exit code and its output. The shell pane's header shows the last one; "Send to Claude" (or "Ask Claude" after a failure, or Cmd+Shift+Enter) pastes it into Claude's prompt without sending, secrets masked and long output cut to its tail, so you add a note and press Enter.
- Terminal tabs rendered with xterm.js, each backed by a session on Seam's private tmux server.
- Closing a tab keeps the terminal running in the background; quitting the app keeps everything running.
- Relaunching restores the tabs that were open, screens intact. Background terminals can be reopened or ended from the titlebar menu.

The Claude pane runs `claude` through your login shell, so it is found wherever you installed it. If it is missing, the pane says so; when Claude Code exits, the pane becomes a shell.

Shell integration loads after your own startup files (zsh through a Seam-owned ZDOTDIR that sources yours, bash through `--init-file` that replays your login files) and changes nothing on disk outside Seam's data folder.

Next: attach mode and auto sync for Shell to Claude, then Claude to shell.

| Shortcut | Action |
| --- | --- |
| ⌘T | New Claude + shell pair (pick a folder) |
| ⌘⇧T | New shell |
| ⌃` | Switch focus between Claude and the shell |
| ⌘⇧↩ | Send the shell's last command to Claude |
| ⌘W | Close tab (its terminals keep running) |
| ⌘⇧W | End the tab and its terminals |
| ⌘1 to ⌘9 | Switch tabs |

Shortcuts are defined in the application menu, so they also appear under File and Window.

## Requirements

- macOS (Apple Silicon), Node 22.12+, pnpm 10
- tmux 3.3+ (`brew install tmux`). Seam will bundle its own in M5.

`node-pty` ships an N-API prebuild for macOS, so nothing compiles on install and the same binary loads in Electron. A postinstall step marks its `spawn-helper` executable, which the prebuild omits.

## Develop

```bash
pnpm install
pnpm dev        # launch the app with hot reload
pnpm test       # unit and integration tests (drive a real, throwaway tmux server)
pnpm typecheck
pnpm build
```

Seam's tmux server lives at `~/Library/Application Support/Seam/tmux/<name>.sock`, outside `/tmp` (which macOS cleans periodically). Dev builds use the name `seam-dev`; packaged builds use `seam`. Set `SEAM_TMUX_SOCKET` to use another name, and `SEAM_TMUX` to point at a specific tmux binary.

To inspect the private server directly:

```bash
tmux -S ~/Library/Application\ Support/Seam/tmux/seam-dev.sock ls
```

### A stand-in for Claude Code

Where Claude Code cannot sign in (CI, sandboxes), run new pairs with a stand-in that shows a prompt and echoes what is pasted:

```bash
SEAM_CLAUDE_COMMAND='["python3", "scripts/fake-claude.py"]' pnpm dev
```

### Headless smoke test

`apps/desktop/scripts/smoke.sh '<js expression>'` builds the app, launches it, evaluates the expression in the renderer, prints the result as JSON and quits. Set `SEAM_SMOKE_SCREENSHOT=/path/out.png` to also capture the window. On Linux it runs under `xvfb-run`.

### Building on Linux

There is no Linux prebuild for `node-pty`, so it compiles from source. If `node-gyp` cannot download Node headers (offline or sandboxed), point it at the local Node install:

```bash
npm_config_nodedir="$(dirname "$(dirname "$(which node)")")" pnpm install
```

## Layout

```text
apps/desktop/
  src/main/          Electron main: tmux wrapper, terminal service, IPC
  src/preload/       typed bridge exposed as window.seam
  src/renderer/      React UI, xterm.js tabs
  src/shared/        IPC contract shared by all three
  test/              vitest unit and integration tests
packages/            shared packages (added as milestones need them)
```

See the design doc for architecture and milestones.
