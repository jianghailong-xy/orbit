#!/usr/bin/env bash
# The T16 rehearsal of docs/session-status-retirement-plan.md §7.2 (deploy D1, the backfill, deploy D2), step by step,
# on an isolated stack (loopback only; never production): the runner link staging stack of
# scripts/runner-link/staging-up.sh through scripts/acceptance/landing-measured/stack.sh, under the Compose project
# orbit-link-t16, with two apiservers on one database. README.md beside this file says what each step shows.
#
#   rehearse.sh up          the stack, both apiservers at D1 code (images from build-images.sh)
#   rehearse.sh rewind      stop both apiservers; take the fresh database back to before D1 (D1's down script)
#   rehearse.sh seed        the production-shaped rows: session-status-query-plans-seed.sql and seed-shapes.cjs
#   rehearse.sh d1          writer loop and lock sampler on; start the D1 apiservers, which apply 1611 and 1612
#   rehearse.sh census <label>
#   rehearse.sh gate        the post-backfill gate (T5's history, 1daa60562d 1622) on the database as it is
#   rehearse.sh backfill    scripts/session-turn-state-backfill.sh, timed
#   rehearse.sh plans <label>   scripts/session-status-query-plans.sql (plans=1 writes=1)
#   rehearse.sh d2          hand-over: apiserver-b replaced by D2 code, which applies 1621-1643 while D1 serves
#   rehearse.sh post-gate   the post-backfill migrations of 1daa60562d (gate, strict CHECK, VALIDATEs, NOT NULL)
#   rehearse.sh migrations  _prisma_migrations' timings for the session-status migrations
#   rehearse.sh cutover     the end of the hand-over: D1 stops, the D2 replica answers as apiserver
#   rehearse.sh stop-load   writer loop and lock sampler off, with their summaries
#   rehearse.sh down        remove the stack and every container this script started
#
# Records go to $OUT (default /mnt/tmp/t16/out): one file per step, and timeline.log.
set -euo pipefail
HERE=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
export LM_PROJECT=${LM_PROJECT:-orbit-link-t16}
export LM_DIR=${LM_DIR:-/mnt/tmp/t16/lm}
export LM_HTTP_PORT=${LM_HTTP_PORT:-57086} LM_LINK_PORT=${LM_LINK_PORT:-57443} LM_METRICS_PORT=${LM_METRICS_PORT:-57464}
export LM_NATS_PORT=${LM_NATS_PORT:-57422} LM_NATS_MONITOR_PORT=${LM_NATS_MONITOR_PORT:-57822} LM_PEBBLE_PORT=${LM_PEBBLE_PORT:-57500}
export ORBIT_LINK_STAGING_BACKENDS=2
OUT=${OUT:-/mnt/tmp/t16/out}
P=$LM_PROJECT
PG=$P-postgres
NET=${P}_default
DB_URL='postgresql://orbit:orbit@postgres:5432/orbit?schema=public'
POST_GATE_REF=1daa60562d
mkdir -p "$OUT"
stamp() { date -u +%FT%T.%3NZ; }
log() { echo "$(stamp) $*" | tee -a "$OUT/timeline.log"; }
psqlc() { docker exec -i "$PG" psql -U orbit -d orbit -X -v ON_ERROR_STOP=1 "$@"; }
kit() { docker run --rm --network "$NET" -e DATABASE_URL="$DB_URL" -v "$HERE:/kit:ro" -v "$REPO/scripts:/scripts:ro" "$P-apiserver:d2" "$@"; }
healthy() { docker exec "$1" node -e "fetch('http://127.0.0.1:3000/api').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; }
wait_healthy() {
  local c=$1 t0; t0=$(date +%s)
  until healthy "$c"; do
    docker ps --format '{{.Names}}' | grep -qx "$c" || { docker logs --tail 60 "$c"; echo "$c exited"; return 1; }
    [ $(( $(date +%s) - t0 )) -lt 900 ] || { echo "$c not healthy after 900 s"; return 1; }
    sleep 1
  done
  log "$c healthy after $(( $(date +%s) - t0 )) s"
}
migrations() {
  psqlc -A -F $'\t' -c "SELECT migration_name, started_at, finished_at,
      round(extract(epoch FROM finished_at - started_at)::numeric * 1000) AS ms, applied_steps_count, rolled_back_at
    FROM _prisma_migrations WHERE migration_name ~ '^16[0-9][0-9]_' ORDER BY started_at"
}
image_of() { docker inspect -f '{{.Config.Image}} {{.Image}}' "$1"; }

case "${1:-}" in
up)
  for side in d1 d2; do docker image inspect "$P-apiserver:$side" >/dev/null; done
  docker tag "$P-apiserver:d1" "$P-apiserver:local"
  log "up: apiserver and apiserver-b at D1 ($(docker image inspect -f '{{index .Config.Labels "t16.source"}}' "$P-apiserver:d1"))"
  bash "$REPO/scripts/acceptance/landing-measured/stack.sh" up --no-build > "$OUT/up.log" 2>&1 || { tail -40 "$OUT/up.log"; exit 1; }
  log "up: $(image_of "$P-apiserver") / $(image_of "$P-apiserver-b")"
  migrations | tail -5 | tee "$OUT/up-migrations.tsv"
  ;;
