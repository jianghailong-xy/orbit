/**
 * The door `project.status` is written through, and who is on each side of it.
 *
 * WHAT WAS OPEN
 * =============
 * `COORDINATOR_AUTHORITY.SETTLE_PROJECT_DONE` is graded `AUTOMATIC`, and the sentence beside it
 * reads "no principal writes it". That was a description of an intention rather than of the
 * server: `UpdateProjectDto` carries `status`, `ProjectsService.update` copies it into the Prisma
 * input whenever the request sent one, and the only role gate on that method returned early on
 * every request that did not also carry acceptance criteria. So any session — a task execution
 * run, the one-shot judgment session, a long-lived coordination conversation — could PATCH its own
 * project to DONE, and the three tiers above it were describing a boundary that was not there.
 *
 * WHAT THIS FILE HOLDS, AND WHY IT IS THREE CASES AND NOT ONE
 * ==========================================================
 * 1. THE NEGATIVE. A write carrying `status` from a request with an acting session is refused, and
 *    the refusal NAMES the rule: a `code` and a `requiredAction` the caller can act on. Then the
 *    column is read back off the row, outside the service, because "the service threw" and "the
 *    project was not settled" are two facts and only the second one is what the door is for.
 *
 * 2. THE POSITIVE CONTROL, in the same fixture, on the same project, with the same body. Take the
 *    acting session away and the write still goes through and still commits DONE. Without this
 *    case an implementation that simply deleted `status` from the DTO — or refused it for
 *    everybody — passes case 1 exactly as well as the real one does, and the user API, the
 *    headless CLI and every internal caller would have lost a field nobody said to take from them.
 *    Migration 0229 removed the DONE gate that refused EVERY principal, on the account owner's
 *    explicit choice; this door is a narrower thing and case 2 is what says so.
 *
 * 3. NOT SILENTLY IGNORED. The tempting cheap implementation is to strip the field: no refusal, a
 *    200, and a row that did not move. A caller — here, a model that will go on to act as though
 *    the project is finished — cannot tell that from success. So the third case sends `status`
 *    ALONGSIDE a field the same caller is genuinely allowed to write, and asserts that the request
 *    is refused WHOLE: the status did not land, and neither did the writable field. A stripped
 *    field would have answered 200 and written the other one.
 *
 * WHY REAL POSTGRESQL
 * ===================
 * Cases 1 and 3 are claims that a row did NOT move, and a Prisma double asked whether it recorded
 * a write answers with whatever the double was built to say. The premise (`status = 'OPEN'`), the
 * refusal and the verdict are all read off a real row here, through a second connection that is
 * not the one the service used.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-status-write-door.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ForbiddenException } from '@nestjs/common';
import { ProjectStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
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

/**
 * The acting session every negative below is made from.
 *
 * `USER` on purpose, and it is the sharpest choice available: it is the ORDINARY origin — a task
 * execution run, a conversation somebody opened — and it is what `authorityPrincipal` classifies
 * as NON_JUDGMENT. A door that only refused `PROJECT_COORDINATOR` would leave every other agent
 * session holding the write, which is the hole this file exists for. The one-shot judgment session
 * is checked too, further down, so neither role can be the only one the door knows about.
 */
const ACTING_ORIGIN = SessionDispatchOrigin.USER;

interface Fixture {
  prisma: PrismaClient;
  sql: Client;
  projects: ProjectsService;
  ownerId: string;
  projectId: string;
  /** A real session row, owned by the same user, as the runner door's header would name. */
  sessionId: string;
  /** The `status` column as the ROW holds it, read on a connection the service never touched. */
  storedStatus(): Promise<string>;
  /** The `goal` column, for the whole-request claim in case 3. */
  storedGoal(): Promise<string | null>;
}

async function fixture(t: { after(fn: () => unknown): void }, label: string): Promise<Fixture> {
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

  const ownerId = randomUUID();
  const projectId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `status-door-${ownerId}@write-door.invalid`,
      name: 'The owner whose project this is',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: `A project nobody has settled — ${label}` },
  });
  const session = await prisma.session.create({
    data: {
      ownerId,
      creatorId: ownerId,
      title: 'an ordinary agent session inside this project',
      prompt: 'do the work',
      dispatchOrigin: ACTING_ORIGIN,
    },
    select: { id: true },
  });

  const projects = new ProjectsService(
    prisma as unknown as PrismaService,
    new ProjectAcceptanceService(prisma as unknown as PrismaService),
  );

  return {
    prisma,
    sql,
    projects,
    ownerId,
    projectId,
    sessionId: session.id,
    async storedStatus() {
      const row = await sql.query<{ status: string }>(
        `SELECT "status"::text AS status FROM "project" WHERE "id" = $1::uuid`, [projectId]);
      assert.equal(row.rowCount, 1, 'the fixture project is missing');
      return row.rows[0].status;
    },
    async storedGoal() {
      const row = await sql.query<{ goal: string | null }>(
        `SELECT "goal" FROM "project" WHERE "id" = $1::uuid`, [projectId]);
      assert.equal(row.rowCount, 1, 'the fixture project is missing');
      return row.rows[0].goal;
    },
  };
}

