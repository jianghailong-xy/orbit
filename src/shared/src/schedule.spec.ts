import { describe, expect, it } from 'vitest';
import { sessionOriginTag } from './driveChat';
import {
  SCHEDULE_PAGE_CHAT_COPY,
  SCHEDULE_RUN_STATES,
  type ScheduleCreateCard,
  type ScheduleListRow,
  type ScheduleRunState,
  type ScheduleRunView,
  scheduleApprovalWaiting,
  scheduleCircle,
  scheduleCreateWhen,
  scheduleFailedWaiting,
  scheduleHeldWaiting,
  scheduleNeedsCount,
  scheduleNeedsYou,
  schedulePageChatOpening,
  scheduleReportedText,
  scheduleRowCircle,
  scheduleRenamedText,
  scheduleRowLine,
  scheduleRunCircle,
  scheduleRunLine,
  scheduleRunOfText,
  scheduleRuleRepeats,
  scheduleRuleText,
  scheduleRunStripText,
  scheduleTimeline,
  scheduleWhenText,
} from './schedule';

// The boards' demo day: Friday Nov 14, 12:19 in Asia/Shanghai (UTC+8, no DST).
const TZ = 'Asia/Shanghai';
const NOW = new Date('2025-11-14T04:19:00.000Z');
/** An instant from a Shanghai wall clock. */
const sh = (local: string) => new Date(`${local}:00.000+08:00`).toISOString();

let seq = 0;
function schedule(over: Partial<ScheduleListRow> = {}): ScheduleListRow {
  seq += 1;
  return {
    id: `s${seq}`,
    title: `Schedule ${seq}`,
    intent: 'intent',
    prompt: 'prompt',
    rule: { kind: 'DAILY', time: '09:00' },
    ruleText: 'Daily 09:00',
    timezone: TZ,
    workspaceId: 'w1',
    workspaceName: 'apiserver',
    agentId: null,
    accessLevel: 'CHECK_ONLY',
    may: '',
    runLimitMinutes: 30,
    runsPerWeek: 7,
    envelope: { workspaceId: 'w1', accessLevel: 'CHECK_ONLY', runsPerWeek: 7, runLimitMinutes: 30 },
    state: 'ACTIVE',
    heldReason: null,
    endedReason: null,
    note: null,
    revision: 1,
    startAt: sh('2025-11-01T00:00'),
    endAt: null,
    nextDueAt: null,
    consecutiveFailures: 0,
    createdFromSessionId: null,
    createdAt: sh('2025-11-01T00:00'),
    endedAt: null,
    lastRun: null,
    ...over,
  };
}

function run(s: ScheduleListRow, state: ScheduleRunState, plannedAt: string, over: Partial<ScheduleRunView> = {}): ScheduleRunView {
  return {
    id: `r-${s.id}-${plannedAt}`,
    scheduleId: s.id,
    scheduleRevision: 1,
    plannedAt,
    trigger: 'SCHEDULED',
    state,
    attempt: 1,
    startedAt: plannedAt,
    endedAt: null,
    sessionId: null,
    key: null,
    summary: null,
    links: [],
    failureReason: null,
    heldReason: null,
    ...over,
  };
}

const names = (groups: ReturnType<typeof scheduleTimeline>) =>
  groups.map((g) => [g.title, g.subtitle, g.items.map((i) => (i.kind === 'DRAFT' ? i.card.title : i.schedule.title))]);

