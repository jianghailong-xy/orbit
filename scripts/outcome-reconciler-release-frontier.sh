#!/usr/bin/env bash
# Unique release-frontier acceptance. Every independent-verifier entrypoint is executed, followed
# by the complete API/Web/Go/Swift matrices and the remote/deployment evidence gates. No filtering,
# skip allowance, or stale-manifest reuse is accepted.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$REPO/build"
PHASE="${OUTCOME_RELEASE_FRONTIER_PHASE:-final}"
if [ "$PHASE" != final ] && [ "$PHASE" != prebinding ]; then
  echo "invalid OUTCOME_RELEASE_FRONTIER_PHASE: $PHASE" >&2
  exit 2
fi

TARGET_SHA="$(git -C "$REPO" rev-parse HEAD)"
if [ -n "$(git -C "$REPO" status --short --untracked-files=no)" ]; then
  echo 'release-frontier requires a tracked-clean checkout' >&2
  exit 2
fi

LOG_DIR="$BUILD/outcome-reconciler-release-frontier-logs-$PHASE"
LEDGER="$BUILD/outcome-reconciler-release-frontier-$PHASE.tsv"
OUTPUT="$BUILD/outcome-reconciler-release-frontier-manifest.json"
if [ "$PHASE" = prebinding ]; then
  OUTPUT="$BUILD/outcome-reconciler-release-frontier-prebinding-manifest.json"
fi
WORKER_BASE="${OUTCOME_RELEASE_WORKER_ROOT:-/root/.orbit/release-frontier-workers}"
RUN_TOKEN="${PHASE}-$(date -u +%Y%m%dT%H%M%SZ)-$$"

mkdir -p "$BUILD" "$LOG_DIR" "$WORKER_BASE"
: > "$LEDGER"
# A killed run must never leave an earlier PASS at the canonical output path.
rm -f -- "$OUTPUT"
RESULT_DIR="$(mktemp -d "$BUILD/outcome-reconciler-release-frontier-results.XXXXXX")"

declare -a WORKERS=()
declare -a LANE_PIDS=()

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  local pid worker
  for pid in "${LANE_PIDS[@]}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  for pid in "${LANE_PIDS[@]}"; do
    wait "$pid" >/dev/null 2>&1 || true
  done
  for worker in "${WORKERS[@]}"; do
    git -C "$REPO" worktree remove --force "$worker" >/dev/null 2>&1 || true
  done
  if [[ "$RESULT_DIR" == "$BUILD"/outcome-reconciler-release-frontier-results.* ]]; then
    rm -rf -- "$RESULT_DIR"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

prepare_worker() {
  local lane="$1"
  local worker="$WORKER_BASE/$RUN_TOKEN-$lane"
  local dependency base
  [ ! -e "$worker" ] || {
    echo "release-frontier worker already exists: $worker" >&2
    return 1
  }
  git -C "$REPO" worktree add --detach "$worker" "$TARGET_SHA" >/dev/null
  WORKERS+=("$worker")

  # Root dependencies are immutable inputs. Rebuild the workspace links so imports resolve to this
  # worker's exact checkout rather than to the deployment checkout behind the shared npm install.
  mkdir -p "$worker/node_modules/@orbit"
  while IFS= read -r -d '' dependency; do
    base="${dependency##*/}"
    case "$base" in
      @orbit|.cache|.vite|.vite-temp) continue ;;
    esac
    ln -s "$dependency" "$worker/node_modules/$base"
  done < <(find "$(readlink -f "$REPO/node_modules")" -mindepth 1 -maxdepth 1 -print0)
  ln -s ../../src/shared "$worker/node_modules/@orbit/shared"
  ln -s ../../src/apiserver "$worker/node_modules/@orbit/apiserver"
  ln -s ../../src/web "$worker/node_modules/@orbit/web"

  # Prisma generate mutates both @prisma/client and .prisma. Each lane gets private copies so two
  # real generators can never race merely because all task worktrees share the installed packages.
  local api_modules web_modules
  api_modules="$(readlink -f "$REPO/src/apiserver/node_modules")"
  web_modules="$(readlink -f "$REPO/src/web/node_modules")"
  mkdir -p "$worker/src/apiserver/node_modules/.cache"
  ln -s "$api_modules/.bin" "$worker/src/apiserver/node_modules/.bin"
  ln -s "$api_modules/prisma" "$worker/src/apiserver/node_modules/prisma"
  ln -s "$api_modules/typescript" "$worker/src/apiserver/node_modules/typescript"
  cp -a --reflink=auto "$api_modules/@prisma" "$worker/src/apiserver/node_modules/@prisma"
  cp -a --reflink=auto "$api_modules/.prisma" "$worker/src/apiserver/node_modules/.prisma"
  cp -a --reflink=auto "$web_modules" "$worker/src/web/node_modules"
  mkdir -p "$worker/src/shared/node_modules/.vite"

  PREPARED_WORKER="$worker"
}

