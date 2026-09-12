-- 0259 — the four relations the Watch domain contract freezes, and nothing else.
--
-- Authority: `contracts/watch.contract.json` (frozen by P0) and `docs/watch-contract.md`. Every
-- closed set below — the seven watch states, the three target states, the four delivery states,
-- the two modes, the two actions, the delivery budget — is transcribed from that file, and a CHECK
-- is what holds a column to it. Where this migration and the contract disagree, the contract is
-- right and this file is a bug.
--
-- BACKWARD COMPATIBLE BY CONSTRUCTION
-- ==================================
-- Four CREATE TABLEs and their indexes. There is no `ALTER TABLE`, no backfill, no trigger, no
-- function and no enum type anywhere in this file, so no existing row is read or written and no
-- existing relation changes shape. A deployment that applies this migration and then rolls the
-- CODE back keeps working: nothing outside these four tables can tell they exist.
--
-- Atomic and re-runnable, for the reason 0231/0251 give: this batch of objects has no meaning in
-- halves. A `watch` without `watch_match`'s unique key is a watch whose one-shot guarantee is a
-- hope, and a `watch_match` without `watch_delivery` is a fact with nowhere to record whether
-- anybody was told. So the file carries its own BEGIN/COMMIT, and every statement is
-- `IF NOT EXISTS` so an interrupted apply can simply be re-run.
--
-- WHY NO TRIGGERS, NO FUNCTIONS, NO ENUM TYPES
-- ============================================
-- Deliberate, and worth stating because the repo has plenty of all three. An enum type would make
-- adding a state an `ALTER TYPE` in a later migration; a CHECK against a literal list is edited by
-- the same DDL that is already being written, and `pg_get_constraintdef` prints the whole closed
-- set to anybody asking what the column may hold. Triggers are avoided because every invariant
-- here is a statement about ONE row and is therefore expressible as a CHECK — and because a
-- trigger would be the first on these tables and would cost five separate census suites their
-- current answer. Nothing below needs to observe another row to decide.
--
-- WHAT THIS DOES NOT BUILD
-- ========================
-- No generic project event table, no outbox, no `watch_event`, no queue of hints. That table
-- already existed once (`project_event`, 0116) and 0164 dropped it precisely because eleven
-- triggers wrote into it and nothing read it. Contract §8 puts the liveness somewhere that cannot
-- rot the same way: `watch.next_evaluate_at` plus a leased reconciliation sweep. Real-time hints
-- only ever move an evaluation earlier, so dropping every one of them changes latency and no
-- conclusion — which is exactly why there is nothing here to drop them FROM.
--
-- THE THREE PLACES A DUPLICATE IS MADE IMPOSSIBLE RATHER THAN UNLIKELY
-- ===================================================================
--   * `watch_match_watch_generation_key` — UNIQUE (watch_id, generation). Contract §5: a one-shot
--     watch that crosses its condition a second time cannot write a second Match. The evaluator
--     races itself on restart, on a duplicated hint and on two workers; this is the constraint
--     that makes all three the same harmless event.
--   * `watch_one_shot_generation_chk` — a ONE_SHOT watch may never advance past generation 1. The
--     unique key above stops the second ROW; this stops the second generation that would have
--     made the second row legal.
--   * `watch_delivery_match_action_key` — UNIQUE (match_id, action). One match causes one delivery
--     per action, so a redelivered or replayed match adopts the delivery already recorded instead
--     of enqueuing a second wake. This is the database half of the `clientTurnId` idempotency
--     contract §6 reuses on `conversation_turn`; that unique key stops the second TURN, this one
--     stops the second attempt to enqueue one.
--
-- THE THREE QUERIES THAT GET AN INDEX, AND WHY THOSE THREE
-- =======================================================
--   * BY TARGET — `watch_target_resource_idx` on (target_kind, target_resource_id). "This session
--     just changed; who was watching it." The hint path's only read.
--   * BY OWNER/OBSERVER — `watch_owner_state_idx` on (owner_id, state) and
--     `watch_observer_session_idx` on the observer session. "What am I watching", and "what is
--     this session parked on".
--   * BY DUE EVALUATION — `watch_due_idx` on (next_evaluate_at), PARTIAL on it being non-null. The
--     sweep's only read, and the partiality is what keeps it small: a terminal watch is never
--     scheduled again, which `watch_terminal_not_scheduled_chk` turns from a convention into a
--     fact, so terminal rows leave the index instead of accumulating in it.
--
-- TTL rides that same due index rather than getting one of its own:
-- `watch_next_evaluate_within_ttl_chk` holds `next_evaluate_at <= expires_at`, so a watch is
-- always scheduled to be looked at no later than the moment it expires. Contract §5 requires that
-- expiry itself be delivered — a session waiting on a watch that quietly expired waits forever —
-- and this is what makes the sweep that delivers it reach every expiring row without a second
-- index and a second query to keep in step with the first.
--
-- `updated_at` carries a database default, unlike most of this schema. Prisma's `@updatedAt` is
-- client-side only, so a NOT NULL column without one makes every raw-SQL INSERT — fixtures and
-- migrations included — fail on a column the writer never mentioned.

