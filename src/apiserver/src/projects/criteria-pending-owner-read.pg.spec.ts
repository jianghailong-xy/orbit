/**
 * THE KEY LEAVES THE DATABASE ON ONE ROUTE, AND THAT ROUTE IS THE ACCOUNT OWNER'S.
 *
 * `criteria-pending-decisions.pg.spec.ts` witnesses the derived read — which proposals are still a
 * question, and why each one is or is not decidable. `criteria-decision-door.pg.spec.ts` witnesses
 * the door that answers one, and that it takes two keys. Between them was a hole with nothing in
 * it: the browser had no way to ASK, and no way to be given the second key even if it had. The
 * card `src/web` renders (`CriteriaDecisionCard`, `pendingCriteriaDecisionsQuery`) reads
 * `GET /projects/:id/acceptance/criteria-decisions/pending` and puts `row.commitToken` in the body
 * it posts back. Until that route existed the card was permanently empty.
 *
 * WHY THIS GOES OVER REAL HTTP AND OVER A REAL POSTGRESQL
 * ------------------------------------------------------
 * Both halves are load-bearing and neither can stand in for the other.
 *
 *   * HTTP, because the claim is about a WIRE. `commitToken` is a `uuid` column compared byte for
 *     byte by the door, and it is in `NEVER_PUBLIC_ID_FIELDS` precisely so that
 *     `PublicIdInterceptor` does not re-spell it on the way out; `intentId` is in the other set and
 *     IS re-spelled. A unit call on the service sees neither fact. What settles it is taking the
 *     token out of one response and posting it into another, which case (5) does.
 *   * PostgreSQL, because every row this read derives from is one the write path wrote under
 *     triggers this spec does not get to fake: `content_hash` and `revision` come from the
 *     definition's BEFORE trigger, and `project_ratified_action_intent` is immutable by a trigger
 *     of its own — which is exactly why "pending" has to be derived rather than stored, and why a
 *     fake store would be testing the fake.
 *
 * WHAT EACH CASE IS FOR
 * ---------------------
 *   (1) is the paired negative for (2): the same GET, against the same project, before any
 *       proposal exists. Without it "the proposal reads out" is also what a reader that returns
 *       everything would say.
 *   (2) the owner's read carries the key, and every field name the card reads, with `intentId` in
 *       the spelling the door takes back.
 *   (3) THE KEY DOES NOT LEAVE BY THE OTHER PATH. Two facts over the SAME rows, so the only thing
 *       that differs between them is which read was called: the delivery shape
 *       (`readPendingCriteriaDecisions`, what `coordinator-delivery.service.ts` composes an agent's
 *       card from) contains the token nowhere, and the owner's read of the same moment does.
 *   (4) and a read made WITH an acting session is refused outright, with the door's own code —
 *       because handing over the key is handing over the decision, so it is one rule, not two.
 *   (5) a proposal a later one displaced is gone, and the survivor names it in the SAME spelling
 *       this read gave it — the comparison `criteriaDecisionStanding` makes to decide whether a
 *       card is SUPERSEDED or merely ALREADY_SETTLED.
 *   (6) a proposal that was answered is gone, and it was answered with the key this read handed
 *       over. That is what makes (2) a claim about a usable key rather than about a string.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/criteria-pending-owner-read.pg.spec.ts
 *
 * Not destructive: the case owns freshly generated ids and asserts over its own project.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { PrismaClient } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { readPendingCriteriaDecisions } from './criteria-pending-decisions';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectHandoffService } from './project-handoff.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { SessionAttemptService } from './session-attempt.service';
import { TaskCheckpointService } from './task-checkpoint.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** How the criteria say they are to be judged. Restated byte for byte by every edit below. */
const METHOD = 'A person reads the criterion and says whether it holds';

const FIRST = 'the owner is handed the key on their own read and nowhere else';
const SECOND = 'the criterion the first loosening edit drops';
const THIRD = 'the criterion the second loosening edit drops, so supersession has something to name';

