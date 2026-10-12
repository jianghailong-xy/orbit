#!/usr/bin/env bash
# D3 acceptance: a DeepSeek Harness task whose completion criterion is EXECUTABLE runs through the real apiserver
# (PostgreSQL) and a runner built from this tree, on the pinned dsh 0.2.0-rc.2 against a local mock model; its
# acceptance command is run by the runner in the worktree (never by dsh or the model) and derives DONE / FAILED,
# a person's `!` shell on a Harness session is still refused, and Claude's EXECUTABLE path is unchanged.
# Named scenarios: scripts/test-dsh-executable-acceptance.mjs.
#
#   bash scripts/test-dsh-executable-acceptance.sh
#
# Red on any build or startup failure, and on any required scenario that is missing, renamed, skipped or failed:
# the .mjs exits non-zero unless its report names exactly the required scenarios, each PASS.
# DSH_EXEC_ACC_KEEP=<dir> keeps the logs (apiserver, runner, model requests, report.json) there.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 2
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/dsh-executable-acceptance.XXXXXX")"
PG_NAME="dsh-exec-acc-pg-$$-$RANDOM"
cleanup() {
  docker rm -f -v "$PG_NAME" >/dev/null 2>&1 || true
  if [ -n "${DSH_EXEC_ACC_KEEP:-}" ]; then
    mkdir -p "$DSH_EXEC_ACC_KEEP" && cp -a "$SCRATCH/logs" "$SCRATCH/report.json" "$DSH_EXEC_ACC_KEEP/" 2>/dev/null
  fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
die() { echo "test-dsh-executable-acceptance: $*" >&2; exit 1; }

for tool in node npm go docker; do command -v "$tool" >/dev/null || die "$tool is required"; done
docker info >/dev/null 2>&1 || die "docker is not usable"

echo "==> worktree overlay (dependencies, this branch's Prisma client)"
bash "$REPO/scripts/worktree-overlay.sh" > "$SCRATCH/overlay.log" 2>&1 || { cat "$SCRATCH/overlay.log"; die "worktree overlay failed"; }
PRISMA="$REPO/src/apiserver/node_modules/.bin/prisma"; [ -x "$PRISMA" ] || PRISMA="$REPO/node_modules/.bin/prisma"
[ -x "$PRISMA" ] || die "no prisma after the overlay"

echo "==> build @orbit/shared and @orbit/apiserver"
( npm run build -w @orbit/shared && npm run build -w @orbit/apiserver ) > "$SCRATCH/build.log" 2>&1 \
  || { tail -40 "$SCRATCH/build.log"; die "build failed"; }
[ -f "$REPO/src/apiserver/dist/main.js" ] || die "the build left no src/apiserver/dist/main.js"

echo "==> go build the runner from this tree"
( cd "$REPO/src/runner-go" && GOFLAGS=-buildvcs=false go build -o "$SCRATCH/bin/orbit" . ) > "$SCRATCH/go-build.log" 2>&1 \
  || { cat "$SCRATCH/go-build.log"; die "go build failed"; }

mkdir -p "$SCRATCH/logs"
for name in $(compgen -e | grep -E '^(ORBIT_|CLAUDE|ANTHROPIC_|OPENAI_|DEEPSEEK|DSH_)' | grep -v '^DSH_EXEC_ACC_'); do unset "$name"; done
DSH_EXEC_ACC_REPO="$REPO" DSH_EXEC_ACC_SCRATCH="$SCRATCH" DSH_EXEC_ACC_RUNNER_BINARY="$SCRATCH/bin/orbit" \
DSH_EXEC_ACC_PRISMA="$PRISMA" DSH_EXEC_ACC_PG_NAME="$PG_NAME" NODE_OPTIONS='' \
  node "$REPO/scripts/test-dsh-executable-acceptance.mjs"
rc=$?
[ "$rc" = 0 ] || echo "test-dsh-executable-acceptance: RED (exit $rc)" >&2
exit "$rc"
