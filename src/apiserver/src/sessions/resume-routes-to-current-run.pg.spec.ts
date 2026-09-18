import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  CreatorType,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
} from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from './sessions.service';

/**
 * A message sent into a run the task has already replaced, against a real PostgreSQL.
 *
 * 2026-09-18 01:18 UTC: a run failed on `anthropic-2` with a 429, the auto-run re-dispatch started
 * the next one on `deepseek` two seconds later, and the person still looking at the failed run
 * typed a message into it. `session_task_execution_claim_idx` refused the revive — correctly, one
 * live Session per task — and the platform's whole answer was a 409 with an English sentence in it.
 * The message was never delivered anywhere. What was missing is not the wording: it is that nobody
 * ROUTED the message to the run that is actually doing the task.
 *
 * These cases pin both halves of that routing, and the three rules it may not break:
 *
 *   1. a run's provider is fixed for its lifetime — a switch is "stop this one, continue on the
 *      other", never a provider rewritten under something that is running;
 *   2. stopping a run that is going is destructive, so nothing is stopped without an explicit
 *      act by the person: the provider they chose AND a confirmation that names the run;
 *   3. "the task's current run" is `session_task_execution_claim_idx`'s own predicate — the four
 *      statuses, no invented ordering.
 *
 * Driven through `SessionsService.resume`, which is what `POST /api/sessions/:id/resume` calls, so
 * what is asserted here is the answer a client actually gets.
 *
 * Destructive: it seeds and contends rows, so it runs only against the disposable servers
 * `scripts/run-pg-spec.sh` and `scripts/project-pg-matrix.sh` provision.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails and provider slugs are unique, and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

interface Fixture {
  ownerId: string;
  taskId: string;
  /** The run the person is looking at: ended, replaced, still on screen. */
  replaced: string;
  /** The run that holds the task's execution claim. */
  holder: string;
  /** A configured provider on the SAME runtime as the holder (claude ↔ deepseek). */
  sameRuntime: string;
  /** A configured provider that borrows the codex runtime. */
  crossRuntime: string;
}

interface Services {
  db: PrismaClient;
  sessions: SessionsService;
}

function connect(): Services {
  const db = prismaClientFor(URL!);
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  return {
    db,
    sessions: new SessionsService(
      db as unknown as PrismaService,
      { notifySessionQueued: () => undefined } as unknown as QueueService,
      publishes,
    ),
  };
}