/**
 * The service door as this spec calls it — declared here rather than imported.
 *
 * That is deliberate and it is what makes the negative control a RED. Run against the tree before
 * this task's change, a file that IMPORTED a method which does not exist yet would not compile,
 * and a compile error is not evidence that a rule is missing. Declared structurally, the same file
 * compiles either way: on the old tree the property is `undefined` and case (4) fails saying so, on
 * the new one it is the method and case (4) tests the rule.
 */
type OwnerPendingRead = {
  pendingCriteriaDecisions?: (
    ownerId: string,
    projectId: string,
    actingSessionId?: string,
  ) => Promise<{ pending: Array<Record<string, unknown>> }>;
};

/** One criterion as a held proposal's `action.request` states it. */
interface ProposedCriterion {
  id: string | null;
  text: string;
  verificationMethod: string;
}

/** A response, kept as text as well as JSON: a body that failed to parse has to be readable. */
type Sent = { status: number; body: string; json: Record<string, unknown> };

/** Everything a REFUSED read must have left exactly as it was. */
interface Census {
  criteria: Array<{ id: string; ordinal: number; text: string; revision: number }>;
  intents: Array<{ id: string; digest: string }>;
  decisions: Array<{ intentId: string; decision: string }>;
}

test('the owner’s pending-decision read: over HTTP, with the key, and only there', {
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
      email: `owner-read-${ownerId}@standard-set.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'The project whose keys only its owner is handed' },
  });

  // ── the app, with the real controller, the real service and the real interceptor ─────────────
  // Only the three collaborators this route never reaches are stubbed, and they are stubbed to
  // THROW: a probe that answered them quietly would let a shadowed route pass as a green.
  const refuse = (name: string) => () => {
    throw new Error(`${name} must not be reached by this probe`);
  };
  @Module({
    controllers: [ProjectsController],
    providers: [
      { provide: ProjectsService, useValue: projects },
      { provide: ProjectAcceptanceService, useValue: acceptance },
      { provide: ProjectHandoffService, useValue: { listForProject: refuse('handoffs') } },
      { provide: SessionAttemptService, useValue: { describe: refuse('attempts') } },
      { provide: TaskCheckpointService, useValue: { record: refuse('checkpoints') } },
      JwtAuthGuard,
      Reflector,
      { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: ownerId }) } },
      { provide: PrismaService, useValue: prisma },
    ],
  })
  class OwnerReadModule {}

  const app = await NestFactory.create(OwnerReadModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  // The one main.ts installs. Without it this spec would be asserting over a body no client ever
  // receives — which is the whole of what cases (2) and (5) are about.
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  /** The project as its owner addresses it: base62, the way every client spells an id. */
  const projectPublicId = uuidToBase62(projectId);

  async function send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Sent> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: 'Bearer the-account-owner',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* asserted on below */ }
    return { status: response.status, body: text, json };
  }

  /** The route this task exists to add, as a browser reaches it. */
  const readPending = () =>
    send('GET', `/api/projects/${projectPublicId}/acceptance/criteria-decisions/pending`);

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

  /** Every criterion on record, by the text it states. */
  async function stated(): Promise<Array<{ id: string; ordinal: number; text: string; revision: number }>> {
    const { rows } = await sql.query<{ id: string; ordinal: number; text: string; revision: number }>(
      `SELECT "id", "ordinal", "text", "revision"
         FROM "project_acceptance_criterion_definition"
        WHERE "project_id" = $1::uuid ORDER BY "ordinal"`, [projectId],
    );
    return rows;
  }

  async function census(): Promise<Census> {
    const intents = (await sql.query<{ id: string; action_digest: string }>(
      `SELECT "id", "action_digest" FROM "project_ratified_action_intent"
        WHERE "project_id" = $1::uuid ORDER BY "created_at", "id"`, [projectId],
    )).rows.map((row) => ({ id: row.id, digest: row.action_digest }));
    const decisions = (await sql.query<{ intent_id: string; decision: string }>(
      `SELECT "intent_id", "decision" FROM "project_criteria_decision"
        WHERE "project_id" = $1::uuid ORDER BY "decided_at", "intent_id"`, [projectId],
    )).rows.map((row) => ({ intentId: row.intent_id, decision: row.decision }));
    return { criteria: await stated(), intents, decisions };
  }

  /** The newest proposal as the TABLE holds it, keys and all — the owner's own vantage point. */
  async function newestProposal(): Promise<{
    id: string; commitToken: string; baselineSeal: string; proposed: ProposedCriterion[];
  }> {
    const { rows } = await sql.query<{
      id: string; commit_token: string;
      action: { request: { proposed: ProposedCriterion[] }; baseline: { seal: string } };
    }>(
      `SELECT "id", "commit_token", "action" FROM "project_ratified_action_intent"
        WHERE "project_id" = $1::uuid ORDER BY "created_at" DESC, "id" DESC LIMIT 1`, [projectId],
    );
    assert.equal(rows.length, 1, 'the edit under test has to have filed a proposal');
    const [row] = rows;
    return {
      id: row.id,
      commitToken: row.commit_token,
      baselineSeal: row.action.baseline.seal,
      proposed: row.action.request.proposed,
    };
  }

  const idOf = (rows: Awaited<ReturnType<typeof stated>>, text: string): string => {
    const row = rows.find((criterion) => criterion.text === text);
    assert.ok(row, `the fixture must still state: ${text}`);
    return row.id;
  };

  const queueOf = (answer: Sent) => ({
    count: answer.json.count as number,
    decidableCount: answer.json.decidableCount as number,
    oldestAgeSeconds: answer.json.oldestAgeSeconds as number | null,
    pending: (answer.json.pending ?? []) as Array<Record<string, unknown>>,
  });

  // Three criteria, so that two DIFFERENT loosening edits exist to be made.
  await state([{ text: FIRST }, { text: SECOND }, { text: THIRD }]);

  await t.test('(1) with nothing proposed, the owner’s read is empty rather than absent',
    async () => {
      const answer = await readPending();
      assert.equal(answer.status, 200,
        `the route must exist and answer the owner — got ${answer.status}: ${answer.body}`);
      const queue = queueOf(answer);
      assert.deepEqual(queue.pending, [], 'nothing has been proposed yet');
      assert.equal(queue.count, 0);
      assert.equal(queue.decidableCount, 0);
      assert.equal(queue.oldestAgeSeconds, null, 'there is no oldest when there is none');
      assert.equal(answer.json.projectId, projectPublicId,
        'the queue names the project it is about, in the spelling the caller asked with');
      assert.equal(typeof answer.json.readAt, 'string', 'the read stamps itself');
    });

  let firstProposalId = '';
  let firstProposalPublicId = '';

  await t.test('(2) a held proposal reads out with its key, and every field the card reads',
    async () => {
      const before = await stated();
      await state([{ id: idOf(before, FIRST), text: FIRST }, { id: idOf(before, THIRD), text: THIRD }]);
      const filed = await newestProposal();
      firstProposalId = filed.id;
      firstProposalPublicId = uuidToBase62(filed.id);

      const answer = await readPending();
      assert.equal(answer.status, 200, `read answered ${answer.status}: ${answer.body}`);
      const queue = queueOf(answer);
      assert.equal(queue.count, 1, 'exactly the proposal the edit above filed');
      assert.equal(queue.decidableCount, 1, 'nothing has moved the ruler under it');
      assert.equal(typeof queue.oldestAgeSeconds, 'number');
      const [row] = queue.pending;

      // THE KEY. Byte for byte what the column holds — not re-spelled by the interceptor, which
      // is the whole reason `commitToken` is classified NEVER_PUBLIC_ID_FIELDS.
      assert.equal(row.commitToken, filed.commitToken,
        'the owner’s read is where the second key leaves the database');
      // THE ADDRESS, in the other spelling — the one `PublicIdPipe` decodes when it comes back.
      assert.equal(row.intentId, firstProposalPublicId,
        'the id is public-id spelled, so posting it back to the door resolves');
      assert.notEqual(row.intentId, row.commitToken, 'the address is not the key');

      // Every name `PendingCriteriaDecisionRow` declares in src/web, so a rename here is a red
      // here rather than an empty card in a browser.
      assert.deepEqual(
        Object.keys(row).filter((key) => !key.endsWith('PublicId')).sort(),
        ['actionDigest', 'ageSeconds', 'baselineSeal', 'commitToken', 'currentSeal', 'decidability',
          'diff', 'filedAt', 'intentId', 'projectId', 'proposed', 'supersededIntentId'].sort(),
      );
      assert.equal(row.projectId, projectPublicId);
      assert.equal(row.baselineSeal, filed.baselineSeal);
      assert.equal(row.currentSeal, filed.baselineSeal, 'nothing moved between filing and reading');
      assert.equal(row.supersededIntentId, null, 'it displaced nothing');
      assert.deepEqual(row.decidability, { decidable: true, refusal: null, requiredAction: null });
      assert.deepEqual(
        (row.proposed as ProposedCriterion[]).map((criterion) => criterion.text),
        filed.proposed.map((criterion) => criterion.text),
        'the diff the owner judges is the one the request stated',
      );
      // THE DIFF, over the same boundary. The card renders this and not `proposed`, so a
      // criterion the request restated word for word has to come back marked SAME here, and the
      // one it drops has to be here at all — `proposed` cannot carry a criterion it omits.
      const diff = row.diff as {
        entries: Array<{ change: string; definitionId: string | null; ordinal: number }>;
        sameCount: number; changedCount: number; newCount: number; removedCount: number;
      };
      assert.deepEqual(
        [diff.sameCount, diff.changedCount, diff.newCount, diff.removedCount], [2, 0, 0, 1],
        'this edit drops one of three criteria and restates the other two unchanged',
      );
      assert.deepEqual(diff.entries.map((entry) => entry.change), ['SAME', 'SAME', 'REMOVED']);
      // Public-id spelled, like every other address on this response — and the SAME spelling
      // `proposed[].id` arrives in, because a reader that compared the two would otherwise never
      // match a single row.
      assert.deepEqual(
        diff.entries.slice(0, 2).map((entry) => entry.definitionId),
        (row.proposed as ProposedCriterion[]).map((criterion) => criterion.id),
        'the definition an entry names is spelled the way the proposal names it',
      );
      for (const entry of diff.entries) {
        assert.notEqual(entry.definitionId, null);
        assert.doesNotMatch(entry.definitionId!, /^[0-9a-f]{8}-[0-9a-f]{4}-/u,
          'a raw uuid here would be the one address on this card nobody could hand back');
      }

      // And the edit really was HELD: the criterion it drops is still stated.
      assert.deepEqual((await stated()).map((criterion) => criterion.text),
        [FIRST, SECOND, THIRD], 'a loosening edit changes nothing until it is answered');
    });

  await t.test('(3) the delivery shape carries no key; the owner’s read of the same rows does',
    async () => {
      // What an agent is shown: `coordinator-delivery.service.ts` composes the coordinator's card
      // from exactly this call.
      const delivered = await readPendingCriteriaDecisions(prisma, ownerId, projectId);
      assert.equal(delivered.pending.length, 1, 'the same one proposal, read the other way');
      assert.equal(delivered.pending[0].intentId, firstProposalId,
        'the two reads are about the same row — that is what makes the next line a comparison');
      const token = (await newestProposal()).commitToken;
      assert.ok(token.length > 0);
      assert.ok(!JSON.stringify(delivered).includes(token),
        'the key must appear nowhere in what the proposing side is shown');

      // The positive half, over the same rows in the same moment: it IS on the owner's path. A
      // "the token is absent" assertion on its own is also what a read returning nothing would
      // satisfy.
      const owned = await readPending();
      assert.ok(owned.body.includes(token),
        'the owner’s read of the same proposal carries the key the delivery does not');
    });

  await t.test('(4) the same read made with an acting session is refused, and writes nothing',
    async () => {
      const before = await census();
      const read = (projects as unknown as OwnerPendingRead).pendingCriteriaDecisions;
      assert.equal(typeof read, 'function',
        'ProjectsService must expose the owner read this route is on');
      const refused = await read!.call(projects, ownerId, projectId, randomUUID())
        .then(() => null, (error: unknown) => error);
      assert.ok(refused, 'a read carrying an acting session must not answer with the keys');
      const body = (refused as { getResponse?: () => unknown; getStatus?: () => number });
      assert.equal(typeof body.getStatus, 'function',
        `expected a typed HttpException, got ${String(refused)}`);
      assert.equal(body.getStatus!(), 403);
      const payload = body.getResponse!() as Record<string, unknown>;
      assert.equal(payload.code, 'PROJECT_CRITERIA_DECISION_OWNER_CHANNEL_ONLY',
        'one rule with one code: reading the key IS being able to decide');
      assert.equal(payload.requiredAction, 'ASK_A_PERSON');
      const token = (await newestProposal()).commitToken;
      assert.ok(!JSON.stringify(payload).includes(token), 'a refusal does not leak what it refused');
      assert.deepEqual(await census(), before, 'a refused read leaves every row exactly as it was');
    });

  await t.test('(5) a displaced proposal is gone, and the survivor names it in the same spelling',
    async () => {
      const before = await stated();
      // A DIFFERENT loosening: drop THIRD instead of SECOND, so this is a new ask rather than the
      // identical one, and it supersedes the proposal on record.
      await state([{ id: idOf(before, FIRST), text: FIRST }, { id: idOf(before, SECOND), text: SECOND }]);
      const later = await newestProposal();
      assert.notEqual(later.id, firstProposalId, 'the second edit filed a proposal of its own');

      const queue = queueOf(await readPending());
      assert.equal(queue.count, 1, 'one question at a time: the displaced one is not still asked');
      const [row] = queue.pending;
      assert.equal(row.intentId, uuidToBase62(later.id), 'the survivor is the newer proposal');
      assert.ok(!queue.pending.some((pending) => pending.intentId === firstProposalPublicId),
        'the displaced proposal is not in the queue');
      // The comparison `criteriaDecisionStanding` makes: it finds the card's replacement by
      // matching `supersededIntentId` against the `intentId` this same read published. Spelled
      // two different ways, that match never fires and a superseded card renders as an answered
      // one — which is why this is asserted on the WIRE and not on the derivation.
      assert.equal(row.supersededIntentId, firstProposalPublicId,
        'the survivor names the displaced proposal by the id this read gave it');
      assert.equal(row.commitToken, later.commitToken, 'and it carries its own key, not the old one');
    });

  await t.test('(6) the key this read handed over answers the door, and then the proposal is gone',
    async () => {
      const queue = queueOf(await readPending());
      assert.equal(queue.count, 1);
      const [row] = queue.pending;

      // Everything posted here came out of the read above — the address, the key, and the seal.
      // That is the claim: a browser holding this response can answer, with nothing else.
      const decided = await send(
        'POST',
        `/api/projects/${projectPublicId}/acceptance/criteria-decisions/${row.intentId as string}`,
        { commitToken: row.commitToken, decision: 'APPROVE', baseSeal: row.currentSeal },
      );
      assert.equal(decided.status, 201, `the door answered ${decided.status}: ${decided.body}`);
      assert.equal(decided.json.applied, true, 'an APPROVE applies the edit that was held');

      const after = queueOf(await readPending());
      assert.deepEqual(after.pending, [], 'an answered question is not a question');
      assert.equal(after.count, 0);
      assert.equal(after.decidableCount, 0);
      assert.equal(after.oldestAgeSeconds, null);
      // And the edit landed, so "gone from the queue" is not "the fixture stopped working".
      assert.deepEqual((await stated()).map((criterion) => criterion.text), [FIRST, SECOND]);
    });
});
