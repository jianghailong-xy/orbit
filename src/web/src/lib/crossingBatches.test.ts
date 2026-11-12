import { describe, expect, it } from 'vitest';
import type { ProjectCrossingRow } from './attribution';
import {
  FILE_APPROVE_CONSEQUENCE,
  MOVE_TASKS_APPROVE_CONSEQUENCE,
  anotherEndLine,
  answeredBadge,
  approveConsequence,
  batchReasons,
  batchVerdict,
  criteriaRange,
  crossingBadge,
  crossingBatches,
  crossingListHead,
  crossingSummary,
  crossingTitle,
  isLive,
  notRecordedNote,
  requestedCriterionLine,
  waitingLine,
  withdrawnCriterionLine,
} from './crossingBatches';
import { MOVE_TASK_APPROVE_CONSEQUENCE } from '../components/ProjectCrossingsCard';

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
    requestedCriterion: { key: String(3 + n), text: `criterion ${3 + n}` },
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
    expect(summary).not.toMatch(/Pub|SrcPub|TgtPub|row-|task-/);
    expect(waitingLine(batch)).toBe('move · 8 waiting');
  });

  it('says criteria as a list when they are not a run, and one criterion in the singular', () => {
    expect(criteriaRange(['9', '4', '6'])).toBe('4, 6, 9');
    expect(criteriaRange(['5'])).toBe('5');
    expect(criteriaRange(['b', 'a'])).toBe('a, b');
    n = 0;
    const [one] = crossingBatches([row({ requestedCriterion: { key: '4', text: 'x' } })], TARGET);
    expect(crossingSummary(one)).toBe('1 task from Runner link v1 · for criterion 4');
    n = 0;
    const [none] = crossingBatches(
      [row({ kind: 'DEPEND_ON_TASK', requestedCriterion: null }), row({ kind: 'DEPEND_ON_TASK', requestedCriterion: null })],
      TARGET,
    );
    expect(crossingSummary(none)).toBe('2 dependencies from Runner link v1');
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
    const gone = row({ requestedCriterion: { key: '4', text: null }, withdrawnCriterion: { key: '2', text: 'old' } });
    expect(requestedCriterionLine(gone)).toBe(
      'Target criterion requested: 4 — The target project no longer states this criterion.',
    );
    expect(withdrawnCriterionLine(gone)).toBe('Source criterion it serves now: 2');
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
