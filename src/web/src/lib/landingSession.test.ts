import { describe, expect, it } from 'vitest';
import type {
  IntegrationTimelineEntry,
  IntegrationTimelineSection,
  ProjectPromotionView,
  SessionLandingAttempt,
  SessionLandingView,
} from '@orbit/shared';
import {
  LANDING_FAILURE_STATES,
  LANDING_PAGE_COPY,
  landingAttemptCard,
  landingCheckPassed,
  landingDuration,
  landingEntryOk,
  landingGates,
  landingHeaderTitle,
  landingMergeReceipt,
  landingNoReportBand,
  landingMenuItemList,
  landingOutcomeCard,
  landingPushSentence,
  landingRefetchMs,
  landingTimeoutLine,
  isLandingSessionDetail,
  landingCancelling,
} from './landingSession';
import { landingClockTime } from '../components/ProjectPanoramaHeader';

// Local wall-clock instants: the page draws a reader's own clock, so no assertion may hard-code a
// UTC time (the landing merge check runs in the runner's zone, Asia/Shanghai).
const at = (hour: number, minute: number, second = 0): string =>
  new Date(2026, 8, 25, hour, minute, second).toISOString();
const NOW = new Date(2026, 8, 25, 14, 58, 30).getTime();
const STEP = at(14, 56, 40);

const attempt = (over: Partial<SessionLandingAttempt> = {}): SessionLandingAttempt => ({
  jobId: 'job-1',
  kind: 'LAND_TASK',
  state: 'RUNNING',
  generation: 1,
  phase: 'CHECK',
  round: 1,
  step: null,
  claim: 1,
  runnerName: 'wikova',
  sourceSessionId: 'source-1',
  targetRef: 'refs/heads/project/p1',
  startedAt: STEP,
  heartbeatAt: at(14, 58, 30),
  outputMovedAt: at(14, 58, 24),
  progressProtocol: 'v2',
  check: { name: 'MERGE_CHECK', index: 1, count: 3, budgetSeconds: 3_600, startedAt: STEP },
  liveness: 'LIVE',
  blockingReason: null,
  timedOut: false,
  limitSeconds: 600,
  retryable: false,
  pushBoundaryPassed: false,
  ...over,
});

const landing = (over: Partial<SessionLandingView> = {}): SessionLandingView => ({
  sessionId: 'landing-1',
  projectId: 'project-1',
  subject: 'TASK',
  taskId: 'task-1',
  promotionId: null,
  episode: 1,
  openedAt: at(14, 50),
  settledAt: null,
  settledAs: null,
  phase: 'CHECK',
  round: 1,
  checks: [],
  liveness: 'LIVE',
  blockingReason: null,
  currentAttempt: attempt(),
  todos: [],
  generations: [],
  timeline: { sections: [], facts: [], truncated: false },
  ...over,
});

const entry = (over: Partial<IntegrationTimelineEntry> = {}): IntegrationTimelineEntry => ({
  id: 'e1',
  seq: 1,
  kind: 'CLAIMED',
  at: STEP,
  claim: 1,
  round: null,
  check: null,
  phase: null,
  step: null,
  actor: { type: 'RUNNER' },
  reason: null,
  data: null,
  text: 'Claimed by runner wikova · claim 1',
  ...over,
});

const section = (over: Partial<IntegrationTimelineSection> = {}): IntegrationTimelineSection => ({
  title: 'Generation 1',
  jobId: 'job-1',
  kind: 'LAND_TASK',
  generation: 1,
  state: 'RUNNING',
  entries: [entry()],
  ...over,
});

const promotion = (over: Partial<ProjectPromotionView> = {}): ProjectPromotionView => ({
  promotionId: 'promo-1',
  state: 'MERGED',
  sourceKind: 'PROJECT_BRANCH',
  sourceRef: 'refs/heads/project/p1',
  sourceSha: 'a'.repeat(40),
  upstreamRef: 'refs/heads/main',
  commitsAhead: 2,
  filesChanged: 3,
  tasks: [
    { taskId: 'task-1', title: 'Ledger migration order' },
    { taskId: 'task-2', title: 'Payout retry budget' },
  ],
  taskIds: ['task-1', 'task-2'],
  checks: [],
  conflicts: [],
  blockedReason: null,
  upstreamShaChecked: 'b'.repeat(40),
  landsTreeSha: '5e5bfca' + '0'.repeat(33),
  landsAs: 'MERGE_COMMIT',
  askedAt: null,
  upstream: { syncedAt: null, conflicts: false },
  recheckedAt: null,
  recheck: null,
  merged: { sha: '8ed0ea7' + '0'.repeat(33), at: at(9, 51), automatic: true, byUserId: null },
  ...over,
});