describe('scheduleTimeline', () => {
  it('lays out board 1/2 ①: Today, Tomorrow, Monday, Paused — no group of errors (owner 2026-11-19)', () => {
    const sweep = schedule({ title: 'Nightly pg spec sweep', consecutiveFailures: 3, nextDueAt: sh('2025-11-15T02:00') });
    const audit = schedule({ title: 'Weekly dependency audit', state: 'HELD', heldReason: 'AGENT_DISABLED' });
    const docs = schedule({ title: 'Docs link check', nextDueAt: sh('2025-11-15T12:00') });
    const notes = schedule({ title: 'Release notes draft', nextDueAt: sh('2025-11-14T17:00') });
    const deploy = schedule({ title: 'Deploy health check', rule: { kind: 'ONCE', at: '2025-11-14T18:00' }, nextDueAt: sh('2025-11-14T18:00') });
    const codex = schedule({ title: 'Codex stable check', nextDueAt: sh('2025-11-15T09:00') });
    const cost = schedule({ title: 'Weekly cost report', nextDueAt: sh('2025-11-17T10:00') });
    const csp = schedule({ title: 'Gateway CSP report digest', state: 'PAUSED' });
    const gone = schedule({ title: 'Ended one', state: 'ENDED', nextDueAt: null });
    const groups = scheduleTimeline({
      schedules: [sweep, audit, docs, notes, deploy, codex, cost, csp, gone],
      runs: [run(docs, 'RUNNING', sh('2025-11-14T12:00'))],
      now: NOW,
      timezone: TZ,
    });
    expect(names(groups)).toEqual([
      ['Today', 'Fri, Nov 14', ['Docs link check', 'Release notes draft', 'Deploy health check']],
      ['Tomorrow', 'Sat, Nov 15', ['Nightly pg spec sweep', 'Codex stable check', 'Docs link check']],
      ['Monday', 'Nov 17', ['Weekly cost report']],
      // A held schedule has no next run: it is listed with the paused ones, before them.
      ['Paused', '2', ['Weekly dependency audit', 'Gateway CSP report digest']],
    ]);
    expect(groups.map((g) => g.key)).toEqual(['TODAY', 'TOMORROW', 'DAY', 'PAUSED']);
    expect(groups[0]!.items[0]!.kind).toBe('RUN');
  });

  it('splits at local midnight, not at UTC midnight', () => {
    // 23:30 and 00:30 Shanghai are 15:30Z and 16:30Z on the same UTC day.
    const late = schedule({ title: 'Late', nextDueAt: sh('2025-11-14T23:30') });
    const early = schedule({ title: 'Early', nextDueAt: sh('2025-11-15T00:30') });
    expect(new Date(late.nextDueAt!).getUTCDate()).toBe(new Date(early.nextDueAt!).getUTCDate());
    const groups = scheduleTimeline({ schedules: [early, late], now: NOW, timezone: TZ });
    expect(names(groups)).toEqual([
      ['Today', 'Fri, Nov 14', ['Late']],
      ['Tomorrow', 'Sat, Nov 15', ['Early']],
    ]);
  });

  it('reads days in the viewer\'s zone: the same instants group differently in Los Angeles', () => {
    const late = schedule({ title: 'Late', nextDueAt: sh('2025-11-14T23:30') }); // 07:30 Fri in LA
    const early = schedule({ title: 'Early', nextDueAt: sh('2025-11-15T00:30') }); // 08:30 Fri in LA
    // 12:19 Shanghai is 20:19 Thursday in Los Angeles.
    const groups = scheduleTimeline({ schedules: [early, late], now: NOW, timezone: 'America/Los_Angeles' });
    expect(names(groups)).toEqual([['Tomorrow', 'Fri, Nov 14', ['Late', 'Early']]]);
  });

  it('just before midnight, a slot a minute later is Tomorrow; just after, it is Today', () => {
    const s = schedule({ title: 'Midnight', nextDueAt: sh('2025-11-15T00:00') });
    const before = scheduleTimeline({ schedules: [s], now: new Date(sh('2025-11-14T23:59')), timezone: TZ });
    expect(before.map((g) => g.title)).toEqual(['Tomorrow']);
    const after = scheduleTimeline({ schedules: [s], now: new Date(sh('2025-11-15T00:00')), timezone: TZ });
    expect(after.map((g) => [g.title, g.subtitle])).toEqual([['Today', 'Sat, Nov 15']]);
  });

  it('names the days of the coming week across the weekend, then Later', () => {
    const at = (d: string) => schedule({ title: d, nextDueAt: sh(`${d}T09:00`) });
    const groups = scheduleTimeline({
      schedules: [at('2025-11-16'), at('2025-11-17'), at('2025-11-20'), at('2025-11-21'), at('2025-12-01')],
      now: NOW,
      timezone: TZ,
    });
    expect(names(groups)).toEqual([
      ['Sunday', 'Nov 16', ['2025-11-16']],
      ['Monday', 'Nov 17', ['2025-11-17']],
      ['Thursday', 'Nov 20', ['2025-11-20']],
      ['Later', null, ['2025-11-21', '2025-12-01']],
    ]);
  });

  it('on a Sunday, Monday is Tomorrow and next Sunday is Later', () => {
    const sunday = new Date(sh('2025-11-16T20:00'));
    const mon = schedule({ title: 'Mon', nextDueAt: sh('2025-11-17T09:00') });
    const sat = schedule({ title: 'Sat', nextDueAt: sh('2025-11-22T09:00') });
    const sun = schedule({ title: 'Sun', nextDueAt: sh('2025-11-23T09:00') });
    const groups = scheduleTimeline({ schedules: [sun, sat, mon], now: sunday, timezone: TZ });
    expect(names(groups)).toEqual([
      ['Tomorrow', 'Mon, Nov 17', ['Mon']],
      ['Saturday', 'Nov 22', ['Sat']],
      ['Later', null, ['Sun']],
    ]);
  });

  it('across a month end and a year end', () => {
    const now = new Date(sh('2025-12-31T22:00'));
    const s = schedule({ title: 'New year', nextDueAt: sh('2026-01-01T09:00') });
    const groups = scheduleTimeline({ schedules: [s], now, timezone: TZ });
    expect(groups.map((g) => [g.title, g.subtitle])).toEqual([['Tomorrow', 'Thu, Jan 1']]);
  });

  it('puts a slot already due (being fired) under Today', () => {
    const s = schedule({ title: 'Due', nextDueAt: sh('2025-11-13T09:00') });
    expect(scheduleTimeline({ schedules: [s], now: NOW, timezone: TZ }).map((g) => g.title)).toEqual(['Today']);
  });

  it('shows ended runs only with Show past runs, and only today\'s', () => {
    const s = schedule({ title: 'Codex stable check', nextDueAt: sh('2025-11-15T09:00') });
    const runs = [
      run(s, 'CHANGED', sh('2025-11-14T10:00')),
      run(s, 'NO_CHANGE', sh('2025-11-13T10:00')),
    ];
    const hidden = scheduleTimeline({ schedules: [s], runs, now: NOW, timezone: TZ });
    expect(hidden.map((g) => g.title)).toEqual(['Tomorrow']);
    const shown = scheduleTimeline({ schedules: [s], runs, showPastRuns: true, now: NOW, timezone: TZ });
    expect(names(shown)).toEqual([
      ['Today', 'Fri, Nov 14', ['Codex stable check']],
      ['Tomorrow', 'Sat, Nov 15', ['Codex stable check']],
    ]);
    const item = shown[0]!.items[0]!;
    expect(item.kind === 'RUN' && item.run.state).toBe('CHANGED');
  });

  it('places a draft on the day of its first run', () => {
    const card = {
      id: 'c1', kind: 'CREATE', title: 'Weekday issue summary',
      when: { rule: { kind: 'WEEKLY', time: '09:00', weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] }, timezone: TZ, firstRunAt: sh('2025-11-17T09:00'), text: '' },
    } as unknown as ScheduleCreateCard;
    const cost = schedule({ title: 'Weekly cost report', nextDueAt: sh('2025-11-17T10:00') });
    const groups = scheduleTimeline({ schedules: [cost], drafts: [card], now: NOW, timezone: TZ });
    expect(names(groups)).toEqual([['Monday', 'Nov 17', ['Weekday issue summary', 'Weekly cost report']]]);
  });
});

