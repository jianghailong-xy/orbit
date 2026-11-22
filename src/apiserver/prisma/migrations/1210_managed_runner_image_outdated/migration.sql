-- What the manager found of a READY managed runner's image (managed-runner-manager.ts recordImageOutdated), kept so the
-- owner's status says, without asking the backend, that the runner runs an older build than the current one: when it
-- first found the instance made from a previous image, and the source commit the current image was built from (its
-- org.opencontainers.image.revision label). Both null while the instance is current or the server cannot tell.
-- Additive: nullable columns with no default, which the running release neither reads nor writes.
ALTER TABLE "managed_runner" ADD COLUMN "image_outdated_since" TIMESTAMPTZ(3);
ALTER TABLE "managed_runner" ADD COLUMN "current_image_sha" TEXT;
