import assert from 'node:assert/strict';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { test } from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { lastValueFrom, of } from 'rxjs';
import { uuidToBase62 } from '@orbit/shared';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { buildCoordinatorInstructions } from './coordinator-opening';
import { CreateProjectDto } from './dto';
import { ProjectsService } from './projects.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const OTHER_OWNER_ID = '00000000-0000-7000-8000-000000000002';
const RUNNER_ID = '00000000-0000-7000-8000-0000000000b1';
const OTHER_RUNNER_ID = '00000000-0000-7000-8000-0000000000b2';
const SESSION_ID = '00000000-0000-7000-8000-0000000000c1';
const WORKSPACE_ID = '00000000-0000-7000-8000-0000000000d1';
const PROJECT_ID = '00000000-0000-7000-8000-0000000000e1';
/** The conversation the fallback opens for a project the acting session may not coordinate. */
const SECOND_SESSION_ID = '00000000-0000-7000-8000-0000000000c2';

interface SessionRow {
  id: string;
  title: string;
  prompt: string;
  titleManagedByProject: boolean;
  titleBeforeProjectManagement: string | null;
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
  title: 'Explore the corpus',
  prompt: 'Explore the corpus and decide what work should be recorded.',
  titleManagedByProject: false,
  titleBeforeProjectManagement: null,
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

/** The unique violation Postgres raises on `coordinator_session_id`, as Prisma reports it. */
function uniqueCoordinator(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.20.0',
    meta: { target: ['coordinator_session_id'] },
  });
}

function makeService(rows: SessionRow[] = [LIVE], insertFails?: Error) {
  rows = rows.map((row) => ({ ...row }));
  const creates: Record<string, unknown>[] = [];
  const lookups: Record<string, unknown>[] = [];
  const sessionUpdateSql: string[] = [];
  const sessionCreates: unknown[][] = [];
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
        // The row the insert WOULD have written is recorded before it fails, so a test can assert
        // that a rejected create left nothing behind — the database writes no row for a statement
        // that raises, and `creates` here is the statement rather than the row.
        creates.push(data);
        if (insertFails) throw insertFails;
        // Plus the two rows every project response is folded from, in the shape the include asks
        // for (the nested writes above are what CREATES them; this is what reading them back
        // looks like).
        return { id: PROJECT_ID, ...data, members: [], runtime: { coordinatorGeneration: 0n } };
      },
      // The re-read a structured create makes after writing its criterion definitions, so the
      // response carries the rows the database normalized rather than the ones it was sent.
      findUniqueOrThrow: async () => ({
        id: PROJECT_ID,
        ...(creates[creates.length - 1] ?? {}),
        members: [],
        runtime: { coordinatorGeneration: 0n },
      }),
      // A binding applied by a follow-up write would leave a window in which the project exists
      // pointing at no conversation, so reaching for either of these is a failure, not an
      // alternative.
      update: async () => {
        throw new Error('the coordinator binding must be written in the create, not after it');
      },
      updateMany: async () => {
        throw new Error('the coordinator binding must be written in the create, not after it');
      },
    },
    $queryRaw: async (...args: unknown[]) => {
      const { text, values: bound } = renderRawQuery(args);
      if (text.includes('FROM "user"')) return [{ id: OWNER_ID }];
      if (text.includes('FROM "workspace"')) return [{ id: WORKSPACE_ID }];
      if (!text.includes('UPDATE "session"')) throw new Error(`unexpected raw query: ${text}`);
      sessionUpdateSql.push(text);
      const [title, id, ownerId, workspaceId] = bound as string[];
      const row = rows.find(
        (candidate) =>
          candidate.id === id &&
          candidate.ownerId === ownerId &&
          candidate.workspaceId === workspaceId &&
          candidate.deletedAt === null,
      );
      if (!row) return [];
      if (!row.titleManagedByProject && row.titleBeforeProjectManagement === null) {
        row.titleBeforeProjectManagement = row.title;
      }
      row.title = title;
      row.titleManagedByProject = true;
      return [{ id: row.id }];
    },
    $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
      const before = rows.map((row) => ({ ...row }));
      try {
        return await work(prisma);
      } catch (error) {
        rows.splice(0, rows.length, ...before);
        throw error;
      }
    },
  } as never;

  const service = new ProjectsService(prisma, {} as never, {
    create: async (...args: unknown[]) => {
      sessionCreates.push(args);
      throw new Error('promotion must reuse the existing session');
    },
    announceProjectSessionChanged() {},
  } as never);
  return {
    creates,
    lookups,
    sessionCreates,
    sessionUpdateSql,
    sessions: rows,
    /**
     * Record what the ALREADY_COORDINATING fallback delegates, instead of running it.
     *
     * `createInWorkspace` is a composition of three calls this fixture does not model — opening a
     * coordinator takes a session, three lock reads and a compare-and-swap — and its own contract
     * is asserted where those are modelled. What belongs HERE is the decision: that the fallback
     * happens at all, and that the workspace it hands on is the acting session's own rather than
     * anything a caller could have chosen.
     */
    delegateTo(calls: unknown[], project: Record<string, unknown>) {
      (service as unknown as Record<string, unknown>).createInWorkspace = async (
        ...args: unknown[]
      ) => {
        calls.push(args);
        return project;
      };
    },
    inSession: (dto: CreateProjectDto, sessionId = SESSION_ID, runnerId = RUNNER_ID) =>
      service.createInSession(OWNER_ID, runnerId, sessionId, dto),
    /** The seeded create on its own, which is where the unique violation is translated. */
    seeded: (dto: CreateProjectDto) =>
      service.create(OWNER_ID, dto, { sessionId: SESSION_ID, workspaceId: WORKSPACE_ID }, {
        type: 'RUNNER',
        id: RUNNER_ID,
      }),
    headless: (dto: CreateProjectDto) => service.create(OWNER_ID, dto),
  };
}

