-- 0382 — a rate limit that outlasted the gateway's own wait.
--
-- When the upstream answers 429 and the time it asks to be left alone for outlasts what the gateway
-- may hold a request open for (RATE_LIMIT_BUDGET_MS, kept well inside the edge's 100-second limit),
-- the 429 goes back to codex — and codex does not retry a 429 at all: it fails the turn with
-- "exceeded retry limit, last status: 429 Too Many Requests". Nothing recorded that the credential
-- itself was being throttled, so the next claim stayed on it and the failed turn was armed on a
-- blind backoff against the same credential.
--
-- `throttled_until` is that record. It is deliberately NOT `spent_until`: a spent credential is one
-- whose subscription window is used up, and its reset is hours or days away, while this is a
-- momentary rate limit and its window is minutes. A credential under it is one no claim chooses
-- until it passes; the pool's own retry (QueueService.loginPoolRetryAt / sharedPoolKeyRetryAt) then
-- arms at the moment the pool can run again, instead of a fixed ladder.

BEGIN;

ALTER TABLE "pool_codex_login" ADD COLUMN "throttled_until" timestamp(3);
ALTER TABLE "pool_api_key"     ADD COLUMN "throttled_until" timestamp(3);

COMMIT;
