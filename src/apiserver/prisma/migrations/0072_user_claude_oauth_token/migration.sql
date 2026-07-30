-- A Claude subscription token (`claude setup-token`) held per account and injected as
-- CLAUDE_CODE_OAUTH_TOKEN for that user's built-in-claude sessions on every runner, so an
-- expired local login on one machine no longer has to be fixed machine-by-machine.
--
-- Stored as AES-256-GCM ciphertext ("iv:tag:ct", each base64), same scheme as
-- model_provider.api_key_enc. NULL = not configured (runners use their own local login).
ALTER TABLE "user" ADD COLUMN "claude_oauth_token_enc" TEXT;
ALTER TABLE "user" ADD COLUMN "claude_oauth_token_set_at" TIMESTAMP(3);
