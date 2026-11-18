import { scheduleCreateNotice, scheduleWhenLines } from '@orbit/shared';
import { SESSION, WORKSPACE } from './session-fixtures.mjs';

// Conditions as the REST doors answer them (docs/condition-triggers-design.md), on the board's demo data
// (docs/mocks/condition-triggers/01-board.png): a Ceph capacity guard that is waiting and has fired once, a mon disk
// guard that cannot be read, a gateway guard that has fired and repeats on an Orbit Cloud workspace, and a task that
// starts when a third OSD is in. Plain data: unit tests and condition-triggers.capture.mjs read the same rows.

export const CONDITION_NOW = '2026-11-22T12:00:00.000Z';
const ago = (minutes) => new Date(Date.parse(CONDITION_NOW) - minutes * 60_000).toISOString();

export const HPC = { id: WORKSPACE.id, name: 'HPC', runner: 'workstation-gpu' };
export const CLOUD = { id: 'ws-orbit-cloud', name: 'Orbit Cloud', runner: 'orbit-cloud-1' };

export const IDS = {
  ceph: 'sch-ceph-capacity', mon: 'sch-mon-disk', gateway: 'sch-gateway-5xx',
  codex: 'sch-codex-stable', notes: 'sch-release-notes', pg: 'sch-pg-sweep',
  cephCondition: 'cond-ceph', monCondition: 'cond-mon', gatewayCondition: 'cond-gateway', osdCondition: 'cond-osd',
  osdTask: 'task-kubernetes-3-copies',
  cephRun: 'run-ceph-nov21', gatewayRun1: 'run-gateway-0805', gatewayRun2: 'run-gateway-1005',
  monItem: 'req-mon-cant-read', osdItem: 'req-osd-still-waiting',
};

// ── conditions ────────────────────────────────────────────────────────────────────────────────

function rule(c, runsPerWeek) {
  return {
    kind: 'WHEN', conditionId: c.id, runsPerWeek,
    condition: {
      text: c.text, command: c.probe.command, compare: c.compare, holdSeconds: c.holdSeconds, rearm: c.rearm,
      intervalSeconds: c.intervalSeconds, unit: c.unit, timeoutSeconds: c.probe.timeoutSeconds, repeatSeconds: c.repeatSeconds,
    },
  };
}

function condition(over) {
  return {
    workspaceId: HPC.id, holdSeconds: 0, rearm: null, intervalSeconds: 300, repeatSeconds: null, state: 'WAITING',
    lastOutcome: 'VALUE', trueSince: null, unknownSince: null, unknownReason: null, failedChecks: 0, firedAt: null,
    approvedAt: '2026-11-17T09:20:00.000Z', taskId: null, scheduleId: null, createdAt: '2026-11-17T09:20:00.000Z',
    endedAt: null, keepsWorkspaceAwake: false, runnerName: HPC.runner, samples: [], events: [],
    ...over,
    lastReadAt: over.lastReadAt ?? over.lastSampleAt ?? null,
  };
}

/** Waiting, under the line; it fired once on Nov 21 and was ready again on Nov 22 (board ⑥). */
export const CEPH_CONDITION = condition({
  id: IDS.cephCondition, scheduleId: IDS.ceph, text: 'Raw used above 90%', unit: '%',
  probe: { command: 'ceph df -f json | jq .stats.total_used_raw_ratio', timeoutSeconds: 20 },
  compare: { op: 'GT', value: 90 }, holdSeconds: 600, rearm: { op: 'LT', value: 85 },
  lastValue: 6.9, lastSampleAt: ago(1), firedAt: '2026-11-21T03:12:00.000Z',
  events: [
    { at: '2026-11-22T09:40:00.000Z', kind: 'READY_AGAIN', value: 82.9, runId: null, repeat: false },
    { at: '2026-11-21T03:12:00.000Z', kind: 'FIRED', value: 90.4, runId: IDS.cephRun, repeat: false },
  ],
});

