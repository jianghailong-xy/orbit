-- Gemini providers move onto the Antigravity CLI. Until now a Gemini key borrowed the Codex runtime
-- against Google's OpenAI-compatible endpoint, which serves no Responses API — the only dialect
-- Codex speaks — so no session on such a row could run. agy speaks the Gemini API natively (it reads
-- the key and the endpoint from GEMINI_API_KEY and GOOGLE_GEMINI_BASE_URL), so these rows now
-- dispatch as `antigravity` against the API's own host.
BEGIN;

-- Every row created from this preset points at the shipped compatibility URL (with or without a
-- trailing slash); agy appends /v1beta/models/… itself, so what it is given is the bare host. A base
-- URL that matches neither was typed by hand: the runtime still flips, and its owner can correct the
-- endpoint from the provider form rather than have a guess written over their choice.
UPDATE "model_provider"
SET "runtime" = 'antigravity',
    "base_url" = regexp_replace("base_url", '/v1beta/openai/?$', '')
WHERE "preset_slug" = 'gemini';

-- A session on one of these rows may carry the thread id Codex minted before its first request
-- failed. agy resumes by id, and one it never issued makes it open a new conversation in silence
-- (docs/antigravity-runtime-contract.md §4.3); clearing it makes the next spawn start that fresh
-- conversation on purpose. Turns already recorded stay in Orbit's own transcript.
UPDATE "session"
SET "runtime_session_id" = NULL
WHERE "runtime_session_id" IS NOT NULL
  AND "provider" IN (SELECT "slug" FROM "model_provider" WHERE "preset_slug" = 'gemini');

-- 0367's claim guard keeps PENDING -> RUNNING on an Antigravity session behind the capability the
-- claim sets only for a runner that advertises the runtime. A session on one of these rows is an
-- Antigravity session under a slug of its own — the runner is handed an `antigravity` job all the
-- same — and an older control plane, which reads the row's runtime as Claude, would dispatch it as
-- Claude. So the guard now also asks what the slug runs on, as dispatch does: an enabled row of the
-- session's owner, or a shared one, whose runtime is `antigravity` (a disabled row dispatches as
-- Claude and stays ungated). The transition, the silent skip and 0367's invariant are unchanged:
-- PENDING -> RUNNING on such a session is legal only from QueueService.trySessionClaim, whose own
-- predicate asks the same question.
CREATE OR REPLACE FUNCTION guard_antigravity_runner_claim()
RETURNS trigger AS $$
BEGIN
    IF OLD."status" = 'PENDING'
       AND NEW."status" = 'RUNNING'
       AND COALESCE(current_setting('orbit.runner_supports_antigravity', true), '0') <> '1'
       AND (
           NEW."provider" = 'antigravity'
           OR EXISTS (
               SELECT 1 FROM "model_provider" mp
               WHERE mp."slug" = NEW."provider"
                 AND mp."runtime" = 'antigravity'
                 AND mp."enabled"
                 AND (mp."owner_id" IS NULL OR mp."owner_id" = NEW."owner_id")
           )
       ) THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
