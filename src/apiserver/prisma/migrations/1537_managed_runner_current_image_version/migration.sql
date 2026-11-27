-- Beside current_image_sha: the release the current image was published for (its org.opencontainers.image.version
-- label), which its runner reports as its version, so that the owner's status compares a runner reporting a release
-- version with it (managed-runner-manager.ts recordImageOutdated). Null for an image built from a checkout, and while
-- current_image_sha is null.
-- Additive: a nullable column with no default, which the running release neither reads nor writes.
ALTER TABLE "managed_runner" ADD COLUMN "current_image_version" TEXT;
