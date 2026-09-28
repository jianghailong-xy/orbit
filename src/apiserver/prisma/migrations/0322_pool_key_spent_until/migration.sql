-- 0322 — when a key of a shared Codex pool (0321) is out of budget, and until when
-- (docs/codex-shared-pool-design.md §2.2–§2.3).
--
-- The pool gateway forwards a session's requests on the key its claim chose. When OpenAI answers one of
-- them `insufficient_quota` — the key's organization or project has spent what it may — the gateway marks
-- the key out of budget until the moment it can be spent again: the reset OpenAI names if it names one,
-- else the first day of the next calendar month (UTC), the window the pool's ledger and share caps count.
-- A claim chooses no key whose `spent_until` is still ahead of it, so a session's next turn moves onto
-- another key; with every key spent, the session waits for the earliest of these, as it waits for any
-- quota. A request that goes through on a key marked this way clears the mark, and so does replacing the
-- key's secret.
--
-- One nullable `ADD COLUMN`, no default, no index, no CHECK: NULL is "not out of budget", which is every
-- key there is today. Nothing is backfilled and no row is rewritten.
--
-- Numbered to run after 0321_shared_provider_pool, whose table it alters. That migration was written as
-- 0320 and renumbered 0321 before it reached main, where 0320_wiki_maintenance_run had taken the number.

ALTER TABLE "pool_api_key" ADD COLUMN "spent_until" TIMESTAMP(3);
