-- An owner's Update Now of an Orbit Cloud runner (managed-runner.service.ts updateNow): when it was asked for and by
-- whom, kept as the record of the last request, and when the manager found the next generation READY on the current
-- image, which ends it. Additive: nullable columns with no default, which the running release neither reads nor writes.
ALTER TABLE "managed_runner" ADD COLUMN "update_requested_at" TIMESTAMPTZ(3);
ALTER TABLE "managed_runner" ADD COLUMN "update_requested_by" TEXT;
ALTER TABLE "managed_runner" ADD COLUMN "update_completed_at" TIMESTAMPTZ(3);