/** Can't read: the check timed out three times in a row (board ④ ⑥). */
export const MON_CONDITION = condition({
  id: IDS.monCondition, scheduleId: IDS.mon, text: 'Root disk below 5%', unit: '%',
  probe: { command: "df --output=pcent / | tail -1 | tr -dc '0-9'", timeoutSeconds: 20 },
  compare: { op: 'LT', value: 5 }, rearm: { op: 'GT', value: 10 },
  state: 'UNKNOWN', lastValue: 5, lastOutcome: 'TIMEOUT', lastSampleAt: ago(1), lastReadAt: ago(16),
  unknownSince: ago(1), unknownReason: 'TIMEOUT', failedChecks: 3,
  events: [{ at: ago(1), kind: 'CANT_READ', value: null, runId: null, repeat: false }],
});

/** Fired and still holding: it repeats every 2 hours, on an Orbit Cloud workspace it keeps awake. */
export const GATEWAY_CONDITION = condition({
  id: IDS.gatewayCondition, scheduleId: IDS.gateway, workspaceId: CLOUD.id, runnerName: CLOUD.runner,
  text: '5xx rate above 2%', unit: '%',
  probe: { command: 'curl -s localhost:9090/metrics | awk \'/^gateway_5xx_ratio/ {print $2}\'', timeoutSeconds: 20 },
  compare: { op: 'GT', value: 2 }, holdSeconds: 300, rearm: { op: 'LT', value: 1 }, intervalSeconds: 60, repeatSeconds: 7200,
  state: 'FIRED', lastValue: 3.4, lastSampleAt: ago(0.5), firedAt: '2026-11-22T08:05:00.000Z', trueSince: '2026-11-22T08:00:00.000Z',
  keepsWorkspaceAwake: true,
  events: [
    { at: '2026-11-22T10:05:00.000Z', kind: 'FIRED', value: 3.1, runId: IDS.gatewayRun2, repeat: true },
    { at: '2026-11-22T08:05:00.000Z', kind: 'FIRED', value: 2.6, runId: IDS.gatewayRun1, repeat: false },
  ],
});

/** A task's startWhen: once, when a third OSD is in (board ② ④). */
export const OSD_CONDITION = condition({
  id: IDS.osdCondition, taskId: IDS.osdTask, text: '3 or more OSDs are in', unit: 'in',
  probe: { command: 'ceph osd stat -f json | jq .num_in_osds', timeoutSeconds: 20 },
  compare: { op: 'GTE', value: 3 }, lastValue: 2, lastSampleAt: ago(3),
});

export const CONDITIONS = [CEPH_CONDITION, MON_CONDITION, GATEWAY_CONDITION, OSD_CONDITION];

const reading = (c) => ({ id: c.id, text: c.text, unit: c.unit, state: c.state, lastValue: c.lastValue, lastSampleAt: c.lastSampleAt });

// ── schedules ─────────────────────────────────────────────────────────────────────────────────

function schedule(over) {
  const ws = over.ws ?? HPC;
  const access = over.accessLevel ?? 'CHECK_ONLY';
  const runsPerWeek = over.runsPerWeek ?? 7;
  const { ws: _ws, ...rest } = over;
  return {
    intent: '', prompt: '', ruleText: '', timezone: 'UTC', workspaceId: ws.id, workspaceName: ws.name,
    agentId: null, agentName: null, engine: 'claude', accessLevel: access, may: '', runLimitMinutes: 30, runsPerWeek,
    envelope: { workspaceId: ws.id, accessLevel: access, runsPerWeek, runLimitMinutes: 30 },
    state: 'ACTIVE', heldReason: null, endedReason: null, note: null, revision: 1, startAt: '2026-11-17T09:20:00.000Z',
    endAt: null, nextDueAt: null, consecutiveFailures: 0, createdFromSessionId: null, createdAt: '2026-11-17T09:20:00.000Z',
    endedAt: null, condition: null, lastRun: null, pausedAt: null,
    ...rest,
  };
}

function run(over) {
  return {
    scheduleRevision: 1, trigger: 'CONDITION', attempt: 1, startedAt: over.plannedAt, endedAt: null, sessionId: null,
    key: null, summary: null, links: null, failureReason: null, heldReason: null, ...over,
  };
}

