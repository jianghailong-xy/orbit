-- 1574 — a rewrite card written without a press (contracts/wiki.contract.json `chat.drafts.auto`, `chat.rules.chatAutoSectionsPerDay`;
-- docs/wiki-contract.md §28.5; docs/wiki-chat-design.md §7.2 option A, owner 11-22).
--
--   wiki_chat_draft.auto_queued_at  when the server queued a rewrite card's sections with no press: in the drafting call's
--                                   transaction, or in the Apply or Discard of the card it waited on. decision stays NULL:
--                                   the owner pressed nothing. The card reads `rewritten`.
--   wiki_chat_draft.held            why a rewrite card inside option A's other bounds was left for a press, as found when it
--                                   was drafted: web (its chat read web content), budget (the space's automatic sections for
--                                   the UTC day were used up — not something a later read could work out again) or draft
--                                   (another open card of the chat rewrites one of its sections; it is written once that card
--                                   is decided).
--   wiki_chat_draft.held_by_id      for held draft, the card it waits on. A history reference with no foreign key, as
--                                   replaces_id is.
--
-- The undone, seen and told checks of 0483 required a press; a card written without one is undone, seen and told too, so
-- each also takes auto_queued_at. Additive otherwise: three nullable columns with no default, which the running release
-- neither reads nor writes, and checks every existing row passes (none has the new columns set). wiki_chat_draft is a small
-- table written by presses alone, so its lock is taken plainly.
ALTER TABLE "wiki_chat_draft" ADD COLUMN IF NOT EXISTS "auto_queued_at" TIMESTAMPTZ(3);
ALTER TABLE "wiki_chat_draft" ADD COLUMN IF NOT EXISTS "held" TEXT;
ALTER TABLE "wiki_chat_draft" ADD COLUMN IF NOT EXISTS "held_by_id" UUID;

ALTER TABLE "wiki_chat_draft" DROP CONSTRAINT IF EXISTS "wiki_chat_draft_held_chk";
ALTER TABLE "wiki_chat_draft" ADD CONSTRAINT "wiki_chat_draft_held_chk" CHECK (
  ("held" IS NULL OR ("kind" = 'rewrite' AND "held" IN ('web', 'budget', 'draft')))
  AND (("held" = 'draft') = ("held_by_id" IS NOT NULL))
  AND ("held_by_id" IS NULL OR "held_by_id" <> "id"));
-- Written without a press: a rewrite card nobody pressed, never one held for web content or the day's budget.
ALTER TABLE "wiki_chat_draft" DROP CONSTRAINT IF EXISTS "wiki_chat_draft_auto_chk";
ALTER TABLE "wiki_chat_draft" ADD CONSTRAINT "wiki_chat_draft_auto_chk" CHECK (
  "auto_queued_at" IS NULL
  OR ("kind" = 'rewrite' AND "decision" IS NULL AND ("held" IS NULL OR "held" = 'draft')));

ALTER TABLE "wiki_chat_draft" DROP CONSTRAINT IF EXISTS "wiki_chat_draft_undone_chk";
ALTER TABLE "wiki_chat_draft" ADD CONSTRAINT "wiki_chat_draft_undone_chk" CHECK (
  "undone_at" IS NULL OR "decision" IN ('applied', 'edited') OR "auto_queued_at" IS NOT NULL);
ALTER TABLE "wiki_chat_draft" DROP CONSTRAINT IF EXISTS "wiki_chat_draft_seen_chk";
ALTER TABLE "wiki_chat_draft" ADD CONSTRAINT "wiki_chat_draft_seen_chk" CHECK (
  "seen_at" IS NULL OR "decision" IN ('applied', 'edited') OR "auto_queued_at" IS NOT NULL);
ALTER TABLE "wiki_chat_draft" DROP CONSTRAINT IF EXISTS "wiki_chat_draft_told_chk";
ALTER TABLE "wiki_chat_draft" ADD CONSTRAINT "wiki_chat_draft_told_chk" CHECK (
  "told_at" IS NULL OR "decision" IS NOT NULL OR "auto_queued_at" IS NOT NULL);

-- The cards waiting on one: what its Apply or Discard queues.
CREATE INDEX IF NOT EXISTS "wiki_chat_draft_held_by_idx" ON "wiki_chat_draft" ("held_by_id") WHERE "held_by_id" IS NOT NULL;
