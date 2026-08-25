import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BadRequestException, ConflictException, NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RunStatus } from '@prisma/client';
import { ProjectsController } from './projects.controller';
import {
  COORDINATOR_SESSION_LIVE_CODE,
  COORDINATOR_UNAVAILABLE_CODE,
  ProjectsService,
} from './projects.service';

/**
 * `POST /projects/:id/coordinator/rebind` — the action every `COORDINATOR_UNAVAILABLE` names.
 *
 * The refusals around a coordinator's landing all end in "rebind this project's coordination
 * workspace, then open the coordinator again" and all name USER as the one who can carry it out.
 * Until this endpoint existed that was an instruction with no verb behind it, so the file's spine
 * is the round trip rather than the write: a project that CANNOT open its coordinator, a rebind,
 * and the same project opening it — read through `coordinatorStatus` at each step, because a card
 * that goes on refusing after the fix is the same dead end wearing a 200.
 *
 * The store below is one set of rows that `coordinator`, `coordinatorStatus` and
 * `rebindCoordinator` all read and write through the Prisma surface each of them uses. Three
 * fixtures posed separately could each be consistent and still describe three different projects;
 * one store cannot.
 */

const OWNER = '00000000-0000-7000-8000-000000000001';
const OTHER_OWNER = '00000000-0000-7000-8000-000000000002';
const PROJECT = '00000000-0000-7000-8000-0000000000a1';
const OTHER_PROJECT = '00000000-0000-7000-8000-0000000000a2';
const SESSION = '00000000-0000-7000-8000-0000000000b1';
const OPENED = '00000000-0000-7000-8000-0000000000b2';
/** Where the coordinator was bound, and where the owner wants it. */
const HOME = '00000000-0000-7000-8000-0000000000c1';
const ELSEWHERE = '00000000-0000-7000-8000-0000000000c2';
/** The three ways a workspace can be named and still not be a landing. */
const TRASHED_WS = '00000000-0000-7000-8000-0000000000c3';
const DISABLED_WS = '00000000-0000-7000-8000-0000000000c4';
const FOREIGN_WS = '00000000-0000-7000-8000-0000000000c5';
const UNKNOWN_WS = '00000000-0000-7000-8000-0000000000cf';
const RUNNER = '00000000-0000-7000-8000-0000000000d1';

interface WorkspaceRow {
  id: string;
  ownerId: string;
  name: string;
  deletedAt: Date | null;
  enabled: boolean;
  runnerId: string | null;
}

interface SessionRow {
  id: string;
  workspaceId: string;
  deletedAt: Date | null;
  status: RunStatus;
}

interface ProjectRow {
  id: string;
  ownerId: string;
  coordinatorSessionId: string | null;
  coordinatorWorkspaceId: string | null;
  coordinatorGeneration: bigint;
}

interface StoreOptions {
  /** Defaults to a project bound to HOME with its coordinator conversation purged. */
  project?: Partial<ProjectRow>;
  /** Defaults to HOME usable and ELSEWHERE usable. */
  workspaces?: WorkspaceRow[];
  sessions?: SessionRow[];
}

function workspace(id: string, over: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return { id, ownerId: OWNER, name: `ws-${id.slice(-2)}`, deletedAt: null, enabled: true, runnerId: RUNNER, ...over };
}

/**
 * One in-memory set of rows behind the Prisma calls these three methods make.
 *
 * The raw reads are answered by EVALUATING their predicates against the store rather than by
 * matching on the statement: a double that returns a row without checking `enabled` would pass
 * every test below while the service shipped without the check. Bind values come off `.values`,
 * which is the only place a `Prisma.sql` puts them.
 */
