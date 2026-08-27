-- A heuristic may question a completion-criterion choice, but it cannot prove the choice wrong.
-- Persist the creator's explanation when they deliberately keep it; later readers then see the
-- exception's evidence instead of only the resulting enum value.
ALTER TABLE "task"
  ADD COLUMN "completion_criterion_override_reason" TEXT;
