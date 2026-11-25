// Scheduled tasks as the REST doors answer them, on the boards' demo data (docs/mocks/scheduled-tasks/web): Friday
// Nov 14 2025 (the boards' calendar: a Friday), 12:30 in Asia/Shanghai. Plain data, so a capture script can load it under Node's
// type stripping as well as vitest; its one value import is @orbit/shared's notice line, as the server builds it.
import { scheduleCreateNotice } from '@orbit/shared';
import type {
  ScheduleChangeRecord,
  ScheduleCreateCard,
  ScheduleDetailResponse,
  ScheduleEnvelopeCard,
  ScheduleEnvelopeLines,
  ScheduleFindingView,
  ScheduleListResponse,
  ScheduleListRow,
  ScheduleRule,
  ScheduleRunSessionStatus,
  ScheduleRunView,
  ScheduleTimelineRun,
  ScheduleView,
} from '@orbit/shared';

export const SCHEDULE_NOW = '2025-11-14T04:30:00.000Z';
export const SCHEDULE_TZ = 'Asia/Shanghai';

export const WS = {
  apiserver: { id: 'ws-apiserver', name: 'apiserver' },
  web: { id: 'ws-web', name: 'web' },
  baseline: { id: 'ws-baseline', name: 'Orbit baseline' },
};

/** The conversation each schedule came from, and the run sessions the boards open. */
export const SESSION_IDS = {
  codexWatch: 'sess-codex-watch',
  draft: 'sess-weekday-issues',
  codexRun: 'sess-codex-run-nov13',
  freezeRun: 'sess-freeze-run-nov14',
  pgRun: 'sess-pg-run-nov14',
};

const SH_OFFSET_H = 8;
/** An instant from a Shanghai wall clock in November 2025: `sh(14, '12:30')`. */
export function sh(day: number, time: string): string {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2025, 10, day, h! - SH_OFFSET_H, m!)).toISOString();
}

function lines(ws: { id: string; name: string }, engine: string | null, access: 'CHECK_ONLY' | 'OPEN_PR' | 'LAND', runs: number, minutes: number): ScheduleEnvelopeLines {
  return {
    runsIn: { workspaceId: ws.id, workspaceName: ws.name, engine, text: ws.name },
    may: { accessLevel: access, text: access },
    costs: { runsPerWeek: runs, runLimitMinutes: minutes, text: '' },
  };
}

function schedule(over: Partial<ScheduleView> & { id: string; title: string; rule: ScheduleRule; ws: { id: string; name: string } }): ScheduleView {
  const { ws, ...rest } = over;
  const access = rest.accessLevel ?? 'CHECK_ONLY';
  const runsPerWeek = rest.runsPerWeek ?? 7;
  return {
    intent: '',
    prompt: '',
    ruleText: '',
    timezone: SCHEDULE_TZ,
    workspaceId: ws.id,
    workspaceName: ws.name,
    agentId: null,
    agentName: null,
    engine: null,
    accessLevel: access,
    may: '',
    runLimitMinutes: 30,
    runsPerWeek,
    envelope: { workspaceId: ws.id, accessLevel: access, runsPerWeek, runLimitMinutes: 30 },
    state: 'ACTIVE',
    heldReason: null,
    endedReason: null,
    note: null,
    revision: 1,
    startAt: sh(1, '00:00'),
    endAt: null,
    nextDueAt: null,
    consecutiveFailures: 0,
    createdFromSessionId: null,
    createdAt: sh(3, '10:12'),
    endedAt: null,
    ...rest,
  };
}

function run(over: Partial<ScheduleRunView> & { id: string; scheduleId: string; plannedAt: string; state: ScheduleRunView['state'] }): ScheduleRunView {
  return {
    scheduleRevision: 1,
    trigger: 'SCHEDULED',
    attempt: 1,
    startedAt: over.plannedAt,
    endedAt: null,
    sessionId: null,
    key: null,
    summary: null,
    links: null,
    failureReason: null,
    heldReason: null,
    ...over,
  };
}

function finding(key: string, firstRunId: string, notifiedAt: string | null): ScheduleFindingView {
  return { key, summary: null, firstRunId, lastSeenRunId: firstRunId, notifiedAt, baseline: false, links: null, createdAt: sh(13, '10:01') };
}