function store(options: StoreOptions = {}) {
  const projects: ProjectRow[] = [
    {
      id: PROJECT,
      ownerId: OWNER,
      coordinatorSessionId: null,
      coordinatorWorkspaceId: HOME,
      coordinatorGeneration: 4n,
      ...options.project,
    },
    {
      id: OTHER_PROJECT,
      ownerId: OTHER_OWNER,
      coordinatorSessionId: null,
      coordinatorWorkspaceId: HOME,
      coordinatorGeneration: 0n,
    },
  ];
  const workspaces = options.workspaces ?? [workspace(HOME), workspace(ELSEWHERE)];
  const sessions = options.sessions ?? [];
  /** Every `data` object any write handed the project table, in order. */
  const writes: Array<Record<string, unknown>> = [];
  const created: Array<{ workspaceId: string; title: string }> = [];

  const findProject = (id: string, ownerId: string): ProjectRow | undefined =>
    projects.find((p) => p.id === id && p.ownerId === ownerId);
  const findWorkspace = (id: string | null): WorkspaceRow | undefined =>
    workspaces.find((w) => w.id === id);
  const findSession = (id: string | null): SessionRow | undefined => sessions.find((s) => s.id === id);

  /** The superset of every `select` these three reads ask for — Prisma would trim it per call. */
  const asPayload = (row: ProjectRow) => {
    const ws = findWorkspace(row.coordinatorWorkspaceId);
    const session = findSession(row.coordinatorSessionId);
    return {
      id: row.id,
      title: 'Ship the coordinator',
      automationPolicy: 'MANUAL',
      coordinatorSessionId: row.coordinatorSessionId,
      coordinatorWorkspaceId: row.coordinatorWorkspaceId,
      coordinatorSession: session
        ? {
            id: session.id,
            deletedAt: session.deletedAt,
            title: 'Coordinator: Ship the coordinator',
            status: session.status,
            endReason: null,
            startedAt: null,
            finishedAt: null,
            completedAt: null,
            archivedAt: null,
            engineTurnActive: false,
          }
        : null,
      coordinatorWorkspace: ws
        ? { name: ws.name, deletedAt: ws.deletedAt, enabled: ws.enabled, runnerId: ws.runnerId }
        : null,
      members: [] as Array<{ agentId: string; agent: { name: string } }>,
      runtime: { coordinatorGeneration: row.coordinatorGeneration },
    };
  };

  const prisma = {
    project: {
      findFirst: async ({ where }: any) => {
        const row = findProject(where.id, where.ownerId);
        return row ? asPayload(row) : null;
      },
      updateMany: async ({ where, data }: any) => {
        writes.push(data);
        const row = findProject(where.id, where.ownerId);
        if (!row) return { count: 0 };
        // The compare-and-swap `coordinator` writes, honoured rather than assumed: a double that
        // ignored the pointer predicate could never express a lost race.
        if ('coordinatorSessionId' in where && row.coordinatorSessionId !== where.coordinatorSessionId) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    workspace: {
      // `lastCoordinatorWorkspace`: the four conditions the read side applies.
      findFirst: async ({ where }: any) => {
        const row = findWorkspace(where.id);
        if (!row || row.ownerId !== where.ownerId) return null;
        if (where.deletedAt === null && row.deletedAt !== null) return null;
        if (where.enabled === true && !row.enabled) return null;
        return { id: row.id };
      },
      findUnique: async ({ where }: any) => {
        const row = findWorkspace(where.id);
        return row ? { id: row.id, name: row.name } : null;
      },
    },
    task: { groupBy: async () => [] },
    approval: { count: async () => 0 },
    $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(prisma),
    $queryRaw: async (query: unknown) => {
      const sql = query as { text?: string; strings?: string[]; values?: unknown[] };
      const text = sql.text ?? '';
      const values = (sql.values ?? []) as string[];
      if (text.includes('FROM "workspace"')) {
        const [id, ownerId] = values;
        const row = findWorkspace(id);
        const usable = row && row.ownerId === ownerId && row.deletedAt === null && row.enabled;
        return usable ? [{ id: row!.id }] : [];
      }
      if (text.includes('FROM "project"')) {
        const [id, ownerId] = values;
        const row = findProject(id, ownerId);
        return row
          ? [
              {
                coordinator_workspace_id: row.coordinatorWorkspaceId,
                coordinator_session_id: row.coordinatorSessionId,
              },
            ]
          : [];
      }
      if (text.includes('FROM "session"')) {
        const row = findSession(values[0]);
        return row ? [{ workspace_id: row.workspaceId }] : [];
      }
      throw new Error(`unexpected raw query: ${text}`);
    },
  };

  const sessionsService = {
    create: async (_owner: string, dto: { workspaceId: string; title: string }) => {
      created.push({ workspaceId: dto.workspaceId, title: dto.title });
      sessions.push({ id: OPENED, workspaceId: dto.workspaceId, deletedAt: null, status: RunStatus.PENDING });
      return { id: OPENED };
    },
    remove: async () => assert.fail('no scenario here loses the coordinator race'),
  };

  const acceptance = { criteriaSummary: async () => ({ total: 0, passed: 0, lastRunAt: null, criteria: [] }) };
  const service = new ProjectsService(prisma as never, acceptance as never, sessionsService as never);
  return { service, projects, writes, created, row: () => projects[0] };
}

/** The body a structured refusal carries, whichever of the two it is. */
function refusal(e: unknown): Record<string, string> {
  assert.ok(e instanceof ConflictException, `expected a 409, got ${String(e)}`);
  return e.getResponse() as Record<string, string>;
}

async function thrown(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (e) {
    return e;
  }
  return assert.fail('expected this call to refuse');
}

// ── The round trip: the dead end, the rebind, and the coordinator that opens ──

test('a project whose landing was disabled cannot open a coordinator, rebinds, and then can', async () => {
  const { service, writes, created, row } = store({
    workspaces: [workspace(HOME, { enabled: false }), workspace(ELSEWHERE)],
  });

  // 1. The dead end. `coordinator` refuses, and says the one thing that clears it.
  const refused = refusal(await thrown(() => service.coordinator(OWNER, PROJECT)));
  assert.equal(refused.code, COORDINATOR_UNAVAILABLE_CODE);
  assert.equal(refused.owner, 'USER');
  assert.match(refused.requiredAction, /rebind this project’s coordination workspace/);

  // The card predicts the same refusal before the press, which is what makes it a dead end rather
  // than a surprise: one refusal, two sides, same required action.
  const before = await service.coordinatorStatus(OWNER, PROJECT);
  assert.equal(before.state, 'UNAVAILABLE');
  assert.equal(before.openability.canOpen, false);
  assert.equal(before.openability.refusalCode, COORDINATOR_UNAVAILABLE_CODE);
  assert.equal(before.openability.refusalDetail, 'WORKSPACE_DISABLED');
  assert.equal(before.openability.requiredAction, refused.requiredAction);
  assert.equal(before.openability.landing.workspaceId, null);
  assert.equal(before.openability.landing.workspaceIdAbsentReason, 'LANDING_REFUSED');

  // 2. The action that instruction names.
  const rebound = await service.rebindCoordinator(OWNER, PROJECT, ELSEWHERE);
  assert.deepEqual(rebound, {
    projectId: PROJECT,
    coordinatorWorkspaceId: ELSEWHERE,
    coordinatorSessionId: null,
    moved: true,
  });

  // 3. The card changes with it — the projection and the write agree, or the card lies.
  const after = await service.coordinatorStatus(OWNER, PROJECT);
  assert.equal(after.state, 'TRASHED');
  assert.equal(after.openability.canOpen, true);
  assert.equal(after.openability.refusalCode, null);
  assert.equal(after.openability.refusalCodeAbsentReason, 'NOTHING_REFUSES');
  assert.equal(after.openability.requiredAction, null);
  assert.equal(after.openability.landing.workspaceId, ELSEWHERE);
  assert.equal(after.openability.landing.fixed, true);
  assert.equal(after.coordination.workspaceId, ELSEWHERE);

  // 4. And the press the card predicts really does open, in the workspace it named.
  const opened = await service.coordinator(OWNER, PROJECT);
  assert.equal(opened.created, true);
  assert.equal(opened.workspaceId, ELSEWHERE);
  assert.deepEqual(created, [{ workspaceId: ELSEWHERE, title: 'Coordinator: Ship the coordinator' }]);
  assert.equal(row().coordinatorWorkspaceId, ELSEWHERE);

  // The rebind wrote one column; the open wrote the pair. Nothing else touched the row.
  assert.deepEqual(writes, [
    { coordinatorWorkspaceId: ELSEWHERE },
    { coordinatorSessionId: OPENED, coordinatorWorkspaceId: ELSEWHERE },
  ]);
});

test('rebinding does not relax the 409 `coordinator` gives a caller who names somewhere else', async () => {
  const { service } = store();
  await service.rebindCoordinator(OWNER, PROJECT, ELSEWHERE);

  // §7.5's rule is unchanged by the existence of its exit: asking for a coordinator somewhere else
  // is still a refusal, and only the owner's explicit rebind moves one.
  const e = await thrown(() => service.coordinator(OWNER, PROJECT, HOME));
  assert.ok(e instanceof ConflictException);
  assert.match(String((e.getResponse() as { message?: string }).message ?? e.message), /already has a coordinator/);
});

// ── What it writes, and everything it leaves alone ──

test('the write names exactly one column: the landing, and never the session pointer', async () => {
  const { service, writes, row } = store({
    // A pointer that already sits in the workspace being moved to — the one shape in which a
    // project with a bound conversation may move, and the case that proves the pointer is not
    // rewritten rather than merely re-written to the same value.
    project: { coordinatorSessionId: SESSION },
    sessions: [{ id: SESSION, workspaceId: ELSEWHERE, deletedAt: null, status: RunStatus.SUCCEEDED }],
  });

  const result = await service.rebindCoordinator(OWNER, PROJECT, ELSEWHERE);

  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0]), ['coordinatorWorkspaceId']);
  assert.equal(row().coordinatorSessionId, SESSION);
  assert.equal(result.coordinatorSessionId, SESSION);
});

