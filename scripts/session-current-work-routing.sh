#!/usr/bin/env bash
set -euo pipefail

# The protocol is deliberately rollout-gated. Acceptance represents the post-cutover state after
# every API replica has been replaced; mixed-version deployments must leave this unset/disabled.
export ORBIT_SESSION_CURRENT_WORK_ROUTING_ENABLED=1

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
CONTAINER="orbit-current-work-routing-pg-$$"
DB="orbit_current_work_routing"
DB_USER="orbit_current_work"
DB_PASSWORD="orbit_current_work"
IMAGE="${ORBIT_CURRENT_WORK_PG_IMAGE:-postgres:16-alpine}"

cleanup() {
  # postgres declares /var/lib/postgresql/data as a volume. `-v` is required here so the
  # isolated acceptance run does not leave one anonymous volume behind on every invocation.
  docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> provisioning isolated PostgreSQL"
docker run -d --name "$CONTAINER" \
  -e "POSTGRES_USER=$DB_USER" \
  -e "POSTGRES_PASSWORD=$DB_PASSWORD" \
  -e "POSTGRES_DB=$DB" \
  -p 127.0.0.1::5432 \
  "$IMAGE" >/dev/null
PORT="$(docker port "$CONTAINER" 5432/tcp | tail -n 1)"
PORT="${PORT##*:}"
DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1:$PORT/$DB"

READY=0
for _ in $(seq 1 1200); do
  if docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB" -tAc 'SELECT 1' >/dev/null 2>&1; then
    READY=1
    break
  fi
done
if [ "$READY" != "1" ]; then
  echo "PostgreSQL did not become ready" >&2
  exit 1
fi

PRISMA="$API/node_modules/.bin/prisma"
TSC="$API/node_modules/.bin/tsc"
if [ ! -x "$PRISMA" ] || [ ! -x "$TSC" ]; then
  echo "workspace dependencies are missing; run npm ci first" >&2
  exit 1
fi

echo "==> applying every migration to an empty database"
(
  cd "$API"
  DATABASE_URL="$DATABASE_URL" "$PRISMA" migrate deploy --schema prisma/schema.prisma
  "$PRISMA" generate --schema prisma/schema.prisma
  echo "==> checking the 0210 migrated contract against Prisma datamodel (no target drift)"
  # This repository intentionally has historical SQL-only tables and constraints which are not
  # represented in schema.prisma, so a global --exit-code reports the long-standing pre-0210
  # baseline. Run the full engine diff, but make every object owned by 0210 a zero-drift gate.
  # The catalog assertions below additionally cover CHECK/DEFERRABLE details Prisma does not diff.
  SCHEMA_DIFF="$(DATABASE_URL="$DATABASE_URL" "$PRISMA" migrate diff \
    --from-config-datasource \
    --to-schema prisma/schema.prisma \
    --script)"
  TARGET_DRIFT="$(printf '%s\n' "$SCHEMA_DIFF" | grep -E \
    'conversation_turn_startup_fragment|conversation_turn_target_turn_id|conversation_turn_session_id_id_key|request_fingerprint|send_intent|delivery_(status|failure|terminal|acknowledged)|startup_fragment_id|attachment_single_message_owner' || true)"
  if [ -n "$TARGET_DRIFT" ]; then
    echo "Prisma migration/datamodel drift touches the session CURRENT_WORK contract:" >&2
    printf '%s\n' "$TARGET_DRIFT" >&2
    exit 1
  fi
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
DO $contract$
DECLARE
  startup_content_nullable text;
  target_fk text;
  startup_target_fk text;
BEGIN
  SELECT is_nullable INTO startup_content_nullable
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'conversation_turn_startup_fragment'
     AND column_name = 'content';
  IF startup_content_nullable IS DISTINCT FROM 'NO' THEN
    RAISE EXCEPTION 'startup fragment content must be NOT NULL, got %', startup_content_nullable;
  END IF;

  IF to_regclass('public.conversation_turn_target_turn_id_idx') IS NULL
     OR to_regclass('public.conversation_turn_session_id_id_key') IS NULL
     OR to_regclass('public.conversation_turn_startup_target_created_idx') IS NULL
     OR to_regclass('public.conversation_turn_startup_session_client_key') IS NULL
     OR to_regclass('public.attachment_startup_fragment_id_idx') IS NULL THEN
    RAISE EXCEPTION 'one or more 0210 indexes are missing';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO target_fk
    FROM pg_constraint WHERE conname = 'conversation_turn_target_turn_id_fkey';
  SELECT pg_get_constraintdef(oid) INTO startup_target_fk
    FROM pg_constraint WHERE conname = 'conversation_turn_startup_fragment_target_turn_id_fkey';
  IF target_fk IS NULL OR target_fk NOT LIKE
       'FOREIGN KEY (session_id, target_turn_id) REFERENCES conversation_turn(session_id, id)%' THEN
    RAISE EXCEPTION 'conversation turn target is not a same-session composite FK: %', target_fk;
  END IF;
  IF startup_target_fk IS NULL OR startup_target_fk NOT LIKE
       'FOREIGN KEY (session_id, target_turn_id) REFERENCES conversation_turn(session_id, id)%' THEN
    RAISE EXCEPTION 'startup target is not a same-session composite FK: %', startup_target_fk;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname IN (
       'conversation_turn_send_intent_check',
       'conversation_turn_send_intent_shape_check',
       'conversation_turn_request_fingerprint_check',
       'conversation_turn_delivery_terminal_check',
       'conversation_turn_startup_fragment_terminal_check',
       'attachment_single_message_owner_check'
     ) AND NOT convalidated
  ) THEN
    RAISE EXCEPTION 'one or more 0210 constraints remain NOT VALID';
  END IF;
END
$contract$;
SQL
)

