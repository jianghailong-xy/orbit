/**
 * Binding a Project to a code line, on real PostgreSQL — the write surface and migration 0231's
 * constraints, driven together.
 *
 * WHY BOTH HALVES, IN ONE FILE. `project-codebase-schema.pg.spec.ts` proves the table's fourteen
 * constraints hold against rows it writes in raw SQL. `project-codebase-over-http.http.spec.ts`
 * proves the door refuses what the contract says it must, against a store that only remembers.
 * Neither can catch the failure that matters most here: a write surface that DISAGREES with the
 * database — one that refuses something Postgres would have accepted (a capability quietly lost),
 * or accepts something Postgres refuses (a 500 for a request that was merely wrong). So this file
 * runs the real `ProjectsService` against the real schema, and where it asserts a refusal it also
 * asserts that the same value written directly is refused by the database, for the same reason.
 *
 * The two properties the door cannot demonstrate about itself are here too, because both are the
 * database's to decide: `config_revision` is written by a trigger whatever the writer asked for
 * (SR8), and `root_commit_sha` is filled once by whatever OBSERVES it and immutable afterwards
 * (SR37).
 *
 * Destructive: it truncates. It refuses to run anywhere but the disposable server
 * `coordinator-pg-test-safety` identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { CreateProjectCodebaseDto } from './dto';
import { ProjectsService } from './projects.service';
import { decideSessionSource } from './session-source';

const URL = process.env.COORDINATOR_PG_URL;

/** The nine columns migration 0231 freezes at session create (§3.2). Named here, in the contract's
 *  own order, because "none of them moved" is the assertion and a list that drifted would make it
 *  vacuous. */
const CREATE_FROZEN_SELECTOR = [
  'source_kind',
  'source_codebase_id',
  'source_repo_url',
  'source_root_commit_sha',
  'source_ref',
  'source_revision_sha',
  'source_config_revision',
  'source_ref_authority',
  'source_required_contains',
] as const;

/** A legal REMOTE binding as a caller states it. */
const REMOTE_BINDING: CreateProjectCodebaseDto = {
  canonicalRepoUrl: 'https://github.com/acme/widgets',
  upstreamRef: 'refs/heads/main',
  refAuthority: 'REMOTE',
};

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  boundProject: string;
  unboundProject: string;
}

