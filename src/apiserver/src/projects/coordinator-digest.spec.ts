import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PrismaService } from '../prisma/prisma.service';
import { readStateDigest, renderStateDigest, STATE_DIGEST_MAX_CHARS, type StateDigestInput } from './coordinator-digest';
import {
  buildCoordinatorInstructions,
  buildCoordinatorOpening,
  coordinatorOpeningIsCurrent,
} from './coordinator-opening';

const PROJECT_ID = '0192f0d0-0000-7000-8000-000000000001';
const AS_OF = new Date('2026-11-17T09:30:00.000Z');
const STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'FAILED', 'CANCELLED'] as const;

/** A 40-task project at the long end of real ones: long titles and criteria, rulings and open items. */
function fortyTaskProject(taskCount = 40): StateDigestInput {
  const criteria = Array.from({ length: 8 }, (_, i) => ({
    key: `crit${i + 1}KeyAbcdefghijklm`,
    text: `Criterion ${i + 1}: ${'the successor reports from the digest without reading anything first, and '.repeat(4)}`,
    satisfied: i < 3 ? true : i < 7 ? false : null,
  }));
  const tasks = Array.from({ length: taskCount }, (_, i) => ({
    id: `task${String(i + 1).padStart(3, '0')}Abcdefghijklmnopq`,
    title: `Task ${i + 1}: ${'render the coordinator handoff digest into the opening '.repeat(3)}`,
    status: STATUSES[i % STATUSES.length],
    criterionKey: i % 9 === 8 ? null : criteria[i % criteria.length].key,
  }));
  const tasksByStatus: Record<string, number> = {};
  for (const t of tasks) tasksByStatus[t.status] = (tasksByStatus[t.status] ?? 0) + 1;
  return {
    asOf: AS_OF,
    criteria,
    rulings: Array.from({ length: 6 }, (_, i) => ({
      id: `ruling${i + 1}Abcdefghijklmnop`,
      ruling: `Ruling ${i + 1}: ${'the owner decided the digest stays under four thousand tokens; '.repeat(3)}`,
      createdAt: `2026-11-1${i}T08:00:00.000Z`,
    })),
    answers: Array.from({ length: 4 }, (_, i) => ({
      id: `answer${i + 1}Abcdefghijklmnop`,
      question: `Question ${i + 1}: ${'should the successor be told this one turn at a time? '.repeat(4)}`,
      answer: `Answer ${i + 1}: ${'no, it reads it once in its opening '.repeat(3)}`,
      answeredAt: `2026-11-1${6 - i}T08:00:00.000Z`,
    })),
    openItems: Array.from({ length: 5 }, (_, i) => ({
      id: `item${i + 1}Abcdefghijklmnopqr`,
      kind: i % 2 ? 'ASK_OWNER' : 'TASK_FAILED',
      assignee: i % 2 ? 'OWNER' : 'COORDINATOR',
      title: `Open item ${i + 1}: ${'a task failed and waits for the coordinator to decide '.repeat(3)}`,
      taskId: i % 2 ? null : tasks[i].id,
    })),
    tasks,
    taskTotal: tasks.length,
    tasksByStatus,
  };
}

