-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki: an entry's claim is rechecked when main changes its code. docs/wiki-claim-recheck-design.md, task
-- 34snwipJZpZ7fBMfDPhqH: an anchor check says an entry's files are still there, never that what it says still holds,
-- so a pitfall whose fix landed kept reaching agents as verified. contracts/wiki.contract.json `claimStates` and
-- `maintenance.job.server.recheck` are the authority.
--
-- WHAT CHANGES
-- ------------
-- On `wiki_entry`:
--   claim_state        what the last ask found (`claimStates`), `unchecked` for every entry until it is first asked
--   claim_checked_ref  the commit the last ask was made at; claim_checked_at when
--   claim_check        what that ask wrote (WikiClaimCheck: verdict, the commit it named, reason, both answers)
--   claim_screened_at  when the screen first looked at the entry; NULL until then, which is what makes the first
--                      screen look back to the entry's earliest source
--   claim_due_rank     the due queue: the lowest rank the screen has given the entry since it was last asked (0-3),
--   claim_due_at       and when it first became due; both or neither
-- On `wiki_space`, claim_recheck_ref: the commit the space's last recheck screened to.
-- `wiki_repo_op_kind_chk` admits `history`, the runner operation the screen and the asks read git through.
--
-- WHAT DOES NOT
-- -------------
-- No row is rewritten. The text column carries a constant default, which PostgreSQL 11 and later store in the
-- catalog; every other column is nullable with no default. The CHECKs read values every existing row holds
-- (`unchecked`, NULL). The code before this migration neither reads nor writes these columns, so a deployment still
-- running it is unaffected, and a runner that does not know `history` fails that operation alone.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0481: 0479 and 0480 are taken on unlanded branches (wiki chat, managed runner volumes). Prisma applies it once;
-- nothing here is written to run twice.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "wiki_entry"
  ADD COLUMN "claim_state" TEXT NOT NULL DEFAULT 'unchecked',
  ADD COLUMN "claim_checked_ref" TEXT,
  ADD COLUMN "claim_checked_at" TIMESTAMPTZ(3),
  ADD COLUMN "claim_check" JSONB,
  ADD COLUMN "claim_screened_at" TIMESTAMPTZ(3),
  ADD COLUMN "claim_due_rank" SMALLINT,
  ADD COLUMN "claim_due_at" TIMESTAMPTZ(3),
  ADD CONSTRAINT "wiki_entry_claim_state_chk" CHECK ("claim_state" IN ('unchecked', 'holds', 'fixed', 'obsolete', 'unsure')),
  ADD CONSTRAINT "wiki_entry_claim_checked_ref_chk" CHECK ("claim_checked_ref" IS NULL OR "claim_checked_ref" ~ '^[0-9a-f]{40}$'),
  ADD CONSTRAINT "wiki_entry_claim_check_chk" CHECK ("claim_check" IS NULL OR jsonb_typeof("claim_check") = 'object'),
  ADD CONSTRAINT "wiki_entry_claim_due_chk" CHECK (
    ("claim_due_rank" IS NULL) = ("claim_due_at" IS NULL)
    AND ("claim_due_rank" IS NULL OR "claim_due_rank" BETWEEN 0 AND 3)
  );

-- The step reads the queue of one space by rank and age.
CREATE INDEX "wiki_entry_claim_due_idx" ON "wiki_entry" ("space_id", "claim_due_rank", "claim_due_at")
  WHERE "claim_due_at" IS NOT NULL;

ALTER TABLE "wiki_space"
  ADD COLUMN "claim_recheck_ref" CHAR(40),
  ADD CONSTRAINT "wiki_space_claim_recheck_ref_chk" CHECK ("claim_recheck_ref" IS NULL OR "claim_recheck_ref" ~ '^[0-9a-f]{40}$');

ALTER TABLE "wiki_repo_op" DROP CONSTRAINT "wiki_repo_op_kind_chk";
ALTER TABLE "wiki_repo_op"
  ADD CONSTRAINT "wiki_repo_op_kind_chk" CHECK ("kind" IN ('snapshot', 'read', 'diff', 'anchors', 'history'));
