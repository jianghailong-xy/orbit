import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { RunnerOrchestrationAuthorizer } from '../runner-api/runner-orchestration-authorizer';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectHandoffService } from './project-handoff.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { SessionAttemptService } from './session-attempt.service';
import { TaskCheckpointService } from './task-checkpoint.service';

/**
 * Binding a Project to a code line, over real HTTP, through the real pipe and the real service.
 *
 * WHY THIS EXISTS. Migration 0231 landed `project_codebase` with every constraint, and
 * `project-codebase-schema.pg.spec.ts` proved all fourteen of them hold — against rows it wrote
 * itself in raw SQL. Outside a spec file, `grep -rnE 'projectCodebase\.(create|update|upsert|
 * delete)' src/apiserver/src` matched NOTHING, so no person and no client could bind anything: the
 * data model was true and the product capability was not. This file is about the door, and it has
 * to go over HTTP because half of what is being asserted is what the PIPE does — `whitelist: true`
 * silently STRIPS an undeclared property, so "configRevision is refused" and "configRevision is
 * quietly dropped and the caller believes it was stored" are indistinguishable from inside the
 * service.
 *
 * Only PostgreSQL is faked, and it is faked in the direction that cannot flatter the code: the
 * store below never applies a default, so a value this surface fails to send is `undefined` in the
 * recorded write and every assertion about it fails loudly. What the real database's trigger and
 * CHECKs do with the same writes is `project-codebase-binding.pg.spec.ts`, which drives this same
 * service against a real one.
 */

const OWNER_ID = randomUUID();
const OTHER_OWNER_ID = randomUUID();

/** A legal REMOTE binding, as a caller writes it. */
const REMOTE_BINDING = {
  canonicalRepoUrl: 'https://github.com/jianghailong-xy/orbit',
  upstreamRef: 'refs/heads/main',
  refAuthority: 'REMOTE',
};

type CodebaseRow = {
  id: string;
  projectId: string;
  ownerId: string;
  slot: string;
  canonicalRepoUrl: string;
  rootCommitSha: string | null;
  upstreamRef: string;
  integrationRef: string;
  refAuthority: string;
  remoteName: string;
  authorityRunnerId: string | null;
  configRevision: bigint;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * `main.ts` installs this so that a BIGINT column can leave in a JSON body at all. Installed here
 * too, because `configRevision` IS one and the wire spelling it produces — a decimal string, not a
 * number — is part of what this file asserts is read back.
 */
BigInt.prototype.toJSON = function () {
  return this.toString();
};

/** Two projects (one per owner), one runner, and every codebase row ever written. */
function fakePrisma() {
  const projects = new Map<string, string>();
  const runners = new Map<string, string>();
  const state = { codebases: [] as CodebaseRow[], writes: [] as Record<string, unknown>[] };

  const client = {
    project: {
      findFirst: async ({ where }: { where: { id: string; ownerId: string } }) =>
        (projects.get(where.id) === where.ownerId ? { id: where.id } : null),
    },
    runner: {
      findFirst: async ({ where }: { where: { id: string; ownerId: string } }) =>
        (runners.get(where.id) === where.ownerId ? { id: where.id } : null),
    },
    projectCodebase: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        // Recorded BEFORE anything is defaulted, so a test can ask what the service actually
        // asked the database to write rather than what the row ended up looking like.
        state.writes.push({ ...data });
        if (state.codebases.some((row) => row.projectId === data.projectId
          && row.slot === data.slot)) {
          // `project_codebase_project_slot_key`, reported the way the driver reports it, so the
          // service's own P2002 branch is what runs. That the INDEX exists is the pg spec's to
          // prove; that a duplicate is answered 409 rather than 500 is this file's.
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'probe',
          });
        }
        const row: CodebaseRow = {
          id: randomUUID(),
          rootCommitSha: null,
          createdAt: new Date('2026-09-05T00:00:00.000Z'),
          updatedAt: new Date('2026-09-05T00:00:00.000Z'),
          ...(data as unknown as Omit<CodebaseRow, 'id' | 'rootCommitSha' | 'createdAt' | 'updatedAt'>),
          // The trigger's word, not the caller's: `project_codebase_config_guard` sets this to 0
          // on INSERT whatever arrives (SR8). Written LAST so that a service which passed a
          // `configRevision` through could not make this line agree with it by accident.
          configRevision: 0n,
        };
        state.codebases.push(row);
        // A COPY, for the reason a real Prisma client hands back a fresh object every time: the
        // response interceptor rewrites ids in place on whatever the handler returned, so a store
        // that returned its own row would find its `projectId` rewritten to base62 by the reply —
        // and would never match it again.
        return { ...row };
      },
      findFirst: async (
        { where }: { where: { projectId: string; ownerId: string; slot: string } },
      ) => {
        const row = state.codebases.find((candidate) => candidate.projectId === where.projectId
          && candidate.ownerId === where.ownerId && candidate.slot === where.slot);
        return row === undefined ? null : { ...row };
      },
    },
  };
  return { client, state, projects, runners };
}

