#!/usr/bin/env python3
"""Stand-in for Claude Code, for headless demos and smoke tests only.

Run it via SEAM_CLAUDE_COMMAND='["python3", "scripts/fake-claude.py"]'. It
turns on bracketed paste like Claude Code, shows a prompt, and echoes what
it is given, so Seam's Shell to Claude path can be exercised where the real
Claude Code cannot sign in. It never sends anything anywhere.
"""
import os
import sys
import tty

DIM, BOLD, ORANGE, RESET = "\x1b[2m", "\x1b[1m", "\x1b[38;5;173m", "\x1b[0m"


def out(s: str) -> None:
    sys.stdout.write(s)
    sys.stdout.flush()


def prompt(buffer: str) -> None:
    lines = buffer.split("\n") if buffer else [""]
    out("\x1b[2J\x1b[H")
    out(f"{ORANGE}{BOLD}✻ Claude Code{RESET} {DIM}(stand-in for this demo; the real one cannot sign in here){RESET}\r\n\r\n")
    out(f"{DIM}cwd: {os.getcwd()}{RESET}\r\n\r\n")
    width = 72
    out(f"{DIM}╭{'─' * width}╮{RESET}\r\n")
    for i, line in enumerate(lines):
        lead = "> " if i == 0 else "  "
        out(f"{DIM}│{RESET} {lead}{line[: width - 4]}\r\n")
    out(f"{DIM}╰{'─' * width}╯{RESET}\r\n")
    out(f"{DIM}  ? for shortcuts{RESET}")


def main() -> None:
    out("\x1b[?2004h")  # bracketed paste on, as Claude Code does
    tty.setraw(0)
    buffer = ""
    prompt(buffer)
    pending = b""
    while True:
        data = os.read(0, 65536)
        if not data:
            return
        pending += data
        text = pending.decode("utf8", "ignore")
        pending = b""
        text = text.replace("\x1b[200~", "").replace("\x1b[201~", "")
        for ch in text:
            if ch in ("\x03", "\x04"):
                return
            if ch == "\x7f":
                buffer = buffer[:-1]
            elif ch == "\r":
                buffer += "\n"
            elif ch >= " " or ch == "\t":
                buffer += ch
        prompt(buffer)


if __name__ == "__main__":
    main()
