-- Public read-only share link for a session. `share_token` is an unguessable token embedded
-- in a public URL (/s/<token>) that lets anyone with the link view the session's transcript
-- read-only, with no login. NULL = not shared (the default). Revoking sets it back to NULL so
-- the old link 404s; re-sharing mints a fresh token. `shared_at` records when the current link
-- was minted (shown in the share dialog). The token only exposes the transcript via the public
-- SharedController — never ownership, billing, or runner internals.
ALTER TABLE "session" ADD COLUMN "share_token" TEXT;
ALTER TABLE "session" ADD COLUMN "shared_at" TIMESTAMP(3);
CREATE UNIQUE INDEX "session_share_token_key" ON "session"("share_token");
