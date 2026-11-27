#!/usr/bin/env bash
# Runs the web driver against this checkout's web source (needs node_modules in place) and writes
# capture/web-rows.json. The driver and rules are copied in for the run and removed afterwards.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
lib="$root/src/web/src/lib"
cp "$here/web-rows.test.tsx" "$lib/board-web-rows.test.tsx"
cp "$here/rules.mjs" "$lib/board-rules.mjs"
trap 'rm -f "$lib/board-web-rows.test.tsx" "$lib/board-rules.mjs"' EXIT
cd "$root/src/web"
FIXTURE="$here/../fixture.json" OUT="$here/web-rows.json" npx vitest run src/lib/board-web-rows.test.tsx --testTimeout=120000
