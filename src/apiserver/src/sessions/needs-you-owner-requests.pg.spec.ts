/**
 * THE NEEDS-YOU SIGNAL COUNTS OWNER REQUESTS AND WAITING TASK MOVES, ON REAL POSTGRESQL.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/needs-you-owner-requests.pg.spec.ts
 *
 * The "Waiting on you" inbox is going away (project 34vUNVEqe1OFz1uHNULOO), so the two kinds of
 * question it was the only home for are counted on the session rows instead
 * (`projects/owner-decision-signal.ts`):
 *
 *   (a) each of the four owner-request kinds, filed by a session, is counted on THAT session's row —
 *       `pendingApprovals`, `waitingKind` 'OWNER_REQUEST', `ownerRequests` and the row's word
 *       (`ownerRequestRowWord`: "Decision for you", "Key needed", "Steps for you", "Confirm for you");
 *       `needsYouSessions` includes the session, and filing tells the row at once;
 *   (b) two kinds on one row are a mix: counted, and the row keeps "Waiting for approval"
 *       (`waitingKind` null);
 *   (c) answering, declining, withdrawing and the deadline passing each take the count to zero,
 *       tell the row at once, and take the session out of `needsYouSessions`; a request from a
 *       conversation filed away is not counted;
 *   (d) a PENDING MOVE_TASK is counted on the session that asked AND on the target project's
 *       coordinator; two moves from one session into one project are one group, counted once, whose
 *       row says "Approve 2 task moves"; `needsYouSessions` includes both sessions;
 *   (e) DENIED takes one move out ("Approve task move"), APPLIED the other, and both rows go to zero
 *       and leave `needsYouSessions`; each answer tells both rows at once.
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to its own account.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { ownerRequestRowWord } from '@orbit/shared';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { readOwnerDecisionsBySession } from '../projects/owner-decision-signal';
import { ProjectHandoffService } from '../projects/project-handoff.service';
import { OwnerRequestsService } from '../owner-requests/owner-requests.service';
import { OwnerSecretsService } from '../owner-requests/owner-secrets.service';
import type { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { TasksService } from '../tasks/tasks.service';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
process.env.PROVIDER_SECRET_KEY ??= 'needs-you-owner-requests-pg-spec-key';

interface World {
  ownerId: string;
  workspaceId: string;
  projectA: string;
  projectB: string;
  coordA: string;
  coordB: string;
  /** A session of no project: where the owner requests are filed from. */
  asker: string;
}

/** What a row says, the way the clients will read it: the request words, else the generic one. */
type Row = { pendingApprovals: number; waitingKind: string | null; ownerRequests: unknown[]; taskMoves: unknown[] };
const word = (row: Row): string | null =>
  ownerRequestRowWord(row as Parameters<typeof ownerRequestRowWord>[0])
  ?? (row.pendingApprovals > 0 ? 'Waiting for approval' : null);

