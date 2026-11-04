-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki: a verdict that read only a note is a verdict about the note. docs/wiki-memory-claims-design.md
-- section 3.4, in the scope the coordinator set from the audit in section 6.1. An entry drawn from an agent's
-- memory file says the words of that file, so a verifier handed only those words can show only that the
-- entry copied them. The server marks such a verdict `second_hand`, leaves its supported no more than
-- Unreviewed, and keeps it in the fallback's count, because the model did read text.
-- contracts/wiki.contract.json `reviewModes.verification.evidence` is the authority, and
-- src/apiserver/src/wiki/wiki-schema.pg.spec.ts holds this CHECK to it.
--
-- WHAT CHANGES
-- ------------
-- `wiki_changeset_op_verification_evidence_chk` admits a third word, `second_hand`, beside `readable` and
-- `unreadable`, still only beside a verdict (0314).
--
-- WHAT DOES NOT
-- -------------
-- No row is written. Every stored mark is one of the two old words or NULL, so every row satisfies the new
-- CHECK as it stands, and no entry or op recorded before this migration changes. No function, trigger, type or
-- index is created, replaced or dropped, and nothing outside wiki_changeset_op is named. The code before
-- this migration writes only the two old words, so a deployment still running it is unaffected, and it
-- reads `second_hand` as neither of them: out of the fallback's window, and not reopenable. Nothing is
-- locked beyond what the CHECK's validation reads, restated in one statement as 0429 and 0467 restate theirs.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0470: the highest number on origin/main, on project/* and orbit/* and in the checkouts on this host was
-- 0469 when this was written (2026-11-05). Every statement can run twice: the CHECK is dropped IF EXISTS
-- before it is added.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "wiki_changeset_op"
  DROP CONSTRAINT IF EXISTS "wiki_changeset_op_verification_evidence_chk",
  ADD CONSTRAINT "wiki_changeset_op_verification_evidence_chk"
    CHECK ("verification_evidence" IS NULL
       OR ("verification_evidence" IN ('readable', 'second_hand', 'unreadable') AND "verification_verdict" IS NOT NULL));
