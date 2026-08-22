import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { RunStatus, SessionDispatchOrigin } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

/**
 * The inbox is the first read in the product that crosses every workspace and project at once,
 * and the first that carries how long something has been waiting. Both of those are properties
 * of the QUERY, not of the mapping — so the fake below evaluates the `where` and `orderBy` the
 * service actually builds rather than handing back a canned list. Drop the owner scope, the
 * Open/generating gate or the `resolvedSince` window and these tests fail.
 *
 * Every excluded fixture row is deliberately OLDER than every included one: a filter that leaks
 * does not merely add a row, it puts that row at the top of the list.
 */

// ── The account under test ──────────────────────────────────────────────────────────────────
const OWNER = '01a02427-6cb5-7ae0-ae3c-ffe57116c33e';
const STRANGER = '01a02427-6cb5-7ae0-ae3c-ffe57116c33f';
const WORKSPACE_A = '0198c0d2-1111-7000-8000-00000000000a';
const WORKSPACE_B = '0198c0d2-1111-7000-8000-00000000000b';
const PROJECT = '0198c0d2-2222-7000-8000-000000000001';
const TASK_BUILD = '0198c0d2-3333-7000-8000-000000000001';
const TASK_VERIFY = '0198c0d2-3333-7000-8000-000000000002';
const SESSION_COORDINATOR = '0198c0d2-4444-7000-8000-000000000001';
const SESSION_VERIFY = '0198c0d2-4444-7000-8000-000000000002';
const SESSION_EXECUTE = '0198c0d2-4444-7000-8000-000000000003';
const SESSION_USER = '0198c0d2-4444-7000-8000-000000000004';
const SESSION_SELF_DRIVEN = '0198c0d2-4444-7000-8000-000000000005';

const at = (hhmm: string): Date => new Date(`2026-08-22T${hhmm}:00.000Z`);

interface FakeTask {
  id: string;
  title: string;
  verifiesTaskId: string | null;
  project: { id: string; title: string } | null;
}

interface FakeSession {
  ownerId: string;
  title: string;
  workspaceId: string | null;
  dispatchOrigin: SessionDispatchOrigin;
  status: RunStatus;
  engineTurnActive: boolean;
  completedAt: Date | null;
  archivedAt: Date | null;
  deletedAt: Date | null;
  task: FakeTask | null;
}

interface FakeApproval {
  id: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  status: string;
  message: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  session: FakeSession;
}

const buildTask: FakeTask = {
  id: TASK_BUILD,
  title: 'Ship the inbox endpoint',
  verifiesTaskId: null,
  project: { id: PROJECT, title: 'Attention inbox' },
};
const verifyTask: FakeTask = {
  id: TASK_VERIFY,
  title: 'Check the inbox endpoint',
  verifiesTaskId: TASK_BUILD,
  project: { id: PROJECT, title: 'Attention inbox' },
};

function session(over: Partial<FakeSession>): FakeSession {
  return {
    ownerId: OWNER,
    title: 'a session',
    workspaceId: WORKSPACE_A,
    dispatchOrigin: SessionDispatchOrigin.USER,
    status: RunStatus.RUNNING,
    engineTurnActive: false,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    task: null,
    ...over,
  };
}

