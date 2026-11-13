-- Reverses 0647. Not read by Prisma; re-runnable like the forward script. Only the measured latency goes.
ALTER TABLE "model_provider" DROP COLUMN IF EXISTS "probe_latency_ms";
