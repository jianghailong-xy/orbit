#!/usr/bin/env bash
# Seeds a load test's fleet into the staging stack's database, and writes the fleet file loadgen plays
# (src/link-gateway/cmd/loadgen): owners, their runners, a workspace per runner, and the sessions the runners'
# heartbeats name. Sized after the cell's planning numbers (docs/runner-link-design.md §1.3, §9): per owner 1.5 runner
# connections, 4 open sessions and 0.5 turns running at the peak.
#
#   scripts/runner-link/loadgen-seed.sh seed     # owners, runners, workspaces and the idle sessions, once
#   scripts/runner-link/loadgen-seed.sh arm      # before each run: fresh running sessions, presence, the fleet file
#   scripts/runner-link/loadgen-seed.sh disarm   # after each run: its running sessions end (loadgen-run.sh does it)
#   scripts/runner-link/loadgen-seed.sh remove   # delete everything it seeded, events included
#
# Sizes, read by seed and arm: LOADGEN_OWNERS (10000), LOADGEN_RUNNERS (15000), LOADGEN_SESSIONS (40000 open sessions,
# the running ones included) and LOADGEN_ACTIVE (5000 running). Owner n has runners n and n + LOADGEN_OWNERS while there
# are runners left; its sessions are spread over its runners, and owners 0, 2, 4, ... have one of them running.
#
# Rows are SQL inserts, not API calls: 15,000 registrations would test the registration route, not the link. Every
# owner is user loadgen-<n>@loadgen.orbit-staging.test. Each runner's token, which the database keeps only as a hash,
# and its process id are kept in the loadgen schema beside the app's, for the fleet file. A running session is leased
# to its runner's process, as a claim leaves it, and has an engine session id, as an engine that started gives it.
# `arm` ends the previous run's running sessions and makes new ones, so each run starts from seq 1 on sessions nobody
# reaped. `disarm` ends them as soon as a run is over: left running, the reaper would fail them 90 s after the fleet
# went quiet and queue their cancellation for the runner's next process, which the next run would then be handed.
# The fleet file is <state>/loadgen/fleet.jsonl.
set -euo pipefail
# shellcheck source=staging-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/staging-lib.sh"

cmd="${1:-}"
case "$cmd" in seed|arm|disarm|remove) ;; *) sed -n '2,25p' "$0" >&2; exit 2 ;; esac
[ -f "$env_file" ] || die "no staging stack in $state: run staging-up.sh first"
owners="${LOADGEN_OWNERS:-10000}"
runners="${LOADGEN_RUNNERS:-15000}"
sessions="${LOADGEN_SESSIONS:-40000}"
active="${LOADGEN_ACTIVE:-5000}"
for v in "$owners" "$runners" "$sessions" "$active"; do
  [[ "$v" =~ ^[1-9][0-9]*$ ]] || die "sizes are positive whole numbers, not $v"
done
[ "$runners" -ge "$owners" ] && [ "$runners" -le $((2 * owners)) ] || die "LOADGEN_RUNNERS is between LOADGEN_OWNERS and twice it"
[ "$sessions" -ge "$runners" ] || die "LOADGEN_SESSIONS is at least LOADGEN_RUNNERS: every runner has a session"
[ "$active" -le $(((owners + 1) / 2)) ] || die "LOADGEN_ACTIVE is at most half of LOADGEN_OWNERS: one running session per even owner"

pg="$project-postgres"
psql_run() {
  docker exec -i "$pg" psql -U orbit -d orbit -v ON_ERROR_STOP=1 -q -X \
    -v owners="$owners" -v runners="$runners" -v sessions="$sessions" -v active="$active" "$@"
}

case "$cmd" in
seed)
  log "seeding $owners owners, $runners runners and $sessions open sessions into $pg"
  psql_run <<'SQL'