async function emptyWorld(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`
    TRUNCATE "run_event", "conversation_turn", "project_codebase", "task", "session",
             "workspace", "runner", "project", "user"
    RESTART IDENTITY CASCADE
  `);
}

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const boundProject = randomUUID();
  const unboundProject = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@pccs1w.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `x-${runnerId}`,
      status: RunnerStatus.ONLINE, maxConcurrent: 4,
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-ws`, enabled: true, workDir: `/tmp/${label}` },
  });
  await db.project.create({ data: { id: boundProject, ownerId, title: `${label} code` } });
  await db.project.create({ data: { id: unboundProject, ownerId, title: `${label} prose` } });
  return { ownerId, runnerId, workspaceId, boundProject, unboundProject };
}

/** The refusal `fn` produced, or '' if it did not refuse. */
async function message(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e: any) {
    // A Nest exception carries its structured body on `response`; a Postgres error carries only a
    // message. Both are flattened, so an assertion can name the code without caring which refused.
    return `${String(e?.response?.code ?? '')} ${String(e?.response?.message ?? e?.message ?? e)}`;
  }
  return '';
}

const suite = URL ? test : test.skip;

suite('a Project’s code binding, written through the real service on real PostgreSQL', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  const db = prismaClientFor(URL!);
  const projects = new ProjectsService(db as unknown as PrismaService);
  t.after(async () => {
    await db.$disconnect();
    await client.end();
  });

  await t.test('a binding is created through the user door and read back', async () => {
    await emptyWorld(client);
    const w = await world(db, 'create');

    const created = await projects.bindCodebase(w.ownerId, w.boundProject, REMOTE_BINDING);
    assert.equal(created.canonicalRepoUrl, REMOTE_BINDING.canonicalRepoUrl);
    assert.equal(created.upstreamRef, 'refs/heads/main');
    assert.equal(created.integrationRef, 'refs/heads/main');
    assert.equal(created.refAuthority, 'REMOTE');
    assert.equal(created.remoteName, 'origin');
    assert.equal(created.slot, 'primary');

    // Read back through the other route, and identical.
    const read = await projects.codebase(w.ownerId, w.boundProject);
    assert.deepEqual(read.codebase, created);

    // And it is a row in the real table, not a projection: the resolver that decides a session's
    // SOURCE reads `project_codebase` directly, and this is the first thing that ever put one
    // there outside a spec's own fixture.
    const rows = await client.query('SELECT * FROM "project_codebase" WHERE "id" = $1', [created.id]);
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].project_id, w.boundProject);
    assert.equal(rows.rows[0].owner_id, w.ownerId);
  });

  await t.test('config_revision is the trigger’s answer, never the writer’s (SR8)', async () => {
    await emptyWorld(client);
    const w = await world(db, 'revision');
    const created = await projects.bindCodebase(w.ownerId, w.boundProject, REMOTE_BINDING);
    // The door has no spelling for it, and the row starts at the trigger's 0.
    assert.equal(created.configRevision, 0n);

    // The half no door can show: a writer that DOES send a value — this goes around the surface,
    // straight at the table — has it overwritten rather than honoured. That is what makes the
    // number answerable: "is this the configuration that session froze" is a comparison, and a
    // comparison against a number the writer chose answers nothing.
    await db.projectCodebase.update({
      where: { id: created.id },
      data: { configRevision: 99n, upstreamRef: 'refs/heads/next' },
    });
    const bumped = await db.projectCodebase.findUniqueOrThrow({ where: { id: created.id } });
    assert.equal(bumped.configRevision, 1n, 'the trigger took the writer’s 99');
    assert.equal(bumped.upstreamRef, 'refs/heads/next');

    // And a write that changes nothing does not advance it: the counter counts CONFIGURATION
    // changes, so a no-op touch cannot make a frozen snapshot look stale.
    await db.projectCodebase.update({
      where: { id: created.id },
      data: { configRevision: 4242n },
    });
    const still = await db.projectCodebase.findUniqueOrThrow({ where: { id: created.id } });
    assert.equal(still.configRevision, 1n);
  });

  await t.test('root_commit_sha is observed once, and this door cannot state or move it (SR37)', async () => {
    await emptyWorld(client);
    const w = await world(db, 'rootsha');
    const created = await projects.bindCodebase(w.ownerId, w.boundProject, REMOTE_BINDING);
    // "Not observed yet" — which is what NULL MEANS here, and why the create surface does not ask
    // for it. A person filling it in would be guessing a fact, and a wrong guess renames the
    // repository for every snapshot already frozen against it.
    assert.equal(created.rootCommitSha, null);

    // Stating it is refused at the door...
    const stated = await message(() => projects.bindCodebase(
      w.ownerId,
      w.unboundProject,
      { ...REMOTE_BINDING, rootCommitSha: 'a'.repeat(40) } as unknown as CreateProjectCodebaseDto,
    ));
    assert.match(stated, /CODEBASE_AUTHORITY_INVALID/);
    assert.match(stated, /rootCommitSha is not a caller's to state/);

    // ...and the fill-once semantics this door stays out of the way of are intact: the first
    // observation lands, the second is refused by the trigger.
    const sha = 'b'.repeat(40);
    await db.projectCodebase.update({ where: { id: created.id }, data: { rootCommitSha: sha } });
    const observed = await db.projectCodebase.findUniqueOrThrow({ where: { id: created.id } });
    assert.equal(observed.rootCommitSha, sha);
    const rewrite = await message(() => db.projectCodebase.update({
      where: { id: created.id },
      data: { rootCommitSha: 'c'.repeat(40) },
    }));
    assert.match(rewrite, /CODEBASE_AUTHORITY_INVALID/);
    assert.match(rewrite, /repository identity is written once/);
  });

  await t.test('the door’s refusals are the database’s refusals, value for value', async () => {
    await emptyWorld(client);
    const w = await world(db, 'agree');
    // Each row: what a caller states, and the column/value that reaches the table if a surface
    // simply passed it through. Asserting BOTH ends is the point — a door that refused something
    // Postgres accepts would be a capability quietly lost, and one that accepted something
    // Postgres refuses would turn a wrong request into a 500.
    const cases: Array<[string, Partial<CreateProjectCodebaseDto>, Record<string, unknown>]> = [
      ['a short upstreamRef', { upstreamRef: 'main' }, { upstream_ref: 'main' }],
      ['a short integrationRef', { integrationRef: 'main' }, { integration_ref: 'main' }],
      ['a ref with whitespace', { upstreamRef: 'refs/heads/ main' }, { upstream_ref: 'refs/heads/ main' }],
      ['an unknown refAuthority', { refAuthority: 'LOCAL' }, { ref_authority: 'LOCAL' }],
      ['a url with a trailing .git', { canonicalRepoUrl: 'https://github.com/acme/widgets.git' },
        { canonical_repo_url: 'https://github.com/acme/widgets.git' }],
      ['a url with a trailing slash', { canonicalRepoUrl: 'https://github.com/acme/widgets/' },
        { canonical_repo_url: 'https://github.com/acme/widgets/' }],
      ['a padded url', { canonicalRepoUrl: ' https://github.com/acme/widgets' },
        { canonical_repo_url: ' https://github.com/acme/widgets' }],
    ];
    for (const [label, stated, column] of cases) {
      const refusal = await message(() => projects.bindCodebase(
        w.ownerId, w.unboundProject, { ...REMOTE_BINDING, ...stated },
      ));
      assert.match(refusal, /CODEBASE_AUTHORITY_INVALID/, `the door accepted ${label}`);

      // Raw SQL rather than Prisma for the other end, on purpose: what is being asked is what
      // POSTGRES does with the value, and a client-side validation layer in between would answer
      // a different question.
      const row = {
        id: randomUUID(),
        project_id: w.unboundProject,
        owner_id: w.ownerId,
        canonical_repo_url: REMOTE_BINDING.canonicalRepoUrl,
        upstream_ref: REMOTE_BINDING.upstreamRef,
        integration_ref: REMOTE_BINDING.upstreamRef,
        ref_authority: REMOTE_BINDING.refAuthority,
        ...column,
      };
      const columns = Object.keys(row);
      const direct = await message(() => client.query(
        `INSERT INTO "project_codebase" (${columns.map((c) => `"${c}"`).join(', ')}, "updated_at")
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}, now())`,
        Object.values(row),
      ));
      assert.match(direct, /constraint|check/i, `PostgreSQL accepted ${label}`);
    }
    // Nothing landed: every one of them was refused at one end or the other.
    const count = await db.projectCodebase.count({ where: { projectId: w.unboundProject } });
    assert.equal(count, 0);
  });

  await t.test('SR31’s double condition holds at the door and at the CHECK', async () => {
    await emptyWorld(client);
    const w = await world(db, 'sr31');
    const orphan = await message(() => projects.bindCodebase(w.ownerId, w.unboundProject, {
      ...REMOTE_BINDING, refAuthority: 'RUNNER_LOCAL',
    }));
    assert.match(orphan, /CODEBASE_AUTHORITY_INVALID/);
    const leftover = await message(() => projects.bindCodebase(w.ownerId, w.unboundProject, {
      ...REMOTE_BINDING, authorityRunnerId: w.runnerId,
    }));
    assert.match(leftover, /CODEBASE_AUTHORITY_INVALID/);

    // The positive half, which the CHECK also has to accept: a RUNNER_LOCAL binding naming this
    // account's machine.
    const local = await projects.bindCodebase(w.ownerId, w.boundProject, {
      ...REMOTE_BINDING, refAuthority: 'RUNNER_LOCAL', authorityRunnerId: w.runnerId,
    });
    assert.equal(local.refAuthority, 'RUNNER_LOCAL');
    assert.equal(local.authorityRunnerId, w.runnerId);
  });

  await t.test('one binding per project, and two projects may share a repository', async () => {
    await emptyWorld(client);
    const w = await world(db, 'slot');
    await projects.bindCodebase(w.ownerId, w.boundProject, REMOTE_BINDING);
    const second = await message(() => projects.bindCodebase(w.ownerId, w.boundProject, {
      ...REMOTE_BINDING, canonicalRepoUrl: 'https://github.com/acme/other',
    }));
    // `project_codebase_project_slot_key`, reported as a conflict rather than as an engine error.
    assert.match(second, /already bound to a code line/);

    // And the absence that is deliberate: there is NO unique index on
    // `(canonical_repo_url, root_commit_sha)`. Two projects pointing at the same repository is an
    // ordinary thing to want — a product and its docs, a rewrite beside the thing being rewritten
    // — and forbidding it would make "which project is this work for" a property of the checkout.
    const shared = await projects.bindCodebase(w.ownerId, w.unboundProject, REMOTE_BINDING);
    assert.equal(shared.canonicalRepoUrl, REMOTE_BINDING.canonicalRepoUrl);
    const both = await db.projectCodebase.count({
      where: { canonicalRepoUrl: REMOTE_BINDING.canonicalRepoUrl },
    });
    assert.equal(both, 2);
  });

  await t.test('binding writes nothing into a session’s frozen SOURCE selector', async () => {
    await emptyWorld(client);
    const w = await world(db, 'freeze');
    const codebase = await projects.bindCodebase(w.ownerId, w.boundProject, REMOTE_BINDING);
    const task = await db.task.create({
      data: {
        ownerId: w.ownerId, projectId: w.boundProject, title: 'code work',
        creatorType: 'USER', creatorId: w.ownerId, completionCriterion: 'EVIDENCE_JUDGMENT',
      },
      select: {
        id: true, projectId: true, verifiesTaskId: true, pinnedRevision: true,
        codeless: true, attemptGeneration: true, knownGoodSha: true,
      },
    });
    const decision = await decideSessionSource(db as unknown as PrismaService, task);
    const session = await db.session.create({
      data: {
        title: 'run', prompt: 'do the thing', status: RunStatus.PENDING,
        ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId,
        assignedRunnerId: w.runnerId, taskId: task.id, provider: 'claude', providerBuiltin: true,
        ...decision.columns,
      },
      select: { id: true },
    });
    // The session resolved against this binding, so it has something to lose.
    const before = await client.query(
      `SELECT ${CREATE_FROZEN_SELECTOR.map((c) => `"${c}"`).join(', ')}
       FROM "session" WHERE "id" = $1`,
      [session.id],
    );
    assert.equal(before.rows[0].source_codebase_id, codebase.id);

    // Now use the write surface as hard as it can be used against this project: a second bind
    // (refused), and a bind on another project. Neither is a path to the nine columns.
    await message(() => projects.bindCodebase(w.ownerId, w.boundProject, REMOTE_BINDING));
    await projects.bindCodebase(w.ownerId, w.unboundProject, REMOTE_BINDING);
    const after = await client.query(
      `SELECT ${CREATE_FROZEN_SELECTOR.map((c) => `"${c}"`).join(', ')}
       FROM "session" WHERE "id" = $1`,
      [session.id],
    );
    assert.deepEqual(after.rows[0], before.rows[0]);

    // And the freeze itself is unbroken, which is what makes the assertion above mean something:
    // if the nine columns were writable, "the surface did not write them" would be a fact about
    // this run rather than about the surface.
    // A value of the right TYPE per column, so what refuses the statement is the freeze guard and
    // not a type error that would have refused an empty column just as well.
    const otherValue: Record<(typeof CREATE_FROZEN_SELECTOR)[number], string> = {
      source_kind: `'PINNED_REVISION'`,
      source_codebase_id: `'${randomUUID()}'`,
      source_repo_url: `'https://github.com/acme/elsewhere'`,
      source_root_commit_sha: `'${'e'.repeat(40)}'`,
      source_ref: `'refs/heads/moved'`,
      source_revision_sha: `'${'f'.repeat(40)}'`,
      source_config_revision: '77',
      source_ref_authority: `'RUNNER_LOCAL'`,
      source_required_contains: `'{"${'d'.repeat(40)}"}'::CHAR(40)[]`,
    };
    for (const column of CREATE_FROZEN_SELECTOR) {
      const refusal = await message(() => client.query(
        `UPDATE "session" SET "${column}" = ${otherValue[column]} WHERE "id" = $1`,
        [session.id],
      ));
      assert.match(refusal, /SOURCE_PIN_IMMUTABLE/, `${column} was writable after create`);
    }
  });

  await t.test('a Project with no binding stays a Project — tasks, sessions, UNBOUND (SR5)', async () => {
    await emptyWorld(client);
    const w = await world(db, 'unbound');
    // Nothing bound anywhere. This is the half of acceptance criterion 1 that says a non-code
    // Project is not forced into Git, and it has to keep being true AFTER a write surface exists:
    // the easiest way to break it is to make binding a precondition of something.
    assert.deepEqual(await projects.codebase(w.ownerId, w.unboundProject), { codebase: null });

    const task = await db.task.create({
      data: {
        ownerId: w.ownerId, projectId: w.unboundProject, title: 'write the docs',
        creatorType: 'USER', creatorId: w.ownerId, completionCriterion: 'EVIDENCE_JUDGMENT',
      },
      select: {
        id: true, projectId: true, verifiesTaskId: true, pinnedRevision: true,
        codeless: true, attemptGeneration: true, knownGoodSha: true,
      },
    });
    const decision = await decideSessionSource(db as unknown as PrismaService, task);
    assert.equal(decision.columns.sourceState, 'UNBOUND');
    const session = await db.session.create({
      data: {
        title: 'prose', prompt: 'write it', status: RunStatus.PENDING,
        ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId,
        assignedRunnerId: w.runnerId, taskId: task.id, provider: 'claude', providerBuiltin: true,
        ...decision.columns,
      },
      select: { id: true },
    });
    const row = await client.query(
      `SELECT "source_state", ${CREATE_FROZEN_SELECTOR.map((c) => `"${c}"`).join(', ')}
       FROM "session" WHERE "id" = $1`,
      [session.id],
    );
    assert.equal(row.rows[0].source_state, 'UNBOUND');
    // Every snapshot column empty — the Legacy shape, byte for byte what a session created before
    // migration 0231 reads as.
    for (const column of CREATE_FROZEN_SELECTOR) {
      const value = row.rows[0][column];
      assert.deepEqual(
        column === 'source_required_contains' ? value : value ?? null,
        column === 'source_required_contains' ? [] : null,
        `${column} was written for an unbound project`,
      );
    }
  });
});
