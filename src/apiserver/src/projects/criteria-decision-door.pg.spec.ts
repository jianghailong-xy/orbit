/**
 * THE DECISION DOOR: TWO KEYS, ONE TRANSACTION, AND FOUR REFUSALS THAT WRITE NOTHING.
 *
 * `criteria-weakening-intent.pg.spec.ts` witnesses the ask — a loosening edit does not take effect
 * and becomes one `project_ratified_action_intent` row. This file witnesses the ANSWER: the
 * account owner approving that proposal applies it, advances the seal and records the approval as
 * one indivisible thing, or rejecting it settles the proposal and moves not one criterion.
 *
 * WHY "NOTHING WAS WRITTEN" IS ASSERTED AGAINST A CENSUS AND NOT A COUNT
 * ---------------------------------------------------------------------
 * Every refusal below is paired with `census()` — the criteria as the rows hold them, the seal off
 * those same rows, every decision row and every ratified-action commit row. It is captured before
 * the refused call and `deepEqual`d after it, so a refusal that wrote a decision, applied half an
 * edit, or left a commit row behind fails on the difference rather than on a number somebody
 * remembered to update. `assert.equal(rows.length, 0)` would pass just as well on a door that was
 * never reached at all, which is why the successful APPROVE at the end is in the same file: it is
 * the positive that makes every "nothing happened" above mean something.
 *
 * THE ONE-TRANSACTION CLAIM IS WITNESSED BY BREAKING THE LAST WRITE
 * ----------------------------------------------------------------
 * Three things have to happen together on an APPROVE: the edit applies, the seal advances, the
 * approval is recorded. Observing all three afterwards does not distinguish one transaction from
 * three that happened to succeed. So case (E) installs a trigger that makes the LAST of the three
 * writes raise, calls APPROVE, and asserts that the first two are gone too — which only holds if
 * they shared a transaction with the one that failed. The trigger is then dropped and the same
 * call made again, so the same fixture witnesses both the rollback and the commit.
 *
 * WHY THE SEAL IS CHECKED TWICE ON ONE RULE
 * ----------------------------------------
 * A decision names the version of the standard set it was given against. Case (D) moves the ruler
 * under a pending proposal and then answers it two ways: with the seal the card was rendered
 * against (stale request), and with the seal that stands now (fresh request, stale proposal).
 * Both are the same refusal, because approving a proposal composed against an older set would
 * take back whatever was stated in between — which is the walk this whole arrangement forbids.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/criteria-decision-door.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { HttpException } from '@nestjs/common';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** How the criteria say they are to be judged. Restated byte for byte by every edit below. */
const METHOD = 'A person reads the criterion and says whether it holds';

const FIRST = 'the decision door refuses four ways, and writes no effective row on any of them';
const SECOND = 'an APPROVE applies the edit, advances the seal and records the approval together';
const THIRD = 'the criterion this fixture drops, so that dropping it is a loosening';
const FOURTH = 'a fourth criterion, added by a tightening edit that moves the ruler under a proposal';

/** One criterion as a held proposal's `action.request` states it. */
interface ProposedCriterion {
  id: string | null;
  text: string;
  verificationMethod: string;
}

/** Everything a refusal must not have touched, in one value. */
interface Census {
  criteria: Array<{ id: string; ordinal: number; text: string; revision: number; contentHash: string }>;
  seal: string;
  decisions: Array<{
    intentId: string; decision: string; baseSeal: string; resultingSeal: string; decidedById: string;
  }>;
  commits: Array<{ intentId: string; budgetCharge: number; contractDigest: string }>;
}

/** An HTTP refusal, unwrapped into the two things a caller acts on. */
function refusal(error: unknown): { status: number; body: Record<string, unknown> } {
  assert.ok(error instanceof HttpException, `expected an HttpException, got ${String(error)}`);
  const body = error.getResponse();
  assert.equal(typeof body, 'object', 'a typed refusal answers with a body, not a bare string');
  return { status: error.getStatus(), body: body as Record<string, unknown> };
}

