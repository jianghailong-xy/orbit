-- The conversation a task list is steered from.
--
-- A list accumulated real policy over the last few migrations — standing instructions, a pause,
-- a concurrency cap, a foreman, verification — and every one of them is reachable only through
-- an HTTP PATCH or an agent that already knows the list's id. There was nowhere to *go* to say
-- "pause this" or "here is what changed about how these should be run". This column is that
-- entry point: one durable conversation per list, resolved or created on demand.
--
-- A pointer, never a dependency. Nothing on the dispatch path reads it — the auto-run sweep, the
-- claim gate and the foreman behave identically whether it is set, stale or null. That is the
-- whole point of storing an id here rather than making the console a participant: a session that
-- could stall a campaign by dying is the resident supervisor P3 was written to avoid, and this
-- deployment has the cautionary case on file (one session created 43 lists and ~21,500 tasks,
-- then sat FAILED for a fortnight while the work carried on around it).
--
-- ON DELETE SET NULL follows from that: deleting the conversation loses the entry point and
-- nothing else, and the next request simply opens a new one.
ALTER TABLE "task_list" ADD COLUMN "owner_session_id" UUID;

ALTER TABLE "task_list" ADD CONSTRAINT "task_list_owner_session_id_fkey"
    FOREIGN KEY ("owner_session_id") REFERENCES "session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Deliberately NOT versioned into task_list_revision. The revision table records dispatch policy
-- — decisions about how the list runs, which someone might want to restore. Which conversation
-- it is steered from is not one of those: restoring an old revision must not silently re-point
-- the console at a session the user has since replaced.
