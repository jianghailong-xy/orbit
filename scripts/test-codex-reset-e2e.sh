#!/usr/bin/env bash
# Codex earned rate-limit reset, end to end across every layer (docs/codex-rate-limit-reset-contract.md,
# docs/codex-rate-limit-reset-runbook.md): the verification gate of project "Orbit：Codex 使用额度 Reset 能力".
#
#   bash scripts/test-codex-reset-e2e.sh
#
# WHAT RUNS, IN ORDER
#   1. apiserver on PostgreSQL: the operation, relay and planUsage compare-and-set pg specs through scripts/run-pg-spec.sh
#      (a disposable server, a skip counts as red). It also lays this worktree's node_modules overlay and generates this
#      branch's Prisma client, which every later step uses.
#   2. npm run build: @orbit/shared, the apiserver's dist and the web's production bundle — the artifacts step 5 runs.
#   3. runner-go: every test function of the reset and plan-usage test files, by name; then `go build` of the `orbit`
#      binary and `go test -c -tags codexresetfault` of the binary that is the fake Codex app-server in step 5.
#   4. @orbit/shared (the whole package), the apiserver's non-pg specs that read the reset code, and the web's reset
#      and plan-usage tests.
#   5. The cross-layer E2E, scripts/codex-reset-e2e/run.mjs, on one disposable stack:
#        PostgreSQL (postgres:16-alpine) ← `prisma migrate deploy`
#        apiserver  `node dist/main.js` (the production AppModule)
#        web        the production bundle in a headless Chromium, same-origin with /api
#        runner     `orbit register` + `orbit run` (runloop, heartbeat, usage probe, reset relay, consume)
#        Codex      the programmable fake app-server behind a `codex` shim first on the runner's PATH
#      Its scenarios, each pressed from the web and followed through the operation API, the database, the heartbeat
#      command, the runner's consume, the result receipt and the Plan usage refresh (see SCENARIOS below):
#        S01 the authoritative read reaches Plan usage          S08 refresh read fails, is retried read-only, recovers
#        S02 success; double press, lost create answer, reload, S09 refresh never succeeds: REFRESH_FAILED, the stale
#            replayed and in-flight POSTs — one operation          snapshot gate (Web and API), recovery by a new read
#        S03 command and receipt redelivery                     S10 account override (workspace CODEX_HOME)
#        S04 outcome alreadyRedeemed under the same key         S11 outcome noCredit, then no balance
#        S05 outcome nothingToReset, three concurrent POSTs     S12 unsupported account (API-key sign-in)
#        S06 account changed before the consume                 S13 whole-run invariants: one operation and one key
#        S07 offline: entry disabled, API refusal, and an           per intent, same-key retries, no consume after
#            operation that waits and completes                     confirmation, forwards-only rows and snapshots,
#                                                                   no key or account data where it must not be
#
# WHAT COUNTS AS GREEN
#   Every step exits 0 and reports no failure, skip or todo; every named Go test reports PASS; the E2E report names
#   exactly the scenarios above, each PASS. Exit codes alone are not trusted: `go test -run` exits 0 when its pattern
#   selects nothing, `node --test` and vitest exit 0 when every case skipped.
#
# NO REAL ACCOUNT, NO REAL CREDIT
#   OPENAI_* and CODEX_API_KEY are unset. Every step runs behind guard shims named codex, claude, kimi and opencode that
#   record being run and fail; the E2E runner's only other `codex` is the fake, which S01 checks against the PATH the
#   running `orbit` process actually has. A guard `codex` hit is red. HOME, ORBIT_HOME and CODEX_HOME are scratch.
#
# CODEX_RESET_E2E_KEEP=<dir> keeps the E2E's logs, wire captures, row samples and screenshots there.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/codex-reset-e2e.XXXXXX")"
cleanup() {
  docker ps -aq --filter "label=orbit.codex-reset-e2e=1" --filter "name=codex-reset-e2e-pg-$$-" | xargs -r docker rm -f -v >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

SCENARIOS=(S01 S02 S03 S04 S05 S06 S07 S08 S09 S10 S11 S12 S13)
PG_SPECS=(
  src/apiserver/src/runners/codex-rate-limit-reset.pg.spec.ts
  src/apiserver/src/runner-api/codex-reset-relay.pg.spec.ts
  src/apiserver/src/runner-api/codex-reset-plan-usage.pg.spec.ts
)
GO_TEST_FILES=(
  codex_rate_limit_reset_test.go
  codex_rate_limit_reset_read_test.go
  codex_rate_limit_reset_relay_test.go
  codex_rate_limit_reset_consume_test.go
  codex_rate_limit_reset_hardening_test.go
  codex_rate_limit_session_account_test.go
  planusage_test.go
  planusage_error_text_test.go
  runner_me_workspaces_test.go
)
API_SPECS=(
  build/runner-api/codex-reset-plan-usage.spec.js
  build/runners/codex-reset-telemetry.spec.js
  build/runners/runners.service.spec.js
  build/metrics/metrics.controller.spec.js
  build/common/public-id-body-coverage.spec.js
  build/tasks/task-judgment-data-preserved.spec.js
)
WEB_TESTS=(
  src/lib/codexResetCredit.test.ts
  src/components/PlanUsageIndicator.test.tsx
  src/lib/planUsage.test.ts
)

RED=()
STEPS=()
red() { RED+=("$1"); echo "RED: $1"; }
step() { STEPS+=("$1"); echo; echo "################ $1"; }
tap_count() { awk -v key="$2" '$1 == "#" && $2 == key { n = $3 } END { print n + 0 }' "$1"; }

# --- the guard -----------------------------------------------------------------------------------
for name in $(compgen -e | grep -E '^(OPENAI_.*|CODEX_API_KEY)$'); do unset "$name"; done
mkdir -p "$SCRATCH/guard-bin" "$SCRATCH/home" "$SCRATCH/orbit" "$SCRATCH/codex-home"
for engine in codex claude kimi opencode; do
  cat > "$SCRATCH/guard-bin/$engine" <<EOF
#!/bin/sh
echo "$engine \$*" >> "$SCRATCH/guard-hits"
echo "test-codex-reset-e2e: $engine is a guard here, not an engine" >&2
exit 97
EOF
  chmod +x "$SCRATCH/guard-bin/$engine"
done
GUARDED_PATH="$SCRATCH/guard-bin:$PATH"
MAIN="$(dirname "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")"

# --- 1. apiserver on PostgreSQL ------------------------------------------------------------------
step "1. apiserver pg specs (scripts/run-pg-spec.sh): ${#PG_SPECS[@]} files"
PATH="$GUARDED_PATH" bash "$REPO/scripts/run-pg-spec.sh" "${PG_SPECS[@]}" 2>&1 | tee "$SCRATCH/pg.log"
rc=${PIPESTATUS[0]}
[ "$rc" = 0 ] || red "apiserver pg specs: run-pg-spec.sh exited $rc"
grep -q '^==> OK: 3 spec(s) witnessed' "$SCRATCH/pg.log" || red "apiserver pg specs: run-pg-spec.sh did not witness all three files"

# --- 2. production build -------------------------------------------------------------------------
step "2. npm run build"
if [ ! -e "$REPO/src/web/node_modules" ] && [ -d "$MAIN/src/web/node_modules" ] && [ "$MAIN" != "$REPO" ]; then
  ln -s "$MAIN/src/web/node_modules" "$REPO/src/web/node_modules"
fi
( cd "$REPO" && PATH="$GUARDED_PATH" npm run build ) 2>&1 | tee "$SCRATCH/build.log" | tail -25
rc=${PIPESTATUS[0]}
[ "$rc" = 0 ] || red "npm run build exited $rc"
for artifact in src/shared/dist/index.js src/apiserver/dist/main.js src/web/dist/index.html; do
  [ -f "$REPO/$artifact" ] || red "npm run build left no $artifact"
done

# --- 3. runner-go --------------------------------------------------------------------------------
GO_TESTS=()
for file in "${GO_TEST_FILES[@]}"; do
  [ -f "$REPO/src/runner-go/$file" ] || { red "runner-go: $file is missing"; continue; }
  while IFS= read -r name; do GO_TESTS+=("$name"); done < <(grep -oE '^func Test[A-Za-z0-9_]+' "$REPO/src/runner-go/$file" | sed 's/^func //')
done
step "3. runner-go: ${#GO_TESTS[@]} named tests, the orbit binary and the fake Codex app-server"
GO_LOG="$SCRATCH/go.log"
(
  cd "$REPO/src/runner-go" || exit 2
  export GOCACHE="$(go env GOCACHE)" GOMODCACHE="$(go env GOMODCACHE)" GOPATH="$(go env GOPATH)" GOFLAGS=-buildvcs=false
  export HOME="$SCRATCH/home" ORBIT_HOME="$SCRATCH/orbit" CODEX_HOME="$SCRATCH/codex-home" PATH="$GUARDED_PATH"
  go test -count=1 -timeout 1200s -run "^($(IFS='|'; echo "${GO_TESTS[*]}"))\$" -v .
  echo "GO_TEST_EXIT=$?"
  go build -o "$SCRATCH/bin/orbit" .
  echo "GO_BUILD_EXIT=$?"
  go test -c -tags codexresetfault -o "$SCRATCH/bin/runner-go-fault.test" .
  echo "GO_FAULT_BUILD_EXIT=$?"
) > "$GO_LOG" 2>&1
grep -E '^(--- |ok |FAIL|GO_)' "$GO_LOG" | tail -80
grep -q '^GO_TEST_EXIT=0$' "$GO_LOG" || red "runner-go: go test did not exit 0"
grep -q 'no tests to run' "$GO_LOG" && red "runner-go: the -run pattern selected no test"
grep -Eq '^[[:space:]]*--- (FAIL|SKIP):' "$GO_LOG" && red "runner-go: a test failed or skipped"
[ "${#GO_TESTS[@]}" -gt 0 ] || red "runner-go: no test names were collected"
for name in "${GO_TESTS[@]}"; do
  grep -Eq "^--- PASS: $name \(" "$GO_LOG" || red "runner-go: $name did not report PASS"
done
grep -q '^GO_BUILD_EXIT=0$' "$GO_LOG" || red "runner-go: go build of the orbit binary failed"
grep -q '^GO_FAULT_BUILD_EXIT=0$' "$GO_LOG" || red "runner-go: the fake app-server binary (-tags codexresetfault) did not build"

# --- 4. shared, apiserver non-pg, web ------------------------------------------------------------
VITEST="$REPO/node_modules/.bin/vitest"
vitest_json_ok() {
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(`==== ${process.argv[2]} files=${r.numTotalTestSuites} tests=${r.numTotalTests} pass=${r.numPassedTests} fail=${r.numFailedTests} skipped=${r.numPendingTests} todo=${r.numTodoTests}`);
    process.exit(r.success && r.numTotalTests > 0 && r.numFailedTests === 0 && r.numPendingTests === 0 && r.numTodoTests === 0 ? 0 : 1);
  ' "$1" "$2"
}

step "4a. @orbit/shared (whole package)"
( cd "$REPO/src/shared" && PATH="$GUARDED_PATH" "$VITEST" run --reporter=default --reporter=json --outputFile.json="$SCRATCH/shared.json" ) 2>&1 | tail -15
[ -f "$SCRATCH/shared.json" ] && vitest_json_ok "$SCRATCH/shared.json" "@orbit/shared" || red "@orbit/shared: a test failed, skipped or did not run"

step "4b. apiserver non-pg specs that read the reset code: ${#API_SPECS[@]} files"
missing=0
for js in "${API_SPECS[@]}"; do [ -f "$API/$js" ] || { red "apiserver: $js was not built by step 1"; missing=1; }; done
if [ "$missing" = 0 ]; then
  ( cd "$API" && PATH="$GUARDED_PATH" NODE_OPTIONS='' node --test --test-concurrency=1 --test-reporter=tap \
      --test-reporter-destination=stdout "${API_SPECS[@]}" ) > "$SCRATCH/api.tap" 2>&1
  rc=$?
  tail -12 "$SCRATCH/api.tap"
  [ "$rc" = 0 ] || red "apiserver non-pg specs exited $rc"
  for key in fail cancelled skipped todo; do
    [ "$(tap_count "$SCRATCH/api.tap" "$key")" = 0 ] || red "apiserver non-pg specs: $(tap_count "$SCRATCH/api.tap" "$key") $key"
  done
  [ "$(tap_count "$SCRATCH/api.tap" pass)" -gt 0 ] || red "apiserver non-pg specs passed nothing"
fi

step "4c. web reset and plan-usage tests: ${#WEB_TESTS[@]} files"
( cd "$REPO/src/web" && PATH="$GUARDED_PATH" "$VITEST" run --maxWorkers=1 "${WEB_TESTS[@]}" \
    --reporter=default --reporter=json --outputFile.json="$SCRATCH/web.json" ) 2>&1 | tail -15
if [ -f "$SCRATCH/web.json" ] && vitest_json_ok "$SCRATCH/web.json" "web"; then
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const ran = new Set(r.testResults.map((f) => require("path").relative(process.argv[2], f.name)));
    const missing = process.argv.slice(3).filter((f) => !ran.has(f));
    if (missing.length) { console.log("web test files that did not run: " + missing.join(", ")); process.exit(1); }
  ' "$SCRATCH/web.json" "$REPO/src/web" "${WEB_TESTS[@]}" || red "web: a named test file did not run"
else
  red "web: a test failed, skipped or did not run"
fi

# --- 5. the cross-layer E2E ----------------------------------------------------------------------
step "5. cross-layer E2E: ${#SCENARIOS[@]} scenarios"
PRISMA="$API/node_modules/.bin/prisma"; [ -x "$PRISMA" ] || PRISMA="$REPO/node_modules/.bin/prisma"
E2E_READY=1
for need in "$SCRATCH/bin/orbit" "$SCRATCH/bin/runner-go-fault.test" "$REPO/src/apiserver/dist/main.js" "$REPO/src/web/dist/index.html" "$REPO/src/shared/dist/index.js"; do
  [ -e "$need" ] || { red "E2E: $need is missing (see the steps above)"; E2E_READY=0; }
done
command -v docker >/dev/null || { red "E2E: docker is not available"; E2E_READY=0; }
command -v chromium >/dev/null || { red "E2E: chromium is not available"; E2E_READY=0; }
if [ "$E2E_READY" = 1 ]; then
  CODEX_RESET_E2E_REPO="$REPO" \
  CODEX_RESET_E2E_SCRATCH="$SCRATCH/e2e" \
  CODEX_RESET_E2E_RUNNER_BINARY="$SCRATCH/bin/orbit" \
  CODEX_RESET_E2E_FAULT_BINARY="$SCRATCH/bin/runner-go-fault.test" \
  CODEX_RESET_E2E_PRISMA="$PRISMA" \
  CODEX_RESET_E2E_GUARD_BIN="$SCRATCH/guard-bin" \
  CODEX_RESET_E2E_GUARD_HITS="$SCRATCH/guard-hits" \
  CODEX_RESET_E2E_REPORT="$SCRATCH/e2e-report.json" \
  CODEX_RESET_E2E_DEBUG_DIR="${CODEX_RESET_E2E_KEEP:-}" \
  CODEX_RESET_E2E_PG_PREFIX="codex-reset-e2e-pg-$$-" \
  PATH="$GUARDED_PATH" node "$REPO/scripts/codex-reset-e2e/run.mjs"
  rc=$?
  [ "$rc" = 0 ] || red "E2E: run.mjs exited $rc"
  if [ -f "$SCRATCH/e2e-report.json" ]; then
    node -e '
      const report = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const want = process.argv.slice(2);
      const declared = report.declared.map((s) => s.id);
      const problems = [];
      if (JSON.stringify(declared) !== JSON.stringify(want)) problems.push(`declared ${declared.join(",")}, expected ${want.join(",")}`);
      for (const id of want) {
        const result = report.results.find((r) => r.id === id);
        if (!result) problems.push(`${id} did not run`);
        else if (result.status !== "PASS") problems.push(`${id} ${result.status}`);
      }
      for (const result of report.results) if (!want.includes(result.id)) problems.push(`unexpected result ${result.id} ${result.status}`);
      for (const p of problems) console.log("E2E report: " + p);
      process.exit(problems.length ? 1 : 0);
    ' "$SCRATCH/e2e-report.json" "${SCENARIOS[@]}" || red "E2E: the report does not show every declared scenario PASS"
  else
    red "E2E: run.mjs wrote no report"
  fi
fi

if [ -e "$SCRATCH/guard-hits" ] && grep -q '^codex ' "$SCRATCH/guard-hits"; then
  red "the guard codex was run: $(grep '^codex ' "$SCRATCH/guard-hits" | head -5 | tr '\n' ';')"
fi

echo
echo "################ summary"
for s in "${STEPS[@]}"; do echo "  ran: $s"; done
if [ "${#RED[@]}" -gt 0 ]; then
  printf 'RED: %s\n' "${RED[@]}"
  exit 1
fi
echo "==> OK: pg specs, npm run build, ${#GO_TESTS[@]} runner-go tests, shared, apiserver and web tests, and ${#SCENARIOS[@]} E2E scenarios all passed, none skipped"
exit 0