describe('circles', () => {
  const EXPECTED: Record<ScheduleRunState, [string, string | null, string | null]> = {
    QUEUED: ['open', 'clock', null],
    RUNNING: ['running', null, null],
    AWAITING_APPROVAL: ['held', 'alert', 'Waiting for you'],
    NO_CHANGE: ['done', 'check', 'No change'],
    CHANGED: ['done', 'check', 'Known'],
    FAILED: ['failed', 'alert', 'Failed'],
    SKIPPED: ['muted', 'check', 'Skipped'],
    MISSED: ['muted', 'check', 'Missed'],
    HELD: ['held', 'alert', 'Held'],
    CANCELLED: ['muted', 'check', 'Cancelled'],
  };

  it('maps every ScheduleRun state', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...SCHEDULE_RUN_STATES].sort());
    for (const state of SCHEDULE_RUN_STATES) {
      const v = scheduleRunCircle({ state });
      expect([v.circle, v.mark, v.tag?.text ?? null], state).toEqual(EXPECTED[state]);
    }
  });

  it('a CHANGED run with a new finding is a green tick tagged New', () => {
    expect(scheduleRunCircle({ state: 'CHANGED' }, { newFinding: true })).toEqual({
      circle: 'new', mark: 'check', tag: { tone: 'new', text: 'New' },
    });
  });

  it('maps every schedule state, failing and draft', () => {
    expect(scheduleCircle({ state: 'ACTIVE', consecutiveFailures: 0 }).circle).toBe('open');
    expect(scheduleCircle({ state: 'ACTIVE', consecutiveFailures: 3 })).toEqual({
      circle: 'failed', mark: 'alert', tag: { tone: 'fail', text: 'Failed 3 in a row' },
    });
    expect(scheduleCircle({ state: 'ACTIVE', consecutiveFailures: 1 }).tag?.text).toBe('Failed');
    expect(scheduleCircle({ state: 'HELD', consecutiveFailures: 0 }).tag).toEqual({ tone: 'held', text: 'Held' });
    expect(scheduleCircle({ state: 'PAUSED', consecutiveFailures: 0 }).circle).toBe('paused');
    expect(scheduleCircle({ state: 'ENDED', consecutiveFailures: 0 }).circle).toBe('muted');
    expect(scheduleCircle({ state: 'ACTIVE', consecutiveFailures: 0 }, { draft: true }).circle).toBe('draft');
    expect(scheduleNeedsYou({ id: 's', state: 'PAUSED', consecutiveFailures: 2 })).toBe(false);
  });

  it('counts for the drawer as Apple and Android do: needs-you schedules, then conditions that cannot be read', () => {
    const reading = (state: 'WAITING' | 'UNKNOWN') =>
      ({ id: `c-${state}`, text: 'raw used above 90%', unit: '%', state, lastValue: null, lastSampleAt: null });
    const failing = schedule({ consecutiveFailures: 1 });
    const held = schedule({ state: 'HELD', heldReason: 'AGENT_DISABLED' });
    const unread = schedule({ condition: reading('UNKNOWN') });
    const unreadPaused = schedule({ state: 'PAUSED', condition: reading('UNKNOWN') });
    const readable = schedule({ condition: reading('WAITING') });
    const task = (state: 'WAITING' | 'UNKNOWN') =>
      ({ id: `t-${state}`, title: 'Set pool size', workspaceId: 'ws', workspaceName: null, condition: reading(state) });
    const schedules = [failing, held, unread, unreadPaused, readable, schedule()];
    expect(scheduleNeedsCount({ schedules, waitingTasks: [task('UNKNOWN'), task('WAITING')] })).toBe(4);
    // A failing schedule whose retry is under way is left out until that run ends.
    expect(scheduleNeedsCount({ schedules, runs: [run(failing, 'RUNNING', sh('2025-11-14T12:27'))] })).toBe(2);
    expect(scheduleNeedsCount(undefined)).toBe(0);
  });

  it('a failing schedule with a run under way waits for that run: no tag, not counted (owner 2026-11-19)', () => {
    const failing = schedule({ consecutiveFailures: 2, nextDueAt: sh('2025-11-15T18:00') });
    const held = schedule({ state: 'HELD', heldReason: 'AGENT_DISABLED' });
    const other = schedule();
    expect(scheduleNeedsYou(failing)).toBe(true);
    expect(scheduleRowCircle(failing, []).tag?.text).toBe('Failed 2 in a row');
    for (const state of ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL'] as const) {
      const retry = [run(failing, state, sh('2025-11-14T12:27'), { trigger: 'MANUAL' })];
      expect(scheduleNeedsYou(failing, retry)).toBe(false);
      expect(scheduleRowCircle(failing, retry)).toEqual({ circle: 'open', mark: null, tag: null });
    }
    // An ended run, or another schedule's run under way, leaves the failure standing.
    expect(scheduleNeedsYou(failing, [run(failing, 'FAILED', sh('2025-11-14T12:27'))])).toBe(true);
    expect(scheduleNeedsYou(failing, [run(other, 'RUNNING', sh('2025-11-14T12:27'))])).toBe(true);
    // A hold is not waited out by a run.
    expect(scheduleNeedsYou(held, [run(held, 'QUEUED', sh('2025-11-14T12:27'))])).toBe(true);
    expect(scheduleRowCircle(held, []).tag?.text).toBe('Held');
  });
});