BEGIN;

-- ── watch ────────────────────────────────────────────────────────────────────────────────────
-- Who is watching, what condition, what to do when it holds, and until when.
CREATE TABLE IF NOT EXISTS "watch" (
  "id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,

  -- The observer. `USER` is a person watching from a client; `SESSION` is an agent that will be
  -- resumed. No FK to `user` for the session case and no second column for the user case: the
  -- owner IS the user, and contract §1's observer is either that owner or one of their sessions.
  "observer_type" text NOT NULL,
  "observer_session_id" uuid,

  -- The typed predicate (contract §2), stored whole. It is a closed grammar validated at the
  -- door, not free text: an object, never a string, so a log line or a shell fragment cannot be
  -- smuggled in as a predicate.
  "predicate" jsonb NOT NULL,
  "predicate_version" integer NOT NULL DEFAULT 1,

  "mode" text NOT NULL DEFAULT 'ONE_SHOT',
  "action" text NOT NULL,
  "state" text NOT NULL DEFAULT 'ACTIVE',

  -- Advanced by one per match. A one-shot watch stops at 1 (see the CHECK); a continuous one keeps
  -- counting, and the count is what makes each crossing a distinguishable, deduplicable fact.
  "generation" integer NOT NULL DEFAULT 0,

  -- TTL is mandatory. Contract §5: a watch nobody can see expiring is the failure mode being
  -- designed out, so there is no "forever" to store.
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  -- Liveness. NULL means "nothing is scheduled", which for a terminal watch is the only legal
  -- value and for a live one means it is being evaluated right now.
  "next_evaluate_at" TIMESTAMPTZ(6),
  "last_evaluated_at" TIMESTAMPTZ(6),

  -- Creation idempotency: a retried create resolves to the watch already made rather than a second
  -- one watching the same thing.
  "idempotency_key" text,

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "watch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "watch_owner_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  -- The observer session going away takes its watches with it: an observation nobody can be told
  -- about is not an observation.
  CONSTRAINT "watch_observer_session_fkey" FOREIGN KEY ("observer_session_id")
    REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "watch_observer_type_chk" CHECK ("observer_type" IN ('USER', 'SESSION')),
  -- The two halves of the observer agree, in both directions. A `SESSION` row with no session is
  -- an observer nobody can resume; a `USER` row carrying one is a session that would be woken by a
  -- watch its owner believes is only a notification.
  CONSTRAINT "watch_observer_shape_chk"
    CHECK (("observer_type" = 'SESSION') = ("observer_session_id" IS NOT NULL)),
  -- Contract §6: RESUME_SESSION's whole effect is a turn on the observer session, so an action
  -- that has nowhere to put one is refused by the column, not by a code path somebody may forget.
  CONSTRAINT "watch_resume_needs_session_chk"
    CHECK ("action" <> 'RESUME_SESSION' OR "observer_session_id" IS NOT NULL),
  -- Contract §7: a RESUME_SESSION watch may not name its own observer among its targets. The
  -- unbounded wake loop that rule exists for closes through `watch_target`, so the whole rule
  -- cannot live here; what CAN live here is stated in `watch_target_no_self_watch_chk` below.

  CONSTRAINT "watch_mode_chk" CHECK ("mode" IN ('ONE_SHOT', 'CONTINUOUS')),
  CONSTRAINT "watch_action_chk" CHECK ("action" IN ('NOTIFY_USER', 'RESUME_SESSION')),
  CONSTRAINT "watch_state_chk" CHECK ("state" IN
    ('ACTIVE', 'PAUSED', 'MATCHED', 'EXPIRED', 'CANCELLED', 'REVOKED', 'UNRESOLVABLE')),
  CONSTRAINT "watch_predicate_version_chk" CHECK ("predicate_version" >= 1),
  -- A predicate is a term in a closed grammar. `jsonb_typeof` refusing anything but an object is
  -- what keeps contract §2's "no shell, no SQL, no log regex, no free-text expression" from being
  -- a sentence in a document that a JSON string would quietly contradict.
  CONSTRAINT "watch_predicate_object_chk" CHECK (jsonb_typeof("predicate") = 'object'),

  CONSTRAINT "watch_generation_chk" CHECK ("generation" >= 0),
  -- Contract §5: one-shot settles at MATCHED. Generation 2 on a one-shot watch is the state from
  -- which a second Match would be legal, so it is the state that is refused.
  CONSTRAINT "watch_one_shot_generation_chk"
    CHECK ("mode" <> 'ONE_SHOT' OR "generation" <= 1),
  -- A terminal watch is never scheduled again. This is also what keeps `watch_due_idx` small.
  CONSTRAINT "watch_terminal_not_scheduled_chk" CHECK (
    "state" NOT IN ('MATCHED', 'EXPIRED', 'CANCELLED', 'REVOKED', 'UNRESOLVABLE')
    OR "next_evaluate_at" IS NULL),
  -- Expiry is reached by the same sweep that reaches evaluation, so it needs no index of its own.
  CONSTRAINT "watch_next_evaluate_within_ttl_chk"
    CHECK ("next_evaluate_at" IS NULL OR "next_evaluate_at" <= "expires_at")
);