const { client: prisma, state, projects, runners } = fakePrisma();

const BOUND_PROJECT = randomUUID();
const UNBOUND_PROJECT = randomUUID();
const OTHER_OWNERS_PROJECT = randomUUID();
const AUTHORITY_RUNNER = randomUUID();
const FOREIGN_RUNNER = randomUUID();

projects.set(BOUND_PROJECT, OWNER_ID);
projects.set(UNBOUND_PROJECT, OWNER_ID);
projects.set(OTHER_OWNERS_PROJECT, OTHER_OWNER_ID);
runners.set(AUTHORITY_RUNNER, OWNER_ID);
runners.set(FOREIGN_RUNNER, OTHER_OWNER_ID);

const refuse = (name: string) => () => {
  throw new Error(`${name} must not be reached by this probe`);
};

@Module({
  controllers: [ProjectsController, RunnerProjectsController],
  providers: [
    { provide: ProjectsService, useFactory: () => new ProjectsService(prisma as never) },
    { provide: ProjectAcceptanceService, useValue: { recordMergeEvidence: refuse('acceptance') } },
    { provide: ProjectHandoffService, useValue: { listForProject: refuse('handoffs') } },
    { provide: SessionAttemptService, useValue: { describe: refuse('attempts') } },
    { provide: TaskCheckpointService, useValue: { record: refuse('checkpoints') } },
    { provide: RunnerOrchestrationAuthorizer, useValue: { assert: refuse('orchestration') } },
    JwtAuthGuard,
    RunnerAuthGuard,
    Reflector,
    { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: OWNER_ID }) } },
    // The runner door's guard runs for real, so its 403 is reached the way an agent reaches it —
    // authenticated as a runner of this same account, refused on authority rather than on identity.
    {
      provide: PrismaService,
      useValue: { runner: { findFirst: async () => ({ id: AUTHORITY_RUNNER, ownerId: OWNER_ID }) } },
    },
  ],
})
class CodebaseModule {}

type Sent = { status: number; body: string; json: Record<string, unknown> };

async function send(
  base: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  as: 'user' | 'runner' = 'user',
): Promise<Sent> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(as === 'user'
        ? { authorization: 'Bearer an-ordinary-actor' }
        : { 'x-runner-token': 'a-runner-of-this-account' }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text, json: JSON.parse(text) };
}

/**
 * A project of this owner that nothing has bound yet, in base62.
 *
 * One per refusal case rather than a shared one, and it is not tidiness: every negative below
 * expects a 400, and a project that a PREVIOUS negative accidentally bound answers 409 instead.
 * That still fails, but it fails describing a slot conflict — so the first regression in this file
 * would disguise every later one as its own side effect. Found by mutating the refusal away and
 * reading what the failures said.
 */
function freshProject(): string {
  const id = randomUUID();
  projects.set(id, OWNER_ID);
  return uuidToBase62(id);
}

/** Every value refusal on this surface answers with one code and the fix action §10.1 pairs it
 *  with — asserted per case rather than assumed, because "the code is stable" is the claim. */
