#!/usr/bin/env bash
# The fast gate: the three checks a change is answerable for on its own branch, in seconds.
#
# It exists because the full API acceptance was being spent in the wrong place. Every task ran all
# of it -- one disposable PostgreSQL database and role per case, every migration replayed, tens of
# minutes -- to learn something about a change that touched one directory, while the failures that
# actually happened were merge-boundary failures the branch run could not see anyway.
#
# So the tiers are: this gate answers "is my own change coherent", the full run answers "is the
# tree still good", and the release DAG answers "is this releasable". It is NOT a substitute for
# the full run, and it says so in its own output, every time, because the whole risk of having a
# cheap gate is that somebody merges on it.
#
#   npm run test:outcome-reconciler:fast-gate            run it
#   npm run test:outcome-reconciler:fast-gate -- --dry-run   print what it would run, run nothing
#
# ORBIT_FAST_GATE_SPECS adds specs by regular expression, for a change whose blast radius is wider
# than its own directory.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
BUDGET="${ORBIT_FAST_GATE_BUDGET_SECONDS:-90}"
DRY_RUN=0
STARTED_AT="$(date +%s)"

for ARGUMENT in "$@"; do
  case "$ARGUMENT" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "usage: outcome-reconciler-fast-gate.sh [--dry-run]" >&2; exit 2 ;;
  esac
done

# Always printed, on the way out of every path including the failing ones: a gate that is cheap
# enough to run constantly is exactly the one whose limits get forgotten.
announce_boundary() {
  echo '==> fast-gate: this gate is scoped to the change on this branch. It is NOT a merge gate.'
  echo '==> fast-gate: before merging, run the full acceptance once:'
  echo '==>            npm run test:outcome-reconciler:full-api'
}
trap announce_boundary EXIT

# ---------------------------------------------------------------------------------------------
# Stage 1: build orphans.
#
# `tsc --build --clean` cannot remove the output of a source file that no longer exists -- the
# build info it consults has no record of a file the current include set never saw. The full run
# enumerates `build/**/*.spec.js`, so every stale artifact is an extra case, run against a tree
# that no longer contains the thing it tests. Three of them turned into three phantom reds in one
# evening. This has to come first: every later stage reads the same directory.
# ---------------------------------------------------------------------------------------------
echo '==> fast-gate [1/3]: build orphans'
ORPHANS=()
if [ -d "$API/build" ]; then
  while IFS= read -r ARTIFACT; do
    RELATIVE="${ARTIFACT#"$API/build/"}"
    [ -f "$API/src/${RELATIVE%.js}.ts" ] || ORPHANS+=("$RELATIVE")
  done < <(find "$API/build" -path "$API/build/node_modules" -prune -o -type f -name '*.js' -print | sort)
fi
if [ "${#ORPHANS[@]}" -gt 0 ]; then
  echo "==> fast-gate: ${#ORPHANS[@]} compiled artifact(s) have no source; the full run would run them as cases:" >&2
  printf '    %s\n' "${ORPHANS[@]}" >&2
  echo "==> fast-gate: remove them with: rm -rf $API/build" >&2
  [ "$DRY_RUN" = 1 ] || exit 1
fi
echo "==> fast-gate: no orphaned build artifacts"

# ---------------------------------------------------------------------------------------------
# Stage 3's selection, computed before stage 2 so `--dry-run` can print the whole plan.
#
# Changed against the merge base rather than against `origin/main` itself: what this change is
# answerable for is what it did, not how far the branch has drifted behind.
# ---------------------------------------------------------------------------------------------
BASE="$(git -C "$REPO" merge-base HEAD origin/main 2>/dev/null || true)"
[ -n "$BASE" ] || BASE=HEAD
mapfile -t CHANGED < <({
  git -C "$REPO" diff --name-only "$BASE" --
  git -C "$REPO" ls-files --others --exclude-standard
} | sort -u)

mapfile -t SELECTED < <(
  printf '%s\n' "${CHANGED[@]}" | node "$REPO/scripts/outcome-reconciler-fast-gate-select.mjs"
)
if [ -n "${ORBIT_FAST_GATE_SPECS:-}" ]; then
  mapfile -t SELECTED < <({
    printf '%s\n' "${SELECTED[@]}"
    ( cd "$REPO" && find src/apiserver/src -mindepth 2 -maxdepth 2 -type f -name '*.spec.ts' ) \
      | grep -E "$ORBIT_FAST_GATE_SPECS" || true
  } | grep -v '^$' | sort -u)
fi