describe('the renderer is chosen by the detail’s sessionKind', () => {
  it('reads the detail flag, not a list row’s kind', () => {
    expect(isLandingSessionDetail({ sessionKind: 'LANDING' })).toBe(true);
    expect(isLandingSessionDetail({ sessionKind: 'CONVERSATION' })).toBe(false);
    expect(isLandingSessionDetail({})).toBe(false);
    expect(isLandingSessionDetail(null)).toBe(false);
  });
});

describe('§2.7a: the landing page’s polling cadence', () => {
  it('is 4 s while the attempt runs, 15 s while it waits, and stops once settled', () => {
    expect(landingRefetchMs(landing())).toBe(4_000);
    expect(landingRefetchMs(landing({ currentAttempt: attempt({ state: 'QUEUED', phase: null, claim: 0 }) })))
      .toBe(15_000);
    expect(landingRefetchMs(landing({ currentAttempt: null }))).toBe(15_000);
    expect(landingRefetchMs(landing({ settledAt: at(9, 51), settledAs: 'LANDED' }))).toBe(false);
    expect(landingRefetchMs(null)).toBe(false);
  });
});

describe('the status card: five livenesses, three job kinds', () => {
  // §7.2 V6: the M is the kind's own most rounds per claim — three for a task's landing, none for
  // the two kinds with one round — whatever the check's count (3 in this fixture) says.
  const kinds: Array<[SessionLandingAttempt['kind'], string, string]> = [
    ['LAND_TASK', 'Landing', 'round 1 of 3'],
    ['CHECK_PROMOTION', 'Merge check', 'round 1'],
    ['LAND_PROMOTION', 'Merge to main', 'round 1'],
  ];

  it.each(kinds)('draws %s’s LIVE head and V6 rows', (kind, word, round) => {
    const card = landingAttemptCard(landing({ currentAttempt: attempt({ kind }) }), NOW, { updatedAt: NOW })!;
    expect(card.word).toBe(word);
    expect(card.state).toBe('checking');
    expect(card.right).toBe('1m 50s of 60m');
    expect(card.detail).toBe(`checking · output 6s ago · claim 1 · ${round} · updated just now`);
    expect(card.budget).toBe('Merge check 1m 50s of 60m');
    expect(card.live).toBe('Output 6s ago · Updated just now');
    expect(card.running).toBe(true);
  });

  it.each(kinds)('QUIET for %s: the heartbeat is fresh and the output is not', (kind, word, round) => {
    const card = landingAttemptCard(
      landing({ currentAttempt: attempt({ kind, liveness: 'QUIET', outputMovedAt: at(14, 44, 30) }) }),
      NOW,
      { updatedAt: NOW },
    )!;
    expect(card.word).toBe(word);
    expect(card.detail).toBe(
      `checking · no output for 14m · within its 60m budget · claim 1 · ${round} · updated just now`,
    );
    expect(card.live).toBe('No output for 14m · within its 60m budget · Updated just now');
    expect(card.running).toBe(true);
  });

  it.each(kinds)('SILENT for %s: the clock freezes at the runner’s last word', (kind, word, round) => {
    const card = landingAttemptCard(
      landing({
        currentAttempt: attempt({
          kind,
          liveness: 'SILENT',
          heartbeatAt: at(14, 54, 30),
          startedAt: at(14, 53, 30),
          check: { name: 'MERGE_CHECK', index: 1, count: 3, budgetSeconds: 3_600, startedAt: at(14, 49, 30) },
        }),
      }),
      NOW,
      { updatedAt: NOW },
    )!;
    expect(card.word).toBe(word);
    expect(card.detail).toBe(`checking · no word from runner wikova for 4m · claim 1 · ${round}`);
    expect(card.live).toBe('No word from runner wikova for 4m');
    expect(card.right).toBe('5m 0s of 60m');
  });

  it.each(kinds)('LEGACY for %s: reports only between steps, and no silence is inferred', (kind, word, round) => {
    const card = landingAttemptCard(
      landing({
        currentAttempt: attempt({ kind, liveness: 'LEGACY', heartbeatAt: at(14, 46, 30), progressProtocol: null }),
      }),
      NOW,
      { updatedAt: NOW },
    )!;
    expect(card.word).toBe(word);
    expect(card.detail).toBe(
      `checking · reports only between steps · claim 1 · ${round} · updated 12m ago`,
    );
    expect(card.live).toBe('Reports only between steps · Updated 12m ago');
  });

  it.each(kinds)('LEASE_EXPIRED for %s: the server’s own Timed out head', (kind, word) => {
    const card = landingAttemptCard(
      landing({
        currentAttempt: attempt({ kind, liveness: 'LEASE_EXPIRED', timedOut: true, heartbeatAt: at(14, 35, 30) }),
      }),
      NOW,
      { updatedAt: NOW },
    )!;
    expect(card.word).toBe(word);
    expect(card.timedOut).toBe(true);
    expect(card.right).toBe('Timed out');
    expect(card.rightIsClock).toBe(false);
    expect(card.detail).toBe('No report for 23m · limit 10m');
    expect(card.running).toBe(false);
  });

  it('a task’s landing is “of 3” whatever its check’s count, and with no check in flight', () => {
    const detail = (over: Partial<SessionLandingAttempt>, now = NOW) =>
      landingAttemptCard(landing({ currentAttempt: attempt(over) }), now, { updatedAt: now })!.detail;
    expect(detail({ round: 2, check: { name: 'TASK_ACCEPTANCE', index: 1, count: 1, budgetSeconds: 3_600, startedAt: STEP } }))
      .toBe('checking · output 6s ago · claim 1 · round 2 of 3 · updated just now');
    expect(detail({ phase: 'REBASE', check: null }))
      .toBe('rebasing · output 6s ago · claim 1 · round 1 of 3 · updated just now');
    // A merge with no check in flight still names no M.
    expect(detail({ kind: 'LAND_PROMOTION', phase: 'PUSH', check: null }))
      .toBe('pushing · output 6s ago · claim 1 · round 1 · updated just now');
  });

  it('names the takeover and the first start the timeline still carries', () => {
    const timeline = {
      sections: [section({
        entries: [
          entry({ id: 'c1', kind: 'CLAIMED', at: at(17, 3), claim: 1 }),
          entry({ id: 'c2', kind: 'TAKEN_OVER', at: at(17, 31), claim: 2 }),
        ],
      })],
      facts: [],
      truncated: false,
    };
    const card = landingAttemptCard(
      landing({
        timeline,
        currentAttempt: attempt({ claim: 2, startedAt: at(17, 31), heartbeatAt: at(17, 36) }),
      }),
      new Date(2026, 8, 25, 17, 36, 30).getTime(),
      { updatedAt: new Date(2026, 8, 25, 17, 36, 30).getTime() },
    )!;
    expect(card.detail).toContain(`Taken over ${landingClockTime(at(17, 31))} · `
      + `first started ${landingClockTime(at(17, 3))}`);
  });

  it('says Update unavailable when this device cannot read, and freezes the clock', () => {
    const card = landingAttemptCard(landing(), NOW, { updatedAt: NOW - 91_000 }, {})!;
    expect(card.state).toBe(LANDING_PAGE_COPY.UPDATE_UNAVAILABLE);
    expect(card.detail).toBe(LANDING_PAGE_COPY.UPDATE_UNAVAILABLE);
    expect(card.running).toBe(false);
    expect(card.live).toBe('Updated 1m ago');
    const failed = landingAttemptCard(landing(), NOW, { updatedAt: NOW, failed: true })!;
    expect(failed.detail).toBe(LANDING_PAGE_COPY.UPDATE_UNAVAILABLE);
  });
});

