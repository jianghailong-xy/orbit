#!/usr/bin/env bash
# The Orbit agent-contract eval (docs/agent-contract-eval.md).
#
#   scripts/agent-eval.sh deterministic
#       The CI layer: the scenario catalogue, the golden and mistake agents through the real `orbit mcp` and CLI,
#       the graders, the report and the telemetry, and the contract tests the release gate names (every advertised
#       argv and helpArgv runs, strict input, the receipts, the Plan gate, the primer and its carriers after a
#       compaction, the CLI batch's card). No engine, no model, a few minutes.
#
#   scripts/agent-eval.sh live [--engines claude,codex] [--scenarios all|ID,ID|E1*] [--repeats N]
#                              [--claude-model M] [--codex-model M] [--claude-bin PATH] [--codex-bin PATH]
#                              [--effort E] [--out DIR] [--baseline REPORT.json] [--leave-out UNIT,UNIT]
#       The black-box layer: the real engines this machine's runner spawns, with real models, against the eval's own
#       control plane (nothing reaches an Orbit account; the engines reach their model provider with the login this
#       machine's runner gives its sessions, so a run costs what that many session turns cost). Writes
#       DIR/agent-eval-<UTC time>.json and .md, and exits non-zero unless the release gate passes. With --baseline,
#       the report compares itself with that one, cell by cell, and a regression fails the gate. With --leave-out,
#       every engine is given its instructions without those units (instructionUnits ids, instruction_units.go), and the
#       report names them: a measurement of what the units are worth, never a baseline.
#
#   scripts/agent-eval.sh compare BASELINE.json REPORT.json
#       Prints the comparison of two reports and exits non-zero on a regression.
#
#   scripts/agent-eval.sh merge OUT.json REPORT.json REPORT.json...
#       One report of several graded by the same suite (one per engine or per machine), its gate read again.
#
#   scripts/agent-eval.sh regrade OUT.json TRANSCRIPT_DIR
#       A report from the transcripts a live run kept (--transcripts DIR), graded by this checkout's graders: a
#       grader fix re-reads what the engines did instead of running them again. The report names the commit the
#       transcripts were played on (ORBIT_AGENT_EVAL_REPO_SHA for transcripts that do not record it). Transcripts hold
#       the engines' words and the tools' answers; they are local diagnostics, never uploaded or committed.
#
# The eval must not see the calling Orbit session: a session's ORBIT_* variables would send the eval's own
# `orbit` processes to the real control plane, so they are removed here, as they are for every runner-go test run
# from inside a session.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runner="$here/../src/runner-go"

clean_env=(env
  -u ORBIT_SESSION_ID -u ORBIT_AGENT_ID -u ORBIT_TASK_ID -u ORBIT_HOME -u ORBIT_ALLOW_ORCHESTRATION
  -u ORBIT_WATCHES -u ORBIT_WIKI -u ORBIT_BG_SOCKET -u ORBIT_BG_TOKEN -u ORBIT_BG_JOB_ID -u ORBIT_SPAWN_DEPTH
  -u ORBIT_RUNNER_CHILD -u ORBIT_ORCHESTRATION_TOKEN -u ORBIT_MCP_PERMISSION_PROMPT
  -u ORBIT_BROWSER -u ORBIT_WORKFLOWS -u ORBIT_SCHEDULE_RUN -u ORBIT_SCHEDULED_CHECK_ONLY -u ORBIT_SUBAGENT_RUN_ID
  -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_MODEL
  -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN
  -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_PID -u CLAUDE_EFFORT
  NO_COLOR=1)

# The deterministic layer: the eval's own tests, and the contract tests the release gate names
# (docs/agent-contract-eval.md#release-gate).
deterministic_tests='^(TestAgentEval|TestAgentContractTelemetry|TestOrbitCLIInvocationReadsInsideAShell|TestATurnThatTouchedOrbitFilesItsTelemetryBeforeItsTurnEnd|TestTheMessageAfterACompactionCarriesTheContextResetNote|TestCodexTurnAfterACompactionOrAResumeCarriesTheContextResetNote|TestEveryAdvertisedArgvAndHelpArgvRuns|TestContract|TestCLIReceipt|TestCLIRefusesAnInvalidBatchDocumentBeforeAnyRequest|TestEveryAdvertisedObjectSchemaIsClosed|TestCatalogSchemasUseOnlyTheValidatedSubset|TestPlanGate|TestOrbitMCPRefusesAWriteInPlanBeforeItReachesTheControlPlane|TestTheInSessionCLIRefusesAWriteInPlan|TestCLIPlanGateRefusesTheSameWrites|TestAgentPrimer|TestMCPInitializeAnswersWithTheVersionedPrimer|TestEveryEngineIsGivenTheSamePrimer|TestCodexPutsThePrimerBackAfterCompaction|TestMCPToolListIsProjectedFromCatalog)'

