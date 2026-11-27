-- 1720: the decision-card push ledger (task 354adqnR5U6CZFIfyR5df, "Push the owner when a decision card becomes
-- theirs").
--
--   owner_card_push   one row per (owner, card key): a decision card the account owner was pushed about once it became
--       theirs (PushService.notifyDecisionCards, push/owner-cards.ts). Several of those cards become the owner's with no
--       write at all — an evidence revision when its dispatching session's 30 minutes run out or that session ends, an
--       owner confirmation whose review timed out, a project that looks finished past its window — so the sweep that
--       notices them needs a record of what it already pushed, or a second pass and a restart would push again. The key
--       names the card and the version of it (`evidence:<evidence id>`, `standard-set:<project>:<digest>`, …): one
--       push per key, ever. A row is claimed before the push is sent (INSERT … ON CONFLICT DO NOTHING); a push that then
--       fails is not retried, the way every other alert here is best-effort.
--
-- One new table, history rather than foreign keys (like project_orphan_notice): no existing row is read or rewritten,
-- and no trigger is added or changed. Every statement can run twice.
--
-- NUMBERING: main stands at 1671 and every origin/* branch and local worktree at or below 1711 (scanned 2026-11-27).
CREATE TABLE IF NOT EXISTS "owner_card_push" (
  "id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "card_key" text NOT NULL,
  "kind" text NOT NULL,
  "session_id" uuid,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "owner_card_push_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "owner_card_push_kind_chk" CHECK ("kind" IN (
    'EVIDENCE', 'OWNER_CONFIRMATION', 'CRITERIA_DECISION', 'STANDARD_SET', 'DONE_REQUEST', 'RECORD_AS_DONE'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS "owner_card_push_owner_key"
  ON "owner_card_push" ("owner_id", "card_key");
