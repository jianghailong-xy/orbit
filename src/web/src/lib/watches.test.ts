import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  WATCH_ACTIONS,
  WATCH_ATTENTION_EXPIRED_ACTIONS,
  WATCH_ATTENTION_STATES,
  WATCH_LIMITS,
  WATCH_STATES,
  uuidToBase62,
  type WatchDeliveryView,
  type WatchPredicate,
  type WatchTargetView,
  type WatchView,
} from '@orbit/shared';
import {
  LEAF_COPY,
  TTL_CHOICES,
  ago,
  cancelWatch,
  choiceOf,
  createWatch,
  createWatchBody,
  describeCondition,
  describeProgress,
  describeReason,
  expiryLabel,
  formatSpan,
  groupWatches,
  lastChangedAt,
  mergeWatches,
  parseWatchWake,
  pauseWatch,
  predicateFor,
  progressOf,
  resumeWatch,
  thresholdOf,
  updateWatch,
  wakeWithdrawn,
  watchBucket,
  watchErrorMessage,
  watchProblem,
  watchStateCopy,
  watchesFollowedBy,
  watchesFollowing,
} from './watches';

vi.mock('../api', () => ({ api: vi.fn(async () => ({})) }));
const { api } = await import('../api');

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const at = (fromNow: number) => new Date(NOW + fromNow).toISOString();

const target = (id: string, over: Partial<WatchTargetView> = {}): WatchTargetView => ({
  targetKind: 'TASK',
  targetResourceId: id,
  state: 'OBSERVED',
  targetEpoch: 0,
  lastEvaluatedAt: at(-2 * HOUR),
  ...over,
});

const delivery = (over: Partial<WatchDeliveryView> = {}): WatchDeliveryView => ({
  id: 'd1',
  action: 'NOTIFY_USER',
  state: 'DELIVERED',
  attempts: 0,
  nextAttemptAt: null,
  lastError: null,
  deliveredAt: at(-HOUR),
  deadLetteredAt: null,
  createdAt: at(-HOUR),
  updatedAt: at(-HOUR),
  ...over,
});

function watch(over: Partial<WatchView> = {}): WatchView {
  return {
    id: 'w1',
    observerType: 'USER',
    observerSessionId: null,
    predicateVersion: 1,
    predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
    mode: 'ONE_SHOT',
    action: 'NOTIFY_USER',
    state: 'ACTIVE',
    generation: 0,
    expiresAt: at(DAY),
    nextEvaluateAt: at(MINUTE),
    lastEvaluatedAt: at(-12 * SECOND),
    idempotencyKey: null,
    createdAt: at(-2 * HOUR),
    updatedAt: at(-2 * HOUR),
    targets: [target('t1')],
    matches: [],
    expiryDeliveries: [],
    ...over,
  };
}

const matched = (deliveries: WatchDeliveryView[], matchedAt = at(-HOUR)): Partial<WatchView> => ({
  state: 'MATCHED',
  generation: 1,
  matches: [
    {
      id: 'm1',
      generation: 1,
      matchedAt,
      reason: 'ALL TASK_TERMINAL 1/1',
      predicateVersion: 1,
      perTargetSnapshot: { evaluatedAt: matchedAt, targets: [] },
      deliveries,
    },
  ],
});