test('the digest of a 40-task project is dated, has every section, every task and every live ruling, within 16,000 characters', () => {
  const input = fortyTaskProject();
  const digest = renderStateDigest(input);

  assert.ok(digest.length <= STATE_DIGEST_MAX_CHARS, `digest is ${digest.length} characters`);
  assert.ok(digest.startsWith(`<state_digest as_of="${AS_OF.toISOString()}">`), 'dated in its opening tag');
  assert.match(digest, /2026-11-17 09:30 UTC/);
  assert.ok(digest.endsWith('</state_digest>'));
  assert.match(digest, /40 task\(s\) \(OPEN 8, IN_PROGRESS 8, DONE 8, FAILED 8, CANCELLED 8\); 8 acceptance criteria, 3 met\./);

  // Sections, in order.
  const sections = ['Acceptance criteria', 'Owner rulings in force (project_ruling', 'Owner answers in force', 'Open items', 'Tasks (title · status · criterion'];
  const at = sections.map((s) => digest.indexOf(`\n${s}`));
  assert.ok(at.every((i) => i > 0), 'every section is there');
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in order');

  // One line per criterion, met or not.
  for (const [i, c] of input.criteria.entries()) {
    const state = c.satisfied === true ? 'met' : c.satisfied === false ? 'not met' : 'not answered';
    assert.match(digest, new RegExp(`\\nC${i + 1} · ${state} · Criterion ${i + 1}: .*· ${c.key}\\n`));
  }
  // Every live ruling, with its date and id.
  for (const r of input.rulings) assert.match(digest, new RegExp(`\\n- ${r.createdAt.slice(0, 10)} · Ruling .* · ${r.id}\\n`));
  // Every answer in force, with its date and id, the question and the answer clipped to one line.
  for (const a of input.answers) assert.match(digest, new RegExp(`\\n- ${a.answeredAt.slice(0, 10)} · Question .*… → Answer .* · ${a.id}\\n`));
  // Every open item.
  for (const o of input.openItems) assert.ok(digest.includes(` · ${o.id}\n`), o.id);
  // One line per task — title, status, criterion — none truncated away; unfinished ones first.
  for (const t of input.tasks) {
    const criterion = t.criterionKey ? `C${input.criteria.findIndex((c) => c.key === t.criterionKey) + 1}` : 'no criterion';
    assert.match(digest, new RegExp(`\\n- Task \\d+: .* · ${t.status} · ${criterion} · ${t.id}(\\n|$)`), t.id);
  }
  assert.ok(!digest.includes('more tasks not shown'));
  assert.ok(digest.indexOf(' · FAILED · ') < digest.indexOf(' · DONE · '), 'unfinished tasks before settled ones');
});

test('beyond the ceiling the digest truncates with a count, and counts tasks it never read', () => {
  const input = { ...fortyTaskProject(400), taskTotal: 1_000 };
  const digest = renderStateDigest(input);
  assert.ok(digest.length <= STATE_DIGEST_MAX_CHARS, `digest is ${digest.length} characters`);
  const shown = (digest.match(/\n- Task \d+:/g) ?? []).length;
  assert.ok(shown > 40 && shown < 400, `${shown} task lines`);
  assert.ok(digest.includes(`\n… ${1_000 - shown} more tasks not shown; task_list has every one.\n</state_digest>`));
  for (const r of input.rulings) assert.ok(digest.includes(r.id), 'rulings are not crowded out by tasks');
});

test('an empty project renders every section empty', () => {
  const digest = renderStateDigest({ asOf: AS_OF, criteria: [], rulings: [], answers: [], openItems: [], tasks: [], taskTotal: 0, tasksByStatus: {} });
  for (const empty of ['(none stated)', '(none recorded)', '(none)', '(none yet)']) assert.ok(digest.includes(`\n${empty}\n`), empty);
});