async function fixture(
  db: PrismaClient,
  label: string,
  holderStatus: RunStatus,
): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  const replaced = randomUUID();
  const holder = randomUUID();
  const sameRuntime = `deepseek-${label}-${RUN}`;
  const crossRuntime = `openai-${label}-${RUN}`;
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${RUN}-${ownerId}@routing.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      lastHeartbeatAt: new Date(),
      capabilities: [],
      capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-agent`, enabled: true },
  });
  await db.task.create({
    data: {
      id: taskId,
      ownerId,
      assigneeId: workspaceId,
      title: `${label} task`,
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
    },
  });
  // Two configured identities, told apart by the runtime they BORROW rather than by being
  // configured: `deepseek` drives the claude CLI, so a claude session may move onto it; the other
  // drives codex, so it may not. A check that only asked "is it a configured row?" would pass both.
  await db.modelProvider.create({
    data: {
      slug: sameRuntime, label: sameRuntime, runtime: 'claude', ownerId,
      baseUrl: 'https://api.deepseek.test', apiKeyEnc: 'iv:tag:ct', enabled: true,
    },
  });
  await db.modelProvider.create({
    data: {
      slug: crossRuntime, label: crossRuntime, runtime: 'codex', ownerId,
      baseUrl: 'https://api.openai.test', apiKeyEnc: 'iv:tag:ct', enabled: true,
    },
  });
  const common = {
    ownerId,
    creatorId: ownerId,
    taskId,
    workspaceId,
    assignedRunnerId: runnerId,
    prompt: label,
    provider: 'claude',
    providerBuiltin: true,
    dispatchOrigin: SessionDispatchOrigin.USER,
    startsTaskWork: true,
    numTurns: 1,
    engineTurnActive: false,
    runtimeSessionId: randomUUID(),
    // A run that actually ran: `resumeBlocked('NEVER_STARTED')` is ahead of everything this file
    // is about, and a fixture that stopped there would prove nothing about the claim.
    startedAt: new Date(),
  };
  await db.session.create({
    data: {
      ...common,
      id: replaced,
      title: `${label}-replaced`,
      status: RunStatus.FAILED,
      finishedAt: new Date(),
    },
  });
  await db.session.create({
    data: { ...common, id: holder, title: `${label}-holder`, status: holderStatus },
  });
  return { ownerId, taskId, replaced, holder, sameRuntime, crossRuntime };
}

const message = (extra: Record<string, unknown> = {}) => ({
  clientTurnId: randomUUID(),
  content: 'carry on with the task',
  ...extra,
});

/** Where this exact message ended up, by the key that makes a send idempotent. */
async function turnsFor(db: PrismaClient, clientTurnId: string): Promise<string[]> {
  const rows = await db.conversationTurn.findMany({
    where: { clientTurnId }, select: { sessionId: true },
  });
  return rows.map((r) => r.sessionId);
}

async function sessionRow(db: PrismaClient, id: string) {
  return db.session.findUniqueOrThrow({
    where: { id },
    select: { status: true, provider: true, providerBuiltin: true, cancelRequestedAt: true },
  });
}

const body = (error: unknown): Record<string, unknown> =>
  (error as ConflictException).getResponse() as Record<string, unknown>;

test('a message to a replaced run lands on the run that holds the claim, and says which',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const { db, sessions } = connect();
    try {
      const f = await fixture(db, 'routes', RunStatus.RUNNING);
      const dto = message();

      const answer = await sessions.resume(f.ownerId, f.replaced, dto as never, {
        routeToCurrentRun: true,
      }) as { routedToSessionId?: string; turnId?: string };

      // The one thing the client could not work out for itself: where the message went, in the
      // spelling it can hand back to `session_get`.
      assert.equal(answer.routedToSessionId, uuidToBase62(f.holder),
        'the answer must name the run the message was routed to');
      assert.deepEqual(await turnsFor(db, dto.clientTurnId), [f.holder],
        'the turn belongs to the run that holds the claim, and to nothing else');

      const replaced = await sessionRow(db, f.replaced);
      assert.equal(replaced.status, RunStatus.FAILED, 'the replaced run is not revived behind this');
      const holder = await sessionRow(db, f.holder);
      assert.equal(holder.status, RunStatus.RUNNING);
      // Rule 2, in the case nobody asked for anything: a message with no provider in it is not an
      // instruction to stop what is going.
      assert.equal(holder.cancelRequestedAt, null, 'nothing authorised stopping the run that is going');
    } finally {
      await db.$disconnect();
    }
  });

test('naming the provider the current run is already on is not a switch',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const { db, sessions } = connect();
    try {
      const f = await fixture(db, 'same-provider', RunStatus.RUNNING);
      const dto = message({ provider: 'claude' });

      const answer = await sessions.resume(f.ownerId, f.replaced, dto as never, {
        routeToCurrentRun: true,
      }) as { routedToSessionId?: string };

      assert.equal(answer.routedToSessionId, uuidToBase62(f.holder));
      assert.deepEqual(await turnsFor(db, dto.clientTurnId), [f.holder]);
      const holder = await sessionRow(db, f.holder);
      assert.equal(holder.cancelRequestedAt, null,
        'the provider they chose is the one already running: there is nothing to stop');
      assert.equal(holder.status, RunStatus.RUNNING);
    } finally {
      await db.$disconnect();
    }
  });

test('another provider asks for a confirmation, structurally, before anything is stopped',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const { db, sessions } = connect();
    try {
      const f = await fixture(db, 'confirm', RunStatus.PENDING);
      const dto = message({ provider: f.sameRuntime });

      await assert.rejects(
        () => sessions.resume(f.ownerId, f.replaced, dto as never, { routeToCurrentRun: true }),
        (error: unknown) => {
          assert.ok(error instanceof ConflictException, 'a structured answer, not a 500');
          const payload = body(error);
          assert.equal(payload.code, 'TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED');
          // The point of the case: "this needs confirming" is a FIELD, and what to send back to
          // confirm it is a field too. A client that had to read the English sentence to find out
          // it was being asked a question has no protocol at all.
          assert.equal(payload.confirmationRequired, true);
          assert.deepEqual(payload.confirm, {
            field: 'stopSessionId', value: uuidToBase62(f.holder),
          });
          assert.equal(payload.runningProvider, 'claude');
          assert.equal(payload.requestedProvider, f.sameRuntime);
          assert.equal(payload.conflictingSessionId, uuidToBase62(f.holder));
          assert.equal(payload.conflictingSessionStatus, RunStatus.PENDING);
          assert.equal(payload.taskId, uuidToBase62(f.taskId));
          assert.equal(payload.retryable, false, 'repeating it unchanged would ask the same question');
          return true;
        },
      );

      const holder = await sessionRow(db, f.holder);
      assert.equal(holder.cancelRequestedAt, null, 'an unconfirmed ask stops nothing');
      assert.equal(holder.status, RunStatus.PENDING);
      assert.equal(holder.provider, 'claude', 'and it certainly does not move a running provider');
      assert.deepEqual(await turnsFor(db, dto.clientTurnId), [],
        'nothing was delivered on a question that has not been answered');
    } finally {
      await db.$disconnect();
    }
  });

test('the confirmed switch stops the current run and continues this message on the chosen provider',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const { db, sessions } = connect();
    try {
      const f = await fixture(db, 'switch', RunStatus.PENDING);
      const dto = message({ provider: f.sameRuntime, stopSessionId: f.holder });

      const answer = await sessions.resume(f.ownerId, f.replaced, dto as never, {
        routeToCurrentRun: true,
      }) as { revived?: boolean };

      assert.equal(answer.revived, true, 'this message opened a round of its own');
      const holder = await sessionRow(db, f.holder);
      assert.ok(holder.cancelRequestedAt, 'the run that was going has been stopped');
      assert.equal(holder.status, RunStatus.CANCELLED);
      assert.equal(holder.provider, 'claude',
        'stopped, not rewritten: a run keeps the provider it ran on');

      const continued = await sessionRow(db, f.replaced);
      assert.equal(continued.provider, f.sameRuntime, 'the round continuing is on the chosen provider');
      assert.equal(continued.providerBuiltin, false);
      assert.equal(continued.status, RunStatus.PENDING, 'and it is live again');
      assert.deepEqual(await turnsFor(db, dto.clientTurnId), [f.replaced],
        'the message is the opening of that round');
    } finally {
      await db.$disconnect();
    }
  });

test('a run that has to wind down keeps the message honest: the stop lands, the delivery follows',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const { db, sessions } = connect();
    try {
      // RUNNING, not PENDING: this one has a runtime process, so the stop is a request its runner
      // has to carry out. The claim is not free the instant it is asked for.
      const f = await fixture(db, 'winding-down', RunStatus.RUNNING);
      const dto = message({ provider: f.sameRuntime, stopSessionId: f.holder });

      await assert.rejects(
        () => sessions.resume(f.ownerId, f.replaced, dto as never, { routeToCurrentRun: true }),
        (error: unknown) => {
          assert.ok(error instanceof ConflictException);
          const payload = body(error);
          assert.equal(payload.code, 'TASK_ALREADY_RUNNING');
          // Structural, because "it is on its way out, ask again" and "somebody else's run is in
          // the way, wait for it" are different things to show a person and only differed in the
          // English before this.
          assert.equal(payload.conflictingSessionEnding, true);
          assert.equal(payload.retryable, true);
          return true;
        },
      );
      const stopping = await sessionRow(db, f.holder);
      assert.ok(stopping.cancelRequestedAt, 'the stop they authorised was taken');
      assert.deepEqual(await turnsFor(db, dto.clientTurnId), [],
        'and the message was not quietly delivered onto the provider they did not choose');

      // What the runner does when it has finished winding the process down.
      await db.session.update({
        where: { id: f.holder },
        data: { status: RunStatus.CANCELLED, finishedAt: new Date() },
      });

      const answer = await sessions.resume(f.ownerId, f.replaced, dto as never, {
        routeToCurrentRun: true,
      }) as { revived?: boolean };
      assert.equal(answer.revived, true);
      assert.equal((await sessionRow(db, f.replaced)).provider, f.sameRuntime);
      assert.deepEqual(await turnsFor(db, dto.clientTurnId), [f.replaced],
        'the same message, the same key, delivered once the claim was free');
    } finally {
      await db.$disconnect();
    }
  });

test('a provider on another runtime is refused, and nothing is stopped for it',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const { db, sessions } = connect();
    try {
      const f = await fixture(db, 'cross-runtime', RunStatus.PENDING);
      // Configured exactly like the one the switch above allows — same kind of row, same owner —
      // and different in the only way that decides it: the runtime it borrows. A check that read
      // "configured provider" instead of "which CLI runs it" would stop a run for this.
      const dto = message({ provider: f.crossRuntime, stopSessionId: f.holder });

      await assert.rejects(
        () => sessions.resume(f.ownerId, f.replaced, dto as never, { routeToCurrentRun: true }),
        (error: unknown) => {
          assert.ok(error instanceof BadRequestException, 'not a conflict: this cannot be confirmed');
          assert.match(String((error as Error).message), /runs on codex/);
          return true;
        },
      );

      const holder = await sessionRow(db, f.holder);
      assert.equal(holder.cancelRequestedAt, null,
        'a switch that can never happen must not cost a running run');
      assert.equal(holder.status, RunStatus.PENDING);
      assert.equal((await sessionRow(db, f.replaced)).provider, 'claude');
      assert.deepEqual(await turnsFor(db, dto.clientTurnId), []);
    } finally {
      await db.$disconnect();
    }
  });

test('a message carrying files is refused rather than delivered without them',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const { db, sessions } = connect();
    try {
      const f = await fixture(db, 'attachments', RunStatus.RUNNING);
      const attachmentId = randomUUID();
      // Uploaded into the run the person is looking at, which is where an `attachment` row lives:
      // it is scoped to one session and cannot be linked to a turn in another.
      await db.attachment.create({
        data: {
          id: attachmentId,
          ownerId: f.ownerId,
          sessionId: f.replaced,
          fileName: 'screenshot.png',
          mimeType: 'image/png',
          sizeBytes: 3,
          data: Buffer.from([1, 2, 3]),
        },
      });
      const dto = message({ attachmentIds: [attachmentId] });

      await assert.rejects(
        () => sessions.resume(f.ownerId, f.replaced, dto as never, { routeToCurrentRun: true }),
        (error: unknown) => {
          assert.ok(error instanceof ConflictException);
          // The structured refusal, which names the run to open — not a sentence about attachment
          // ids, and not a delivery of the words without the picture they are about.
          assert.equal(body(error).code, 'TASK_ALREADY_RUNNING');
          assert.equal(body(error).conflictingSessionId, uuidToBase62(f.holder));
          return true;
        },
      );
      assert.deepEqual(await turnsFor(db, dto.clientTurnId), []);
    } finally {
      await db.$disconnect();
    }
  });

test('a server-driven resume keeps the refusal: only a person routes a message',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const { db, sessions } = connect();
    try {
      // The auto-retry sweeper re-sending a quota-killed message is not somebody deciding to say
      // something now: its message belongs to the run it was typed into, and pushing it into
      // whatever the task is running instead would inject stale words into a fresh run.
      const f = await fixture(db, 'sweeper', RunStatus.RUNNING);
      const dto = message();

      await assert.rejects(
        () => sessions.resume(f.ownerId, f.replaced, dto as never),
        (error: unknown) => {
          assert.ok(error instanceof ConflictException);
          assert.equal(body(error).code, 'TASK_ALREADY_RUNNING');
          return true;
        },
      );
      assert.deepEqual(await turnsFor(db, dto.clientTurnId), []);
    } finally {
      await db.$disconnect();
    }
  });
