#!/usr/bin/env bash
# F-P7-1 acceptance: a runner built from this tree declares dsh whether or not the pinned CLI is installed, so the
# server reads its engine report. Upgraded but not installed, creating or resuming a Harness session through the real
# apiserver (PostgreSQL) is refused with the not-installed notice and a persisted session's follow-up waits instead of
# being claimed and failed; after the install through Orbit the same sessions and a new one run on the pinned dsh
# 0.2.0-rc.2 against a local mock model. Named scenarios: scripts/test-dsh-install-gate.mjs.
#
#   bash scripts/test-dsh-install-gate.sh
#
# Red on any build or startup failure, and on any required scenario that is missing, renamed, skipped or failed:
# the .mjs exits non-zero unless its report names exactly the required scenarios, each PASS.
# DSH_INSTALL_GATE_KEEP=<dir> keeps the logs (apiserver, runner, model requests, report.json) there.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 2
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/dsh-install-gate.XXXXXX")"
PG_NAME="dsh-install-gate-pg-$$-$RANDOM"
cleanup() {
  docker rm -f -v "$PG_NAME" >/dev/null 2>&1 || true
  if [ -n "${DSH_INSTALL_GATE_KEEP:-}" ]; then
    mkdir -p "$DSH_INSTALL_GATE_KEEP" && cp -a "$SCRATCH/logs" "$SCRATCH/report.json" "$DSH_INSTALL_GATE_KEEP/" 2>/dev/null
  fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
die() { echo "test-dsh-install-gate: $*" >&2; exit 1; }

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
for name in $(compgen -e | grep -E '^(ORBIT_|CLAUDE|ANTHROPIC_|OPENAI_|DEEPSEEK|DSH_)' | grep -v '^DSH_INSTALL_GATE_'); do unset "$name"; done
DSH_INSTALL_GATE_REPO="$REPO" DSH_INSTALL_GATE_SCRATCH="$SCRATCH" DSH_INSTALL_GATE_RUNNER_BINARY="$SCRATCH/bin/orbit" \
DSH_INSTALL_GATE_PRISMA="$PRISMA" DSH_INSTALL_GATE_PG_NAME="$PG_NAME" NODE_OPTIONS='' \
  node "$REPO/scripts/test-dsh-install-gate.mjs"
rc=$?
[ "$rc" = 0 ] || echo "test-dsh-install-gate: RED (exit $rc)" >&2
exit "$rc"