copy_fresh_evidence() {
  local worker="$1"
  local relative="$2"
  local source="$worker/$relative"
  local destination="$REPO/$relative"
  if [ ! -s "$source" ]; then
    echo "fresh evidence is missing after execution: $relative" >&2
    return 1
  fi
  mkdir -p "$(dirname "$destination")"
  cp -f -- "$source" "$destination"
}

record_result() {
  local name="$1"
  local rc="$2"
  local started_at="$3"
  local finished_at="$4"
  printf '%s\n' "$rc" > "$RESULT_DIR/$name.rc"
  printf '%s\t%s\n' "$started_at" "$finished_at" > "$RESULT_DIR/$name.window"
}

run_worker_npm() {
  local worker="$1"
  local lane="$2"
  local name="$3"
  local package_script="$4"
  shift 4
  local manifests=("$@")
  local log_relative="build/$(basename "$LOG_DIR")/${name}.log"
  local log="$REPO/$log_relative"
  local started_at finished_at rc manifest
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "==> release-frontier [$PHASE/$lane]: $name ($package_script)"
  set +e
  (
    cd "$worker"
    npm run "$package_script"
  ) 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  set -e
  if [ "$rc" -eq 0 ]; then
    for manifest in "${manifests[@]}"; do
      if ! copy_fresh_evidence "$worker" "$manifest"; then
        rc=66
      fi
    done
  fi
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  record_result "$name" "$rc" "$started_at" "$finished_at"
  if [ "$rc" -ne 0 ]; then
    echo "!! release-frontier: $name failed rc=$rc" >&2
  fi
  return 0
}

run_parent_npm() {
  local name="$1"
  local package_script="$2"
  local log_relative="build/$(basename "$LOG_DIR")/${name}.log"
  local log="$REPO/$log_relative"
  local started_at finished_at rc
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "==> release-frontier [$PHASE/final-gates]: $name ($package_script)"
  set +e
  (
    cd "$REPO"
    npm run "$package_script"
  ) 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  set -e
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  record_result "$name" "$rc" "$started_at" "$finished_at"
  if [ "$rc" -ne 0 ]; then
    echo "!! release-frontier: $name failed rc=$rc" >&2
  fi
}

run_parent_direct() {
  local name="$1"
  local command_name="$2"
  shift 2
  local log_relative="build/$(basename "$LOG_DIR")/${name}.log"
  local log="$REPO/$log_relative"
  local started_at finished_at rc
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "==> release-frontier [$PHASE/final-gates]: $name"
  set +e
  (cd "$REPO" && "$@") 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  set -e
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  record_result "$name" "$rc" "$started_at" "$finished_at"
  if [ "$rc" -ne 0 ]; then
    echo "!! release-frontier: $name failed rc=$rc" >&2
  fi
}

