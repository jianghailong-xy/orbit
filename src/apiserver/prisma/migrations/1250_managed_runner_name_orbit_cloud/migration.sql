-- 1250 — the managed runner's stored name is Orbit Cloud, the name every client already shows it by.
--
-- Managed runners were created named `orbit-managed` (MANAGED_RUNNER_NAME), a word the server could still write
-- wherever it names a runner by its stored name. New ones are created named `Orbit Cloud`; this renames the ones
-- already there. Only a runner that is an account's managed runner and still carries the old name: a self-managed
-- runner someone named `orbit-managed` keeps its name, and the owner's own name for it (display_name) is untouched.
-- The name is written only at creation (no heartbeat or registration rewrites a managed runner's), so this holds.
-- Every statement can run twice.

UPDATE "runner" r
   SET "name" = 'Orbit Cloud'
  FROM "managed_runner" m
 WHERE m."runner_id" = r."id"
   AND r."name" = 'orbit-managed';
