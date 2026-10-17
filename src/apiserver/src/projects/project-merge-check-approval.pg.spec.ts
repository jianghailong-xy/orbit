import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { uuidToBase62 } from '@orbit/shared';
import { RunnerStatus, RunStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import type { RunnerOrchestrationAuthorizer } from '../runner-api/runner-orchestration-authorizer';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { SessionsService } from '../sessions/sessions.service';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectHandoffService } from './project-handoff.service';
import { PROJECT_INTEGRATION_APPROVAL_TOOL_NAME } from './project-integration-approval';
import { ProjectsService } from './projects.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';

/**
 * A session changing a project's merge check — through the owner's card, and only through it.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-merge-check-approval.pg.spec.ts
 *
 * WHAT IS REAL
 * ============
 * Everything a session's write touches: the runner door it arrives on
 * (`RunnerProjectsController`, the one MCP and the CLI both use), the real `ProjectsService`
 * against a real PostgreSQL, a real `approval` row, and the owner's own decision route
 * (`SessionsService.decideApproval`) as the thing that writes `decided_by_id`. The merge check is
 * read back off `project_codebase` and the provenance off `activity`, so both halves of the claim
 * are the database's answer rather than the service's return value.
 *
 * WHAT THE CARD HAS TO PROVE
 * ==========================
 * The three cases the unit spec can only argue about with a stub: a card nobody answered, a card
 * the owner DECLINED, and a card filed for one change being used to write another. All three are
 * refusals that write nothing — including the rest of the fields the same request carried — which
 * is a claim about the transaction's position rather than about the guard's arithmetic.
 *
 * Every card here is filed the way a REAL one is — `projectId` as the caller wrote it, which is
 * the public id in the project's web UI URL (see `asTheCallerWritesIt`). A spec that files them
 * with the uuid instead passes with a comparison held to the two ids as-written, and that
 * comparison refuses every card the runner actually files, so the spelling is part of what has to
 * be proved rather than an incidental detail of the fixture.
 *
 * Not destructive: every case owns freshly generated ids.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** Already canonical: the column's CHECK refuses a trailing `.git`, a trailing `/` and case. */
const REPO_URL = 'https://github.com/Example/Merge-Check';

/** The two merge checks these cases move between. */
const OLD_CHECK = 'npm run lint';
const NEW_CHECK = 'npm test';

interface Stack {
  db: PrismaClient;
  prisma: PrismaService;
  sql: Client;
  sessions: SessionsService;
  projects: ProjectsService;
}

async function connect(): Promise<Stack> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  return {
    db, prisma, sql,
    sessions: new SessionsService(prisma, queue, realtime),
    projects: new ProjectsService(prisma, new ProjectAcceptanceService(prisma)),
  };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  projectId: string;
  coordinatorSessionId: string;
  runner: Awaited<ReturnType<PrismaClient['runner']['findUniqueOrThrow']>>;
}

/** One owner, one runner, one workspace naming a remote, and a project coordinated from it. */
async function project(stack: Stack, label: string): Promise<Fixture> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@merge-check.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId, ownerId, runnerId, name: `${label}-workspace`,
      enabled: true, repoUrl: REPO_URL, defaultMergeTarget: 'main',
    },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
      title: `协调：${label}`, prompt: `协调：${label}`, provider: 'claude',
      status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  await db.project.create({
    data: { id: projectId, ownerId, title: `${label} 的项目`, coordinatorWorkspaceId: workspaceId, coordinatorSessionId },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  // The binding, with a merge check already on it — the value a card would be about changing.
  await db.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: REPO_URL, upstreamRef: 'refs/heads/main',
      integrationRef: 'refs/heads/main', refAuthority: 'REMOTE', mergeCheckCommand: OLD_CHECK,
    },
  });
  return {
    ownerId, runnerId, projectId, coordinatorSessionId,
    runner: await db.runner.findUniqueOrThrow({ where: { id: runnerId } }),
  };
}