describe('the condition, in words', () => {
  it('reads one target, all, both and any over the targets its leaf can read', () => {
    const all = { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' } as const;
    const any = { kind: 'ANY', over: 'ALL_TARGETS', leaf: 'TASK_FAILED' } as const;
    expect(describeCondition(all, [target('a')])).toBe('When the task finishes');
    expect(describeCondition(all, [target('a'), target('b')])).toBe('When both tasks finish');
    expect(describeCondition(all, [target('a'), target('b'), target('c')])).toBe('When all 3 tasks finish');
    expect(describeCondition(any, [target('a'), target('b'), target('c')])).toBe(
      'When any 1 of these 3 tasks fails',
    );
    // Counted by the leaf's own kind: a session leaf over a mixed set talks about the sessions.
    expect(
      describeCondition({ kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_TURN_SETTLED' }, [
        target('a'),
        target('s', { targetKind: 'SESSION' }),
      ]),
    ).toBe('When the session finishes its turn');
  });

  it("reads the agent's canonical composite, and names a leaf it does not know", () => {
    const targets = Array.from({ length: 7 }, (_, i) => target(`t${i}`));
    expect(
      describeCondition(
        {
          kind: 'ANY_OF',
          operands: [
            { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
            { kind: 'ANY', over: 'ALL_TARGETS', leaf: 'TASK_FAILED' },
          ],
        },
        targets,
      ),
    ).toBe('When all 7 tasks finish, or any 1 of these 7 tasks fails');
    expect(
      describeCondition({ kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_REOPENED' as never }, targets),
    ).toBe('When ALL TASK_REOPENED');
  });

  it('keeps settled, ended, filed away and done apart (contract §2.2)', () => {
    const phrases = Object.values(LEAF_COPY).map((copy) => copy.one);
    expect(new Set(phrases).size).toBe(phrases.length);
  });

  it("reads a Match's recorded reason back as counts, and leaves any other shape alone", () => {
    expect(describeReason('ANY_OF(ALL TASK_TERMINAL 5/7, ANY TASK_FAILED 1/7)')).toBe(
      '5 of 7 finished · 1 of 7 failed',
    );
    expect(describeReason('ALL SESSION_TURN_SETTLED 2/2')).toBe('2 of 2 finished their turn');
    expect(describeReason('something a newer server wrote')).toBe('something a newer server wrote');
  });
});

describe('how stale, and for how long', () => {
  it('formats spans for a card row', () => {
    expect(formatSpan(40 * SECOND)).toBe('40s');
    expect(formatSpan(12 * MINUTE)).toBe('12m');
    expect(formatSpan(3 * HOUR + 20 * MINUTE)).toBe('3h 20m');
    expect(formatSpan(23 * HOUR)).toBe('23h');
    expect(formatSpan(2 * DAY + 4 * HOUR)).toBe('2d 4h');
    expect(formatSpan(12 * DAY)).toBe('12d');
    expect(ago(at(-3 * SECOND), NOW)).toBe('just now');
    expect(ago(at(5 * SECOND), NOW)).toBe('just now');
    expect(ago(at(-42 * MINUTE), NOW)).toBe('42m ago');
    expect(ago(null, NOW)).toBe('never');
  });

  it('counts a live deadline down — paused included — and flags the last hour', () => {
    expect(expiryLabel(watch({ expiresAt: at(21 * HOUR) }), NOW)).toEqual({ text: 'in 21h', soon: false });
    expect(expiryLabel(watch({ state: 'PAUSED', expiresAt: at(48 * MINUTE) }), NOW)).toEqual({
      text: 'in 48m',
      soon: true,
    });
    expect(expiryLabel(watch({ state: 'EXPIRED', expiresAt: at(-2 * HOUR) }), NOW)).toEqual({
      text: '2h ago',
      soon: false,
    });
    // A deadline means nothing to a watch that already ended some other way.
    expect(expiryLabel(watch({ state: 'CANCELLED' }), NOW)).toBeNull();
    expect(expiryLabel(watch(matched([delivery()])), NOW)).toBeNull();
  });

  it('takes the last change from the targets and the Match, never from the last look', () => {
    const w = watch({
      createdAt: at(-5 * HOUR),
      lastEvaluatedAt: at(-10 * SECOND),
      targets: [
        target('a', { lastEvaluatedAt: at(-5 * HOUR) }),
        target('b', { state: 'SATISFIED', lastEvaluatedAt: at(-42 * MINUTE) }),
        target('c', { lastEvaluatedAt: null }),
      ],
    });
    expect(lastChangedAt(w)).toBe(at(-42 * MINUTE));
    expect(lastChangedAt({ ...w, ...matched([], at(-5 * MINUTE)) })).toBe(at(-5 * MINUTE));
    expect(lastChangedAt(watch({ createdAt: at(-HOUR), targets: [] }))).toBe(at(-HOUR));
  });

  it('summarises the current snapshot', () => {
    const p = progressOf(
      watch({
        targets: [target('a', { state: 'SATISFIED' }), target('b'), target('c', { state: 'GONE' })],
      }),
    );
    expect(p).toEqual({ met: 1, waiting: 1, gone: 1, total: 3 });
    expect(describeProgress(p)).toBe('1 of 3 met · 1 deleted');
    expect(describeProgress(progressOf(watch({ targets: [] })))).toBe('No targets');
  });
});

describe('the threshold the condition sets', () => {
  const TASKS = Array.from({ length: 4 }, (_, i) => target(`t${i}`));
  const any: WatchPredicate = { kind: 'ANY', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' };

  it('asks one target of an ANY, however many it looks at', () => {
    expect(thresholdOf(any, TASKS)).toEqual({ needed: 1, of: 4 });
  });

  it('asks its own count of an AT_LEAST, and never more than the set holds', () => {
    const atLeast = (count: number): WatchPredicate => ({
      kind: 'AT_LEAST',
      count,
      over: 'ALL_TARGETS',
      leaf: 'TASK_TERMINAL',
    });
    expect(thresholdOf(atLeast(2), TASKS)).toEqual({ needed: 2, of: 4 });
    // The server refuses a quota larger than the set; one already stored is not trusted to be smaller.
    expect(thresholdOf(atLeast(9), TASKS)).toEqual({ needed: 4, of: 4 });
  });

  it('asks every target of an ALL', () => {
    expect(thresholdOf({ kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' }, TASKS)).toEqual({
      needed: 4,
      of: 4,
    });
  });

  it('asks every target of a composite it cannot read, without throwing', () => {
    const composite: WatchPredicate = {
      kind: 'ALL_OF',
      operands: [
        { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
        { kind: 'ANY', over: 'ALL_TARGETS', leaf: 'TASK_FAILED' },
      ],
    };
    expect(() => thresholdOf(composite, TASKS)).not.toThrow();
    expect(thresholdOf(composite, TASKS)).toEqual({ needed: 4, of: 4 });
  });

  it('counts the targets its leaf can read, and no others', () => {
    const mixed = [...TASKS, target('s1', { targetKind: 'SESSION' })];
    expect(thresholdOf(any, mixed)).toEqual({ needed: 1, of: 4 });
    expect(
      thresholdOf({ kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_TURN_SETTLED' }, mixed),
    ).toEqual({ needed: 1, of: 1 });
  });

  it('asks nothing of no targets', () => {
    expect(thresholdOf(any, [])).toEqual({ needed: 0, of: 0 });
  });

  it('reads progress against that threshold, not against the target count', () => {
    const w = watch({ predicate: any, targets: TASKS });
    const said = describeProgress(progressOf(w), thresholdOf(w.predicate, w.targets));
    expect(said).toBe('0 met');
    expect(said).not.toContain('of 4');
  });
});

describe('what needs attention', () => {
  it('files a plain live watch as active and a delivered or cancelled one as history', () => {
    expect(watchBucket(watch())).toBe('active');
    expect(watchBucket(watch({ state: 'PAUSED' }))).toBe('active');
    expect(watchBucket(watch(matched([delivery()])))).toBe('history');
    expect(watchBucket(watch({ state: 'CANCELLED' }))).toBe('history');
    // An expired RESUME_SESSION watch told its session (contract §5): nothing is left unsaid.
    expect(
      watchBucket(
        watch({
          state: 'EXPIRED',
          action: 'RESUME_SESSION',
          observerSessionId: 's1',
          expiryDeliveries: [{ ...delivery({ action: 'RESUME_SESSION' }), kind: 'EXPIRY', expirySnapshot: null }],
        }),
      ),
    ).toBe('history');
  });

  it('says out loud every end nobody would otherwise hear about', () => {
    expect(watchProblem(watch({ state: 'REVOKED' }))).toMatchObject({ tone: 'error' });
    expect(watchProblem(watch({ state: 'UNRESOLVABLE' }))?.title).toContain('every target was deleted');
    const dead = watchProblem(
      watch({
        action: 'RESUME_SESSION',
        observerSessionId: 's1',
        ...matched([
          delivery({
            action: 'RESUME_SESSION',
            state: 'DEAD_LETTER',
            attempts: 1,
            lastError: "OBSERVER_SESSION_ENDED: the observer session's run is over (ENDED), and a watch does not revive it",
          }),
        ]),
      }),
    );
    expect(dead).toEqual({
      tone: 'error',
      title: 'The session was not woken',
      detail: "The observer session's run is over (ENDED), and a watch does not revive it",
    });
    const retrying = watchProblem(
      watch(matched([delivery({ state: 'PENDING', attempts: 3, lastError: 'LEASE_EXPIRED: the worker stopped' })])),
    );
    expect(retrying).toMatchObject({ tone: 'warning', detail: 'The worker stopped' });
    expect(retrying?.title).toContain(`3 of ${WATCH_LIMITS.maxDeliveryAttempts}`);
    // A notify watch has nobody waiting on it, so an expiry is delivered to no one (contract §3).
    expect(watchProblem(watch({ state: 'EXPIRED', expiresAt: at(-HOUR) }))?.title).toBe(
      'Expired before its condition held',
    );
    expect(
      watchProblem(watch({ targets: [target('a'), target('b', { state: 'GONE' })] }))?.title,
    ).toBe('1 of 2 targets was deleted');
    for (const w of [
      watch({ state: 'REVOKED' }),
      watch({ state: 'EXPIRED' }),
      watch({ targets: [target('a', { state: 'GONE' }), target('b')] }),
    ]) {
      expect(watchBucket(w)).toBe('attention');
    }
  });

  it('files a wake withdrawn before it ran as history, and still raises one that never reached the session', () => {
    const dead = (lastError: string) =>
      watch({
        action: 'RESUME_SESSION',
        observerSessionId: 's1',
        ...matched([delivery({ action: 'RESUME_SESSION', state: 'DEAD_LETTER', attempts: 0, deliveredAt: null, lastError })]),
      });
    // As a real server wrote it: the wake left the observer's queue unrun because it was withdrawn.
    const withdrawn = dead("WAKE_WITHDRAWN: the wake was withdrawn from the observer session's queue before a runner took it");
    expect(watchProblem(withdrawn)).toBeNull();
    expect(watchBucket(withdrawn)).toBe('history');
    expect(wakeWithdrawn(withdrawn.matches[0].deliveries[0])).toBe(true);
    // An interrupt drops the wake with everything queued behind the turn it stops, so its answer reached nobody.
    const interrupted = dead(
      'OBSERVER_TURN_INTERRUPTED: the observer session was interrupted before a runner took its queued wake',
    );
    expect(watchProblem(interrupted)).toMatchObject({ tone: 'error', title: 'The session was not woken' });
    expect(watchBucket(interrupted)).toBe('attention');
    expect(wakeWithdrawn(interrupted.matches[0].deliveries[0])).toBe(false);
  });

  it('files an ended watch where the contract says it belongs', () => {
    // `GET /watches?needsAttention=true` reads by the contract's `attention` rule, which shared transcribes: a page
    // that filed these anywhere else would hold watches its own Needs attention tab never raises, and miss ones it does.
    for (const state of WATCH_STATES.filter((value) => value !== 'ACTIVE' && value !== 'PAUSED')) {
      for (const action of WATCH_ACTIONS) {
        const observing = action === 'RESUME_SESSION' ? { observerType: 'SESSION' as const, observerSessionId: 's1' } : {};
        const needed =
          WATCH_ATTENTION_STATES.includes(state)
          || (state === 'EXPIRED' && WATCH_ATTENTION_EXPIRED_ACTIONS.includes(action));
        expect(watchBucket(watch({ state, action, ...observing })), `${state} ${action}`).toBe(
          needed ? 'attention' : 'history',
        );
      }
    }
  });

  it('orders history by when each watch ended, newest first', () => {
    const groups = groupWatches([
      watch({ id: 'old', ...matched([delivery()], at(-3 * DAY)) }),
      watch({ id: 'live' }),
      watch({ id: 'stopped', state: 'CANCELLED', updatedAt: at(-HOUR) }),
      watch({ id: 'lost', state: 'REVOKED' }),
      watch({ id: 'recent', ...matched([delivery()], at(-10 * MINUTE)) }),
    ]);
    expect(groups.active.map((w) => w.id)).toEqual(['live']);
    expect(groups.attention.map((w) => w.id)).toEqual(['lost']);
    expect(groups.history.map((w) => w.id)).toEqual(['recent', 'stopped', 'old']);
  });

  it('never borrows the Background processes wording for a watch (contract §9.2)', () => {
    for (const state of ['ACTIVE', 'PAUSED', 'MATCHED', 'EXPIRED', 'CANCELLED', 'REVOKED', 'UNRESOLVABLE']) {
      expect(watchStateCopy(state).label.toLowerCase()).not.toMatch(/background|process|running/);
    }
  });
});

describe('who follows whom', () => {
  const SESSION_UUID = '0195c0de-0000-7000-8000-0000000000a1';
  const TASK_UUID = '0195c0de-0000-7000-8000-0000000000b2';

  it('matches an observer and a target whichever way the id is spelled', () => {
    const waiting = watch({
      id: 'waiting',
      action: 'RESUME_SESSION',
      observerType: 'SESSION',
      observerSessionId: uuidToBase62(SESSION_UUID),
      targets: [target(uuidToBase62(TASK_UUID))],
    });
    const other = watch({ id: 'other', targets: [target('somethingElse')] });
    // Notifying watches are out however they are spelled: the calling session is their observer
    // (the runner door files every watch an agent makes that way), but what they trigger is a
    // notification to the person, not a resume of this session.
    const notifying = watch({
      id: 'notifying',
      action: 'NOTIFY_USER',
      observerType: 'SESSION',
      observerSessionId: uuidToBase62(SESSION_UUID),
      targets: [target(uuidToBase62(TASK_UUID))],
    });
    expect(watchesFollowing([waiting, notifying], SESSION_UUID).map((w) => w.id)).toEqual(['waiting']);
    expect(watchesFollowing([waiting, other], SESSION_UUID).map((w) => w.id)).toEqual(['waiting']);
    expect(watchesFollowing([waiting, other], uuidToBase62(SESSION_UUID)).map((w) => w.id)).toEqual(['waiting']);
    expect(watchesFollowedBy([waiting, other], 'TASK', TASK_UUID).map((w) => w.id)).toEqual(['waiting']);
    // Same id, other kind: a session is never followed by a watch on a task.
    expect(watchesFollowedBy([waiting, other], 'SESSION', TASK_UUID)).toEqual([]);
  });
});

describe('the editor', () => {
  it('round-trips the conditions it offers and refuses to flatten one it does not', () => {
    for (const choice of [
      { leaf: 'TASK_DONE', aggregation: 'ALL' },
      { leaf: 'SESSION_NEEDS_ATTENTION', aggregation: 'ANY' },
      { leaf: 'TASK_TERMINAL', aggregation: 'ALL', orAnyFails: true },
    ] as const) {
      expect(choiceOf(predicateFor(choice))).toEqual(choice);
    }
    expect(
      choiceOf({
        kind: 'ALL_OF',
        operands: [
          { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_DONE' },
          { kind: 'ANY', over: 'ALL_TARGETS', leaf: 'SESSION_NEEDS_ATTENTION' },
        ],
      }),
    ).toBeNull();
  });

  it('offers only deadlines the server accepts, the default among them', () => {
    for (const { seconds } of TTL_CHOICES) {
      expect(seconds).toBeGreaterThanOrEqual(WATCH_LIMITS.minTtlSeconds);
      expect(seconds).toBeLessThanOrEqual(WATCH_LIMITS.maxTtlSeconds);
    }
    expect(TTL_CHOICES.map((c) => c.seconds)).toContain(WATCH_LIMITS.defaultTtlSeconds);
  });

  it('names an observer only for a watch that resumes one', () => {
    const base = {
      targets: [{ kind: 'TASK' as const, id: 't1' }],
      choice: { leaf: 'TASK_TERMINAL' as const, aggregation: 'ALL' as const },
      ttlSeconds: 3600,
      idempotencyKey: 'k1',
    };
    expect(createWatchBody({ ...base, action: 'NOTIFY_USER', observerSessionId: 's1' })).toEqual({
      predicateVersion: 1,
      predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
      targets: [{ kind: 'TASK', id: 't1' }],
      action: 'NOTIFY_USER',
      ttlSeconds: 3600,
      idempotencyKey: 'k1',
    });
    expect(createWatchBody({ ...base, action: 'RESUME_SESSION', observerSessionId: 's1' })).toMatchObject({
      action: 'RESUME_SESSION',
      observerSessionId: 's1',
    });
  });

  it("explains a refusal by its code, and passes any other server message through", () => {
    expect(watchErrorMessage({ code: 'SELF_WATCH_LOOP', message: 'raw' })).toBe(
      'A session cannot be resumed by a watch on itself.',
    );
    expect(watchErrorMessage({ message: 'a MATCHED watch cannot be paused' })).toBe(
      'a MATCHED watch cannot be paused',
    );
    expect(watchErrorMessage(undefined)).toBe('The request failed.');
  });

  it('sends each control to its own route', async () => {
    const calls = vi.mocked(api);
    calls.mockClear();
    await pauseWatch('w1');
    await resumeWatch('w1');
    await cancelWatch('w1');
    await updateWatch('w1', { ttlSeconds: 3600 });
    await createWatch({ predicateVersion: 1, predicate: predicateFor({ leaf: 'TASK_DONE', aggregation: 'ALL' }), targets: [], action: 'NOTIFY_USER' });
    expect(calls.mock.calls.map(([path, init]) => `${(init as { method: string }).method} ${path}`)).toEqual([
      'POST /watches/w1/pause',
      'POST /watches/w1/resume',
      'POST /watches/w1/cancel',
      'PATCH /watches/w1',
      'POST /watches',
    ]);
  });
});

describe('the turn a watch queues', () => {
  // The three shapes watch-delivery.service.ts writes, built the way it builds them.
  const WATCH = '0195c0de-0000-7000-8000-0000000000c3';
  const TASK = '0195c0de-0000-7000-8000-0000000000d4';
  const fenced = (payload: unknown) => `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  const matchTurn = [
    `Orbit Watch ${WATCH} matched at generation 1: ANY_OF(ALL TASK_TERMINAL 2/3, ANY TASK_FAILED 1/3)`,
    '',
    'This turn was queued by the watch, not typed by a person. What the watch recorded when its condition held:',
  ].join('\n');
  const matchText = `${matchTurn}\n\n${fenced({
    watchId: WATCH,
    generation: 1,
    matchedAt: '2026-09-14T11:59:00.000Z',
    reason: 'ANY_OF(ALL TASK_TERMINAL 2/3, ANY TASK_FAILED 1/3)',
    changedTargets: [{ kind: 'TASK', id: TASK, state: 'SATISFIED', observed: { status: 'FAILED' } }],
    latestSnapshot: { evaluatedAt: '2026-09-14T11:59:00.000Z', targets: [] },
  })}`;

  it('recognises a Match wake and reads what changed', () => {
    expect(parseWatchWake(matchText)).toEqual({
      watchId: WATCH,
      kind: 'MATCHED',
      generation: 1,
      reason: 'ANY_OF(ALL TASK_TERMINAL 2/3, ANY TASK_FAILED 1/3)',
      changedTargets: [{ kind: 'TASK', id: TASK, state: 'SATISFIED', status: 'FAILED' }],
    });
  });

  it('recognises the last wake of a continuous budget, whose head is followed by the line saying it is the last', () => {
    const reason = 'ANY TASK_PROGRESS_AT_LEAST(5) 1/1; 2 crossings since 2026-09-14T11:58:40.000Z; wake 5 of 5';
    const last = [
      `Orbit Watch ${WATCH} matched at generation 5: ${reason}`,
      '',
      'That was the last wake its budget allows: the watch has ended and will not wake this session again.',
      '',
      'This turn was queued by the watch, not typed by a person. What the watch recorded when its condition held:',
    ].join('\n');
    const payload = { watchId: WATCH, generation: 5, matchedAt: '2026-09-14T11:59:00.000Z', reason, changedTargets: [] };
    expect(parseWatchWake(`${last}\n\n${fenced(payload)}`)).toEqual({
      watchId: WATCH,
      kind: 'MATCHED',
      generation: 5,
      reason,
      changedTargets: [],
    });
  });

  it('recognises the three unmatched ends', () => {
    const expiry = [
      `Orbit Watch ${WATCH} EXPIRED at 2026-09-14T11:00:00.000Z without its condition ever holding.`,
      '',
      'This turn was queued by the watch, not typed by a person. The watch has ended and will not wake this session again. What its last evaluation saw:',
    ].join('\n');
    expect(parseWatchWake(`${expiry}\n\n${fenced({ watchId: WATCH, state: 'EXPIRED' })}`)?.kind).toBe('EXPIRED');
    for (const end of ['REVOKED', 'UNRESOLVABLE'] as const) {
      const text = [
        `Orbit Watch ${WATCH} ended ${end}: every target it watched is gone, so its condition can never be decided.`,
        '',
        'This turn was queued by the watch, not typed by a person. The watch has ended and will not wake this session again.',
      ].join('\n');
      expect(parseWatchWake(`${text}\n\n${fenced({ watchId: WATCH, state: end })}`)).toMatchObject({
        kind: end,
        generation: null,
        changedTargets: [],
      });
    }
  });

  it('leaves a person their own bubble when any one part is missing or disagrees', () => {
    expect(parseWatchWake(matchTurn)).toBeNull();
    expect(parseWatchWake(matchText.replace('This turn was queued by the watch', 'I queued this'))).toBeNull();
    expect(parseWatchWake(matchText.replace(`"watchId": "${WATCH}"`, '"watchId": "another"'))).toBeNull();
    expect(parseWatchWake(`Orbit Watch is great\n\n${fenced({ watchId: 'x' })}`)).toBeNull();
  });

  it('holds its reading to the words the server writes', () => {
    // If the delivery worker rewords a wake, this goes red here instead of every wake quietly turning
    // back into a bubble that looks typed by the user. Resolved from either working directory.
    const source = [
      resolve(process.cwd(), '../apiserver/src/watches/watch-delivery.service.ts'),
      resolve(process.cwd(), 'src/apiserver/src/watches/watch-delivery.service.ts'),
    ].find(existsSync);
    if (!source) throw new Error('watch-delivery.service.ts not found from the test working directory');
    const text = readFileSync(source, 'utf8');
    expect(text).toContain('`Orbit Watch ${watchId} matched at generation ${match.generation}: ${reason}`');
    expect(text).toContain("'That was the last wake its budget allows: the watch has ended and will not wake this session again.'");
    expect(text).toContain('`Orbit Watch ${watch.id} EXPIRED at ${expiresAt} without its condition ever holding.`');
    expect(text).toContain('`Orbit Watch ${watchId} ended ${end}: ${WATCH_END_MEANING[end]}.`');
    expect(text.match(/'This turn was queued by the watch, not typed by a person\./g)?.length).toBe(3);
    expect(text).toContain('\\`\\`\\`json\\n${JSON.stringify(payload, null, 2)}\\n\\`\\`\\`');
  });
});