test('the generation the rebind leaves behind is the one it found', async () => {
  const { service, row } = store({ project: { coordinatorGeneration: 4n } });

  const before = await service.coordinatorStatus(OWNER, PROJECT);
  await service.rebindCoordinator(OWNER, PROJECT, ELSEWHERE);
  const after = await service.coordinatorStatus(OWNER, PROJECT);

  assert.equal(before.coordination.coordinatorGeneration, 4n);
  assert.equal(after.coordination.coordinatorGeneration, 4n);
  assert.equal(row().coordinatorGeneration, 4n);
});

/**
 * The reason the assertion above holds is not in this service — it is in the trigger that counts
 * rotations, and a trigger widened to fire on the landing would move the generation without a line
 * of TypeScript changing. So the condition is read out of the migration rather than remembered.
 */
test('the rotation counter fires on the session pointer alone, which is the column this never writes', () => {
  const migration = readFileSync(
    path.resolve(__dirname, '../../prisma/migrations/0112_project_coordinator_companions/migration.sql'),
    'utf8',
  );
  const trigger = /CREATE CONSTRAINT TRIGGER project_coordinator_rotation_count[\s\S]*?EXECUTE FUNCTION/.exec(
    migration,
  );
  assert.ok(trigger, 'the rotation trigger is no longer created by 0112');
  assert.match(trigger[0], /AFTER UPDATE OF "coordinator_session_id" ON "project"/);
  assert.equal(/coordinator_workspace_id/.test(trigger[0]), false);
});