export const CEPH_RUN = run({
  id: IDS.cephRun, scheduleId: IDS.ceph, plannedAt: '2026-11-21T03:12:00.000Z', state: 'CHANGED',
  startedAt: '2026-11-21T03:12:20.000Z', endedAt: '2026-11-21T03:31:00.000Z', sessionId: SESSION.id,
  key: 'above-90@Nov 21', summary: 'Raw used 90.4%. Cause: old snapshots in kubernetes.',
});
const GATEWAY_RUNS = [
  run({ id: IDS.gatewayRun2, scheduleId: IDS.gateway, plannedAt: '2026-11-22T10:05:00.000Z', state: 'NO_CHANGE',
    endedAt: '2026-11-22T10:14:00.000Z', key: 'gateway-5xx@Nov 22', summary: 'Still the same upstream timeouts.' }),
  run({ id: IDS.gatewayRun1, scheduleId: IDS.gateway, plannedAt: '2026-11-22T08:05:00.000Z', state: 'CHANGED',
    endedAt: '2026-11-22T08:21:00.000Z', key: 'gateway-5xx@Nov 22', summary: 'Upstream timeouts from one node.' }),
];

const today = (time) => `2026-11-22T${time}:00.000Z`;
const tomorrow = (time) => `2026-11-23T${time}:00.000Z`;

export const SCHEDULES = {
  ceph: schedule({ id: IDS.ceph, title: 'Ceph capacity guard', rule: rule(CEPH_CONDITION, 3), runsPerWeek: 3, condition: reading(CEPH_CONDITION),
    intent: 'Tell me when Ceph is above 90%, and look at what can be cleared.', lastRun: CEPH_RUN }),
  mon: schedule({ id: IDS.mon, title: 'Mon disk guard', rule: rule(MON_CONDITION, 3), runsPerWeek: 3, condition: reading(MON_CONDITION) }),
  gateway: schedule({ id: IDS.gateway, ws: CLOUD, title: 'Gateway 5xx guard', rule: rule(GATEWAY_CONDITION, 14), runsPerWeek: 14,
    condition: reading(GATEWAY_CONDITION), lastRun: GATEWAY_RUNS[0],
    intent: 'Watch the gateway 5xx rate and tell me which upstream fails, again while it stays bad.' }),
  codex: schedule({ id: IDS.codex, ws: { id: 'ws-apiserver', name: 'apiserver' }, title: 'Codex stable check',
    rule: { kind: 'DAILY', time: '10:00' }, nextDueAt: tomorrow('10:00') }),
  notes: schedule({ id: IDS.notes, ws: { id: 'ws-baseline', name: 'Orbit baseline' }, title: 'Release notes draft',
    rule: { kind: 'WEEKLY', time: '17:00', weekdays: ['SUN'] }, nextDueAt: today('17:00'), accessLevel: 'OPEN_PR', runsPerWeek: 1 }),
  pg: schedule({ id: IDS.pg, ws: { id: 'ws-apiserver', name: 'apiserver' }, title: 'Nightly pg spec sweep',
    rule: { kind: 'DAILY', time: '02:00' }, nextDueAt: tomorrow('02:00') }),
};

/** The OPEN tasks waiting for their startWhen, as the list door adds them (`waitingTasks`). */
export const WAITING_TASKS = [
  { id: IDS.osdTask, title: 'Set kubernetes pool to 3 copies', workspaceId: HPC.id, workspaceName: HPC.name, condition: reading(OSD_CONDITION) },
];

export function conditionListAnswer() {
  return { schedules: Object.values(SCHEDULES), runs: [], waitingTasks: WAITING_TASKS };
}

function created(s) {
  return {
    kind: 'SCHEDULE_CHANGE_RECORD', scheduleId: s.id, title: s.title, revision: 1, changedBy: 'USER', sessionId: null,
    changed: ['accessLevel', 'envelope'], before: null,
    after: { accessLevel: s.accessLevel, envelope: s.envelope }, undoOfRevision: null, undoneByRevision: null,
    createdAt: s.createdAt, undo: null,
  };
}

const READ_BACK = {
  [IDS.ceph]: "Whenever Ceph's raw use goes above 90%, I look at what is using the space and propose what to clear. I tell you each time it crosses.",
  [IDS.mon]: 'When the mon\'s root disk drops below 5% free, I look at what filled it and propose what to clear.',
  [IDS.gateway]: 'When the gateway answers more than 2% of requests with a 5xx, I look at its logs and tell you which upstream fails.',
};
const RUNS = { [IDS.ceph]: [CEPH_RUN], [IDS.gateway]: GATEWAY_RUNS };