/** The refusal body, or a failure that says the write was NOT refused. */
async function refusalOf(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await run();
  } catch (error) {
    assert.ok(
      error instanceof ForbiddenException,
      `expected the status write to be refused, got ${String(error)}`,
    );
    return error.getResponse() as Record<string, unknown>;
  }
  return assert.fail(
    'the write was not refused at all: an acting session settled the project it is working '
    + 'inside, which is the door this file exists to keep shut',
  );
}

// ═══ 1. the negative ════════════════════════════════════════════════════════════════════════════
test('an acting session writing status=DONE is refused by name, and the row does not move', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const f = await fixture(t, 'the negative');

  assert.equal(await f.storedStatus(), 'OPEN',
    'the premise: nothing has settled this project, so the write below is the only thing that '
    + 'could have');

  const body = await refusalOf(() => f.projects.update(
    f.ownerId, f.projectId, { status: ProjectStatus.DONE } as never, f.sessionId));

  // WHICH rule, not merely that there was one. A caller told "forbidden" has to guess, and the
  // caller here is a model that will guess wrong and retry.
  assert.equal(body.code, 'PROJECT_STATUS_NOT_SESSION_WRITABLE',
    'the refusal names the boundary the caller met');
  assert.equal(body.requiredAction, 'ASK_A_PERSON',
    'and what to do about it, from the closed set of required actions');
  // The field it is about, so a request carrying several does not leave the caller bisecting.
  assert.match(String(body.message), /status/);

  assert.equal(await f.storedStatus(), 'OPEN',
    'and the column did not move: a service that threw AFTER committing would answer this file '
    + 'with a refusal and settle the project anyway');

  // Neither of the two roles is the only one the door knows about. The one-shot judgment session
  // is the role the HUMAN_ONLY rows restrict; this boundary is broader than that one, and the
  // ordinary session above is the case that would be missed by a gate keyed on dispatch_origin.
  await t.test('the one-shot judgment session is refused the same way', async () => {
    const judgment = await f.prisma.session.create({
      data: {
        ownerId: f.ownerId,
        creatorId: f.ownerId,
        title: 'a one-shot judgment session',
        prompt: 'judge',
        dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR,
      },
      select: { id: true },
    });
    const refused = await refusalOf(() => f.projects.update(
      f.ownerId, f.projectId, { status: ProjectStatus.DONE } as never, judgment.id));
    assert.equal(refused.code, 'PROJECT_STATUS_NOT_SESSION_WRITABLE');
    assert.equal(await f.storedStatus(), 'OPEN');
  });

  // The other two values, because a rule that only refused DONE is a rule with a way round it:
  // CANCELLED closes a project just as finally, and OPEN puts back into circulation work the
  // owner settled. Both are statements about the whole project, which is what this field is.
  await t.test('CANCELLED and OPEN are refused too, not just DONE', async () => {
    for (const status of [ProjectStatus.CANCELLED, ProjectStatus.OPEN]) {
      const refused = await refusalOf(() => f.projects.update(
        f.ownerId, f.projectId, { status } as never, f.sessionId));
      assert.equal(refused.code, 'PROJECT_STATUS_NOT_SESSION_WRITABLE', `${status} was allowed`);
    }
    assert.equal(await f.storedStatus(), 'OPEN');
  });
});

// ═══ 2. the positive control ════════════════════════════════════════════════════════════════════
test('the same write with no acting session still settles the project', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const f = await fixture(t, 'the positive control');

  assert.equal(await f.storedStatus(), 'OPEN');

  // The user API's own call shape: `ProjectsController.update` passes three arguments, and the
  // runner door passes `undefined` when no `X-Orbit-Session-Id` header arrived. Both are this.
  const settled = await f.projects.update(
    f.ownerId, f.projectId, { status: ProjectStatus.DONE } as never,
  ) as unknown as { status: string };

  assert.equal(settled.status, ProjectStatus.DONE,
    'the owner-authenticated and headless paths keep the behaviour migration 0229 left them: a '
    + 'door that refused everybody would pass the negative above and would still be wrong');
  assert.equal(await f.storedStatus(), 'DONE',
    'and the row committed it, so the control is about the column and not about a return value');
});

// ═══ 3. refused, not silently ignored ═══════════════════════════════════════════════════════════
test('the field is refused rather than stripped: the whole request is turned away', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const f = await fixture(t, 'not silently ignored');

  // First, establish that this caller can write the OTHER field. Without this the case below
  // cannot distinguish "the request was refused" from "this session could never write anything".
  await f.projects.update(
    f.ownerId, f.projectId, { goal: 'what this project is for' } as never, f.sessionId);
  assert.equal(await f.storedGoal(), 'what this project is for',
    'the acting session writes prose about the work, which this door does not touch');

  // Now the same caller sends `status` alongside a second write of that same allowed field. An
  // implementation that dropped `status` from the DTO answers 200 here and lands the goal.
  const body = await refusalOf(() => f.projects.update(
    f.ownerId,
    f.projectId,
    { status: ProjectStatus.DONE, goal: 'a goal written under cover of a settlement' } as never,
    f.sessionId,
  ));
  assert.equal(body.code, 'PROJECT_STATUS_NOT_SESSION_WRITABLE');

  assert.equal(await f.storedStatus(), 'OPEN',
    'the settlement did not happen');
  assert.equal(await f.storedGoal(), 'what this project is for',
    'and neither did the rest of the request: the caller is told its write did not land, rather '
    + 'than left with a 200 and a project that is still open');
});
