/**
 * "PENDING" EXCLUDES "ANSWERED": A REJECTED PROPOSAL DOES NOT HOLD THE EDIT HOSTAGE.
 *
 * `criteria-weakening-intent.pg.spec.ts` witnesses that a loosening edit becomes a proposal, and
 * `criteria-decision-door.pg.spec.ts` witnesses that the owner can answer one. Between the two sits
 * a read nobody was watching: `ProjectsService.pendingWeakeningProposal`, which
 * `holdWeakeningAcceptanceEdit` consults twice — once to decide whether an arriving edit is the
 * proposal already on record, and once to decide what the new proposal SUPERSEDES.
 *
 * WHAT WENT WRONG WHEN THAT READ ONLY KNEW ABOUT SUPERSESSION
 * ----------------------------------------------------------
 * A proposal stops being pending two different ways and neither implies the other: a later edit
 * DISPLACES it, or the owner ANSWERS it. Reading only the first made a REJECTED proposal pending
 * forever, and the consequence was not theoretical. Re-making the very edit that was rejected took
 * the identical-ask branch, so no new proposal was filed and the caller was handed the rejected
 * proposal's id — an address whose one-time `commitToken` is spent, which the decision door
 * answers with `PROJECT_CRITERIA_DECISION_ALREADY_SETTLED` and nothing else. The edit was stuck
 * until somebody reworded it. A "no" to this ask has to leave it re-proposable; it is not a ban on
 * ever asking again, and the door that says no is not the door that decides what may be asked.
 *
 * WHY THE POSITIVE CONTROL IS THE WHOLE OF THIS FILE'S ARGUMENT
 * ------------------------------------------------------------
 * "The re-file produced a new proposal" is worth nothing on its own: it is also what a write path
 * with no identical-ask branch at all would produce, and that branch is a real rule this change
 * must not have deleted. So (A) makes the SAME re-file against the SAME ruler while the proposal is
 * unanswered and asserts the opposite outcome — the caller gets the proposal it already has and no
 * row is filed. (A) and (B) send byte-for-byte the same edit and read the same tables; the ONLY
 * thing that differs between them is whether one `project_criteria_decision` row exists, and this
 * file asserts that too, by `deepEqual`ing the two censuses with the decisions taken out.
 *
 * WHY THE CENSUS IS A WHOLE VALUE AND NOT A COUNT
 * ----------------------------------------------
 * Every case below pairs its claim with `census()` — the definition rows, the seal computed off
 * those same rows, and every decision row — captured before and `deepEqual`d after. A read that
 * started filing proposals correctly and also moved a criterion on the way past would pass every
 * count somebody remembered to write; it fails on the difference. The proposals themselves are
 * deliberately NOT in the census, because a new proposal appearing is the thing being witnessed.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/criteria-pending-excludes-settled.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
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

const FIRST = 'a rejected proposal stops being pending, so the same edit can be asked again';
const SECOND = 'an unanswered proposal is still the proposal on record, and is handed back';
const THIRD = 'the criterion the rejected edit drops, twice, byte for byte the same ask';
const FOURTH = 'the criterion a DIFFERENT loosening drops, so supersession has something to name';

/** Everything a re-filed proposal must not have touched, in one value. */
interface Census {
  criteria: Array<{ id: string; ordinal: number; text: string; revision: number; contentHash: string }>;
  seal: string;
  decisions: Array<{
    intentId: string; decision: string; baseSeal: string; resultingSeal: string; decidedById: string;
  }>;
}

/** One proposal as the table holds it. `commitToken` is the key the proposer never receives. */
interface Proposal {
  id: string;
  actionDigest: string;
  commitToken: string;
  baselineSeal: string;
  supersedes: { intentId: string; actionDigest: string; reason: string } | null;
}

