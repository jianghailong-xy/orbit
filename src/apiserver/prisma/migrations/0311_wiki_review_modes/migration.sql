-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki review modes (criterion 7 of the wiki's phase 2): a space's `settings.reviewMode` —
-- manual, tiered or automatic — decides which of what the effect policy holds back applies at once.
-- contracts/wiki.contract.json `reviewModes` is the authority for everything below, and
-- src/apiserver/src/wiki/wiki-schema.pg.spec.ts holds these CHECKs to it.
--
-- WHAT CHANGES
-- ------------
--   * wiki_entry.trust admits two more values. `auto` is what a review mode leaves an entry it
--     applied at once and that is pushed; `unreviewed` is what Tiered leaves one without the
--     owner's words or a machine verification behind it — shown, never pushed. Both are trusts of an
--     ACTIVE entry, so `wiki_entry_trust_status_chk` (trust is 'proposed' exactly when the status is
--     proposed or rejected) holds them as it stands and is not touched.
--   * wiki_changeset_op.applied_by_mode names the mode that applied an op at once (tiered or
--     automatic), NULL when the effect policy decided it. Only an add or an amend is ever applied by
--     a mode: a supersede and a retire end a lineage nothing could bring back, so they wait in every
--     mode (reviewModes.effect).
--   * wiki_changeset_op.spot_check marks the op a mode applied that was drawn into Review for the
--     owner to check after the fact. Only an op a mode applied can be one.
--
-- WHAT DOES NOT
-- -------------
-- The mode itself is a key of wiki_space.settings, which 0307 already made a JSON object: no column.
-- A space whose settings name no mode reads as manual — every space that exists when this runs — so
-- no stored row is rewritten, and none of the owner's spaces changes behaviour until the client can
-- show the setting and the owner chooses another (a new space is created tiered). No row is
-- written, read or locked here: both new columns take a constant default (NULL, false), which is
-- catalog-only, and every existing op satisfies both new CHECKs as it is.
--
-- No function, trigger, type or index is created, replaced or dropped, and nothing outside the two
-- wiki tables is named.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0311: the highest number on origin/main and on every branch of origin and every local branch was
-- 0310 when this was written (2026-09-27). Every statement can run twice: the trust CHECK is dropped
-- IF EXISTS and added again, the columns are added IF NOT EXISTS, and each new CHECK is dropped IF
-- EXISTS before it is added.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "wiki_entry" DROP CONSTRAINT IF EXISTS "wiki_entry_trust_chk";
ALTER TABLE "wiki_entry" ADD CONSTRAINT "wiki_entry_trust_chk"
  CHECK ("trust" IN ('owner', 'confirmed', 'auto', 'unreviewed', 'proposed', 'external'));

ALTER TABLE "wiki_changeset_op" ADD COLUMN IF NOT EXISTS "applied_by_mode" TEXT;
ALTER TABLE "wiki_changeset_op" ADD COLUMN IF NOT EXISTS "spot_check" BOOLEAN NOT NULL DEFAULT false;

-- The closed set, and the ops it may name, as two constraints: the set is what the schema spec holds
-- to the contract's modes, value for value.
ALTER TABLE "wiki_changeset_op" DROP CONSTRAINT IF EXISTS "wiki_changeset_op_applied_by_mode_chk";
ALTER TABLE "wiki_changeset_op" ADD CONSTRAINT "wiki_changeset_op_applied_by_mode_chk"
  CHECK ("applied_by_mode" IS NULL OR "applied_by_mode" IN ('tiered', 'automatic'));
ALTER TABLE "wiki_changeset_op" DROP CONSTRAINT IF EXISTS "wiki_changeset_op_applied_by_mode_op_chk";
ALTER TABLE "wiki_changeset_op" ADD CONSTRAINT "wiki_changeset_op_applied_by_mode_op_chk"
  CHECK ("applied_by_mode" IS NULL OR "op" IN ('add', 'amend'));

ALTER TABLE "wiki_changeset_op" DROP CONSTRAINT IF EXISTS "wiki_changeset_op_spot_check_chk";
ALTER TABLE "wiki_changeset_op" ADD CONSTRAINT "wiki_changeset_op_spot_check_chk"
  CHECK (NOT "spot_check" OR "applied_by_mode" IS NOT NULL);
