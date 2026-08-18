import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { uuidToBase62 } from '@orbit/shared';
import { CreateProjectDto } from './dto';
import { ProjectsService } from './projects.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const OTHER_OWNER_ID = '00000000-0000-7000-8000-000000000002';
const RUNNER_ID = '00000000-0000-7000-8000-0000000000b1';
const OTHER_RUNNER_ID = '00000000-0000-7000-8000-0000000000b2';
const SESSION_ID = '00000000-0000-7000-8000-0000000000c1';
const WORKSPACE_ID = '00000000-0000-7000-8000-0000000000d1';

interface SessionRow {
  id: string;
  ownerId: string;
  assignedRunnerId: string | null;
  deletedAt: Date | null;
  workspaceId: string | null;
  /** Workspaces are soft-deleted, so a live FK can still point at one nothing may run in. */
  workspaceDeletedAt: Date | null;
  /** ...and an ordinary column a person flips at any time does the same, without deleting a thing. */
  workspaceEnabled: boolean;
}

const LIVE: SessionRow = {
  id: SESSION_ID,
  ownerId: OWNER_ID,
  assignedRunnerId: RUNNER_ID,
  deletedAt: null,
  workspaceId: WORKSPACE_ID,
  workspaceDeletedAt: null,
  workspaceEnabled: true,
};

/**
 * The session table is modelled as ROWS the `where` is applied to, rather than as a stub that
 * answers whatever the test wants.
 *
 * A stub returning a fixed row would pass every test here with `assignedRunnerId` or `deletedAt`
 * deleted from the query — and those two clauses are the whole tenancy argument: without them a
 * runner could name any session id and seed a project pointing into a workspace it has no
 * business opening a coordinator in. An unmodelled filter throws rather than being ignored, so a
 * narrowing this file has never exercised cannot pass by being invisible.
 */
function matches(row: SessionRow, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    switch (key) {
      case 'id':
        if (row.id !== value) return false;
        break;
      case 'ownerId':
        if (row.ownerId !== value) return false;
        break;
      case 'assignedRunnerId':
        if (row.assignedRunnerId !== value) return false;
        break;
      case 'deletedAt':
        if ((row.deletedAt ?? null) !== value) return false;
        break;
      case 'workspace': {
        // Prisma compiles a to-one relation filter to a join, so a NULL foreign key matches
        // nothing — modelled, because "the session never had a workspace" is one of the cases
        // that has to be refused rather than turned into a project pointing at nothing.
        if (!row.workspaceId) return false;
        const filter = value as { deletedAt?: unknown; enabled?: unknown };
        if (filter.deletedAt === null && row.workspaceDeletedAt !== null) return false;
        if (filter.enabled === true && !row.workspaceEnabled) return false;
        break;
      }
      default:
        throw new Error(`session filter not modelled by this fixture: ${key}`);
    }
  }
  return true;
}

function makeService(rows: SessionRow[] = [LIVE]) {
  const creates: Record<string, unknown>[] = [];
  const lookups: Record<string, unknown>[] = [];
  const prisma = {
    session: {
      findFirst: async ({ where }: any) => {
        lookups.push(where);
        const row = rows.find((candidate) => matches(candidate, where));
        return row ? { workspaceId: row.workspaceId } : null;
      },
    },
    project: {
      create: async ({ data }: any) => {
        creates.push(data);
        return { id: 'project-1', ...data };
      },
      // A default applied by a follow-up write would leave a window in which the project exists
      // and cannot be opened, so reaching for either of these is a failure, not an alternative.
      update: async () => {
        throw new Error('the coordinator default must be written in the create, not after it');
      },
      updateMany: async () => {
        throw new Error('the coordinator default must be written in the create, not after it');
      },
    },
  } as never;

  const service = new ProjectsService(prisma, {} as never);
  return {
    creates,
    lookups,
    inSession: (dto: CreateProjectDto, sessionId = SESSION_ID, runnerId = RUNNER_ID) =>
      service.createInSession(OWNER_ID, runnerId, sessionId, dto),
    headless: (dto: CreateProjectDto) => service.create(OWNER_ID, dto),
  };
}

// ── The rule ──────────────────────────────────────────────────────────────────────────────────

test('a project created inside a session remembers that session’s workspace', async () => {
  const f = makeService();

  await f.inSession({ title: 'Crawl', goal: 'Index the corpus' });

  assert.equal(f.creates.length, 1);
  assert.equal(f.creates[0].coordinatorWorkspaceId, WORKSPACE_ID);
  // The project is still the project: the session decides where its coordinator opens and nothing
  // about what the work is.
  assert.equal(f.creates[0].ownerId, OWNER_ID);
  assert.equal(f.creates[0].title, 'Crawl');
  assert.equal(f.creates[0].goal, 'Index the corpus');
});

// A project is openable or it is not, and it must not be briefly neither. One insert also means
// there is no failure mode where the row lands and the default does not.
test('the default is part of the insert, not a second write', async () => {
  const f = makeService();

  await f.inSession({ title: 'Crawl' });

  assert.deepEqual(Object.keys(f.creates[0]).sort(), [
    'acceptanceCriteria',
    'coordinatorWorkspaceId',
    'goal',
    'instructions',
    'ownerId',
    'title',
  ]);
});

