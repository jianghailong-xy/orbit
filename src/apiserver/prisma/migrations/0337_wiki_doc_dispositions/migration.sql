-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, phase 2, criterion 9 (revised 2026-09-28): what became of each piece of a section's
-- material. Before the local model writes a section, it merges the section's material into the state
-- the section describes, and says of every piece whether it was adopted, merged into another, or
-- dropped, and why; the runner adds the pieces it never handed over — over the section's material cap,
-- or filtered by rule (a platform-generated template message, a duplicate). The write carries that
-- ledger with the section (`orbit wiki docs build`), and it is kept beside the section it explains.
-- contracts/wiki.contract.json `docs.dispositions` is the authority for what it holds.
--
-- WHAT IS ADDED
-- -------------
--   wiki_doc_section.dispositions   JSONB, an array of { material, kind, ref, action, into, reason }:
--                                   one per piece of the section's material, as the write sent them.
--                                   A section rewritten is a new row with its own; one written before
--                                   this column existed has none ('[]').
--
-- WHAT DOES NOT CHANGE
-- --------------------
-- One column is added to one table, with a default, so no existing row is rewritten by hand and none
-- is locked beyond the ALTER itself; no other table is named. No function, trigger or type is created,
-- replaced or dropped; no table outside the wiki is named.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0337: origin/main stood at 0336 (0336_session_account_choice) when this was merged (2026-09-30), and no
-- other branch had a 0337. ADD COLUMN IF NOT EXISTS, and the CHECK added only when it is not there, so
-- every statement can run twice.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "wiki_doc_section" ADD COLUMN IF NOT EXISTS "dispositions" JSONB NOT NULL DEFAULT '[]';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiki_doc_section_dispositions_chk') THEN
    ALTER TABLE "wiki_doc_section"
      ADD CONSTRAINT "wiki_doc_section_dispositions_chk" CHECK (jsonb_typeof("dispositions") = 'array');
  END IF;
END
$$;