BEGIN;
CREATE SCHEMA IF NOT EXISTS loadgen;
CREATE TABLE IF NOT EXISTS loadgen.runner (
  n integer PRIMARY KEY, runner_id uuid NOT NULL UNIQUE, workspace_id uuid NOT NULL UNIQUE, owner_n integer NOT NULL,
  token text NOT NULL, process uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS loadgen.owner (n integer PRIMARY KEY, user_id uuid NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS loadgen.session (
  session_id uuid PRIMARY KEY, runner_n integer NOT NULL, owner_n integer NOT NULL, running boolean NOT NULL
);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM loadgen.owner) THEN
    RAISE EXCEPTION 'already seeded: run remove first, or arm';
  END IF;
END $$;

INSERT INTO loadgen.owner (n, user_id) SELECT n, gen_random_uuid() FROM generate_series(0, :owners - 1) n;
INSERT INTO "user" (id, email, name)
  SELECT user_id, format('loadgen-%s@loadgen.orbit-staging.test', n), format('Load test owner %s', n) FROM loadgen.owner;

INSERT INTO loadgen.runner (n, runner_id, workspace_id, owner_n, token, process)
  SELECT n, gen_random_uuid(), gen_random_uuid(), n % :owners, 'lg_' || encode(gen_random_bytes(24), 'hex'), gen_random_uuid()
  FROM generate_series(0, :runners - 1) n;
INSERT INTO runner (id, name, owner_id, token_hash, status, max_concurrent, last_heartbeat_at)
  SELECT r.runner_id, format('loadgen-%s', r.n), o.user_id, encode(sha256(convert_to(r.token, 'UTF8')), 'hex'), 'ONLINE', 2, now()
  FROM loadgen.runner r JOIN loadgen.owner o ON o.n = r.owner_n;
INSERT INTO workspace (id, name, owner_id, runner_id, work_dir)
  SELECT r.workspace_id, format('loadgen %s', r.n), o.user_id, r.runner_id, format('/home/u%s/src/app', lpad(r.n::text, 5, '0'))
  FROM loadgen.runner r JOIN loadgen.owner o ON o.n = r.owner_n;
COMMIT;
SQL
  psql_run <<'SQL'
BEGIN;
-- Open sessions: session k goes to owner k % owners, and to that owner's runners in turn.
WITH s AS (
  SELECT k, k % :owners AS owner_n, (k / :owners) AS round FROM generate_series(0, :sessions - :active - 1) k
), per_owner AS (
  SELECT o.n AS owner_n, array_agg(r.n ORDER BY r.n) AS runner_ns FROM loadgen.owner o JOIN loadgen.runner r ON r.owner_n = o.n GROUP BY o.n
)
INSERT INTO loadgen.session (session_id, runner_n, owner_n, running)
  SELECT gen_random_uuid(), p.runner_ns[1 + (s.round % array_length(p.runner_ns, 1))], s.owner_n, false
  FROM s JOIN per_owner p ON p.owner_n = s.owner_n;
INSERT INTO session (id, title, prompt, owner_id, creator_id, updated_at, workspace_id, assigned_runner_id, status, engine,
                     runtime_session_id, inbox_lease_owner, last_turn_at)
  SELECT ls.session_id, format('Load test session %s', ls.session_id), 'load test', o.user_id, o.user_id, now(), r.workspace_id,
         r.runner_id, 'AWAITING_INPUT', 'claude', gen_random_uuid()::text, r.process, now()
  FROM loadgen.session ls JOIN loadgen.runner r ON r.n = ls.runner_n JOIN loadgen.owner o ON o.n = ls.owner_n;
COMMIT;
ANALYZE "user"; ANALYZE runner; ANALYZE workspace; ANALYZE session;
SQL
  log "seeded; run arm before each load test"
  ;;
arm)
  log "arming $active running sessions in $pg"
  psql_run <<'SQL'
BEGIN;
-- The previous run's running sessions are over; the reaper may have finished some of them already. A cancellation it
-- queued for one would be handed to the runner's next process for five minutes (RealtimeService.drainCancellations).
UPDATE session s SET status = 'SUCCEEDED', finished_at = now(), updated_at = now()
  FROM loadgen.session ls WHERE ls.session_id = s.id AND ls.running AND s.status IN ('RUNNING', 'PENDING', 'INTERRUPTED');
