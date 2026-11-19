ALTER TABLE "workspace" ADD COLUMN "model_routing_optimize_for" TEXT NOT NULL DEFAULT 'cost';
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_model_routing_optimize_for_check"
  CHECK ("model_routing_optimize_for" IN ('cost', 'balance', 'intelligence'));