// ── the schedules ───────────────────────────────────────────────────────────────────────────────

const pg = schedule({
  id: 'sch-pg', title: 'Nightly pg spec sweep', rule: { kind: 'DAILY', time: '02:00' }, ws: WS.apiserver,
  consecutiveFailures: 3, nextDueAt: sh(15, '02:00'),
});
const pgFailed = run({
  id: 'run-pg-nov14', scheduleId: pg.id, plannedAt: sh(14, '02:00'), state: 'FAILED', failureReason: 'NO_REPORT',
  endedAt: sh(14, '02:41'), sessionId: SESSION_IDS.pgRun,
});

const audit = schedule({
  id: 'sch-audit', title: 'Weekly dependency audit', rule: { kind: 'WEEKLY', time: '09:00', weekdays: ['MON'] }, ws: WS.web,
  state: 'HELD', heldReason: 'AGENT_DISABLED', nextDueAt: null, agentId: 'agent-auditor', agentName: 'auditor',
});

const docs = schedule({
  id: 'sch-docs', title: 'Docs link check', rule: { kind: 'DAILY', time: '12:00' }, ws: WS.web, nextDueAt: sh(15, '12:00'),
});
const docsRunning = run({ id: 'run-docs-nov14', scheduleId: docs.id, plannedAt: sh(14, '12:00'), startedAt: sh(14, '12:09'), state: 'RUNNING' });

const notes = schedule({
  id: 'sch-notes', title: 'Release notes draft', rule: { kind: 'WEEKLY', time: '17:00', weekdays: ['FRI'] }, ws: WS.baseline,
  accessLevel: 'OPEN_PR', runsPerWeek: 1, nextDueAt: sh(14, '17:00'),
});

const deploy = schedule({
  id: 'sch-deploy', title: 'Deploy health check', rule: { kind: 'ONCE', at: sh(14, '18:00') }, ws: WS.apiserver,
  runsPerWeek: 1, nextDueAt: sh(14, '18:00'),
});

const codex = schedule({
  id: 'sch-codex', title: 'Codex stable check', rule: { kind: 'DAILY', time: '09:00' }, ws: WS.apiserver, accessLevel: 'OPEN_PR',
  engine: 'codex', nextDueAt: sh(15, '09:00'), revision: 4, createdFromSessionId: SESSION_IDS.codexWatch,
  intent: '每天北京时间 10 点检查 Codex 官方稳定版，和 apiserver 固定的版本比一下。没变化就别吵我，有新版告诉我版本号和发布说明。',
  note: 'Release notes moved to github.com/openai/codex/releases. The old changelog URL is 404.',
});
const codexToday = run({
  id: 'run-codex-nov14', scheduleId: codex.id, plannedAt: sh(14, '10:00'), state: 'CHANGED', key: '0.49.0',
  summary: 'Known 0.49.0, linked PR #831', endedAt: sh(14, '10:03'), sessionId: 'sess-codex-run-nov14',
});
const codexNov13 = run({
  id: 'run-codex-nov13', scheduleId: codex.id, plannedAt: sh(13, '10:00'), startedAt: sh(13, '10:01'), state: 'CHANGED',
  key: '0.49.0', summary: 'Codex 0.49.0 is out (pinned 0.48.0).', endedAt: sh(13, '10:04'), sessionId: SESSION_IDS.codexRun,
  links: [{ url: 'https://github.com/openai/codex/releases/tag/0.49.0', title: 'Release notes' }],
});
const codexNov12 = run({
  id: 'run-codex-nov12', scheduleId: codex.id, plannedAt: sh(12, '10:00'), startedAt: sh(12, '13:47'), state: 'NO_CHANGE',
  summary: 'No change', endedAt: sh(12, '13:49'), sessionId: 'sess-codex-run-nov12',
});

const claude = schedule({
  id: 'sch-claude', title: 'Claude CLI version check', rule: { kind: 'DAILY', time: '10:30' }, ws: WS.apiserver, nextDueAt: sh(15, '10:30'),
  engine: 'claude',
});
const claudeToday = run({
  id: 'run-claude-nov14', scheduleId: claude.id, plannedAt: sh(14, '10:30'), state: 'CHANGED', key: '2.1.310',
  summary: '2.1.310 is out', endedAt: sh(14, '10:33'), sessionId: 'sess-claude-run-nov14',
});

