import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { COORDINATOR_UNAVAILABLE_CODE, ProjectsService } from './projects.service';

/**
 * `POST /projects/:id/coordinator/replace` — this project's next coordinator conversation.
 *
 * Until it existed, the only conversation Orbit would replace was one in Trash, so a person who
 * wanted a fresh coordinator had two ways to get one: keep talking into a conversation that was
 * over, or delete it — which starts a retention clock over the record of every decision the project
 * has made.
 *
 * Two things are asserted here and they pull in opposite directions. `coordinator` RESOLVES, and
 * has to go on resolving: it is the press behind every link to a coordinator, and a reader who
 * opened a conversation to read it must not be the reason the project has a second one. `replace`
 * is the other intent, and it ENDS things — a conversation that is still open is completed first,
 * because a project names exactly one coordinator and a bare pointer swap would leave a live one
 * being written to and no longer able to act.
 *
 * The store below is the rows all of it reads and writes through, rather than a stub per call: a
 * double that answered `created: true` without moving the pointer would pass a test written the
 * other way while the endpoint shipped as a session factory.
 */

const OWNER = '00000000-0000-7000-8000-000000000001';
const PROJECT = '00000000-0000-7000-8000-0000000000a1';
/** The conversation the project points at when each case starts. */
const STANDING = '00000000-0000-7000-8000-0000000000b1';
/** The one `sessions.create` hands back. A different id, which is what a replacement means. */
const OPENED = '00000000-0000-7000-8000-0000000000b2';
const HOME = '00000000-0000-7000-8000-0000000000c1';

interface SessionRow {
  id: string;
  titleManagedByProject: boolean;
  workspaceId: string;
  deletedAt: Date | null;
  completedAt: Date | null;
  /** The legacy mirror of `completedAt`. A row written by an older binary carries only this one. */
  archivedAt: Date | null;
}

const COMPLETED_AT = new Date('2026-09-07T09:00:00.000Z');

function sessionRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: STANDING,
    titleManagedByProject: true,
    workspaceId: HOME,
    deletedAt: null,
    completedAt: null,
    archivedAt: null,
    ...over,
  };
}

