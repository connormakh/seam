# Seam

Seam (working name) is a macOS app where each project's Claude Code sessions and your shells live in one workspace and share context in both directions:

- **Paired workspaces.** A Claude session and its companion shell, side by side, rooted at the same directory, surviving app restarts.
- **Shell to Claude.** Send a command, its exit code and output to Claude in one keystroke, or let auto sync keep Claude informed.
- **Claude to shell.** Claude can see your live shells and run commands in them, behind an approval policy you control.

You can always do the work yourself or hand it to Claude; switching between the two is one keystroke.

## Status

Milestone M0: terminal skeleton. One Electron window, terminal tabs backed by a private tmux server, tabs survive quitting the app.

## Requirements

- macOS (Apple Silicon), Node 22.12+, pnpm 10
- tmux 3.3+ on your PATH for now (`brew install tmux`); Seam will bundle its own later
- Xcode Command Line Tools (to build `node-pty`)

## Develop

```bash
pnpm install
pnpm dev        # launch the app with hot reload
pnpm test       # unit and integration tests (needs tmux)
pnpm typecheck
```

## Layout

```text
apps/desktop/        Electron app (main, preload, renderer)
packages/            shared packages (added as milestones need them)
```

See the design doc for architecture and milestones.
