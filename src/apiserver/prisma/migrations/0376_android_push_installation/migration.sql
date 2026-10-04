-- Existing APNs rows retain their token uniqueness, owner FK and NULL installation identity.
-- PostgreSQL permits multiple NULLs in this index; Android registration requires an install UUID.
ALTER TABLE "device_token" ADD COLUMN "installation_id" TEXT;
CREATE UNIQUE INDEX "device_token_installation_key"
ON "device_token" ("platform", "bundle_id", "environment", "installation_id");
