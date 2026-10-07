-- 0392 — an account may have no password (docs/google-sign-in-design.md §5.1, §5.4).
--
-- `user.password_hash` NULL is an account that signs in with Google only: one opened by a Google
-- sign-in under the OPEN sign-up policy (§5.2 row 5), or one an administrator created with
-- `passwordless` (§5.4). The password login answers such an account exactly as it answers a wrong
-- password, and an administrator's password reset gives it one.
--
-- The email's unique index is left as it is, on the address as written: a self-hosted database may
-- hold addresses that differ only in letter case, which a unique index on lower(email) would make
-- this migration fail on. A Google sign-in matches lower(email) and refuses more than one match
-- (GOOGLE_EMAIL_AMBIGUOUS) instead.
--
-- 0392: the next number free on main and on every branch of origin (2026-10-07). DROP NOT NULL on
-- a column that is already nullable does nothing, so this runs twice. No row is written, and no
-- existing password is touched.

ALTER TABLE "user" ALTER COLUMN "password_hash" DROP NOT NULL;
