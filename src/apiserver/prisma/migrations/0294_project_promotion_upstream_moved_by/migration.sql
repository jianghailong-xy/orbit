-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- `project_promotion.upstream_moved_by`: how far the upstream had moved when a confirmed
-- promotion's landing job found it had (contract §3.3 M-T7, read back as §3.6's `recheck`).
--
-- WHY THIS IS STORED AND NOT DERIVED. The fact is "main moved N commits between the tip the owner's
-- check passed against and the tip the merge was redone on". Both tips are already on the row
-- (`upstream_sha_checked`) and on the job (`upstream_sha`), but the count between them is a question
-- about a repository, and the control plane has no repository: only the runner has one. So the
-- runner counts it (`git rev-list --count from..to`, `src/runner-go/integrate.go`) and reports it on
-- the progress call that moves the promotion to RECHECKING; this column is where that report lands.
--
-- NULLABLE, and permanently so. Every promotion re-checked before this migration has no count and
-- never will — the commits are not kept anywhere and a later read cannot recover them — and that is
-- not a value to backfill but a fact about when it happened. The read distinguishes it: the card
-- says "main moved since the check" and stops, rather than printing a zero it made up. The runner
-- also omits the count when git cannot answer, which arrives here as the same NULL.
--
-- ADD COLUMN only: no default, no NOT NULL, so the ALTER is catalog-only and no stored row is
-- rewritten. The card's other state-B number, `typicalMs`, is NOT stored: it is the median of this
-- project's recent `CHECK_PROMOTION` durations, read from `project_integration_job` at read time,
-- which is the row the durations are already in.

ALTER TABLE "project_promotion" ADD COLUMN "upstream_moved_by" INTEGER;

COMMENT ON COLUMN "project_promotion"."upstream_moved_by" IS
  'How many commits the upstream moved between the tip the last passing check ran against and the '
  'tip the merge was redone on, as the runner counted them when it reported the move (M-T7). NULL '
  'means nobody counted: the promotion predates this column, or the runner could not read the '
  'commits. Never zero — a move of zero commits is not a move.';
