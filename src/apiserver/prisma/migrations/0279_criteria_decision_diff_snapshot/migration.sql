-- What the owner was looking at when they answered, kept because it cannot be worked out later.
--
-- An answered proposal's card could show only one side of the change: the words the proposal ASKED
-- for. The words it REPLACED were nowhere — `project_ratified_action_intent.action.baseline.material`
-- seals each criterion as `(definition_id, revision, content_hash)` and carries no text,
-- `project_criteria_authorship` records who wrote a revision and not what it said, and the
-- definition's own `text` is overwritten by the approval itself. The account owner's report,
-- 2026-09-17: after approving, you can no longer see what the change was.
--
-- The before-words exist in exactly one place at exactly one moment: inside the deciding
-- transaction, which reads the definitions in force to compute the seal it compares. So the
-- decision writes the diff it was given — the same `criteriaProposalDiff(proposed, in force)` the
-- pending card was drawn from — in the same INSERT as the answer.
--
-- IT IS A SNAPSHOT AND NOT A DERIVATION, which is the whole reason the column exists: a row here
-- states what the criteria said BEFORE this decision, and after an APPROVE no later read of any
-- table can recover that. A reader must not "refresh" it from the definitions, and nothing may
-- recompute it and write it back.
--
-- NULLABLE, and permanently so. Every decision recorded before this migration has no snapshot and
-- never will; that is not a missing value to backfill but a fact about when it was answered, and
-- the read distinguishes it (`PREDATES_SNAPSHOT`) from a decision that moved nothing. The ADD
-- COLUMN is catalog-only — no default, no rewrite — and no stored row is touched.

ALTER TABLE "project_criteria_decision" ADD COLUMN "diff_snapshot" JSONB;

COMMENT ON COLUMN "project_criteria_decision"."diff_snapshot" IS
  'The proposal read against the criteria in force AT THE MOMENT THIS DECISION WAS WRITTEN, as the '
  'pending card drew it. A snapshot, never a derivation: an APPROVE overwrites the definitions this '
  'was taken from, so no later read can reproduce it. NULL means the decision predates this column.';
