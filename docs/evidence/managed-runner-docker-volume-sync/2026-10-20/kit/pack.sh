#!/bin/bash
# On the HPC host: the test host's records into this evidence directory. Small files as they are; the per-second and
# per-request ones gzipped; the gateway's access log as gateway.txt.gz (*.log is ignored by Git). The smoke rounds that
# tried the kit out are left out, and so is everything secret: the accounts' passwords (secrets.json) and the keys'
# slugs stay under /mnt/data/tmp/34ilx9dqVOKBeYZObuIjI.
#   pack.sh <this evidence directory>
set -euo pipefail
T=/mnt/data/tmp/34ilx9dqVOKBeYZObuIjI/evidence
E="$1"
mkdir -p "$E/rounds"
for r in "$T"/rounds/*; do
  name="$(basename "$r")"
  case "$name" in smoke*) continue ;; esac
  d="$E/rounds/$name"
  mkdir -p "$d"
  for f in meta.json summary.json risk-window.json turns.jsonl commits.jsonl sessions.jsonl quiet.jsonl errors.jsonl \
           pg-stat-statements.tsv pg-stat-wal.tsv pgbench.txt; do
    if [ -e "$r/$f" ]; then cp "$r/$f" "$d/"; fi
  done
  for f in samples.jsonl syncfs.jsonl api-probe.jsonl pgbench-transactions.txt; do
    if [ -e "$r/$f" ]; then gzip -9 -n -c "$r/$f" >"$d/$f.gz"; fi
  done
  if [ -e "$r/gateway.log" ]; then gzip -9 -n -c "$r/gateway.log" >"$d/gateway.txt.gz"; fi
done
gzip -9 -n -c "$T/fake-model.jsonl" >"$E/fake-model.jsonl.gz"
gzip -9 -n -c "$T/status-transitions.jsonl" >"$E/status-transitions.jsonl.gz"
gzip -9 -n -c "$T/install-default.log" >"$E/install-default.txt.gz"
cp "$T/steps.jsonl" "$E/steps.jsonl"
du -sh "$E"
