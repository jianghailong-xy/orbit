-- The sign-in relay now drives codex as well as claude, and the two flows differ in kind:
-- `claude auth login` prints a URL and waits for the code that page gives the user, while
-- `codex login --device-auth` prints a URL *and* a one-time code to enter there, then polls for
-- the approval itself. So the row has to say which CLI is being signed in, and carry a code that
-- travels runner → user (login_user_code) as well as the existing user → runner one (login_code).
--
-- Both NULL on existing rows: a relay in flight during the deploy is claude's, which is what a
-- NULL login_engine reads as.
ALTER TABLE "runner" ADD COLUMN "login_engine" TEXT;
ALTER TABLE "runner" ADD COLUMN "login_user_code" TEXT;