/**
 * The created project as a CLIENT receives it, through the interceptor every non-machine response
 * passes on its way out.
 *
 * The binding is only worth writing if it can be read back, and read back in the spelling the
 * caller addresses things by: `id` in a payload an agent or the web app sees is base62, and the
 * two coordinator columns are in `PUBLIC_ID_FIELDS` so that they are too. Asserting on the raw row
 * would prove the column and not the contract.
 */
function asClientSees(body: unknown): Promise<Record<string, unknown>> {
  class ProjectsController {}
  const interceptor = new PublicIdInterceptor();
  return lastValueFrom(
    interceptor.intercept({ getClass: () => ProjectsController } as never, {
      handle: () => of(body),
    } as never),
  ) as Promise<Record<string, unknown>>;
}

// ── The rule ──────────────────────────────────────────────────────────────────────────────────

test('a project created inside a session is coordinated BY that session', async () => {
  const f = makeService();

  await f.inSession({ title: 'Crawl', goal: 'Index the corpus' });

  assert.equal(f.creates.length, 1);
  // Both halves, off the one session row: the conversation the work was planned in, and where
  // that conversation runs. Recording only the workspace was the near miss this test exists to
  // pin — the project was openable, but opening it started a stranger in the right room.
  assert.equal(f.creates[0].coordinatorSessionId, SESSION_ID);
  assert.equal(f.creates[0].coordinatorWorkspaceId, WORKSPACE_ID);
  // The project is still the project: the session decides which conversation coordinates it and
  // nothing about what the work is.
  assert.equal(f.creates[0].ownerId, OWNER_ID);
  assert.equal(f.creates[0].title, 'Crawl');
  assert.equal(f.creates[0].goal, 'Index the corpus');
  assert.equal(f.sessions[0].title, 'Crawl');
  assert.equal(f.sessions[0].titleManagedByProject, true);
  assert.equal(f.sessions[0].titleBeforeProjectManagement, 'Explore the corpus');
});

test('promotion tells the current turn its coordinator role without rewriting its opening', async () => {
  const f = makeService();
  const originalPrompt = f.sessions[0].prompt;

  const created = await f.inSession({ title: 'Crawl', goal: 'Index the corpus' });

  assert.equal(f.sessions[0].prompt, originalPrompt);
  assert.deepEqual(f.sessionCreates, []);
  assert.equal(f.sessionUpdateSql.length, 1);
  assert.doesNotMatch(f.sessionUpdateSql[0], /"prompt"/i);
  assert.equal(
    created.coordinatorInstructions,
    buildCoordinatorInstructions('Crawl', PROJECT_ID),
  );
  assert.match(created.coordinatorInstructions, /不是用来替它干活/);
  assert.match(created.coordinatorInstructions, /先读再说/);
  assert.match(created.coordinatorInstructions, /账号所有者通道记录/);
});

