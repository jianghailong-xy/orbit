import { describe, expect, it } from 'vitest';
import { isGenerating, statusLabel } from '../components/WorkspaceView';
import { sessionStatusMeta } from '../components/TaskDetailPanel';
import { followDelay } from '../pages/SharedSessionPage';
import { outlivingSessionWork } from './sessionActivity';
import { sessionMarks } from './sessionDisplay';
import { carriesServerActivity, olderServer, serverActivity, SITUATIONS } from './sessionPhaseFields.fixture';
import { isSessionLive, isSessionWorking, sessionRunStateOf, type SessionStateSource } from './sessionState';

/**
 * The regression of deploy 3: the server answers `activity` TURN for every row stored PENDING or RUNNING
 * (sessionActivitySql), so a plain running turn carries one, and must read Running, offer Stop and keep its approval
 * card answerable. Every row below carries the activity the server sends.
 */

const stopOffered = (s: SessionStateSource & Record<string, unknown>) =>
  isGenerating(s, sessionRunStateOf(s)) || outlivingSessionWork(s as never) !== null;

// [situation, run state, header word (`phase` alone, lib/sessionDisplay), its marks, Stop, approval answerable, polls
// at the working pace]. The run state, Stop, approval and pace columns are the behaviour the display change must keep.
const TABLE: [string, string, string, string[], boolean, boolean, boolean][] = [
  ['a queued turn', 'QUEUED', 'Queued', [], false, false, true],
  ['on hold', 'QUEUED', 'Queued', ['ON_HOLD'], false, false, true],
  ['a running turn', 'RUNNING', 'Running', [], true, true, true],
  ['waiting on an approval', 'RUNNING', 'Running', ['NEEDS_YOU'], true, true, true],
  ["parked with the engine's own turn", 'AWAITING_INPUT', 'Running', [], true, true, true],
  ['parked with a sub-agent running', 'AWAITING_INPUT', 'Running', [], true, false, true],
  ['running a job with no turn', 'AWAITING_INPUT', 'Running', ['BACKGROUND'], true, false, true],
  ['will wake', 'AWAITING_INPUT', 'Idle', ['WILL_RESUME'], false, false, false],
  ['held idle', 'AWAITING_INPUT', 'Idle', [], false, false, false],
  ['interrupted', 'INTERRUPTED', 'Idle', ['INTERRUPTED'], false, false, false],
  ['released by a failed turn', 'FAILED', 'Idle', ['FAILED'], false, false, false],
  ['released by End', 'ENDED', 'Idle', ['ENDED'], false, false, false],
  ['a task run that finished', 'SUCCEEDED', 'Idle', ['FINISHED'], false, false, false],
  ['released with a retry armed', 'FAILED', 'Idle', ['RETRYING'], false, false, false],
];

describe('the fixtures are the server shape', () => {
  it('every RUNNING or PENDING row carries activity TURN', () => {
    for (const [name, payload] of Object.entries(SITUATIONS)) expect(carriesServerActivity(payload), name).toBe(true);
  });
  it('the guard fails a RUNNING row built without activity TURN', () => {
    expect(carriesServerActivity({ id: 's', status: 'RUNNING' })).toBe(false);
    expect(carriesServerActivity({ id: 's', status: 'PENDING', activity: 'WAITING' })).toBe(false);
  });
  it('mirrors sessionActivitySql', () => {
    expect(serverActivity('RUNNING')).toBe('TURN');
    expect(serverActivity('PENDING')).toBe('TURN');
    expect(serverActivity('AWAITING_INPUT')).toBeNull();
    expect(serverActivity('AWAITING_INPUT', 'BACKGROUND_JOB')).toBe('BACKGROUND_JOB');
    expect(serverActivity('INTERRUPTED', 'TURN')).toBeNull();
  });
});

describe('run state, word, Stop, approval and poll pace of every shape', () => {
  for (const [name, state, word, marks, stop, answerable, fast] of TABLE) {
    it(`${name}: ${state}, "${word}"${marks.length ? ` + ${marks.join(', ')}` : ''}`, () => {
      const s = SITUATIONS[name] as SessionStateSource & Record<string, unknown>;
      expect(sessionRunStateOf(s)).toBe(state);
      expect(statusLabel(s)).toBe(word);
      expect(sessionMarks(s)).toEqual(marks);
      expect(stopOffered(s)).toBe(stop);
      // WorkspaceView's turnStillGenerating decides whether an approval card is answerable.
      expect(isGenerating(s, sessionRunStateOf(s))).toBe(answerable);
      expect(followDelay(s, false) !== null && isSessionWorking(s)).toBe(fast);
    });
  }

  it('a running turn reads Running with a Stop button and an answerable approval card', () => {
    const s = SITUATIONS['a running turn'];
    expect(s.activity).toBe('TURN');
    expect(sessionRunStateOf(s)).toBe('RUNNING');
    expect(isGenerating(s, sessionRunStateOf(s))).toBe(true);
    expect(isSessionLive(s)).toBe(true);
  });

  it('a running turn reads the same with and without the new fields', () => {
    const s = SITUATIONS['a running turn'];
    expect(sessionRunStateOf(olderServer(s))).toBe('RUNNING');
    expect(statusLabel(olderServer(s))).toBe(statusLabel(s));
  });
});

describe('the task panel run badge reads the same run state', () => {
  const badge = (s: SessionStateSource) => sessionStatusMeta(s).label;
  it('says Running for a running turn and Idle (its mark: Finished) for a finished run', () => {
    expect(badge(SITUATIONS['a running turn'])).toBe('Running');
    expect(badge(SITUATIONS['a task run that finished'])).toBe('Idle');
  });
  it('says Queued for a held queued run, whose hold is its On hold mark', () => {
    expect(badge(SITUATIONS['on hold'])).toBe('Queued');
    expect(sessionMarks(SITUATIONS['on hold'])).toEqual(['ON_HOLD']);
  });
});
