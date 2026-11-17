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
  const sections = ['Acceptance criteria', 'Owner rulings in force (project_ruling', 'Open items', 'Tasks (title · status · criterion'];
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
  const digest = renderStateDigest({ asOf: AS_OF, criteria: [], rulings: [], openItems: [], tasks: [], taskTotal: 0, tasksByStatus: {} });
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
    projectOpenItem: { findMany: record('projectOpenItem', [{ id: 'item-1', kind: 'ASK_OWNER', assignee: 'OWNER', title: 'Which branch?', taskId: null }]) },
    task: { findMany: record('task', [{ id: 'task-1', title: 'Render the digest', status: 'IN_PROGRESS', criterionDefinitionId: 'crit-a' }]) },
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

test('a successor\'s opening reports from the digest: no required project_get/task_list, and a later read wins', () => {
  const digest = renderStateDigest(fortyTaskProject());
  for (const note of ['Where things stand: two tasks are waiting on the owner.', null]) {
    const opening = buildCoordinatorOpening('Coordinator handoff v2', PROJECT_ID, true, true, { note, digest });

    assert.ok(!opening.includes('Read first'), 'the read-first requirement is gone');
    assert.ok(!/use project_get .* then task_list/.test(opening));
    assert.match(opening, /you do not need project_get or task_list before your first report/);
    assert.match(opening, /The digest is dated and the handoff note is the previous conversation’s own words: where a later read disagrees with either, the later read wins\./);
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