function assertRefusedAsAuthorityInvalid(sent: Sent, because: string) {
  assert.equal(sent.status, 400, `${because}: answered ${sent.status} — ${sent.body}`);
  assert.equal(sent.json.code, 'CODEBASE_AUTHORITY_INVALID', `${because}: ${sent.body}`);
  assert.equal(sent.json.fixAction, 'FIX_CODEBASE_CONFIG', `${because}: ${sent.body}`);
}

test('a Project’s code binding is created and read back over HTTP', async (t) => {
  const app = await NestFactory.create(CodebaseModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  // main.ts's pipe, with its options. `whitelist: true` is half of what this file asserts.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  const bound = uuidToBase62(BOUND_PROJECT);
  const unbound = uuidToBase62(UNBOUND_PROJECT);

  await t.test('an unbound Project reads as having no code line, not as missing', async () => {
    const read = await send(base, 'GET', `/api/projects/${unbound}/codebase`);
    assert.equal(read.status, 200, `GET answered ${read.status}: ${read.body}`);
    // SR5: a Project is allowed to have no code line. `null` is the answer; a 404 would be a
    // statement about the PROJECT, which is the one thing this read must not confuse it with.
    assert.deepEqual(read.json, { codebase: null });
  });

  await t.test('POST binds it, and the response carries the four declared fields', async () => {
    const created = await send(base, 'POST', `/api/projects/${bound}/codebase`, REMOTE_BINDING);
    assert.equal(created.status, 201, `POST answered ${created.status}: ${created.body}`);

    const row = created.json;
    assert.equal(row.projectId, bound, created.body);
    assert.equal(row.canonicalRepoUrl, REMOTE_BINDING.canonicalRepoUrl);
    // The four §3.1 fields the acceptance criterion names, on the way back out.
    assert.equal(row.upstreamRef, 'refs/heads/main');
    // Not sent, and written equal to `upstreamRef` rather than left blank: a project that never
    // says otherwise merges back where it branched from (§3.1, SR44).
    assert.equal(row.integrationRef, 'refs/heads/main');
    assert.equal(row.refAuthority, 'REMOTE');
    // A decimal STRING, because the column is BIGINT — the same spelling `SessionSourceSnapshot`
    // already serves it in, so a client comparing "the configuration this session froze" against
    // "the configuration now" compares like with like.
    assert.equal(row.configRevision, '0');
    // v1's one slot, chosen by the server.
    assert.equal(row.slot, 'primary');
    assert.equal(row.remoteName, 'origin');
    assert.equal(row.rootCommitSha, null);
    assert.equal(row.authorityRunnerId, null);
    // An address, rendered base62 like every other id on the way out (`PUBLIC_ID_FIELDS`).
    assert.match(String(row.id), /^[0-9A-Za-z]{20,22}$/, created.body);

    const read = await send(base, 'GET', `/api/projects/${bound}/codebase`);
    assert.equal(read.status, 200, `GET answered ${read.status}: ${read.body}`);
    // Read back through a different route, and identical: the same field names, the same public
    // id spelling, the same configRevision.
    assert.deepEqual(read.json.codebase, created.json);
  });

  await t.test('a second binding for the same project is refused, not silently second', async () => {
    const again = await send(base, 'POST', `/api/projects/${bound}/codebase`, {
      ...REMOTE_BINDING,
      canonicalRepoUrl: 'https://github.com/jianghailong-xy/somewhere-else',
    });
    assert.equal(again.status, 409, `POST answered ${again.status}: ${again.body}`);
    assert.equal(state.codebases.filter((row) => row.projectId === BOUND_PROJECT).length, 1);
  });

  await t.test('upstreamRef: a full-name ref binds, a short name is refused', async () => {
    // The positive half is the binding above (`refs/heads/main`, read back verbatim). This is the
    // negative one: SR9's ambiguity, refused at the write rather than on the day a run resolves it.
    const short = await send(base, 'POST', `/api/projects/${freshProject()}/codebase`, {
      ...REMOTE_BINDING,
      upstreamRef: 'main',
    });
    assertRefusedAsAuthorityInvalid(short, 'a short upstreamRef');
    assert.match(short.json.message as string, /upstreamRef/);
    // `refs/heads/ main` is a ref git itself will not take; accepting it would store a baseline
    // that can never resolve, and nothing would find out until a run tried.
    const spaced = await send(base, 'POST', `/api/projects/${freshProject()}/codebase`, {
      ...REMOTE_BINDING,
      upstreamRef: 'refs/heads/ main',
    });
    assertRefusedAsAuthorityInvalid(spaced, 'an upstreamRef with whitespace in it');
  });

  await t.test('integrationRef: a full-name ref binds, a short name is refused', async () => {
    const stated = await send(base, 'POST', `/api/projects/${freshProject()}/codebase`, {
      ...REMOTE_BINDING,
      integrationRef: 'refs/heads/release',
    });
    assert.equal(stated.status, 201, `POST answered ${stated.status}: ${stated.body}`);
    assert.equal(stated.json.upstreamRef, 'refs/heads/main');
    assert.equal(stated.json.integrationRef, 'refs/heads/release');

    const short = await send(base, 'POST', `/api/projects/${freshProject()}/codebase`, {
      ...REMOTE_BINDING,
      integrationRef: 'release',
    });
    assertRefusedAsAuthorityInvalid(short, 'a short integrationRef');
    assert.match(short.json.message as string, /integrationRef/);
  });

  await t.test('refAuthority: both members bind, everything else is refused', async () => {
    const runnerLocal = await send(base, 'POST', `/api/projects/${freshProject()}/codebase`, {
      ...REMOTE_BINDING,
      refAuthority: 'RUNNER_LOCAL',
      authorityRunnerId: uuidToBase62(AUTHORITY_RUNNER),
    });
    assert.equal(runnerLocal.status, 201, `POST answered ${runnerLocal.status}: ${runnerLocal.body}`);
    assert.equal(runnerLocal.json.refAuthority, 'RUNNER_LOCAL');
    assert.equal(runnerLocal.json.authorityRunnerId, uuidToBase62(AUTHORITY_RUNNER));

    const unknown = await send(base, 'POST', `/api/projects/${freshProject()}/codebase`, {
      ...REMOTE_BINDING,
      refAuthority: 'LOCAL',
    });
    assertRefusedAsAuthorityInvalid(unknown, 'a refAuthority outside the closed set');
    assert.match(unknown.json.message as string, /REMOTE, RUNNER_LOCAL/);
  });

  await t.test('SR31 is a double condition, and both halves are refused', async () => {
    const orphan = await send(base, 'POST', `/api/projects/${freshProject()}/codebase`, {
      ...REMOTE_BINDING,
      refAuthority: 'RUNNER_LOCAL',
    });
    assertRefusedAsAuthorityInvalid(orphan, 'RUNNER_LOCAL with no authorityRunnerId');

    // The other half, and the reason it is a refusal rather than a harmless leftover: a REMOTE row
    // carrying a machine id would adopt it the moment somebody flipped the authority.
    const leftover = await send(base, 'POST', `/api/projects/${freshProject()}/codebase`, {
      ...REMOTE_BINDING,
      authorityRunnerId: uuidToBase62(AUTHORITY_RUNNER),
    });
    assertRefusedAsAuthorityInvalid(leftover, 'REMOTE carrying an authorityRunnerId');

    // Another account's machine is refused in the same wording as an unusable one: distinguishing
    // them would answer "does this id exist" for an id this caller has no business reading.
    const foreign = await send(base, 'POST', `/api/projects/${freshProject()}/codebase`, {
      ...REMOTE_BINDING,
      refAuthority: 'RUNNER_LOCAL',
      authorityRunnerId: uuidToBase62(FOREIGN_RUNNER),
    });
    assertRefusedAsAuthorityInvalid(foreign, 'an authorityRunnerId of another account');
  });

  await t.test('configRevision in the body is refused, never accepted and never stripped', async () => {
    const stated = await send(base, 'POST', `/api/projects/${freshProject()}/codebase`, {
      ...REMOTE_BINDING,
      configRevision: '7',
    });
    assertRefusedAsAuthorityInvalid(stated, 'a stated configRevision');
    assert.match(stated.json.message as string, /configRevision is not a caller's to state/);
    // The failure this refusal exists to prevent is not a corrupted row — the trigger would have
    // overwritten the value anyway. It is a caller who reads 201 and believes a version number was
    // theirs to choose, and then reasons about "did this session freeze THIS configuration" with a
    // number they made up. So: nothing was written, and nothing was quietly dropped either.
    assert.equal(state.writes.every((data) => data.configRevision === undefined), true);
    // And the value on a row that WAS created came from the store, not from the request.
    const created = state.codebases.find((row) => row.projectId === BOUND_PROJECT);
    assert.equal(created?.configRevision, 0n);
  });

  await t.test('rootCommitSha has no door here at all — stating one is refused', async () => {
    const stated = await send(base, 'POST', `/api/projects/${freshProject()}/codebase`, {
      ...REMOTE_BINDING,
      rootCommitSha: 'a'.repeat(40),
    });
    assertRefusedAsAuthorityInvalid(stated, 'a stated rootCommitSha');
    assert.match(stated.json.message as string, /rootCommitSha is not a caller's to state/);
    // SR37: the column means "observed", and it is filled once by whatever first RESOLVES the
    // repository. This surface neither asks for it nor offers a way to change it, so the
    // fill-once trigger has nothing here to defend against.
    assert.equal(state.writes.every((data) => data.rootCommitSha === undefined), true);
    assert.equal(state.codebases.every((row) => row.rootCommitSha === null), true);
  });

  await t.test('slot is the server’s, so a stated one is refused rather than dropped', async () => {
    const stated = await send(base, 'POST', `/api/projects/${freshProject()}/codebase`, {
      ...REMOTE_BINDING,
      slot: 'secondary',
    });
    assertRefusedAsAuthorityInvalid(stated, 'a stated slot');
    // A silently stripped `slot` would read as "I created a second binding" to a caller who then
    // waits for a resolver that only ever reads `primary`.
    assert.equal(state.codebases.every((row) => row.slot === 'primary'), true);
  });

  await t.test('canonicalRepoUrl is an identity, so a clone-shaped one is refused', async () => {
    for (const [url, why] of [
      ['https://github.com/jianghailong-xy/orbit.git', 'a trailing .git'],
      ['https://github.com/jianghailong-xy/orbit/', 'a trailing slash'],
      [' https://github.com/jianghailong-xy/orbit', 'surrounding whitespace'],
      ['', 'an empty url'],
    ] as const) {
      const sent = await send(base, 'POST', `/api/projects/${freshProject()}/codebase`, {
        ...REMOTE_BINDING,
        canonicalRepoUrl: url,
      });
      assertRefusedAsAuthorityInvalid(sent, `canonicalRepoUrl with ${why}`);
    }
  });

  await t.test('another account’s project is a 404, not a binding', async () => {
    const sent = await send(
      base,
      'POST',
      `/api/projects/${uuidToBase62(OTHER_OWNERS_PROJECT)}/codebase`,
      REMOTE_BINDING,
    );
    assert.equal(sent.status, 404, `POST answered ${sent.status}: ${sent.body}`);
  });

  await t.test('the runner door refuses to bind, and says whose it is', async () => {
    const before = state.codebases.length;
    const sent = await send(
      base,
      'POST',
      `/api/runner/projects/${unbound}/codebase`,
      REMOTE_BINDING,
      'runner',
    );
    // 403, not 404: the caller is a model, and a bare 404 reads as "wrong URL, try another
    // spelling" rather than "this is not yours to write". Same boundary `coordinatorEnabled` and
    // `task.projectId` sit on, and a strictly larger grant than either — a binding decides where
    // every task in the project takes its code from.
    assert.equal(sent.status, 403, `runner POST answered ${sent.status}: ${sent.body}`);
    assert.match(sent.json.message as string, /account owner’s to set, not this session’s/);
    // And it names the door that can, rather than leaving an agent to guess.
    assert.match(sent.json.message as string, /web app or the user API/);
    assert.equal(state.codebases.length, before, 'the runner door wrote a binding');
  });
});
