-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki: an amend answers the challenge it names. docs/wiki-challenge-resolution-design.md section
-- 3.3 hard rule 4 and section 9 P1, contracts/wiki.contract.json `reviewModes.challenge` and
-- `ops.amend.keys.answersChallenge` are the authority.
--
-- WHY
-- ---
-- A challenge takes effect at once — its flag takes the entry out of the push — but its ANSWER was only
-- ever the owner's, so an agent's amend could apply through the ordinary review path and still leave the
-- challenge pending, the entry challenged, and the owner pressing a card for a question the code had
-- already answered. An amend may now name the pending challenge of its own entry: when the amend takes
-- effect, that challenge is recorded edited and recomputeFlags clears the flag. An amend that names none
-- closes none, so an unrelated rewrite cannot quietly close a question about the entry's content.
--
-- WHAT IS ADDED, to wiki_changeset_op
-- -----------------------------------
--   answers_challenge   the pending challenge an amend answers. A history reference with NO foreign key,
--                       as verification_duplicate_of has none (0312): part of what the op said, which
--                       outlives the op it names. Set exactly on an amend.
--   answered_by         who closed a challenge: owner, agent or research (research is P2's job; P1 never
--                       writes it). NULL on every row recorded before this migration and on every answer
--                       given in Review, which read as the owner's. Set exactly on a challenge.
-- Two CHECKs hold the closed set and which op may carry each column.
--
-- WHAT DOES NOT CHANGE
-- --------------------
-- No row is written: both columns are nullable with no default, so adding them is catalog-only, and every
-- existing op satisfies both new CHECKs as it stands (both columns are NULL everywhere). No decision value
-- is added: accepted and edited keep their meaning, and answered_by only says who answered. No function,
-- trigger or type is created, replaced or dropped, and nothing outside wiki_changeset_op is named. Code
-- from before this migration neither reads nor writes these columns.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0488: 0487 was the highest number on origin/main when this was written (2026-11-07), and 0486 on this
-- branch. Every statement can run twice: the columns are added IF NOT EXISTS and each CHECK is dropped
-- IF EXISTS before it is added.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "wiki_changeset_op" ADD COLUMN IF NOT EXISTS "answers_challenge" UUID;
ALTER TABLE "wiki_changeset_op" ADD COLUMN IF NOT EXISTS "answered_by" TEXT;

-- Only an amend answers a challenge.
ALTER TABLE "wiki_changeset_op" DROP CONSTRAINT IF EXISTS "wiki_changeset_op_answers_challenge_op_chk";
ALTER TABLE "wiki_changeset_op" ADD CONSTRAINT "wiki_changeset_op_answers_challenge_op_chk"
  CHECK ("answers_challenge" IS NULL OR "op" = 'amend');

-- A closed set over TEXT, never an enum type (the 0259 practice): who answered a challenge.
ALTER TABLE "wiki_changeset_op" DROP CONSTRAINT IF EXISTS "wiki_changeset_op_answered_by_chk";
ALTER TABLE "wiki_changeset_op" ADD CONSTRAINT "wiki_changeset_op_answered_by_chk"
  CHECK ("answered_by" IS NULL OR "answered_by" IN ('owner', 'agent', 'research'));

-- And only a challenge is answered.
ALTER TABLE "wiki_changeset_op" DROP CONSTRAINT IF EXISTS "wiki_changeset_op_answered_by_op_chk";
ALTER TABLE "wiki_changeset_op" ADD CONSTRAINT "wiki_changeset_op_answered_by_op_chk"
  CHECK ("answered_by" IS NULL OR "op" = 'challenge');
