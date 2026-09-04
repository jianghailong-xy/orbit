import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { REMOVED_CRITERION_WIRING_FIELDS } from './dto';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectHandoffService } from './project-handoff.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { SessionAttemptService } from './session-attempt.service';
import { TaskCheckpointService } from './task-checkpoint.service';

/**
 * Authoring a project's acceptance criteria, over real HTTP, through the real validation pipe.
 *
 * THE REASON THIS GOES OVER HTTP. Every other spec about the four wiring fields migration 0233
 * removed — `project-acceptance-wiring-removal.pg.spec.ts`, `project-criterion-automation.pg.
 * spec.ts`, `projects.dto.spec.ts` — calls `ProjectsService` directly with an object literal.
 * In a literal, a key that was not written is genuinely absent. In a DTO instance it is not: the
 * four fields are DECLARED on `CreateProjectAcceptanceCriterionDto` (so `whitelist: true` cannot
 * strip them without a word), and a declared class field is materialised on every instance holding
 * `undefined`. So `'completionCriterion' in item` was TRUE for a caller who had sent only `text`
 * and `verificationMethod`, and the service refused it — every criterion authored over HTTP came
 * back 400 while the whole API round stayed green, because no spec ever ran pipe → service.
 *
 * That is the gap this file closes, and it can only be closed from the outside: a probe that
 * builds the argument itself cannot reproduce a defect whose cause is how the pipe builds it.
 *
 * Only PostgreSQL is faked. The controller, the DTO, the pipe and `ProjectsService` are the real
 * ones — stubbing any of them would make the assertions vacuous.
 */

const OWNER_ID = randomUUID();

/** A criterion as the caller writes it: the two fields a criterion has, and nothing else. */
const FIRST = { text: 'the door answers 201', verificationMethod: 'POST it and read the status' };
const SECOND = { text: 'the row is readable', verificationMethod: 'GET the project back' };

/**
 * What an explicit send looks like per field, beside the explicit `null` each is also tried with.
 * `acceptanceExpectedExitCode: 0` on purpose: the refusal is about the field being SENT, and a
 * check written against truthiness would wave the most ordinary exit code there is straight
 * through.
 */
const EXPLICIT_VALUES: Record<string, unknown> = {
  completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'npm test',
  acceptanceExpectedExitCode: 0,
  evidenceTaskId: randomUUID(),
};

type CriterionRow = {
  id: string;
  projectId: string;
  ordinal: number;
  text: string;
  verificationMethod: string;
  completionCriterionOverrideReason: string | null;
  revision: number;
  contentHash: string;
  semanticRevision: number;
  semanticHash: string;
};

/** The database, small enough to read: project rows by id, and every criterion row ever written. */
function fakePrisma() {
  const titles = new Map<string, string>();
  const state = { criteria: [] as CriterionRow[] };

  const read = (id: string) => {
    const title = titles.get(id);
    if (title === undefined) return null;
    return {
      id,
      ownerId: OWNER_ID,
      title,
      status: 'OPEN',
      coordinatorSessionId: null,
      coordinatorEnabled: true,
      // A number rather than the column's BigInt: this probe serialises the response to JSON, and
      // a BigInt in it would be a 500 about `JSON.stringify` rather than about the criteria.
      runtime: { coordinatorGeneration: 0 },
      members: [] as Array<{ agentId: string }>,
      _count: { tasks: 0 },
      acceptanceCriterionDefinitions: state.criteria
        .filter((row) => row.projectId === id)
        .sort((a, b) => a.ordinal - b.ordinal),
    };
  };

  const client = {
    project: {
      create: async ({ data }: { data: { title: string } }) => {
        const id = randomUUID();
        titles.set(id, data.title);
        return read(id);
      },
      findFirst: async ({ where }: { where: { id: string } }) => read(where.id),
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => read(where.id),
      update: async ({ where, data }: { where: { id: string }; data: { title?: string } }) => {
        if (data.title !== undefined) titles.set(where.id, data.title);
        return read(where.id);
      },
    },
    projectAcceptanceCriterionDefinition: {
      findMany: async ({ where }: { where: { projectId: string } }) => state.criteria
        .filter((row) => row.projectId === where.projectId)
        .sort((a, b) => a.ordinal - b.ordinal),
      updateMany: async (
        { where, data }: { where: { projectId: string }; data: { ordinal: { increment: number } } },
      ) => {
        const rows = state.criteria.filter((row) => row.projectId === where.projectId);
        for (const row of rows) row.ordinal += data.ordinal.increment;
        return { count: rows.length };
      },
      deleteMany: async (
        { where }: { where: { projectId: string; id?: { notIn: string[] } } },
      ) => {
        const before = state.criteria.length;
        const kept = where.id?.notIn;
        state.criteria = state.criteria.filter((row) => row.projectId !== where.projectId
          || (kept !== undefined && kept.includes(row.id)));
        return { count: before - state.criteria.length };
      },
      create: async ({ data }: { data: Omit<CriterionRow, 'semanticRevision' | 'semanticHash'> }) => {
        const row = { semanticRevision: 1, semanticHash: 'semantic', ...data };
        state.criteria.push(row);
        return row;
      },
      update: async (
        { where, data }: { where: { id: string }; data: Partial<CriterionRow> },
      ) => {
        const row = state.criteria.find((candidate) => candidate.id === where.id);
        assert.ok(row, `update named a criterion this store never wrote: ${where.id}`);
        Object.assign(row, data);
        return row;
      },
    },
    task: { groupBy: async () => [] },
    // The row `update` locks before it writes. `config_revision` is a number for the same reason
    // `coordinatorGeneration` is; nothing in this probe compares it.
    $queryRaw: async () => [{
      coordinator_enabled: true,
      config_revision: 0,
      status: 'OPEN',
      coordinator_session_id: null,
    }],
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(client),
  };
  return { client, state };
}

