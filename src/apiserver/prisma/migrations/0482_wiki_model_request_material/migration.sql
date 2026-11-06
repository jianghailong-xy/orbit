-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, server execution: a model call keeps the case file it was made from, so that a replay of its job asks
-- what the earlier attempt asked. contracts/wiki.contract.json `modelQueue.material` and
-- `maintenance.job.server.replay` are the authority, docs/wiki-contract.md §25.3 the prose.
--
-- WHY (2026-11-06)
-- ----------------
-- With the production host's CPU saturated, two maintain runs of the orbit space lost their lease and were replayed.
-- Each replay read a session that was still going on again, built its case file from the records it had by then, and
-- asked the question an earlier attempt had asked under the same unit with another prompt; the queue refused it
-- ("already exists with a different call") and both runs failed. The question a unit was first asked is the row's own;
-- what the replay was missing is the case file that question was made from, which it needs to read the answer.
--
-- WHAT CHANGES
-- ------------
-- `wiki_model_request.material`, a nullable JSONB column, with a CHECK that it is an object when it is set. The
-- maintain job writes it with the first question of each session, of its extraction and of the pass over the
-- agent's notes: the dossier, or the notes and their file. Every other call keeps NULL.
--
-- WHAT DOES NOT
-- -------------
-- No row is written, and every request made before this migration keeps NULL: a replay of a job that one of them
-- belongs to asks as it did before. Adding a nullable column with no default rewrites nothing, and the CHECK has no
-- value to read in a table where the column is NULL everywhere. The code before this migration neither reads nor
-- writes the column, so a deployment still running it is unaffected.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0482 follows 0481, the highest number on main, the project branches and the pushed task branches on 2026-11-06.
-- Prisma applies it once; nothing here is written to run twice.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "wiki_model_request"
  ADD COLUMN "material" JSONB,
  ADD CONSTRAINT "wiki_model_request_material_chk" CHECK ("material" IS NULL OR jsonb_typeof("material") = 'object');
