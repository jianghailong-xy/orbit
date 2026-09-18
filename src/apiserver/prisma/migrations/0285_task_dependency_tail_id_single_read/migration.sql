-- `task_dependency_tail_id` reads the head row once instead of twice, and says so to the planner.
--
-- The function resolves a prerequisite through its supersession chain, and every project-scoped
-- read calls it once per EDGE: the panorama's work scan, the ready-to-run gate, the page's inbound
-- tally, and the dispatch gate itself. On the 109,872-task project in this deployment that is
-- 110,866 calls in one statement, and it was the single most expensive thing in all of them —
-- 15.0 s and 854,518 buffer hits where the same rows reached by a plain join cost 0.77 s and
-- 9,002.
--
-- Two things made it cost that, and neither is the chain walk:
--
--   1. The head row was read TWICE. `SELECT owner_id INTO root_owner` read the row at p_task_id,
--      and then the loop's first iteration — whose cursor_id IS p_task_id — read the same row
--      again for its other three columns. 44 of this deployment's 111,752 tasks are superseded, so
--      99.96% of calls are exactly one iteration long and paid double for it. The owner is now
--      taken from the loop's own read on the iteration that already has the row in hand, which is
--      the iteration the old first read was duplicating.
--
--   2. It was PARALLEL UNSAFE, which is the default and was never a statement about this function.
--      It only SELECTs from `task`: no write, no sequence, no temp table, no transaction state. The
--      label is what forbade a parallel plan for EVERY query that calls it, however parallelisable
--      the rest of that query was.
--
-- Measured against a copy of this deployment's real 111,752 tasks and 110,866 dependencies,
-- alternating the two definitions to control for host load: 10.1-11.0 s and 879,999 buffer hits
-- become 2.8-3.5 s and 441,634. The halving of the buffer count is the structural half and is
-- identical across runs; the wall clock is the machine's.
--
-- SEMANTICS ARE UNCHANGED, and that is checked rather than argued: over every one of the 111,752
-- task ids, every one of the 110,866 edge heads, and 200 ids belonging to no task, the old and new
-- definitions returned the same value for every input — including all 44 ids whose chain actually
-- walks. The reordering below is why they must: the old first read only ever established
-- `root_owner` and the NOT FOUND exit, the loop's first iteration reads the same row under the
-- same snapshot, and the `current_owner <> root_owner` test it fed was vacuous on that first pass
-- because both sides came from one row.
CREATE OR REPLACE FUNCTION task_dependency_tail_id(p_task_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE cursor_id uuid := p_task_id; next_id uuid; root_owner uuid; current_owner uuid;
        current_status text; current_reason text;
        seen uuid[] := ARRAY[]::uuid[]; depth integer := 0;
BEGIN
  LOOP
    IF cursor_id = ANY(seen) OR depth > 256 THEN RETURN NULL; END IF;
    seen := array_append(seen, cursor_id);
    SELECT t."owner_id", t."superseded_by_task_id", t."status"::text, t."terminal_reason"
      INTO current_owner, next_id, current_status, current_reason
      FROM "task" t WHERE t."id" = cursor_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    -- depth 0 is the head, and the row it just read is the one the old separate SELECT read. From
    -- there on the owner is compared, not adopted: a chain that leaves its owner is not a chain.
    IF depth = 0 THEN root_owner := current_owner;
    ELSIF current_owner <> root_owner THEN RETURN NULL;
    END IF;
    IF next_id IS NULL THEN
      -- ON DELETE SET NULL preserves SUPERSEDED as honest history; it does not leave a tail whose
      -- status can satisfy new work. That broken chain is deliberately unresolved.
      IF current_reason = 'SUPERSEDED' THEN RETURN NULL; END IF;
      RETURN cursor_id;
    END IF;
    IF current_status NOT IN ('FAILED', 'CANCELLED') OR current_reason IS DISTINCT FROM 'SUPERSEDED'
      THEN RETURN NULL;
    END IF;
    cursor_id := next_id;
    depth := depth + 1;
  END LOOP;
END;
$$;
