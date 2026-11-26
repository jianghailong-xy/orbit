import { describe, expect, it } from 'vitest';
import type { ProjectCrossingRow } from './attribution';
import {
  FILE_APPROVE_CONSEQUENCE,
  MOVE_TASKS_APPROVE_CONSEQUENCE,
  MOVE_OUT_APPROVE_CONSEQUENCE,
  MOVE_OUT_MANY_APPROVE_CONSEQUENCE,
  anotherEndLine,
  answeredBadge,
  answeredTitle,
  approveConsequence,
  batchReasons,
  batchVerdict,
  criteriaRange,
  crossingBadge,
  crossingBatches,
  crossingListHead,
  crossingSummary,
  crossingTitle,
  decisionLabels,
  isLive,
  moveBatches,
  notRecordedNote,
  reasonsHead,
  requestedCriterionLine,
  waitingLine,
  withdrawnCriterionLine,
} from './crossingBatches';
import { MOVE_TASK_APPROVE_CONSEQUENCE, MOVE_TASK_OUT_APPROVE_CONSEQUENCE } from '../components/ProjectCrossingsCard';

const TARGET = '0195c0de-0000-7000-8000-000000000010';
const SOURCE = '0195c0de-0000-7000-8000-000000000020';
const OTHER_SOURCE = '0195c0de-0000-7000-8000-000000000030';

let n = 0;
function row(over: Partial<ProjectCrossingRow> = {}): ProjectCrossingRow {
  n += 1;
  return {
    id: `row-${n}`,
    publicId: `Pub${n}`,
    fromProjectId: SOURCE,
    fromProjectPublicId: 'SrcPub',
    toProjectId: TARGET,
    toProjectPublicId: 'TgtPub',
    fromProject: { title: 'Runner link v1', status: 'DONE' },
    toProject: { title: 'Runner hardening', status: 'OPEN' },
    kind: 'MOVE_TASK',
    subjectTaskId: `task-${n}`,
    subjectTask: { id: `task-${n}`, title: `Task ${n}` },
    // Real keys are base62 ids; the card must name the criterion by its number instead.
    requestedCriterion: { key: `2wndAAHBC95f4Al8rN${n}`, text: `criterion ${3 + n}`, ordinal: 3 + n },
    withdrawnCriterion: null,
    crossingKey: `key-${n}`,
    state: 'PENDING',
    title: `Task ${n} (as asked)`,
    reason: 'These tasks serve criteria here; their old project is done.',
    requestedAt: `2026-11-09T08:31:0${n % 10}.000Z`,
    decidedAt: null,
    expiresAt: null,
    ...over,
  };
}

