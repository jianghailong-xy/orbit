-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, the wiki chat (project 34sYUuoSpnReXXn6j28WR, task C6): the cards a chat's agent drafts and
-- the owner presses. docs/wiki-chat-design.md section 7 and docs/wiki-contract.md section 28.5–28.6
-- (contracts/wiki.contract.json `chat.drafts` and `chat.presses`) are the authority for everything below;
-- src/apiserver/src/wiki/wiki-chat-drafts.pg.spec.ts holds these CHECKs to the contract's closed sets.
--
-- WHAT IS ADDED
-- -------------
--   wiki_chat_draft   one row per card: the chat (session_id) it was drafted in and its space; its kind
--                     (entry, rewrite or plan); the agent's rationale; an entry card's ops as checked, each
--                     with its similar[] (ops), a rewrite card's sections, a plan card's change; the
--                     sections it rewrites once pressed (rewrites), worked out when it was drafted; whether
--                     the chat had read the web then (tainted); the open card of the same chat it replaced
--                     (replaces_id); the drafting call's idempotency key and request digest; and the press —
--                     the decision (applied, edited or discarded), when, the changeset an Apply recorded and
--                     the trust each entry an amend changed had before it (trust_before) — then undone_at,
--                     seen_at (the owner opened its settled rewrite) and told_at (the agent was told of its
--                     press with the owner's next message, notes.drafts).
--
-- A card is never a changeset (design section 7.1): it takes no place in pendingOpsPerSpace, leaves no
-- proposed entry and is in no Review. Its state is derived on read (`chat.drafts.derivation`), never
-- stored: no column says draft, replaced, changed or not applied.
--
-- WHO WRITES IT. The drafting tool call (wiki_propose or a wiki_note's corrects in a chat, and wiki_draft)
-- inserts it in its own transaction; the owner's presses (apply, edit, discard, undo, retry, seen) and the
-- delivery that tells the agent of them update it. src/apiserver/src/common/db-write-inventory.ts names
-- each writer.
--
-- TENANCY
-- -------
-- As every wiki child reaches its parent (0307, 0326, 0475): (space_id, owner_id) references wiki_space ON
-- DELETE CASCADE, so a space's delete takes its cards (contract `chat.binding.rule`). The chat session, the
-- card replaced and the changeset an Apply recorded are history references with no foreign key (contract
-- `storage.historyRefs`), as wiki_changeset.session_id is: a session in Trash keeps its cards, which read
-- not applied.
--
-- LOCKS
-- -----
-- The CREATE TABLE's foreign key takes wiki_space's SHARE ROW EXCLUSIVE lock for the moment the table is
-- made, as 0475's did; no other existing table is named, no row of one is written, read or locked, and no
-- existing table gains a column. No DO block, so Prisma sends each statement on its own.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0483: 0481 (wiki_entry_claim_check, origin/orbit/task-a-wiki-b45864) and 0482 (wiki_model_request_material,
-- orbit/task-31fa21) were taken on other branches when this was written (2026-11-06); main stood at 0480.
-- Every statement can run twice: CREATE TABLE / INDEX IF NOT EXISTS, with the table's constraints inside
-- its CREATE.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "wiki_chat_draft" (
  "id"              UUID NOT NULL,
  "owner_id"        UUID NOT NULL,
  "space_id"        UUID NOT NULL,
  -- The chat (session.wiki_chat_space_id set) it was drafted in. A history reference with no foreign key.
  "session_id"      UUID NOT NULL,
  "kind"            TEXT NOT NULL,
  "rationale"       TEXT NOT NULL,
  -- entry: [{ seq, op, entryId, baseRevision, payload, similar, tainted }, …], as checked and redacted.
  "ops"             JSONB NOT NULL DEFAULT '[]',
  -- rewrite: [{ doc, key }, …], the sections wiki_draft named.
  "sections"        JSONB NOT NULL DEFAULT '[]',
  -- plan: the change, shaped as a plan proposal's (contract `plan.proposals`).
  "change"          JSONB,
  -- [{ doc, key }, …]: what its press rewrites (contract `chat.drafts.rewrites`), at most 5.
  "rewrites"        JSONB NOT NULL DEFAULT '[]',
  "tainted"         BOOLEAN NOT NULL DEFAULT false,
  -- The open card of the same chat this one replaced. A history reference with no foreign key.
  "replaces_id"     UUID,
  "idempotency_key" TEXT,
  "request_sha256"  CHAR(64),
  -- The press: applied, edited or discarded, and when.
  "decision"        TEXT,
  "decided_at"      TIMESTAMPTZ(3),
  -- The changeset an entry card's Apply or Edit recorded. A history reference with no foreign key.
  "changeset_id"    UUID,
  -- { "<entry id>": "<trust>" }: what each entry an amend of the card changed was trusted as before the press.
  "trust_before"    JSONB,
  "undone_at"       TIMESTAMPTZ(3),
  "seen_at"         TIMESTAMPTZ(3),
  "told_at"         TIMESTAMPTZ(3),
  "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wiki_chat_draft_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_chat_draft_id_owner_id_key" UNIQUE ("id", "owner_id"),
  CONSTRAINT "wiki_chat_draft_space_fkey"
    FOREIGN KEY ("space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_chat_draft_kind_chk" CHECK ("kind" IN ('entry', 'rewrite', 'plan')),
  CONSTRAINT "wiki_chat_draft_rationale_chk" CHECK (btrim("rationale") <> '' AND char_length("rationale") <= 4000),
  CONSTRAINT "wiki_chat_draft_rows_chk" CHECK (
    jsonb_typeof("ops") = 'array' AND jsonb_typeof("sections") = 'array' AND jsonb_typeof("rewrites") = 'array'
    AND jsonb_array_length("rewrites") <= 5
    AND ("trust_before" IS NULL OR jsonb_typeof("trust_before") = 'object')),
  -- An entry card holds ops and no sections, a rewrite card 1 to 5 sections and no op, a plan card its change.
  CONSTRAINT "wiki_chat_draft_shape_chk" CHECK (
    ("kind" = 'entry' AND jsonb_array_length("ops") BETWEEN 1 AND 30 AND jsonb_array_length("sections") = 0 AND "change" IS NULL)
    OR ("kind" = 'rewrite' AND jsonb_array_length("ops") = 0 AND jsonb_array_length("sections") BETWEEN 1 AND 5 AND "change" IS NULL)
    OR ("kind" = 'plan' AND jsonb_array_length("ops") = 0 AND "change" IS NOT NULL)),
  CONSTRAINT "wiki_chat_draft_replaces_chk" CHECK ("replaces_id" IS NULL OR "replaces_id" <> "id"),
  CONSTRAINT "wiki_chat_draft_idempotency_chk" CHECK (
    ("idempotency_key" IS NULL) = ("request_sha256" IS NULL)
    AND ("idempotency_key" IS NULL OR (char_length("idempotency_key") BETWEEN 1 AND 200 AND "request_sha256" ~ '^[0-9a-f]{64}$'))),
  -- A press is one of three, with its time; an Apply's changeset and the trust it found are an entry card's
  -- applied or edited press; Undo takes back an applied or edited card, and only once it was pressed.
  CONSTRAINT "wiki_chat_draft_decision_chk" CHECK (
    ("decision" IS NULL OR "decision" IN ('applied', 'edited', 'discarded'))
    AND (("decision" IS NULL) = ("decided_at" IS NULL))),
  CONSTRAINT "wiki_chat_draft_changeset_chk" CHECK (
    ("changeset_id" IS NULL AND "trust_before" IS NULL)
    OR ("kind" = 'entry' AND "decision" IN ('applied', 'edited'))),
  CONSTRAINT "wiki_chat_draft_undone_chk" CHECK ("undone_at" IS NULL OR "decision" IN ('applied', 'edited')),
  CONSTRAINT "wiki_chat_draft_seen_chk" CHECK ("seen_at" IS NULL OR "decision" IN ('applied', 'edited')),
  CONSTRAINT "wiki_chat_draft_told_chk" CHECK ("told_at" IS NULL OR "decision" IS NOT NULL)
);
-- A card is replaced at most once: only the newest of a chain is open (contract `chat.drafts.replace`), and two
-- drafts racing to replace the same card cannot both win.
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_chat_draft_replaces_key" ON "wiki_chat_draft" ("replaces_id") WHERE "replaces_id" IS NOT NULL;
-- The drafting call's key, as wiki_changeset's is: the same request under the same key is the same card.
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_chat_draft_owner_idempotency_key"
  ON "wiki_chat_draft" ("owner_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
-- A chat's cards, oldest first: the chat's drafts read, the panel, the delivery's note.
CREATE INDEX IF NOT EXISTS "wiki_chat_draft_session_idx" ON "wiki_chat_draft" ("session_id", "created_at");
-- A space's cards: the round button's counts and the Wiki's waiting count (chatWaiting).
CREATE INDEX IF NOT EXISTS "wiki_chat_draft_space_idx" ON "wiki_chat_draft" ("space_id", "created_at");
-- The card an Apply's changeset belongs to: the revert route's way to the card's Undo.
CREATE INDEX IF NOT EXISTS "wiki_chat_draft_changeset_idx" ON "wiki_chat_draft" ("changeset_id") WHERE "changeset_id" IS NOT NULL;