/** Waiting on a human, in the order they started waiting. */
const PENDING: FakeApproval[] = [
  {
    id: '0198c0d2-5555-7000-8000-000000000001',
    sessionId: SESSION_COORDINATOR,
    toolName: 'AskUserQuestion',
    input: { questions: [{ question: 'Group the sidebar by project?', header: 'Grouping' }] },
    status: 'PENDING',
    message: null,
    createdAt: at('09:00'),
    decidedAt: null,
    // No task: a coordinator's project is only reachable back through Project.
    session: session({ title: 'Coordinate the redesign', workspaceId: WORKSPACE_A }),
  },
  {
    id: '0198c0d2-5555-7000-8000-000000000002',
    sessionId: SESSION_VERIFY,
    toolName: 'ExitPlanMode',
    input: { plan: 'Re-run the spec, then diff the payload\nagainst the recorded fixture' },
    status: 'PENDING',
    message: null,
    createdAt: at('09:30'),
    session: session({
      title: 'Verify the endpoint',
      workspaceId: WORKSPACE_B,
      dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR,
      task: verifyTask,
    }),
    decidedAt: null,
  },
  {
    id: '0198c0d2-5555-7000-8000-000000000003',
    sessionId: SESSION_EXECUTE,
    toolName: 'Bash',
    input: { command: 'npx tsc -p tsconfig.test.json', description: 'typecheck' },
    status: 'PENDING',
    message: null,
    createdAt: at('10:00'),
    decidedAt: null,
    session: session({
      title: 'Build the endpoint',
      workspaceId: WORKSPACE_B,
      dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR,
      task: buildTask,
    }),
  },
  {
    id: '0198c0d2-5555-7000-8000-000000000004',
    sessionId: SESSION_USER,
    toolName: 'Write',
    input: { file_path: 'docs/inbox.md', content: 'notes' },
    status: 'PENDING',
    message: null,
    createdAt: at('11:00'),
    decidedAt: null,
    session: session({ title: 'Scratch', workspaceId: WORKSPACE_A }),
  },
  {
    id: '0198c0d2-5555-7000-8000-000000000005',
    sessionId: SESSION_SELF_DRIVEN,
    toolName: 'Bash',
    input: { command: 'git push --force' },
    status: 'PENDING',
    message: null,
    createdAt: at('11:30'),
    decidedAt: null,
    // A turn the runtime started for itself never reaches /turn-complete, so it sits at
    // AWAITING_INPUT for its whole duration. Its prompt blocks exactly as much.
    session: session({
      title: 'Woke itself up',
      status: RunStatus.AWAITING_INPUT,
      engineTurnActive: true,
    }),
  },
];

/** PENDING rows that must never reach the inbox — each older than everything above. */
const EXCLUDED: FakeApproval[] = [
  {
    id: '0198c0d2-6666-7000-8000-000000000001',
    sessionId: '0198c0d2-4444-7000-8000-00000000000a',
    toolName: 'Bash',
    input: { command: 'echo completed' },
    status: 'PENDING',
    message: null,
    createdAt: at('08:00'),
    decidedAt: null,
    session: session({ title: 'Already completed', completedAt: at('08:05') }),
  },
  {
    id: '0198c0d2-6666-7000-8000-000000000002',
    sessionId: '0198c0d2-4444-7000-8000-00000000000b',
    toolName: 'Bash',
    input: { command: 'echo mirrored' },
    status: 'PENDING',
    message: null,
    createdAt: at('08:10'),
    decidedAt: null,
    // Only the compatibility mirror set, as an older replica would have written it.
    session: session({ title: 'Completed by an old replica', archivedAt: at('08:12') }),
  },
  {
    id: '0198c0d2-6666-7000-8000-000000000003',
    sessionId: '0198c0d2-4444-7000-8000-00000000000c',
    toolName: 'Bash',
    input: { command: 'echo idle' },
    status: 'PENDING',
    message: null,
    createdAt: at('08:20'),
    decidedAt: null,
    session: session({
      title: 'Idle, nothing generating',
      status: RunStatus.AWAITING_INPUT,
      engineTurnActive: false,
    }),
  },
  {
    id: '0198c0d2-6666-7000-8000-000000000004',
    sessionId: '0198c0d2-4444-7000-8000-00000000000d',
    toolName: 'Bash',
    input: { command: 'echo trashed' },
    status: 'PENDING',
    message: null,
    createdAt: at('08:30'),
    decidedAt: null,
    session: session({ title: 'In the trash', deletedAt: at('08:31') }),
  },
  {
    id: '0198c0d2-6666-7000-8000-000000000005',
    sessionId: '0198c0d2-4444-7000-8000-00000000000e',
    toolName: 'Bash',
    input: { command: 'echo not yours' },
    status: 'PENDING',
    message: null,
    createdAt: at('08:40'),
    decidedAt: null,
    session: session({ title: "Somebody else's", ownerId: STRANGER }),
  },
];