-- "What is this account watching", the owner read.
CREATE INDEX IF NOT EXISTS "watch_owner_state_idx" ON "watch"("owner_id", "state");
-- "What is this session parked on", the observer read. Partial: most watches are a person's.
CREATE INDEX IF NOT EXISTS "watch_observer_session_idx"
  ON "watch"("observer_session_id") WHERE "observer_session_id" IS NOT NULL;
-- The sweep's read: watches whose evaluation has come due. Partial, so terminal watches are not in
-- it at all rather than filtered out of it on every pass.
CREATE INDEX IF NOT EXISTS "watch_due_idx"
  ON "watch"("next_evaluate_at") WHERE "next_evaluate_at" IS NOT NULL;
-- Creation idempotency, scoped to the account. Partial, because most watches carry no key and
-- NULLs are not equal to each other — an unpartitioned unique index would say the same thing but
-- carry a row for every watch ever made.
CREATE UNIQUE INDEX IF NOT EXISTS "watch_owner_idempotency_key"
  ON "watch"("owner_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;

-- ── watch_target ─────────────────────────────────────────────────────────────────────────────
-- One row per target in the set, frozen at create (contract §4).
CREATE TABLE IF NOT EXISTS "watch_target" (
  "id" uuid NOT NULL,
  "watch_id" uuid NOT NULL,

  -- The ResourceRef. Only SESSION and TASK are watchable; TASK_LIST and PROJECT appear below as a
  -- snapshot SOURCE, which is a different thing and is why they are a different pair of columns.
  "target_kind" text NOT NULL,
  -- Deliberately NO foreign key. Contract §4: a deleted target becomes GONE and leaves the set, it
  -- does not delete the observation — "every target is gone" is how a watch reaches UNRESOLVABLE,
  -- and a cascade here would erase the evidence for that conclusion on the way to it. The same
  -- reasoning `session.source_codebase_id` is unreferenced for.
  "target_resource_id" uuid NOT NULL,

  "state" text NOT NULL DEFAULT 'OBSERVED',
  -- The lifecycle epoch observed when the snapshot was taken. Contract §4: a Task reopened after a
  -- Match advances its epoch, and the Match is not rewritten — it was a true statement about the
  -- epoch it saw. Storing the epoch is what lets a reader tell those two worlds apart later.
  "target_epoch" integer NOT NULL DEFAULT 0,

  -- Where this target came from, when it was expanded out of a list or a project rather than named
  -- directly. Recorded once; the watch has no live relationship with that source afterwards.
  "snapshot_source_kind" text,
  "snapshot_source_id" uuid,

  "last_evaluated_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "watch_target_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "watch_target_watch_fkey" FOREIGN KEY ("watch_id") REFERENCES "watch"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  -- A target appears once per watch. Without this, one target named twice makes `ALL` and `ANY`
  -- count it twice and a debounced continuous watch fire twice for one crossing.
  CONSTRAINT "watch_target_watch_resource_key" UNIQUE ("watch_id", "target_kind", "target_resource_id"),

  CONSTRAINT "watch_target_kind_chk" CHECK ("target_kind" IN ('SESSION', 'TASK')),
  CONSTRAINT "watch_target_state_chk" CHECK ("state" IN ('OBSERVED', 'SATISFIED', 'GONE')),
  CONSTRAINT "watch_target_epoch_chk" CHECK ("target_epoch" >= 0),
  CONSTRAINT "watch_target_snapshot_source_kind_chk"
    CHECK ("snapshot_source_kind" IS NULL OR "snapshot_source_kind" IN ('TASK_LIST', 'PROJECT')),
  -- Both halves of the provenance or neither. A kind with no id names nothing; an id with no kind
  -- cannot be resolved, because the two kinds live in different tables.
  CONSTRAINT "watch_target_snapshot_source_shape_chk"
    CHECK (("snapshot_source_kind" IS NULL) = ("snapshot_source_id" IS NULL))
);

-- The hint path's read: "this row changed — who was watching it". Leading with `target_kind` keeps
-- a session id and a task id that happen to collide from ever being one another's answer.
CREATE INDEX IF NOT EXISTS "watch_target_resource_idx"
  ON "watch_target"("target_kind", "target_resource_id");

-- ── watch_match ──────────────────────────────────────────────────────────────────────────────
-- The condition held, once, at a moment. Immutable: a fact about the world, not a notification.
CREATE TABLE IF NOT EXISTS "watch_match" (
  "id" uuid NOT NULL,
  "watch_id" uuid NOT NULL,
  "generation" integer NOT NULL,
  "matched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Why it held, in the contract's vocabulary. Never a log line and never shell output.
  "reason" text NOT NULL,
  -- Which grammar decided it. A Match read years later must be interpretable under the rules that
  -- produced it, not under whatever the current build believes a predicate means.
  "predicate_version" integer NOT NULL,
  -- The structured trigger snapshot: per-target state as it was when the condition held, which is
  -- what contract §6 hands to a resumed session as `changedTargets` / `latestSnapshot`.
  "per_target_snapshot" jsonb NOT NULL,

  CONSTRAINT "watch_match_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "watch_match_watch_fkey" FOREIGN KEY ("watch_id") REFERENCES "watch"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  -- Contract §5, vector `one-shot-second-crossing-produces-no-second-match`. The whole point of
  -- the word "impossible" in that vector.
  CONSTRAINT "watch_match_watch_generation_key" UNIQUE ("watch_id", "generation"),

  -- Creation evaluates once, and a condition already true then is generation 1. There is no
  -- generation 0 Match, because generation 0 is "never matched".
  CONSTRAINT "watch_match_generation_chk" CHECK ("generation" >= 1),
  CONSTRAINT "watch_match_predicate_version_chk" CHECK ("predicate_version" >= 1),
  -- Structured, not prose. Contract §6's "polling logs or shell transcript text must never be put
  -- into the payload" is a rule about this column, so this column refuses a bare JSON string.
  CONSTRAINT "watch_match_snapshot_object_chk"
    CHECK (jsonb_typeof("per_target_snapshot") = 'object')
);

-- ── watch_delivery ───────────────────────────────────────────────────────────────────────────
-- What was DONE about a Match, and whether it worked. Retryable, leased, and dead-letterable.
CREATE TABLE IF NOT EXISTS "watch_delivery" (
  "id" uuid NOT NULL,
  "match_id" uuid NOT NULL,
  "action" text NOT NULL,
  "state" text NOT NULL DEFAULT 'PENDING',
  "attempts" integer NOT NULL DEFAULT 0,

  -- The fence a worker holds while it is doing the thing. Both halves, because a stale process
  -- releasing late must be able to expire only its OWN generation — the same shape
  -- `conversation_turn` uses for the runner engine's delivery lease.
  "lease_owner" uuid,
  "lease_generation" uuid,
  "lease_deadline_at" TIMESTAMPTZ(6),

  -- When to try again. The retry/backoff clock, and the claim query's only predicate.
  "next_attempt_at" TIMESTAMPTZ(6),
  "last_error" text,
  "delivered_at" TIMESTAMPTZ(6),
  "dead_lettered_at" TIMESTAMPTZ(6),

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "watch_delivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "watch_delivery_match_fkey" FOREIGN KEY ("match_id") REFERENCES "watch_match"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  -- One delivery per match per action. A redelivered match adopts this row instead of enqueuing a
  -- second wake; v1 allows one action per watch, so in practice this is one delivery per match.
  CONSTRAINT "watch_delivery_match_action_key" UNIQUE ("match_id", "action"),

  CONSTRAINT "watch_delivery_action_chk" CHECK ("action" IN ('NOTIFY_USER', 'RESUME_SESSION')),
  CONSTRAINT "watch_delivery_state_chk"
    CHECK ("state" IN ('PENDING', 'IN_FLIGHT', 'DELIVERED', 'DEAD_LETTER')),
  -- `maxDeliveryAttempts` = 8 in the contract's limits. Past it the row is a dead letter, so a
  -- ninth attempt is not a thing that can be recorded.
  CONSTRAINT "watch_delivery_attempts_chk" CHECK ("attempts" >= 0 AND "attempts" <= 8),
  -- IN_FLIGHT and "held under a lease with a deadline" are the same statement. Either direction
  -- being possible on its own is what produces a delivery no worker owns and nothing reclaims.
  CONSTRAINT "watch_delivery_lease_shape_chk" CHECK (
    ("state" = 'IN_FLIGHT')
    = ("lease_owner" IS NOT NULL AND "lease_generation" IS NOT NULL
       AND "lease_deadline_at" IS NOT NULL)),
  -- Each terminal state and its timestamp imply each other, in both directions.
  CONSTRAINT "watch_delivery_delivered_shape_chk"
    CHECK (("state" = 'DELIVERED') = ("delivered_at" IS NOT NULL)),
  CONSTRAINT "watch_delivery_dead_letter_shape_chk"
    CHECK (("state" = 'DEAD_LETTER') = ("dead_lettered_at" IS NOT NULL))
);

-- The delivery worker's claim: what is pending and due. Partial on PENDING, so rows already in
-- flight, delivered or dead-lettered are not in the index the worker scans.
CREATE INDEX IF NOT EXISTS "watch_delivery_due_idx"
  ON "watch_delivery"("next_attempt_at") WHERE "state" = 'PENDING';

COMMIT;