describe('the card of an attempt that has ended: only a stopped one says it stopped', () => {
  const ended = (over: Partial<SessionLandingAttempt>, view: Partial<SessionLandingView> = {}) =>
    landingAttemptCard(
      landing({ ...view, currentAttempt: attempt({ phase: null, check: null, liveness: null, ...over }) }),
      NOW,
      { updatedAt: NOW },
    )!;
  const round = { subject: 'PROMOTION' as const, taskId: null, promotionId: 'promo-1' };

  it('a merge check that ended READY passed and waits for the owner: no failure line', () => {
    const card = ended({ kind: 'CHECK_PROMOTION', state: 'READY' }, round);
    expect(card.word).toBe('Merge check');
    expect(card.state).toBe('Ready');
    expect(card.right).toBe('Ready');
    expect(card.detail).toBe('Passed the check · waiting for the owner');
    expect(card.failure).toBeNull();
    expect(card.running).toBe(false);
  });

  it('a cancelled attempt really stopped, and still says Stopped · not landed', () => {
    const task = ended({ state: 'CANCELLED' });
    expect(task.right).toBe('Not landed');
    expect(task.failure).toBe('Stopped · not landed');
    // The merge check's own kind does not hide it: only its READY does.
    const check = ended({ kind: 'CHECK_PROMOTION', state: 'CANCELLED' }, round);
    expect(check.right).toBe('Not merged');
    expect(check.failure).toBe('Stopped · not landed');
  });

  it('a check that failed, a conflict or an error stopped on a failure: the head wears the red ✕ (board 02 d)', () => {
    expect(LANDING_FAILURE_STATES).toEqual(['CHECK_FAILED', 'CONFLICT', 'ERROR']);
    const failedCheck = { name: 'TASK_ACCEPTANCE', exitCode: 1, expectedExitCode: 0, timedOut: false, durationMs: 232_000 };
    const checkFailed = ended({ state: 'CHECK_FAILED' }, { checks: [failedCheck] });
    expect(checkFailed.right).toBe('Not landed');
    expect(checkFailed.stoppedOnFailure).toBe(true);
    expect(ended({ state: 'CONFLICT' }).stoppedOnFailure).toBe(true);
    expect(ended({ state: 'ERROR' }).stoppedOnFailure).toBe(true);
    expect(ended({ kind: 'CHECK_PROMOTION', state: 'CHECK_FAILED' }, round).stoppedOnFailure).toBe(true);
    // The attempt's state decides it, never its sentence: a failed attempt with no check record says
    // only `Stopped · not landed` and is still a failure; a cancelled one beside a failed check is not.
    expect(ended({ state: 'CHECK_FAILED' }).detail).toBe('Stopped · not landed');
    expect(ended({ state: 'CHECK_FAILED' }).stoppedOnFailure).toBe(true);
    expect(ended({ state: 'CANCELLED' }, { checks: [failedCheck] }).stoppedOnFailure).toBe(false);
  });

  it('every other ending, and work in hand, keeps the quiet head', () => {
    expect(ended({ state: 'CANCELLED' }).stoppedOnFailure).toBe(false);
    expect(ended({ kind: 'CHECK_PROMOTION', state: 'READY' }, round).stoppedOnFailure).toBe(false);
    expect(landingAttemptCard(landing(), NOW, { updatedAt: NOW })!.stoppedOnFailure).toBe(false);
    expect(landingAttemptCard(landing({ currentAttempt: attempt({ state: 'QUEUED', claim: 0 }) }), NOW,
      { updatedAt: NOW })!.stoppedOnFailure).toBe(false);
    expect(landingAttemptCard(landing({ currentAttempt: attempt({ timedOut: true, liveness: 'LEASE_EXPIRED' }) }), NOW,
      { updatedAt: NOW })!.stoppedOnFailure).toBe(false);
  });
});