/** The door a session's write arrives on. */
function door(stack: Stack): RunnerProjectsController {
  return new RunnerProjectsController(
    stack.projects,
    {} as ProjectAcceptanceService,
    {} as ProjectHandoffService,
    {} as RunnerOrchestrationAuthorizer,
  );
}

/**
 * The id the CALLER writes, which is the one the card carries.
 *
 * `project_update` tells the agent its `projectId` is "the project as shown in its web UI URL
 * (/projects/<id>)", `runner-go/mcp.go`'s `projectMergeCheckCard` puts that string on the card
 * unchanged, and the route that performs the write has already decoded it to the uuid. So this —
 * not the uuid — is the spelling on the card in every real call, and a comparison held to the two
 * as-written strings would never match one.
 */
const asTheCallerWritesIt = (projectId: string) => uuidToBase62(projectId);

/** The card the runner files: this project, what the check is now, and what it would become. */
function cardInput(projectId: string, proposed: Record<string, unknown>) {
  return { projectId, projectTitle: '项目', currentMergeCheckCommand: OLD_CHECK, ...proposed };
}

/** File a card, and answer it as the account owner (or leave it unanswered).
 *
 *  `projectId` is the spelling the card carries: the public id a runner files by default, and the
 *  uuid for the card an internal caller would have written. */
async function filedCard(
  stack: Stack,
  f: Fixture,
  proposed: Record<string, unknown>,
  answer?: 'allow' | 'deny',
  projectId: string = asTheCallerWritesIt(f.projectId),
): Promise<string> {
  const card = await stack.db.approval.create({
    data: {
      sessionId: f.coordinatorSessionId,
      toolName: PROJECT_INTEGRATION_APPROVAL_TOOL_NAME,
      input: cardInput(projectId, proposed),
    },
  });
  if (answer) {
    await stack.sessions.decideApproval(f.ownerId, f.coordinatorSessionId, card.id, { behavior: answer });
  }
  return card.id;
}

/** The merge check on the binding, as the database has it. */
async function mergeCheckOf(stack: Stack, f: Fixture): Promise<string | null> {
  const row = await stack.db.projectCodebase.findFirstOrThrow({
    where: { projectId: f.projectId }, select: { mergeCheckCommand: true },
  });
  return row.mergeCheckCommand;
}

/** The merge-check provenance rows for this project, oldest first. */
async function provenanceOf(stack: Stack, f: Fixture) {
  return stack.db.activity.findMany({
    where: { type: 'project.merge_check.changed' },
    orderBy: { createdAt: 'asc' },
  }).then((rows) => rows.filter((row) => (row.payload as { projectId?: string })?.projectId === f.projectId));
}

/** Write through the runner door as a session, and report whether it was refused by the rule. */
async function writeAsSession(
  stack: Stack,
  f: Fixture,
  integration: Record<string, unknown>,
): Promise<{ refused: boolean }> {
  try {
    await door(stack).updateProject(f.runner, f.projectId, f.coordinatorSessionId,
      { integration } as never);
    return { refused: false };
  } catch (error) {
    const status = (error as { getStatus?: () => number }).getStatus?.();
    const code = (error as { getResponse?: () => { code?: string } }).getResponse?.()?.code;
    assert.equal(status, 403, String(error));
    assert.equal(code, 'INTEGRATION_SETTINGS_OWNER_ONLY', String(error));
    return { refused: true };
  }
}