const cost = schedule({
  id: 'sch-cost', title: 'Weekly cost report', rule: { kind: 'WEEKLY', time: '10:00', weekdays: ['MON'] }, ws: WS.baseline,
  runsPerWeek: 1, nextDueAt: sh(17, '10:00'),
});

const gateway = schedule({
  id: 'sch-gateway', title: 'Gateway CSP report digest', rule: { kind: 'DAILY', time: '08:00' }, ws: WS.web, state: 'PAUSED',
});

// An EVERY rule with a planned end by time, and one with an end by count; the second has missed slots overnight.
const sweep = schedule({
  id: 'sch-sweep', title: 'Queue depth sweep', rule: { kind: 'EVERY', minutes: 30, time: '09:00', until: '18:00', weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] },
  ws: WS.apiserver, endAt: sh(14, '18:00'), nextDueAt: sh(14, '13:00'),
});
const burst = schedule({
  id: 'sch-burst', title: 'Canary burst watch', rule: { kind: 'EVERY', minutes: 60, time: '00:00', weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] },
  ws: WS.web, maxRuns: 6, runsStarted: 3, runsLeft: 3, nextDueAt: sh(14, '14:00'),
});
const burstMissed = ['01:00', '02:00', '03:00', '04:00'].map((t, i) => run({
  id: `run-burst-missed-${i}`, scheduleId: burst.id, plannedAt: sh(14, t), startedAt: null, state: 'MISSED',
}));

// ── a run that never reached its engine (board docs/mocks/scheduled-run-not-started ②③④) ────────────────

/** Engine version bump, the board's Run now: planned 03:32, five tries on HPC, given up at 05:44. */
const bump = schedule({
  id: 'sch-bump', title: 'Engine version bump', rule: { kind: 'DAILY', time: '06:00' }, ws: WS.apiserver, accessLevel: 'LAND',
  engine: 'claude', nextDueAt: sh(15, '06:00'),
});
export const BUMP_SCHEDULE = bump;
/** The sessions of its five tries, oldest first. */
export const BUMP_TRY_SESSIONS = ['sess-bump-try-1', 'sess-bump-try-2', 'sess-bump-try-3', 'sess-bump-try-4', 'sess-bump-try-5'];
const BUMP_TRY_TIMES = ['03:32', '03:43', '03:58', '04:23', '05:34'];
const bumpTries = (reached: number | null = null) => BUMP_TRY_SESSIONS.map((sessionId, i) => ({
  sessionId, startedAt: sh(14, BUMP_TRY_TIMES[i]!), claimed: true, reachedEngine: reached === i + 1,
}));
/** ② Didn't run: MISSED after five tries HPC did not pick up. */
export const BUMP_MISSED_RUN = run({
  id: 'run-bump-nov14', scheduleId: bump.id, plannedAt: sh(14, '03:32'), trigger: 'MANUAL', startedAt: sh(14, '05:34'),
  endedAt: sh(14, '05:44'), state: 'MISSED', attempt: 5, failureReason: 'RUNNER_UNAVAILABLE', sessionId: BUMP_TRY_SESSIONS[4]!,
});
export function bumpMissedStatus(thisTry = 5): ScheduleRunSessionStatus {
  return { tries: bumpTries(), thisTry, gaveUpAt: sh(14, '05:44'), notBeforeAt: null, nextDueAt: sh(15, '06:00'), queue: null };
}
/** ③ Queued · runner full: one try, waiting 1 h 12 min behind HPC's 20 sessions, until 03:32 tomorrow. */
export const BUMP_QUEUED_RUN = run({
  id: 'run-bump-nov14', scheduleId: bump.id, plannedAt: sh(14, '03:32'), trigger: 'MANUAL', startedAt: sh(14, '11:18'),
  state: 'RUNNING', sessionId: BUMP_TRY_SESSIONS[0]!,
});
export function bumpQueuedStatus(): ScheduleRunSessionStatus {
  return {
    tries: [{ sessionId: BUMP_TRY_SESSIONS[0]!, startedAt: sh(14, '11:18'), claimed: false, reachedEngine: false }],
    thisTry: 1, gaveUpAt: null, notBeforeAt: null, nextDueAt: sh(15, '06:00'),
    queue: {
      queuedReason: 'runner_at_capacity', queuedActive: 20, queuedLimit: 20, queuedHeldByJobs: 0,
      since: sh(14, '11:18'), deadline: sh(15, '03:32'),
    },
  };
}
/** ④ Started on try 3: try 2's session, whose engine exited; try 3 reached its engine at 03:58. */
export const BUMP_STARTED_RUN = run({
  id: 'run-bump-nov14', scheduleId: bump.id, plannedAt: sh(14, '03:32'), trigger: 'MANUAL', startedAt: sh(14, '03:58'),
  state: 'RUNNING', attempt: 3, sessionId: BUMP_TRY_SESSIONS[2]!,
});
export function bumpStartedStatus(thisTry = 2): ScheduleRunSessionStatus {
  return { tries: bumpTries(3).slice(0, 3), thisTry, gaveUpAt: null, notBeforeAt: null, nextDueAt: sh(15, '06:00'), queue: null };
}