export function conditionScheduleDetail(id) {
  const s = Object.values(SCHEDULES).find((row) => row.id === id);
  const runs = RUNS[id] ?? [];
  return {
    schedule: s, readBack: READ_BACK[id] ?? s.intent, lastRun: runs[0] ?? null, recentRuns: runs, findings: [],
    usage: { since: '2026-11-01T00:00:00.000Z', runs: runs.length, minutes: runs.length * 17, costUsd: null, text: '' },
    history: [created(s)], pendingCards: [],
  };
}

// ── the task ──────────────────────────────────────────────────────────────────────────────────

/** The startWhen task as GET /tasks/:id reads it: OPEN, with its waiting line. */
export const OSD_TASK_START_WHEN = {
  conditionId: OSD_CONDITION.id, text: OSD_CONDITION.text, unit: OSD_CONDITION.unit, state: OSD_CONDITION.state,
  lastValue: OSD_CONDITION.lastValue, lastSampleAt: OSD_CONDITION.lastSampleAt, firedAt: null,
  waitingLine: `Waiting for: ${OSD_CONDITION.text}`,
};

// ── cards ─────────────────────────────────────────────────────────────────────────────────────

/** The task create card (board ②), as the runner files orbit_task_create with the server's preview. */
export const TASK_CREATE_APPROVAL = {
  id: 'appr-osd-task', sessionId: SESSION.id, toolName: 'orbit_task_create', status: 'PENDING', createdAt: ago(2),
  input: {
    title: 'Set kubernetes pool to 3 copies',
    description: 'When a third OSD is in, I check the cluster again and propose setting kubernetes to size 3. Nothing changes until you approve.',
    acceptanceCriteria: 'The kubernetes pool reports size 3 and every PG is active+clean.',
    completionCriterion: 'OWNER_CONFIRMED',
    startWhen: { text: OSD_CONDITION.text, command: OSD_CONDITION.probe.command, compare: OSD_CONDITION.compare, unit: 'in', baseline: { value: 2 } },
    preview: {
      taskCount: 1, startingNow: 0, blocked: 0, needsManualStart: 0, notDispatchable: 0, internalEdges: 0, externalEdges: 0,
      lists: [], assignees: [{ id: HPC.id, name: HPC.name, hasRunner: true }],
      tasks: [{
        title: 'Set kubernetes pool to 3 copies', dependsOnRefs: [], dependsOnTaskIds: [], ref: null,
        startWhen: {
          startsWhen: OSD_CONDITION.text,
          checked: `Once. Checked every 5 min on ${HPC.runner}, no model.`,
          command: OSD_CONDITION.probe.command,
          today: '2 in. Not yet.',
          ifNever: 'Asks you after 30 days of waiting',
          awake: null,
        },
      }],
      titlesTruncated: 0,
    },
  },
};

function cardBase(id, createdAt) {
  return {
    id, state: 'PENDING', askedBy: 'SESSION', askedBySessionId: SESSION.id, createdAt, decidedAt: null, resultRevision: null,
    decision: { allow: `/api/schedule-requests/${id}/allow`, decline: `/api/schedule-requests/${id}/decline` },
  };
}

function envelopeLines(ws, access, runs) {
  return {
    runsIn: { workspaceId: ws.id, workspaceName: ws.name, engine: 'claude', text: `${ws.name} · Claude agent` },
    may: { accessLevel: access, text: access },
    costs: { runsPerWeek: runs, runLimitMinutes: 30, text: '' },
  };
}

/** The schedule create card with a WHEN rule (board ③). */
export const WHEN_CREATE_CARD = {
  ...cardBase('req-ceph-create', ago(2)), kind: 'CREATE', scheduleId: null,
  title: 'Ceph capacity guard',
  readBack: READ_BACK[IDS.ceph],
  intent: 'Tell me when Ceph is above 90%, and look at what can be cleared.',
  when: {
    rule: { ...rule(CEPH_CONDITION, 3), conditionId: null }, timezone: 'UTC', firstRunAt: null,
    text: scheduleWhenLines(rule(CEPH_CONDITION, 3).condition, HPC.runner).text,
    condition: scheduleWhenLines(rule(CEPH_CONDITION, 3).condition, HPC.runner),
  },
  ...envelopeLines(HPC, 'CHECK_ONLY', 3),
  today: { key: '6.9%', summary: '6.9%. Nothing to report.', text: '6.9%. Nothing to report.' },
  notice: scheduleCreateNotice(null),
  envelope: null,
};

