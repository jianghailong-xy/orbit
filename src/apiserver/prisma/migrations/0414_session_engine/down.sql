-- Run BEFORE rolling the apiserver image back past 0414 (docs/provider-engine-contract.md §5.9). Not
-- read by Prisma; re-runnable.
--
-- An image older than 0414 never declares `orbit.claim_reads_session_engine`, and the backfill gave
-- nearly every session a recorded engine, so with this guard in place such an image can claim no
-- session and take over no lease: every runner would sit idle. Dropping it hands claims back to the
-- older image's own rules.
--
-- Everything else stays. The engine columns keep their data (an older Prisma client never reads
-- them), the immutability trigger keeps them honest for a later roll forward, and the three runtime
-- claim guards keep reading the recorded engine, which an older image's capability declarations
-- (orbit.runner_supports_*) satisfy exactly as they satisfy the old predicates. Sessions created on
-- the newer image on a credential its own engine does not natively run (a DeepSeek Harness session on
-- a DeepSeek key, an OpenCode session on a key) are the ones an older image cannot run correctly; it
-- reads them by their slug.

DROP TRIGGER IF EXISTS session_acquisition_engine_guard ON "session";
DROP FUNCTION IF EXISTS guard_session_engine_acquisition();