export const SCHEDULES: Record<string, ScheduleView> = { pg, audit, docs, notes, deploy, codex, claude, cost, gateway };
/** The EVERY schedules above, kept out of SCHEDULES so the older specs' rows and counts stay as they were. */
export const EVERY_SCHEDULES = { sweep, burst };
export const EVERY_ROWS: ScheduleListRow[] = [sweep, burst].map((s) => ({ ...s, lastRun: null }));
export const BURST_MISSED_RUNS = burstMissed;

const LAST: Record<string, ScheduleRunView | null> = {
  [pg.id]: pgFailed, [codex.id]: codexToday, [claude.id]: claudeToday,
};

export const LIST_ROWS: ScheduleListRow[] = Object.values(SCHEDULES).map((s) => ({ ...s, lastRun: LAST[s.id] ?? null }));

// ── history ─────────────────────────────────────────────────────────────────────────────────────

function record(over: Partial<ScheduleChangeRecord> & { scheduleId: string; title: string; revision: number; after: Record<string, unknown> }): ScheduleChangeRecord {
  return {
    kind: 'SCHEDULE_CHANGE_RECORD',
    changedBy: 'SESSION',
    sessionId: null,
    changed: Object.keys(over.after),
    before: {},
    undoOfRevision: null,
    undoneByRevision: null,
    askedText: null,
    createdAt: sh(14, '12:19'),
    undo: { method: 'POST', path: `/api/schedules/${over.scheduleId}/undo`, body: { revision: over.revision } },
    ...over,
  };
}

const ENV_CHECK = { workspaceId: WS.apiserver.id, accessLevel: 'CHECK_ONLY', runsPerWeek: 7, runLimitMinutes: 30 };
const ENV_PR = { ...ENV_CHECK, accessLevel: 'OPEN_PR' };

export const CODEX_TIME_RECORD = record({
  scheduleId: codex.id, title: codex.title, revision: 4, sessionId: SESSION_IDS.codexWatch, createdAt: sh(14, '12:19'),
  before: { rule: { kind: 'DAILY', time: '10:00' } }, after: { rule: { kind: 'DAILY', time: '09:00' } },
});
const codexAccess = record({
  scheduleId: codex.id, title: codex.title, revision: 3, sessionId: SESSION_IDS.codexWatch, createdAt: sh(14, '12:19'),
  before: { accessLevel: 'CHECK_ONLY', envelope: ENV_CHECK }, after: { accessLevel: 'OPEN_PR', envelope: ENV_PR }, undo: null,
});
const codexPrompt = record({
  scheduleId: codex.id, title: codex.title, revision: 2, changedBy: 'RUN', sessionId: 'sess-codex-run-nov12', createdAt: sh(12, '13:50'),
  before: { prompt: 'check the changelog' }, after: { prompt: 'check the releases page, not the changelog' },
});
const codexCreated = record({
  scheduleId: codex.id, title: codex.title, revision: 1, changedBy: 'USER', createdAt: sh(3, '10:12'),
  before: null, after: { accessLevel: 'CHECK_ONLY', envelope: ENV_CHECK }, undo: null,
});
const gatewayPaused = record({
  scheduleId: gateway.id, title: gateway.title, revision: 2, changedBy: 'USER', createdAt: sh(7, '09:30'),
  before: { state: 'ACTIVE' }, after: { state: 'PAUSED' }, undo: null,
});

