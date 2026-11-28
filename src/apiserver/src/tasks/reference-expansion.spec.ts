import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { parseBareIds, parseReferences, ReferenceExpansionService } from './reference-expansion';

const LIST_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';
const OWNER = '5ccdf9b9-6871-49a6-8595-839c6a1f79d2';
/** What those two are called everywhere the agent can see them, `task_get` / `tasklist_get` included. */
const LIST_PUBLIC_ID = uuidToBase62(LIST_ID);
const TASK_PUBLIC_ID = uuidToBase62(TASK_ID);

const listRef = (id = LIST_ID) => `[FineWeb](orbit-list:${id})`;
const taskRef = (id = TASK_ID) => `[W 009](orbit-task:${id})`;

function makeService(opts: { ownedList?: boolean; ownedTask?: boolean } = {}) {
  const queries: string[] = [];
  const prisma = {
    taskList: {
      findFirst: async ({ where }: any) => {
        queries.push('taskList');
        return opts.ownedList === false || where.ownerId !== OWNER
          ? null
          : {
              id: LIST_ID,
              title: 'FineWeb CC-MAIN-2025-26',
              paused: true,
              maxConcurrent: 3,
              instructions: '须去重、断点续传。',
              verifyOnDone: false,
            };
      },
    },
    task: {
      findFirst: async ({ where }: any) => {
        queries.push('task');
        return opts.ownedTask === false || where.ownerId !== OWNER
          ? null
          : {
              id: TASK_ID,
              title: '[W 009/250] → WARC',
              status: 'DONE',
              isForeman: false,
              verifiesTaskId: null,
              list: { title: 'FineWeb CC-MAIN-2025-26' },
              assignee: { name: 'wikova' },
            };
      },
      groupBy: async () => [
        { status: 'DONE', _count: { _all: 249 } },
        { status: 'OPEN', _count: { _all: 248 } },
      ],
    },
    taskListEvent: {
      findMany: async ({ where }: any) =>
        where.listId === LIST_ID
          ? [
              {
                kind: 'quota_hold',
                detail: '12 个就绪任务被配额挡住',
                occurrences: 47,
                firstSeenAt: new Date('2026-08-15T03:11:00.000Z'),
                lastSeenAt: new Date('2026-08-15T04:07:00.000Z'),
              },
            ]
          : [],
    },
    // The list's live count: the work sessions carrying its tasks.
    $queryRaw: async () => [{ count: 2 }],
    session: {
      count: async ({ where }: any) => (where?.numTurns?.gt !== undefined ? 0 : 3),
      findMany: async () => [
        { error: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage" },
        { error: 'runner offline' },
      ],
      // Released by a failure: the facts the word is derived from (sessions/session-legacy-words.ts).
      findFirst: async () => ({
        status: 'FAILED', finishedAt: new Date(0), turnState: null, endReason: null, lastTurnOutcome: 'FAILED',
        startedAt: new Date(0), importSourceCwd: null, sessionKind: 'CONVERSATION', numTurns: 0, error: 'runner offline',
      }),
    },
  } as never;
  return { service: new ReferenceExpansionService(prisma), queries };
}

test('a message with no reference is returned untouched and costs no query', async () => {
  // The overwhelmingly common case: one regex scan, no database work.
  const { service, queries } = makeService();

  const out = await service.expand(OWNER, '把并发降到 2');

  assert.equal(out, '把并发降到 2');
  assert.deepEqual(queries, []);
});

test('a list reference appends the shape of the list, not its tasks', async () => {
  // The load-bearing rule. This deployment's descriptions total ~11 MB; inlining a 500-task
  // list's contents would blow the context window on a single message.
  const { service } = makeService();

  const out = (await service.expand(OWNER, `帮我看下 ${listRef()} 卡在哪`))!;

  assert.ok(out.includes(`<referenced-list id="${LIST_PUBLIC_ID}">`), out);
  assert.match(out, /FineWeb CC-MAIN-2025-26/);
  assert.match(out, /DONE 249 \/ OPEN 248/);
  assert.match(out, /Running {5}2/);
  // Attribution rides along, so "is this a prompt problem" is answerable without a second call.
  assert.match(out, /quota 1 \/ infrastructure 1/);
  assert.match(out, /paused · concurrency cap 3/);
  // And it says where the contents are, rather than carrying them.
  assert.match(out, /fetch them yourself with tasklist_get \/ task_list \/ task_get/);
  // The user's own words survive ahead of the block.
  assert.match(out, /^帮我看下 \[FineWeb\]/);
});

test('a task reference leads with whether anything ever ran', async () => {
  // The question that decided every verification verdict that mattered here, and the one a
  // reader is least likely to think to ask of a task marked DONE.
  const { service } = makeService();

  const out = (await service.expand(OWNER, `查一下 ${taskRef()}`))!;

  assert.ok(out.includes(`<referenced-task id="${TASK_PUBLIC_ID}">`), out);
  assert.match(out, /3 in total, 0 of them took a turn/);
  assert.match(out, /last: FAILED \(infrastructure\), 0 turns/);
});

test('the task block is, byte for byte, the English note both clients are proved against', async () => {
  // The web (lib/referencedTask.ts) and OrbitKit (ReferencedTask.swift) read this block back into a
  // card, and their tests read the note `IN_ENGLISH` (web lib/referencedTask.fixtures.ts, which
  // OrbitKit's fixtures are held to byte for byte). A label or sentence reworded here and not there
  // is a block every client draws as plain text — so the two blocks are written here and compared
  // with that note, rather than restated.
  const fixtures = readFileSync(
    path.join(path.resolve(__dirname, '../../../..'), 'src/web/src/lib/referencedTask.fixtures.ts'),
    'utf8',
  );
  const note = /export const IN_ENGLISH = `([\s\S]*?)`;/.exec(fixtures)?.[1];
  assert.ok(note, 'IN_ENGLISH is not in the web fixtures');
  const ran = toUuid('34DH29mTc7OQ6AwxAFIJu');
  const never = toUuid('349vy0HknpSjHwdwJ31O1');
  const tasks: Record<string, unknown> = {
    [ran]: {
      id: ran,
      title: 'Claude QA: verify the Watch core backend and its recovery semantics',
      status: 'DONE',
      isForeman: false,
      verifiesTaskId: 'subject-task',
      list: null,
      assignee: { name: 'orbit' },
    },
    [never]: {
      id: never,
      title: 'P0 | Review and publish the docs and the community baseline',
      status: 'OPEN',
      isForeman: false,
      verifiesTaskId: null,
      list: null,
      assignee: null,
    },
  };
  const prisma = {
    task: { findFirst: async ({ where }: any) => (where.ownerId === OWNER ? tasks[where.id] ?? null : null) },
    session: {
      count: async ({ where }: any) => (where.taskId === ran ? 1 : 0),
      findFirst: async ({ where }: any) =>
        where.taskId === ran
          ? {
            // Released with its task done: the facts the word is derived from.
            status: 'SUCCEEDED', finishedAt: new Date(0), turnState: null, endReason: 'task_done', lastTurnOutcome: 'ANSWERED',
            startedAt: new Date(0), importSourceCwd: null, sessionKind: 'CONVERSATION', numTurns: 144, error: null,
          }
          : null,
    },
  } as never;
  const typed = '[QA](orbit-task:34DH29mTc7OQ6AwxAFIJu) [P0](orbit-task:349vy0HknpSjHwdwJ31O1)';

  const out = (await new ReferenceExpansionService(prisma).expand(OWNER, typed))!;

  assert.equal(out, `${typed}\n\n${note}`);
});

test('both blocks name their row by its public id, never by the uuid the column holds', async () => {
  // The expansion is prose delivered to the agent, and prose is the one boundary
  // PublicIdInterceptor does not cover: it rewrites response *fields*, and a message is not one.
  // The id here is the entry point the block exists to hand over — what the agent passes to
  // task_get / tasklist_get to fetch what this deliberately does not carry — so spelled unlike
  // every other id in the run it is least usable exactly where it matters most.
  //
  // Referenced by uuid on purpose: the lookup still takes uuids, so this pins the encode to the
  // render rather than to the input spelling.
  const { service } = makeService();

  const out = (await service.expand(OWNER, `看下 ${listRef()} 和 ${taskRef()}`))!;

  // Not a no-op codec, or every assertion below would hold for the bug too.
  assert.notEqual(LIST_PUBLIC_ID, LIST_ID);
  assert.notEqual(TASK_PUBLIC_ID, TASK_ID);
  assert.ok(out.includes(`<referenced-list id="${LIST_PUBLIC_ID}">`), out);
  assert.ok(out.includes(`<referenced-task id="${TASK_PUBLIC_ID}">`), out);
  // Scoped to what was appended: the user's own words are kept verbatim ahead of it, uuids and
  // all, and rewriting those is the thing expanding at delivery exists to avoid.
  const expansion = out.slice(out.indexOf('<referenced-'));
  assert.equal(expansion.includes(LIST_ID), false, 'the raw list uuid reached the agent');
  assert.equal(expansion.includes(TASK_ID), false, 'the raw task uuid reached the agent');
});

test('a reference the sender does not own expands to nothing, not an error', async () => {
  // A stray id in prose must not fail delivery of the turn carrying it, and must not reveal that
  // the row exists elsewhere.
  const { service } = makeService({ ownedList: false });

  const out = await service.expand(OWNER, `看下 ${listRef()}`);

  assert.equal(out, `看下 ${listRef()}`);
});

test('the same reference twice expands once', async () => {
  // People name a list twice in one sentence — "pause X, and tell me why X stalled".
  const refs = parseReferences(`暂停 ${listRef()}，再说说 ${listRef()} 为什么停`);

  assert.deepEqual(refs, [{ kind: 'list', id: LIST_ID }]);
});

test('references are capped, so one pasted wall of links cannot flood the prompt', () => {
  const many = Array.from(
    { length: 20 },
    (_, i) => `[x](orbit-task:550e8400-e29b-41d4-a716-4466554400${String(i).padStart(2, '0')})`,
  ).join(' ');

  assert.equal(parseReferences(many).length, 8);
});

test('only the two known schemes are references', () => {
  // `orbit-attachment:` is the transcript's own image scheme and must not be swept up here.
  assert.deepEqual(parseReferences('![x](orbit-attachment:abc-123)'), []);
  assert.deepEqual(parseReferences('[x](https://example.com/orbit-list:nope)'), []);
});

test('a base62 public id resolves to the same reference as the uuid', () => {
  // The spelling clients actually send. Pinning the pattern to the 36-char uuid made every
  // reference the composer produced expand to nothing, and an unexpanded reference looks exactly
  // like a message that never had one — so this is the case that has to stay covered.
  const short = uuidToBase62(LIST_ID);

  assert.notEqual(short, LIST_ID);
  assert.deepEqual(parseReferences(`[x](orbit-list:${short})`), [{ kind: 'list', id: LIST_ID }]);
});

test('the two spellings of one id dedupe against each other', () => {
  const mixed = `[a](orbit-list:${LIST_ID}) 和 [b](orbit-list:${uuidToBase62(LIST_ID)})`;

  assert.deepEqual(parseReferences(mixed), [{ kind: 'list', id: LIST_ID }]);
});

test('an unparseable id costs the expansion, not the delivery', () => {
  // Prose may contain anything; the value must never reach a `::uuid` cast.
  assert.deepEqual(parseReferences('[x](orbit-list:not!an!id)'), []);
  assert.deepEqual(parseReferences('[x](orbit-task:zzzzzzzzzzzzzzzzzzzzzzzzzz)'), []);
});

test('an id is matched case-insensitively and normalised', () => {
  const upper = LIST_ID.toUpperCase();

  assert.deepEqual(parseReferences(`[x](orbit-list:${upper})`), [
    { kind: 'list', id: LIST_ID },
  ]);
});

// ── Sessions and projects, as the owner names them (docs/composer-references-design.md §3.1) ──────

const SESSION_ID = '0198b0a1-7c3e-7d2a-9b11-5f2e8c4d6a01';
const OTHER_SESSION = '0198b0a1-7c3e-7d2a-9b11-5f2e8c4d6a02';
const PROJECT_ID = '0198b0a1-7c3e-7d2a-9b11-5f2e8c4d6a03';
const THIS_RUNNER = '0198b0a1-7c3e-7d2a-9b11-5f2e8c4d6a04';
const HPC_RUNNER = '0198b0a1-7c3e-7d2a-9b11-5f2e8c4d6a05';
const SESSION_PUBLIC_ID = uuidToBase62(SESSION_ID);
const PROJECT_PUBLIC_ID = uuidToBase62(PROJECT_ID);

function makeOwnerService() {
  const queries: string[] = [];
  const sessionRow = (id: string) => ({
    id,
    title: 'Deploy main to staging',
    openedBy: 'PERSON',
    createdAt: new Date('2026-11-28T08:14:00.000Z'),
    lastTurnAt: new Date('2026-11-28T09:02:00.000Z'),
    numTurns: 14,
    phase: 'IDLE',
    finishedAt: null,
    turnState: null,
    endReason: null,
    lastTurnOutcome: 'ANSWERED',
    startedAt: new Date('2026-11-28T08:14:05.000Z'),
    importSourceCwd: null,
    sessionKind: 'CONVERSATION',
    error: null,
    deletedAt: null,
    branch: 'orbit/session-ab12',
    branchMerged: false,
    mergeStatus: null,
    worktreeDirty: false,
    assignedRunnerId: HPC_RUNNER,
    assignedRunner: { name: 'hpc' },
    workspace: { name: 'orbit-prod' },
    task: null,
    coordinatorForProject: null,
  });
  const owned = new Set([SESSION_ID, OTHER_SESSION]);
  const prisma = {
    session: {
      findMany: async ({ where }: any) => {
        queries.push('session.findMany');
        return where.ownerId === OWNER ? where.id.in.filter((id: string) => owned.has(id)).map((id: string) => ({ id })) : [];
      },
      findFirst: async ({ where }: any) => {
        queries.push('session.findFirst');
        return where.ownerId === OWNER && owned.has(where.id) ? sessionRow(where.id) : null;
      },
    },
    project: {
      findMany: async ({ where }: any) => {
        queries.push('project.findMany');
        return where.ownerId === OWNER && where.id.in.includes(PROJECT_ID) ? [{ id: PROJECT_ID }] : [];
      },
      findFirst: async ({ where }: any) =>
        where.ownerId === OWNER && where.id === PROJECT_ID
          ? {
              id: PROJECT_ID,
              title: 'Runner link hardening',
              status: 'RUNNING',
              coordinatorSessionId: OTHER_SESSION,
              coordinatorSession: { phase: 'IDLE' },
            }
          : null,
    },
    task: {
      findMany: async () => {
        queries.push('task.findMany');
        return [];
      },
    },
    approval: { count: async () => 0 },
    projectBlocker: { count: async () => 1 },
    projectOpenItem: { count: async () => 1 },
    projectAcceptanceCriterionDefinition: { count: async () => 5 },
  } as never;
  const service = new ReferenceExpansionService(prisma);
  service.panorama = (async () => ({
    buckets: { running: 1, ready: 0, blocked: 0, awaitingVerification: 0, done: 11, failed: 1, cancelled: 0 },
    shape: { taskCount: 13 },
  })) as never;
  return { service, queries };
}

const OWNER_OPTS = { byOwner: true, sessionId: OTHER_SESSION, runnerId: THIS_RUNNER };

test('a pasted session URL on the owner\'s message appends the facts of that session', async () => {
  // How people point at a session most (206 of 413): the web URL, pasted, with the question after it.
  const { service } = makeOwnerService();
  const typed = `https://orbit.example.com/sessions/${SESSION_PUBLIC_ID} finished but the list still shows Running. Why?`;

  const out = (await service.expand(OWNER, typed, OWNER_OPTS))!;

  assert.ok(out.startsWith(`${typed}\n\n<referenced-session id="${SESSION_PUBLIC_ID}">`), out);
  assert.match(out, /Title {7}Deploy main to staging/);
  // Said outright: a third of referenced sessions are on another machine.
  assert.match(out, /Runs on {5}runner hpc \(not this runner\)/);
  assert.match(out, /List shows {2}IDLE · status /);
  assert.match(out, /Turns {7}14; last ANSWERED at 2026-11-28T09:02:00.000Z/);
  assert.match(out, /Code {8}branch orbit\/session-ab12 · merged no · nothing uncommitted/);
  assert.match(out, /Pending {5}0 approvals/);
  assert.equal(out.includes(SESSION_ID), false, 'the raw uuid reached the agent');
});

test('a bare session id resolves only when the owner has that session', async () => {
  // The other half (209 of 413). A token is a candidate, never a reference by its shape alone.
  const { service } = makeOwnerService();
  const stranger = uuidToBase62('0198b0a1-7c3e-7d2a-9b11-5f2e8c4d6aff');

  const out = (await service.expand(OWNER, `${SESSION_PUBLIC_ID} vs ${stranger}`, OWNER_OPTS))!;

  assert.equal(out.match(/<referenced-session /g)?.length, 1, out);
  assert.ok(out.includes(`<referenced-session id="${SESSION_PUBLIC_ID}">`));
});

test('the composer\'s @ chip and # project chip expand on the owner\'s message', async () => {
  const { service } = makeOwnerService();
  const typed = `[@Deploy main to staging](orbit-session:${SESSION_PUBLIC_ID}) and [#Runner link hardening](orbit-project:${PROJECT_PUBLIC_ID})`;

  const out = (await service.expand(OWNER, typed, OWNER_OPTS))!;

  assert.ok(out.includes(`<referenced-session id="${SESSION_PUBLIC_ID}">`), out);
  assert.ok(out.includes(`<referenced-project id="${PROJECT_PUBLIC_ID}">`), out);
  assert.match(out, /Tasks {8}13 in total: running 1 \/ done 11 \/ failed 1/);
  assert.match(out, /Criteria {5}5 stated; project_get says which are met/);
  assert.match(out, /Blockers {5}1 open · 1 item waiting on the owner/);
  assert.match(out, new RegExp(`Coordinator {2}session ${uuidToBase62(OTHER_SESSION)} · IDLE`));
  // In the order written: the session first.
  assert.ok(out.indexOf('<referenced-session') < out.indexOf('<referenced-project'));
});

test('an agent\'s or Orbit\'s message is delivered as before: no session, project, URL or bare id', async () => {
  // Design §8 decision B: agent-to-agent traffic and platform notices keep their prompts.
  const { service, queries } = makeOwnerService();
  const typed = `see [s](orbit-session:${SESSION_PUBLIC_ID}), https://orbit.example.com/sessions/${SESSION_PUBLIC_ID}, ${SESSION_PUBLIC_ID}`;

  const out = await service.expand(OWNER, typed, { sessionId: OTHER_SESSION });

  assert.equal(out, typed);
  assert.deepEqual(queries, []);
});

test('a message naming the session it is sent to does not describe that session to itself', async () => {
  const { service } = makeOwnerService();

  const out = await service.expand(OWNER, `continue ${uuidToBase62(OTHER_SESSION)}`, OWNER_OPTS);

  assert.equal(out, `continue ${uuidToBase62(OTHER_SESSION)}`);
});

test('words, hashes and paths are not bare-id candidates', () => {
  // Only a token that mixes digits, upper and lower case and stands alone can be a public id.
  assert.deepEqual(parseBareIds('internationalization abcdefghijklmnopqrstuv'), []);
  assert.deepEqual(parseBareIds('commit 9078659f13f7cd5cd6ae77d316ea43a2f3f270e2'), []);
  assert.deepEqual(parseBareIds(`/sessions/${SESSION_PUBLIC_ID} orbit-session:${SESSION_PUBLIC_ID}`), []);
  assert.deepEqual(parseBareIds(`look at ${SESSION_PUBLIC_ID}.`), [SESSION_ID]);
  assert.deepEqual(parseBareIds(`uuid ${SESSION_ID.toUpperCase()}`), [SESSION_ID]);
});

test('URLs are recognised on the owner\'s message only, with any query string after the id', () => {
  const url = `https://orbit.example.com/sessions/${SESSION_PUBLIC_ID}?project=${PROJECT_PUBLIC_ID}`;

  assert.deepEqual(parseReferences(url), []);
  assert.deepEqual(parseReferences(url, { recognise: true }), [{ kind: 'session', id: SESSION_ID }]);
  assert.deepEqual(parseReferences(`https://x.test/projects/${PROJECT_PUBLIC_ID}`, { recognise: true }), [
    { kind: 'project', id: PROJECT_ID },
  ]);
});
