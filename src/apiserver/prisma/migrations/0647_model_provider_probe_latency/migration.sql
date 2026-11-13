-- 0647 — how long the bound runner's last probe of a runner-scoped provider took to answer its readiness call
-- (Ollama's GET /api/version), in milliseconds (docs/ollama-local-provider-contract.md §6). Written by the runner's
-- heartbeat beside probe_state/probe_version/probed_at (0646); NULL until a probe got an answer, and cleared with
-- them when the row moves to another runner or endpoint. One nullable column on model_provider; no row is written.
-- down.sql reverses it. Every statement can run twice.

ALTER TABLE "model_provider" ADD COLUMN IF NOT EXISTS "probe_latency_ms" INTEGER;