test('a settled proposal is not pending: the same edit may be made again', {
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
      email: `pending-${ownerId}@standard-set.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'The project whose rejected asks may be asked again' },
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

  /** What the caller is told about an edit that was held, or undefined if it was applied. */
  async function held(items: Array<{ id?: string; text: string }>): Promise<{
    applied: boolean; intentId: string; actionDigest: string; baselineSeal: string;
    supersededIntentId: string | null;
  }> {
    const response = await state(items);
    const hold = response.acceptanceCriteriaHold as {
      applied: boolean; intentId: string; actionDigest: string; baselineSeal: string;
      supersededIntentId: string | null;
    } | undefined;
    assert.ok(hold, 'this edit had to be HELD — an applied one witnesses nothing about proposals');
    assert.equal(hold.applied, false, 'and a held edit says so');
    return hold;
  }

  /** The seal that stands, through the same read path the product's confirmation page uses. */
  async function seal(): Promise<string> {
    return (await acceptance.standardSetConfirmation(ownerId, projectId)).currentVersion.digest;
  }

  /** Everything a re-file must leave alone, read straight off the tables. */
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
    return { criteria, seal: await seal(), decisions };
  }

  /** Every proposal on record, oldest first — with the key the response deliberately withholds. */
  async function proposals(): Promise<Proposal[]> {
    const { rows } = await sql.query<{
      id: string; action_digest: string; commit_token: string; action: {
        baseline: { seal: string };
        supersedes: { intentId: string; actionDigest: string; reason: string } | null;
      };
    }>(
      `SELECT "id", "action_digest", "commit_token", "action"
         FROM "project_ratified_action_intent"
        WHERE "project_id" = $1::uuid AND "effect_class" = 'PROJECT_CRITERIA_WEAKENING'
        ORDER BY "created_at", "id"`, [projectId],
    );
    return rows.map((row) => ({
      id: row.id,
      actionDigest: row.action_digest,
      commitToken: row.commit_token,
      baselineSeal: row.action.baseline.seal,
      supersedes: row.action.supersedes,
    }));
  }

  /** The one proposal with this id, or a failure that says the fixture lost it. */
  function proposalNamed(all: Proposal[], id: string): Proposal {
    const row = all.find((proposal) => proposal.id === id);
    assert.ok(row, `no proposal ${id} on this project`);
    return row;
  }

  /**
   * The invariant every case shares: an id this door hands out names something answerable.
   *
   * "Answerable" is exactly one predicate — no row in `project_criteria_decision` keyed by it —
   * because that is the predicate the decision door itself refuses a second answer with. A caller
   * pointed at an id that fails this has been told its edit is on record and given an address
   * nobody, including the account owner, can act on.
   */
  async function assertAnswerable(intentId: string, what: string): Promise<void> {
    const { rows } = await sql.query<{ decision: string }>(
      `SELECT "decision" FROM "project_criteria_decision" WHERE "intent_id" = $1::uuid`, [intentId],
    );
    assert.deepEqual(rows, [], `${what}: the caller was handed a proposal already settled as `
      + `${rows[0]?.decision ?? '(none)'}, whose one-time key is spent and which the decision door `
      + 'will only ever answer with PROJECT_CRITERIA_DECISION_ALREADY_SETTLED');
  }

  /** Answer a proposal as the account owner would: no acting session, the owner's own id. */
  function decide(
    intentId: string,
    body: { commitToken: string; decision: 'APPROVE' | 'REJECT'; baseSeal: string; note?: string },
  ) {
    return projects.decideCriteriaChange(ownerId, projectId, intentId, body as never, undefined);
  }

  /** Every id in `census().criteria`, by the text it states. */
  const idOf = (rows: Census['criteria'], text: string): string => {
    const row = rows.find((criterion) => criterion.text === text);
    assert.ok(row, `the fixture must still state: ${text}`);
    return row.id;
  };

  // ── the fixture: four criteria, and the one loosening edit this whole file re-sends ───────────
  await state([{ text: FIRST }, { text: SECOND }, { text: THIRD }, { text: FOURTH }]);
  const opening = await census();
  assert.equal(opening.criteria.length, 4, 'the fixture starts with four criteria');
  assert.match(opening.seal, /^[0-9a-f]{64}$/);
  assert.deepEqual(opening.decisions, [], 'and nothing has been answered yet');

  /**
   * THE EDIT, stated once and sent three times: to file it, again in (A), and again in (B).
   * Dropping a criterion is the loosening whose direction the classifier can read without any
   * ambiguity, and re-sending the retained ids by hand is what makes the three sends byte-for-byte
   * identical: `action_digest` is taken over the request, and a request that named different ids
   * would be a different ask.
   */
  const theEdit = [FIRST, SECOND, FOURTH].map((text) => ({ id: idOf(opening.criteria, text), text }));
  /** A DIFFERENT loosening, so that supersession has an unanswered proposal to point at. */
  const anotherEdit = [FIRST, SECOND, THIRD].map((text) => ({ id: idOf(opening.criteria, text), text }));

  const firstHold = await held(theEdit);
  const first = proposalNamed(await proposals(), firstHold.intentId);
  assert.equal(first.baselineSeal, opening.seal,
    'the proposal names the standard set it was composed against');
  assert.equal(first.supersedes, null, 'and it displaced nothing: the project had no pending one');
  assert.deepEqual(await census(), opening, 'filing it moved no criterion, no seal, no decision');

  // ═══ (A) THE POSITIVE CONTROL: while it is UNANSWERED, the identical ask is handed back ═══════

  await t.test('(A) an unanswered proposal is handed back, and no second row is filed', async () => {
    const before = await census();
    const again = await held(theEdit);

    assert.equal(again.intentId, first.id,
      'the same ask against the same ruler is the proposal already on record, not a second one');
    assert.equal(again.actionDigest, firstHold.actionDigest, 'byte for byte the same request');
    assert.equal(again.baselineSeal, first.baselineSeal, 'against byte for byte the same ruler');
    assert.equal(again.supersededIntentId, null,
      're-filing it displaced nothing — a proposal is not displaced by a copy of itself');

    const filed = await proposals();
    assert.equal(filed.length, 1, 'still exactly one proposal on record');
    assert.deepEqual(filed[0], first, 'and it is the row that was filed, unrewritten');
    await assertAnswerable(again.intentId, 'the identical re-file of an unanswered proposal');
    assert.deepEqual(await census(), before, 'nothing moved');
  });

  // ═══ (B) THE SAME RE-FILE, AFTER A REJECT: a new proposal, with its own key ═══════════════════

  let secondId = '';
  await t.test('(B) once it is REJECTED, the identical edit files a NEW proposal', async () => {
    const before = await census();

    const rejected = await decide(first.id, {
      commitToken: first.commitToken,
      decision: 'REJECT',
      baseSeal: before.seal,
      note: 'not this time — which is an answer to this ask, not a ban on making it again',
    });
    assert.equal(rejected.decision, 'REJECT');
    assert.equal(rejected.applied, false, 'a REJECT applies nothing');

    // The ONE thing that differs between the read (A) made and the read this case makes. Asserted
    // as a whole value with the decisions removed, so "only the decision row changed" is a fact
    // about every column of every definition row rather than about the three this file remembered.
    const answered = await census();
    assert.deepEqual(answered.decisions, [{
      intentId: first.id,
      decision: 'REJECT',
      baseSeal: before.seal,
      resultingSeal: before.seal,
      decidedById: ownerId,
    }], 'exactly one answer, against the version it was given, by the owner');
    assert.deepEqual({ ...answered, decisions: [] }, { ...before, decisions: [] },
      'and the REJECT moved no criterion and no seal: the decision row is the whole difference '
      + 'between the state (A) re-filed against and the state this case re-files against');

    // ── the same edit, a fourth time, and now it must land as a proposal of its own ─────────────
    const refiled = await held(theEdit);
    const filed = await proposals();
    assert.equal(filed.length, 2, 'the rejected ask, made again, is a proposal of its own');

    const second = proposalNamed(filed, refiled.intentId);
    secondId = second.id;
    assert.notEqual(second.id, first.id,
      'the caller is not handed the id of the proposal that was rejected');
    assert.equal(second.actionDigest, first.actionDigest,
      'and it is the SAME ask: same criteria, same ids, same words — only the answer to the first '
      + 'one stands between them');
    assert.equal(second.baselineSeal, first.baselineSeal,
      'composed against the same ruler, because a REJECT moves no criterion');
    assert.notEqual(second.commitToken, first.commitToken,
      'with its own one-time key: the rejected proposal\'s is spent and is not reissued');
    assert.match(second.commitToken, /^[0-9a-f-]{36}$/);
    await assertAnswerable(second.id, 'the re-file of a REJECTED proposal');

    // The rejected row is exactly as it was filed. Nothing marked it settled IN PLACE, because
    // nothing can: the intent table's BEFORE UPDATE OR DELETE trigger refuses every rewrite, which
    // is why "pending" is derived from the decision row rather than from a status column.
    assert.deepEqual(proposalNamed(filed, first.id), first,
      'and the rejected proposal was not edited, only answered');

    assert.deepEqual(await census(), answered,
      'filing the new proposal moved no criterion, no seal, and answered nothing');
  });

  // ═══ (C) WHAT A NEW PROPOSAL CLAIMS TO HAVE DISPLACED ═════════════════════════════════════════

  await t.test('(C) supersedes names an unanswered proposal, or nothing at all', async () => {
    const before = await census();

    // A DIFFERENT loosening, filed while the re-proposal from (B) is pending and unanswered. It
    // goes FIRST because it is what makes this case's claim reachable: composing a new proposal is
    // the only moment `supersedes` is ever written, so a read that thinks an ANSWERED proposal is
    // still pending states its mistake here, on this row, in words.
    const thirdHold = await held(anotherEdit);
    const filed = await proposals();
    const third = proposalNamed(filed, thirdHold.intentId);

    // ── the claim, over the whole table and against the decision rows themselves ────────────────
    // Read out of `project_criteria_decision` rather than out of a list this file kept: what makes
    // a supersession false is that the proposal it names had been ANSWERED, and that is one query.
    // `criteriaWeakeningSupersessionReason` says "a later weakening edit replaced this proposal",
    // and that is not what happened to a proposal the account owner decided. It was answered, and
    // an answer is not a displacement — the two are the different ways of ceasing to be pending
    // that this whole file exists to keep apart.
    const answered = new Set((await sql.query<{ intent_id: string }>(
      `SELECT "intent_id" FROM "project_criteria_decision" WHERE "project_id" = $1::uuid`,
      [projectId],
    )).rows.map((row) => row.intent_id));
    assert.deepEqual([...answered], [first.id], 'exactly one proposal has been answered so far');
    assert.deepEqual(
      filed
        .filter((proposal) => proposal.supersedes && answered.has(proposal.supersedes.intentId))
        .map((proposal) => `${proposal.id} claims to have replaced ${proposal.supersedes?.intentId}`),
      [],
      'no proposal on this project claims to have displaced one that was already answered',
    );

    // ── the two shapes that claim is allowed to take, named one at a time ───────────────────────
    assert.ok(secondId, '(B) has to have filed the re-proposal this case reads');
    const second = proposalNamed(filed, secondId);
    assert.equal(second.supersedes, null,
      'the proposal filed straight after a REJECT displaced nothing: the rejected one had stopped '
      + 'being pending by being answered, so there was nothing left for it to take the place of');

    // The positive control for supersession itself. Without it, "supersedes is null" above would
    // hold just as well of a write path that had stopped recording supersession at all, and the
    // rule under test would be witnessed by nothing.
    assert.notEqual(third.actionDigest, second.actionDigest, 'a different ask, so a different row');
    assert.ok(third.supersedes, 'and THIS one did displace the proposal that was pending');
    assert.equal(third.supersedes.intentId, second.id,
      'namely the unanswered one, and not the one the owner rejected');
    assert.notEqual(third.supersedes.intentId, first.id);
    assert.equal(third.supersedes.actionDigest, second.actionDigest,
      'including what the displaced proposal was asking for');
    assert.match(third.supersedes.reason, /replaced this proposal/);
    assert.equal(thirdHold.supersededIntentId, second.id,
      'and the caller is told which proposal its new one took the place of');
    await assertAnswerable(third.id, 'the proposal that displaced a pending one');

    assert.deepEqual(await census(), before,
      'and none of these reads moved a criterion, the seal, or an answer on record');
  });
});
