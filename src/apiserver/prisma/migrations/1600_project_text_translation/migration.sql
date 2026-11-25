-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1600: a project's title and acceptance criteria are translated for the owner (project 'Translate project criteria
-- and title for the owner', criterion 1; decision 1A). The owner-started "Is this project done?" card, the project
-- page's Done when list and the why-not-done card draw them, and until now always in the agent's language. Wire
-- shape: @orbit/shared translation.ts (ProjectTextTranslation). Server flow: src/apiserver/src/sessions/card-translation.ts,
-- queued by ProjectsService.queueProjectTextTranslation and served by GET /projects/:id.
--
-- WHAT IT ADDS
-- ------------
-- project_text_translation   one row per project, keyed by its id: { lang, failed?, sourceDigest, title?,
--                            criteria?: [{ id, text }] }. sourceDigest is the sha256 of the title and each criterion's
--                            id and text the translation was made from, so any edit of either leaves the row stale:
--                            it is not served, and the next read queues a new one.
-- The project's own columns and its criteria rows stay exactly what the agent wrote; the translation is a reader's copy
-- kept beside them, and no row means translation was not involved. Nothing is backfilled: a project is translated the
-- first time it is read with translation on (decision 1A).
--
-- WHY A TABLE AND NOT A COLUMN ON project
-- ---------------------------------------
-- project is the hottest row an owner has: its triggers and its guards fire on every write of it, and its document is
-- read on every page view. A background translation written into it would contend with the coordinator's writes and
-- announce itself through every trigger that watches the row. A table of its own is written by one upsert by key and
-- cascades away with the project.
--
-- GUARDS
-- ------
-- None: no trigger reads or writes the new table, and nothing in it decides any state.
--
-- LOCKS
-- -----
-- CREATE TABLE takes a SHARE ROW EXCLUSIVE lock on project for the foreign key only, asked for 2 s at a time, 1 s apart,
-- up to 60 tries, in one DO statement, as 1070 and 1080 ask for theirs. No INSERT, UPDATE or DELETE.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1600: main stands at 1592 and every origin/project/* and pushed origin/orbit/* branch at or below 1592
-- (scanned 2026-11-25). Can run twice: CREATE TABLE IF NOT EXISTS.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      CREATE TABLE IF NOT EXISTS "project_text_translation" (
        "project_id"  UUID           NOT NULL,
        "owner_id"    UUID           NOT NULL,
        "translation" JSONB          NOT NULL,
        "updated_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "project_text_translation_pkey" PRIMARY KEY ("project_id"),
        CONSTRAINT "project_text_translation_project_fkey" FOREIGN KEY ("project_id")
          REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE
      );
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF tries >= 60 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