const { client: prisma, state } = fakePrisma();

const refuse = (name: string) => () => {
  throw new Error(`${name} must not be reached by this probe`);
};

@Module({
  controllers: [ProjectsController],
  providers: [
    { provide: ProjectsService, useFactory: () => new ProjectsService(prisma as never) },
    { provide: ProjectAcceptanceService, useValue: { recordMergeEvidence: refuse('acceptance') } },
    { provide: ProjectHandoffService, useValue: { listForProject: refuse('handoffs') } },
    { provide: SessionAttemptService, useValue: { describe: refuse('attempts') } },
    { provide: TaskCheckpointService, useValue: { record: refuse('checkpoints') } },
    JwtAuthGuard,
    Reflector,
    { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: OWNER_ID }) } },
    { provide: PrismaService, useValue: {} },
  ],
})
class CriteriaModule {}

type Sent = { status: number; body: string; json: Record<string, unknown> };

async function send(
  base: string,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<Sent> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: 'Bearer an-ordinary-actor',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text, json: JSON.parse(text) };
}

test('a project’s acceptance criteria can be authored, re-read and replaced over HTTP', async (t) => {
  const app = await NestFactory.create(CriteriaModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  // The pipe main.ts installs, with the same options. `whitelist: true` is half the story this
  // file is about: it is why the four removed fields are declared on the DTO at all.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  await t.test('POST /projects with a two-field criterion is created, not refused', async () => {
    const created = await send(base, 'POST', '/api/projects', {
      title: 'criteria over http',
      acceptanceCriteriaItems: [FIRST],
    });

    assert.equal(created.status, 201, `POST answered ${created.status}: ${created.body}`);
    // The exact refusal this file exists for: a caller who sent neither field being told one of
    // them is gone.
    assert.doesNotMatch(created.body, /was removed by migration 0233/);
    const items = created.json.acceptanceCriteriaItems as Array<Record<string, unknown>>;
    assert.equal(items.length, 1);
    assert.equal(items[0].text, FIRST.text);
    assert.equal(items[0].verificationMethod, FIRST.verificationMethod);
    // And it reached storage, rather than only being echoed back by the projection.
    assert.equal(state.criteria.length, 1);
    assert.equal(state.criteria[0].text, FIRST.text);

    const id = created.json.id as string;
    const read = await send(base, 'GET', `/api/projects/${id}`);
    assert.equal(read.status, 200, `GET answered ${read.status}: ${read.body}`);
    const readItems = read.json.acceptanceCriteriaItems as Array<Record<string, unknown>>;
    assert.deepEqual(
      readItems.map((item) => [item.text, item.verificationMethod]),
      [[FIRST.text, FIRST.verificationMethod]],
    );

    const patched = await send(base, 'PATCH', `/api/projects/${id}`, {
      acceptanceCriteriaItems: [SECOND],
    });
    assert.equal(patched.status, 200, `PATCH answered ${patched.status}: ${patched.body}`);
    assert.doesNotMatch(patched.body, /was removed by migration 0233/);
    const patchedItems = patched.json.acceptanceCriteriaItems as Array<Record<string, unknown>>;
    assert.deepEqual(
      patchedItems.map((item) => [item.text, item.verificationMethod]),
      [[SECOND.text, SECOND.verificationMethod]],
    );
    assert.equal(state.criteria.length, 1);
    assert.equal(state.criteria[0].text, SECOND.text);
  });

  // The guard on the repair: making omission pass must not make sending one pass with it. Over
  // HTTP an explicit send is `null` or a value — JSON has no `undefined` — and both are refused.
  for (const field of REMOVED_CRITERION_WIRING_FIELDS) {
    for (const [label, value] of [
      ['null', null],
      ['a value', EXPLICIT_VALUES[field]],
    ] as const) {
      await t.test(`POST /projects sending ${field} as ${label} is still refused`, async () => {
        const before = state.criteria.length;
        const refused = await send(base, 'POST', '/api/projects', {
          title: `explicit ${field}`,
          acceptanceCriteriaItems: [{ ...FIRST, [field]: value }],
        });

        assert.equal(refused.status, 400, `POST answered ${refused.status}: ${refused.body}`);
        assert.match(
          refused.body,
          new RegExp(`acceptance criterion ${field} was removed by migration 0233`),
        );
        assert.equal(state.criteria.length, before, 'a refused criterion was written anyway');
      });

      await t.test(`PATCH /projects/:id sending ${field} as ${label} is still refused`, async () => {
        const target = await send(base, 'POST', '/api/projects', { title: `patch ${field}` });
        assert.equal(target.status, 201, `POST answered ${target.status}: ${target.body}`);
        const before = state.criteria.length;

        const refused = await send(base, 'PATCH', `/api/projects/${target.json.id as string}`, {
          acceptanceCriteriaItems: [{ ...FIRST, [field]: value }],
        });

        assert.equal(refused.status, 400, `PATCH answered ${refused.status}: ${refused.body}`);
        assert.match(
          refused.body,
          new RegExp(`acceptance criterion ${field} was removed by migration 0233`),
        );
        assert.equal(state.criteria.length, before, 'a refused criterion was written anyway');
      });
    }
  }
});
