import { describe, expect, it } from 'vitest';
import { sessionStatusMeta } from '../components/TaskDetailPanel';
import { sessionTimeSections } from './sessionGrouping';
import { serverActivity, SITUATIONS, olderServer, type Payload } from './sessionPhaseFields.fixture';
import { sessionRunStateOf } from './sessionState';

/** A run as the task detail's `sessions[]` sends it: the legacy fields beside the six session facts. */
const taskRun = (situation: string, facts: Record<string, unknown> = {}): Payload =>
  ({ ...SITUATIONS[situation], workFinished: false, endReason: null, ...facts }) as Payload;

describe('the task panel run badge reads the session facts', () => {
  it('a held queued run reads "On hold"', () => {
    const run = taskRun('on hold');
    expect(run.status).toBe('PENDING');
    expect(run.activity).toBe(serverActivity('PENDING'));
    expect(sessionStatusMeta(run).label).toBe('On hold');
  });

  it('a queued run with nothing holding it reads "Queued"', () => {
    expect(sessionStatusMeta(taskRun('a queued turn')).label).toBe('Queued');
  });

  it('without the facts a held queued run reads "Queued" (the older control plane)', () => {
    expect(sessionStatusMeta(olderServer(taskRun('on hold'))).label).toBe('Queued');
  });

  it('Finished only when the work finished', () => {
    const done = taskRun('a task run that finished', { endReason: 'task_done', workFinished: true });
    expect(sessionStatusMeta(done).label).toBe('Finished');
    // Released and answered, but the work did not finish: Ended, not Finished.
    const plain = taskRun('old plain row stored SUCCEEDED', { workFinished: false });
    expect(sessionRunStateOf(plain)).toBe('ENDED');
    expect(sessionStatusMeta(plain).label).toBe('Ended');
  });

  it('Failed only for a failed turn nobody asked to end; Ended otherwise', () => {
    expect(sessionStatusMeta(taskRun('released by a failed turn')).label).toBe('Failed');
    expect(sessionStatusMeta(taskRun('ended, runner never confirmed', { endReason: 'ended' })).label).toBe('Ended');
    expect(sessionStatusMeta(taskRun('released by End', { endReason: 'ended' })).label).toBe('Ended');
  });
});

describe('a job-only parked session groups under Working', () => {
  const jobOnly = { ...SITUATIONS['running a job with no turn'], id: 'job', createdAt: '2020-01-01T00:00:00Z' };
  const titles = (sessions: Payload[]) =>
    sessionTimeSections(sessions as never, { attention: true } as never).map((s) => `${s.title}:${s.sessions.map((x: { id: string }) => x.id).join(',')}`);

  it('with the facts present: phase RUNNING is working', () => {
    expect(jobOnly.status).toBe('AWAITING_INPUT');
    expect(jobOnly.activity).toBe('BACKGROUND_JOB');
    expect(titles([jobOnly])).toEqual(['Working:job']);
  });

  it('with the facts absent: the old status decides, as before', () => {
    expect(titles([olderServer(jobOnly)])).toEqual(['Older:job']);
    expect(titles([olderServer({ ...SITUATIONS['a running turn'], id: 'run', createdAt: '2020-01-01T00:00:00Z' })])).toEqual(['Working:run']);
  });

  it('a parked session with nothing running is not working', () => {
    expect(titles([{ ...SITUATIONS['held idle'], id: 'idle', createdAt: '2020-01-01T00:00:00Z' }])).toEqual(['Older:idle']);
  });
});

describe('phase RUNNING with a run status word this client does not know', () => {
  const unknown = (activity: string | null): Payload =>
    ({ id: 's', status: 'FUTURE_STATUS', runStatus: 'FUTURE_STATUS', phase: 'RUNNING', released: false, lastTurnOutcome: null, waitingOn: null, ...(activity ? { activity } : {}) }) as Payload;

  it('reads Running for no activity or TURN', () => {
    expect(sessionRunStateOf(unknown(null))).toBe('RUNNING');
    expect(sessionRunStateOf(unknown('TURN'))).toBe('RUNNING');
  });

  it('reads parked for BACKGROUND_JOB or WAITING', () => {
    expect(sessionRunStateOf(unknown('BACKGROUND_JOB'))).toBe('AWAITING_INPUT');
    expect(sessionRunStateOf(unknown('WAITING'))).toBe('AWAITING_INPUT');
  });

  it('a parked AWAITING_INPUT session with activity TURN still reads parked', () => {
    const parked = SITUATIONS["parked with the engine's own turn"];
    expect(parked.activity).toBe('TURN');
    expect(sessionRunStateOf(parked)).toBe('AWAITING_INPUT');
  });

  it('known statuses keep their rule', () => {
    expect(sessionRunStateOf({ ...unknown('BACKGROUND_JOB'), status: 'RUNNING', runStatus: 'RUNNING' })).toBe('RUNNING');
    expect(sessionRunStateOf({ ...unknown('TURN'), status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT' })).toBe('AWAITING_INPUT');
  });
});
