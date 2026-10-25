#!/usr/bin/env bash
# Build the app, launch it headlessly, run a script in the renderer, print the result.
# Usage: scripts/smoke.sh ['<js expression>']
# Linux needs xvfb-run; on macOS the window flashes briefly instead.
set -euo pipefail
cd "$(dirname "$0")/.."

script="${1:-document.body.innerText}"
npx electron-vite build >/dev/null

runner=()
extra=()
if [[ "$(uname)" == "Linux" ]]; then
  runner=(xvfb-run -a)
  # Containers usually run as root, where Chromium's sandbox cannot start.
  [[ "$(id -u)" == "0" ]] && extra=(--no-sandbox)
fi

SEAM_SMOKE_TEST="$script" "${runner[@]}" npx electron "${extra[@]}" . 2>/dev/null | grep '^SMOKE:' | sed 's/^SMOKE://'
