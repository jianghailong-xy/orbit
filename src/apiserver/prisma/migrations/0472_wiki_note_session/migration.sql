-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki: a note can say which session wrote it. docs/wiki-memory-claims-design.md section 4: a session's
-- `wiki_note` is stored as a note, and the maintenance run reads the session's notes back as claims to check
-- against that session's records. contracts/wiki.contract.json `agentSurface.note` is the authority.
--
-- WHAT CHANGES
-- ------------
-- `wiki_note.session_id`, a nullable UUID, and an index to read a session's notes by. It names a session with no
-- foreign key on purpose, as a source's ref does: the note outlives what it names, and a session's owner is
-- already held by the note's own (space_id, owner_id) key, which every read goes through.
--
-- WHAT DOES NOT
-- -------------
-- No row is written, and every note imported before this migration keeps NULL: `orbit wiki import` still registers
-- with none, and such a note is no session's claim. Adding a nullable column with no default rewrites nothing. The
-- code before this migration neither reads nor writes the column, so a deployment still running it is unaffected:
-- its INSERT leaves the column NULL, as it should.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0472 follows 0471. Prisma applies it once; nothing here is written to run twice.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "wiki_note" ADD COLUMN "session_id" UUID;

CREATE INDEX "wiki_note_session_id_idx" ON "wiki_note" ("session_id");
