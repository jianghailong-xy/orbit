-- Account role gating the admin-only user-management area. Everyone defaults to
-- MEMBER; the earliest-registered account is seeded as ADMIN so the deployment always
-- has exactly one operator to start, with no manual SQL.
ALTER TABLE "user" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'MEMBER';
UPDATE "user" SET "role" = 'ADMIN'
 WHERE "id" = (SELECT "id" FROM "user" ORDER BY "created_at" ASC LIMIT 1);
