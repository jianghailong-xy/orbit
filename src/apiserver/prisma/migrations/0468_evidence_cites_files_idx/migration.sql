-- Which versions of evidence cite a file: what a receipt goes by to offer an older version's files (`citesFiles` on `decided`,
-- tasks/pending-evidence-judgments.ts). The pending read asks it of every decision a conversation has recorded, on every
-- poll, so the answer must not open the envelopes. Measured on production on 2026-11-03 (1581 versions, an envelope 3.4 KB on
-- average and 52 KB at most, none citing a file), the same question without this index took 50 ms over 47 versions and 153 ms
-- over 113, where the planner chose a sequential scan, beside 0.36 ms for the decisions themselves. With it the answer comes
-- from this index alone, which holds only the versions that cite a file.
--
-- The predicate is the query's own text, so the planner proves it and rechecks nothing. `attachment.evidence_id` could not
-- answer this: it names only the newest version citing a row, and an older version is the point.
--
-- A plain build, because Prisma runs a migration in a transaction: a SHARE lock on `task_completion_evidence` for as long as
-- the build takes, which holds back evidence being submitted and no read. It reads every envelope once; this table is small.
-- A much larger deployment may pre-create the identical index CONCURRENTLY, after which IF NOT EXISTS makes this a no-op.
--
-- 0468: the next number free on main and on every ref of this repository (2026-11-03; main and every project line end at 0467).
CREATE INDEX IF NOT EXISTS "task_completion_evidence_cites_files_idx"
  ON "task_completion_evidence" ("id")
  WHERE "evidence" @> '{"checks":[{"kind":"FILE"}]}'::jsonb;
