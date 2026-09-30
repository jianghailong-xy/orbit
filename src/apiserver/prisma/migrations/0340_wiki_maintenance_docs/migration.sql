-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, phase 2, criterion 3 (revision 3) and criterion 11: the documents follow what changed.
-- When the owner confirms a plan version, the server asks for a build of its documents — a plan job of
-- kind `build`, run as a task of the space's hidden «Wiki maintenance» list like a draft is (0338). And
-- a maintenance run rewrites only the sections its facts touched: the entries it wrote, and the design
-- documents, code and contracts a section cites that changed on origin/main — a sentence citing a file
-- that was deleted or renamed there is withdrawn as its anchor gone missing. contracts/wiki.contract.json
-- `plan.jobs` and `docs.withdrawal` are the authority for everything below, and
-- src/apiserver/src/wiki/wiki-maintenance.pg.spec.ts holds these CHECKs to it.
--
-- WHAT IS ADDED
-- -------------
--   wiki_plan_job.progress         a build's progress while it runs: the documents written of how many,
--                                  and the one being written (what the plan page shows). A build's alone.
--   wiki_plan_job build version    a build names the confirmed version it writes, from the moment it is
--                                  asked for: its `version` is never null.
--   one waiting build a space      at most one build of a space is queued or held (a partial unique
--                                  index): a second confirmation finds it and points it at the newer
--                                  version. A build already made (its task exists) does not stand in the
--                                  way — it writes the version it was made for, and the waiting one the
--                                  next.
--   wiki_doc_sentence.withdrawn_path
--                                  the repository file whose deletion or rename withdrew a sentence, in
--                                  place of the entry an entry's withdrawal names: a sentence withdrawn
--                                  names one of the two, never both, and a path only as anchor_missing.
--   wiki_doc_footnote repo index   what a path's disappearance withdraws: the repository footnotes of an
--                                  owner by their path.
--
-- WHAT DOES NOT CHANGE
-- --------------------
-- No existing row is written or rewritten: the new columns start NULL on every row, which every new or
-- restated CHECK admits (no build job and no withdrawn sentence exists before this ships, and a stored
-- withdrawal names its entry, which the restated CHECK still takes). The two CHECKs restated are dropped
-- and added back in the same file, widened and nothing else. No closed set of the contract changes: the
-- withdraw reasons, the job kinds, states and triggers are the ones 0326 and 0338 stored. No function,
-- trigger or type is created, replaced or dropped; no table outside the wiki is named.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0340: origin/main stood at 0336, the project branch at 0338, and 0339 was another branch's (the plan
-- draft's idempotency key, since landed on both) — the first free number after the highest. Every statement can run twice:
-- ADD COLUMN / CREATE INDEX IF NOT EXISTS, and each CHECK dropped IF EXISTS before it is added.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "wiki_plan_job" ADD COLUMN IF NOT EXISTS "progress" JSONB;

ALTER TABLE "wiki_plan_job" DROP CONSTRAINT IF EXISTS "wiki_plan_job_progress_chk";
ALTER TABLE "wiki_plan_job" ADD CONSTRAINT "wiki_plan_job_progress_chk"
  CHECK ("progress" IS NULL OR ("kind" = 'build' AND jsonb_typeof("progress") = 'object'));

-- A build names the confirmed version it writes, whatever state it is in.
ALTER TABLE "wiki_plan_job" DROP CONSTRAINT IF EXISTS "wiki_plan_job_build_version_chk";
ALTER TABLE "wiki_plan_job" ADD CONSTRAINT "wiki_plan_job_build_version_chk"
  CHECK ("kind" <> 'build' OR "version" IS NOT NULL);

-- At most one build of a space waits (queued or held).
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_plan_job_space_id_waiting_build_key" ON "wiki_plan_job" ("space_id")
  WHERE "kind" = 'build' AND "state" IN ('queued', 'held');

ALTER TABLE "wiki_doc_sentence" ADD COLUMN IF NOT EXISTS "withdrawn_path" TEXT;

-- A withdrawn sentence says when, why, and what withdrew it — the entry it came through, or the
-- repository file it cited, one of the two — and no other sentence says any of it.
ALTER TABLE "wiki_doc_sentence" DROP CONSTRAINT IF EXISTS "wiki_doc_sentence_withdrawn_chk";
ALTER TABLE "wiki_doc_sentence" ADD CONSTRAINT "wiki_doc_sentence_withdrawn_chk" CHECK (
  ("status" = 'withdrawn') = ("withdrawn_at" IS NOT NULL)
  AND ("withdrawn_at" IS NULL) = ("withdrawn_reason" IS NULL)
  AND ("withdrawn_at" IS NULL) = ("withdrawn_entry_id" IS NULL AND "withdrawn_path" IS NULL)
  AND ("withdrawn_entry_id" IS NULL OR "withdrawn_path" IS NULL));

-- A path withdraws a sentence only as its anchor gone missing.
ALTER TABLE "wiki_doc_sentence" DROP CONSTRAINT IF EXISTS "wiki_doc_sentence_withdrawn_path_chk";
ALTER TABLE "wiki_doc_sentence" ADD CONSTRAINT "wiki_doc_sentence_withdrawn_path_chk" CHECK (
  "withdrawn_path" IS NULL
  OR ("withdrawn_reason" = 'anchor_missing' AND btrim("withdrawn_path") <> '' AND char_length("withdrawn_path") <= 1000));

-- What a repository path's deletion or rename withdraws: the footnotes that cite it.
CREATE INDEX IF NOT EXISTS "wiki_doc_footnote_repo_ref_idx" ON "wiki_doc_footnote" ("owner_id", "ref")
  WHERE "kind" IN ('design_doc', 'code', 'contract');
