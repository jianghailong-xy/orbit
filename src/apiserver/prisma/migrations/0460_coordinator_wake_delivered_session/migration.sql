-- 0460 — the wakes delivered to a conversation, found by that conversation (projects/coordinator-delivery-card.ts).
--
-- A turn Orbit writes to tell a project's coordinator about a committed fact is drawn as one line rather than as the
-- owner's bubble (`CoordinatorDeliveryCard`), and the line is read off the wake whose `delivery` record names the turn:
-- the event and the `detail` the coordinator was told, and when it was handed them. That read is made where every turn
-- card is read — both views of the queue, which the clients refresh on every change to a conversation, and the event
-- ingest, for every user turn whose key `derivedUuid` made — and it goes from the turn to the wake, by the conversation
-- and the turn's key. No index served it: 0174's are the key and the project, and 0243's unique index on `session_id`
-- is partial on SESSION_OPENED. So DELIVERED wakes are indexed by the conversation they reached, and the read filters
-- that conversation's deliveries by `delivery`'s `clientTurnId`.
--
-- 0460: the next number free on main, on every branch of origin, in every commit of `git log --all` and in every
-- worktree on this host (2026-10-31). Written as 0459, and renumbered before it landed anywhere when another branch's
-- 0459_background_job_wake_stall took that number. One index, created IF NOT EXISTS; no column, CHECK, trigger or row
-- is written.

CREATE INDEX IF NOT EXISTS "project_coordinator_wake_delivered_session_idx"
  ON "project_coordinator_wake" ("session_id")
  WHERE "status" = 'DELIVERED';