test('the reader renders live rulings, open items and tasks from the project\'s rows', async () => {
  const calls: Record<string, unknown> = {};
  const record = (name: string, rows: unknown[]) => async (args: unknown) => { calls[name] = args; return rows; };
  const prisma = {
    projectAcceptanceCriterionDefinition: {
      findMany: async (args: { select: Record<string, unknown> }) => (args.select.text
        ? [{ id: 'crit-a', text: 'The digest is in the opening' }]
        : [{ id: 'crit-a', ordinal: 0, revision: 1, satisfiedBy: 'TASKS', servingTasks: [] }]),
    },
    projectRuling: { findMany: record('projectRuling', [{ id: 'rul-1', projectId: PROJECT_ID, ruling: 'Keep it under 4k tokens', quote: 'under 4k', sourceKind: 'TURN', sourceId: 'turn-1', recordedBySessionId: null, supersededById: null, createdAt: AS_OF }]) },
    projectOpenItem: {
      findMany: async (args: { where: { state: string } }) => (args.where.state === 'OPEN'
        ? record('projectOpenItem', [{ id: 'item-1', kind: 'ASK_OWNER', assignee: 'OWNER', title: 'Which branch?', taskId: null }])(args)
        : record('answered', [])(args)),
    },
    task: {
      findMany: async (args: { select: Record<string, unknown> }) => (args.select.title
        ? record('task', [{ id: 'task-1', title: 'Render the digest', status: 'IN_PROGRESS', criterionDefinitionId: 'crit-a' }])(args)
        : record('unsettled', [])(args)),
    },
    projectTaskStatusCount: { findMany: record('projectTaskStatusCount', [{ status: 'IN_PROGRESS', count: 1 }]) },
  } as unknown as PrismaService;

  const digest = await readStateDigest(prisma, 'owner-1', PROJECT_ID, AS_OF);

  assert.deepEqual((calls.projectRuling as { where: unknown }).where, { ownerId: 'owner-1', projectId: PROJECT_ID, supersededById: null }, 'live rulings only');
  assert.deepEqual((calls.projectOpenItem as { where: unknown }).where, { projectId: PROJECT_ID, ownerId: 'owner-1', state: 'OPEN' });
  assert.match(digest, /\n- 2026-11-17 · Keep it under 4k tokens · rul-1\n/);
  assert.match(digest, /\n- ASK_OWNER · OWNER · Which branch\? · item-1\n/);
  assert.match(digest, /\nC1 · .* · The digest is in the opening · crit-a\n/);
  assert.match(digest, /\n- Render the digest · IN_PROGRESS · C1 · task-1\n/);
});

test('the reader keeps the answers still in force: recent ones, and old ones blocking unfinished work', async () => {
  const day = 24 * 60 * 60 * 1000;
  const question = (text: string, blocksTaskIds: string[] = []) => ({
    question: text,
    options: [{ label: 'Cancel it' }, { label: 'Keep it' }],
    recommendedOption: 0,
    blocksTaskIds,
    ifUnanswered: null,
  });
  // Newest first, as the read orders them.
  const answered = [
    { id: 'ans-translated', payload: question('Recent, typed in another language?'), answer: { text: '保留', translation: { text: 'keep it' }, answeredByUserId: 'u' }, resolvedAt: new Date(AS_OF.getTime() - day) },
    { id: 'ans-recent', payload: question('Recent, blocking nothing?'), answer: { text: 'yes', answeredByUserId: 'u' }, resolvedAt: new Date(AS_OF.getTime() - 2 * day) },
    { id: 'ans-blocking', payload: question('Old, blocking open work?', ['task-open']), answer: { option: 0, answeredByUserId: 'u' }, resolvedAt: new Date(AS_OF.getTime() - 30 * day) },
    { id: 'ans-settled', payload: question('Old, blocking finished work?', ['task-done']), answer: { option: 1, answeredByUserId: 'u' }, resolvedAt: new Date(AS_OF.getTime() - 30 * day) },
    { id: 'ans-stale', payload: question('Old, blocking nothing?'), answer: { option: 1, answeredByUserId: 'u' }, resolvedAt: new Date(AS_OF.getTime() - 30 * day) },
  ];
  let unsettledAsked: unknown;
  const prisma = {
    projectAcceptanceCriterionDefinition: { findMany: async () => [] },
    projectRuling: { findMany: async () => [] },
    projectOpenItem: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        if (args.where.state === 'OPEN') return [];
        assert.deepEqual(args.where, { projectId: PROJECT_ID, ownerId: 'owner-1', kind: 'COORDINATOR_QUESTION', state: 'RESOLVED', resolution: 'ANSWERED' });
        return answered;
      },
    },
    task: {
      findMany: async (args: { where: { id?: { in: string[] } }; select: Record<string, unknown> }) => {
        if (args.select.title) return [];
        unsettledAsked = args.where.id?.in;
        return [{ id: 'task-open' }];
      },
    },
    projectTaskStatusCount: { findMany: async () => [] },
  } as unknown as PrismaService;

  const digest = await readStateDigest(prisma, 'owner-1', PROJECT_ID, AS_OF);

  assert.deepEqual(unsettledAsked, ['task-open', 'task-done'], 'one read for every blocked task');
  assert.match(digest, /\n- 2026-11-15 · Recent, blocking nothing\? → yes · ans-recent\n/);
  assert.match(digest, /\n- 2026-10-18 · Old, blocking open work\? → Cancel it · ans-blocking\n/);
  assert.match(digest, /\n- 2026-11-16 · Recent, typed in another language\? → keep it · ans-translated\n/,
    'the owner\'s words in the agent language, as the answer\'s own turn tells them');
  assert.ok(!digest.includes('ans-settled'), 'an old answer whose work is finished is not in force');
  assert.ok(!digest.includes('ans-stale'), 'nor an old one that blocks nothing');
  assert.ok(digest.indexOf('ans-translated') < digest.indexOf('ans-recent'), 'in the order read: newest first');
});