describe('crossingBatches — one card per batch', () => {
  it('groups the crossings into this project by source and kind', () => {
    n = 0;
    const rows = [
      row(), row(), row(),
      row({ kind: 'FILE_TASK' }),
      row({ fromProjectId: OTHER_SOURCE, fromProject: { title: 'Other', status: 'OPEN' } }),
      // Out of this project: never drawn here.
      row({ toProjectId: OTHER_SOURCE, toProjectPublicId: 'x' }),
    ];
    const batches = crossingBatches(rows, TARGET);
    expect(batches.map((b) => [b.kind, b.sourceTitle, b.rows.length])).toEqual([
      ['MOVE_TASK', 'Runner link v1', 3],
      ['FILE_TASK', 'Runner link v1', 1],
      ['MOVE_TASK', 'Other', 1],
    ]);
    expect(batches[0].id).toBe('crossing-batch-Pub1');
    expect(batches[0].moment).toBe(rows[0].requestedAt);
  });

  it('matches the project by its public id as well', () => {
    n = 0;
    expect(crossingBatches([row()], 'TgtPub')).toHaveLength(1);
  });

  it('never draws a move out to no project as a crossing into any project', () => {
    n = 0;
    const out = row({ toProjectId: null, toProjectPublicId: null, toProject: null, requestedCriterion: null });
    const absent = row({ toProjectId: null, toProjectPublicId: undefined, toProject: null, requestedCriterion: null });
    for (const id of [TARGET, 'TgtPub']) {
      expect(crossingBatches([out, absent], id)).toEqual([]);
    }
    // It is drawn only in its SOURCE's conversation, as a request to take tasks out (below).
    for (const id of [SOURCE, 'SrcPub']) {
      expect(crossingBatches([out, absent], id).map((b) => [b.out, b.rows])).toEqual([[true, [out, absent]]]);
    }
    // Beside an ordinary move from the same source, it neither joins nor splits that batch.
    const into = row();
    const batches = crossingBatches([out, into, absent], TARGET);
    expect(batches.map((b) => b.rows)).toEqual([[into]]);
  });

  it('starts a new batch for a request made after the earlier batch was fully answered', () => {
    n = 0;
    const first = row({ state: 'APPLIED', requestedAt: '2026-11-01T00:00:00.000Z', decidedAt: '2026-11-01T01:00:00.000Z' });
    const during = row({ state: 'APPLIED', requestedAt: '2026-11-01T00:30:00.000Z', decidedAt: '2026-11-01T01:00:00.000Z' });
    const later = row({ requestedAt: '2026-11-02T00:00:00.000Z' });
    const batches = crossingBatches([later, first, during], TARGET);
    expect(batches.map((b) => b.rows.map((r) => r.id))).toEqual([[first.id, during.id], [later.id]]);
    expect(isLive(batches[0])).toBe(false);
    expect(isLive(batches[1])).toBe(true);
  });

  it('keeps a request in the batch while an earlier one is still waiting', () => {
    n = 0;
    const a = row({ requestedAt: '2026-11-01T00:00:00.000Z' });
    const b = row({ requestedAt: '2026-11-05T00:00:00.000Z' });
    expect(crossingBatches([a, b], TARGET)).toHaveLength(1);
  });

  it('calls a fully answered batch approved, refused or mixed', () => {
    n = 0;
    const [approved] = crossingBatches([row({ state: 'APPLIED' }), row({ state: 'APPROVED' })], TARGET);
    expect(batchVerdict(approved)).toBe('APPROVED');
    n = 0;
    const [refused] = crossingBatches([row({ state: 'DENIED' }), row({ state: 'DENIED' })], TARGET);
    expect(batchVerdict(refused)).toBe('REFUSED');
    n = 0;
    const [mixed] = crossingBatches([row({ state: 'DENIED' }), row({ state: 'APPLIED' })], TARGET);
    expect(batchVerdict(mixed)).toBe('MIXED');
  });
});

