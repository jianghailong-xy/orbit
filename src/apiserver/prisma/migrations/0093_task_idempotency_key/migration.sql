-- A turn that creates tasks and is then redelivered (its runner lease expired mid-turn, so the
-- inbox hands the same turn back and the engine re-runs it) created those tasks a second time:
-- at-least-once turn delivery meets a non-idempotent write, and the user is left with doubled
-- tasks. TasksService now stamps a create that happens inside a live turn with a hash of
-- (session, turn, title, description); the second run recomputes the SAME hash and collides here
-- instead of inserting a duplicate.
--
-- The column is nullable and the index plain-unique on purpose: Postgres treats NULLs as distinct
-- in a unique index, so every task created outside a turn (the user-facing API, headless bridges)
-- keeps NULL and coexists freely, while two in-turn creates that hash alike cannot both land.
ALTER TABLE "task" ADD COLUMN "idempotency_key" TEXT;

CREATE UNIQUE INDEX "task_idempotency_key_key" ON "task" ("idempotency_key");