test('an answer a ruling records is listed once, with the rulings, and one whose ruling was replaced not at all', async () => {
  const day = 24 * 60 * 60 * 1000;
  const question = (text: string) => ({
    question: text, options: [{ label: 'Blue' }, { label: 'Green' }], recommendedOption: 0, blocksTaskIds: [], ifUnanswered: null,
  });
  const answeredAt = new Date(AS_OF.getTime() - day);
  // Newest first, as the read orders them.
  const answered = [
    { id: 'ans-typed', payload: question('Typed answer?'), answer: { text: 'neither, use grey', answeredByUserId: 'u' }, resolvedAt: answeredAt },
    { id: 'ans-picked', payload: question('Picked answer?'), answer: { option: 0, answeredByUserId: 'u' }, resolvedAt: answeredAt },
    { id: 'ans-replaced', payload: question('Replaced answer?'), answer: { option: 1, answeredByUserId: 'u' }, resolvedAt: answeredAt },
    { id: 'ans-before-rulings', payload: question('Answered before rulings existed?'), answer: { option: 1, answeredByUserId: 'u' }, resolvedAt: answeredAt },
  ];
  const live = [
    { id: 'rul-picked', projectId: PROJECT_ID, ruling: 'Picked answer? — Blue', quote: 'Blue', sourceKind: 'ASK_OWNER', sourceId: 'ans-picked', recordedBySessionId: null, supersededById: null, createdAt: answeredAt },
    { id: 'rul-typed', projectId: PROJECT_ID, ruling: 'Typed answer?', quote: 'neither, use grey', sourceKind: 'ASK_OWNER', sourceId: 'ans-typed', recordedBySessionId: null, supersededById: null, createdAt: answeredAt },
    { id: 'rul-turn', projectId: PROJECT_ID, ruling: 'Ship on Friday', quote: 'ship it friday', sourceKind: 'TURN', sourceId: 'turn-1', recordedBySessionId: 's', supersededById: null, createdAt: answeredAt },
  ];
  let ruledAsked: unknown;
  const prisma = {
    projectAcceptanceCriterionDefinition: { findMany: async () => [] },
    projectRuling: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        if (!('sourceKind' in args.where)) return live;
        ruledAsked = args.where;
        // Every ruling of these questions, superseded ones included: the replaced answer's was.
        return [{ sourceId: 'ans-picked' }, { sourceId: 'ans-typed' }, { sourceId: 'ans-replaced' }];
      },
    },
    projectOpenItem: {
      findMany: async (args: { where: Record<string, unknown> }) => (args.where.state === 'OPEN' ? [] : answered),
    },
    task: { findMany: async () => [] },
    projectTaskStatusCount: { findMany: async () => [] },
  } as unknown as PrismaService;

  const digest = await readStateDigest(prisma, 'owner-1', PROJECT_ID, AS_OF);

  assert.deepEqual(ruledAsked, {
    ownerId: 'owner-1', projectId: PROJECT_ID, sourceKind: 'ASK_OWNER',
    sourceId: { in: ['ans-typed', 'ans-picked', 'ans-replaced', 'ans-before-rulings'] },
  }, 'one read for the rulings of every answered question, superseded or not');
  const section = (head: string) => digest.slice(digest.indexOf(`\n${head}`), digest.indexOf('\n\n', digest.indexOf(`\n${head}`) + 1));
  const answers = section('Owner answers in force');
  assert.ok(answers.includes('Answered before rulings existed? → Green · ans-before-rulings'), 'an answer no ruling records stays');
  for (const ruled of ['ans-picked', 'ans-typed', 'ans-replaced']) assert.ok(!answers.includes(ruled), `${ruled} is not listed as an answer`);
  const rulings = section('Owner rulings in force');
  assert.match(rulings, /\n- \d{4}-\d{2}-\d{2} · Picked answer\? — Blue · rul-picked(\n|$)/, 'a picked option is in the ruling\'s words already');
  assert.match(rulings, /\n- \d{4}-\d{2}-\d{2} · Typed answer\? → neither, use grey · rul-typed(\n|$)/,
    'a typed answer is only in the ruling\'s quote, so the line carries it');
  assert.match(rulings, /\n- \d{4}-\d{2}-\d{2} · Ship on Friday · rul-turn(\n|$)/, 'a ruling from a turn reads as before');
});