rewind)
  docker stop -t 30 "$P-apiserver-b" "$P-apiserver" >/dev/null
  log "rewind: both apiservers stopped; D1's down script and its two _prisma_migrations rows"
  psqlc -f - < "$REPO/scripts/session-turn-state-phase-down.sql"
  psqlc -c "DELETE FROM _prisma_migrations WHERE migration_name IN ('1611_session_turn_state_phase', '1612_session_turn_state_phase_validate')"
  # A fresh database migrated by D1 code holds every migration of that tree; the stack's own seed wrote no session.
  psqlc -At -c "SELECT count(*) AS columns_left FROM information_schema.columns WHERE table_name = 'session' AND column_name IN ('turn_state', 'phase')" | tee "$OUT/rewind.txt"
  psqlc -At -c "SELECT max(migration_name) FROM _prisma_migrations" | tee -a "$OUT/rewind.txt"
  ;;
seed)
  log "seed: session-status-query-plans-seed.sql"
  t0=$(date +%s)
  psqlc -f - < "$REPO/scripts/session-status-query-plans-seed.sql" > "$OUT/seed.txt" 2>&1 || { tail -30 "$OUT/seed.txt"; exit 1; }
  log "seed: plans seed in $(( $(date +%s) - t0 )) s"
  kit node /kit/seed-shapes.cjs > "$OUT/seed-shapes.json"
  log "seed: shapes $(node -e 'const j=require(process.argv[1]); console.log(j.shapes, "shapes,", j.rows, "rows")' "$OUT/seed-shapes.json")"
  psqlc -c 'VACUUM (ANALYZE) "session"' >/dev/null
  psqlc -A -F $'\t' -c "SELECT status, count(*), count(*) FILTER (WHERE finished_at IS NULL) AS held FROM session GROUP BY 1 ORDER BY 1" | tee "$OUT/seed-counts.tsv"
  ;;
d1)
  docker rm -f t16-writer >/dev/null 2>&1 || true
  docker run -d --name t16-writer --network "$NET" -e DATABASE_URL="$DB_URL" -v "$HERE:/kit:ro" "$P-apiserver:d2" node /kit/writer-loop.cjs >/dev/null
  # Its own session, so it outlives the step that starts it (a runner-hosted job ends its process group); stop-load
  # stops it.
  setsid bash "$HERE/sample-locks.sh" "$PG" "$OUT/locks.jsonl" > /dev/null 2>&1 < /dev/null &
  echo $! > "$OUT/sampler.pid"
  sleep 5
  log "d1: writer loop and lock sampler on; starting the D1 apiservers (prisma migrate deploy at boot: 1611, 1612)"
  docker start "$P-apiserver" >/dev/null
  wait_healthy "$P-apiserver"
  docker start "$P-apiserver-b" >/dev/null
  wait_healthy "$P-apiserver-b"
  migrations | tee "$OUT/d1-migrations.tsv"
  docker logs "$P-apiserver" 2>&1 | grep -E 'migration|Applying|applied|All migrations' | head -20 > "$OUT/d1-apiserver-migrate.log" || true
  ;;
census)
  label=${2:?label}
  log "census $label"
  set +e
  kit node /kit/census.cjs "$label" > "$OUT/census-$label.json"
  rc=$?
  set -e
  log "census $label: exit $rc $(node -e 'const j=require(process.argv[1]); console.log(JSON.stringify(j.totals), JSON.stringify(j.byKind))' "$OUT/census-$label.json")"
  psqlc -At -f - < "$REPO/scripts/session-turn-state-census.sql" > "$OUT/census-sql-$label.txt" 2>&1 || true
  ;;
gate)
  log "gate: 1622 of $POST_GATE_REF (refuses a row whose facts are not the word's)"
  set +e
  git -C "$REPO" show "$POST_GATE_REF:src/apiserver/prisma/migrations/1622_session_turn_state_checks/migration.sql" |
    psqlc -c '\timing on' -f - > "$OUT/gate-${2:-run}.txt" 2>&1
  rc=$?
  set -e
  log "gate: exit $rc: $(grep -E 'ERROR|HINT|Time:' "$OUT/gate-${2:-run}.txt" | tr '\n' ' ' | cut -c1-400)"
  ;;
backfill)
  log "backfill: start"
  t0=$(date +%s.%N)
  PSQL="docker exec -i $PG psql -U orbit -d orbit" bash "$REPO/scripts/session-turn-state-backfill.sh" > "$OUT/backfill.txt" 2>&1
  t1=$(date +%s.%N)
  log "backfill: $(tail -1 "$OUT/backfill.txt") in $(echo "$t1 - $t0" | bc) s"
  ;;
plans)
  label=${2:?label}
  log "plans $label"
  psqlc -v plans=1 -v writes=1 -f - < "$REPO/scripts/session-status-query-plans.sql" > "$OUT/plans-$label.txt" 2>&1 || { tail -30 "$OUT/plans-$label.txt"; exit 1; }
  log "plans $label: written"
  ;;