echo "==> compiling shared, API test tree, and Web"
npm run build --workspace @orbit/shared
"$TSC" -p "$API/tsconfig.test.json"
npm run build --workspace @orbit/web

echo "==> API/unit regressions (including legacy queue and steer recovery)"
node --test --test-concurrency=1 \
  "$API/build/common/public-id-coverage.spec.js" \
  "$API/build/realtime/reaper-offline-retry.spec.js" \
  "$API/build/realtime/reaper-queued-cancel.spec.js" \
  "$API/build/realtime/reaper-terminal-fence.spec.js" \
  "$API/build/runner-api/abandoned-steer.spec.js" \
  "$API/build/runner-api/finalize-failed-run.spec.js" \
  "$API/build/runner-api/runner-attempt-guard.spec.js" \
  "$API/build/runner-api/runner-api-events.spec.js" \
  "$API/build/runner-api/runner-dispatch-capabilities.spec.js" \
  "$API/build/runner-api/runner-sessions-orchestration.spec.js" \
  "$API/build/runner-api/service-token.spec.js" \
  "$API/build/runner-api/steer-dequeue.spec.js" \
  "$API/build/runner-api/steer-requeue.spec.js" \
  "$API/build/runner-api/steer-turn-complete.spec.js" \
  "$API/build/sessions/auto-retry.service.spec.js" \
  "$API/build/sessions/cancel-queued-turn-scheduling.spec.js" \
  "$API/build/sessions/create-turn-scheduling.spec.js" \
  "$API/build/sessions/current-work-delivery.spec.js" \
  "$API/build/sessions/entry-point-contract.spec.js" \
  "$API/build/sessions/interrupt-and-send.spec.js" \
  "$API/build/sessions/resume-first-run.spec.js" \
  "$API/build/sessions/steer-kind.spec.js" \
  "$API/build/sessions/steer-queue-visibility.spec.js"

echo "==> PostgreSQL lock race, migration constraints, and real dequeue predicate"
COORDINATOR_PG_URL="$DATABASE_URL" ORBIT_TEST_PG_URL="$DATABASE_URL" node --test --test-concurrency=1 \
  "$API/build/sessions/session-current-work-routing.pg.spec.js" \
  "$API/build/runner-api/steer-dequeue.pg.spec.js"

echo "==> rollback drain gate rejects unresolved receipts"
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO "user"(id, email, name, password_hash)
VALUES ('8a000000-0000-4000-8000-000000000001',
        'current-work-rollback-gate@example.test', 'rollback gate', 'test');
INSERT INTO "session"(id, title, prompt, owner_id, creator_id, status, num_turns, updated_at)
VALUES ('8a000000-0000-4000-8000-000000000002', 'rollback gate', 'opening',
        '8a000000-0000-4000-8000-000000000001',
        '8a000000-0000-4000-8000-000000000001', 'RUNNING', 1, clock_timestamp());
INSERT INTO "conversation_turn"(
  id, session_id, seq, client_turn_id, kind, content, status, delivered_at,
  lease_deadline_at, lease_generation
) VALUES (
  '8a000000-0000-4000-8000-000000000003',
  '8a000000-0000-4000-8000-000000000002', 1, 'rollback-target', 'message',
  'opening', 'IN_FLIGHT', clock_timestamp(), clock_timestamp() + interval '1 minute',
  '8a000000-0000-4000-8000-000000000006'
);
INSERT INTO "conversation_turn_startup_fragment"(
  id, session_id, target_turn_id, client_turn_id, content, delivered_at
) VALUES (
  '8a000000-0000-4000-8000-000000000004',
  '8a000000-0000-4000-8000-000000000002',
  '8a000000-0000-4000-8000-000000000003', 'rollback-startup', 'unresolved startup',
  clock_timestamp()
);
INSERT INTO "conversation_turn"(
  id, session_id, seq, client_turn_id, kind, content, status, send_intent, target_turn_id,
  delivered_at
) VALUES (
  '8a000000-0000-4000-8000-000000000005',
  '8a000000-0000-4000-8000-000000000002', 2, 'rollback-current', 'steer',
  'unresolved steer', 'ANSWERED', 'CURRENT_WORK',
  '8a000000-0000-4000-8000-000000000003', clock_timestamp()
);
SQL
if DATABASE_URL="$DATABASE_URL" bash "$REPO/scripts/session-current-work-rollback-check.sh"; then
  echo "rollback gate unexpectedly passed with unresolved CURRENT_WORK receipts" >&2
  exit 1
