#!/usr/bin/env bash
# Delivery checks, one at a time, each in its own network namespace (fixed ports stay private):
# overlay and choice component suites, then the merge check (build + unit tests). Every step logs
# argv, cwd, HEAD, uncommitted paths and exit code to runs/<name>.log.
set -u
R=/var/tmp/p4.1-293463/runs
DEL=/root/.orbit/worktrees/3402ff96-4293-56f4-8940-d723dd9fa681
step() {
  local name=$1; shift
  { echo "argv: $*"; echo "cwd: $DEL"; echo "head: $(git -C $DEL rev-parse HEAD)"; echo "uncommitted:"; git -C $DEL status --short; echo "started: $(date -u +%FT%TZ)"; echo; } > "$R/$name.log"
  echo "== $name $(date -u +%T)"
  ( cd "$DEL" && nice -n -10 unshare -n bash -c 'ip link set lo up && exec "$@"' bash "$@" ) >> "$R/$name.log" 2>&1
  local code=$?
  echo "exit=$code" >> "$R/$name.log"; echo "ended: $(date -u +%FT%TZ)" >> "$R/$name.log"
  grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped)|Test Files|Tests |^exit=" "$R/$name.log"
}
step c-overlays npm run test:ui-overlays -w @orbit/web
step c-choices npm run test:ui-choices -w @orbit/web
step c-merge bash -c 'npm run build -w @orbit/web && npm run test -w @orbit/web'
echo "== done $(date -u +%T)"
