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
  # An if, not &&: a false && is a non-zero status, which set -e would act on.
  if [[ "$(id -u)" == "0" ]]; then extra=(--no-sandbox); fi
fi

# ${a[@]+"${a[@]}"} and not "${a[@]}": with set -u, bash 3.2 (what macOS ships)
# calls an empty array unbound. ELECTRON_RUN_AS_NODE is inherited from editors
# that are themselves Electron apps, and makes electron run as plain node.
env -u ELECTRON_RUN_AS_NODE SEAM_SMOKE_TEST="$script" ${runner[@]+"${runner[@]}"} \
  npx electron ${extra[@]+"${extra[@]}"} . 2>/dev/null | grep '^SMOKE:' | sed 's/^SMOKE://'
