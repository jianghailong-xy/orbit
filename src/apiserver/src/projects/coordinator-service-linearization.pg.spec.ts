import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { COORDINATOR_UNAVAILABLE_CODE, ProjectsService } from './projects.service';
import { WorkspacesService } from '../workspaces/workspaces.service';

/**
 * The four repairs of validation 04 that are claims about ORDER and FAILURE, asserted where those
 * words mean something: a real server, real row locks, two real connections, and faults injected
 * into the database rather than into a stub.
 *
 * A model can be made to say anything about a race. `FOR SHARE` conflicting with the UPDATE that
 * soft-deletes an agent, a deferred trigger counting a rotation at COMMIT, a transaction that
 * throws leaving a session that was created outside it — none of those are claims about this
 * service's code, they are claims about what Postgres does with what it sends. So they run here.
 *
 * Skipped unless a disposable database with the full schema is pointed at it:
 *
 *   COORDINATOR_PG_URL=postgres://pcc03a_admin:***@127.0.0.1:45437/pcc03a_verify \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc03a_verify COORDINATOR_PG_EXPECTED_USER=pcc03a_admin \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=<...> \
 *   node --test build/projects/coordinator-service-linearization.pg.spec.js
 */
const URL = process.env.COORDINATOR_PG_URL;

const OWNER_ID = '00000000-0000-7000-8000-0000000005a1';
const RUNNER_ID = '00000000-0000-7000-8000-0000000005a2';
const AGENT = '00000000-0000-7000-8000-0000000005b1';
const AGENT_OTHER = '00000000-0000-7000-8000-0000000005b2';
const SESSION_OLD = '00000000-0000-7000-8000-0000000005c1';
const TASK_ID = '00000000-0000-7000-8000-0000000005d1';
/** Sessions the coordinator path creates, handed out in order so each call is identifiable. */
const MINTED = [
  '00000000-0000-7000-8000-0000000005e1',
  '00000000-0000-7000-8000-0000000005e2',
  '00000000-0000-7000-8000-0000000005e3',
];

type ClientCtor = new (config: { connectionString?: string }) => Client;
type PrismaCtor = new (config: { datasources: { db: { url: string } } }) => any;

const skip = URL ? false : 'set COORDINATOR_PG_URL to run';

/**
 * A sessions service that writes real rows: `create` inserts one, `remove` SOFT-DELETES it, which
 * is what `SessionsService.remove` does and what makes "is there a live orphan" a question the
 * database can answer.
 */
function sessionsFor(prisma: any) {
  const minted: string[] = [];
  return {
    minted,
    service: {
      create: async (_owner: string, dto: { workspaceId: string; title: string }) => {
        const id = MINTED[minted.length];
        minted.push(id);
        await prisma.session.create({
          data: {
            id,
            ownerId: OWNER_ID,
            creatorId: OWNER_ID,
            workspaceId: dto.workspaceId,
            title: dto.title,
            prompt: 'x',
          },
        });
        return { id };
      },
      remove: async (_owner: string, id: string) => {
        await prisma.session.update({ where: { id }, data: { deletedAt: new Date() } });
        return { ok: true };
      },
      end: async () => ({ ok: true }),
    } as never,
  };
}