describe('crossingBatches — the words', () => {
  it('asks per kind, singular and plural', () => {
    expect(crossingTitle('MOVE_TASK', 8)).toBe('Move these tasks here?');
    expect(crossingTitle('MOVE_TASK', 1)).toBe('Move this task here?');
    expect(crossingTitle('FILE_TASK', 2)).toBe('File these tasks here?');
    expect(crossingTitle('FILE_TASK', 1)).toBe('File this task here?');
    expect(crossingTitle('DEPEND_ON_TASK', 2)).toBe('Allow these dependencies?');
    expect(crossingTitle('DEPEND_ON_TASK', 1)).toBe('Allow this dependency?');
    expect([crossingBadge('MOVE_TASK'), crossingBadge('FILE_TASK'), crossingBadge('DEPEND_ON_TASK')])
      .toEqual(['move', 'file', 'depend']);
    expect([crossingListHead('MOVE_TASK'), crossingListHead('FILE_TASK'), crossingListHead('DEPEND_ON_TASK')])
      .toEqual(['Tasks to move', 'Tasks to file', 'Tasks waited on']);
    expect(answeredBadge('MOVE_TASK', 'APPROVED')).toBe('moved');
    expect(answeredBadge('FILE_TASK', 'APPROVED')).toBe('approved');
    expect(answeredBadge('DEPEND_ON_TASK', 'REFUSED')).toBe('refused');
    expect(answeredBadge('MOVE_TASK', 'MIXED')).toBe('answered');
  });

  it('summarises the board’s card: count, source by name, criteria as a range, no ids', () => {
    n = 0;
    const rows = Array.from({ length: 8 }, () => row());
    const [batch] = crossingBatches(rows, TARGET);
    const summary = crossingSummary(batch);
    expect(summary).toBe('8 tasks from Runner link v1 · for criteria 4–11');
    expect(summary).not.toMatch(/Pub|SrcPub|TgtPub|row-|task-|2wnd/);
    expect(waitingLine(batch)).toBe('move · 8 waiting');
  });

  it('says criteria as a list when they are not a run, and one criterion in the singular', () => {
    expect(criteriaRange([9, 4, 6])).toBe('4, 6, 9');
    expect(criteriaRange([5])).toBe('5');
    expect(criteriaRange([5, 4, 5])).toBe('4–5');
    n = 0;
    const [one] = crossingBatches([row({ requestedCriterion: { key: '5QwwlrpmVQesF7jgVjMxe5', text: 'x', ordinal: 4 } })], TARGET);
    expect(crossingSummary(one)).toBe('1 task from Runner link v1 · for criterion 4');
    n = 0;
    const scattered = [9, 4, 6].map((ordinal) =>
      row({ requestedCriterion: { key: `Key${ordinal}base62AAAAAAA`, text: `c${ordinal}`, ordinal } }));
    const [list] = crossingBatches(scattered, TARGET);
    expect(crossingSummary(list)).toBe('3 tasks from Runner link v1 · for criteria 4, 6, 9');
    n = 0;
    const same = [row(), row()].map((r) => ({ ...r, requestedCriterion: { key: 'SameKey', text: 'x', ordinal: 7 } }));
    const [shared] = crossingBatches(same, TARGET);
    expect(crossingSummary(shared)).toBe('2 tasks from Runner link v1 · for criterion 7');
    n = 0;
    const [none] = crossingBatches(
      [row({ kind: 'DEPEND_ON_TASK', requestedCriterion: null }), row({ kind: 'DEPEND_ON_TASK', requestedCriterion: null })],
      TARGET,
    );
    expect(crossingSummary(none)).toBe('2 dependencies from Runner link v1');
  });

  it('falls back to the criterion’s words, never its key, when the number is missing', () => {
    n = 0;
    // An older server sends no ordinal at all.
    const [older] = crossingBatches(
      [row({ requestedCriterion: { key: '5QwwlrpmVQesF7jgVjMxe5', text: 'A wedged drain restarts within a minute.' } })],
      TARGET,
    );
    expect(crossingSummary(older)).toBe('1 task from Runner link v1 · for criterion “A wedged drain restarts within a minute.”');
    expect(requestedCriterionLine(older.rows[0])).toBe(
      'Target criterion requested: A wedged drain restarts within a minute.');
    n = 0;
    // Numbers and words together: the numbers first, then the words.
    const [mixed] = crossingBatches([
      row({ requestedCriterion: { key: 'AAAone', text: 'one', ordinal: 2 } }),
      row({ requestedCriterion: { key: 'AAAtwo', text: 'two', ordinal: null } }),
    ], TARGET);
    expect(crossingSummary(mixed)).toBe('2 tasks from Runner link v1 · for criteria 2, “two”');
    n = 0;
    // A criterion that is gone has neither: the summary leaves it out, the row says so.
    const [gone] = crossingBatches(
      [row({ requestedCriterion: { key: '5QwwlrpmVQesF7jgVjMxe5', text: null, ordinal: null } })], TARGET);
    expect(crossingSummary(gone)).toBe('1 task from Runner link v1');
    expect(requestedCriterionLine(gone.rows[0])).toBe(
      'Target criterion requested: The target project no longer states this criterion.');
    for (const line of [crossingSummary(older), crossingSummary(mixed), crossingSummary(gone),
      requestedCriterionLine(older.rows[0]), requestedCriterionLine(gone.rows[0])]) {
      expect(line).not.toMatch(/5Qww|AAAone|AAAtwo/);
    }
  });

  it('names a source with no title as an unnamed project, never by id', () => {
    n = 0;
    const [batch] = crossingBatches([row({ fromProject: null })], TARGET);
    expect(crossingSummary(batch)).toContain('from unnamed project');
  });

  it('pluralises the move consequence and keeps the filing one', () => {
    n = 0;
    const [many] = crossingBatches([row(), row()], TARGET);
    expect(approveConsequence(many)).toBe(MOVE_TASKS_APPROVE_CONSEQUENCE);
    n = 0;
    const [one] = crossingBatches([row()], TARGET);
    expect(approveConsequence(one)).toBe(MOVE_TASK_APPROVE_CONSEQUENCE);
    n = 0;
    const [file] = crossingBatches([row({ kind: 'FILE_TASK' })], TARGET);
    expect(approveConsequence(file)).toBe(FILE_APPROVE_CONSEQUENCE);
  });

  it('lists each criterion line and each distinct reason once', () => {
    n = 0;
    const gone = row({
      requestedCriterion: { key: '2wndAAHBC95f4Al8rNFtR', text: null, ordinal: null },
      withdrawnCriterion: { key: '5QwwlrpmVQesF7jgVjMxe5', text: 'old', ordinal: 2 },
    });
    expect(requestedCriterionLine(gone)).toBe(
      'Target criterion requested: The target project no longer states this criterion.',
    );
    expect(withdrawnCriterionLine(gone)).toBe('Source criterion it serves now: Criterion 2');
    expect(requestedCriterionLine(row())).toBe(`Target criterion requested: Criterion ${3 + n}`);
    expect(withdrawnCriterionLine(row({ withdrawnCriterion: { key: '5QwwlrpmVQesF7jgVjMxe5', text: 'old' } })))
      .toBe('Source criterion it serves now: old');
    const [batch] = crossingBatches([gone, row(), row({ reason: 'another' }), row({ reason: null })], TARGET);
    expect(batchReasons(batch)).toEqual([
      'These tasks serve criteria here; their old project is done.',
      'another',
    ]);
  });

  it('says where an answer came from', () => {
    expect(anotherEndLine('APPROVED')).toBe('Approved at another end');
    expect(anotherEndLine('REFUSED')).toBe('Refused at another end');
    expect(notRecordedNote(1)).toBe('1 answer was not recorded');
    expect(notRecordedNote(3)).toBe('3 answers were not recorded');
  });
});