core_lane() {
  local worker="$1"
  trap - EXIT INT TERM
  set +e
  # Dependency-bearing commands stay serial inside this lane. In particular, each integration
  # attestation follows the regression manifest that it authenticates.
  run_worker_npm "$worker" core bootstrap test:outcome-reconciler:bootstrap \
    build/outcome-reconciler-bootstrap-manifest.json
  run_worker_npm "$worker" core contract test:outcome-reconciler:contract \
    build/outcome-reconciler-v2-contract-manifest.json
  run_worker_npm "$worker" core protocol test:outcome-reconciler:protocol \
    build/outcome-reconciler-v2-protocol-manifest.json
  run_worker_npm "$worker" core evaluator test:outcome-reconciler:evaluator \
    build/outcome-reconciler-v2-evaluator-manifest.json
  run_worker_npm "$worker" core projection test:outcome-reconciler:projection \
    build/outcome-reconciler-v2-projection-manifest.json
  run_worker_npm "$worker" core done-gate test:outcome-reconciler:done-gate \
    build/outcome-reconciler-v2-done-gate-manifest.json
  run_worker_npm "$worker" core actions test:outcome-reconciler:actions \
    build/outcome-reconciler-v2-actions-manifest.json
  run_worker_npm "$worker" core coordinator test:outcome-reconciler:coordinator \
    build/outcome-reconciler-v2-coordinator-manifest.json
  run_worker_npm "$worker" core fact-ingress test:outcome-reconciler:fact-ingress \
    build/outcome-reconciler-v2-fact-ingress-manifest.json
  run_worker_npm "$worker" core ratification test:outcome-reconciler:ratification \
    build/outcome-reconciler-v2-ratification-manifest.json
  run_worker_npm "$worker" core auto-dispatch test:outcome-reconciler:auto-dispatch \
    build/outcome-reconciler-auto-dispatch-manifest.json
  run_worker_npm "$worker" core work-overview-readiness \
    test:outcome-reconciler:work-overview-readiness \
    build/work-overview-readiness-manifest.json
  run_worker_npm "$worker" core auto-dispatch-integration \
    test:outcome-reconciler:auto-dispatch:integration \
    build/outcome-reconciler-auto-dispatch-integration-attestation.json
  run_worker_npm "$worker" core watchdog-current-binding-regression \
    test:outcome-reconciler:watchdog-current-binding:regression \
    build/outcome-reconciler-watchdog-current-binding-manifest.json
  run_worker_npm "$worker" core watchdog-current-binding \
    test:outcome-reconciler:watchdog-current-binding \
    build/outcome-reconciler-watchdog-current-binding-attestation.json
  run_worker_npm "$worker" core delivery test:outcome-reconciler:delivery \
    build/outcome-reconciler-v2-delivery-manifest.json
  run_worker_npm "$worker" core versioning test:outcome-reconciler:versioning \
    build/outcome-reconciler-v2-versioning-manifest.json
  run_worker_npm "$worker" core surfaces test:outcome-reconciler:surfaces \
    build/outcome-reconciler-v2-surfaces-manifest.json
  run_worker_npm "$worker" core replay test:outcome-reconciler:replay \
    build/outcome-reconciler-v2-replay-manifest.json
  run_worker_npm "$worker" core owner-ratification-ui \
    test:outcome-reconciler:owner-ratification-ui \
    build/outcome-reconciler-owner-ratification-ui-manifest.json
}

watchdog_lane() {
  local worker="$1"
  trap - EXIT INT TERM
  set +e
  run_worker_npm "$worker" backend watchdog test:outcome-reconciler:watchdog \
    build/outcome-reconciler-v2-watchdog-manifest.json \
    build/outcome-reconciler-v2-watchdog-capacity-manifest.json
}

runtime_tail_lane() {
  local worker="$1"
  trap - EXIT INT TERM
  set +e
  # Canary consumes immutable Watchdog evidence, so these proofs begin only after Watchdog has
  # published the current run's manifests in the same isolated worker.
  run_worker_npm "$worker" backend acceptance-runtime \
    test:outcome-reconciler:acceptance-runtime \
    build/executable-acceptance-runtime-manifest.json
  run_worker_npm "$worker" backend canary test:outcome-reconciler:canary \
    build/outcome-reconciler-v2-canary-manifest.json
}

api_lane() {
  local worker="$1"
  trap - EXIT INT TERM
  set +e
  # The complete API matrix has no evidence dependency on Watchdog/Canary. Starting it immediately
  # removes that twenty-minute false edge while four case workers keep the whole DAG bounded to the
  # machine's eight logical CPUs.
  OUTCOME_RELEASE_API_JOBS="${OUTCOME_RELEASE_API_JOBS:-4}" \
    run_worker_npm "$worker" api full-api test:outcome-reconciler:full-api \
      build/outcome-reconciler-full-api-manifest.json
}

clients_lane() {
  local worker="$1"
  trap - EXIT INT TERM
  set +e
  run_worker_npm "$worker" clients full-clients test:outcome-reconciler:full-clients \
    build/outcome-reconciler-full-clients-manifest.json
}

set -e
prepare_worker core
CORE_WORKER="$PREPARED_WORKER"
prepare_worker runtime
RUNTIME_WORKER="$PREPARED_WORKER"
prepare_worker api
API_WORKER="$PREPARED_WORKER"
prepare_worker clients
CLIENTS_WORKER="$PREPARED_WORKER"

echo "==> release-frontier [$PHASE]: execute bounded DAG target=$TARGET_SHA lanes=4 apiJobs=${OUTCOME_RELEASE_API_JOBS:-4} clientsAfter=watchdog"
(trap - EXIT INT TERM; core_lane "$CORE_WORKER") &
CORE_PID="$!"
LANE_PIDS+=("$CORE_PID")
(trap - EXIT INT TERM; watchdog_lane "$RUNTIME_WORKER") &
WATCHDOG_PID="$!"
LANE_PIDS+=("$WATCHDOG_PID")
(trap - EXIT INT TERM; api_lane "$API_WORKER") &
API_PID="$!"
LANE_PIDS+=("$API_PID")