async function open() {
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const probe = new Ctor({ connectionString: URL });
  await probe.connect();
  await verifyCoordinatorPgIdentity(probe);

  const { PrismaClient } = (await import('@prisma/client')) as unknown as { PrismaClient: PrismaCtor };
  const prisma = new PrismaClient({ datasources: { db: { url: URL! } } });
  /** A second pool, so a transaction on one can genuinely block a transaction on the other. */
  const other = new PrismaClient({ datasources: { db: { url: URL! } } });

  /**
   * Close everything this function has opened, for the path where it never gets to return.
   *
   * `open()` creates three live connections and hands them to the caller inside an object whose
   * `teardown` closes them. Everything between the last `new` and the `return` is therefore a
   * window in which a throw leaks all three: node keeps their sockets, the test run passes, and
   * the process simply never exits — which is what it did, for three and a half minutes, with
   * every backend sitting idle in ClientRead and nothing to see in pg_stat_activity. The throw
   * that opened that window was a `wipe()` against a database whose schema an earlier spec had
   * altered; the window is the bug either way.
   */
  const release = async () => {
    await probe.end().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    await other.$disconnect().catch(() => {});
  };

  const wipe = async () => {
    await prisma.task.deleteMany({ where: { ownerId: OWNER_ID } });
    await prisma.projectMember.deleteMany({ where: { project: { ownerId: OWNER_ID } } });
    await prisma.projectRuntime.deleteMany({ where: { project: { ownerId: OWNER_ID } } });
    await prisma.project.deleteMany({ where: { ownerId: OWNER_ID } });
    await prisma.session.deleteMany({ where: { ownerId: OWNER_ID } });
    await prisma.workspace.deleteMany({ where: { ownerId: OWNER_ID } });
    await prisma.runner.deleteMany({ where: { ownerId: OWNER_ID } });
    await prisma.user.deleteMany({ where: { id: OWNER_ID } });
  };
  try {
    await wipe();
    await prisma.user.create({
      data: { id: OWNER_ID, email: `pcc03a-${OWNER_ID}@example.test`, name: 'pcc03a', passwordHash: 'x' },
    });
    await prisma.runner.create({
      data: { id: RUNNER_ID, ownerId: OWNER_ID, name: 'pcc03a runner', tokenHash: 'x' },
    });
    await prisma.workspace.createMany({
      data: [
        { id: AGENT, ownerId: OWNER_ID, runnerId: RUNNER_ID, name: 'agent' },
        { id: AGENT_OTHER, ownerId: OWNER_ID, runnerId: RUNNER_ID, name: 'other agent' },
      ],
    });
  } catch (e) {
    await release();
    throw e;
  }

  const sessions = sessionsFor(prisma);
  return {
    prisma,
    other,
    probe,
    minted: sessions.minted,
    service: new ProjectsService(prisma, sessions.service),
    /** The real delete path, on the OTHER connection: this is the writer being linearized against. */
    workspaces: new WorkspacesService(other),
    serviceOn: (client: any) => new ProjectsService(client, sessionsFor(client).service),
    teardown: async () => {
      // The wipe is best-effort and the release is not: a fixture that cannot be cleaned up is a
      // dirty database, while a connection that is not closed is a process that never exits.
      await wipe().catch(() => {});
      await release();
    },
  };
}

/**
 * The same client, with one call paused: it runs, then waits for `release` before returning.
 *
 * `where` picks WHICH read pauses, and that is the whole design of these two tests. `pre` pauses
 * the liveness check that happens BEFORE the transaction — the window validation 04 slipped a
 * delete through. `inTx` pauses a read INSIDE it, after the agent's row lock has been taken, which
 * is the window that must now block the delete instead.
 */
