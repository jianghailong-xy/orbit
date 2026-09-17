import { describe, expect, it } from 'vitest';
import { parseReferencedTasks, summarizeReferencedTasks } from './referencedTask';
import {
  EIGHT_TASKS,
  NEVER_RAN,
  ONE_TASK,
  TWO_TASKS,
  WITH_BACKGROUND_JOBS,
} from './referencedTask.fixtures';

/**
 * Reading the blocks delivery appends for a person's `#`-references.
 *
 * Held to the wording the apiserver writes (tasks/reference-expansion.ts `describeTask`) and proved
 * against this deployment's own notes, copied out of `run_event` (referencedTask.fixtures.ts) —
 * including the note that carries eight of them and the one that shares a note with the inventory a
 * returning engine was handed.
 */
describe('parseReferencedTasks', () => {
  it('reads every field of one block, id included', () => {
    const parsed = parseReferencedTasks(ONE_TASK);

    expect(parsed?.tasks).toEqual([
      {
        id: '34OEE9MQXMEm0h0Ptm1GG',
        title: 'runner 从项目集成线的 tip 创建 worktree',
        status: 'FAILED',
        suffixes: [],
        list: '(无列表)',
        assignee: 'orbit',
        runs: 1,
        executed: 1,
        // The classified cause rides along with the status, in the block's own words.
        lastRun: 'FAILED (unattributed), 31 turns',
      },
    ]);
    expect(parsed?.rest).toBe('');
  });

  it('keeps a task nobody has run and nobody owns as the block put it', () => {
    const [task] = parseReferencedTasks(NEVER_RAN)?.tasks ?? [];

    expect(task.status).toBe('OPEN');
    expect(task.runs).toBe(0);
    expect(task.executed).toBe(0);
    expect(task.list).toBe('(无列表)');
    expect(task.assignee).toBe('(未指派)');
    expect(task.lastRun).toBe('从未运行');
  });

  it('tells a status from what the line says after it, and translates neither', () => {
    const [verification] = parseReferencedTasks(TWO_TASKS)?.tasks ?? [];

    expect(verification.status).toBe('DONE');
    expect(verification.suffixes).toEqual(['验收任务']);
  });

  it('reads a run that took no turn apart from one that did', () => {
    const [, running] = parseReferencedTasks(TWO_TASKS)?.tasks ?? [];

    // The evidence question: a session exists, and it has never taken a turn.
    expect(running.runs).toBe(1);
    expect(running.executed).toBe(0);
    expect(running.lastRun).toBe('RUNNING, 0 turns');
  });

  it('reads all eight of the most anyone has referenced at once', () => {
    const parsed = parseReferencedTasks(EIGHT_TASKS);

    expect(parsed?.tasks.map((task) => task.id)).toEqual([
      '34ONkD7V6aKjyLdHXyimz',
      '34OAsTIS8JuGm5H2j95qO',
      '34NcCcju6ItuCcHBoeaqd',
      '34NaYaztogra0gaMFo4mY',
      '34NaebW9aR15Mr8WrYyV5',
      '34Nb44UnFuiGKvXwWfxFY',
      '34NJZsv3am8LrTpZ4jc09',
      '34DH29mTc7OQ6AwxAFIJu',
    ]);
    // Nothing of the note is left over: eight blocks and the blank lines between them.
    expect(parsed?.rest).toBe('');
    expect(parsed?.tasks[6].status).toBe('OPEN');
    expect(parsed?.tasks[7].suffixes).toEqual(['验收任务']);
  });

  it('hands another block in the same note back untouched', () => {
    const parsed = parseReferencedTasks(WITH_BACKGROUND_JOBS);

    expect(parsed?.tasks.map((task) => task.title)).toEqual([
      'Claude QA 复验：Watch 核心后端（D1/D2/D2b 修复后）',
    ]);
    expect(parsed?.rest.startsWith('<background-jobs>')).toBe(true);
    expect(parsed?.rest.endsWith('</background-jobs>')).toBe(true);
  });

  it('leaves a block that is not this shape to the text it always was', () => {
    const missingField = ONE_TASK.replace(/^ {2}运行 .*$/m, '  运行了 1 次');
    const notAnId = ONE_TASK.replace('34OEE9MQXMEm0h0Ptm1GG', 'task 34OEE9MQXMEm0h0Ptm1GG');

    // Null, not a card with a blank row: the note keeps the shape it has always had.
    expect(parseReferencedTasks(missingField)).toBeNull();
    expect(parseReferencedTasks(notAnId)).toBeNull();
    expect(parseReferencedTasks(null)).toBeNull();
    // A list reference is a shape this deployment has never sent one of, and nobody guesses at it.
    expect(parseReferencedTasks('<referenced-list id="34OEE9MQXMEm0h0Ptm1GG">\n  标题   x\n</referenced-list>')).toBeNull();
  });

  it('draws the blocks it can read and leaves beside them the one it cannot', () => {
    const note = `${ONE_TASK.replace(/^ {2}标题 .*$/m, '  名称   x')}\n\n${NEVER_RAN}`;

    const parsed = parseReferencedTasks(note);

    expect(parsed?.tasks.map((task) => task.id)).toEqual(['349vy0HknpSjHwdwJ31O1']);
    expect(parsed?.rest).toBe(ONE_TASK.replace(/^ {2}标题 .*$/m, '  名称   x'));
  });
});

describe('summarizeReferencedTasks', () => {
  const summarize = (note: string) =>
    summarizeReferencedTasks(parseReferencedTasks(note)?.tasks ?? []);

  it('says the state of a lone task outright', () => {
    expect(summarize(ONE_TASK)).toBe('FAILED');
    expect(summarize(NEVER_RAN)).toBe('OPEN');
  });

  it('counts several by status, in the order the note named them', () => {
    expect(summarize(EIGHT_TASKS)).toBe('7 DONE, 1 OPEN');
    expect(summarize(TWO_TASKS)).toBe('1 DONE, 1 OPEN');
  });
});
