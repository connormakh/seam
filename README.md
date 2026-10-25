# Seam

Seam (working name) is a macOS app where each project's Claude Code sessions and your shells live in one workspace and share context in both directions:

- **Paired workspaces.** A Claude session and its companion shell, side by side, rooted at the same directory, surviving app restarts.
- **Shell to Claude.** Send a command, its exit code and output to Claude in one keystroke, or let auto sync keep Claude informed.
- **Claude to shell.** Claude can see your live shells and run commands in them, behind an approval policy you control.

You can always do the work yourself or hand it to Claude; switching between the two is one keystroke.

## Status

**M0, terminal skeleton: done.**

- Terminal tabs rendered with xterm.js, each backed by a session on Seam's private tmux server.
- Closing a tab keeps the terminal running in the background; quitting the app keeps everything running.
- Relaunching restores the tabs that were open, screens intact. Background terminals can be reopened or ended from the titlebar menu.

Next: M1, the Claude Code session browser.

| Shortcut | Action |
| --- | --- |
| ⌘T | New shell |
| ⌘W | Close tab (terminal keeps running) |
| ⌘⇧W | End the terminal |
| ⌘1 to ⌘9 | Switch tabs |

## Requirements

- macOS (Apple Silicon), Node 22.12+, pnpm 10
- tmux 3.3+ (`brew install tmux`). Seam will bundle its own in M5.

`node-pty` ships an N-API prebuild for macOS, so nothing compiles on install and the same binary loads in Electron.

## Develop

```bash
pnpm install
pnpm dev        # launch the app with hot reload
pnpm test       # unit and integration tests (drive a real, throwaway tmux server)
pnpm typecheck
pnpm build
```

Dev builds use the tmux socket `seam-dev`; packaged builds use `seam`. Set `SEAM_TMUX_SOCKET` to use another, and `SEAM_TMUX` to point at a specific tmux binary.

To inspect the private server directly: `tmux -L seam-dev ls`.

### Headless smoke test

`apps/desktop/scripts/smoke.sh '<js expression>'` builds the app, launches it, evaluates the expression in the renderer, prints the result as JSON and quits. Set `SEAM_SMOKE_SCREENSHOT=/path/out.png` to also capture the window. On Linux it runs under `xvfb-run`.

### Building on Linux

There is no Linux prebuild for `node-pty`, so it compiles from source. If `node-gyp` cannot download Node headers (offline or sandboxed), point it at a local Node install: `cd node_modules/node-pty && npx node-gyp rebuild --nodedir="$(dirname "$(dirname "$(which node)")")"`.

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