test('a merge check change needs postgres; every case below is a skip without it', { skip }, async (t) => {
  const stack = await connect();
  t.after(() => stack.db.$disconnect().catch(() => undefined));
  t.after(() => stack.sql.end().catch(() => undefined));

  await t.test('the owner’s card, on this exact change, is what lets a session write it', async () => {
    // Both spellings of the project, and the first is the load-bearing one: it is what a REAL card
    // carries. The owner can answer the question and the write still be refused for a reason that
    // has nothing to do with what they were asked — which is exactly what happened while the
    // comparison was held to the two ids as WRITTEN, since the card carries the public id the
    // caller passed and the request carries the uuid the route resolved it to. The second spelling
    // is what an internal caller has, and it has to keep working: the fix is that the comparison
    // lands on WHICH project the card is about, not on one spelling winning over the other.
    for (const asUuid of [false, true] as const) {
      const spelling = asUuid ? 'the uuid on the card' : 'the caller’s public id on the card';
      const f = await project(stack, asUuid ? 'approved-uuid' : 'approved-public-id');
      const projectId = asUuid ? f.projectId : asTheCallerWritesIt(f.projectId);
      const cardId = await filedCard(stack, f, { mergeCheckCommand: NEW_CHECK }, 'allow', projectId);

      assert.deepEqual(await writeAsSession(stack, f, { mergeCheckCommand: NEW_CHECK }),
        { refused: false }, `${spelling} on the card`);
      assert.equal(await mergeCheckOf(stack, f), NEW_CHECK, spelling);

      // Provenance: which card, whose click, whose session, and the change it authorised. The row is
      // the whole answer to "why did this field move", which is what makes the card auditable after
      // the fact rather than only enforceable at the moment it is read. The project on it is the
      // RESOLVED uuid either way — the ledger names the project, not how the card spelled it.
      const rows = await provenanceOf(stack, f);
      assert.equal(rows.length, 1, spelling);
      assert.equal(rows[0].actorId, f.ownerId, spelling);
      assert.equal(rows[0].type, 'project.merge_check.changed', spelling);
      assert.deepEqual(rows[0].payload, {
        projectId: f.projectId,
        approvalId: cardId,
        approvedByUserId: f.ownerId,
        requestedBySessionId: f.coordinatorSessionId,
        mergeCheckCommand: NEW_CHECK,
      }, spelling);
    }
  });

  await t.test('resolving the id does not make another project’s card this project’s', async () => {
    // The one refusal the cases below do not reach: they file the card against THIS project in
    // every spelling, so none of them holds the fix to the property it could plausibly break. A
    // card naming a different project — spelled the way a caller spells ids, which is the spelling
    // that now gets resolved — is that other project's card, and authorises nothing here.
    const f = await project(stack, 'other-projects-card');
    const elsewhere = await project(stack, 'elsewhere');
    await filedCard(stack, f, { mergeCheckCommand: NEW_CHECK }, 'allow',
      asTheCallerWritesIt(elsewhere.projectId));

    assert.deepEqual(await writeAsSession(stack, f, { mergeCheckCommand: NEW_CHECK }), { refused: true });
    assert.equal(await mergeCheckOf(stack, f), OLD_CHECK);
    assert.deepEqual(await provenanceOf(stack, f), []);
  });

  await t.test('a card the owner DECLINED, or never answered, leaves the check where it was', async () => {
    for (const [what, answer] of [['declined', 'deny'], ['unanswered', undefined]] as const) {
      const f = await project(stack, `no-${what}`);
      await filedCard(stack, f, { mergeCheckCommand: NEW_CHECK }, answer);

      assert.deepEqual(await writeAsSession(stack, f, { mergeCheckCommand: NEW_CHECK }), { refused: true }, what);
      assert.equal(await mergeCheckOf(stack, f), OLD_CHECK, what);
      assert.deepEqual(await provenanceOf(stack, f), [], what);
    }
  });

  await t.test('no card at all is refused, and the fields beside it are not written either', async () => {
    const f = await project(stack, 'no-card');

    // A title travelling with the refused integration object, to hold the guard to its position:
    // it runs before the transaction, so a refused request writes nothing it carried.
    await assert.rejects(
      () => door(stack).updateProject(f.runner, f.projectId, f.coordinatorSessionId,
        { integration: { mergeCheckCommand: NEW_CHECK }, title: 'renamed by a refused request' } as never),
      (error: { getStatus?: () => number; getResponse?: () => { code?: string } }) => {
        assert.equal(error.getStatus?.(), 403, String(error));
        assert.equal(error.getResponse?.()?.code, 'INTEGRATION_SETTINGS_OWNER_ONLY');
        return true;
      },
    );
    assert.equal(await mergeCheckOf(stack, f), OLD_CHECK);
    assert.equal(await stack.db.project.findUniqueOrThrow({
      where: { id: f.projectId }, select: { title: true },
    }).then((row) => row.title), 'no-card 的项目', 'the refused request renamed the project anyway');
    assert.deepEqual(await provenanceOf(stack, f), []);
  });

  await t.test('a card approved for one change does not authorise a second', async () => {
    const f = await project(stack, 'reused-card');
    await filedCard(stack, f, { mergeCheckCommand: NEW_CHECK }, 'allow');

    assert.deepEqual(await writeAsSession(stack, f, { mergeCheckCommand: NEW_CHECK }), { refused: false });
    // The same session, on the strength of the same card, tries a different change.
    assert.deepEqual(await writeAsSession(stack, f, { mergeCheckCommand: 'rm -rf /' }), { refused: true });
    assert.equal(await mergeCheckOf(stack, f), NEW_CHECK);
    assert.equal((await provenanceOf(stack, f)).length, 1, 'the refused write recorded no provenance');
  });

  await t.test('the line is refused with a card or without one', async () => {
    const f = await project(stack, 'line');
    // A card that covers the merge check this request also carries — so the refusal is the LINE's
    // and not the card's.
    await filedCard(stack, f, { mergeCheckCommand: NEW_CHECK }, 'allow');

    for (const integration of [
      { line: 'MAIN' },
      { projectBranchName: 'refs/heads/project/next' },
      { upstreamRef: 'refs/heads/trunk' },
      { line: 'MAIN', mergeCheckCommand: NEW_CHECK },
    ]) {
      assert.deepEqual(await writeAsSession(stack, f, integration), { refused: true }, JSON.stringify(integration));
    }
    assert.equal(await mergeCheckOf(stack, f), OLD_CHECK);
    assert.deepEqual(await stack.db.projectCodebase.findFirstOrThrow({
      where: { projectId: f.projectId },
      select: { integrationRef: true, upstreamRef: true, integrationRefSource: true },
    }), {
      integrationRef: 'refs/heads/main', upstreamRef: 'refs/heads/main', integrationRefSource: 'DEFAULT_RULE',
    }, 'a refused line write moved the line anyway');
  });

  await t.test('with no acting session the owner writes the merge check themselves', async () => {
    const f = await project(stack, 'owner-terminal');

    await door(stack).updateProject(f.runner, f.projectId, undefined,
      { integration: { mergeCheckCommand: NEW_CHECK, mergeCheckTimeoutSeconds: 900 } } as never);

    assert.equal(await mergeCheckOf(stack, f), NEW_CHECK);
    assert.equal(await stack.db.projectCodebase.findFirstOrThrow({
      where: { projectId: f.projectId }, select: { mergeCheckTimeoutSeconds: true },
    }).then((row) => row.mergeCheckTimeoutSeconds), 900);
    assert.deepEqual(await provenanceOf(stack, f), [],
      'no card was answered, so there is no card to record');
  });

  await t.test('another session’s card is not this session’s', async () => {
    const f = await project(stack, 'other-session');
    const otherSessionId = randomUUID();
    await stack.db.session.create({
      data: {
        id: otherSessionId, ownerId: f.ownerId, creatorId: f.ownerId, assignedRunnerId: f.runnerId,
        title: 'another conversation', prompt: 'another conversation', provider: 'claude',
        status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER,
      },
    });
    await stack.db.approval.create({
      data: {
        sessionId: otherSessionId, toolName: PROJECT_INTEGRATION_APPROVAL_TOOL_NAME,
        input: cardInput(f.projectId, { mergeCheckCommand: NEW_CHECK }),
      },
    });
    await stack.sessions.decideApproval(f.ownerId, otherSessionId,
      (await stack.db.approval.findFirstOrThrow({ where: { sessionId: otherSessionId } })).id,
      { behavior: 'allow' });

    assert.deepEqual(await writeAsSession(stack, f, { mergeCheckCommand: NEW_CHECK }), { refused: true });
    assert.equal(await mergeCheckOf(stack, f), OLD_CHECK);
  });

});