# The 111k Watchdog seed is the machine's heaviest bounded phase. Web stays a complete one-worker
# matrix, but starts after that phase so its event-loop deadlines measure the product rather than
# CPU starvation caused by the acceptance harness itself. API and core continue independently.
set +e
wait "$WATCHDOG_PID"
set -e
(trap - EXIT INT TERM; runtime_tail_lane "$RUNTIME_WORKER") &
RUNTIME_TAIL_PID="$!"
LANE_PIDS+=("$RUNTIME_TAIL_PID")
(trap - EXIT INT TERM; clients_lane "$CLIENTS_WORKER") &
CLIENTS_PID="$!"
LANE_PIDS+=("$CLIENTS_PID")

set +e
for LANE_PID in "$CORE_PID" "$API_PID" "$RUNTIME_TAIL_PID" "$CLIENTS_PID"; do
  wait "$LANE_PID"
done
set -e

# Remote/deployment gates run only after every fresh lane manifest has been copied to the invoking
# clean checkout. They are deliberately not evaluated inside an isolated worker.
run_parent_npm authoritative-target test:outcome-reconciler:authoritative-target
if [ "$PHASE" = final ]; then
  run_parent_direct release-live-state test:outcome-reconciler:release-live-state \
    node scripts/outcome-reconciler-release-live-state.mjs
fi

ENTRY_NAMES=(
  bootstrap contract protocol evaluator projection done-gate actions coordinator watchdog
  acceptance-runtime fact-ingress ratification auto-dispatch work-overview-readiness
  auto-dispatch-integration watchdog-current-binding-regression watchdog-current-binding
  delivery versioning surfaces replay canary owner-ratification-ui full-api full-clients
  authoritative-target
)
ENTRY_SCRIPTS=(
  test:outcome-reconciler:bootstrap
  test:outcome-reconciler:contract
  test:outcome-reconciler:protocol
  test:outcome-reconciler:evaluator
  test:outcome-reconciler:projection
  test:outcome-reconciler:done-gate
  test:outcome-reconciler:actions
  test:outcome-reconciler:coordinator
  test:outcome-reconciler:watchdog
  test:outcome-reconciler:acceptance-runtime
  test:outcome-reconciler:fact-ingress
  test:outcome-reconciler:ratification
  test:outcome-reconciler:auto-dispatch
  test:outcome-reconciler:work-overview-readiness
  test:outcome-reconciler:auto-dispatch:integration
  test:outcome-reconciler:watchdog-current-binding:regression
  test:outcome-reconciler:watchdog-current-binding
  test:outcome-reconciler:delivery
  test:outcome-reconciler:versioning
  test:outcome-reconciler:surfaces
  test:outcome-reconciler:replay
  test:outcome-reconciler:canary
  test:outcome-reconciler:owner-ratification-ui
  test:outcome-reconciler:full-api
  test:outcome-reconciler:full-clients
  test:outcome-reconciler:authoritative-target
)
if [ "$PHASE" = final ]; then
  ENTRY_NAMES+=(release-live-state)
  ENTRY_SCRIPTS+=(test:outcome-reconciler:release-live-state)
fi

: > "$LEDGER"
FAILED=0
for ((INDEX = 0; INDEX < ${#ENTRY_NAMES[@]}; INDEX += 1)); do
  NAME="${ENTRY_NAMES[$INDEX]}"
  PACKAGE_SCRIPT="${ENTRY_SCRIPTS[$INDEX]}"
  RC_FILE="$RESULT_DIR/$NAME.rc"
  RC=125
  if [ -s "$RC_FILE" ]; then
    RC="$(tr -d '[:space:]' < "$RC_FILE")"
  fi
  LOG_RELATIVE="build/$(basename "$LOG_DIR")/${NAME}.log"
  printf '%s\t%s\t%s\t%s\n' "$NAME" "$PACKAGE_SCRIPT" "$RC" "$LOG_RELATIVE" >> "$LEDGER"
  if [ "$RC" -ne 0 ]; then
    echo "!! release-frontier: $NAME did not produce a successful current-run result (rc=$RC)" >&2
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo '!! release-frontier: one or more declared entrypoints failed; no PASS manifest published' >&2
  exit 1
fi

node "$REPO/scripts/outcome-reconciler-release-frontier-manifest.mjs" \
  "$PHASE" "$LEDGER" "$OUTPUT"
echo "✓ release-frontier $PHASE accepted: manifest=$OUTPUT target=$TARGET_SHA"
