import { describe, expect, it } from 'vitest';
import { sessionStatusMeta } from '../components/TaskDetailPanel';
import { sessionMarks } from './sessionDisplay';
import { sessionTimeSections } from './sessionGrouping';
import { serverActivity, SITUATIONS, olderServer, type Payload } from './sessionPhaseFields.fixture';
import { sessionRunStateOf } from './sessionState';

/** A run as the task detail's `sessions[]` sends it: the legacy fields beside the six session facts. */
const taskRun = (situation: string, facts: Record<string, unknown> = {}): Payload =>
  ({ ...SITUATIONS[situation], workFinished: false, endReason: null, ...facts }) as Payload;

// The badge says the state from `phase` alone; the fact it used to say instead is its mark (lib/sessionDisplay, the
// approved board docs/mocks/session-display-three-states).
const badge = (run: Payload) => [sessionStatusMeta(run).label, ...(sessionMarks(run) ?? [])];

describe('the task panel run badge reads the session facts', () => {
  it('a held queued run reads "Queued" with the On hold mark', () => {
    const run = taskRun('on hold');
    expect(run.status).toBe('PENDING');
    expect(run.activity).toBe(serverActivity('PENDING'));
    expect(badge(run)).toEqual(['Queued', 'ON_HOLD']);
  });

  it('a queued run with nothing holding it reads "Queued"', () => {
    expect(badge(taskRun('a queued turn'))).toEqual(['Queued']);
  });

  it('without the facts a held queued run reads "Queued" (the older control plane)', () => {
    expect(sessionStatusMeta(olderServer(taskRun('on hold'))).label).toBe('Queued');
  });

  it('a release that finished or ended draws its state alone (Finished and Ended are not drawn: the owner, 2026-11-27)', () => {
    const done = taskRun('a task run that finished', { endReason: 'task_done', workFinished: true });
    expect(badge(done)).toEqual(['Idle']);
    const plain = taskRun('old plain row stored SUCCEEDED', { workFinished: false });
    expect(sessionRunStateOf(plain)).toBe('ENDED');
    expect(badge(plain)).toEqual(['Idle']);
  });

  it('Failed only for a failed turn nobody asked to end', () => {
    expect(badge(taskRun('released by a failed turn'))).toEqual(['Idle', 'FAILED']);
    expect(badge(taskRun('ended, runner never confirmed', { endReason: 'ended' }))).toEqual(['Idle']);
    expect(badge(taskRun('released by End', { endReason: 'ended' }))).toEqual(['Idle']);
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
