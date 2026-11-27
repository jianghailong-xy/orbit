import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import {
  PROJECT_RULING_COORDINATOR_ONLY,
  PROJECT_RULING_QUOTE_NOT_FOUND,
  PROJECT_RULING_SUPERSEDES_NOT_LIVE,
  PROJECT_RULING_TURN_NOT_FOUND,
} from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectOpenItemService } from './project-open-item.service';
import { readLiveRulings } from './project-ruling';
import { ProjectsService } from './projects.service';

/**
 * Owner rulings as project records (docs/coordinator-handoff-v2-design.md §2, migration 0970), on a real
 * database: an answered ask_owner question writes a ruling; `project_ruling_record` accepts a quote found in
 * its turn's owner text and refuses one that is not, a caller that is not the coordinator, and a turn that is
 * not the owner's; supersession marks the old ruling and keeps it; project_get serves the live ones; and
 * another owner can neither read nor write them.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

interface Harness {
  db: PrismaClient;
  openItems: ProjectOpenItemService;
  projects: ProjectsService;
}

let harness: Promise<Harness> | undefined;
function connect(): Promise<Harness> {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await sql.connect();
    try {
      await verifyCoordinatorPgIdentity(sql);
    } finally {
      await sql.end();
    }
    const db = prismaClientFor(URL!) as unknown as PrismaClient;
    const prisma = db as unknown as PrismaService;
    // The answer's delivery is not what this file reads: an ended conversation is what it meets.
    const sessions = {
      receiveBlockedReasonFor: async () => null,
      createTurn: async () => { throw new NotFoundException('not delivered in this spec'); },
    };
    const openItems = new ProjectOpenItemService(prisma, sessions as never);
    const projects = new ProjectsService(prisma, new ProjectAcceptanceService(prisma));
    return { db, openItems, projects };
  })();
  return harness;
}

after(async () => {
  const h = await harness?.catch(() => undefined);
  await h?.db.$disconnect();
});

interface World {
  ownerId: string;
  projectId: string;
  coordinator: string;
  other: string;
}

async function session(db: PrismaClient, ownerId: string, workspaceId: string, runnerId: string, title: string): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title, prompt: title,
      provider: 'claude', turnState: null, dispatchOrigin: SessionDispatchOrigin.USER,
      startedAt: new Date(), runtimeSessionId: `runtime-${id}`,
    },
  });
  return id;
}

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@ruling.invalid`, name: label, passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-ws`, enabled: true, repoUrl: `https://git.invalid/${label}/${projectId}.git`, workDir: `/srv/${label}` },
  });
  const coordinator = await session(db, ownerId, workspaceId, runnerId, `coordinator: ${label}`);
  const other = await session(db, ownerId, workspaceId, runnerId, `other: ${label}`);
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} project`, goal: 'keep what the owner ruled',
      coordinatorEnabled: true, coordinatorWorkspaceId: workspaceId, coordinatorSessionId: coordinator,
    },
  });
  return { ownerId, projectId, coordinator, other };
}

let seq = 0;
async function turn(
  db: PrismaClient,
  sessionId: string,
  content: string,
  extra: { clientTurnId?: string; senderSessionId?: string } = {},
): Promise<string> {
  seq += 1;
  const row = await db.conversationTurn.create({
    data: {
      sessionId, seq, clientTurnId: extra.clientTurnId ?? `owner-${randomUUID()}`, kind: 'message',
      sendIntent: 'NEXT_TURN', content, status: 'ANSWERED', senderSessionId: extra.senderSessionId ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

async function code(promise: Promise<unknown>): Promise<{ status: number; code: string | undefined }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BadRequestException || error instanceof ForbiddenException
      || error instanceof NotFoundException || error instanceof ConflictException) {
      const body = error.getResponse() as { code?: string };
      return { status: error.getStatus(), code: typeof body === 'object' ? body.code : undefined };
    }
    throw error;
  }
  assert.fail('expected a refusal');
}

test('an answered ask_owner question becomes a ruling: the question with the chosen option, the answer as the quote', { skip }, async () => {
  const { db, openItems } = await connect();
  const w = await world(db, 'auto');
  const asked = await openItems.askOwner(w.ownerId, w.projectId, w.coordinator, {
    question: 'Ship the Android build before the iOS one?',
    options: [{ label: 'Android first' }, { label: 'Both together' }],
  } as never);
  const itemId = (asked as { itemId: string }).itemId;
  await openItems.answerOpenItem(w.ownerId, w.projectId, itemId, { option: 0, text: 'Android first, iOS can wait a week.' });

  const rows = await db.projectRuling.findMany({ where: { projectId: w.projectId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ruling, 'Ship the Android build before the iOS one? — Android first');
  assert.equal(rows[0].quote, 'Android first, iOS can wait a week.');
  assert.equal(rows[0].sourceKind, 'ASK_OWNER');
  assert.equal(rows[0].sourceId, itemId);
  assert.equal(rows[0].recordedBySessionId, null);
  assert.equal(rows[0].ownerId, w.ownerId);

  // An option alone: the option the owner picked is their words.
  const second = await openItems.askOwner(w.ownerId, w.projectId, w.coordinator, {
    question: 'Keep the old endpoint?',
    options: [{ label: 'Keep it' }, { label: 'Remove it' }],
  } as never);
  await openItems.answerOpenItem(w.ownerId, w.projectId, (second as { itemId: string }).itemId, { option: 1 });
  const live = await readLiveRulings(db as never, w.ownerId, w.projectId);
  assert.deepEqual(live.map((r) => [r.ruling, r.quote]), [
    ['Ship the Android build before the iOS one? — Android first', 'Android first, iOS can wait a week.'],
    ['Keep the old endpoint? — Remove it', 'Remove it'],
  ]);
});

test('project_ruling_record accepts a quote found in the turn\'s owner text', { skip }, async () => {
  const { db, openItems, projects } = await connect();
  const w = await world(db, 'record');
  const turnId = await turn(db, w.coordinator, 'OK — don\'t merge   Payment retries\nbefore Friday\'s release, whatever CI says.');
  const view = await openItems.recordRuling(w.ownerId, w.projectId, w.coordinator, {
    ruling: 'Payment retries is not merged before Friday\'s release.',
    quote: 'don\'t merge Payment retries before Friday\'s release',
    sourceTurnId: turnId,
  });
  assert.equal(view.sourceKind, 'TURN');
  assert.equal(view.sourceId, turnId);
  assert.equal(view.recordedBySessionId, w.coordinator);
  assert.equal(view.supersededById, null);

  const detail = await projects.get(w.ownerId, w.projectId) as unknown as { rulings: Array<{ id: string; ruling: string }> };
  assert.deepEqual(detail.rulings.map((r) => r.id), [view.id]);
});

test('project_ruling_record refuses a quote that is not a substring, a non-coordinator caller, and a turn that is not the owner\'s', { skip }, async () => {
  const { db, openItems } = await connect();
  const w = await world(db, 'refuse');
  const turnId = await turn(db, w.coordinator, 'Use the staging stack for the walkthrough.');
  const body = { ruling: 'The walkthrough runs on staging.', quote: 'Use the staging stack', sourceTurnId: turnId };

  assert.deepEqual(
    await code(openItems.recordRuling(w.ownerId, w.projectId, w.coordinator, { ...body, quote: 'Use the production stack' })),
    { status: 400, code: PROJECT_RULING_QUOTE_NOT_FOUND },
  );
  assert.deepEqual(await code(openItems.recordRuling(w.ownerId, w.projectId, w.other, body)), { status: 403, code: PROJECT_RULING_COORDINATOR_ONLY });
  assert.deepEqual(await code(openItems.recordRuling(w.ownerId, w.projectId, undefined, body)), { status: 403, code: PROJECT_RULING_COORDINATOR_ONLY });

  // A turn another session sent, and one Orbit wrote, are not the owner's words even when the quote is in them.
  const sent = await turn(db, w.coordinator, 'Use the staging stack, says the task session.', { senderSessionId: w.other });
  assert.deepEqual(
    await code(openItems.recordRuling(w.ownerId, w.projectId, w.coordinator, { ...body, sourceTurnId: sent })),
    { status: 400, code: PROJECT_RULING_QUOTE_NOT_FOUND },
  );
  const orbit = await turn(db, w.coordinator, 'Use the staging stack (from Orbit).', { clientTurnId: `coordinator-handoff:v1:${randomUUID()}:1` });
  assert.deepEqual(
    await code(openItems.recordRuling(w.ownerId, w.projectId, w.coordinator, { ...body, sourceTurnId: orbit })),
    { status: 400, code: PROJECT_RULING_QUOTE_NOT_FOUND },
  );
  // A turn of a conversation that never coordinated this project.
  const elsewhere = await turn(db, w.other, 'Use the staging stack.');
  assert.deepEqual(
    await code(openItems.recordRuling(w.ownerId, w.projectId, w.coordinator, { ...body, sourceTurnId: elsewhere })),
    { status: 404, code: PROJECT_RULING_TURN_NOT_FOUND },
  );
  assert.equal(await db.projectRuling.count({ where: { projectId: w.projectId } }), 0);
});

test('a superseding ruling marks the old one superseded and keeps it', { skip }, async () => {
  const { db, openItems, projects } = await connect();
  const w = await world(db, 'supersede');
  const first = await turn(db, w.coordinator, 'Release on Friday.');
  const second = await turn(db, w.coordinator, 'Change of plan: release on Monday instead.');
  const old = await openItems.recordRuling(w.ownerId, w.projectId, w.coordinator, {
    ruling: 'The release is on Friday.', quote: 'Release on Friday', sourceTurnId: first,
  });
  const next = await openItems.recordRuling(w.ownerId, w.projectId, w.coordinator, {
    ruling: 'The release is on Monday.', quote: 'release on Monday instead', sourceTurnId: second, supersedes: old.id,
  });
  const kept = await db.projectRuling.findUniqueOrThrow({ where: { id: old.id } });
  assert.equal(kept.supersededById, next.id);
  assert.equal(kept.ruling, 'The release is on Friday.');
  assert.equal(await db.projectRuling.count({ where: { projectId: w.projectId } }), 2);

  const detail = await projects.get(w.ownerId, w.projectId) as unknown as { rulings: Array<{ id: string }> };
  assert.deepEqual(detail.rulings.map((r) => r.id), [next.id]);

  // A superseded ruling cannot be superseded again.
  assert.deepEqual(
    await code(openItems.recordRuling(w.ownerId, w.projectId, w.coordinator, {
      ruling: 'The release is on Tuesday.', quote: 'Release on Friday', sourceTurnId: first, supersedes: old.id,
    })),
    { status: 409, code: PROJECT_RULING_SUPERSEDES_NOT_LIVE },
  );
});

test('another owner can neither read nor write a project\'s rulings', { skip }, async () => {
  const { db, openItems, projects } = await connect();
  const a = await world(db, 'owner-a');
  const b = await world(db, 'owner-b');
  const turnId = await turn(db, a.coordinator, 'Never deploy on a weekend.');
  const ruling = await openItems.recordRuling(a.ownerId, a.projectId, a.coordinator, {
    ruling: 'No weekend deploys.', quote: 'Never deploy on a weekend', sourceTurnId: turnId,
  });

  // Read: owner B's view of A's project is nothing.
  assert.deepEqual(await readLiveRulings(db as never, b.ownerId, a.projectId), []);
  await assert.rejects(projects.get(b.ownerId, a.projectId), NotFoundException);

  // Write through the door: B's credential naming A's project, A's coordinator, or A's turn.
  assert.equal((await code(openItems.recordRuling(b.ownerId, a.projectId, a.coordinator, {
    ruling: 'Weekend deploys are fine.', quote: 'Never deploy on a weekend', sourceTurnId: turnId,
  }))).status, 404);
  assert.deepEqual(await code(openItems.recordRuling(b.ownerId, b.projectId, b.coordinator, {
    ruling: 'Weekend deploys are fine.', quote: 'Never deploy on a weekend', sourceTurnId: turnId,
  })), { status: 404, code: PROJECT_RULING_TURN_NOT_FOUND });
  // Nor supersede A's ruling from B's project.
  const bTurn = await turn(db, b.coordinator, 'Weekend deploys are fine now.');
  assert.deepEqual(await code(openItems.recordRuling(b.ownerId, b.projectId, b.coordinator, {
    ruling: 'Weekend deploys are fine.', quote: 'Weekend deploys are fine', sourceTurnId: bTurn, supersedes: ruling.id,
  })), { status: 409, code: PROJECT_RULING_SUPERSEDES_NOT_LIVE });

  // And the table itself: a row under B naming A's project fails the (project_id, owner_id) foreign key.
  await assert.rejects(db.projectRuling.create({
    data: { ownerId: b.ownerId, projectId: a.projectId, ruling: 'x', quote: 'xxxx', sourceKind: 'TURN', sourceId: turnId },
  }));
  const untouched = await db.projectRuling.findUniqueOrThrow({ where: { id: ruling.id } });
  assert.equal(untouched.supersededById, null);
  assert.equal(await db.projectRuling.count({ where: { projectId: b.projectId } }), 0);
});
