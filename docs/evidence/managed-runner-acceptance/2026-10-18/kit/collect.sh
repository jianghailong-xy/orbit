#!/usr/bin/env bash
# Copy one acceptance-lab.py run into this evidence directory, then scan it for credentials.
# Usage: collect.sh RUN_OUT SERVER_DIR SELFHOST_DIR EVIDENCE_DIR
#   RUN_OUT       the run's --out directory (steps.jsonl, records/, run.log)
#   SERVER_DIR    its LAB_TEST_SERVER_DIR (timeline, apiserver and fake model logs)
#   SELFHOST_DIR  the self-managed runner's directory (its log)
#   EVIDENCE_DIR  docs/evidence/managed-runner-acceptance/2026-10-18, named outright
# Logs become .txt or .gz: the repository ignores *.log.
set -euo pipefail
run=${1:?RUN_OUT} server=${2:?SERVER_DIR} selfhost=${3:?SELFHOST_DIR} evidence=${4:?EVIDENCE_DIR}
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
[ -f "$run/steps.jsonl" ] && [ -d "$run/records" ] || { echo "no run in $run" >&2; exit 1; }
mkdir -p "$evidence/records" "$evidence/logs" "$evidence/checks"
cp "$run/steps.jsonl" "$evidence/steps.jsonl"
cp "$run"/records/*.json "$evidence/records/"
cp "$run/run.log" "$evidence/logs/run.txt"
cp "$run/head.txt" "$evidence/head.txt"
gzip -9 -c "$server/timeline.jsonl" > "$evidence/logs/timeline.jsonl.gz"
gzip -9 -c "$server/logs/apiserver.log" > "$evidence/logs/apiserver.txt.gz"
[ -f "$server/logs/apiserver-b.log" ] && gzip -9 -c "$server/logs/apiserver-b.log" > "$evidence/logs/apiserver-replica.txt.gz"
gzip -9 -c "$server/logs/fake-model.jsonl" > "$evidence/logs/fake-model.jsonl.gz"
gzip -9 -c "$server/gate/api-gate.jsonl" > "$evidence/logs/api-gate.jsonl.gz"
cp "$selfhost/runner.log" "$evidence/logs/selfhost-runner.txt"
LAB_TEST_SERVER_DIR=$server python3 -I "$repo/scripts/managed-runner/lab/acceptance-lab.py" report "$run" > "$evidence/report.json"
LAB_TEST_SERVER_DIR=$server python3 -I "$repo/scripts/managed-runner/lab/acceptance-lab.py" secret-scan \
  "$evidence/records" "$evidence/logs" "$evidence/checks" "$evidence/steps.jsonl" "$evidence/report.json" > "$evidence/secret-scan.json"
echo "collected into $evidence: $(find "$evidence" -type f | wc -l) files, $(du -sh "$evidence" | cut -f1)"
