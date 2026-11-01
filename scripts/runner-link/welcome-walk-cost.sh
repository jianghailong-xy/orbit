#!/usr/bin/env bash
# Times the welcome route's walk against the stack's own sessions, at the depths they hold (task C2b, step 4; the first
# run's method, task comment "C2b 证据 11"). A reconnect storm measures the walk at whatever depth the run reached;
# this measures how the walk's cost grows with depth, on sessions a finished run left behind.
#
#   scripts/runner-link/welcome-walk-cost.sh --out <dir> [--sessions 40] [--repeats 5]
#
# The statement is the one runner-link-welcome.ts runs for a Welcome, with one session id, timed in the database with
# \timing. Each session is timed --repeats times and the FASTEST is kept: the fastest is the cache-hit cost, which is
# what a reconnect storm pays once a session's pages are in shared_buffers. Sessions are picked to spread over the
# depths present, by ntile over the stored-event count.
#
#   walks.tsv   session, stored events, each timing (ms), the fastest
#   walk.json   the fastest per depth, a least-squares fit of ms = a + b × events, and the r² of the fit
set -euo pipefail
# shellcheck source=staging-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/staging-lib.sh"

out=""
sessions=40
repeats=5
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --sessions) sessions="$2"; shift 2 ;;
    --repeats) repeats="$2"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done
[ -n "$out" ] || die "--out <dir> is required"
[ -f "$env_file" ] || die "no staging stack in $state: run staging-up.sh first"
mkdir -p "$out"
pg="$project-postgres"
psql_at() { docker exec -i "$pg" psql -U orbit -d orbit -X -At -v ON_ERROR_STOP=1 "$@"; }

# Sessions spread over the depths present, with the runner each is assigned to (the walk's statement filters on it).
psql_at -c "WITH d AS (
    SELECT s.id, s.\"assigned_runner_id\" AS runner,
           (SELECT count(*) FROM \"run_event\" e WHERE e.\"session_id\" = s.id AND e.\"seq\" > 0) AS n
    FROM \"session\" s WHERE s.\"kind\" = 'CONVERSATION' AND s.\"assigned_runner_id\" IS NOT NULL),
  nz AS (SELECT *, ntile($sessions) OVER (ORDER BY n) AS tile FROM d WHERE n > 0),
  pick AS (SELECT DISTINCT ON (tile) id, runner, n FROM nz ORDER BY tile, n)
  SELECT id || E'\t' || runner || E'\t' || n FROM pick ORDER BY n" > "$out/picked.tsv"
[ -s "$out/picked.tsv" ] || die "no sessions with stored events: run a load test first"
log "timing the welcome walk on $(wc -l < "$out/picked.tsv") sessions, $repeats times each"

printf 'session\trunner\tevents\ttimings_ms\tfastest_ms\n' > "$out/walks.tsv"
while IFS=$'\t' read -r sid runner n; do
  [ -n "$sid" ] || continue
  # The statement runner-link-welcome.ts runs, with this one session. \timing prints the server-side duration.
  sql="SELECT s.id::text AS \"id\",
         COALESCE(
           (SELECT stored.n - 1 FROM (
              SELECT e.\"seq\", row_number() OVER (ORDER BY e.\"seq\") AS n
              FROM \"run_event\" e WHERE e.\"session_id\" = s.id AND e.\"seq\" > 0) stored
            WHERE stored.\"seq\" <> stored.n ORDER BY stored.\"seq\" LIMIT 1),
           (SELECT max(e.\"seq\") FROM \"run_event\" e WHERE e.\"session_id\" = s.id AND e.\"seq\" > 0),
           0)::int AS \"durableSeq\",
         (s.status IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED') AND s.\"kind\" = 'CONVERSATION'
           AND s.\"inbox_lease_owner\" = '$runner'::uuid) AS \"leaseHeld\"
       FROM \"session\" s
       WHERE s.id = ANY(ARRAY['$sid']::uuid[]) AND s.\"assigned_runner_id\" = '$runner'::uuid"
  # Server-side execution time (EXPLAIN ANALYZE's "Execution Time"), every repeat in one backend so its caches are warm,
  # TIMING OFF so the per-node clock reads do not inflate a query this small. stdin is closed: docker exec would
  # otherwise read the rest of the session list this loop is reading.
  explain="EXPLAIN (ANALYZE, TIMING OFF, BUFFERS) $sql"
  args=()
  for _ in $(seq 1 "$repeats"); do args+=(-c "$explain"); done
  timings="$(docker exec "$pg" psql -U orbit -d orbit -X -q -v ON_ERROR_STOP=1 "${args[@]}" < /dev/null 2>/dev/null \
    | awk '/Execution Time:/{print $3}' | paste -sd, -)"
  fastest="$(printf '%s' "$timings" | tr ',' '\n' | grep -E '^[0-9.]+$' | sort -g | head -1)"
  printf '%s\t%s\t%s\t%s\t%s\n' "$sid" "$runner" "$n" "$timings" "${fastest:-}" >> "$out/walks.tsv"
done < "$out/picked.tsv"

# A least-squares fit of the fastest timings against depth: a fixed cost a session, plus a cost an event.
node -e '
const fs = require("fs");
const rows = fs.readFileSync(process.argv[1], "utf8").split("\n").slice(1)
  .map((l) => l.split("\t")).filter((c) => c.length >= 5 && c[4] !== "")
  .map((c) => ({ session: c[0], events: Number(c[2]), ms: Number(c[4]) }))
  .filter((r) => Number.isFinite(r.events) && Number.isFinite(r.ms));
if (rows.length < 3) { console.log(JSON.stringify({ sessions: rows.length, note: "too few timings to fit" })); process.exit(0); }
const n = rows.length;
const sx = rows.reduce((a, r) => a + r.events, 0), sy = rows.reduce((a, r) => a + r.ms, 0);
const sxx = rows.reduce((a, r) => a + r.events * r.events, 0), sxy = rows.reduce((a, r) => a + r.events * r.ms, 0);
const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a = (sy - b * sx) / n;
const my = sy / n;
const ssTot = rows.reduce((s, r) => s + (r.ms - my) ** 2, 0);
const ssRes = rows.reduce((s, r) => s + (r.ms - (a + b * r.events)) ** 2, 0);
const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;
const round = (v, d) => (v === null ? null : Number(v.toFixed(d)));
console.log(JSON.stringify({
  sessions: n,
  depthRange: [Math.min(...rows.map((r) => r.events)), Math.max(...rows.map((r) => r.events))],
  fixedMsPerSession: round(a, 4),
  msPerStoredEvent: round(b, 7),
  usPerStoredEvent: round(b * 1000, 4),
  rSquared: round(r2, 3),
  projectedMs: Object.fromEntries([100, 1000, 10000, 100000].map((d) => [d, round(a + b * d, 2)])),
  measured: rows.map((r) => ({ events: r.events, ms: round(r.ms, 3) })),
}, null, 2));
' "$out/walks.tsv" > "$out/walk.json"
log "written to $out/walk.json"
cat "$out/walk.json"
