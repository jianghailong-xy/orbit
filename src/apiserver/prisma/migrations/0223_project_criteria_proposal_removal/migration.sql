-- Remove the acceptance-criteria proposal channel. `acceptanceCriteriaItems` is a write again.
--
-- 0217_project_criteria_proposal_card turned an agent's acceptance-criteria edit into a card the
-- account owner had to answer, and 0218 kept that card while deleting the approval queue that had
-- grown around it. The account owner has now decided to remove the protection itself. This
-- migration takes the whole channel out rather than leaving half of it standing.
--
-- What that costs, stated here rather than discovered later: after this migration any principal
-- that can reach `project_update` rewrites any project's acceptance criteria directly and in
-- force, with no confirmation step, no rendered semantic diff and no ABA protection on the set the
-- edit was drafted against. The four invariants 0217 and 0218 carried --
--
--   * acceptance criteria have no direct editing entry point on the web,
--   * a proposal has no automatic apply path,
--   * a proposal does not move the ruler while it stands,
--   * no machine principal may decide one
--
-- -- are removed, not relocated. Nothing in this schema takes them over, and nothing should be
-- added later that quietly reinstates an equivalent protection under another name.
--
-- What is deliberately NOT touched: `project_acceptance_criterion_definition`,
-- `project_acceptance_criterion` and every other `project_acceptance_*` relation. This migration
-- names none of them in any statement, so no criterion's `text` or `verification_method` can move
-- by one byte. `project_criteria_proposal` held zero rows: the channel landed on 2026-09-01 and
-- was never used.
-- (2026-09-02: `project_acceptance_criteria_confirmation` was one of the relations this migration
-- left standing. 0226_project_criteria_confirmation_removal has since dropped it as an orphan --
-- zero writers, zero readers. Nothing above changed; the sentence is annotated, not rewritten.)
BEGIN;

-- The two doors, the applier, the card renderer and the readers underneath them. Dropped before
-- the table because several take `project_criteria_proposal%ROWTYPE`.
DROP FUNCTION project_criteria_proposal_state_json(uuid, uuid);
DROP FUNCTION project_owner_decide_criteria_proposal(uuid, uuid, text, text, uuid, text, text, text);
DROP FUNCTION project_propose_acceptance_criteria(uuid, uuid, text, text, jsonb, text);
DROP FUNCTION project_apply_criteria_proposal(uuid, jsonb);
DROP FUNCTION project_criteria_proposal_card(jsonb, jsonb, timestamptz);
DROP FUNCTION project_criteria_proposal_diff(jsonb, jsonb);
DROP FUNCTION project_criteria_proposal_normalize(uuid, jsonb);
-- 0218's one addition to the channel: the identity of the criteria set a proposal was drafted
-- against. Both of its callers were inside the decision function dropped above.
DROP FUNCTION project_acceptance_criteria_set_digest(uuid);
DROP FUNCTION project_criteria_proposal_effective_criteria(uuid);

-- The table and its six indexes: the primary key, the (project_id, proposal_generation) unique
-- constraint, and the four 0217 declared by name -- one_pending, idempotency, decision_idempotency
-- and inbox. PostgreSQL drops all of them, and the table's own constraints, with it. It carries no
-- trigger and nothing points at it, so this reaches nothing else. 0217 created no view.
DROP TABLE project_criteria_proposal;

COMMIT;