else
  echo "rollback gate correctly blocked unresolved receipts"
fi

echo "==> terminal receipts fix steer safety but startup remains an N-1 compatibility fence"
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
UPDATE "conversation_turn_startup_fragment"
   SET delivery_status = 'FAILED',
       failed_at = clock_timestamp(),
       failure_code = 'ROLLBACK_DRAIN_TEST',
       failure_reason = 'terminalized by rollback acceptance'
 WHERE id = '8a000000-0000-4000-8000-000000000004';
UPDATE "conversation_turn"
   SET status = 'ANSWERED', answered_at = clock_timestamp(),
       delivery_status = 'FAILED',
       delivery_failure_code = 'ROLLBACK_DRAIN_TEST',
       delivery_failure_reason = 'terminalized by rollback acceptance',
       delivery_terminal_at = clock_timestamp()
 WHERE id = '8a000000-0000-4000-8000-000000000005';
SQL
if DATABASE_URL="$DATABASE_URL" bash "$REPO/scripts/session-current-work-rollback-check.sh"; then
  echo "rollback gate unexpectedly accepted a historical startup fragment" >&2
  exit 1
else
  echo "rollback gate correctly kept the N-1 startup compatibility fence"
fi

echo "==> rollback gate keeps runner-loss UNCONFIRMED receipts unsafe"
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
-- This is an isolated acceptance fixture, not a production drain operation. Production keeps
-- startup audit rows and therefore cannot roll back to an API that does not understand them.
DELETE FROM "conversation_turn_startup_fragment"
 WHERE id = '8a000000-0000-4000-8000-000000000004';
INSERT INTO "conversation_turn"(
  id, session_id, seq, client_turn_id, kind, content, status, send_intent, target_turn_id,
  delivered_at, answered_at, delivery_status, delivery_acknowledged_at
) VALUES (
  '8a000000-0000-4000-8000-000000000007',
  '8a000000-0000-4000-8000-000000000002', 3, 'rollback-current-acked', 'steer',
  'acknowledged steer', 'ANSWERED', 'CURRENT_WORK',
  '8a000000-0000-4000-8000-000000000003', clock_timestamp(), clock_timestamp(),
  'ACKNOWLEDGED', clock_timestamp()
);
INSERT INTO "conversation_turn"(
  id, session_id, seq, client_turn_id, kind, content, status, send_intent, target_turn_id,
  delivered_at, answered_at, delivery_status, delivery_failure_code,
  delivery_failure_reason, delivery_terminal_at
) VALUES (
  '8a000000-0000-4000-8000-000000000008',
  '8a000000-0000-4000-8000-000000000002', 4, 'rollback-current-unconfirmed', 'steer',
  'possibly consumed before runner loss', 'ANSWERED', 'CURRENT_WORK',
  '8a000000-0000-4000-8000-000000000003', clock_timestamp(), clock_timestamp(),
  'UNCONFIRMED', 'CURRENT_WORK_SESSION_REAPED',
  'Delivery could not be confirmed after runner loss.', clock_timestamp()
);
SQL
if DATABASE_URL="$DATABASE_URL" bash "$REPO/scripts/session-current-work-rollback-check.sh"; then
  echo "rollback gate unexpectedly accepted an UNCONFIRMED runner-loss receipt" >&2
  exit 1
else
  echo "rollback gate correctly blocked the UNCONFIRMED runner-loss receipt"
fi

echo "==> rollback gate accepts only valid ACK/FAILED steer proofs after ambiguity is resolved"
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
UPDATE "conversation_turn"
   SET delivery_status = 'FAILED',
       delivery_failure_code = 'ROLLBACK_DRAIN_TEST',
       delivery_failure_reason = 'operator proved the message did not enter the engine'
 WHERE id = '8a000000-0000-4000-8000-000000000008';
SQL
DATABASE_URL="$DATABASE_URL" bash "$REPO/scripts/session-current-work-rollback-check.sh"

echo "==> Web authoritative-placement and three-state UI regressions"
npm test --workspace @orbit/web -- --run \
  src/api.test.ts \
  src/components/Transcript.test.tsx \
  src/components/WorkspaceView.queuedTurn.test.tsx \
  src/lib/acceptedUserTurn.test.ts \
  src/lib/composerSendState.test.ts \
  src/lib/sessionTurnIntent.test.ts \
  src/lib/reseedActiveSnapshot.test.ts \
  src/lib/steerDelivery.test.ts \
  src/lib/steerDeliveryParity.test.ts \
  src/lib/turnPlacement.test.ts

echo "==> runner Codex/Claude steer recovery regressions"
(
  cd "$REPO/src/runner-go"
  go test -v ./... -run '(Steer|CurrentWork|DeliveryFlush|TargetFence)' -count=1
)

echo "==> session CURRENT_WORK routing acceptance passed"
