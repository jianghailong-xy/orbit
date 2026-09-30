-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, phase 2, criterion 11: a plan draft under an idempotency key. The drafting job sends its
-- draft again when the answer to the first send was lost on its way back (a deploy's 502s, a stream the
-- edge reset), and until now the second landing was refused WIKI_PLAN_STALE — the first had already
-- stored the version it was built to replace — so a run whose draft was stored reported that it failed.
-- A draft may now carry a key, as a changeset does (0307): the same key with the same request is
-- answered with the version it stored, marked replayed, and writes nothing; the same key with another
-- request is refused WIKI_IDEMPOTENCY_KEY_REUSED. contracts/wiki.contract.json `plan.idempotency` is the
-- authority for everything below, and src/apiserver/src/wiki/wiki-plan-draft.pg.spec.ts holds it.
--
-- WHAT CHANGES
-- ------------
--   * wiki_plan.idempotency_key: the key a drafting job's draft was stored under, the owner's as a
--     changeset's is; NULL for every version stored without one — an owner's edit, an accepted
--     proposal, and every version stored before this migration.
--   * wiki_plan.request_sha256: the digest of the request the key was stored with (its normalized
--     JSON), which tells a replay (the same request) from a key reused for another. The two are set
--     and left NULL together, as on wiki_changeset.
--   * A unique index on (owner_id, idempotency_key): of two landings of one key, one version is stored.
--     NULLs are distinct, so versions stored with no key never collide.
--
-- WHAT DOES NOT
-- -------------
-- No row is written: both columns are nullable with no default, which PostgreSQL records in the
-- catalog rather than rewriting the table, and every existing version satisfies the CHECK as both
-- read NULL. The CHECK and the index each read wiki_plan once as they are made. No function, trigger or
-- type is created, replaced or dropped, and nothing outside wiki_plan is named.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0339: when this was written (2026-09-30) origin/main stood at 0336, project/34VR0RwUSIcaoO7ZZqv52
-- at 0338, and 0337 was another branch's (the documents' dispositions) — the first free number after
-- the highest. Every statement can run twice: the columns are added IF NOT EXISTS, the CHECK is
-- dropped IF EXISTS before it is added, and the index is created IF NOT EXISTS.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "wiki_plan" ADD COLUMN IF NOT EXISTS "idempotency_key" TEXT;
ALTER TABLE "wiki_plan" ADD COLUMN IF NOT EXISTS "request_sha256" CHAR(64);

-- The digest is what tells a replay (same request) from a key reused for another request.
ALTER TABLE "wiki_plan" DROP CONSTRAINT IF EXISTS "wiki_plan_idempotency_chk";
ALTER TABLE "wiki_plan" ADD CONSTRAINT "wiki_plan_idempotency_chk"
  CHECK (("idempotency_key" IS NULL) = ("request_sha256" IS NULL)
     AND ("request_sha256" IS NULL OR "request_sha256" ~ '^[0-9a-f]{64}$'));

-- NULLs are distinct: a version stored with no key never collides with another.
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_plan_owner_idempotency_key"
  ON "wiki_plan" ("owner_id", "idempotency_key");