describe('crossingBatches — a task asked to be taken out of every project', () => {
  const out = (over: Partial<ProjectCrossingRow> = {}) =>
    row({ toProjectId: null, toProjectPublicId: null, toProject: null, requestedCriterion: null, ...over });

  it('is drawn in the source project\'s conversation, as a batch of its own', () => {
    n = 0;
    const rows = [out(), row({ fromProjectId: SOURCE, toProjectId: OTHER_SOURCE, toProjectPublicId: 'x' }), out()];
    const batches = crossingBatches(rows, SOURCE);
    expect(batches.map((b) => [b.kind, b.out, b.rows.length])).toEqual([['MOVE_TASK', true, 2]]);
    // ...by either spelling of the id, and never in another project's conversation.
    expect(crossingBatches([out()], 'SrcPub')).toHaveLength(1);
    expect(crossingBatches([out()], TARGET)).toHaveLength(0);
  });

  it('says what it does: take the task out, or keep it here', () => {
    n = 0;
    const [one] = crossingBatches([out()], SOURCE);
    expect(crossingTitle(one.kind, 1, null, true)).toBe('Take this task out of the project?');
    expect(crossingTitle(one.kind, 2, null, true)).toBe('Take these tasks out of the project?');
    expect(crossingSummary(one)).toBe('1 task to take out of Runner link v1');
    expect(crossingListHead(one.kind, true)).toBe('Tasks to take out');
    expect(approveConsequence(one)).toMatch(/^Confirming takes the task out of this project/);
    expect(decisionLabels(one)).toEqual({ approve: 'Take it out', refuse: 'Keep it here' });
    expect(answeredBadge(one.kind, 'APPROVED', true)).toBe('taken out');
    const [two] = crossingBatches([out(), out()], SOURCE);
    expect(decisionLabels(two)).toEqual({ approve: 'Take them out', refuse: 'Keep them here' });
    // An ordinary move keeps its words.
    const [into] = crossingBatches([row()], TARGET);
    expect(into.out).toBe(false);
    expect(decisionLabels(into)).toEqual({ approve: 'Approve', refuse: 'Refuse' });
  });
});

