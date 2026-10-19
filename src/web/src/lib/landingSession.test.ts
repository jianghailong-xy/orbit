import { describe, expect, it } from 'vitest';
import type {
  IntegrationTimelineEntry,
  IntegrationTimelineSection,
  ProjectPromotionView,
  SessionLandingAttempt,
  SessionLandingView,
} from '@orbit/shared';
import {
  LANDING_PAGE_COPY,
  landingAttemptCard,
  landingDuration,
  landingFooter,
  landingGates,
  landingHeaderSub,
  landingHeaderTitle,
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
  const kinds: Array<[SessionLandingAttempt['kind'], string]> = [
    ['LAND_TASK', 'Landing'],
    ['CHECK_PROMOTION', 'Merge check'],
    ['LAND_PROMOTION', 'Merge to main'],
  ];

  it.each(kinds)('draws %s’s LIVE head and V6 rows', (kind, word) => {
    const card = landingAttemptCard(landing({ currentAttempt: attempt({ kind }) }), NOW, { updatedAt: NOW })!;
    expect(card.word).toBe(word);
    expect(card.state).toBe('checking');
    expect(card.right).toBe('1m 50s of 60m');
    expect(card.detail).toBe('checking · output 6s ago · claim 1 · round 1 of 3 · updated just now');
    expect(card.budget).toBe('Merge check 1m 50s of 60m');
    expect(card.live).toBe('Output 6s ago · Updated just now');
    expect(card.running).toBe(true);
  });

  it.each(kinds)('QUIET for %s: the heartbeat is fresh and the output is not', (kind, word) => {
    const card = landingAttemptCard(
      landing({ currentAttempt: attempt({ kind, liveness: 'QUIET', outputMovedAt: at(14, 44, 30) }) }),
      NOW,
      { updatedAt: NOW },
    )!;
    expect(card.word).toBe(word);
    expect(card.detail).toBe(
      'checking · no output for 14m · within its 60m budget · claim 1 · round 1 of 3 · updated just now',
    );
    expect(card.live).toBe('No output for 14m · within its 60m budget · Updated just now');
    expect(card.running).toBe(true);
  });

  it.each(kinds)('SILENT for %s: the clock freezes at the runner’s last word', (kind, word) => {
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
    expect(card.detail).toBe('checking · no word from runner wikova for 4m · claim 1 · round 1 of 3');
    expect(card.live).toBe('No word from runner wikova for 4m');
    expect(card.right).toBe('5m 0s of 60m');
  });

  it.each(kinds)('LEGACY for %s: reports only between steps, and no silence is inferred', (kind, word) => {
    const card = landingAttemptCard(
      landing({
        currentAttempt: attempt({ kind, liveness: 'LEGACY', heartbeatAt: at(14, 46, 30), progressProtocol: null }),
      }),
      NOW,
      { updatedAt: NOW },
    )!;
    expect(card.word).toBe(word);
    expect(card.detail).toBe(
      'checking · reports only between steps · claim 1 · round 1 of 3 · updated 12m ago',
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

  it('a merge check never pushes and says only that', () => {
    const check = attempt({ kind: 'CHECK_PROMOTION', phase: 'CHECK', liveness: 'LEASE_EXPIRED', timedOut: true });
    expect(landingPushSentence(landing({ subject: 'PROMOTION', currentAttempt: check }), check))
      .toBe(LANDING_PAGE_COPY.CHECK_PUSHES_NOTHING_SENTENCE);
  });

  it('names who took the attempt, when, where it stopped and the claim', () => {
    const view = landing({ currentAttempt: timed });
    expect(landingTimeoutLine(view, timed))
      .toBe(`Runner wikova took it at ${landingClockTime(STEP)} · stopped at rebasing · claim 1 · round 1 of 3`);
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

  it('past the push boundary, Stop disappears', () => {
    expect(gates(landing({ currentAttempt: attempt({ phase: 'PUSH' }) })).stop).toBe(false);
    expect(gates(landing({ currentAttempt: attempt({ phase: 'VERIFY' }) })).stop).toBe(false);
    const pushedTimeline = {
      sections: [section({ entries: [entry({ kind: 'STEP', phase: 'PUSH' })] })],
      facts: [], truncated: false,
    };
    expect(gates(landing({ currentAttempt: attempt({ phase: 'CHECK' }), timeline: pushedTimeline })).stop)
      .toBe(false);
  });

  it('a merge round offers Cancel while its merge job is before the push', () => {
    const merge = attempt({ kind: 'LAND_PROMOTION', phase: 'CHECK' });
    const view = landing({ subject: 'PROMOTION', promotionId: 'promo-1', currentAttempt: merge });
    expect(gates(view)).toEqual({
      stop: false, cancel: true, abandon: false, retry: false, recheck: false,
    });
  });

  it('a lease-expired LAND_TASK offers only Abandon and the server’s Retry', () => {
    const timed = attempt({ liveness: 'LEASE_EXPIRED', timedOut: true });
    expect(gates(landing({ currentAttempt: timed }))).toEqual({
      stop: false, cancel: false, abandon: true, retry: true, recheck: false,
    });
  });

  it('a lease-expired CHECK_PROMOTION offers Abandon and Re-run the check', () => {
    const timed = attempt({ kind: 'CHECK_PROMOTION', liveness: 'LEASE_EXPIRED', timedOut: true });
    expect(gates(landing({ subject: 'PROMOTION', promotionId: 'promo-1', currentAttempt: timed }))).toEqual({
      stop: false, cancel: false, abandon: true, retry: false, recheck: true,
    });
  });

  it('a lease-expired LAND_PROMOTION has no Retry and no Cancel — only Abandon', () => {
    const timed = attempt({ kind: 'LAND_PROMOTION', liveness: 'LEASE_EXPIRED', timedOut: true });
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
      pushSentence: view.currentAttempt?.timedOut
        ? landingPushSentence(view, view.currentAttempt)
        : null,
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
      currentAttempt: attempt({ liveness: 'LEASE_EXPIRED', timedOut: true }),
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
    const actions = labels(timed).map((item) => item.action);
    expect(actions).toContain('RERUN_THE_CHECK');
    expect(actions).toContain('ABANDON');
    expect(actions).not.toContain('RETRY');
  });
});

describe('the header and the read-only footer', () => {
  it('titles a linked landing with its server title, and a pre-row one from the view', () => {
    expect(landingHeaderTitle(landing(), 'Land · Ledger migration order')).toBe('Land · Ledger migration order');
    expect(landingHeaderTitle(landing(), null, 'Ledger migration order')).toBe('Land · Ledger migration order');
    const round = landing({ subject: 'PROMOTION', taskId: null, promotionId: 'p', episode: 7 });
    expect(landingHeaderTitle(round, null)).toMatch(/^Merge project .+ → main · #7$/);
  });

  it('names the runner while it runs and the settlement once it has settled', () => {
    expect(landingHeaderSub(landing())).toBe('Run by Orbit · runner wikova');
    expect(landingHeaderSub(landing({ settledAt: at(9, 51), settledAs: 'LANDED' })))
      .toBe(`Run by Orbit · settled ${landingClockTime(at(9, 51))}`);
  });

  it('points a task segment at the coordinator, a round at its card, and a settled one at nothing', () => {
    expect(landingFooter(landing(), null)).toMatchObject({
      line: 'Orbit runs this landing — nothing to type here.',
      detail: 'Decisions: the coordinator',
      link: 'COORDINATOR',
    });
    const round = landing({ subject: 'PROMOTION' });
    expect(landingFooter(round, 'MERGE').detail).toBe('A clean pass merges on its own');
    expect(landingFooter(round, 'ASK').detail).toBe('Merging is decided on the merge card');
    expect(landingFooter(round, null)).toMatchObject({
      detail: 'Merging is decided on the merge card',
      link: 'REVIEW_CARD',
    });
    const settled = landing({ subject: 'PROMOTION', episode: 9, settledAt: at(9, 51), settledAs: 'MERGED' });
    expect(landingFooter(settled, null)).toMatchObject({
      line: 'This landing is complete — nothing to type here.',
      link: null,
      next: 'The next merge into main opens a new landing (#10).',
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
