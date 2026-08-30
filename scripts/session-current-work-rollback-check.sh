#!/usr/bin/env bash
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 2
fi

read -r STARTUP STEERS < <(
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -F ' ' <<'SQL'
SELECT
  (SELECT count(*)
     FROM conversation_turn_startup_fragment),
  (SELECT count(*)
     FROM conversation_turn
    WHERE send_intent = 'CURRENT_WORK'
      AND NOT COALESCE(
        (delivery_status = 'ACKNOWLEDGED'
          AND delivery_acknowledged_at IS NOT NULL
          AND delivery_failure_code IS NULL
          AND delivery_failure_reason IS NULL
          AND delivery_terminal_at IS NULL)
        OR
        (delivery_status = 'FAILED'
          AND delivery_acknowledged_at IS NULL
          AND delivery_failure_code IS NOT NULL
          AND delivery_failure_reason IS NOT NULL
          AND delivery_terminal_at IS NOT NULL),
        false
      ));
SQL
)

echo "n_minus_one_incompatible_startup_fragments=$STARTUP unresolved_current_work_steers=$STEERS"
if [ "$STARTUP" != "0" ] || [ "$STEERS" != "0" ]; then
  echo "rollback blocked: every CURRENT_WORK steer needs ACK/FAILED proof (UNCONFIRMED is unsafe), and any startup fragment permanently requires a routing-aware API" >&2
  exit 1
fi