describe('row lines', () => {
  it('reads like board 1/2', () => {
    expect(scheduleRowLine(schedule({ rule: { kind: 'DAILY', time: '02:00' } })))
      .toBe('Every day at 02:00 · apiserver · Check only');
    expect(scheduleRowLine(schedule({ rule: { kind: 'WEEKLY', time: '17:00', weekdays: ['FRI'] }, workspaceName: 'Orbit baseline', accessLevel: 'OPEN_PR' })))
      .toBe('Every Friday at 17:00 · Orbit baseline · Open a PR');
    expect(scheduleRowLine(schedule({ rule: { kind: 'ONCE', at: '2025-11-14T18:00' } })))
      .toBe('Once · apiserver · Check only');
    expect(scheduleRowLine(
      schedule({ rule: { kind: 'WEEKLY', time: '09:00', weekdays: ['MON'] }, workspaceName: 'web', state: 'HELD', heldReason: 'AGENT_DISABLED' }),
      { agentName: 'auditor' },
    )).toBe('Every Monday at 09:00 · web · the agent "auditor" is disabled');
    expect(scheduleRowLine(schedule({ rule: { kind: 'DAILY', time: '12:00' }, workspaceName: 'web' }), { runningMinutes: 21 }))
      .toBe('Every day at 12:00 · web · Check only · running for 21 min');
    expect(scheduleRowLine(schedule({ rule: { kind: 'DAILY', time: '08:00' }, workspaceName: 'web', state: 'PAUSED' }), {
      pausedAt: new Date(sh('2025-11-07T15:00')), timezone: TZ,
    })).toBe('Every day at 08:00 · web · paused Nov 7');
    expect(scheduleRowLine(schedule({ rule: { kind: 'WEEKLY', time: '09:00', weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] } }), { draft: true }))
      .toBe('Weekdays at 09:00 · apiserver · Check only · draft, waiting for you');
  });

  it('past runs', () => {
    const s = schedule();
    expect(scheduleRunLine(run(s, 'FAILED', NOW.toISOString(), { failureReason: 'NO_REPORT' }))).toBe('Ended without a report');
    expect(scheduleRunLine(run(s, 'CHANGED', NOW.toISOString(), { summary: '2.1.310 is out' }), { notified: true }))
      .toBe('2.1.310 is out · you were notified');
    expect(scheduleRunLine(run(s, 'CHANGED', NOW.toISOString(), { summary: '0.49.0 again · linked PR #831' })))
      .toBe('0.49.0 again · linked PR #831 · not notified');
    expect(scheduleRunLine(run(s, 'MISSED', NOW.toISOString(), { failureReason: 'OVER_BUDGET', reasonText: 'Over budget: 7 of 7 runs this week' })))
      .toBe('Over budget: 7 of 7 runs this week');
    // A reported failure says what the run reported, as its Waiting card and push do.
    expect(scheduleRunLine(run(s, 'FAILED', NOW.toISOString(), { failureReason: 'REPORTED_FAILED', summary: 'The releases page returned 503.' })))
      .toBe('Reported a failure: The releases page returned 503');
    expect(scheduleRunLine(run(s, 'FAILED', NOW.toISOString(), { failureReason: 'REPORTED_FAILED' }))).toBe('Reported a failure');
  });

  it('when', () => {
    expect(scheduleWhenText(new Date(sh('2025-11-14T02:00')), NOW, TZ)).toBe('Today 02:00');
    expect(scheduleWhenText(new Date(sh('2025-11-15T09:00')), NOW, TZ)).toBe('Tomorrow 09:00');
    expect(scheduleWhenText(new Date(sh('2025-11-17T09:00')), NOW, TZ)).toBe('Monday 09:00');
    expect(scheduleWhenText(new Date(sh('2025-11-24T09:00')), NOW, TZ)).toBe('Nov 24 09:00');
  });
});