// ── The target has to be a landing, and there is one sentence for every way it is not ──

test('unknown, another owner’s, trashed and disabled are refused in the same words', async () => {
  const { service, writes } = store({
    workspaces: [
      workspace(HOME),
      workspace(TRASHED_WS, { deletedAt: new Date('2026-08-01T00:00:00.000Z') }),
      workspace(DISABLED_WS, { enabled: false }),
      workspace(FOREIGN_WS, { ownerId: OTHER_OWNER }),
    ],
  });

  const messages: string[] = [];
  for (const target of [UNKNOWN_WS, FOREIGN_WS, TRASHED_WS, DISABLED_WS]) {
    const e = await thrown(() => service.rebindCoordinator(OWNER, PROJECT, target));
    assert.ok(e instanceof BadRequestException, `${target} should be a 400, got ${String(e)}`);
    messages.push(String((e.getResponse() as { message?: string }).message ?? e.message));
  }

  // One sentence, four times. Telling them apart would answer "does this id exist" for ids the
  // caller has no business knowing about, and would say "restore it" about somebody else's row.
  assert.equal(new Set(messages).size, 1, `four refusals, ${new Set(messages).size} wordings: ${messages.join(' | ')}`);
  assert.match(messages[0], /no such workspace to coordinate this project in/);
  assert.match(messages[0], /has not been deleted or disabled/);
  assert.deepEqual(writes, [], 'a refused rebind must not have written anything');
});

