-- Retention scans only the consumed half of the event outbox. The live queue remains governed by
-- project_event_open_dedupe_idx and is intentionally absent from this index and from every prune.
CREATE INDEX "project_event_timer_due_retention_idx"
  ON "project_event"("consumed_at", "id")
  WHERE "kind" = 'timer.due'
    AND "disposition" = 'RECONCILED'
    AND "consumed_at" IS NOT NULL;

-- The service applies a much stricter JSON no-op predicate before deletion. This partial index only
-- narrows the historical ledger to its one eligible reason and supplies the retention time order.
CREATE INDEX "project_decision_inflight_retention_idx"
  ON "project_decision"("created_at", "id")
  WHERE "reason" = 'in-flight session may end';

-- Both the anti-join and the decision FK check need to answer "does this decision have an action?"
-- per candidate. Without the referencing-side index, a bounded decision batch still rescans the
-- whole action ledger once per row.
CREATE INDEX "project_action_decision_id_retention_idx"
  ON "project_action"("decision_id")
  WHERE "decision_id" IS NOT NULL;

-- Acceptance runs are the other durable decision lineage. Preserve them explicitly and make the
-- retention anti-join a one-key lookup instead of a scan of the acceptance ledger.
CREATE INDEX "project_acceptance_run_decision_id_retention_idx"
  ON "project_acceptance_run"("decision_id")
  WHERE "decision_id" IS NOT NULL;