usage() {
  sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

cmd="${1:-}"
[ -n "$cmd" ] || usage
shift

case "$cmd" in
  deterministic)
    cd "$runner"
    exec "${clean_env[@]}" go test -count=1 -timeout 20m -run "$deterministic_tests" .
    ;;
  live)
    engines="claude,codex" scenarios="all" repeats=1 out="${PWD}/agent-eval-reports" baseline=""
    claude_model="" codex_model="" claude_bin="" codex_bin="" effort="" transcripts="" leave_out=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --engines) engines="$2"; shift 2 ;;
        --scenarios) scenarios="$2"; shift 2 ;;
        --repeats) repeats="$2"; shift 2 ;;
        --claude-model) claude_model="$2"; shift 2 ;;
        --codex-model) codex_model="$2"; shift 2 ;;
        --claude-bin) claude_bin="$2"; shift 2 ;;
        --codex-bin) codex_bin="$2"; shift 2 ;;
        --effort) effort="$2"; shift 2 ;;
        --out) out="$2"; shift 2 ;;
        --baseline) baseline="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
        --transcripts) mkdir -p "$2"; transcripts="$(cd "$2" && pwd)"; shift 2 ;;
        --leave-out) leave_out="$2"; shift 2 ;;
        *) usage ;;
      esac
    done
    mkdir -p "$out"
    out="$(cd "$out" && pwd)"
    report="$out/agent-eval-$(date -u +%Y%m%dT%H%M%SZ).json"
    sha="$(git -C "$here/.." rev-parse HEAD 2>/dev/null || true)"
    if [ -n "$(git -C "$here/.." status --porcelain 2>/dev/null)" ]; then sha="${sha}+dirty"; fi
    cd "$runner"
    status=0
    "${clean_env[@]}" ORBIT_AGENT_EVAL=live ORBIT_AGENT_EVAL_ENGINES="$engines" ORBIT_AGENT_EVAL_SCENARIOS="$scenarios" \
      ORBIT_AGENT_EVAL_REPEATS="$repeats" ORBIT_AGENT_EVAL_REPORT="$report" ORBIT_AGENT_EVAL_BASELINE="$baseline" \
      ORBIT_AGENT_EVAL_CLAUDE_MODEL="$claude_model" ORBIT_AGENT_EVAL_CODEX_MODEL="$codex_model" \
      ORBIT_AGENT_EVAL_CLAUDE_BIN="$claude_bin" ORBIT_AGENT_EVAL_CODEX_BIN="$codex_bin" ORBIT_AGENT_EVAL_EFFORT="$effort" \
      ORBIT_AGENT_EVAL_REPO_SHA="$sha" ORBIT_AGENT_EVAL_TRANSCRIPTS="$transcripts" ORBIT_AGENT_EVAL_LEAVE_OUT="$leave_out" \
      go test -count=1 -timeout 6h -v -run '^TestAgentEvalLive$' . || status=$?
    echo "report: $report"
    echo "markdown: ${report%.json}.md"
    exit "$status"
    ;;
  compare)
    [ $# -eq 2 ] || usage
    base="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
    cur="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
    cd "$runner"
    exec "${clean_env[@]}" ORBIT_AGENT_EVAL_COMPARE="$base,$cur" go test -count=1 -v -run '^TestAgentEvalCompareReports$' .
    ;;
  merge)
    [ $# -ge 2 ] || usage
    spec=""
    for f in "$@"; do
      abs="$(cd "$(dirname "$f")" && pwd)/$(basename "$f")"
      spec="${spec:+$spec,}$abs"
    done
    cd "$runner"
    exec "${clean_env[@]}" ORBIT_AGENT_EVAL_MERGE="$spec" go test -count=1 -v -run '^TestAgentEvalMergeReports$' .
    ;;
  regrade)
    [ $# -eq 2 ] || usage
    out="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
    dir="$(cd "$2" && pwd)"
    sha="${ORBIT_AGENT_EVAL_REPO_SHA:-$(git -C "$here/.." rev-parse HEAD 2>/dev/null || true)}"
    cd "$runner"
    exec "${clean_env[@]}" ORBIT_AGENT_EVAL_REGRADE="$out,$dir" ORBIT_AGENT_EVAL_REPO_SHA="$sha" \
      go test -count=1 -v -run '^TestAgentEvalRegrade$' .
    ;;
  *)
    usage
    ;;
esac