// ── details ─────────────────────────────────────────────────────────────────────────────────────

const RUNS: Record<string, ScheduleRunView[]> = {
  [pg.id]: [pgFailed],
  [docs.id]: [docsRunning],
  [codex.id]: [codexToday, codexNov13, codexNov12],
  [claude.id]: [claudeToday],
};
const FINDINGS: Record<string, ScheduleFindingView[]> = {
  [codex.id]: [finding('0.49.0', codexNov13.id, sh(13, '10:04'))],
  [claude.id]: [finding('2.1.310', claudeToday.id, sh(14, '10:33'))],
};
const HISTORY: Record<string, ScheduleChangeRecord[]> = {
  [codex.id]: [CODEX_TIME_RECORD, codexAccess, codexPrompt, codexCreated],
  [gateway.id]: [gatewayPaused],
};
const READ_BACK: Record<string, string> = {
  [codex.id]: 'Every day at 09:00 Beijing time I check the latest stable Codex against the version the apiserver pins. When there is a new one I tell you and open a PR that bumps it.',
};

export function scheduleDetail(id: string): ScheduleDetailResponse {
  const s = [...Object.values(SCHEDULES), sweep, burst, bump].find((row) => row.id === id)!;
  const runs = id === burst.id ? burstMissed : RUNS[id] ?? [];
  return {
    schedule: s,
    readBack: READ_BACK[id] ?? s.intent,
    lastRun: runs.find((r) => r.endedAt !== null) ?? null,
    recentRuns: runs,
    findings: FINDINGS[id] ?? [],
    usage: { since: sh(1, '00:00'), runs: id === codex.id ? 14 : 3, minutes: id === codex.id ? 41 : 9, costUsd: null, text: '' },
    history: HISTORY[id] ?? [],
    pendingCards: [],
  };
}

/**
 * `GET /api/schedules` as the REST door answers it (schedule-reads.service.ts list with `timeline`): the rows with
 * when each paused one was paused, and the runs of the last day and those under way, each with its finding facts.
 */
export function listAnswer(rows: ScheduleListRow[] = LIST_ROWS): ScheduleListResponse {
  const since = Date.parse(SCHEDULE_NOW) - 24 * 60 * 60_000;
  const under = ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL'];
  const ids = new Set(rows.map((r) => r.id));
  const runs: ScheduleTimelineRun[] = [...Object.values(RUNS).flat(), ...burstMissed]
    .filter((r) => ids.has(r.scheduleId) && (under.includes(r.state) || Date.parse(r.plannedAt) >= since))
    .map((r) => {
      const f = (FINDINGS[r.scheduleId] ?? []).find((x) => x.firstRunId === r.id && x.key === r.key);
      return { ...r, newFinding: Boolean(f), notified: Boolean(f?.notifiedAt) };
    });
  const pausedAt = (id: string) =>
    (HISTORY[id] ?? []).find((record) => record.after?.state === 'PAUSED')?.createdAt ?? null;
  return {
    schedules: rows.map((r) => ({ ...r, pausedAt: r.state === 'PAUSED' ? pausedAt(r.id) : null })),
    runs,
  };
}

// ── cards ───────────────────────────────────────────────────────────────────────────────────────

function cardBase(id: string, sessionId: string, createdAt: string) {
  return {
    id, state: 'PENDING' as const, askedBy: 'SESSION' as const, askedBySessionId: sessionId, createdAt, decidedAt: null,
    resultRevision: null, decision: { allow: `/schedule-requests/${id}/allow`, decline: `/schedule-requests/${id}/decline` },
  };
}

