import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidToBase62 } from '@orbit/shared';
import { parseReferences, ReferenceExpansionService } from './reference-expansion';

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
    session: {
      count: async ({ where }: any) => (where?.numTurns?.gt !== undefined ? 0 : 3),
      findMany: async () => [
        { error: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage" },
        { error: 'runner offline' },
      ],
      findFirst: async () => ({ status: 'FAILED', numTurns: 0, error: 'runner offline' }),
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
  // Attribution rides along, so "is this a prompt problem" is answerable without a second call.
  assert.match(out, /quota 1 \/ infrastructure 1/);
  assert.match(out, /已暂停 · 并发上限 3/);
  // And it says where the contents are, rather than carrying them.
  assert.match(out, /tasklist_get \/ task_list \/ task_get 自取/);
  // The user's own words survive ahead of the block.
  assert.match(out, /^帮我看下 \[FineWeb\]/);
});

test('a task reference leads with whether anything ever ran', async () => {
  // The question that decided every verification verdict that mattered here, and the one a
  // reader is least likely to think to ask of a task marked DONE.
  const { service } = makeService();

  const out = (await service.expand(OWNER, `查一下 ${taskRef()}`))!;

  assert.ok(out.includes(`<referenced-task id="${TASK_PUBLIC_ID}">`), out);
  assert.match(out, /共 3 次，其中执行过 turn 的 0 次/);
  assert.match(out, /最近一次：FAILED \(infrastructure\), 0 turns/);
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
