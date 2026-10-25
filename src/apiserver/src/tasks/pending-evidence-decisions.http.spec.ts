import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { uuidToBase62 } from '@orbit/shared';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { ProjectAttributionService } from '../projects/project-attribution.service';
import { PendingEvidenceJudgmentsController } from './pending-evidence-judgments.controller';
import { TaskCompletionEvidenceController } from './task-completion-evidence.controller';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

/**
 * The two doors the rail uses, over real HTTP, with the controllers registered in the order the
 * module registers them.
 *
 * The reason this is an HTTP probe and not a unit call: `tasks/evidence-decisions/pending` lives
 * under a prefix whose neighbour is `@Get(':id')`. Whether the request reaches this handler or is
 * swallowed by a parameterised route one controller earlier is a fact about Express's matcher and
 * about declaration order — neither of which a direct `controller.pending(...)` call can see. A
 * shadowed route would 404, or worse, answer from `TasksService.get('evidence-decisions')`, and
 * both look identical to a unit test that never routed anything.
 *
 * `TasksController` is the real class for that reason, with its two dependencies stubbed. Its stub
 * RECORDS what it was asked for, so a shadowed route fails by naming the id it was handed rather
 * than by a bare status code.
 */

const OWNER_ID = randomUUID();
const TASK_ID = randomUUID();
/** The other group's row: an open question this reader is the one to clear, and which no decision
 *  can be recorded about until they do. */
const WAITING_ON_YOU_TASK_ID = randomUUID();
/** A revision waiting for this coordinator while it is paused, and one that waited and was then
 *  delivered to it — the two groups only the coordinator's own conversation is read. */
const WAITING_ON_COORDINATOR_TASK_ID = randomUUID();
const SENT_TO_COORDINATOR_TASK_ID = randomUUID();
const PROJECT_ID = randomUUID();
const SESSION_ID = randomUUID();

/** Anything `TasksController` was asked to look up. Must stay empty: the two paths below belong to
 *  the other two controllers, and a non-empty list IS the shadowing bug. */
const lookedUp: string[] = [];
/** What the shared service was asked to do, so the probe asserts about the call and not only about
 *  the status code the door returned. */
const decided: unknown[][] = [];

const evidenceService = {
  pending: async (ownerId: string, decidingSessionId: string) => ({
    readAt: new Date('2026-09-04T12:00:00.000Z'),
    decidingSessionId,
    count: 1,
    oldestAgeSeconds: 5_400,
    pending: [{
      taskId: TASK_ID,
      title: 'the derived pending queue',
      status: 'OPEN',
      projectId: null,
      criterion: { key: 'a-criterion-key', text: 'the rail is derived from the facts' },
      evidenceRevision: '2',
      submittedAt: new Date('2026-09-04T10:30:00.000Z'),
      ageSeconds: 5_400,
      claim: 'the suite passed',
      gaps: ['iOS is out of scope'],
      citations: [],
      decidability: { decidable: true, refusal: null, requiredAction: null },
      independence: { independent: ownerId === OWNER_ID, disqualification: null, requiredAction: null },
    }],
    waitingOnYou: [{
      taskId: WAITING_ON_YOU_TASK_ID,
      title: 'the SOURCE contract rebase',
      status: 'OPEN',
      projectId: null,
      criterion: null,
      evidenceRevision: '2',
      submittedAt: new Date('2026-09-04T09:00:00.000Z'),
      ageSeconds: 10_800,
      claim: '',
      gaps: [],
      citations: [],
      decidability: {
        decidable: false,
        refusal: 'this evidence quotes no project criterion, so there is no stated standard to '
          + 'decide it against',
        requiredAction: 'ASK_FOR_EVIDENCE_AGAINST_THE_CURRENT_CRITERION',
      },
      independence: { independent: ownerId === OWNER_ID, disqualification: null, requiredAction: null },
    }],
    waitingOnCoordinator: [{
      taskId: WAITING_ON_COORDINATOR_TASK_ID,
      title: 'the queue a paused coordinator gets when it is back',
      status: 'IN_PROGRESS',
      projectId: PROJECT_ID,
      criterion: { key: 'a-criterion-key', text: 'the rail is derived from the facts' },
      evidenceRevision: '1',
      submittedAt: new Date('2026-09-04T11:00:00.000Z'),
      ageSeconds: 3_600,
      claim: 'the revision waited for the coordinator',
      gaps: [],
      citations: [],
      decidability: { decidable: true, refusal: null, requiredAction: null },
      independence: { independent: true, disqualification: null, requiredAction: null },
    }],
    sentToCoordinator: [{
      taskId: SENT_TO_COORDINATOR_TASK_ID,
      title: 'the revision handed over when the coordinator came back',
      projectId: PROJECT_ID,
      evidenceRevision: '3',
      deliveredAt: new Date('2026-09-04T11:30:00.000Z'),
    }],
  }),
  decide: async (...args: unknown[]) => {
    decided.push(args);
    return { id: randomUUID(), decision: 'CONFIRM', evidenceRevision: '2' };
  },
};

@Module({
  // The registration order TasksModule declares, so the probe asks the question the module asks.
  controllers: [TasksController, PendingEvidenceJudgmentsController, TaskCompletionEvidenceController],
  providers: [
    {
      provide: TasksService,
      useValue: {
        get: async (_ownerId: string, id: string) => {
          lookedUp.push(id);
          return { id, title: 'a task nobody asked for' };
        },
      },
    },
    { provide: ProjectAttributionService, useValue: {} },
    { provide: TaskCompletionEvidenceService, useValue: evidenceService },
    JwtAuthGuard,
    Reflector,
    { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: OWNER_ID }) } },
    { provide: PrismaService, useValue: {} },
  ],
})
class RailModule {}