const RESOLVED: FakeApproval[] = [
  {
    id: '0198c0d2-7777-7000-8000-000000000001',
    sessionId: SESSION_EXECUTE,
    toolName: 'Bash',
    input: { command: 'npm install' },
    status: 'ALLOWED',
    message: null,
    createdAt: at('11:40'),
    decidedAt: at('12:00'),
    session: session({
      title: 'Build the endpoint',
      workspaceId: WORKSPACE_B,
      dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR,
      task: buildTask,
    }),
  },
  {
    id: '0198c0d2-7777-7000-8000-000000000002',
    sessionId: SESSION_VERIFY,
    toolName: 'Bash',
    input: { command: 'rm -rf build' },
    status: 'DENIED',
    message: 'not that one',
    createdAt: at('11:45'),
    decidedAt: at('12:30'),
    session: session({
      title: 'Verify the endpoint',
      workspaceId: WORKSPACE_B,
      dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR,
      task: verifyTask,
    }),
  },
  {
    id: '0198c0d2-7777-7000-8000-000000000003',
    sessionId: SESSION_EXECUTE,
    toolName: 'Bash',
    input: { command: 'echo yesterday' },
    status: 'ALLOWED',
    message: null,
    createdAt: at('01:00'),
    decidedAt: new Date('2026-08-21T12:00:00.000Z'),
    session: session({ title: 'Build the endpoint', workspaceId: WORKSPACE_B }),
  },
  {
    id: '0198c0d2-7777-7000-8000-000000000004',
    sessionId: '0198c0d2-4444-7000-8000-00000000000e',
    toolName: 'Bash',
    input: { command: 'echo not yours either' },
    status: 'ALLOWED',
    message: null,
    createdAt: at('11:50'),
    decidedAt: at('12:10'),
    session: session({ title: "Somebody else's", ownerId: STRANGER }),
  },
];

const PROJECTS = [
  { id: PROJECT, title: 'Attention inbox', ownerId: OWNER, coordinatorSessionId: SESSION_COORDINATOR },
  // A project of another account whose coordinator id would otherwise collide with nothing —
  // present so the owner scope on the reverse lookup is exercised too.
  {
    id: '0198c0d2-2222-7000-8000-000000000002',
    title: "Stranger's project",
    ownerId: STRANGER,
    coordinatorSessionId: SESSION_USER,
  },
];

// ── A Prisma stand-in that evaluates the query rather than ignoring it ───────────────────────

const OPERATORS = new Set(['equals', 'not', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte']);
type Where = Record<string, unknown>;

const ms = (value: unknown): number => (value instanceof Date ? value.getTime() : NaN);

function matches(row: unknown, where: Where): boolean {
  if (row == null || typeof row !== 'object') return false;
  const record = row as Record<string, unknown>;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((c) => matches(row, c));
    if (key === 'AND') return (cond as Where[]).every((c) => matches(row, c));
    return matchField(record[key], cond);
  });
}

/** A condition is one of: a literal, `null`, a Date, an operator object, or — the only other
 *  thing Prisma allows in this position — a filter on a related row. No field in this model is
 *  named after an operator, so the two object shapes are told apart by their keys. */
function matchField(value: unknown, cond: unknown): boolean {
  if (cond === null) return value == null;
  if (cond instanceof Date) return ms(value) === ms(cond);
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
    const entries = Object.entries(cond as Where);
    if (entries.length > 0 && entries.every(([k]) => OPERATORS.has(k))) {
      return entries.every(([op, operand]) => applyOperator(op, value, operand));
    }
    return matches(value, cond as Where);
  }
  return value === cond;
}

function applyOperator(op: string, value: unknown, operand: unknown): boolean {
  switch (op) {
    case 'equals':
      return matchField(value, operand);
    case 'not':
      return !matchField(value, operand);
    case 'in':
      return (operand as unknown[]).includes(value);
    case 'notIn':
      return !(operand as unknown[]).includes(value);
    case 'gt':
      return ms(value) > ms(operand);
    case 'gte':
      return ms(value) >= ms(operand);
    case 'lt':
      return ms(value) < ms(operand);
    case 'lte':
      return ms(value) <= ms(operand);
    default:
      throw new Error(`the fake prisma does not implement the ${op} operator`);
  }
}

function findMany<T>(rows: T[]) {
  return async (args: {
    where?: Where;
    orderBy?: Record<string, 'asc' | 'desc'>;
    take?: number;
  }): Promise<T[]> => {
    const out = rows.filter((row) => matches(row, args.where ?? {}));
    const order = args.orderBy && Object.entries(args.orderBy)[0];
    if (order) {
      const [field, direction] = order;
      out.sort(
        (a, b) =>
          (ms((a as Record<string, unknown>)[field]) - ms((b as Record<string, unknown>)[field])) *
          (direction === 'desc' ? -1 : 1),
      );
    }
    return args.take == null ? out : out.slice(0, args.take);
  };
}

