-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki: an op remembers the agent's note it came from. docs/wiki-memory-claims-design.md section 3.3:
-- a maintenance run's pass over an agent's notes records, on each op it proposes, the tool_use event that wrote
-- the note and the memory file's name. contracts/wiki.contract.json `opRules.promptedBy` is the authority.
--
-- WHAT CHANGES
-- ------------
-- `wiki_changeset_op.prompted_by`, a nullable JSONB column, with a CHECK that it is an object when it is set. It
-- names a run_event with no foreign key on purpose, as verification_duplicate_of names an entry: the trail
-- outlives what it names.
--
-- WHAT DOES NOT
-- -------------
-- No row is written, and every op recorded before this migration keeps NULL: nothing about its evidence or its
-- trust changes. Adding a nullable column with no default rewrites nothing, and the CHECK has no value to read in
-- a table where the column is NULL everywhere. The code before this migration neither reads nor writes the column,
-- so a deployment still running it is unaffected.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0471 follows 0470. Prisma applies it once; nothing here is written to run twice.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "wiki_changeset_op"
  ADD COLUMN "prompted_by" JSONB,
  ADD CONSTRAINT "wiki_changeset_op_prompted_by_chk" CHECK ("prompted_by" IS NULL OR jsonb_typeof("prompted_by") = 'object');