async function boot(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const app = await NestFactory.create(RailModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  return app.getUrl();
}

const AUTH = { authorization: 'Bearer the-signed-in-owner', 'content-type': 'application/json' };

test('GET /api/tasks/evidence-decisions/pending reaches the queue and not the task lookup',
  async (t) => {
    const base = await boot(t);

    const response = await fetch(
      `${base}/api/tasks/evidence-decisions/pending?decidingSessionId=${uuidToBase62(SESSION_ID)}`,
      { headers: AUTH },
    );
    const body = await response.json() as {
      count?: number;
      decidingSessionId?: string;
      pending?: Array<{ taskId?: string; gaps?: string[] }>;
      waitingOnYou?: Array<{ taskId?: string; decidability?: { decidable?: boolean } }>;
      waitingOnCoordinator?: Array<{ taskId?: string; projectId?: string; submittedAt?: string }>;
      sentToCoordinator?: Array<{
        taskId?: string; title?: string; projectId?: string; evidenceRevision?: string; deliveredAt?: string;
      }>;
    };

    assert.equal(response.status, 200);
    assert.deepEqual(lookedUp, [], 'the request was routed to the task lookup instead of the queue');
    assert.equal(body.count, 1);
    assert.deepEqual(body.pending?.[0].gaps, ['iOS is out of scope']);
    // Ids leave in the public spelling, so the session the browser named comes back as the session
    // it named and the task id is one the app can put in a link.
    assert.equal(body.decidingSessionId, uuidToBase62(SESSION_ID));
    assert.equal(body.pending?.[0].taskId, uuidToBase62(TASK_ID));

    // The second group crosses the same door, and its ids are keyed by the same field name — a row
    // that arrived spelled as a raw UUID would be one the browser could not put in a link or hand
    // back to the decision door, and it would have travelled that way silently.
    assert.equal(body.waitingOnYou?.length, 1);
    assert.equal(body.waitingOnYou?.[0].taskId, uuidToBase62(WAITING_ON_YOU_TASK_ID));
    assert.equal(body.waitingOnYou?.[0].decidability?.decidable, false);
    // And it is not counted into the number the rail leads with.
    assert.equal(body.count, 1);

    // The two groups the coordinator's conversation is read with cross the same door, their ids in
    // the public spelling under the same field names — the waiting card's "Decide it myself" posts
    // that task id back to the decision door, and the sent line links it — and neither is counted.
    assert.deepEqual(body.waitingOnCoordinator?.map((row) => [row.taskId, row.projectId, row.submittedAt]), [
      [uuidToBase62(WAITING_ON_COORDINATOR_TASK_ID), uuidToBase62(PROJECT_ID), '2026-09-04T11:00:00.000Z'],
    ]);
    assert.deepEqual(body.sentToCoordinator?.map((row) => [
      row.taskId, row.title, row.projectId, row.evidenceRevision, row.deliveredAt,
    ]), [[
      uuidToBase62(SENT_TO_COORDINATOR_TASK_ID),
      'the revision handed over when the coordinator came back',
      uuidToBase62(PROJECT_ID),
      '3',
      '2026-09-04T11:30:00.000Z',
    ]]);
    assert.equal(body.count, 1);
  });

test('the queue refuses to be read for nobody', async (t) => {
  const base = await boot(t);
  const response = await fetch(`${base}/api/tasks/evidence-decisions/pending`, { headers: AUTH });
  assert.equal(response.status, 400);
  assert.deepEqual(lookedUp, []);
});

test('POST /api/tasks/:taskId/evidence/decision carries the named session into the one door',
  async (t) => {
    const base = await boot(t);
    decided.length = 0;

    const response = await fetch(`${base}/api/tasks/${uuidToBase62(TASK_ID)}/evidence/decision`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        decidingSessionId: uuidToBase62(SESSION_ID),
        evidenceRevision: '2',
        decision: 'CONFIRM',
      }),
    });

    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(decided.length, 1);
    assert.equal(decided[0][0], OWNER_ID);
    assert.equal(decided[0][1], TASK_ID);
    // Both ids arrive decoded, so the browser's short spelling reaches the service as the UUID the
    // independence check and the compare-and-set are asked about. Asserted field by field rather
    // than as a whole object: what arrives is a validated DTO instance carrying an absent `note`,
    // and the claim here is about the three values that must travel, not about its constructor.
    const input = decided[0][3] as { decidingSessionId?: string; evidenceRevision?: string; decision?: string };
    assert.equal(input.decidingSessionId, SESSION_ID);
    assert.equal(input.evidenceRevision, '2');
    assert.equal(input.decision, 'CONFIRM');
  });

test('a decision that names no session is refused at the door, before the service', async (t) => {
  const base = await boot(t);
  decided.length = 0;

  const response = await fetch(`${base}/api/tasks/${uuidToBase62(TASK_ID)}/evidence/decision`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ evidenceRevision: '2', decision: 'CONFIRM' }),
  });

  // The whole point of the app's door taking the session as a field is that it is CHECKED. A
  // request that names none cannot be answered "as whoever is signed in" — there would be no run
  // to hold the independence rule against.
  assert.equal(response.status, 400);
  assert.deepEqual(decided, []);
});