// ── The pointer the database will not let a landing move away from ──

test('a project still bound to a conversation elsewhere is refused, and told what frees it', async () => {
  const { service, writes, row } = store({
    project: { coordinatorSessionId: SESSION },
    sessions: [{ id: SESSION, workspaceId: HOME, deletedAt: null, status: RunStatus.AWAITING_INPUT }],
  });

  const body = refusal(await thrown(() => service.rebindCoordinator(OWNER, PROJECT, ELSEWHERE)));
  assert.equal(body.code, COORDINATOR_SESSION_LIVE_CODE);
  assert.equal(body.owner, 'USER');
  assert.match(body.message, /still bound to a coordinator conversation/);
  assert.match(body.requiredAction, /delete it permanently/);
  assert.deepEqual(writes, []);
  assert.equal(row().coordinatorWorkspaceId, HOME);
});

test('a pointer into Trash stands in the guard’s eyes too, and gets the same refusal', async () => {
  // `coordinator` replaces a trashed binding, so it is tempting to read this pointer as absent.
  // The pointer guard does not: it checks the pair as committed, whatever Trash says about it.
  const { service, writes } = store({
    project: { coordinatorSessionId: SESSION },
    sessions: [
      { id: SESSION, workspaceId: HOME, deletedAt: new Date('2026-08-02T00:00:00.000Z'), status: RunStatus.SUCCEEDED },
    ],
  });

  const body = refusal(await thrown(() => service.rebindCoordinator(OWNER, PROJECT, ELSEWHERE)));
  assert.equal(body.code, COORDINATOR_SESSION_LIVE_CODE);
  assert.deepEqual(writes, []);
});

/**
 * The refusal above is the shape of a database rule, so the rule is read rather than remembered.
 * 0164 removed the control loop's triggers and KEPT this one by name; if a later migration drops
 * it, the service is refusing something the database would now accept and this fails.
 */
test('the pointer guard that makes that a refusal is still installed', () => {
  const migrations = path.resolve(__dirname, '../../prisma/migrations');
  const installed = readFileSync(
    path.join(migrations, '0126_project_coordinator_session_lifecycle/migration.sql'),
    'utf8',
  );
  assert.match(installed, /CREATE TRIGGER "project_coordinator_pointer_guard"\s*\nBEFORE INSERT OR UPDATE OF "coordinator_session_id", "coordinator_workspace_id" ON "project"/);
  assert.match(installed, /COORDINATOR_POINTER_RELOCATED/);

  const dropped = readFileSync(path.join(migrations, '0164_drop_project_event_outbox/migration.sql'), 'utf8');
  assert.equal(
    /DROP TRIGGER IF EXISTS "project_coordinator_pointer_guard"/.test(dropped),
    false,
    '0164 now drops the guard — the rebind refusal it justifies has to go with it',
  );
});

// ── Replay, and tenancy ──

test('rebinding to the landing a project already records writes nothing and says so', async () => {
  const { service, writes } = store({
    // Bound, and running: a replay must not be told its own rebind was refused because of a
    // conversation it is not moving.
    project: { coordinatorSessionId: SESSION, coordinatorWorkspaceId: HOME },
    sessions: [{ id: SESSION, workspaceId: HOME, deletedAt: null, status: RunStatus.RUNNING }],
  });

  const result = await service.rebindCoordinator(OWNER, PROJECT, HOME);
  assert.deepEqual(result, {
    projectId: PROJECT,
    coordinatorWorkspaceId: HOME,
    coordinatorSessionId: SESSION,
    moved: false,
  });
  assert.deepEqual(writes, []);
});