test('a headless project create does not invent a coordinator transition', async () => {
  const f = makeService();

  const created = await f.headless({ title: 'Nightly sweep' });

  assert.equal('coordinatorInstructions' in created, false);
});

// The binding as a client actually reads it: the project comes back already naming the session
// and workspace it was created in, in base62. A binding written to a column nobody can read in
// the spelling they address things by is a binding that does not exist to the caller — and the
// agent that just created the project is the first caller that needs to act on it.
test('the created project already names its session and workspace, in base62', async () => {
  const f = makeService();

  const created = await asClientSees(await f.inSession({ title: 'Crawl' }));

  assert.equal(created.coordinatorSessionId, uuidToBase62(SESSION_ID));
  assert.equal(created.coordinatorWorkspaceId, uuidToBase62(WORKSPACE_ID));
  assert.equal(created.coordinatorSessionPublicId, uuidToBase62(SESSION_ID));
  assert.equal(created.coordinatorWorkspacePublicId, uuidToBase62(WORKSPACE_ID));
  // The instruction string is already in the public-id spelling accepted by the tools. The
  // interceptor converts object fields, not prose embedded inside a tool result.
  assert.match(created.coordinatorInstructions as string, new RegExp(uuidToBase62(PROJECT_ID)));
  assert.doesNotMatch(created.coordinatorInstructions as string, new RegExp(PROJECT_ID));
});

