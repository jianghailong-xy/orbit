#!/usr/bin/env bash
# D2-era: this reads or writes session.status, which deploy D4 (migration 1711) dropped. It runs on a database of
# deploy D1 or D2 only, and is kept for the record of those deploys.
#
# Run scripts/session-turn-state-backfill.sql batch after batch until one writes 0 rows (docs/session-status-retirement-plan.md
# §4.4; task T3, with the owner's go: it writes production rows).
#
#   DATABASE_URL=postgresql://… scripts/session-turn-state-backfill.sh
#   PSQL="docker exec -i orbit-postgres psql -U orbit -d orbit" scripts/session-turn-state-backfill.sh
#
# PSQL is the command that reaches the database (default: psql "$DATABASE_URL"); the batch is fed on stdin. A batch
# that fails (its 2 s lock timeout, or anything else) is tried again after 1 s, up to 10 times in a row; then the
# script stops with that error. Prints one line per batch with its row count, and the total.
set -euo pipefail

SQL="$(dirname "${BASH_SOURCE[0]}")/session-turn-state-backfill.sql"
if [ -n "${PSQL:-}" ]; then
  read -r -a PSQL_CMD <<<"$PSQL"
else
  : "${DATABASE_URL:?set DATABASE_URL, or PSQL to the command that reaches the database}"
  PSQL_CMD=(psql "$DATABASE_URL")
fi

batch=0
total=0
failures=0
while :; do
  if out="$("${PSQL_CMD[@]}" -X -v ON_ERROR_STOP=1 -f - <"$SQL" 2>&1)"; then
    failures=0
  else
    failures=$((failures + 1))
    echo "batch failed (${failures} in a row): ${out}" >&2
    [ "$failures" -lt 10 ] || exit 1
    sleep 1
    continue
  fi
  rows="$(printf '%s\n' "$out" | sed -n 's/^UPDATE \([0-9][0-9]*\)$/\1/p' | tail -1)"
  [ -n "$rows" ] || { echo "no UPDATE count in: ${out}" >&2; exit 1; }
  batch=$((batch + 1))
  total=$((total + rows))
  echo "batch ${batch}: ${rows} rows"
  [ "$rows" -gt 0 ] || break
done
echo "done: ${total} rows in $((batch - 1)) batches that wrote"