/** The same card on an Orbit Cloud workspace, with a repeat: one line each under When. */
export const WHEN_CREATE_CARD_REPEAT = {
  ...cardBase('req-gateway-create', ago(1)), kind: 'CREATE', scheduleId: null,
  title: 'Gateway 5xx guard',
  readBack: READ_BACK[IDS.gateway],
  intent: 'Watch the gateway 5xx rate and tell me which upstream fails.',
  when: {
    rule: { ...rule(GATEWAY_CONDITION, 14), conditionId: null }, timezone: 'UTC', firstRunAt: null,
    text: scheduleWhenLines(rule(GATEWAY_CONDITION, 14).condition, CLOUD.runner, true).text,
    condition: scheduleWhenLines(rule(GATEWAY_CONDITION, 14).condition, CLOUD.runner, true),
  },
  ...envelopeLines(CLOUD, 'CHECK_ONLY', 14),
  today: { key: '0.4%', summary: '0.4%. Nothing to report.', text: '0.4%. Nothing to report.' },
  notice: scheduleCreateNotice(null),
  envelope: null,
};

/** A run asks for a new probe command: the widen card (§4.1, board ⑥ note 3). */
export const COMMAND_WIDEN_CARD = {
  ...cardBase('req-ceph-command', ago(1)), kind: 'UPDATE', scheduleId: IDS.ceph,
  title: 'Ceph capacity guard', readBack: null, intent: null, when: null, runsIn: null, may: null, costs: null, today: null, notice: null,
  proposed: { rule: { ...rule(CEPH_CONDITION, 3), condition: { ...rule(CEPH_CONDITION, 3).condition,
    command: 'ceph df -f json | jq \'.stats.total_used_raw_ratio * 100\'' } } },
  envelope: {
    widens: ['PROBE_COMMAND'],
    now: { ...envelopeLines(HPC, 'CHECK_ONLY', 3) },
    asked: { ...envelopeLines(HPC, 'CHECK_ONLY', 3) },
  },
};

// ── Waiting on you ────────────────────────────────────────────────────────────────────────────

function item(over) {
  return {
    state: 'PENDING', blocksTaskIds: [], ifUnanswered: null, options: null, recommendedOption: null, steps: null,
    secretSpec: null, secretGrant: null, verifyHint: null, expiresAt: null, askedBySessionId: SESSION.id, projectId: null,
    resolvedAt: null, resolvedByUserId: null, resolvedBySessionId: null, resolutionNote: null, answer: null, ...over,
  };
}

/** The can't-read card (board ⑥), in the server's words (condition-attention.ts unknownCopy). */
export const MON_CANT_READ_ITEM = item({
  id: IDS.monItem, kind: 'CONDITION_UNKNOWN', conditionId: MON_CONDITION.id, workspaceId: HPC.id, createdAt: ago(1),
  title: "Can't read: Root disk below 5%",
  why: 'The check timed out 3 times in a row. The last reading was 5%, 16 minutes ago. It does not fire while it cannot '
    + 'be read, and its hold starts over. This closes by itself when a check reads again.',
});

/** The 30-day question (§6.2), in the server's words (condition-still-waiting.ts stillWaitingCopy). */
export const OSD_STILL_WAITING_ITEM = item({
  id: IDS.osdItem, kind: 'CONDITION_STILL_WAITING', conditionId: OSD_CONDITION.id, workspaceId: HPC.id, createdAt: ago(40),
  title: 'Still waiting for 3 or more OSDs are in. Keep waiting?',
  why: 'This task starts when 3 or more OSDs are in, and that has not held in 30 days. Keep waiting asks again in 30 days. '
    + 'Stop ends the check; the task stays open, and you can start it yourself.',
  options: [
    { label: 'Keep waiting', description: 'Ask again in 30 days.' },
    { label: 'Stop', description: 'End the check. The task stays open.' },
  ],
  recommendedOption: 0,
});

export const WAITING_ITEMS = [MON_CANT_READ_ITEM, OSD_STILL_WAITING_ITEM];
