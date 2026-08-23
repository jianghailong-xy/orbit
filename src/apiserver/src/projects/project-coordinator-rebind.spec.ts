import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { COORDINATOR_SESSION_LIVE_CODE, ProjectsService } from './projects.service';

/**
 * Moving a project's coordination workspace — the door every refusal about a landing points at.
 *
 * `coordinator` will not move one ("open it where it is"), and §7.5 forbids the control loop from
 * choosing a new home for a coordinator it cannot open. Both hand the decision to the owner, which
 * only means something if the owner has somewhere to make it. Four rules, and every test here is
 * one of them:
 *
 *  - **A landing is a workspace a coordinator can actually open in.** Refused at this door rather
 *    than at the `sessions.create` that would have discovered it later, because accepting a
 *    soft-deleted or disabled one writes the `COORDINATOR_UNAVAILABLE` this endpoint exists to
 *    clear — a rebind that returns 200 and leaves the coordinator exactly as unopenable.
 *  - **A live conversation is not moved out from under.** The same refusal §7.5's rotation makes,
 *    made here instead, because the write that follows would detach a running coordinator from the
 *    project it believes it coordinates without its turn ever being told.
 *  - **The pointer goes with the landing, in one statement.** Not a tidy-up: the database refuses
 *    the pair outright (`project_coordinator_pointer_guard`), so a landing that moved while a
 *    pointer stayed is a row that cannot exist. The conversation it detaches is named in the
 *    response, because "no longer this project's coordinator" must not mean "lost".
 *  - **Rebinding to where it already is is a no-op, not a conflict.** A client retrying a request
 *    whose response it never saw is the ordinary case, and it must not be told its own write failed.
 *
 * The database half — that a DERIVED identity follows the landing and an EXPLICIT one does not,
 * that no generation is spent, that the detached conversation survives — is
 * `coordinator-identity-service.pg.spec.ts`. Those are claims about triggers, and only a real
 * PostgreSQL can be asked.
 */

const OWNER = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
const PROJECT = '019fcbf3-0fa8-7f83-9302-46b25389cb16';
const HERE = '019fd557-68b2-7fb2-bef0-9fb1cf06abb2';
const THERE = '019fd557-68b2-7fb2-bef0-9fb1cf06abb3';
const CONVERSATION = '019fd557-68b2-7fb2-bef0-9fb1cf06abb4';

interface World {
  /** The project row, or null for one this caller may not see. */
  project?: { coordinator_workspace_id: string | null; coordinator_session_id: string | null } | null;
  /** Whether the target names a live, enabled agent of this account. */
  landingUsable?: boolean;
  /** The conversation the pointer names, when it names one this caller can still open. */
  session?: { workspace_id: string; live: boolean } | null;
}

interface Trace {
  statements: string[];
  updates: Array<Record<string, unknown>>;
}

/** `Prisma.sql` passes ONE argument — a tagged-template object — so the text comes off `strings`. */
function sqlText(arg: unknown): string {
  const parts = (arg as { strings?: readonly string[] })?.strings ?? (arg as readonly string[]);
  return Array.isArray(parts) ? parts.join(' ') : String(arg);
}

/**
 * Dispatch on which table a statement reads, which is what makes three consecutive `$queryRaw`
 * calls three different answers rather than one repeated. A fake that returned the same rows to
 * all of them would pass every test here with the landing check deleted.
 */