d2)
  b=$P-apiserver-b
  env_file=$OUT/apiserver-b.env
  (umask 077; docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$b" | grep -vE '^(PATH|NODE_VERSION|YARN_VERSION|HOSTNAME)=' | grep . > "$env_file")
  binds=$(docker inspect -f '{{range .HostConfig.Binds}}-v {{.}} {{end}}' "$b")
  log "d2: hand-over. $b ($(image_of "$b")) stopped and replaced by D2 code; $P-apiserver stays at D1 and serves"
  docker stop -t 30 "$b" >/dev/null && docker rm "$b" >/dev/null
  # shellcheck disable=SC2086
  docker run -d --name "$b" --network "$NET" --network-alias apiserver-b --env-file "$env_file" $binds \
    --label t16.replaced=compose-apiserver-b "$P-apiserver:d2" >/dev/null
  wait_healthy "$b"
  log "d2: $(image_of "$b") serving beside $(image_of "$P-apiserver")"
  migrations | tee "$OUT/d2-migrations.tsv"
  docker logs "$b" 2>&1 | grep -E 'migration|Applying|applied|All migrations' | head -30 > "$OUT/d2-apiserver-migrate.log" || true
  ;;
post-gate)
  log "post-gate: the post-backfill migrations of $POST_GATE_REF, as prisma migrate deploy sends them"
  : > "$OUT/post-gate.txt"
  for m in 1622_session_turn_state_checks 1623_session_turn_state_agrees_validate 1624_session_turn_state_released_validate \
           1625_session_phase_not_null_validate 1626_session_phase_set_not_null; do
    echo "=== $m $(stamp)" >> "$OUT/post-gate.txt"
    t0=$(date +%s%N)
    git -C "$REPO" show "$POST_GATE_REF:src/apiserver/prisma/migrations/$m/migration.sql" | psqlc -c '\timing on' -f - >> "$OUT/post-gate.txt" 2>&1
    log "post-gate: $m in $(( ($(date +%s%N) - t0) / 1000000 )) ms"
    if [ "$m" = 1622_session_turn_state_checks ]; then
      # What the later task adds beside it: 1622 of the project branch's NULL-tolerant CHECK goes.
      echo "=== drop session_turn_state_agrees_unless_null_chk $(stamp)" >> "$OUT/post-gate.txt"
      psqlc -c '\timing on' -c 'SET lock_timeout = '"'"'2s'"'"'' -c 'ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_turn_state_agrees_unless_null_chk"' >> "$OUT/post-gate.txt" 2>&1
    fi
  done
  psqlc -A -F $'\t' -c "SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'session'::regclass AND conname ~ 'turn_state|phase' ORDER BY 1" | tee -a "$OUT/post-gate.txt"
  psqlc -At -c "SELECT attnotnull FROM pg_attribute WHERE attrelid = 'session'::regclass AND attname = 'phase'" | sed 's/^/phase NOT NULL: /' | tee -a "$OUT/post-gate.txt"
  ;;
cutover)
  # The end of the hand-over: the D1 replica stops and the D2 one answers to the service name too, as a deployment's
  # new apiserver does (the web gateway and the link gateway's revocation read address `apiserver`).
  b=$P-apiserver-b
  log "cutover: $P-apiserver (D1) stopped; $b (D2) answers as apiserver"
  docker stop -t 30 "$P-apiserver" >/dev/null
  docker network disconnect "$NET" "$b"
  docker network connect --alias apiserver-b --alias apiserver "$NET" "$b"
  docker restart -t 10 "$P-gateway" >/dev/null
  wait_healthy "$b"
  for _ in $(seq 1 60); do
    [ "$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$LM_HTTP_PORT/api/auth/setup-status")" = 200 ] && break
    sleep 1
  done
  log "cutover: the web gateway answers $(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$LM_HTTP_PORT/api/auth/setup-status") through $(image_of "$b")"
  ;;
migrations)
  migrations
  ;;
stop-load)
  [ -f "$OUT/sampler.pid" ] && { kill -- -"$(cat "$OUT/sampler.pid")" 2>/dev/null || true; rm -f "$OUT/sampler.pid"; }
  psqlc -At -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 't16-lock-sampler'" >/dev/null || true
  docker stop -t 20 t16-writer >/dev/null 2>&1 || true
  docker logs t16-writer > "$OUT/writer-loop.jsonl" 2>&1 || true
  docker rm t16-writer >/dev/null 2>&1 || true
  log "stop-load: writer $(grep -c '"slow"' "$OUT/writer-loop.jsonl" || true) slow lines; $(wc -l < "$OUT/locks.jsonl" 2>/dev/null || echo 0) lock samples with a waiter"
  ;;
down)
  docker rm -f t16-writer "$P-apiserver-b" >/dev/null 2>&1 || true
  bash "$REPO/scripts/acceptance/landing-measured/stack.sh" down
  ;;
*) sed -n '2,24p' "$0"; exit 2 ;;
esac