describe('a stop that has been asked for and not answered (J-T8 / M-T10)', () => {
  const asked = {
    sections: [section({
      entries: [
        entry({ id: 'c', kind: 'CLAIMED', claim: 1 }),
        entry({ id: 's', kind: 'STOP_REQUESTED', claim: 1, text: 'Stop requested · claim 1' }),
      ],
    })],
    facts: [],
    truncated: false,
  };

  it('says Cancelling in the card and stops offering the door again', () => {
    const view = landing({ timeline: asked });
    expect(landingCancelling(view)).toBe(true);
    expect(landingAttemptCard(view, NOW, { updatedAt: NOW })!.state).toBe('Cancelling');
    expect(landingGates(view, { updatedAt: NOW }, NOW).stop).toBe(false);
  });

  it('the ask belongs to the claim it names: a takeover starts clean', () => {
    const view = landing({ timeline: asked, currentAttempt: attempt({ claim: 2 }) });
    expect(landingCancelling(view)).toBe(false);
    expect(landingGates(view, { updatedAt: NOW }, NOW).stop).toBe(true);
  });
});

describe('J12: what a timed-out attempt can say about the push', () => {
  const timed = attempt({ liveness: 'LEASE_EXPIRED', timedOut: true, phase: 'REBASE' });

  it('a v2 claim with no PUSH report proves nothing was pushed', () => {
    expect(landingPushSentence(landing({ currentAttempt: timed }), timed))
      .toBe(LANDING_PAGE_COPY.NOTHING_PUSHED_SENTENCE);
  });

  it('a legacy claim may have been pushed', () => {
    const legacy = { ...timed, progressProtocol: null };
    expect(landingPushSentence(landing({ currentAttempt: legacy }), legacy))
      .toBe(LANDING_PAGE_COPY.MAY_HAVE_PUSHED_SENTENCE);
  });

  it('a report that named the push says so, with its time', () => {
    const pushed = { ...timed, phase: 'PUSH' as const };
    const timeline = {
      sections: [section({ entries: [entry({ id: 'p', kind: 'STEP', phase: 'PUSH', at: at(15, 42) })] })],
      facts: [], truncated: false,
    };
    const view = landing({ currentAttempt: pushed, timeline });
    expect(landingPushSentence(view, pushed))
      .toBe(LANDING_PAGE_COPY.MAY_HAVE_PUSHED_AT(landingClockTime(at(15, 42))));
  });

  it('a merge check writes no push sentence at all (owner 2026-10-19)', () => {
    const check = attempt({ kind: 'CHECK_PROMOTION', phase: 'CHECK', liveness: 'LEASE_EXPIRED', timedOut: true });
    // A check never pushes, so a sentence about one is noise on a card that already says where the
    // runner stopped — the facts line stays, the push line does not.
    expect(landingPushSentence(landing({ subject: 'PROMOTION', currentAttempt: check }), check)).toBeNull();
    expect(landingTimeoutLine(landing({ subject: 'PROMOTION', currentAttempt: check }), check))
      .toContain('stopped at checking');
  });

  it('ends the section with the runner’s silence as the band words it', () => {
    const timed = attempt({ liveness: 'LEASE_EXPIRED', timedOut: true, heartbeatAt: at(14, 35, 30) });
    expect(landingNoReportBand(landing({ currentAttempt: timed }))).toEqual({
      text: `No report from wikova since ${landingClockTime(at(14, 35, 30))}`,
      at: at(14, 35, 30),
    });
    expect(landingNoReportBand(landing())).toBeNull();
  });

  it('names who took the attempt, when, where it stopped and the claim', () => {
    const view = landing({ currentAttempt: timed });
    expect(landingTimeoutLine(view, timed))
      .toBe(`Runner wikova took it at ${landingClockTime(STEP)} · stopped at rebasing · claim 1 · round 1 of 3`);
    // The M is the kind's, not the check's: a task's landing with one check is still "of 3", and a
    // merge into main, which has one round per claim, names none.
    const one = { ...timed, check: { name: 'TASK_ACCEPTANCE' as const, index: 1, count: 1, budgetSeconds: 3_600, startedAt: STEP } };
    expect(landingTimeoutLine(landing({ currentAttempt: one }), one)).toMatch(/ · claim 1 · round 1 of 3$/);
    const merge = { ...timed, kind: 'LAND_PROMOTION' as const, phase: 'PUSH' as const };
    expect(landingTimeoutLine(landing({ subject: 'PROMOTION', currentAttempt: merge }), merge))
      .toBe(`Runner wikova took it at ${landingClockTime(STEP)} · stopped at pushing · claim 1 · round 1`);
  });
});