function store(standing: SessionRow | null, workspaceUsable = true) {
  const project = {
    id: PROJECT,
    ownerId: OWNER,
    title: 'Ship the coordinator',
    coordinatorSessionId: standing?.id ?? null,
    coordinatorWorkspaceId: HOME,
  };
  const sessions: SessionRow[] = standing ? [standing] : [];
  /** Every `data` object a write handed the project row, in order. */
  const writes: Array<Record<string, unknown>> = [];
  const created: Array<{ workspaceId: string; title: string }> = [];

  const find = (id: string | null) => sessions.find((s) => s.id === id) ?? null;

  const prisma = {
    project: {
      findFirst: async ({ where }: any) => {
        if (where.id !== project.id || where.ownerId !== project.ownerId) return null;
        const session = find(project.coordinatorSessionId);
        return {
          ...project,
          automationPolicy: 'MANUAL',
          coordinatorSession: session
            ? {
                id: session.id,
                deletedAt: session.deletedAt,
                completedAt: session.completedAt,
                archivedAt: session.archivedAt,
              }
            : null,
        };
      },
      updateMany: async ({ where, data }: any) => {
        writes.push(data);
        if (where.id !== project.id || where.ownerId !== project.ownerId) return { count: 0 };
        // The compare-and-swap, honoured rather than assumed.
        if ('coordinatorSessionId' in where && project.coordinatorSessionId !== where.coordinatorSessionId) {
          return { count: 0 };
        }
        Object.assign(project, data);
        return { count: 1 };
      },
    },
    session: {
      updateMany: async ({ where, data }: any) => {
        const row = find(where.id);
        if (!row) return { count: 0 };
        if (
          where.titleManagedByProject !== undefined
          && row.titleManagedByProject !== where.titleManagedByProject
        ) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    workspace: {
      // `lastCoordinatorWorkspace`, with the conditions it really applies. `workspaceUsable`
      // stands in for the landing having been disabled or trashed since the binding.
      findFirst: async ({ where }: any) => {
        if (where.id !== HOME || where.ownerId !== OWNER || !workspaceUsable) return null;
        return { id: HOME };
      },
    },
    $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(prisma),
    // Rendered through the shared helper rather than read off `.strings`/`.values` here: a double
    // that parses Prisma's two calling conventions itself is how a spec comes to disagree with the
    // real client about what statement was issued.
    $queryRaw: async (...args: unknown[]) => {
      const { text, values: bound } = renderRawQuery(args);
      const values = bound as string[];
      if (text.includes('FROM "workspace"')) {
        return values[0] === HOME && values[1] === OWNER ? [{ id: HOME }] : [];
      }
      if (text.includes('FROM "session"')) {
        // The rows the CAS locks, in the order it asked for them.
        return values.map((id) => find(id)).filter(Boolean).map((row) => ({ id: row!.id }));
      }
      if (text.includes('FROM "project"')) {
        return values[0] === project.id && values[1] === project.ownerId
          ? [{ coordinator_session_id: project.coordinatorSessionId, title: project.title }]
          : [];
      }
      throw new Error(`unexpected raw query: ${text}`);
    },
  };

  /** Every session this call ended, in order. */
  const completed: string[] = [];

  const sessionsService = {
    // The real `SessionsService.complete`: it writes `completed_at` and is a no-op on a row that
    // already carries one.
    complete: async (owner: string, sessionId: string) => {
      assert.equal(owner, OWNER);
      completed.push(sessionId);
      const row = find(sessionId);
      if (row && row.completedAt == null) row.completedAt = new Date('2026-09-07T10:00:00.000Z');
      return { ok: true };
    },
    create: async (
      _owner: string,
      dto: { workspaceId: string; title: string },
      opts?: { titleManagedByProject?: boolean },
    ) => {
      created.push({ workspaceId: dto.workspaceId, title: dto.title });
      sessions.push(
        sessionRow({
          id: OPENED,
          titleManagedByProject: opts?.titleManagedByProject ?? false,
          workspaceId: dto.workspaceId,
        }),
      );
      return { id: OPENED };
    },
    remove: async () => assert.fail('no case here loses the coordinator race'),
  };

  const acceptance = { criteriaSummary: async () => ({ total: 0, passed: 0, lastRunAt: null, criteria: [] }) };
  const service = new ProjectsService(prisma as never, acceptance as never, sessionsService as never);
  return { service, project, sessions, writes, created, completed };
}

async function thrown(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (e) {
    return e;
  }
  return assert.fail('expected this call to refuse');
}

// ── A conversation its owner finished ────────────────────────────────────────────────────────

test('a COMPLETED coordinator is replaced, in the workspace it already ran in', async () => {
  const { service, project, sessions, writes, created, completed } = store(
    sessionRow({ completedAt: COMPLETED_AT }),
  );

  const replaced = await service.coordinator(OWNER, PROJECT, undefined, 'replace');

  assert.deepEqual(replaced, { sessionId: OPENED, created: true, workspaceId: HOME });
  // §7.5: the SESSION is replaced; the workspace is not. A replacement that could land anywhere
  // else would be a migration wearing a replacement's name.
  assert.deepEqual(created, [{ workspaceId: HOME, title: 'Ship the coordinator' }]);
  assert.equal(project.coordinatorSessionId, OPENED);
  assert.equal(project.coordinatorWorkspaceId, HOME);
  assert.deepEqual(writes, [{ coordinatorSessionId: OPENED, coordinatorWorkspaceId: HOME }]);

  // The conversation left behind is left ALONE: already over, so nothing here ends it a second
  // time, and it stays out of Trash — it is the record of everything this project decided.
  assert.deepEqual(completed, []);
  const previous = sessions.find((s) => s.id === STANDING)!;
  assert.equal(previous.deletedAt, null);
  assert.equal(previous.completedAt, COMPLETED_AT);
  // What it does lose is the project's name — one project, one managed title.
  assert.equal(previous.titleManagedByProject, false);
});

test('a row completed under the legacy mirror alone is just as finished', async () => {
  // `archived_at` is what a session completed by an older binary carries. Reading only
  // `completed_at` would answer "still open" about a conversation that has been over for months.
  // The visible cost of reading only `completed_at` is the line below: this call would END the
  // conversation again, enqueueing a second end intent against one that already had it.
  const { service, project, completed } = store(sessionRow({ archivedAt: COMPLETED_AT }));

  const replaced = await service.coordinator(OWNER, PROJECT, undefined, 'replace');

  assert.deepEqual(completed, []);
  assert.equal(replaced.created, true);
  assert.equal(project.coordinatorSessionId, OPENED);
});

// ── A conversation that is still going ───────────────────────────────────────────────────────

test('an OPEN coordinator is completed before the replacement takes its place', async () => {
  const { service, project, sessions, created, completed } = store(sessionRow());

  const replaced = await service.coordinator(OWNER, PROJECT, undefined, 'replace');

  // Ended, and ended THROUGH the session service rather than by writing `completed_at` here: the
  // completion is a runner-visible act (an end intent, a recycled process, a lifecycle event), and
  // a project that reached into the column would produce a conversation that looks finished to a
  // reader and is still running to everybody else.
  assert.deepEqual(completed, [STANDING]);
  assert.notEqual(sessions.find((s) => s.id === STANDING)!.completedAt, null);

  // Only then the replacement, and the pointer with it. A swap that left the old conversation open
  // would leave it being written to while it silently lost the authority to act on this project.
  assert.equal(replaced.created, true);
  assert.equal(project.coordinatorSessionId, OPENED);
  assert.deepEqual(created, [{ workspaceId: HOME, title: 'Ship the coordinator' }]);
});

test('a landing that refuses does not end the conversation it could not replace', async () => {
  // The workspace was disabled since the binding. The refusal is the one a replacement can still
  // meet — and it has to arrive with the project exactly as it was, or a press that could never
  // succeed costs the project the coordinator it had.
  const { service, project, sessions, created, completed, writes } = store(sessionRow(), false);

  const refused = await thrown(() => service.coordinator(OWNER, PROJECT, undefined, 'replace'));

  assert.ok(refused instanceof ConflictException);
  assert.equal((refused.getResponse() as Record<string, string>).code, COORDINATOR_UNAVAILABLE_CODE);
  assert.deepEqual(completed, []);
  assert.equal(sessions.find((s) => s.id === STANDING)!.completedAt, null);
  assert.deepEqual(created, []);
  assert.deepEqual(writes, []);
  assert.equal(project.coordinatorSessionId, STANDING);
});

// ── The door that must NOT replace ───────────────────────────────────────────────────────────

test('opening a completed coordinator hands back that same conversation', async () => {
  // The non-regression the separate route exists for. Every link to a coordinator presses this,
  // and a reader who opened a finished conversation to read it must not create the next one.
  const { service, project, created, writes } = store(sessionRow({ completedAt: COMPLETED_AT }));

  const opened = await service.coordinator(OWNER, PROJECT);

  assert.deepEqual(opened, { sessionId: STANDING, created: false, workspaceId: HOME });
  assert.deepEqual(created, []);
  assert.deepEqual(writes, []);
  assert.equal(project.coordinatorSessionId, STANDING);
});

test('a project whose conversation is gone still gets one from either press', async () => {
  // `replace` asked of a pointer that leads nowhere is the TRASHED card's Start button arriving a
  // moment late. There is nothing to refuse — the replacement it asked for is what an open does
  // here anyway — so it opens rather than inventing a second rule about a conversation that is
  // already gone.
  const { service, project } = store(sessionRow({ deletedAt: new Date('2026-09-06T00:00:00.000Z') }));

  const replaced = await service.coordinator(OWNER, PROJECT, undefined, 'replace');

  assert.equal(replaced.created, true);
  assert.equal(project.coordinatorSessionId, OPENED);
});