// Both halves of the scope, stated together in the one query that resolves the session. The owner
// alone would let a runner seed a project from any of that account's sessions — including one
// running on another machine, in a workspace this runner cannot see.
test('the session is resolved under this owner AND this runner, alive, with a usable workspace', async () => {
  const f = makeService();

  await f.inSession({ title: 'Crawl' });

  assert.deepEqual(f.lookups, [
    {
      id: SESSION_ID,
      ownerId: OWNER_ID,
      assignedRunnerId: RUNNER_ID,
      deletedAt: null,
      workspace: { deletedAt: null, enabled: true },
    },
  ]);
});

// `publicIdHeaders` hands the handler a UUID, but the decode is the id rule rather than that
// middleware's private habit: the same id in the spelling a model actually sees must resolve to
// the same session, not to a 403 that reads as "your session is gone".
test('a base62 session id resolves to the same session', async () => {
  const f = makeService();

  await f.inSession({ title: 'Crawl' }, uuidToBase62(SESSION_ID));

  assert.equal(f.lookups[0].id, SESSION_ID);
  assert.equal(f.creates[0].coordinatorWorkspaceId, WORKSPACE_ID);
});

// The prose rules are the DTO's and the service's, and they are the same rules whichever door the
// project came in by — otherwise an agent's blank goal and a person's blank goal are two different
// stored states.
test('prose is shaped exactly as it is on the headless path', async () => {
  const f = makeService();

  await f.inSession({ title: 'Crawl', goal: '   ', acceptanceCriteria: 'Every shard reported' });

  assert.equal(f.creates[0].goal, null);
  assert.equal(f.creates[0].acceptanceCriteria, 'Every shard reported');
  assert.equal(f.creates[0].instructions, undefined);
});

// ── What is refused ───────────────────────────────────────────────────────────────────────────

const REFUSED: Array<[string, SessionRow[], string]> = [
  ['a session id nothing is filed under', [], SESSION_ID],
  [
    'a session belonging to another owner',
    [{ ...LIVE, ownerId: OTHER_OWNER_ID }],
    SESSION_ID,
  ],
  [
    'a session assigned to another runner',
    [{ ...LIVE, assignedRunnerId: OTHER_RUNNER_ID }],
    SESSION_ID,
  ],
  ['a session that has been deleted', [{ ...LIVE, deletedAt: new Date() }], SESSION_ID],
  [
    'a session whose workspace has been deleted',
    [{ ...LIVE, workspaceDeletedAt: new Date() }],
    SESSION_ID,
  ],
  // Disabled is not deleted, and nothing about the session says so: the row is live, the FK is
  // live, and `sessions.create` refuses it all the same. Seeding a default from one is the same
  // unopenable project as seeding from a deleted workspace, arrived at by the more ordinary route
  // — somebody switched a workspace off while an agent was working in it.
  [
    'a session whose workspace has been disabled',
    [{ ...LIVE, workspaceEnabled: false }],
    SESSION_ID,
  ],
  ['a session that never had a workspace', [{ ...LIVE, workspaceId: null }], SESSION_ID],
  // `publicIdHeaders` leaves a value it cannot decode exactly as it arrived, for the handler to
  // reject. Reaching Prisma with one would be a P2023 the caller gets as a bare 500.
  ['a header that is not an id at all', [LIVE], 'not-an-id!!'],
];

for (const [label, rows, sessionId] of REFUSED) {
  test(`${label} is refused, and no project is created`, async () => {
    const f = makeService(rows);

    await assert.rejects(
      () => f.inSession({ title: 'Crawl' }, sessionId),
      (e: unknown) => e instanceof ForbiddenException,
    );
    // The refusal is the point. A project created anyway, minus its default, is the unopenable
    // project this path exists to stop producing — and one pointing at a borrowed workspace would
    // be worse.
    assert.deepEqual(f.creates, []);
  });
}

// Which of the refusals it was is not the caller's business: "that session is not yours" and
// "there is no such session" together answer "does this id exist" for ids belonging to accounts
// the caller cannot see. It can act on none of the distinctions, so it is told none of them.
test('every refusal reads exactly the same', async () => {
  const messages = new Set<string>();
  for (const [, rows, sessionId] of REFUSED) {
    const f = makeService(rows);
    await f.inSession({ title: 'Crawl' }, sessionId).catch((e: ForbiddenException) => {
      messages.add(JSON.stringify(e.getResponse()));
    });
  }

  assert.equal(messages.size, 1, `refusals differ: ${[...messages].join(' | ')}`);
});

// ── What did not change ───────────────────────────────────────────────────────────────────────

// The logged-in user's POST /projects has no current agent session to inherit from, and inventing
// a global "current session" for it would be a guess. It keeps creating projects with no default,
// which `coordinator` still answers by borrowing from the tasks or by asking.
test('a create with no session context stores no default at all', async () => {
  const f = makeService();

  await f.headless({ title: 'Crawl' });

  assert.equal('coordinatorWorkspaceId' in f.creates[0], false);
  assert.deepEqual(f.lookups, [], 'a headless create must not look a session up');
});