# A .pg spec needs the disposable server the full run provisions, and every one of them reports
# itself skipped without it. Running them here would turn "no database" into a green.
RUNNABLE=()
DEFERRED=()
for SPEC in "${SELECTED[@]}"; do
  [ -n "$SPEC" ] || continue
  if [[ "$SPEC" == *.pg.spec.ts ]]; then DEFERRED+=("$SPEC"); else RUNNABLE+=("$SPEC"); fi
done

if [ "$DRY_RUN" = 1 ]; then
  echo "==> fast-gate: plan for ${#CHANGED[@]} changed path(s) against ${BASE:0:12}"
  echo "==> fast-gate: stage 2 would run: tsc -p tsconfig.outcome-reconciler.json --noEmit"
  echo "==> fast-gate: stage 3 would run ${#RUNNABLE[@]} spec(s)"
  [ "${#RUNNABLE[@]}" = 0 ] || printf '    run      %s\n' "${RUNNABLE[@]}"
  [ "${#DEFERRED[@]}" = 0 ] || printf '    deferred %s\n' "${DEFERRED[@]}"
  exit 0
fi

# ---------------------------------------------------------------------------------------------
# Stage 2: types, against the same isolated Prisma Client the full run compiles against.
#
# `tsconfig.test.json` resolves `@prisma/client` through node_modules, which a worktree shares with
# the main checkout -- so a `prisma generate` in ANY concurrent session replaces it, and this gate
# goes red over models this tree never touched. That happened while this gate was being written:
# twenty errors, none of them about the change, on a tree the full run then passed 361/361. A gate
# that can be turned red by somebody else's schema is a gate people learn to ignore, so it reads
# the client generated from THIS tree's schema, exactly as the full run does.
#
# --noEmit on purpose: this stage must not be able to leave an artifact behind, because stage 1 is
# the thing that notices artifacts. The generated client lives under `build/node_modules`, which
# stage 1 prunes.
# ---------------------------------------------------------------------------------------------
echo '==> fast-gate [2/3]: tsc --noEmit'
CLIENT="$API/build/node_modules/@prisma/client"
if [ ! -f "$CLIENT/index.d.ts" ] || [ "$API/prisma/schema.prisma" -nt "$CLIENT/index.d.ts" ]; then
  echo '    generating the isolated Prisma Client for this tree'
  node "$REPO/scripts/outcome-reconciler-isolated-prisma-schema.mjs" \
    "$API/prisma/schema.prisma" "$API/build/outcome-reconciler-prisma.schema.prisma" "$CLIENT"
  ( cd "$API" && ./node_modules/.bin/prisma format \
    --schema build/outcome-reconciler-prisma.schema.prisma >/dev/null )
  ( cd "$API" && ./node_modules/.bin/prisma generate \
    --schema build/outcome-reconciler-prisma.schema.prisma >/dev/null )
fi
( cd "$REPO" && npm run build -w @orbit/shared >/dev/null )
( cd "$API" && ./node_modules/.bin/tsc -p tsconfig.outcome-reconciler.json --noEmit )

# ---------------------------------------------------------------------------------------------
# Stage 3: the specs this change is answerable for.
# ---------------------------------------------------------------------------------------------
echo "==> fast-gate [3/3]: ${#RUNNABLE[@]} change-scoped spec(s), ${#DEFERRED[@]} deferred to the full run"
if [ "${#DEFERRED[@]}" -gt 0 ]; then
  printf '    deferred (needs the disposable server): %s\n' "${DEFERRED[@]}"
fi
if [ "${#RUNNABLE[@]}" -gt 0 ]; then
  printf '    %s\n' "${RUNNABLE[@]}"
  ( cd "$API" && ./node_modules/.bin/tsc -p tsconfig.outcome-reconciler.json )
  COMPILED=()
  for SPEC in "${RUNNABLE[@]}"; do
    RELATIVE="${SPEC#src/apiserver/src/}"
    COMPILED+=("$API/build/${RELATIVE%.ts}.js")
  done
  ( cd "$API" && node --test --test-concurrency=1 --test-reporter=tap "${COMPILED[@]}" )
else
  echo '    (no spec belongs to this change; the full run is the only thing that covers it)'
fi

ELAPSED=$(( $(date +%s) - STARTED_AT ))
echo "==> fast-gate: PASSED elapsed=${ELAPSED}s budget=${BUDGET}s"
if [ "$ELAPSED" -gt "$BUDGET" ]; then
  # Reported rather than enforced: a wall clock that fails the gate makes a loaded host look like
  # a broken change, and the one thing this gate must never do is teach anybody to ignore it.
  echo "==> fast-gate: OVER BUDGET by $((ELAPSED - BUDGET))s -- it is meant to stay under ${BUDGET}s" >&2
fi