function paused(prisma: any, where: 'pre' | 'inTx', reached: () => void, release: Promise<void>) {
  const hook = (model: any, name: string) =>
    new Proxy(model, {
      get(m, prop, receiver) {
        if (prop === name) {
          return async (...args: unknown[]) => {
            const result = await m[name](...args);
            reached();
            await release;
            return result;
          };
        }
        const value = Reflect.get(m, prop, receiver);
        return typeof value === 'function' ? value.bind(m) : value;
      },
    });

  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === 'workspace' && where === 'pre') return hook(target.workspace, 'findFirst');
      if (prop === '$transaction') {
        return (arg: unknown, opts?: Record<string, unknown>) => {
          if (typeof arg !== 'function') return target.$transaction(arg, opts);
          // A longer budget than Prisma's five-second default: this transaction is deliberately
          // held open while another connection is watched blocking behind it.
          return target.$transaction(
            (tx: any) =>
              (arg as (tx: unknown) => unknown)(
                where === 'inTx'
                  ? new Proxy(tx, {
                      get(t, p, r) {
                        if (p === 'projectMember') return hook(t.projectMember, 'findFirst');
                        const v = Reflect.get(t, p, r);
                        return typeof v === 'function' ? v.bind(t) : v;
                      },
                    })
                  : tx,
              ),
            { ...opts, timeout: 20_000, maxWait: 20_000 },
          );
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Wait until some backend on this server is waiting on a lock — the other writer, blocked. */
async function waitForBlockedWriter(probe: Client): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await probe.query<{ n: string }>(
      `SELECT count(*) n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`,
    );
    if (Number(rows[0].n) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail('no writer ever blocked — the lock this test is about was not taken');
}

// ── An agent's soft delete and its coordinator membership (validation 04, P1-03) ───────────────

test('membership first: the delete waits, then finds a coordinator and is refused', { skip }, async () => {
  const f = await open();
  try {
    const project: any = await f.service.create(OWNER_ID, { title: 'pcc03a order A' } as never);
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const writing = new ProjectsService(paused(f.prisma, 'inTx', reached, gate), {} as never).update(
      OWNER_ID,
      project.id,
      { coordinatorAgentId: AGENT } as never,
    );
    await arrived; // inside the transaction, holding the project's row lock and the agent's

    const deleting = f.workspaces.remove(OWNER_ID, AGENT);
    await waitForBlockedWriter(f.probe); // ...and the delete is behind it, not racing past it
    release();

    await writing;
    await assert.rejects(deleting, (e: { status?: number }) => e.status === 409);

    const agent = await f.prisma.workspace.findUnique({ where: { id: AGENT } });
    const members = await f.prisma.projectMember.findMany({ where: { projectId: project.id } });
    assert.equal(agent.deletedAt, null, 'the agent a project coordinates with survives');
    assert.equal(members.length, 1);
    assert.equal(members[0].agentId, AGENT);
  } finally {
    await f.teardown();
  }
});

test('delete first: the membership is refused, and never points at a deleted agent', { skip }, async () => {
  const f = await open();
  try {
    const project: any = await f.service.create(OWNER_ID, { title: 'pcc03a order B' } as never);
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    // Paused where the check used to be the ONLY check: after the pre-transaction read saw a live
    // agent, before anything is locked. This is the exact interleaving validation 04 committed a
    // membership through.
    const writing = new ProjectsService(paused(f.prisma, 'pre', reached, gate), {} as never).update(
      OWNER_ID,
      project.id,
      { coordinatorAgentId: AGENT } as never,
    );
    await arrived;
    await f.workspaces.remove(OWNER_ID, AGENT); // commits: nothing is holding this row yet
    release();

    await assert.rejects(writing, (e: { status?: number; message?: string }) => {
      assert.equal(e.status, 400);
      return true;
    });
    const members = await f.prisma.projectMember.findMany({ where: { projectId: project.id } });
    assert.deepEqual(members, [], 'no membership may point at an agent that is gone');
    const agent = await f.prisma.workspace.findUnique({ where: { id: AGENT } });
    assert.notEqual(agent.deletedAt, null);
  } finally {
    await f.teardown();
  }
});

// ── A rotation lands where the coordinator belongs, or not at all (P1-02) ─────────────────────

test('a replacement is refused rather than moved when its workspace is gone', { skip }, async () => {
  const f = await open();
  try {
    const project: any = await f.service.create(OWNER_ID, { title: 'pcc03a home gone' } as never);
    await f.prisma.session.create({
      data: {
        id: SESSION_OLD,
        ownerId: OWNER_ID,
        creatorId: OWNER_ID,
        workspaceId: AGENT,
        title: 'first coordinator',
        prompt: 'x',
        deletedAt: new Date(),
      },
    });
    await f.prisma.project.update({
      where: { id: project.id },
      data: { coordinatorSessionId: SESSION_OLD, coordinatorWorkspaceId: AGENT },
    });
    // Somewhere to migrate TO, so that "it did not move" is a fact about behaviour rather than
    // about there being no alternative: this project's only task runs in the other agent.
    await f.prisma.task.create({
      data: {
        id: TASK_ID,
        title: 'work',
        ownerId: OWNER_ID,
        creatorType: 'USER',
        creatorId: OWNER_ID,
        assigneeId: AGENT_OTHER,
        projectId: project.id,
      },
    });
    await f.prisma.workspace.update({ where: { id: AGENT }, data: { deletedAt: new Date() } });

    await assert.rejects(
      () => f.service.coordinator(OWNER_ID, project.id),
      (e: { status?: number; getResponse?: () => { code?: string; owner?: string } }) => {
        assert.equal(e.status, 409);
        assert.equal(e.getResponse!().code, COORDINATOR_UNAVAILABLE_CODE);
        assert.equal(e.getResponse!().owner, 'USER');
        return true;
      },
    );

    const after = await f.prisma.project.findUnique({
      where: { id: project.id },
      include: { runtime: true },
    });
    assert.equal(after.coordinatorWorkspaceId, AGENT, 'the coordination workspace is not moved');
    assert.equal(after.coordinatorSessionId, SESSION_OLD);
    assert.equal(after.runtime.coordinatorGeneration, 0n, 'nothing rotated');
    assert.deepEqual(f.minted, [], 'and no session was opened anywhere');
  } finally {
    await f.teardown();
  }
});

test('naming a different workspace does not move a coordinator that is in Trash', { skip }, async () => {
  const f = await open();
  try {
    const project: any = await f.service.create(OWNER_ID, { title: 'pcc03a elsewhere' } as never);
    await f.prisma.session.create({
      data: {
        id: SESSION_OLD,
        ownerId: OWNER_ID,
        creatorId: OWNER_ID,
        workspaceId: AGENT,
        title: 'first coordinator',
        prompt: 'x',
        deletedAt: new Date(),
      },
    });
    await f.prisma.project.update({
      where: { id: project.id },
      data: { coordinatorSessionId: SESSION_OLD, coordinatorWorkspaceId: AGENT },
    });

    await assert.rejects(
      () => f.service.coordinator(OWNER_ID, project.id, AGENT_OTHER),
      (e: { status?: number }) => e.status === 409,
    );
    const after = await f.prisma.project.findUnique({ where: { id: project.id } });
    assert.equal(after.coordinatorWorkspaceId, AGENT);
    assert.deepEqual(f.minted, []);

    // Naming the workspace it actually belongs in is the same request, allowed: this is a fixed
    // landing spot, not a refusal to rotate.
    const result = await f.service.coordinator(OWNER_ID, project.id, AGENT);
    assert.equal(result.created, true);
    assert.equal(result.workspaceId, AGENT);
  } finally {
    await f.teardown();
  }
});

// ── A failure after the session exists leaves no orphan (P1-04) ───────────────────────────────

/**
 * A fault injected into the database, on the statement named, and removed again afterwards.
 *
 * Scoped by a WHEN clause to the one project this test owns. A trigger that fired for every row
 * would make this file fail whatever else happened to be running on the same disposable server —
 * including the other coordinator specs, which `node --test` runs in parallel processes.
 */
async function withFault(
  probe: Client,
  fault: { on: string; when: string; column: string; sqlstate?: string },
  projectId: string,
  body: () => Promise<void>,
): Promise<void> {
  const state = fault.sqlstate ? ` USING ERRCODE = '${fault.sqlstate}'` : '';
  await probe.query(`
    CREATE OR REPLACE FUNCTION pcc03a_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'pcc03a injected fault'${state}; END; $$;
    CREATE TRIGGER pcc03a_fault_trigger BEFORE ${fault.when} ON "${fault.on}"
    FOR EACH ROW WHEN (NEW."${fault.column}" = '${projectId}'::uuid) EXECUTE FUNCTION pcc03a_fault();
  `);
  try {
    await body();
  } finally {
    await probe.query(`DROP TRIGGER IF EXISTS pcc03a_fault_trigger ON "${fault.on}"`);
    await probe.query(`DROP FUNCTION IF EXISTS pcc03a_fault()`);
  }
}

for (const fault of [
  // The rotation count, which is written by a deferred trigger at COMMIT — so this one fails after
  // the swap statement has already reported success.
  {
    name: 'the rotation count fails at commit',
    on: 'project_runtime',
    when: 'INSERT OR UPDATE',
    column: 'project_id',
  },
  // The swap statement itself.
  { name: 'the swap statement fails outright', on: 'project', when: 'UPDATE', column: 'id' },
  // ...and the same, arriving as a foreign-key class error, which Prisma reports as a different
  // error type. The cleanup must not depend on recognising the failure.
  {
    name: 'the swap fails with a foreign-key error',
    on: 'project',
    when: 'UPDATE',
    column: 'id',
    sqlstate: '23503',
  },
]) {
  test(`no live orphan session survives when ${fault.name}`, { skip }, async () => {
    const f = await open();
    try {
      const project: any = await f.service.create(OWNER_ID, { title: 'pcc03a orphan' } as never);
      await f.prisma.session.create({
        data: {
          id: SESSION_OLD,
          ownerId: OWNER_ID,
          creatorId: OWNER_ID,
          workspaceId: AGENT,
          title: 'first coordinator',
          prompt: 'x',
          deletedAt: new Date(),
        },
      });
      await f.prisma.project.update({
        where: { id: project.id },
        data: { coordinatorSessionId: SESSION_OLD, coordinatorWorkspaceId: AGENT },
      });

      await withFault(f.probe, fault, project.id, async () => {
        await assert.rejects(() => f.service.coordinator(OWNER_ID, project.id));
      });

      // The project is exactly as it was: the swap rolled back with its transaction.
      const after = await f.prisma.project.findUnique({
        where: { id: project.id },
        include: { runtime: true },
      });
      assert.equal(after.coordinatorSessionId, SESSION_OLD);
      assert.equal(after.runtime.coordinatorGeneration, 0n);

      // And the session that failure left behind is not live. This is the whole finding: it was
      // created outside the transaction, so nothing rolls it back — somebody has to discard it.
      assert.equal(f.minted.length, 1, 'the call did create a session before it failed');
      const orphan = await f.prisma.session.findUnique({ where: { id: f.minted[0] } });
      assert.notEqual(orphan.deletedAt, null, 'the session no project points at must not be live');
      const live = await f.prisma.session.findMany({
        where: { ownerId: OWNER_ID, deletedAt: null, coordinatorForProject: null },
      });
      assert.deepEqual(live, [], 'no live session may be left with no project pointing at it');
    } finally {
      await f.teardown();
    }
  });
}

test('two callers replacing the same coordinator leave one winner and no orphan', { skip }, async () => {
  const f = await open();
  try {
    const project: any = await f.service.create(OWNER_ID, { title: 'pcc03a concurrent' } as never);
    await f.prisma.session.create({
      data: {
        id: SESSION_OLD,
        ownerId: OWNER_ID,
        creatorId: OWNER_ID,
        workspaceId: AGENT,
        title: 'first coordinator',
        prompt: 'x',
        deletedAt: new Date(),
      },
    });
    await f.prisma.project.update({
      where: { id: project.id },
      data: { coordinatorSessionId: SESSION_OLD, coordinatorWorkspaceId: AGENT },
    });

    const both = await Promise.allSettled([
      f.service.coordinator(OWNER_ID, project.id),
      f.service.coordinator(OWNER_ID, project.id),
    ]);
    const answered = both.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];

    const after = await f.prisma.project.findUnique({
      where: { id: project.id },
      include: { runtime: true },
    });
    // Whatever the two calls answered, the database holds one replacement and counts one.
    assert.equal(after.runtime.coordinatorGeneration, 1n);
    assert.notEqual(after.coordinatorSessionId, SESSION_OLD);
    for (const call of answered) assert.equal(call.value.workspaceId, AGENT);

    const live = await f.prisma.session.findMany({
      where: { ownerId: OWNER_ID, deletedAt: null, coordinatorForProject: null },
    });
    assert.deepEqual(live, [], 'the loser’s session is discarded, not left open');
  } finally {
    await f.teardown();
  }
});

// ── An old writer's project, read and rotated by the new code (P1-06) ─────────────────────────

test('a project inserted by a 0110 writer rotates correctly under the new service', { skip }, async () => {
  const f = await open();
  try {
    const id = '00000000-0000-7000-8000-0000000005f1';
    await f.prisma.session.create({
      data: {
        id: SESSION_OLD,
        ownerId: OWNER_ID,
        creatorId: OWNER_ID,
        workspaceId: AGENT,
        title: 'planned here',
        prompt: 'x',
        deletedAt: new Date(),
      },
    });
    // Exactly the columns the old binary writes, through raw SQL so that no part of this codebase
    // is involved in producing the row.
    await f.prisma.$executeRawUnsafe(`
      INSERT INTO "project" ("id", "owner_id", "title", "coordinator_session_id",
                             "coordinator_workspace_id", "created_at", "updated_at")
      VALUES ('${id}', '${OWNER_ID}', 'old writer', '${SESSION_OLD}', '${AGENT}',
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);

    // What the new code READS: a runtime row and an identity, neither of which the writer knew to
    // write.
    const seen = await f.service.get(OWNER_ID, id);
    assert.equal((seen as any).coordinatorAgentId, AGENT);
    assert.equal((seen as any).coordinatorGeneration, 0n);

    // ...and what it DOES with it: the trashed conversation is replaced, in the same workspace, and
    // the rotation is counted from the generation the trigger gave it.
    const rotated = await f.service.coordinator(OWNER_ID, id);
    const after = await f.prisma.project.findUnique({
      where: { id },
      include: { runtime: true, members: true },
    });
    assert.equal(rotated.created, true);
    assert.equal(rotated.workspaceId, AGENT);
    assert.equal(after.runtime.coordinatorGeneration, 1n);
    assert.equal(after.members[0].agentId, AGENT, 'the identity survives the rotation');
  } finally {
    await f.teardown();
  }
});
