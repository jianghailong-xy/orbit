-- Browser-less `claude auth login` relay. The runner drives the CLI under a pty on its own
-- machine; the user approves in their own browser and pastes the authorization code back through
-- the web, so a runner with no terminal access can still be signed in.
--
-- State, not history: one sign-in at a time per runner, because the CLI writes that machine's
-- single credentials file. login_code holds the user's paste only until the next heartbeat hands
-- it to the runner — it is single-use and useless without the PKCE verifier, which never leaves
-- the runner process.
ALTER TABLE "runner" ADD COLUMN "login_status" TEXT;
ALTER TABLE "runner" ADD COLUMN "login_url" TEXT;
ALTER TABLE "runner" ADD COLUMN "login_code" TEXT;
ALTER TABLE "runner" ADD COLUMN "login_message" TEXT;
ALTER TABLE "runner" ADD COLUMN "login_at" TIMESTAMP(3);