test('an unknown id and another owner’s id get the same 404 the rest of the project API gives', async () => {
  // Each caller names a landing of their OWN, so what is being tested is the project id and only
  // the project id — the landing is checked first (it is the lower lock rank), so a caller who
  // owns neither would be answered about the workspace and prove nothing about the project.
  const { service, writes } = store({
    workspaces: [workspace(HOME), workspace(ELSEWHERE), workspace(FOREIGN_WS, { ownerId: OTHER_OWNER })],
  });

  for (const [owner, id, landing] of [
    [OWNER, '00000000-0000-7000-8000-00000000ffff', ELSEWHERE],
    [OWNER, OTHER_PROJECT, ELSEWHERE],
    [OTHER_OWNER, PROJECT, FOREIGN_WS],
  ] as const) {
    const e = await thrown(() => service.rebindCoordinator(owner, id, landing));
    assert.ok(e instanceof NotFoundException, `${id} should be a 404, got ${String(e)}`);
    assert.match(String((e.getResponse() as { message?: string }).message ?? e.message), /project not found/);
  }
  assert.deepEqual(writes, []);
});

// ── The instruction and the route it names ──

/** Every route this controller declares, found by PATH rather than by handler name. */
function routeTable(): Array<{ handler: string; path: string; method: unknown }> {
  const proto = ProjectsController.prototype as unknown as Record<string, object>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && typeof proto[name] === 'function')
    .map((handler) => ({
      handler,
      path: Reflect.getMetadata(PATH_METADATA, proto[handler]) as string,
      method: Reflect.getMetadata(METHOD_METADATA, proto[handler]) as unknown,
    }))
    .filter((route) => typeof route.path === 'string');
}

/**
 * The one test that stops the sentence and the endpoint drifting apart again.
 *
 * `COORDINATOR_UNAVAILABLE` told the owner to rebind for as long as there was nothing to rebind
 * WITH — the text was true about what was needed and false about what existed, and nothing failed.
 * So the verb is taken out of the refusal itself and looked up in the route table: reword the
 * action without moving the route, or move the route without rewording the action, and this fails.
 */
test('the action COORDINATOR_UNAVAILABLE names is a route this server actually serves', async () => {
  const { service } = store({ workspaces: [workspace(HOME, { enabled: false }), workspace(ELSEWHERE)] });
  const body = refusal(await thrown(() => service.coordinator(OWNER, PROJECT)));
  assert.equal(body.code, COORDINATOR_UNAVAILABLE_CODE);

  // "rebind this project's coordination workspace (or …), then open the coordinator again"
  const named = /^(\w+) this project’s coordination workspace/.exec(body.requiredAction);
  assert.ok(named, `the required action no longer opens with a verb and its object: ${body.requiredAction}`);
  const verb = named[1];

  const route = routeTable().find((r) => r.path === `:id/coordinator/${verb}`);
  assert.ok(route, `nothing serves ':id/coordinator/${verb}', which is the action the refusal names`);
  assert.equal(route.method, RequestMethod.POST, 'the action changes a project and has to be a POST');
  assert.equal(route.handler, 'rebindCoordinator');

  // And the read predicts the same instruction, so a client that reaches this from the card is
  // sent to the same door as one that reached it from the button.
  const status = await service.coordinatorStatus(OWNER, PROJECT);
  assert.equal(status.openability.requiredAction, body.requiredAction);
});

test('the rebind route reads its landing from the DTO that has no null spelling', () => {
  // `POST :id/coordinator` and `POST :id/coordinator/rebind` are one path segment apart and mean
  // opposite things about a project that already has a landing, so the pair is asserted together.
  const table = routeTable();
  const open = table.find((r) => r.handler === 'openCoordinator');
  const rebind = table.find((r) => r.handler === 'rebindCoordinator');
  assert.equal(open?.path, ':id/coordinator');
  assert.equal(rebind?.path, ':id/coordinator/rebind');
  assert.equal(rebind?.method, RequestMethod.POST);
});