describe('the owner doors the landing view’s facts open (LS6)', () => {
  const gates = (view: SessionLandingView, observation = { updatedAt: NOW }) =>
    landingGates(view, observation, NOW);

  it('a running task landing offers Stop, and offers nothing else', () => {
    expect(gates(landing())).toEqual({
      stop: true, cancel: false, abandon: false, retry: false, recheck: false,
    });
  });

  it('past the push boundary, Stop disappears — on the server’s fact alone', () => {
    // `pushBoundaryPassed` is J-T4's boundary as the server computed it. The page does not read a
    // phase or a timeline line to decide this: a phase of PUSH with the server saying the claim has
    // not passed keeps the door open, and the server's true closes it whatever the phase says.
    expect(gates(landing({ currentAttempt: attempt({ pushBoundaryPassed: true }) })).stop).toBe(false);
    expect(gates(landing({ currentAttempt: attempt({ phase: 'PUSH' }) })).stop).toBe(true);
  });

  it('a merge round offers Cancel while its merge job is before the push', () => {
    const merge = attempt({ kind: 'LAND_PROMOTION', phase: 'CHECK' });
    const view = landing({ subject: 'PROMOTION', promotionId: 'promo-1', currentAttempt: merge });
    expect(gates(view)).toEqual({
      stop: false, cancel: true, abandon: false, retry: false, recheck: false,
    });
  });

  it('a lease-expired LAND_TASK offers only Abandon and the server’s Retry', () => {
    const timed = attempt({ liveness: 'LEASE_EXPIRED', timedOut: true, retryable: true });
    expect(gates(landing({ currentAttempt: timed }))).toEqual({
      stop: false, cancel: false, abandon: true, retry: true, recheck: false,
    });
  });

  it('a lease-expired CHECK_PROMOTION offers Abandon and Re-run the check', () => {
    const timed = attempt({ kind: 'CHECK_PROMOTION', liveness: 'LEASE_EXPIRED', timedOut: true, retryable: false });
    expect(gates(landing({ subject: 'PROMOTION', promotionId: 'promo-1', currentAttempt: timed }))).toEqual({
      stop: false, cancel: false, abandon: true, retry: false, recheck: true,
    });
  });

  it('a lease-expired LAND_PROMOTION has no Retry and no Cancel — only Abandon', () => {
    const timed = attempt({ kind: 'LAND_PROMOTION', liveness: 'LEASE_EXPIRED', timedOut: true, retryable: false });
    expect(gates(landing({ subject: 'PROMOTION', promotionId: 'promo-1', currentAttempt: timed }))).toEqual({
      stop: false, cancel: false, abandon: true, retry: false, recheck: false,
    });
  });

  it('opens nothing when this device cannot read the server, or once settled', () => {
    expect(gates(landing(), { updatedAt: NOW - 90_001 })).toEqual({
      stop: false, cancel: false, abandon: false, retry: false, recheck: false,
    });
    expect(gates(landing(), { updatedAt: NOW, failed: true })).toEqual({
      stop: false, cancel: false, abandon: false, retry: false, recheck: false,
    });
    expect(gates(landing({ settledAt: at(9, 51), settledAs: 'LANDED' }))).toEqual({
      stop: false, cancel: false, abandon: false, retry: false, recheck: false,
    });
  });
});

