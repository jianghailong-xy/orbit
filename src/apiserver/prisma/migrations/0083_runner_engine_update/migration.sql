BEGIN;

-- Which job the engine relay's one slot is running: 'install' (one named CLI) or 'update' (every
-- CLI already on the machine). One slot for both, because both drive a package manager against
-- that machine's single global prefix and must never overlap.
--
-- NULL on every existing row, including any relay in flight during this migration: those are all
-- installs, and both the API and the runner read a missing mode as 'install'.
ALTER TABLE "runner" ADD COLUMN "install_mode" TEXT;

COMMIT;