UPDATE session s SET cancel_requested_at = NULL
  FROM loadgen.owner o WHERE s.owner_id = o.user_id AND s.cancel_requested_at IS NOT NULL;
DELETE FROM loadgen.session WHERE running;
-- One running session for each even owner, on its first runner.
WITH chosen AS (
  SELECT o.n AS owner_n, min(r.n) AS runner_n FROM loadgen.owner o JOIN loadgen.runner r ON r.owner_n = o.n
  WHERE o.n % 2 = 0 AND o.n / 2 < :active GROUP BY o.n
)
INSERT INTO loadgen.session (session_id, runner_n, owner_n, running)
  SELECT gen_random_uuid(), runner_n, owner_n, true FROM chosen;
INSERT INTO session (id, title, prompt, owner_id, creator_id, updated_at, workspace_id, assigned_runner_id, status, engine,
                     runtime_session_id, inbox_lease_owner, last_turn_at)
  SELECT ls.session_id, format('Load test session %s', ls.session_id), 'load test', o.user_id, o.user_id, now(), r.workspace_id,
         r.runner_id, 'RUNNING', 'claude', gen_random_uuid()::text, r.process, now()
  FROM loadgen.session ls JOIN loadgen.runner r ON r.n = ls.runner_n JOIN loadgen.owner o ON o.n = ls.owner_n
  WHERE ls.running;
-- Every runner heard from just now: the reaper reads 90 s of silence as a runner gone (runners/runner-presence.ts),
-- and the fleet takes about as long to connect.
UPDATE runner r SET status = 'ONLINE', last_heartbeat_at = now() FROM loadgen.runner lr WHERE lr.runner_id = r.id;
UPDATE runner_presence p SET last_beat_at = now() FROM loadgen.runner lr WHERE lr.runner_id = p.runner_id;
COMMIT;
ANALYZE session;
SQL
  mkdir -p "$state/loadgen"
  psql_run -At > "$state/loadgen/fleet.jsonl.new" <<'SQL'
SELECT json_build_object(
  'runner', r.runner_id, 'token', r.token, 'process', r.process,
  'sessions', coalesce((SELECT json_agg(ls.session_id ORDER BY ls.session_id) FROM loadgen.session ls WHERE ls.runner_n = r.n), '[]'),
  'active', coalesce((SELECT json_agg(json_build_object('id', ls.session_id, 'seq', 0)) FROM loadgen.session ls
                      WHERE ls.runner_n = r.n AND ls.running), '[]'))
FROM loadgen.runner r ORDER BY r.n;
SQL
  mv -f "$state/loadgen/fleet.jsonl.new" "$state/loadgen/fleet.jsonl"
  log "fleet: $(wc -l < "$state/loadgen/fleet.jsonl") runners in $state/loadgen/fleet.jsonl"
  ;;
disarm)
  log "ending the running sessions in $pg"
  psql_run <<'SQL'
UPDATE session s SET status = 'SUCCEEDED', finished_at = now(), updated_at = now()
  FROM loadgen.session ls WHERE ls.session_id = s.id AND ls.running AND s.status IN ('RUNNING', 'PENDING', 'INTERRUPTED');
SQL
  ;;
remove)
  log "removing the load test's rows from $pg"
  psql_run <<'SQL'
BEGIN;
SET LOCAL statement_timeout = 0;
DELETE FROM session s USING loadgen.owner o WHERE s.owner_id = o.user_id;
DELETE FROM workspace w USING loadgen.owner o WHERE w.owner_id = o.user_id;
DELETE FROM runner r USING loadgen.owner o WHERE r.owner_id = o.user_id;
DELETE FROM "user" u USING loadgen.owner o WHERE u.id = o.user_id;
DROP SCHEMA loadgen CASCADE;
COMMIT;
SQL
  rm -f "$state/loadgen/fleet.jsonl"
  log "removed"
  ;;
esac
