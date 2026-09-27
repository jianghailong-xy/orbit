-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki: Automatic verifies before it applies (criterion 7, revision 3, owner 2026-09-27). An
-- op an automatic space takes waits for a verdict — supported, partial, unsupported or duplicate —
-- that a separate call to the local model gives against the op's own sources, and the verdict is
-- kept on the op. contracts/wiki.contract.json `reviewModes.verification` is the authority for
-- everything below, and src/apiserver/src/wiki/wiki-schema.pg.spec.ts holds these CHECKs to it.
--
-- WHAT CHANGES
-- ------------
--   * wiki_changeset_op.decision admits `verifying`: the op waits for its verdict — not applied, not
--     pushed, not a Review card. `wiki_changeset_op_decided_chk` read "decided_at is set exactly when
--     the decision is not pending"; a verifying op has not been decided either, so it now reads
--     "neither pending nor verifying". Both are dropped and added again, widened by that one value.
--   * Five columns carry the verdict's trail: verification_verdict (the closed set), the verifier's
--     reason, the model that gave it, verified_at (when the server recorded it), and
--     verification_duplicate_of (the entry a duplicate named). The first four are set together or not
--     at all; the last exactly when the verdict is duplicate. Only an add or an amend ever waits for a
--     verdict or carries one, and a verifying op carries none yet.
--   * verification_duplicate_of has NO foreign key, deliberately (contract `storage.verificationTrail`):
--     it is part of what the verifier said, which outlives the entry it named the way a history
--     reference outlives its record. The op's other entry keys cascade (delete means forget), and a
--     cascade from this one would delete the trail with the op; SET NULL would rewrite it.
--   * One partial index, over the ops that wait for a verdict: the verification list reads exactly
--     those, by owner and in id order (uuid(7), so oldest first), and every other op is outside it.
--
-- WHAT DOES NOT
-- -------------
-- No row is written, read or locked: the five columns are nullable with no default (catalog-only),
-- and every existing op satisfies every new and widened CHECK as it stands — none is verifying, none
-- has a verdict. The partial index is built over an empty set. No function, trigger or type is
-- created, replaced or dropped, and nothing outside wiki_changeset_op is named.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0312: the highest number on origin/main and on every recent branch of origin was 0311 when this was
-- written (2026-09-27). Every statement can run twice: each CHECK is dropped IF EXISTS before it is
-- added, the columns are added IF NOT EXISTS, and the index is created IF NOT EXISTS.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "wiki_changeset_op" DROP CONSTRAINT IF EXISTS "wiki_changeset_op_decision_chk";
ALTER TABLE "wiki_changeset_op" ADD CONSTRAINT "wiki_changeset_op_decision_chk" CHECK ("decision" IN
  ('pending', 'accepted', 'edited', 'rejected', 'auto_applied', 'conflict', 'expired', 'withdrawn', 'verifying'));
ALTER TABLE "wiki_changeset_op" DROP CONSTRAINT IF EXISTS "wiki_changeset_op_decided_chk";
ALTER TABLE "wiki_changeset_op" ADD CONSTRAINT "wiki_changeset_op_decided_chk"
  CHECK (("decision" IN ('pending', 'verifying')) = ("decided_at" IS NULL));

ALTER TABLE "wiki_changeset_op" ADD COLUMN IF NOT EXISTS "verification_verdict" TEXT;
ALTER TABLE "wiki_changeset_op" ADD COLUMN IF NOT EXISTS "verification_reason" TEXT;
ALTER TABLE "wiki_changeset_op" ADD COLUMN IF NOT EXISTS "verification_model" TEXT;
ALTER TABLE "wiki_changeset_op" ADD COLUMN IF NOT EXISTS "verified_at" TIMESTAMPTZ(3);
ALTER TABLE "wiki_changeset_op" ADD COLUMN IF NOT EXISTS "verification_duplicate_of" UUID;

-- The closed set, on its own: the constraint the schema spec holds to the contract's verdicts.
ALTER TABLE "wiki_changeset_op" DROP CONSTRAINT IF EXISTS "wiki_changeset_op_verification_verdict_chk";
ALTER TABLE "wiki_changeset_op" ADD CONSTRAINT "wiki_changeset_op_verification_verdict_chk"
  CHECK ("verification_verdict" IS NULL OR "verification_verdict" IN ('supported', 'partial', 'unsupported', 'duplicate'));

-- The trail is whole or absent: a verdict, the reason for it, the model that gave it and when.
ALTER TABLE "wiki_changeset_op" DROP CONSTRAINT IF EXISTS "wiki_changeset_op_verification_trail_chk";
ALTER TABLE "wiki_changeset_op" ADD CONSTRAINT "wiki_changeset_op_verification_trail_chk"
  CHECK (("verification_verdict" IS NULL) = ("verification_reason" IS NULL)
     AND ("verification_verdict" IS NULL) = ("verification_model" IS NULL)
     AND ("verification_verdict" IS NULL) = ("verified_at" IS NULL)
     AND ("verification_reason" IS NULL OR (btrim("verification_reason") <> '' AND char_length("verification_reason") <= 500))
     AND ("verification_model" IS NULL OR (btrim("verification_model") <> '' AND char_length("verification_model") <= 200)));

-- A duplicate names what it duplicates, and nothing else names anything. IS NOT DISTINCT FROM, because
-- with no verdict at all `verdict = 'duplicate'` is NULL and a CHECK lets NULL through.
ALTER TABLE "wiki_changeset_op" DROP CONSTRAINT IF EXISTS "wiki_changeset_op_verification_duplicate_chk";
ALTER TABLE "wiki_changeset_op" ADD CONSTRAINT "wiki_changeset_op_verification_duplicate_chk"
  CHECK (("verification_verdict" IS NOT DISTINCT FROM 'duplicate') = ("verification_duplicate_of" IS NOT NULL));

-- Only an add or an amend waits for a verdict or carries one, and one still waiting carries none.
ALTER TABLE "wiki_changeset_op" DROP CONSTRAINT IF EXISTS "wiki_changeset_op_verification_op_chk";
ALTER TABLE "wiki_changeset_op" ADD CONSTRAINT "wiki_changeset_op_verification_op_chk"
  CHECK (("decision" <> 'verifying' AND "verification_verdict" IS NULL) OR "op" IN ('add', 'amend'));
ALTER TABLE "wiki_changeset_op" DROP CONSTRAINT IF EXISTS "wiki_changeset_op_verifying_chk";
ALTER TABLE "wiki_changeset_op" ADD CONSTRAINT "wiki_changeset_op_verifying_chk"
  CHECK ("decision" <> 'verifying' OR "verification_verdict" IS NULL);

-- The verification list: an owner's ops that wait for a verdict, oldest first.
CREATE INDEX IF NOT EXISTS "wiki_changeset_op_verifying_idx"
  ON "wiki_changeset_op" ("owner_id", "id") WHERE "decision" = 'verifying';