function service(world: World, trace: Trace): ProjectsService {
  const project = world.project === undefined
    ? { coordinator_workspace_id: HERE, coordinator_session_id: CONVERSATION }
    : world.project;
  const tx = {
    $queryRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      trace.statements.push(sql);
      if (sql.includes('FROM "project"')) return project === null ? [] : [project];
      if (sql.includes('FROM "workspace"')) {
        return world.landingUsable === false ? [] : [{ id: THERE }];
      }
      if (sql.includes('FROM "session"')) {
        const session = world.session === undefined
          ? { workspace_id: HERE, live: false }
          : world.session;
        return session === null ? [] : [{ id: CONVERSATION, ...session }];
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
    project: {
      update: async (args: Record<string, unknown>) => {
        trace.updates.push(args);
        return { id: PROJECT };
      },
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  return new ProjectsService(prisma as never, {} as never);
}

function trace(): Trace {
  return { statements: [], updates: [] };
}

function rebind(world: World, t: Trace, to: string = THERE) {
  return service(world, t).rebindCoordinator(OWNER, PROJECT, to);
}

// ── What may not be rebound ───────────────────────────────────────────────────────────────────

test('a project this caller cannot see is a 404, and nothing is written', async () => {
  const t = trace();
  const error = await rebind({ project: null }, t).then(() => null, (e) => e);
  assert.ok(error instanceof NotFoundException, `expected a 404, got ${error}`);
  assert.deepEqual(t.updates, []);
});

test('a project that does not exist is still a 404 when the landing named does', async () => {
  // Which order the two are read in is a lock-order decision, and it must not become an answer:
  // proving the landing first cannot turn "no such project" into "no such workspace".
  const t = trace();
  const error = await rebind({ project: null, landingUsable: true }, t).then(() => null, (e) => e);
  assert.ok(error instanceof NotFoundException, `expected a 404, got ${error}`);
});

test('a landing that is not a live, enabled agent of this account is a 400', async () => {
  const t = trace();
  const error = await rebind({ landingUsable: false }, t).then(() => null, (e) => e);
  assert.ok(error instanceof BadRequestException, `expected a 400, got ${error}`);
  assert.match(String((error.getResponse() as { message: string }).message), /workspaceId/);
  assert.deepEqual(t.updates, [], 'a refused rebind must not have moved anything');
});

test('the landing is proved with the two conditions that decide, and held for the write', async () => {
  const t = trace();
  await rebind({}, t);
  const workspace = t.statements.find((s) => s.includes('FROM "workspace"'))!;
  // Soft-deleted and disabled are the same question here — can a coordinator open where it is
  // being sent — and `lastCoordinatorWorkspace` asks both of the landing it reads back.
  assert.match(workspace, /"deleted_at" IS NULL/);
  assert.match(workspace, /"enabled" = TRUE/);
  // A soft delete is an UPDATE, so the foreign key does not conflict with one: without this the
  // check and the write straddle it.
  assert.match(workspace, /FOR SHARE/);
});

test('a coordinator somebody is still in refuses the move, and says who ends it', async () => {
  const t = trace();
  const error = await rebind({ session: { workspace_id: HERE, live: true } }, t)
    .then(() => null, (e) => e);
  assert.ok(error instanceof ConflictException, `expected a 409, got ${error}`);
  const body = error.getResponse() as Record<string, unknown>;
  assert.equal(body.code, COORDINATOR_SESSION_LIVE_CODE);
  assert.equal(body.owner, 'USER');
  assert.match(String(body.requiredAction), /end this project’s current coordinator session/);
  assert.deepEqual(t.updates, []);
  // Error bodies do not pass through `PublicIdInterceptor`, so a uuid put in one goes out raw.
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.exec(JSON.stringify(body)), null);
});

// ── What a rebind does ────────────────────────────────────────────────────────────────────────

test('the two rows are locked in rank order, and the pointer is cleared by the write that moves the landing',
  async () => {
    const t = trace();
    const result = await rebind({}, t);

    // `workspace` is rank 15 and `project` is rank 40 (lock-order.ts), so the landing is proved
    // BEFORE the project row is locked — reading the project first would lock upward, which is the
    // shape rank 15 exists to keep out of these paths. Nothing here needs the project row to know
    // which landing was named, so the ranks and the data agree.
    assert.match(t.statements[0], /FROM "workspace"/);
    // The pointer is written by `coordinator` and by the rotation loop too, so what this read saw
    // has to still be true at the commit that clears it.
    assert.match(t.statements[1], /FROM "project"/);
    assert.match(t.statements[1], /FOR NO KEY UPDATE/);

    assert.equal(t.updates.length, 1, 'one statement, so the pair the database checks is never split');
    assert.deepEqual(t.updates[0].data, {
      coordinatorWorkspaceId: THERE,
      coordinatorSessionId: null,
    });
    assert.equal(result.moved, true);
    assert.equal(result.coordinatorWorkspaceId, THERE);
    assert.equal(result.coordinatorSessionId, null);
    // Detached, not deleted — and named, so the conversation is still reachable afterwards.
    assert.deepEqual(result.unbound, { sessionId: CONVERSATION, workspaceId: HERE });
  });

test('a project with no coordinator conversation rebinds with nothing to unbind', async () => {
  const t = trace();
  const result = await rebind(
    { project: { coordinator_workspace_id: HERE, coordinator_session_id: null } },
    t,
  );
  assert.equal(result.moved, true);
  assert.equal(result.unbound, null);
  assert.equal(t.statements.some((s) => s.includes('FROM "session"')), false,
    'and does not go looking for one');
});

test('a pointer that leads into Trash unbinds nothing a caller could have opened', async () => {
  const t = trace();
  const result = await rebind({ session: null }, t);
  assert.equal(result.moved, true);
  assert.equal(result.unbound, null);
  assert.deepEqual(t.updates[0].data, { coordinatorWorkspaceId: THERE, coordinatorSessionId: null });
});

// ── Rebinding to where it already is ──────────────────────────────────────────────────────────

test('rebinding a project to its own landing writes nothing and says it moved nothing', async () => {
  const t = trace();
  const result = await service(
    { project: { coordinator_workspace_id: THERE, coordinator_session_id: CONVERSATION } },
    t,
  ).rebindCoordinator(OWNER, PROJECT, THERE);

  assert.equal(result.moved, false);
  assert.equal(result.coordinatorWorkspaceId, THERE);
  // The pointer as it stands, not the `null` a move would have left: reporting one that is still
  // bound as cleared would tell a retrying client its coordinator had been detached.
  assert.equal(result.coordinatorSessionId, CONVERSATION);
  assert.equal(result.unbound, null);
  assert.deepEqual(t.updates, []);
});

test('a no-op rebind is not refused by a coordinator that is running', async () => {
  const t = trace();
  const result = await service(
    { project: { coordinator_workspace_id: THERE, coordinator_session_id: CONVERSATION },
      session: { workspace_id: THERE, live: true } },
    t,
  ).rebindCoordinator(OWNER, PROJECT, THERE);
  // A call that moves nothing has no reason to care whether the conversation it is leaving alone
  // happens to be live — and a retry must not turn into a refusal.
  assert.equal(result.moved, false);
  assert.deepEqual(t.updates, []);
});