test('a successor\'s opening reports from the digest: no required project_get/task_list, and a later read wins', () => {
  const digest = renderStateDigest(fortyTaskProject());
  for (const note of ['Where things stand: two tasks are waiting on the owner.', null]) {
    const opening = buildCoordinatorOpening('Coordinator handoff v2', PROJECT_ID, true, true, { note, digest });

    assert.ok(!opening.includes('Read first'), 'the read-first requirement is gone');
    assert.ok(!/use project_get .* then task_list/.test(opening));
    assert.match(opening, /you do not need project_get or task_list before your first report/);
    assert.match(opening, /The digest is dated and a handoff note, when there is one, is the previous conversation’s own words: where a later read disagrees with either, the later read wins\./);
    assert.ok(opening.includes(`\n\n${digest}`), 'the digest is in the opening');
    assert.ok(opening.indexOf('this is its coordinator session') < opening.indexOf('<state_digest'), 'after the standing instructions');
    assert.equal(opening.includes('<handoff_note>'), note !== null);
    if (note) {
      assert.ok(opening.indexOf('</state_digest>') < opening.indexOf('<handoff_note>'), 'the note after the digest');
      assert.match(opening, /where a later read \(project_get, task_list\) disagrees with the note or with the digest above, the later read wins/);
    }
    // It still stands in for the delivery block on its first turn.
    assert.equal(coordinatorOpeningIsCurrent(opening, PROJECT_ID, true, true), true);
    assert.equal(coordinatorOpeningIsCurrent(opening, PROJECT_ID, false, true), false);
  }
});

test('a first coordinator\'s opening (no handoff) is unchanged: it still reads project_get and task_list first', () => {
  for (const enabled of [true, false]) {
    const opening = buildCoordinatorOpening('Coordinator handoff v2', PROJECT_ID, enabled);
    assert.equal(opening, buildCoordinatorInstructions('Coordinator handoff v2', PROJECT_ID, enabled));
    assert.match(opening, /Read first: use project_get to read this project’s goal, acceptance criteria and instructions, then task_list /);
    assert.ok(!opening.includes('<state_digest'));
    assert.equal(coordinatorOpeningIsCurrent(opening, PROJECT_ID, enabled), true);
  }
});