describe('cards', () => {
  it('the create card When (board 2/2 ①, 1/2 ④)', () => {
    const when = scheduleCreateWhen({
      when: { rule: { kind: 'DAILY', time: '10:00' }, timezone: TZ, firstRunAt: sh('2025-11-15T10:00'), text: '' },
    }, NOW, TZ);
    expect(when.text).toBe('Daily 10:00 · Asia/Shanghai · first run tomorrow');
    const draft = scheduleCreateWhen({
      when: { rule: { kind: 'WEEKLY', time: '09:00', weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] }, timezone: TZ, firstRunAt: sh('2025-11-17T09:00'), text: '' },
    }, NOW, TZ);
    expect([`${draft.rule} · ${draft.zone}`, draft.firstRun]).toEqual(['Weekdays at 09:00 · Asia/Shanghai', 'First run Monday']);
    const noZone = scheduleCreateWhen({ when: { rule: { kind: 'DAILY', time: '10:00' }, timezone: null, firstRunAt: null, text: '' } }, NOW, TZ);
    expect(noZone.text).toBe('Daily 10:00 · your time zone');
  });

  it('Waiting on you: failed, held, approval (board 2/2 ④)', () => {
    expect(scheduleFailedWaiting({
      title: 'Nightly pg spec sweep',
      consecutiveFailures: 3,
      run: { failureReason: 'NO_REPORT', reasonText: null, plannedAt: sh('2025-11-14T02:00') },
      timezone: TZ,
    })).toEqual({
      title: 'Nightly pg spec sweep failed 3 runs in a row',
      kind: 'Scheduled',
      body: 'The last run ended without a report (Nov 14, 02:00). It keeps running on schedule until you pause it. '
        + 'Open the run to see where it stopped, or ask a session to fix the prompt.',
      actions: ['Open run', 'Pause schedule'],
    });
    expect(scheduleHeldWaiting({
      title: 'Weekly dependency audit',
      heldReason: 'AGENT_DISABLED',
      plannedAt: sh('2025-11-10T09:00'),
      agentName: 'auditor',
      workspaceName: 'web',
      now: new Date(sh('2025-11-10T09:01')),
      timezone: TZ,
    })).toEqual({
      title: 'Weekly dependency audit is held',
      kind: 'Scheduled',
      body: 'It could not start on Monday 09:00: the agent "auditor" in workspace web is disabled. Nothing runs until it is enabled and you resume.',
      actions: ['Open agent settings', 'Resume'],
    });
    const approval = scheduleApprovalWaiting({
      title: 'Nightly pg spec sweep',
      deadline: sh('2025-11-14T04:00'),
      nextAt: sh('2025-11-15T02:00'),
      pattern: 'psql:*',
      workspaceName: 'apiserver',
      now: new Date(sh('2025-11-14T02:03')),
      timezone: TZ,
    });
    expect(approval).toEqual({
      title: 'Nightly pg spec sweep wants to run a command',
      kind: 'Scheduled run',
      body: 'If nobody answers by 04:00 this run fails; the next one starts tomorrow.',
      alwaysAllow: "Always allow covers psql:* in apiserver: later runs won't ask for this.",
      actions: ['Always allow', 'Allow once', 'Deny'],
    });
  });

  it('a held card without the agent\'s name still reads', () => {
    const held = scheduleHeldWaiting({
      title: 'Audit', heldReason: 'AGENT_DISABLED', plannedAt: sh('2025-10-27T09:00'), now: NOW, timezone: TZ,
    });
    expect(held.body).toBe('It could not start on Oct 27, 09:00: its agent is disabled. Nothing runs until it is enabled and you resume.');
  });
});