const fakePrisma = (): PrismaService =>
  ({
    approval: { findMany: findMany([...PENDING, ...EXCLUDED, ...RESOLVED]) },
    project: { findMany: findMany(PROJECTS) },
  }) as unknown as PrismaService;

const service = (): InboxService => new InboxService(fakePrisma());

// ── The contract ────────────────────────────────────────────────────────────────────────────

test('one list spans every workspace the account is waiting on', async () => {
  const { pending } = await service().list(OWNER);

  const workspaces = new Set(pending.map((item) => item.workspaceId));
  assert.deepEqual(
    [...workspaces].sort(),
    [WORKSPACE_A, WORKSPACE_B].sort(),
    'both workspaces contribute — this is the query the per-session endpoint could not express',
  );
  assert.equal(
    pending.filter((item) => item.workspaceId === WORKSPACE_A).length,
    3,
    'workspace A: the coordinator, the scratch session and the self-driven turn',
  );
  assert.equal(
    pending.filter((item) => item.workspaceId === WORKSPACE_B).length,
    2,
    'workspace B: the verification and the execution session',
  );
});

test('the list is ordered by how long each thing has been waiting, oldest first', async () => {
  const { pending } = await service().list(OWNER);

  assert.deepEqual(
    pending.map((item) => item.waitingSince),
    [
      at('09:00').toISOString(),
      at('09:30').toISOString(),
      at('10:00').toISOString(),
      at('11:00').toISOString(),
      at('11:30').toISOString(),
    ],
  );
  assert.equal(pending[0].sessionTitle, 'Coordinate the redesign', 'blocked longest, so first');
});

test('nothing that is not the human’s turn gets in', async () => {
  const { pending } = await service().list(OWNER);

  // Every excluded fixture is older than every included one, so a leak lands at the top.
  assert.equal(pending.length, 5);
  const titles = pending.map((item) => item.sessionTitle);
  for (const gone of [
    'Already completed',
    'Completed by an old replica',
    'Idle, nothing generating',
    'In the trash',
    "Somebody else's",
  ]) {
    assert.ok(!titles.includes(gone), `${gone} must not be in the inbox`);
  }
  assert.ok(
    titles.includes('Woke itself up'),
    'a self-driven turn is generating, and its prompt blocks like any other',
  );
});

test('what a card says it is, and who is asking', async () => {
  const { pending } = await service().list(OWNER);
  const by = (title: string) => pending.find((item) => item.sessionTitle === title)!;

  const question = by('Coordinate the redesign');
  assert.equal(question.kind, 'question');
  assert.equal(question.summary, 'Group the sidebar by project?');
  assert.equal(question.role, 'coordinator', 'named as the coordinator of a project, not by a task');
  assert.equal(question.projectId, PROJECT, 'reached backwards through Project.coordinatorSessionId');
  assert.equal(question.projectTitle, 'Attention inbox');
  assert.equal(question.taskId, undefined, 'a coordinator session carries no task');

  const plan = by('Verify the endpoint');
  assert.equal(plan.kind, 'plan');
  assert.equal(plan.summary, 'Re-run the spec, then diff the payload', 'one line, not the whole plan');
  assert.equal(plan.role, 'verification', 'its task verifies another one');
  assert.equal(plan.taskId, TASK_VERIFY);
  assert.equal(plan.taskTitle, 'Check the inbox endpoint');
  assert.equal(plan.projectId, PROJECT, 'through its task this time');

  const permission = by('Build the endpoint');
  assert.equal(permission.kind, 'permission');
  assert.equal(permission.toolName, 'Bash');
  assert.equal(permission.summary, 'npx tsc -p tsconfig.test.json', 'the command, not the description');
  assert.equal(permission.role, 'execution', 'dispatched by the project coordinator');

  const mine = by('Scratch');
  assert.equal(mine.kind, 'permission');
  assert.equal(mine.summary, 'docs/inbox.md', 'a Write names its file');
  assert.equal(mine.role, 'user', 'nobody dispatched it');
  assert.equal(mine.projectId, undefined, 'and a stranger’s project must not claim it');
});