describe('moveBatches — a move out of every project, from the session read', () => {
  it('is a take-out batch with no target, in the asking session and in the source coordinator alike', () => {
    n = 0;
    const move = row({ toProjectId: null, toProjectPublicId: null, toProject: null, requestedCriterion: null });
    for (const drawnAs of [['REQUESTER'], ['TARGET_COORDINATOR']] as const) {
      const [batch] = moveBatches([{
        batchKey: 'k', requestedBySessionId: 's', fromProjectId: SOURCE, toProjectId: null, state: 'PENDING',
        since: move.requestedAt, decidedAt: null, drawnAs, moves: [move],
      }]);
      expect(batch.out).toBe(true);
      expect(batch.targetTitle).toBeNull();
      expect(crossingTitle(batch.kind, 1, batch.targetTitle, batch.out)).toBe('Take this task out of the project?');
      expect(decisionLabels(batch)).toEqual({ approve: 'Take it out', refuse: 'Keep it here' });
    }
  });
});

describe('an answered card says what happened', () => {
  it('heads it in the past tense by kind and verdict, and a mixed answer only as answered', () => {
    expect(answeredTitle('MOVE_TASK', 1, 'APPROVED', null, true)).toBe('Task taken out of the project');
    expect(answeredTitle('MOVE_TASK', 2, 'APPROVED', null, true)).toBe('Tasks taken out of the project');
    expect(answeredTitle('MOVE_TASK', 1, 'REFUSED', null, true)).toBe('Task kept in the project');
    expect(answeredTitle('MOVE_TASK', 3, 'APPROVED')).toBe('Tasks moved here');
    expect(answeredTitle('MOVE_TASK', 1, 'APPROVED', 'Runner hardening')).toBe('Task moved to Runner hardening');
    expect(answeredTitle('MOVE_TASK', 1, 'REFUSED')).toBe('Move refused');
    expect(answeredTitle('FILE_TASK', 1, 'APPROVED')).toBe('Task filed here');
    expect(answeredTitle('FILE_TASK', 2, 'REFUSED')).toBe('Filings refused');
    expect(answeredTitle('DEPEND_ON_TASK', 2, 'APPROVED')).toBe('Dependencies allowed');
    expect(answeredTitle('DEPEND_ON_TASK', 1, 'REFUSED')).toBe('Dependency refused');
    expect(answeredTitle('MOVE_TASK', 2, 'MIXED')).toBe('Requests answered');
  });

  it('labels the quoted reasons as the agent\'s, and takes a task out in the project page\'s words', () => {
    expect(reasonsHead(1)).toBe('Reason given by the requesting agent');
    expect(reasonsHead(2)).toBe('Reasons given by the requesting agent');
    expect(MOVE_OUT_APPROVE_CONSEQUENCE).toBe(MOVE_TASK_OUT_APPROVE_CONSEQUENCE);
    expect(MOVE_OUT_MANY_APPROVE_CONSEQUENCE).toMatch(/^Confirming takes the tasks out of this project as soon as you answer; /);
  });
});
