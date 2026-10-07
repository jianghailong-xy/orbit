-- 0396 — an administrator can disable an account (docs/google-sign-in-design.md §5.5).
--
-- `user.disabled_at` is when an administrator disabled the account, NULL while it is enabled. A
-- disabled account is refused at every door: the password login, the Google exchange and the
-- refresh answer 403 ACCOUNT_DISABLED, and so do its personal access tokens, runners and service
-- tokens; its access tokens are refused 401. Nothing it owns is deleted, so enabling it again — the
-- column back to NULL — lets it back in.
--
-- 0396: free on main and on every branch of origin (2026-10-07); 0394 and 0395 are held by branches
-- not yet on main (the managed runner, the project rollup index). A nullable column with no default
-- is added to the catalog only: no row is rewritten, and every existing account reads NULL — enabled.

ALTER TABLE "user" ADD COLUMN "disabled_at" TIMESTAMP(3);