test('the criteria decision door: two keys, one transaction, four refusals', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const acceptance = new ProjectAcceptanceService(prisma as unknown as PrismaService);
  const projects = new ProjectsService(prisma as unknown as PrismaService, acceptance);

  const ownerId = randomUUID();
  const projectId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `decision-${ownerId}@standard-set.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'The project whose ruler only the owner may loosen' },
  });

  /** State the whole collection through the owner's path — the only writer of a definition. */
  async function state(items: Array<{ id?: string; text: string }>) {
    return projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: items.map((item) => ({
        ...(item.id ? { id: item.id } : {}),
        text: item.text,
        verificationMethod: METHOD,
      })),
    } as never) as Promise<Record<string, unknown>>;
  }

  /** The seal that stands, through the same read path the product's confirmation page uses. */
  async function seal(): Promise<string> {
    return (await acceptance.standardSetConfirmation(ownerId, projectId)).currentVersion.digest;
  }

  /** Everything a refusal must leave alone, read straight off the tables. */
  async function census(): Promise<Census> {
    const criteria = (await sql.query<{
      id: string; ordinal: number; text: string; revision: number; content_hash: string;
    }>(
      `SELECT "id", "ordinal", "text", "revision", "content_hash"
         FROM "project_acceptance_criterion_definition"
        WHERE "project_id" = $1::uuid ORDER BY "ordinal"`, [projectId],
    )).rows.map((row) => ({
      id: row.id, ordinal: row.ordinal, text: row.text,
      revision: row.revision, contentHash: row.content_hash,
    }));
    const decisions = (await sql.query<{
      intent_id: string; decision: string; base_seal: string; resulting_seal: string;
      decided_by_id: string;
    }>(
      `SELECT "intent_id", "decision", "base_seal", "resulting_seal", "decided_by_id"
         FROM "project_criteria_decision"
        WHERE "project_id" = $1::uuid ORDER BY "decided_at", "intent_id"`, [projectId],
    )).rows.map((row) => ({
      intentId: row.intent_id, decision: row.decision, baseSeal: row.base_seal,
      resultingSeal: row.resulting_seal, decidedById: row.decided_by_id,
    }));
    const commits = (await sql.query<{
      intent_id: string; budget_charge: number; contract_digest: string;
    }>(
      `SELECT "intent_id", "budget_charge", "contract_digest"
         FROM "project_ratified_action_commit"
        WHERE "project_id" = $1::uuid ORDER BY "committed_at", "intent_id"`, [projectId],
    )).rows.map((row) => ({
      intentId: row.intent_id, budgetCharge: row.budget_charge, contractDigest: row.contract_digest,
    }));
    return { criteria, seal: await seal(), decisions, commits };
  }

  /**
   * The newest proposal on record, with the key the proposer never receives.
   *
   * Read out of the table rather than out of a response, because the response deliberately does
   * not carry it: `criteria-weakening-intent.pg.spec.ts` asserts the token appears nowhere in the
   * body handed to whoever filed the proposal. A test standing in for the account owner is
   * exactly the party that does hold it.
   */
  async function newestProposal(): Promise<{
    id: string; commitToken: string; contractDigest: string; baselineSeal: string;
    proposed: ProposedCriterion[];
  }> {
    const { rows } = await sql.query<{
      id: string; commit_token: string; contract_digest: string; action: {
        request: { proposed: ProposedCriterion[] }; baseline: { seal: string };
      };
    }>(
      `SELECT "id", "commit_token", "contract_digest", "action"
         FROM "project_ratified_action_intent"
        WHERE "project_id" = $1::uuid
        ORDER BY "created_at" DESC, "id" DESC LIMIT 1`, [projectId],
    );
    assert.equal(rows.length, 1, 'the edit under test has to have filed a proposal');
    const [row] = rows;
    return {
      id: row.id,
      commitToken: row.commit_token,
      contractDigest: row.contract_digest,
      baselineSeal: row.action.baseline.seal,
      proposed: row.action.request.proposed,
    };
  }

  /** Answer a proposal as the account owner would: no acting session, the owner's own id. */
  function decide(
    intentId: string,
    body: { commitToken: string; decision: 'APPROVE' | 'REJECT'; baseSeal: string; note?: string },
    actingSessionId?: string,
  ) {
    return projects.decideCriteriaChange(ownerId, projectId, intentId, body as never, actingSessionId);
  }

  /** Every id in `census().criteria`, by the text it states. */
  const idOf = (rows: Census['criteria'], text: string): string => {
    const row = rows.find((criterion) => criterion.text === text);
    assert.ok(row, `the fixture must still state: ${text}`);
    return row.id;
  };

  // ── the fixture: three criteria, then one loosening edit held as a proposal ───────────────────
  await state([{ text: FIRST }, { text: SECOND }, { text: THIRD }]);
  const opening = await census();
  assert.equal(opening.criteria.length, 3, 'the fixture starts with three criteria');
  assert.match(opening.seal, /^[0-9a-f]{64}$/);
  assert.deepEqual(opening.decisions, [], 'and nothing has been decided yet');

  // Dropping a criterion is the loosening the classifier can read without any ambiguity.
  await state([
    { id: idOf(opening.criteria, FIRST), text: FIRST },
    { id: idOf(opening.criteria, SECOND), text: SECOND },
  ]);
  const firstProposal = await newestProposal();
  assert.equal(firstProposal.baselineSeal, opening.seal,
    'the proposal names the standard set it was composed against');
  assert.deepEqual(await census(), opening, 'and filing it moved nothing');

  // ═══ (A) NO CREDENTIAL: a request that carries an acting session ══════════════════════════════

  await t.test('(A) a session-authored decision is refused, and writes nothing', async () => {
    const before = await census();
    const error = await decide(
      firstProposal.id,
      { commitToken: firstProposal.commitToken, decision: 'APPROVE', baseSeal: before.seal },
      randomUUID(),
    ).then(() => null, (e: unknown) => e);

    const { status, body } = refusal(error);
    assert.equal(status, 403);
    assert.equal(body.code, 'PROJECT_CRITERIA_DECISION_OWNER_CHANNEL_ONLY');
    assert.equal(body.requiredAction, 'ASK_A_PERSON',
      'the caller is told what to do instead: ask a person');
    assert.equal(body.tier, 'HUMAN_ONLY');
    // Its own code, not the confirmation's: a caller refused here met a rule about MOVING the
    // ruler, not one about approving the set it already states.
    assert.notEqual(body.code, 'PROJECT_CRITERIA_CONFIRMATION_OWNER_CHANNEL_ONLY');
    assert.match(String(body.message), /Nothing was written/);

    // It held BOTH keys — the real token, the standing seal — and still could not decide. That is
    // what makes the credential a key rather than a formality.
    assert.deepEqual(await census(), before,
      'not one criterion, decision or commit row moved');
  });

  // ═══ (B) NO KEY, and the WRONG key: two rules, two codes ══════════════════════════════════════

  await t.test('(B) a decision with no commit token, or the wrong one, is refused', async () => {
    const before = await census();

    const missing = refusal(await decide(
      firstProposal.id,
      { commitToken: '   ', decision: 'APPROVE', baseSeal: before.seal },
    ).then(() => null, (e: unknown) => e));
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'PROJECT_CRITERIA_DECISION_KEY_MISSING');
    assert.match(String(missing.body.message), /Nothing was written/);
    assert.deepEqual(await census(), before, 'a missing key writes nothing');

    // A well-formed token that is not this proposal's. Refused as a KEY failure and not as a
    // 404: the proposal is there, and what is wrong is the key the caller brought to it.
    const wrong = refusal(await decide(
      firstProposal.id,
      { commitToken: randomUUID(), decision: 'APPROVE', baseSeal: before.seal },
    ).then(() => null, (e: unknown) => e));
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.code, 'PROJECT_CRITERIA_DECISION_TOKEN_INVALID');
    assert.notEqual(wrong.body.code, missing.body.code,
      'two rules, two codes: a caller learns WHICH one it met');
    assert.match(String(wrong.body.message), /Nothing was written/);
    assert.deepEqual(await census(), before, 'a wrong key writes nothing either');
  });

  // ═══ (C) THE RULER MOVES UNDERNEATH: the tightening that lands, and what it does to a proposal ═

  let secondProposalId = '';
  await t.test('(C) once the seal moves, the pending proposal cannot be decided either way', async () => {
    // A TIGHTENING edit, which lands where it is made — and this is also the positive control for
    // the whole file: the write path the refusals above did not reach is a path that CAN write.
    const before = await census();
    await state([
      ...before.criteria.map((criterion) => ({ id: criterion.id, text: criterion.text })),
      { text: FOURTH },
    ]);
    const moved = await census();
    assert.equal(moved.criteria.length, 4, 'the tightening edit landed');
    assert.notEqual(moved.seal, before.seal, 'so the seal is not the one the proposal named');
    assert.deepEqual(moved.decisions, [], 'and it decided nothing');

    // (1) the stale card: answered with the seal that was on the table when it was rendered.
    const stale = refusal(await decide(
      firstProposal.id,
      { commitToken: firstProposal.commitToken, decision: 'APPROVE', baseSeal: before.seal },
    ).then(() => null, (e: unknown) => e));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'PROJECT_CRITERIA_DECISION_BASE_SEAL_MOVED');
    assert.equal(stale.body.currentSeal, moved.seal,
      'and it names the seal that stands, so the caller can re-read against it');
    assert.deepEqual(await census(), moved, 'nothing was written');

    // (2) the fresh card over a stale proposal: the caller names the seal that stands NOW, but the
    // proposal was composed against the older one. Approving it would take the tightening back.
    const outdated = refusal(await decide(
      firstProposal.id,
      { commitToken: firstProposal.commitToken, decision: 'APPROVE', baseSeal: moved.seal },
    ).then(() => null, (e: unknown) => e));
    assert.equal(outdated.status, 409);
    assert.equal(outdated.body.code, 'PROJECT_CRITERIA_DECISION_BASE_SEAL_MOVED',
      'one rule, one code: the ruler this decision is about is not the ruler that stands');
    assert.equal(outdated.body.proposalSeal, before.seal,
      'and the refusal says which set the proposal WAS composed against');
    assert.deepEqual(await census(), moved, 'nothing was written');

    // The way forward is the ordinary one: make the change again against the set that stands, and
    // a new proposal is filed against the seal that is actually on the table.
    await state(moved.criteria
      .filter((criterion) => criterion.text !== THIRD)
      .map((criterion) => ({ id: criterion.id, text: criterion.text })));
    const second = await newestProposal();
    assert.notEqual(second.id, firstProposal.id, 'a second proposal, not the first one edited');
    assert.equal(second.baselineSeal, moved.seal, 'and it names the set that stands now');
    secondProposalId = second.id;
    assert.deepEqual(await census(), moved, 'filing it moved nothing');
  });

  // ═══ (D) REJECT settles the proposal and touches no criterion; a second answer is refused ═════

  await t.test('(D) a REJECT settles the proposal and moves nothing; deciding twice is refused', async () => {
    const before = await census();
    const proposal = await newestProposal();
    assert.equal(proposal.id, secondProposalId);

    const rejected = await decide(proposal.id, {
      commitToken: proposal.commitToken,
      decision: 'REJECT',
      baseSeal: before.seal,
      note: 'the third criterion is the one this project is actually for',
    });

    assert.equal(rejected.decision, 'REJECT');
    assert.equal(rejected.applied, false, 'a REJECT applies nothing, and says so');
    assert.equal(rejected.baseSeal, before.seal);
    assert.equal(rejected.resultingSeal, before.seal,
      'and its result is its starting point, because it moved nothing');
    assert.deepEqual(
      rejected.acceptanceCriteriaItems.map((item) => item.text),
      before.criteria.map((criterion) => criterion.text),
      'the criteria in the response are the ones that were already in force',
    );

    const after = await census();
    assert.deepEqual(after.criteria, before.criteria, 'not one definition row moved');
    assert.equal(after.seal, before.seal, 'so the seal did not move either');
    assert.deepEqual(after.commits, [],
      'and a REJECT writes no ratified-action commit: nothing was committed');
    assert.deepEqual(after.decisions, [{
      intentId: proposal.id,
      decision: 'REJECT',
      baseSeal: before.seal,
      resultingSeal: before.seal,
      decidedById: ownerId,
    }], 'exactly one row says what was answered, against which version, and by whom');

    // ── the second answer, with both keys and the standing seal, is still refused ───────────────
    const again = refusal(await decide(proposal.id, {
      commitToken: proposal.commitToken,
      decision: 'APPROVE',
      baseSeal: after.seal,
    }).then(() => null, (e: unknown) => e));
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'PROJECT_CRITERIA_DECISION_ALREADY_SETTLED');
    assert.equal(again.body.settledAs, 'REJECT',
      'the caller is told how it was settled, not merely that it was');
    assert.match(String(again.body.decidedAt), /^\d{4}-\d{2}-\d{2}T/);
    assert.match(String(again.body.message), /Nothing was written/);
    assert.deepEqual(await census(), after,
      'the settled proposal keeps the one answer it has: no second decision row, no commit row, '
      + 'and the criteria the REJECT left standing');
  });

  // ═══ (E) APPROVE: the three writes are one transaction, witnessed by breaking the last ════════

  await t.test('(E) an APPROVE applies, re-seals and records — all three, or none of them', async () => {
    const before = await census();
    // A different ask from the rejected one, so this is a new proposal rather than the same
    // request handed back: dropping the criterion the tightening ADDED.
    await state(before.criteria
      .filter((criterion) => criterion.text !== FOURTH)
      .map((criterion) => ({ id: criterion.id, text: criterion.text })));
    const proposal = await newestProposal();
    assert.notEqual(proposal.id, secondProposalId, 'a third proposal, freshly filed');
    assert.equal(proposal.baselineSeal, before.seal);
    assert.deepEqual(proposal.proposed.map((item) => item.text),
      before.criteria.filter((c) => c.text !== FOURTH).map((c) => c.text),
      'and it asks for exactly the set the edit named');
    const held = await census();
    assert.deepEqual(held.criteria, before.criteria, 'filing it applied nothing');

    // The owner confirms the set that stands, so that the SECOND consequence of an APPROVE — the
    // confirmation going stale under it — is a state change this file can watch rather than a
    // property of a project nobody had confirmed.
    const confirmed = await acceptance.confirmStandardSet(
      ownerId, projectId, { criteriaDigest: held.seal },
    );
    assert.equal(confirmed.state, 'CONFIRMED');

    // ── the rollback: make the LAST of the three writes fail ───────────────────────────────────
    // A trigger rather than a contrived unique-key collision: it raises exactly once, exactly on
    // the statement being broken, and it says so in its own message. `P0001` is not one of the
    // three codes `withTransactionRetry` re-runs, so this is one attempt and one failure.
    await sql.query(`
      CREATE OR REPLACE FUNCTION pccspec_break_the_last_write() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'PCCSPEC_COMMIT_ROW_REFUSED';
      END $fn$;
      CREATE TRIGGER pccspec_break_the_last_write
        BEFORE INSERT ON "project_ratified_action_commit"
        FOR EACH ROW EXECUTE FUNCTION pccspec_break_the_last_write()`);

    const broke = await decide(proposal.id, {
      commitToken: proposal.commitToken, decision: 'APPROVE', baseSeal: held.seal,
    }).then(() => null, (e: unknown) => e);
    assert.ok(broke, 'the APPROVE has to have failed, or this case witnesses nothing');
    assert.match(String((broke as { message?: string }).message ?? broke),
      /PCCSPEC_COMMIT_ROW_REFUSED/,
      'and it failed on the write this case broke, not on something else');

    // The whole of the claim: the other two writes are gone as well.
    assert.deepEqual(await census(), held,
      'the edit did not apply, the seal did not move and no approval was recorded — so all three '
      + 'were in one transaction with the write that failed');
    assert.equal(
      (await acceptance.standardSetConfirmation(ownerId, projectId)).state,
      'CONFIRMED',
      'and the owner’s confirmation still stands, because the set it named never moved',
    );

    await sql.query('DROP TRIGGER pccspec_break_the_last_write ON "project_ratified_action_commit"');

    // ── the commit: the same call, against the same fixture ────────────────────────────────────
    const approved = await decide(proposal.id, {
      commitToken: proposal.commitToken, decision: 'APPROVE', baseSeal: held.seal,
    });

    assert.equal(approved.decision, 'APPROVE');
    assert.equal(approved.applied, true);
    assert.equal(approved.intentId, proposal.id);
    assert.equal(approved.decidedById, ownerId);
    assert.equal(approved.baseSeal, held.seal);
    assert.notEqual(approved.resultingSeal, held.seal, 'the seal advanced');

    const after = await census();

    // (i) THE EDIT APPLIED.
    assert.deepEqual(after.criteria.map((criterion) => criterion.text), [FIRST, SECOND, THIRD],
      'the criterion the proposal asked to drop is gone, and only that one');
    assert.deepEqual(
      approved.acceptanceCriteriaItems.map((item) => item.text),
      after.criteria.map((criterion) => criterion.text),
      'and the response states the criteria that are now in force',
    );

    // (ii) THE SEAL ADVANCED — read back off the rows, not recomputed by the caller.
    assert.equal(after.seal, approved.resultingSeal,
      'the seal the response reports is the seal a reader of the rows computes');
    assert.equal(approved.confirmation.state, 'STALE',
      'so the confirmation given against the older set no longer counts');
    assert.equal(approved.confirmation.confirmed, false);
    assert.equal(approved.confirmation.currentVersion.digest, after.seal);
    assert.equal(approved.confirmation.confirmation?.criteriaDigest, held.seal,
      'and the response still says WHICH version the owner had confirmed');

    // (iii) THE APPROVAL WAS RECORDED, on both tables it belongs on.
    assert.deepEqual(after.decisions, [
      ...held.decisions,
      {
        intentId: proposal.id,
        decision: 'APPROVE',
        baseSeal: held.seal,
        resultingSeal: after.seal,
        decidedById: ownerId,
      },
    ], 'one decision row naming the version it was given against and the one it produced');
    assert.deepEqual(after.commits, [{
      intentId: proposal.id,
      budgetCharge: 0,
      contractDigest: proposal.contractDigest,
    }], 'and one ratified-action commit, charging nothing: a criteria decision is not an action '
      + 'the 24-hour budget is about');

    // The key is spent, which is what "one-time" means.
    const spent = refusal(await decide(proposal.id, {
      commitToken: proposal.commitToken, decision: 'REJECT', baseSeal: after.seal,
    }).then(() => null, (e: unknown) => e));
    assert.equal(spent.status, 409);
    assert.equal(spent.body.code, 'PROJECT_CRITERIA_DECISION_ALREADY_SETTLED');
    assert.equal(spent.body.settledAs, 'APPROVE');
    assert.deepEqual(await census(), after, 'and the refusal wrote nothing');
  });
});