describe('the ⋯ menu', () => {
  const labels = (view: SessionLandingView, gates = landingGates(view, { updatedAt: NOW }, NOW)) =>
    landingMenuItemList(view, gates, {
      hasCoordinator: true,
      hasReview: true,
      nothingPushed: view.currentAttempt?.kind === 'CHECK_PROMOTION'
        || (view.currentAttempt?.timedOut === true
          && landingPushSentence(view, view.currentAttempt) === LANDING_PAGE_COPY.NOTHING_PUSHED_SENTENCE),
    });

  it('a running task landing has Open Task, Open Source Session, Open Coordinator and Stop Landing', () => {
    expect(labels(landing()).map((item) => item.action)).toEqual([
      'OPEN_TASK', 'OPEN_SOURCE_SESSION', 'OPEN_COORDINATOR', 'STOP',
    ]);
    const stop = labels(landing()).find((item) => item.action === 'STOP')!;
    expect(stop.sub).toBe('Before the push only · nothing pushed yet');
    expect(stop.danger).toBe(true);
  });

  it('a merge round has Review Card and Cancel Merge, and no Stop Landing', () => {
    const merge = landing({
      subject: 'PROMOTION',
      promotionId: 'promo-1',
      currentAttempt: attempt({ kind: 'LAND_PROMOTION', phase: 'CHECK' }),
    });
    const actions = labels(merge).map((item) => item.action);
    expect(actions).toContain('REVIEW_CARD');
    expect(actions).toContain('CANCEL');
    expect(actions).not.toContain('STOP');
  });

  it('a lease-expired task landing gives Abandon and Retry, never a Copy Link', () => {
    const timed = landing({
      currentAttempt: attempt({ liveness: 'LEASE_EXPIRED', timedOut: true, retryable: true }),
    });
    const items = labels(timed);
    const actions = items.map((item) => item.action);
    expect(actions).toContain('ABANDON');
    expect(actions).toContain('RETRY');
    expect(actions).not.toContain('STOP');
    expect(items.find((item) => item.action === 'ABANDON')!.sub).toBe('Ends this attempt · nothing was pushed');
    expect(items.map((item) => item.label)).not.toContain('Copy Link');
  });

  it('a lease-expired check gives Re-run the check and Abandon', () => {
    const timed = landing({
      subject: 'PROMOTION',
      promotionId: 'promo-1',
      currentAttempt: attempt({ kind: 'CHECK_PROMOTION', liveness: 'LEASE_EXPIRED', timedOut: true }),
    });
    const items = labels(timed);
    const actions = items.map((item) => item.action);
    expect(actions).toContain('RERUN_THE_CHECK');
    expect(actions).toContain('ABANDON');
    expect(actions).not.toContain('RETRY');
    // A check never pushes: its Abandon ends an attempt that provably never reached main, even
    // though no push sentence is written on the card for it.
    expect(items.find((item) => item.action === 'ABANDON')!.sub).toBe('Ends this attempt · nothing was pushed');
  });
});

