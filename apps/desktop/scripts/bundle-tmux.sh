#!/usr/bin/env bash
# Copy tmux and the libraries it needs into resources/bin, rewriting the
# paths so it runs on a machine with no Homebrew.
#
# Seam is a terminal app that cannot work without tmux, and a packaged app
# cannot assume the user has it. Building from source without running this
# is fine: Seam falls back to tmux on PATH and says so at startup if there
# is none.
#
# Usage: scripts/bundle-tmux.sh [path-to-tmux]
set -euo pipefail
cd "$(dirname "$0")/.."

src="${1:-$(command -v tmux || true)}"
if [[ -z "$src" || ! -x "$src" ]]; then
  echo "no tmux found. Install one (brew install tmux) or pass a path." >&2
  exit 1
fi

dest="resources/bin"
rm -rf "$dest"
mkdir -p "$dest"
cp "$src" "$dest/tmux"
chmod u+w "$dest/tmux"

# Anything outside /usr/lib and /System is not on the target machine.
deps_of() {
  otool -L "$1" | tail -n +2 | awk '{print $1}' | grep -Ev '^(/usr/lib|/System)/' || true
}

# Breadth first, because a library Seam copies can need libraries of its own.
queue=("$dest/tmux")
while [[ ${#queue[@]} -gt 0 ]]; do
  current="${queue[0]}"
  queue=("${queue[@]:1}")
  while read -r lib; do
    [[ -z "$lib" ]] && continue
    base="$(basename "$lib")"
    target="$dest/$base"
    if [[ ! -f "$target" ]]; then
      # A missing library is not something to paper over: the bundle would
      # look fine here and fail on someone else's machine.
      [[ -f "$lib" ]] || { echo "missing dependency: $lib" >&2; exit 1; }
      cp "$lib" "$target"
      chmod u+w "$target"
      install_name_tool -id "@executable_path/$base" "$target" 2>/dev/null
      queue+=("$target")
    fi
    install_name_tool -change "$lib" "@executable_path/$base" "$current" 2>/dev/null
  done < <(deps_of "$current")
done

# Rewriting a binary invalidates its signature, and on Apple Silicon the
# kernel will not run an unsigned one at all. Ad-hoc is free and enough:
# signing the app properly is a separate question, with a certificate.
for file in "$dest"/*; do
  codesign --force --sign - "$file" 2>/dev/null
done

# It has to actually run, and say the version Seam parses at startup.
version="$("$dest/tmux" -V)"
remaining="$(deps_of "$dest/tmux" | grep -v '^@executable_path/' || true)"
if [[ -n "$remaining" ]]; then
  echo "tmux still needs libraries from outside the bundle:" >&2
  echo "$remaining" >&2
  exit 1
fi

echo "bundled $version from $src"
ls -1 "$dest" | sed 's/^/  /'