test('the resolved window is only asked for, and only ever answers within itself', async () => {
  const quiet = await service().list(OWNER);
  assert.deepEqual(quiet.resolved, [], 'no window asked for, nothing to sift');

  const { resolved } = await service().list(OWNER, at('11:59').toISOString());
  assert.deepEqual(
    resolved.map((item) => item.approvalId),
    ['0198c0d2-7777-7000-8000-000000000002', '0198c0d2-7777-7000-8000-000000000001'],
    'most recently settled first; yesterday’s and the stranger’s are both out',
  );

  const [denied, allowed] = resolved;
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.status, 'DENIED');
  assert.equal(denied.message, 'not that one');
  assert.equal(denied.resolvedAt, at('12:30').toISOString());
  assert.equal(denied.waitingSince, at('11:45').toISOString(), 'still says how long it sat there');
  assert.equal(denied.role, 'verification');
  assert.equal(allowed.decision, 'allow');
  assert.equal(allowed.status, 'ALLOWED');
  assert.equal(allowed.message, undefined);
});

test('a window the caller opened too wide is bounded, and bounded from the old end', async () => {
  // resolvedSince=<the epoch> asks for every approval the account has ever answered.
  const many = Array.from({ length: 250 }, (_, i) => ({
    ...RESOLVED[0],
    id: `0198c0d2-8888-7000-8000-${String(i).padStart(12, '0')}`,
    // i=0 is the newest, so the last 50 are the ones a cap should drop.
    decidedAt: new Date(at('12:00').getTime() - i * 60_000),
  }));
  const wide = new InboxService({
    approval: { findMany: findMany(many) },
    project: { findMany: findMany(PROJECTS) },
  } as unknown as PrismaService);

  const { resolved } = await wide.list(OWNER, '1970-01-01T00:00:00.000Z');
  assert.equal(resolved.length, 200);
  assert.equal(resolved[0].resolvedAt, at('12:00').toISOString(), 'the newest is kept');
  assert.equal(
    resolved[199].resolvedAt,
    new Date(at('12:00').getTime() - 199 * 60_000).toISOString(),
    'and what falls off the end is the oldest, not an arbitrary slice',
  );
});

test('an unreadable window is refused rather than quietly widened', async () => {
  await assert.rejects(() => service().list(OWNER, 'today'), /resolvedSince/);
});

// ── The same thing over a socket ─────────────────────────────────────────────────────────────

const SECRET = 'inbox-spec-secret';

@Module({
  imports: [JwtModule.register({ secret: SECRET })],
  controllers: [InboxController],
  providers: [InboxService, JwtAuthGuard, { provide: PrismaService, useValue: fakePrisma() }],
})
class LiveInboxModule {}

const RAW_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test('over real HTTP, every id in the payload is a public id', async (t) => {
  const app = await NestFactory.create(LiveInboxModule, { logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  app.useGlobalFilters(new PublicIdExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  const token = app.get(JwtService).sign({ sub: OWNER, email: 'owner@example.com' });
  const get = async (query = '') => {
    const response = await fetch(`${base}/api/inbox${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: response.status, text: await response.text() };
  };

  const { status, text } = await get(`?resolvedSince=${encodeURIComponent(at('11:59').toISOString())}`);
  assert.equal(status, 200);
  assert.ok(
    !RAW_UUID.test(text),
    `a raw uuid reached the wire: ${text.slice(Math.max(0, text.search(RAW_UUID) - 60))}`,
  );

  const body = JSON.parse(text) as {
    pending: Record<string, string>[];
    resolved: Record<string, string>[];
  };
  assert.equal(body.pending.length, 5);
  assert.equal(body.resolved.length, 2);
  assert.equal(body.pending[0].approvalId, uuidToBase62('0198c0d2-5555-7000-8000-000000000001'));
  assert.equal(body.pending[0].approvalPublicId, body.pending[0].approvalId, 'and its twin');
  assert.equal(body.pending[0].sessionId, uuidToBase62(SESSION_COORDINATOR));
  assert.equal(body.pending[0].projectId, uuidToBase62(PROJECT));
  assert.equal(body.pending[0].workspaceId, uuidToBase62(WORKSPACE_A));
  assert.equal(body.pending[0].agentId, body.pending[0].workspaceId, 'the pre-rename alias');
  assert.equal(body.pending[2].taskId, uuidToBase62(TASK_BUILD));

  assert.equal((await get('?resolvedSince=today')).status, 400, 'and a bad window is a 400');
  const anonymous = await fetch(`${base}/api/inbox`);
  assert.equal(anonymous.status, 401, 'the inbox is somebody’s, so it needs a bearer token');
});