// A project is bound or it is not, and it must not be briefly neither. One insert also means
// there is no failure mode where the row lands and the binding does not — which is the whole of
// "atomically", and the reason `update`/`updateMany` throw in the fixture above.
test('both halves of the binding are part of the insert, not a second write', async () => {
  const f = makeService();

  await f.inSession({ title: 'Crawl' });

  // `members` and `runtime` are nested writes of the SAME statement, and they are here for the
  // same reason the two columns are: the coordinating identity and the project's runtime row must
  // never be a follow-up write that can fail on its own and leave a project half-bound.
  assert.deepEqual(Object.keys(f.creates[0]).sort(), [
    'automationPolicy',
    'coordinatorEnabled',
    'coordinatorSessionId',
    'coordinatorWorkspaceId',
    'goal',
    'instructions',
    'members',
    'ownerId',
    'runtime',
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
  // Bound in the spelling the column keys by, not the spelling the header arrived in: a base62
  // value in a `@db.Uuid` column is a P2023 at insert time, and the FK would name nothing.
  assert.equal(f.creates[0].coordinatorSessionId, SESSION_ID);
  assert.equal(f.creates[0].coordinatorWorkspaceId, WORKSPACE_ID);
});

// The prose rules are the DTO's and the service's, and they are the same rules whichever door the
// project came in by — otherwise an agent's blank goal and a person's blank goal are two different
// stored states.
test('prose is shaped exactly as it is on the headless path', async () => {
  const f = makeService();

  await f.inSession({ title: 'Crawl', goal: '   ', instructions: 'Every shard reported' });

  assert.equal(f.creates[0].goal, null);
  assert.equal(f.creates[0].instructions, 'Every shard reported');
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
    // The refusal is the point. A project created anyway, minus its binding, is the unbound
    // project this path exists to stop producing — and one pointing at somebody else's
    // conversation would be worse.
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

// ── One session coordinates at most one project ───────────────────────────────────────────────

// `coordinator_session_id` is UNIQUE, so the SECOND project recorded from one conversation is a
// unique violation rather than a second binding. The rule stands; what follows it changed. Being
// refused left the caller one move it could actually make — drop the session header and retry —
// and that move records a project coordinated by NOBODY, which is the one thing this path exists
// to stop producing. So the second project gets a conversation of its own instead.
test('a second project from the same session gets its OWN coordinator, in the same workspace', async () => {
  const f = makeService([LIVE], uniqueCoordinator());
  const delegated: unknown[] = [];
  f.delegateTo(delegated, { id: PROJECT_ID, title: 'Crawl again', coordinatorSessionId: SECOND_SESSION_ID });

  const result = await f.inSession({ title: 'Crawl again' }) as { coordinatorInstructions: string };

  // The landing is STILL server-derived — the acting session's own workspace, not anything the
  // caller named. Only the conversation is new, so this widens no authority.
  assert.equal(delegated.length, 1);
  assert.deepEqual((delegated[0] as unknown[]).slice(0, 1), [OWNER_ID]);
  assert.equal((delegated[0] as unknown[])[2], WORKSPACE_ID);
  assert.deepEqual((delegated[0] as unknown[])[3], { type: 'RUNNER', id: RUNNER_ID });

  // And the caller is told it was NOT promoted. Saying nothing would be read as the promotion,
  // since that is what recording a project from a session has always meant.
  assert.match(result.coordinatorInstructions, /协调会话不是你/);
  assert.notEqual(
    result.coordinatorInstructions,
    buildCoordinatorInstructions('Crawl again', PROJECT_ID),
  );

  // The first attempt still wrote nothing. One statement is what makes half-written unreachable:
  // the insert that would have carried the binding is the insert that raised, so there is no
  // project row and no dangling pointer from it — the project that exists is the one the fallback
  // created, and it is not this one.
  assert.equal(f.creates.length, 1, 'exactly one seeded statement was attempted');
  assert.equal(f.creates[0].coordinatorSessionId, SESSION_ID);
  assert.equal(f.sessions[0].title, 'Explore the corpus', 'the failed transaction rolls the rename back');
  assert.equal(f.sessions[0].titleManagedByProject, false);
});

// The rule itself is still a 409 with a code, because `createInSession` is what answers it and it
// answers it by reading that code. A translation that stopped happening would reach the fallback
// as an unhandled P2002 — a bare 500 for a case that now has a working outcome.
test('the unique violation is still translated into a code the fallback can switch on', async () => {
  const f = makeService([LIVE], uniqueCoordinator());

  // Asserted at its SOURCE — the seeded create — rather than through `createInSession`, which no
  // longer lets it out. An untranslated P2002 would reach the fallback as a bare Prisma error and
  // be rethrown as a 500 for a case that now has a working outcome.
  await assert.rejects(
    () => f.seeded({ title: 'Crawl again' }),
    (e: unknown) => {
      assert.ok(e instanceof ConflictException, `expected a 409, got ${String(e)}`);
      assert.deepEqual(e.getResponse(), {
        statusCode: 409,
        error: 'Conflict',
        code: 'ALREADY_COORDINATING',
        message:
          'this session already coordinates another project, and a session coordinates at most one',
      });
      return true;
    },
  );
});

// Only the unique violation, and only where one can happen. A P2002 is translated because there
// is exactly one unique index this insert can hit; anything else — a dead connection, a failed FK
// — is a different failure and must not be reported as "that session is taken".
test('any other database failure is not dressed up as a conflict', async () => {
  const other = new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
    code: 'P2003',
    clientVersion: '5.20.0',
  });
  const f = makeService([LIVE], other);

  await assert.rejects(
    () => f.inSession({ title: 'Crawl' }),
    (e: unknown) => e === other,
  );
  assert.equal(f.sessions[0].title, 'Explore the corpus');
  assert.equal(f.sessions[0].titleManagedByProject, false);
});

// The headless path seeds no coordinator, so it cannot violate that index — and a P2002 arriving
// on it means something else entirely. Translating it would tell a cron bridge with no session at
// all that its session already coordinates a project.
test('a headless create never reports the session conflict', async () => {
  const f = makeService([LIVE], uniqueCoordinator());

  await assert.rejects(
    () => f.headless({ title: 'Nightly sweep' }),
    (e: unknown) =>
      e instanceof Prisma.PrismaClientKnownRequestError && !(e instanceof ConflictException),
  );
});

// ── What did not change ───────────────────────────────────────────────────────────────────────

// The logged-in user's POST /projects has no current agent session to bind, and inventing a
// global "current session" for it would be a guess. It keeps creating projects bound to nothing,
// which `coordinator` still answers by opening one — borrowing a workspace from the tasks, or
// asking. This is the path that must not regress: the user-facing create has to go on working
// exactly as it did.
test('a create with no session context binds nothing at all', async () => {
  const f = makeService();

  const created = await f.headless({ title: 'Crawl' });

  assert.equal('coordinatorSessionId' in f.creates[0], false);
  assert.equal('coordinatorWorkspaceId' in f.creates[0], false);
  assert.equal(created.title, 'Crawl', 'and it still creates the project');
  assert.deepEqual(f.lookups, [], 'a headless create must not look a session up');
});
