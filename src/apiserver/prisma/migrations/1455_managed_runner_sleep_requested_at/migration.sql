-- An owner's sleep of an Orbit Cloud runner (managed-runner.service.ts sleep): when it was asked for. The manager drains
-- only on a report the instance sent after it, so a report from before the request never makes a busy runner drain.
-- Additive: a nullable column with no default, which the running release neither reads nor writes.
ALTER TABLE "managed_runner" ADD COLUMN "sleep_requested_at" TIMESTAMPTZ(3);