/** The draft the quick-add line produced (board 1/2 ④). */
export const DRAFT_CARD: ScheduleCreateCard = {
  ...cardBase('req-weekday', SESSION_IDS.draft, sh(14, '12:24')),
  kind: 'CREATE', scheduleId: null,
  title: 'Weekday issue summary',
  readBack: 'Every weekday at 09:00 I list the issues opened in orbit since the last run, grouped by label, and tell you only when there are any.',
  intent: 'every weekday at 9, summarise new GitHub issues in orbit and tell me only if there are any',
  when: { rule: { kind: 'WEEKLY', time: '09:00', weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] }, timezone: SCHEDULE_TZ, firstRunAt: sh(17, '09:00'), text: '' },
  today: { key: 'open-12', summary: null, text: '12 issues are open now. The first run reports what comes after.' },
  // The agent proposed findings 'issues' (schedule_create's `findings`); the server sends the notice built from it.
  notice: scheduleCreateNotice('issues'),
  envelope: null,
  ...lines(WS.apiserver, 'claude', 'CHECK_ONLY', 5, 30),
};

/** The create card in the conversation (board 2/2 ①). */
export const CREATE_CARD: ScheduleCreateCard = {
  ...cardBase('req-codex-create', SESSION_IDS.codexWatch, sh(14, '12:01')),
  kind: 'CREATE', scheduleId: null,
  title: 'Codex stable check',
  readBack: 'Every day at 10:00 Beijing time I check the latest stable Codex against the version the apiserver pins, and tell you only when there is a new one.',
  intent: '每天北京时间 10 点检查 Codex 官方稳定版，和 apiserver 固定的版本比一下。没变化就别吵我，有新版告诉我版本号和发布说明。',
  when: { rule: { kind: 'DAILY', time: '10:00' }, timezone: SCHEDULE_TZ, firstRunAt: sh(15, '10:00'), text: '' },
  today: { key: '0.48.0', summary: null, text: 'Codex 0.48.0, same as pinned. Nothing to report.' },
  notice: scheduleCreateNotice('versions'),
  envelope: null,
  ...lines(WS.apiserver, 'codex', 'CHECK_ONLY', 7, 30),
};

function envelopeCard(id: string, widens: ScheduleEnvelopeCard['envelope']['widens'], now: ScheduleEnvelopeLines, asked: ScheduleEnvelopeLines, proposed: Record<string, unknown>, askedBy: 'SESSION' | 'RUN' = 'SESSION', sessionId = SESSION_IDS.codexWatch): ScheduleEnvelopeCard {
  return {
    ...cardBase(id, sessionId, sh(14, '12:20')),
    askedBy,
    kind: 'UPDATE', scheduleId: codex.id, title: codex.title, readBack: null, intent: null, when: null, runsIn: null, may: null,
    costs: null, today: null, notice: null, proposed, envelope: { widens, now, asked },
  };
}

/** "Let Codex stable check run more often?" (board 2/2 ②). */
export const MORE_OFTEN_CARD = envelopeCard(
  'req-codex-daily', ['RUNS_PER_WEEK'],
  lines(WS.apiserver, 'codex', 'CHECK_ONLY', 1, 30), lines(WS.apiserver, 'codex', 'CHECK_ONLY', 7, 30),
  { rule: { kind: 'DAILY', time: '10:00' } },
);

/** "Let Codex stable check open PRs?" (board 2/2 ③). */
export const OPEN_PRS_CARD = envelopeCard(
  'req-codex-pr', ['ACCESS_LEVEL'],
  lines(WS.apiserver, 'codex', 'CHECK_ONLY', 7, 30), lines(WS.apiserver, 'codex', 'OPEN_PR', 7, 30), { accessLevel: 'OPEN_PR' },
);

export const LAND_CARD = envelopeCard(
  'req-codex-land', ['ACCESS_LEVEL'],
  lines(WS.apiserver, 'codex', 'OPEN_PR', 7, 30), lines(WS.apiserver, 'codex', 'LAND', 7, 30), { accessLevel: 'LAND' },
);

/** The run's own request, which waits in Waiting on you (board 2/2 ④). */
export const RUN_WIDEN_CARD = envelopeCard(
  'req-codex-pr-run', ['ACCESS_LEVEL'],
  lines(WS.apiserver, 'codex', 'CHECK_ONLY', 7, 30), lines(WS.apiserver, 'codex', 'OPEN_PR', 7, 30), { accessLevel: 'OPEN_PR' },
  'RUN', SESSION_IDS.codexRun,
);

/** "Changed Codex stable check: Daily → Mondays 10:00" (board 2/2 ②). */
export const WEEKLY_RECORD = record({
  scheduleId: codex.id, title: codex.title, revision: 5, sessionId: SESSION_IDS.codexWatch, createdAt: sh(14, '12:15'),
  before: { rule: { kind: 'DAILY', time: '10:00' } }, after: { rule: { kind: 'WEEKLY', time: '10:00', weekdays: ['MON'] } },
});

