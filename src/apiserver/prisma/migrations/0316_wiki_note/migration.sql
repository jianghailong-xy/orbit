-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki: the `note` source gets its rows (criterion 1, design §8.3). `orbit wiki import` turns
-- each Markdown file it reads — a CLAUDE.md, an AGENTS.md, one file of an agent's memory library —
-- into ONE note, and the entries it proposes from that file cite the note. Until now `note` was a
-- source kind the contract listed and nothing could resolve. contracts/wiki.contract.json `import`
-- is the authority for everything below, and src/apiserver/src/wiki/wiki-import.pg.spec.ts holds it.
--
-- WHAT IS STORED
-- --------------
-- The file's text AFTER the shared redactor (src/apiserver/src/common/secret-redaction.ts, with the
-- owner's workspace.env values as literals), the sha256 of that redacted text, the path it was read
-- from (redacted the same way), and whether redaction changed anything. Never the text as it was
-- read: hard constraint 4 keeps the redacted text and its hash and nothing else, and the importing
-- runner hands its model the stored text, so what a quote is checked against is what the model read.
--
-- ONE NOTE PER CONTENT: UNIQUE (space_id, content_sha256). The same file imported again — or the same
-- text under another name, as an AGENTS.md that repeats its CLAUDE.md — is the note already there,
-- and no second row is ever made for it.
--
-- TENANCY
-- -------
-- As every wiki table but wiki_space (0307's header): owner_id NOT NULL, and the parent reached
-- through (space_id, owner_id) -> wiki_space(id, owner_id) ON DELETE CASCADE ON UPDATE CASCADE, so a
-- note can never belong to another owner than its space, deleting a space deletes its notes, and no
-- key here names "user" (the rank-10 lock 0307 keeps wiki writes away from). A note is resolved as a
-- source only among its owner's own notes, like every other source kind.
--
-- A wiki_source row that cites a note keeps its id in `ref` with no foreign key (0307's history
-- references), as it keeps a turn's or a task's.
--
-- WHAT DOES NOT CHANGE
-- --------------------
-- One new table and its unique index. No existing table, column, constraint, function, trigger or type
-- is created, altered, replaced or dropped; no INSERT, UPDATE or DELETE. wiki_source.kind already
-- admits 'note' (0307).
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0316: origin/main stood at 0313, and 0314 (wiki_verification_evidence) and 0315 (wiki_cursor) were
-- taken by the project's other branches, when this was written (2026-09-28). Every statement can run
-- twice: CREATE TABLE and CREATE INDEX IF NOT EXISTS, with the constraints inside the CREATE TABLE.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "wiki_note" (
  "id"             UUID NOT NULL,
  "space_id"       UUID NOT NULL,
  "owner_id"       UUID NOT NULL,
  "path"           TEXT NOT NULL,
  "text"           TEXT NOT NULL,
  "content_sha256" CHAR(64) NOT NULL,
  "redacted"       BOOLEAN NOT NULL DEFAULT false,
  "created_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wiki_note_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_note_space_fkey"
    FOREIGN KEY ("space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- import.rules.notePathMaxChars and import.rules.noteMaxChars.
  CONSTRAINT "wiki_note_path_chk" CHECK (btrim("path") <> '' AND char_length("path") <= 500),
  CONSTRAINT "wiki_note_text_chk" CHECK (btrim("text") <> '' AND char_length("text") <= 100000),
  CONSTRAINT "wiki_note_content_sha256_chk" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_note_space_id_content_sha256_key"
  ON "wiki_note" ("space_id", "content_sha256");
