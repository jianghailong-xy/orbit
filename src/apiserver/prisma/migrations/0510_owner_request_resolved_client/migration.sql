-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 0510: owner_request.resolved_client — which client the owner ended a request from
-- (project 34uP1vOyTgWZRZimQ0NU2, task "apiserver: record which client ended an owner request").
--
-- The kind from the X-Orbit-Client header of the owner's done or decline call: web, ios, macos or android. NULL
-- for anything else, for a withdrawn or expired request, and for every request ended before this migration.
--
-- One nullable column, no default: no row is rewritten. No function, trigger or type. Can run twice.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "owner_request" ADD COLUMN IF NOT EXISTS "resolved_client" TEXT;