/** "Ended Release 2.0 freeze watch: goal reached · by this run" (board 2/2 ⑤). */
export const FREEZE = schedule({
  id: 'sch-freeze', title: 'Release 2.0 freeze watch', rule: { kind: 'DAILY', time: '10:00' }, ws: WS.baseline,
  state: 'ENDED', endedReason: 'GOAL_REACHED',
});
export const FREEZE_RUN = run({
  id: 'run-freeze-nov14', scheduleId: FREEZE.id, plannedAt: sh(14, '10:00'), state: 'CHANGED', key: 'released@2.0.0',
  summary: '2.0 shipped; no freeze exceptions are open.', endedAt: sh(14, '10:02'), sessionId: SESSION_IDS.freezeRun,
});
export const FREEZE_ENDED_RECORD = record({
  scheduleId: FREEZE.id, title: FREEZE.title, revision: 3, changedBy: 'RUN', sessionId: SESSION_IDS.freezeRun,
  createdAt: sh(14, '10:02'), before: { state: 'ACTIVE' }, after: { state: 'ENDED', endedReason: 'GOAL_REACHED' },
});
export const CODEX_NOV13_RUN = codexNov13;
export const CODEX_RUNS = RUNS[codex.id]!;

export function freezeDetail(): ScheduleDetailResponse {
  return {
    schedule: FREEZE, readBack: '', lastRun: FREEZE_RUN, recentRuns: [FREEZE_RUN],
    findings: [finding('released@2.0.0', FREEZE_RUN.id, sh(14, '10:02'))],
    usage: { since: sh(1, '00:00'), runs: 10, minutes: 19, costUsd: null, text: '' }, history: [FREEZE_ENDED_RECORD], pendingCards: [],
  };
}

// ── Waiting on you ──────────────────────────────────────────────────────────────────────────────

function item(over: Record<string, unknown> & { id: string; kind: string; title: string; createdAt: string }) {
  return {
    state: 'PENDING', why: '', blocksTaskIds: [], ifUnanswered: null, options: null, recommendedOption: null, steps: null,
    secretSpec: null, secretGrant: null, verifyHint: null, expiresAt: null, askedBySessionId: SESSION_IDS.codexWatch,
    projectId: null, resolvedAt: null, resolvedByUserId: null, resolvedBySessionId: null, resolutionNote: null, answer: null,
    scheduleId: null, scheduleRunId: null, approvalId: null, scheduleChangeRequestId: null,
    ...over,
  };
}

export const WAITING_ITEMS = [
  item({ id: 'or-failed', kind: 'SCHEDULE_FAILED', title: 'Nightly pg spec sweep failed', createdAt: sh(14, '02:41'),
    scheduleId: pg.id, scheduleRunId: pgFailed.id, askedBySessionId: SESSION_IDS.pgRun }),
  item({ id: 'or-held', kind: 'SCHEDULE_HELD', title: 'Weekly dependency audit is on hold', createdAt: sh(10, '09:00'),
    scheduleId: audit.id }),
  item({ id: 'or-approval', kind: 'SCHEDULE_APPROVAL', title: 'Nightly pg spec sweep needs your approval', createdAt: sh(14, '02:03'),
    scheduleId: pg.id, scheduleRunId: pgFailed.id, approvalId: 'appr-psql', askedBySessionId: SESSION_IDS.pgRun }),
  item({ id: 'or-widen', kind: 'SCHEDULE_WIDEN', title: 'Codex stable check asks to do more', createdAt: sh(13, '10:04'),
    scheduleId: codex.id, scheduleRunId: codexNov13.id, scheduleChangeRequestId: RUN_WIDEN_CARD.id, askedBySessionId: SESSION_IDS.codexRun }),
];

export const PSQL_APPROVAL = {
  id: 'appr-psql', sessionId: SESSION_IDS.pgRun, toolName: 'Bash', input: { command: 'psql -h 127.0.0.1 -p 55490 -c "select 1"' },
  status: 'PENDING', createdAt: sh(14, '02:03'),
};
