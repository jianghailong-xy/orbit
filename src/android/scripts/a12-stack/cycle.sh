#!/usr/bin/env bash
# One resumable live cycle into one evidence directory: a freshly seeded stack, then live.sh.
# Usage: cycle.sh APP_APK TEST_APK EVIDENCE_DIR [SERIAL]
# Run the same command again after an interruption (a session recycle kills background jobs) and it resumes: the
# stack is seeded once per evidence directory (the seed it made is recorded there as .seeded), its apiserver and
# runner are started again if they are gone (the database lives in the container), and live.sh skips the journeys
# that already have a result. A12_STACK_DIR / A12_STACK_API_PORT as for setup.sh.
set -euo pipefail

die() { echo "cycle.sh: $*" >&2; exit 2; }
(( $# == 3 || $# == 4 )) || die "usage: $0 APP_APK TEST_APK EVIDENCE_DIR [SERIAL]"
here=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
S=$(realpath -m "${A12_STACK_DIR:-/var/tmp/a12-stack}")
export A12_STACK_DIR=$S A12_STACK_API_PORT=${A12_STACK_API_PORT:-3712}
out=$(realpath -m "$3")
seeded() { node -e 'console.log(require(process.argv[1]).createdAt)' "$S/seed.json"; }

mkdir -p "$out"
if [[ ! -f "$out/.seeded" ]]; then
  # New, empty, or a cycle cut off before it recorded its seed (then only its own setup files are there).
  extra=$(find "$out" -mindepth 1 -maxdepth 1 ! -name .a12-live ! -name stack-build.log ! -name stack-reset.log -print -quit)
  [[ -z "$extra" ]] || die "$out holds a run with no seed of its own: use a new evidence directory"
  touch "$out/.a12-live"
  if [[ ! -f "$S/src/src/apiserver/dist/main.js" || ! -x "$S/bin/orbit" ]]; then
    bash "$here/setup.sh" build > "$out/stack-build.log" 2>&1
  fi
  bash "$here/setup.sh" reset > "$out/stack-reset.log" 2>&1
  seeded > "$out/.seeded"
else
  [[ "$(seeded)" == "$(cat "$out/.seeded")" ]] || die "the stack was seeded again since $out began: start a new evidence directory"
  { echo "== resumed $(date -u +%FT%TZ)"; bash "$here/setup.sh" start; } >> "$out/stack-reset.log" 2>&1
fi
# The seeded objects must still be there (a removed container takes them): both accounts sign in and read them.
node "$here/readback.mjs" cycle-check > /dev/null || die "the stack no longer holds the seed of $out: start a new evidence directory"
exec bash "$here/live.sh" "$1" "$2" "$out" "${4:-emulator-5554}"