describe('the title a landing goes by', () => {
  it('titles a linked landing with its server title, and a pre-row one from the view', () => {
    expect(landingHeaderTitle(landing(), 'Land · Ledger migration order')).toBe('Land · Ledger migration order');
    expect(landingHeaderTitle(landing(), null, 'Ledger migration order')).toBe('Land · Ledger migration order');
    const round = landing({ subject: 'PROMOTION', taskId: null, promotionId: 'p', episode: 7 });
    expect(landingHeaderTitle(round, null)).toMatch(/^Merge project .+ → main · #7$/);
  });
});

/** The receipt a Merged into main row opens to in the Landings window (board 03 e). */
describe('a merge row’s receipt', () => {
  const round = landing({
    subject: 'PROMOTION', taskId: null, promotionId: 'promo-1', settledAt: at(9, 51), settledAs: 'MERGED',
    checks: [{ name: 'MERGE_CHECK', exitCode: 0, expectedExitCode: 0, timedOut: false, durationMs: 17 * 60_000 + 41_000 }],
  });

  it('says what is now on main, the check that passed on the combined tree, and the tree that landed', () => {
    expect(landingMergeReceipt(promotion(), round)).toEqual({
      heading: 'Now on main · 2 tasks',
      tasks: ['Ledger migration order', 'Payout retry budget'],
      checkLine: '✓ Passed on the combined tree · 17m 41s',
      treeLine: 'Landed exactly the tested tree 5e5bfca · as a merge commit',
    });
  });

  it('reads the record’s own checks first, and the record alone for a merge older than landing sessions', () => {
    const recorded = promotion({
      checks: [{ name: 'MERGE_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 0, timedOut: false, durationMs: 9 * 60_000 }],
      landsAs: 'FAST_FORWARD',
    } as Partial<ProjectPromotionView>);
    expect(landingMergeReceipt(recorded, round).checkLine).toBe('✓ Passed on the combined tree · 9m 00s');
    expect(landingMergeReceipt(recorded, null)).toEqual({
      heading: 'Now on main · 2 tasks',
      tasks: ['Ledger migration order', 'Payout retry budget'],
      checkLine: '✓ Passed on the combined tree · 9m 00s',
      treeLine: 'Landed exactly the tested tree 5e5bfca · by fast-forward',
    });
  });

  it('keeps to what the landing view has for a round past the read’s 20 records', () => {
    expect(landingMergeReceipt(null, round)).toEqual({
      heading: 'Now on main',
      tasks: [],
      checkLine: '✓ Passed on the combined tree · 17m 41s',
      treeLine: null,
    });
  });
});

describe('the settled round is the outcome', () => {
  it('draws the merged head, the tasks now on main, the check and the tested tree', () => {
    const outcome = landingOutcomeCard(
      landing({
        subject: 'PROMOTION',
        taskId: null,
        promotionId: 'promo-1',
        settledAt: at(9, 51),
        settledAs: 'MERGED',
        checks: [{ name: 'MERGE_CHECK', exitCode: 0, expectedExitCode: 0, timedOut: false, durationMs: 17 * 60_000 + 41_000 }],
      }),
      promotion(),
    )!;
    expect(outcome.title).toBe('Merged into main');
    expect(outcome.right).toBe(landingClockTime(at(9, 51)));
    expect(outcome.detail).toBe('8ed0ea7 · 2 tasks · automatically');
    expect(outcome.tasksHeading).toBe('Now on main · 2 tasks');
    expect(outcome.tasks).toEqual(['Ledger migration order', 'Payout retry budget']);
    expect(outcome.checkLine).toBe('✓ Passed on the combined tree · 17m 41s');
    expect(outcome.treeLine).toBe('Landed exactly the tested tree 5e5bfca · as a merge commit');
  });

  it('lands a task segment on its own branch word', () => {
    const outcome = landingOutcomeCard(
      landing({ settledAt: at(11, 7), settledAs: 'LANDED' }),
      null,
    )!;
    expect(outcome.title).toBe('Landed');
    expect(outcome.detail).toBe('Landed on project/p1');
  });

  it('spells a duration in minutes and seconds at every length', () => {
    expect(landingDuration(17 * 60_000 + 41_000)).toBe('17m 41s');
    expect(landingDuration(3_600_000 + 5 * 60_000)).toBe('1h 05m');
  });
});

describe('the timeline’s ✓ reads the line’s fields, not its sentence', () => {
  const finished = (data: Record<string, unknown> | null, text = 'Merge check passed · 17m 02s') => entry({
    kind: 'CHECK_FINISHED',
    check: { name: 'MERGE_CHECK', index: 1 },
    phase: 'CHECK',
    data,
    text,
  });
  const result = (state: string | null, text: string, kind: 'RESULT' | 'RESULT_FALLBACK' = 'RESULT') => entry({
    kind,
    data: state == null ? null : { state },
    text,
  });

  it('a check passed when it exited with the code it expected and did not time out', () => {
    expect(landingCheckPassed(finished({ exitCode: 0, expectedExitCode: 0, timedOut: false }))).toBe(true);
    expect(landingCheckPassed(finished({ exitCode: 3, expectedExitCode: 3, timedOut: false }))).toBe(true);
    expect(landingCheckPassed(finished({ exitCode: 1, expectedExitCode: 0, timedOut: false }))).toBe(false);
    expect(landingCheckPassed(finished({ exitCode: 0, expectedExitCode: 0, timedOut: true }))).toBe(false);
    // No exit code is not a pass, and neither is a line with no fields at all.
    expect(landingCheckPassed(finished({ exitCode: null, expectedExitCode: 0, timedOut: false }))).toBe(false);
    expect(landingCheckPassed(finished(null))).toBe(false);
    expect(landingCheckPassed(finished({}))).toBe(false);
  });

  it('the wording changed, the ✓ did not', () => {
    const green = finished({ exitCode: 0, expectedExitCode: 0, timedOut: false }, 'Merge check green · 17m 02s');
    expect(landingCheckPassed(green)).toBe(true);
    expect(landingEntryOk(green, 'LAND_TASK')).toBe(true);
    const saysPassed = finished({ exitCode: 1, expectedExitCode: 0, timedOut: false }, 'Merge check passed · 3m 52s');
    expect(landingCheckPassed(saysPassed)).toBe(false);
    expect(landingEntryOk(saysPassed, 'LAND_TASK')).toBe(false);
    expect(landingEntryOk(result('LANDED', 'Put on main · 8ed0ea7'), 'LAND_TASK')).toBe(true);
    expect(landingEntryOk(result('ALREADY_LANDED', 'Was on main · 8ed0ea7'), 'LAND_TASK')).toBe(true);
    expect(landingEntryOk(result('NOTHING_TO_LAND', 'No commits to push'), 'LAND_TASK')).toBe(true);
    expect(landingEntryOk(
      result('NOTHING_TO_LAND', 'Nothing to push · the branch carried no commits', 'RESULT_FALLBACK'), 'LAND_TASK',
    )).toBe(true);
  });

  it('every other result is ✗, whatever a branch name in it says', () => {
    expect(landingEntryOk(result('READY', 'Ready to merge into fix/passed-x'), 'LAND_TASK')).toBe(false);
    expect(landingEntryOk(result('CONFLICT', 'Could not sync main into fix/passed-x · merge conflict'), 'LAND_TASK'))
      .toBe(false);
    expect(landingEntryOk(result('CHECK_FAILED', 'Check failed · nothing was pushed'), 'LAND_TASK')).toBe(false);
    expect(landingEntryOk(result('ERROR', 'Stopped with an error · PUSH_FAILED'), 'LAND_TASK')).toBe(false);
    expect(landingEntryOk(result('CANCELLED', 'Stopped · not landed'), 'LAND_TASK')).toBe(false);
    expect(landingEntryOk(result('SUPERSEDED', 'Superseded · a newer attempt asks the same question'), 'LAND_TASK'))
      .toBe(false);
    expect(landingEntryOk(result(null, 'Landed on main · 8ed0ea7'), 'LAND_TASK')).toBe(false);
    expect(landingEntryOk(result(null, 'Landed on main · 8ed0ea7', 'RESULT_FALLBACK'), 'LAND_TASK')).toBe(false);
  });

  it('a merge check that ends READY passed; a merge to main that answers READY merged nothing', () => {
    // The section's job kind decides, beside the line's state: never the sentence.
    expect(landingEntryOk(result('READY', 'Ready to merge into main'), 'CHECK_PROMOTION')).toBe(true);
    expect(landingEntryOk(result('READY', 'Ready to merge into main', 'RESULT_FALLBACK'), 'CHECK_PROMOTION'))
      .toBe(true);
    expect(landingEntryOk(result('READY', 'Checked · the merge is yours to make'), 'CHECK_PROMOTION')).toBe(true);
    // A merge to main that answers READY handed the candidate back to be checked again (M-T12, J-T13).
    expect(landingEntryOk(result('READY', 'Ready to merge into main'), 'LAND_PROMOTION')).toBe(false);
    expect(landingEntryOk(result('READY', 'Ready to merge into main'), 'LAND_TASK')).toBe(false);
    // The merge check's other answers keep their marks.
    expect(landingEntryOk(result('ALREADY_LANDED', 'Already on main · 8ed0ea7'), 'CHECK_PROMOTION')).toBe(true);
    expect(landingEntryOk(result('CHECK_FAILED', 'Check failed · nothing was pushed'), 'CHECK_PROMOTION')).toBe(false);
    expect(landingEntryOk(result('CONFLICT', 'Could not merge · conflict'), 'CHECK_PROMOTION')).toBe(false);
    expect(landingEntryOk(result(null, 'Ready to merge into main'), 'CHECK_PROMOTION')).toBe(false);
  });

  it('no other kind of line is a check or a result', () => {
    expect(landingCheckPassed(entry({ kind: 'RESULT', data: { exitCode: 0, expectedExitCode: 0, timedOut: false } })))
      .toBe(false);
    expect(landingEntryOk(entry({ kind: 'CLAIMED', data: { state: 'LANDED' }, text: 'Landed on main' }), 'LAND_TASK'))
      .toBe(false);
    expect(landingEntryOk(entry({ kind: 'CLAIMED', data: { state: 'READY' }, text: 'Ready' }), 'CHECK_PROMOTION'))
      .toBe(false);
  });
});