describe('the run\'s session (board 2/2 ⑥)', () => {
  it('strip, crumb and report', () => {
    const s = schedule();
    const r = run(s, 'CHANGED', sh('2025-11-13T10:00'), { startedAt: sh('2025-11-13T10:01'), key: 'codex@0.49.0' });
    expect(scheduleRunStripText(r, 'CHECK_ONLY', TZ)).toBe(
      'Scheduled run · planned 10:00, started 10:01 · access Check only',
    );
    expect(scheduleRunOfText(r, TZ)).toBe('run of Nov 13');
    expect(scheduleReportedText(r, { notified: true })).toBe('Reported: Changed · codex@0.49.0 · you were notified');
    expect(scheduleReportedText({ state: 'NO_CHANGE', key: null })).toBe('Reported: No change');
  });

});

describe('an EVERY rule (design §3, §9.2)', () => {
  const WORK = ['MON', 'TUE', 'WED', 'THU', 'FRI'] as const;
  const ALL = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
  it('reads as the doc\'s rule sentence, the same short and long, with seven weekdays left unsaid', () => {
    const window = { kind: 'EVERY', minutes: 30, time: '09:00', until: '18:00', weekdays: [...WORK] } as const;
    expect(scheduleRuleText(window)).toBe('Every 30 min, 09:00–18:00, Mon–Fri');
    expect(scheduleRuleText(window, 'long')).toBe('Every 30 min, 09:00–18:00, Mon–Fri');
    expect(scheduleRuleText({ kind: 'EVERY', minutes: 60, time: '00:00', weekdays: [...ALL] })).toBe('Every hour');
    expect(scheduleRuleText({ kind: 'EVERY', minutes: 120, time: '08:00', weekdays: ['SUN', 'SAT'] }))
      .toBe('Every 2 hours from 08:00, weekends');
    expect(scheduleRuleText({ kind: 'EVERY', minutes: 720, time: '00:00', weekdays: ['MON', 'THU'] })).toBe('Every 12 hours, Mon, Thu');
  });

  it('shows the repeat mark, and its row line carries the sentence', () => {
    const rule = { kind: 'EVERY', minutes: 30, time: '09:00', until: '18:00', weekdays: [...WORK] } as const;
    expect(scheduleRuleRepeats(rule)).toBe(true);
    expect(scheduleRowLine(schedule({ rule }))).toBe('Every 30 min, 09:00–18:00, Mon–Fri · apiserver · Check only');
  });
});

