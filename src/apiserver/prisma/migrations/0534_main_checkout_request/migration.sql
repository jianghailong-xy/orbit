-- 0534: the main checkout relay (docs/main-checkout-git-contract.md §10, project 34vZkpKmUuObg8kDVU4Lk).
--
--   main_checkout_request  one row per snapshot read (`op` = 'snapshot') or action (`op` = 'action') a workspace asked
--                          its runner for. The repo-cleanup relay generalized: queued here, handed out once on the
--                          runner's heartbeat (pending → claimed), finished by the runner's answer or by the timeout.
--
-- Two indexes carry the rules the service relies on rather than re-checking them under a lock:
--   main_checkout_request_id_key        a client's requestId names one action per owner, so a repeat finds the first.
--   main_checkout_request_in_flight_key one action in flight per runner and checkout root (ACTION_IN_FLIGHT).
--
-- New table only: no existing row is written. Every statement can run twice.
CREATE TABLE IF NOT EXISTS "main_checkout_request" (
  "id"                        UUID NOT NULL,
  "owner_id"                  UUID NOT NULL,
  "workspace_id"              UUID NOT NULL,
  "runner_id"                 UUID NOT NULL,
  "root"                      TEXT NOT NULL,
  "op"                        TEXT NOT NULL,
  "request_id"                TEXT,
  "kind"                      TEXT,
  "input"                     JSONB NOT NULL DEFAULT '{}',
  "initiated_from_session_id" UUID,
  "state"                     TEXT NOT NULL DEFAULT 'pending',
  "result"                    JSONB,
  "late_result"               JSONB,
  "created_at"                TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"                TIMESTAMPTZ(3) NOT NULL,
  "claimed_at"                TIMESTAMPTZ(3),
  "finished_at"               TIMESTAMPTZ(3),
  CONSTRAINT "main_checkout_request_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "main_checkout_request_workspace_fkey"
    FOREIGN KEY ("workspace_id", "owner_id") REFERENCES "workspace" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "main_checkout_request_op_chk" CHECK ("op" IN ('snapshot', 'action')),
  CONSTRAINT "main_checkout_request_state_chk" CHECK ("state" IN ('pending', 'claimed', 'finished')),
  CONSTRAINT "main_checkout_request_action_chk" CHECK (
    "op" <> 'action' OR ("request_id" IS NOT NULL AND "kind" IN ('move', 'commit', 'push', 'rescue'))),
  CONSTRAINT "main_checkout_request_finished_chk" CHECK (("state" = 'finished') = ("finished_at" IS NOT NULL)),
  CONSTRAINT "main_checkout_request_input_chk" CHECK (jsonb_typeof("input") = 'object'),
  CONSTRAINT "main_checkout_request_result_chk" CHECK ("result" IS NULL OR jsonb_typeof("result") = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS "main_checkout_request_id_key"
  ON "main_checkout_request" ("owner_id", "request_id");
CREATE UNIQUE INDEX IF NOT EXISTS "main_checkout_request_in_flight_key"
  ON "main_checkout_request" ("runner_id", "root") WHERE "op" = 'action' AND "state" <> 'finished';
-- The heartbeat's drain and the timeout sweep: what is still open for a runner.
CREATE INDEX IF NOT EXISTS "main_checkout_request_open_idx"
  ON "main_checkout_request" ("runner_id", "created_at") WHERE "state" <> 'finished';
CREATE INDEX IF NOT EXISTS "main_checkout_request_workspace_idx"
  ON "main_checkout_request" ("workspace_id", "owner_id");
