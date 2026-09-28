-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki: a verification has to be able to read its evidence (criterion 7, revision 4, owner
-- 2026-09-27). A verdict given when the verifier could read none of an op's sources is no verdict
-- about the claim, so the server caps it at Unreviewed and keeps it out of the fallback's count; and a
-- verdict the old reader gave that way can be reopened — its op sent back to wait for another one.
-- contracts/wiki.contract.json `reviewModes.verification.evidence` and `.reopen` are the authority
-- for everything below, and src/apiserver/src/wiki/wiki-schema.pg.spec.ts holds these CHECKs to it.
--
-- WHAT CHANGES
-- ------------
--   * wiki_changeset_op.verification_evidence says what the verifier could read when the server
--     recorded the verdict: `readable` (the text of at least one source) or `unreadable` (none). It is
--     part of the verdict's trail, so it is set only beside a verdict; a verdict recorded before this
--     migration has none (NULL: the reader of that time handed a verifier the text of a user or an
--     assistant event and of no other event).
--   * wiki_changeset_op.verification_history keeps the trail of every earlier verdict of an op that
--     was reopened (reviewModes.verification.reopen): a reopened op waits for its verification again,
--     and one still waiting carries no verdict (0312's `wiki_changeset_op_verifying_chk`), so what the
--     earlier verdict said moves here rather than being overwritten. A JSON array, empty for every op
--     never reopened.
--
-- WHAT DOES NOT
-- -------------
-- No row is written, read or locked: `verification_evidence` is nullable with no default, and
-- `verification_history` takes a constant default ('[]'), which PostgreSQL records in the catalog
-- rather than rewriting the table. Every existing op satisfies both new CHECKs as it stands — none
-- has an evidence mark, and every history is the empty array. No function, trigger, type or index is
-- created, replaced or dropped, and nothing outside wiki_changeset_op is named.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0314: the highest number on origin/main and on project/34VR0RwUSIcaoO7ZZqv52 was 0313 when this was
-- written (2026-09-28). Every statement can run twice: the columns are added IF NOT EXISTS, and each
-- CHECK is dropped IF EXISTS before it is added.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "wiki_changeset_op" ADD COLUMN IF NOT EXISTS "verification_evidence" TEXT;
ALTER TABLE "wiki_changeset_op" ADD COLUMN IF NOT EXISTS "verification_history" JSONB NOT NULL DEFAULT '[]'::jsonb;

-- The closed set, and only beside a verdict: the mark says what that verdict could read.
ALTER TABLE "wiki_changeset_op" DROP CONSTRAINT IF EXISTS "wiki_changeset_op_verification_evidence_chk";
ALTER TABLE "wiki_changeset_op" ADD CONSTRAINT "wiki_changeset_op_verification_evidence_chk"
  CHECK ("verification_evidence" IS NULL
     OR ("verification_evidence" IN ('readable', 'unreadable') AND "verification_verdict" IS NOT NULL));

-- Earlier verdicts are a list, never a scalar a reader would have to guess the shape of.
ALTER TABLE "wiki_changeset_op" DROP CONSTRAINT IF EXISTS "wiki_changeset_op_verification_history_chk";
ALTER TABLE "wiki_changeset_op" ADD CONSTRAINT "wiki_changeset_op_verification_history_chk"
  CHECK (jsonb_typeof("verification_history") = 'array');
