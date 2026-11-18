-- A managed runner left on a previous image by an upgrade is drained once idle and woken at once on the image the
-- profile names (managed-runner-manager.ts rollPreviousImage). Null for every drain to sleep. Additive: a nullable
-- column with no default, which the running release neither reads nor writes.
ALTER TABLE "managed_runner" ADD COLUMN "image_roll_to" TEXT;