describe('a rename in the history (design §8.4 Rename)', () => {
  it('names the old title for a person’s change of the title alone, and nothing else', () => {
    const change = { before: { title: 'Codex check' }, after: { title: 'Codex stable check' } };
    expect(scheduleRenamedText({ changedBy: 'USER', ...change })).toBe('Renamed from “Codex check”');
    expect(scheduleRenamedText({ changedBy: 'SESSION', ...change })).toBeNull();
    expect(scheduleRenamedText({ changedBy: 'RUN', ...change })).toBeNull();
    expect(scheduleRenamedText({ changedBy: 'USER', before: null, after: { title: 'Codex check' } })).toBeNull();
    expect(scheduleRenamedText({
      changedBy: 'USER', before: { title: 'a', prompt: 'p' }, after: { title: 'b', prompt: 'q' },
    })).toBeNull();
  });
});

describe('the Scheduled page chat opening (docs/scheduled-chat-design.md §4.1)', () => {
  const now = new Date('2026-11-28T04:00:00Z');
  const counts = (c: Partial<Parameters<typeof schedulePageChatOpening>[0]['counts']>) =>
    ({ total: 0, active: 0, paused: 0, held: 0, failing: 0, ...c });

  it('words the design example: active and paused, none failing, the next run tomorrow', () => {
    const opening = schedulePageChatOpening({
      counts: counts({ total: 4, active: 2, paused: 2 }),
      next: {
        scheduleId: 's', title: 'Engine version bump', at: '2026-11-28T22:00:00Z', timezone: 'Asia/Shanghai',
        workspaceId: 'w', workspaceName: 'orbit-ws01',
      },
      now,
      viewerTimezone: 'Asia/Shanghai',
    });
    expect(opening.summary).toBe('You have 4 scheduled tasks: 2 active, 2 paused, none failing.');
    expect(opening.nextText).toBe('Next: Engine version bump, tomorrow at 06:00 on orbit-ws01.');
    expect(opening.examples).toEqual([...SCHEDULE_PAGE_CHAT_COPY.examples]);
    expect(opening.closing).toBe(SCHEDULE_PAGE_CHAT_COPY.envelope);
  });

  it('says one task, none active, a held one, and nothing next', () => {
    const opening = schedulePageChatOpening({ counts: counts({ total: 1, held: 1 }), next: null, now });
    expect(opening.summary).toBe('You have 1 scheduled task: none active, 1 held, none failing.');
    expect(opening.nextText).toBeNull();
  });

  it('names a later day and a deleted workspace', () => {
    const opening = schedulePageChatOpening({
      counts: counts({ total: 1, active: 1, failing: 1 }),
      next: { scheduleId: 's', title: 'Docs', at: '2026-12-01T01:00:00Z', timezone: 'UTC', workspaceId: 'w', workspaceName: null },
      now,
    });
    expect(opening.summary).toBe('You have 1 scheduled task: 1 active, 1 failing.');
    expect(opening.nextText).toBe('Next: Docs, Tuesday at 01:00 UTC on a deleted workspace.', 'no viewer zone: the zone is named');
  });

  it("names the schedule's zone when the viewer's clock reads differently, and not when it reads the same", () => {
    const next = {
      scheduleId: 's', title: 'Engine version bump', at: '2026-11-28T22:00:00Z', timezone: 'Asia/Shanghai',
      workspaceId: 'w', workspaceName: 'orbit-ws01',
    };
    const at = (viewerTimezone: string) =>
      schedulePageChatOpening({ counts: counts({ total: 1, active: 1 }), next, now, viewerTimezone }).nextText;
    expect(at('Europe/Berlin')).toBe('Next: Engine version bump, tomorrow at 06:00 Asia/Shanghai on orbit-ws01.');
    expect(at('Asia/Singapore')).toBe('Next: Engine version bump, tomorrow at 06:00 on orbit-ws01.', 'same clock, another name');
  });

  it('on an empty account offers what to say, and says nothing runs until then', () => {
    const opening = schedulePageChatOpening({ counts: counts({}), next: null, now });
    expect(opening.summary).toBe('You have no scheduled tasks yet.');
    expect(opening.examples).toEqual([...SCHEDULE_PAGE_CHAT_COPY.empty.examples]);
    expect(opening.closing).toBe('Nothing runs until you say something.');
  });

  it('tags the chat From Scheduled from the one origin table', () => {
    expect(sessionOriginTag('SCHEDULE_CHAT')).toBe('From Scheduled');
    expect(sessionOriginTag('WIKI_CHAT')).toBe('From Wiki');
    expect(sessionOriginTag(null)).toBeNull();
  });
});