test('the needs-you signal counts owner requests and waiting task moves', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const { prismaClientFor } = await import('../prisma/prisma-client.js');
  const admin = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await admin.connect();
  await verifyCoordinatorPgIdentity(admin);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await admin.end().catch(() => undefined);
  });
  const db = prisma as unknown as PrismaService;

  /** Every "this row changed" the services announced, per owner. */
  const told: Array<{ ownerId: string; sessionIds: string[] }> = [];
  const realtime = new Proxy({
    publishOwnerSignalChanged: (ownerId: string, sessionIds: Iterable<string>) => {
      told.push({ ownerId, sessionIds: [...sessionIds] });
    },
  }, {
    get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined),
  }) as unknown as RealtimeService;
  const toldAbout = (sessionId: string) => told.some((entry) => entry.sessionIds.includes(sessionId));

  const push = new PushService(db, { get: () => undefined } as unknown as ConfigService);
  const pushFake = { notifyOwnerRequest: async () => undefined } as unknown as PushService;
  const requests = new OwnerRequestsService(db, new OwnerSecretsService(db), pushFake, undefined, realtime);
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(db, queue, realtime);
  const handoffs = new ProjectHandoffService(db);
  const tasks = new TasksService(prisma as never, {} as never, realtime as never, handoffs);

  async function row(w: World, sessionId: string): Promise<Row> {
    const [found] = await sessions.listRowsByIds(w.ownerId, [sessionId]);
    assert.ok(found, `session ${sessionId} is not in the list`);
    return found as unknown as Row;
  }

  async function insertTask(ownerId: string, title: string, projectId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "task" ("id","owner_id","title","status","project_id","creator_type","creator_id",
         "updated_at","completion_criterion")
       VALUES ($1,$2,$3,'OPEN',$4,'USER',$2,now(),'EVIDENCE_JUDGMENT')`,
      [id, ownerId, title, projectId],
    );
    return id;
  }

  async function seed(label: string): Promise<World> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await admin.query(
      `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,$3,'x')`,
      [ownerId, `${label}-${ownerId}@needs-you.invalid`, label],
    );
    await admin.query(
      `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","capabilities_reported_at")
       VALUES ($1,$2,$3,'ONLINE',$4,now())`,
      [runnerId, ownerId, `${label}-runner`, `${label}-${runnerId}`],
    );
    await admin.query(
      `INSERT INTO "workspace" ("id","owner_id","name","runner_id","can_create_tasks","can_delegate")
       VALUES ($1,$2,$3,$4,true,true)`,
      [workspaceId, ownerId, `${label}-agent`, runnerId],
    );
    const [projectA, projectB] = [randomUUID(), randomUUID()];
    for (const [id, name] of [[projectA, 'A'], [projectB, 'B']]) {
      await admin.query(
        `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","updated_at")
         VALUES ($1,$2,$3,true,now())`,
        [id, ownerId, `${label} project ${name}`],
      );
      await admin.query(
        `INSERT INTO "project_runtime" ("project_id","updated_at") VALUES ($1,now())
           ON CONFLICT ("project_id") DO NOTHING`,
        [id],
      );
    }
    const [coordA, coordB, asker] = [randomUUID(), randomUUID(), randomUUID()];
    for (const [id, name] of [[coordA, 'coordinator of A'], [coordB, 'coordinator of B'], [asker, 'a session']]) {
      await admin.query(
        `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id",
           "provider","status","dispatch_origin","updated_at")
         VALUES ($1,$2,$3,$4,'fixture',$2,'claude','AWAITING_INPUT'::"run_status",
           'USER'::"session_dispatch_origin",now())`,
        [id, ownerId, workspaceId, `${label}: ${name}`],
      );
    }
    for (const [project, session] of [[projectA, coordA], [projectB, coordB]]) {
      await admin.query('UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
        [project, session]);
    }
    // B states a criterion, so a move into it is a move a person can say yes to.
    const text = `${label}: what B wants`;
    await admin.query(
      `INSERT INTO "project_acceptance_criterion_definition"
         ("id","project_id","ordinal","text","verification_method","content_hash","created_at","updated_at")
       VALUES ($1,$2,1,$3,'a pg spec',$4,now(),now())`,
      [randomUUID(), projectB, text, createHash('sha256').update(text).digest('hex')],
    );
    return { ownerId, workspaceId, projectA, projectB, coordA, coordB, asker };
  }

  /** A session of no project, AWAITING_INPUT, for one case of its own. */
  async function session(w: World, title: string): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id",
         "provider","status","dispatch_origin","updated_at")
       VALUES ($1,$2,$3,$4,'fixture',$2,'claude','AWAITING_INPUT'::"run_status",
         'USER'::"session_dispatch_origin",now())`,
      [id, w.ownerId, w.workspaceId, title],
    );
    return id;
  }

  /** A SECRET request, written as the door writes it: its runner check is not what is under test. */
  async function secretRequest(w: World, sessionId: string): Promise<string> {
    const created = await prisma.ownerRequest.create({
      data: {
        ownerId: w.ownerId,
        askedBySessionId: sessionId,
        kind: 'SECRET',
        state: 'PENDING',
        title: 'The deploy key for staging',
        why: 'the deploy cannot run without it',
        secretSpec: { name: 'staging deploy key', runnerId: randomUUID(), envVar: 'STAGING_KEY' },
      },
      select: { id: true },
    });
    return created.id;
  }

  async function refusalOf(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
    try {
      await run();
    } catch (error) {
      assert.ok(error instanceof HttpException, `expected a typed refusal, got ${error}`);
      return error.getResponse() as Record<string, unknown>;
    }
    throw new assert.AssertionError({ message: 'the request was not refused' });
  }

  const w = await seed('needs-you');

  await t.test('(a) each request kind is counted on the session that asked it, in its own words', async () => {
    const cases = [
      { kind: 'DECISION', word: 'Decision for you' },
      { kind: 'SECRET', word: 'Key needed' },
      { kind: 'MANUAL_STEP', word: 'Steps for you' },
      { kind: 'CONFIRM', word: 'Confirm for you' },
    ] as const;
    for (const { kind, word: expected } of cases) {
      const asker = await session(w, `asks a ${kind}`);
      assert.equal((await row(w, asker)).pendingApprovals, 0, `${kind}: nothing waits before it is filed`);
      assert.ok(!(await push.needsYouSessions(w.ownerId)).includes(asker));
      told.length = 0;
      const id = kind === 'SECRET'
        ? await secretRequest(w, asker)
        : (await requests.file(w.ownerId, asker, {
          kind,
          title: `a ${kind} for the owner`,
          why: 'the work cannot go on without it',
          ...(kind === 'DECISION' ? { options: [{ label: 'Yes' }, { label: 'No' }] } : {}),
          ...(kind === 'MANUAL_STEP' ? { steps: [{ text: 'Rotate the key' }] } : {}),
        })).id;
      if (kind !== 'SECRET') assert.ok(toldAbout(asker), `${kind}: filing tells the asking row at once`);

      const listed = await row(w, asker);
      assert.equal(listed.pendingApprovals, 1, `${kind}: counted once`);
      assert.equal(listed.waitingKind, 'OWNER_REQUEST', `${kind}: the row names it`);
      assert.equal(listed.ownerRequests.length, 1);
      const [item] = listed.ownerRequests as Array<{ ownerRequestId: string; kind: string; title: string; since: string }>;
      assert.equal(item.ownerRequestId, id);
      assert.equal(item.kind, kind);
      assert.ok(item.title.length > 0);
      assert.ok(!Number.isNaN(Date.parse(item.since)), 'since is an instant on the wire');
      assert.deepEqual(listed.taskMoves, []);
      assert.equal(word(listed), expected, `${kind}: the row says "${expected}"`);
      assert.ok((await push.needsYouSessions(w.ownerId)).includes(asker), `${kind}: the session needs you`);
    }
  });

  await t.test('(b) two kinds on one row are a mix, and the row keeps "Waiting for approval"', async () => {
    const asker = await session(w, 'asks two kinds');
    await requests.file(w.ownerId, asker, { kind: 'DECISION', title: 'Which region?', why: 'to deploy' });
    await requests.file(w.ownerId, asker, { kind: 'CONFIRM', title: 'Deploy now?', why: 'to deploy' });
    const listed = await row(w, asker);
    assert.equal(listed.pendingApprovals, 2);
    assert.equal(listed.waitingKind, null);
    assert.equal(listed.ownerRequests.length, 2);
    assert.equal(word(listed), 'Waiting for approval');

    // Two of ONE kind are not a mix: the row says that kind's word.
    const twice = await session(w, 'asks two decisions');
    await requests.file(w.ownerId, twice, { kind: 'DECISION', title: 'Which region?', why: 'to deploy' });
    await requests.file(w.ownerId, twice, { kind: 'DECISION', title: 'Which size?', why: 'to deploy' });
    const same = await row(w, twice);
    assert.equal(same.pendingApprovals, 2);
    assert.equal(same.waitingKind, 'OWNER_REQUEST');
    assert.equal(word(same), 'Decision for you');
  });

  await t.test('(c) an answer, a decline, a withdrawal and a deadline each take the count to zero', async () => {
    const ends: Array<{ name: string; end: (asker: string, id: string) => Promise<unknown> }> = [
      { name: 'answered', end: (_asker, id) => requests.complete(w.ownerId, id, { option: 0 }) },
      { name: 'declined', end: (_asker, id) => requests.decline(w.ownerId, id, 'not this one') },
      { name: 'withdrawn', end: (asker, id) => requests.withdraw(w.ownerId, asker, id, 'no longer needed') },
      {
        name: 'past its deadline',
        end: async (asker, id) => {
          // Before the sweep reaches it: a request past its deadline cannot be answered, so it is
          // no longer counted — and then the sweep writes it EXPIRED and tells the row.
          await admin.query(
            `UPDATE "owner_request" SET "expires_at" = now() - interval '1 minute' WHERE "id" = $1::uuid`, [id]);
          assert.equal((await row(w, asker)).pendingApprovals, 0, 'not counted past its deadline, before the sweep');
          told.length = 0;
          assert.ok((await requests.expireDue(new Date())).includes(id));
        },
      },
    ];
    for (const { name, end } of ends) {
      const asker = await session(w, `a request ${name}`);
      const filed = await requests.file(w.ownerId, asker, {
        kind: 'DECISION', title: `a decision to be ${name}`, why: 'to go on', options: [{ label: 'Yes' }],
      });
      assert.equal((await row(w, asker)).pendingApprovals, 1, `${name}: counted while it waits`);
      assert.ok((await push.needsYouSessions(w.ownerId)).includes(asker));
      told.length = 0;
      await end(asker, filed.id);
      assert.ok(toldAbout(asker), `${name}: the asking row is told at once`);
      const listed = await row(w, asker);
      assert.equal(listed.pendingApprovals, 0, `${name}: the count is zero`);
      assert.equal(listed.waitingKind, null);
      assert.deepEqual(listed.ownerRequests, [], `${name}: sent as an empty list, which clears the row`);
      assert.equal(word(listed), null);
      assert.ok(!(await push.needsYouSessions(w.ownerId)).includes(asker), `${name}: no longer needs you`);
    }

    // A request from a conversation the owner filed away has no row to light.
    const filedAway = await session(w, 'filed away');
    await requests.file(w.ownerId, filedAway, { kind: 'CONFIRM', title: 'Go?', why: 'to go on' });
    await admin.query('UPDATE "session" SET "completed_at" = now() WHERE "id" = $1::uuid', [filedAway]);
    const signals = await readOwnerDecisionsBySession(prisma as never, w.ownerId, { sessionIds: [filedAway] });
    assert.equal(signals.get(filedAway), undefined);
    assert.ok(!(await push.needsYouSessions(w.ownerId)).includes(filedAway));
  });

  /** The two moves (d) asks for and (e) answers. */
  let one = '';
  let two = '';

  await t.test('(d) a waiting move is counted on the asker and on the target coordinator, one group', async () => {
    const first = await insertTask(w.ownerId, 'needs-you: the first task that belongs to B', w.projectA);
    const second = await insertTask(w.ownerId, 'needs-you: the second task that belongs to B', w.projectA);
    const ask = async (taskId: string): Promise<string> => {
      const body = await refusalOf(() => tasks.update(w.ownerId, taskId, {
        projectId: w.projectB, handoff: { reason: 'it serves B' },
      } as never, w.coordA));
      assert.equal(body.code, 'CROSS_PROJECT_APPROVAL_REQUIRED');
      return String(body.handoffId);
    };
    told.length = 0;
    one = await ask(first);
    assert.ok(toldAbout(w.coordA) && toldAbout(w.coordB), 'a filed move tells both rows at once');
    two = await ask(second);

    for (const sessionId of [w.coordA, w.coordB]) {
      const listed = await row(w, sessionId);
      assert.equal(listed.pendingApprovals, 1, 'two moves from one session into one project are one group');
      assert.equal(listed.waitingKind, 'MOVE_REQUEST');
      assert.deepEqual(listed.ownerRequests, []);
      const groups = listed.taskMoves as Array<Record<string, unknown>>;
      assert.equal(groups.length, 1);
      assert.equal(groups[0].count, 2);
      assert.equal(groups[0].requestedBySessionId, w.coordA);
      assert.equal(groups[0].fromProjectId, w.projectA);
      assert.equal(groups[0].toProjectId, w.projectB);
      assert.deepEqual(groups[0].handoffIds, [one, two]);
      assert.equal(groups[0].title, 'needs-you: the first task that belongs to B');
      assert.ok(!Number.isNaN(Date.parse(String(groups[0].since))));
      assert.equal(word(listed), 'Approve 2 task moves');
    }
    const needsYou = await push.needsYouSessions(w.ownerId);
    assert.ok(needsYou.includes(w.coordA), 'the asking session needs you');
    assert.ok(needsYou.includes(w.coordB), 'the target coordinator needs you');
  });

  await t.test('(e) DENIED and APPLIED take the moves out, on both rows at once', async () => {
    told.length = 0;
    await handoffs.decide(w.ownerId, w.ownerId, one, 'DENY', new Date());
    assert.ok(toldAbout(w.coordA) && toldAbout(w.coordB), 'a no tells both rows at once');
    for (const sessionId of [w.coordA, w.coordB]) {
      const listed = await row(w, sessionId);
      assert.equal(listed.pendingApprovals, 1);
      assert.equal(listed.waitingKind, 'MOVE_REQUEST');
      assert.equal(word(listed), 'Approve task move', 'one move left, said in the singular');
    }

    told.length = 0;
    const answer = await handoffs.decide(w.ownerId, w.ownerId, two, 'APPROVE', new Date(), { kind: 'LOGIN' });
    assert.equal(answer.row.state, 'APPLIED');
    assert.ok(toldAbout(w.coordA) && toldAbout(w.coordB), 'a yes tells both rows at once');
    for (const sessionId of [w.coordA, w.coordB]) {
      const listed = await row(w, sessionId);
      assert.equal(listed.pendingApprovals, 0, 'nothing waits once every move is answered');
      assert.equal(listed.waitingKind, null);
      assert.deepEqual(listed.taskMoves, [], 'sent as an empty list, which clears the row');
      assert.equal(word(listed), null);
    }
    const after = await push.needsYouSessions(w.ownerId);
    assert.ok(!after.includes(w.coordA));
    assert.ok(!after.includes(w.coordB));
  });
});
