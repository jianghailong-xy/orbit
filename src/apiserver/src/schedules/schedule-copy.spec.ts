/**
 * The server's schedule sentences are the boards' (docs/mocks/scheduled-tasks/web/capture/*.mjs, 01-board.html,
 * 02-agent-first.html), taken from @orbit/shared: each case pins what the server writes to the board's words AND to
 * the shared text function, so a sentence the server words by itself goes red here even when it still reads well.
 *
 * The last two cases read the source: no SCHEDULE_COPY phrase is spelled out as a literal in src/apiserver/src/
 * schedules or in PushService.notifySchedule, and none of the sentences the server used to write before it read the
 * shared copy is back.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  SCHEDULE_COPY,
  scheduleApprovalWaiting,
  scheduleCreateNotice,
  scheduleEnvelopeTitle,
  scheduleFailedPush,
  scheduleFailedWaiting,
  scheduleHeldWaiting,
  scheduleMayText as sharedMayText,
  scheduleRuleText as sharedRuleText,
  scheduleRunsInText,
  scheduleUsageText,
  scheduleWidenWaitingText,
} from '@orbit/shared';

import { approvalCopy, approvalPattern, failedCopy, goalReachedCopy, heldClause, heldCopy, widenCopy } from './schedule-attention';
import type { Envelope } from './schedule-envelope';
import { parseRule } from './schedule-time';
import { scheduleCardView, scheduleMayText, scheduleRuleText, scheduleUsageThisMonth, scheduleView } from './schedule-views';

const TZ = 'Asia/Shanghai';
const CHECK: Envelope = { workspaceId: 'ws-apiserver', accessLevel: 'CHECK_ONLY', runsPerWeek: 7, runLimitMinutes: 30 };
const PR: Envelope = { ...CHECK, accessLevel: 'OPEN_PR' };

function createCard(over: { engine?: string | null; findings?: string | null; timezone?: string | null } = {}) {
  const request = {
    id: 'r1',
    kind: 'CREATE',
    state: 'PENDING',
    askedBy: 'SESSION',
    askedBySessionId: 'sess-1',
    scheduleId: null,
    createdAt: new Date('2026-11-13T02:00:00Z'),
    decidedAt: null,
    resultRevision: null,
    envelopeAsked: CHECK,
    envelopeBefore: null,
    widens: [],
    proposed: {
      title: 'Codex stable check',
      intent: 'every day at 10 check codex',
      rule: { kind: 'DAILY', time: '10:00' },
      timezone: over.timezone === undefined ? TZ : over.timezone,
      findings: over.findings ?? null,
    },
  };
  return scheduleCardView(request as never, {
    workspaces: new Map([['ws-apiserver', 'apiserver']]),
    engines: new Map([['sess-1', over.engine === undefined ? 'codex' : over.engine]]),
    schedules: new Map(),
    now: new Date('2026-11-13T04:00:00Z'), // 12:00 in Shanghai: the next 10:00 is tomorrow
  });
}

test('(a) rules: the cards\' short form, as the boards write it', () => {
  const cases: [unknown, string][] = [
    [{ kind: 'DAILY', time: '10:00' }, 'Daily 10:00'],
    [{ kind: 'WEEKLY', time: '10:00', weekdays: ['MON'] }, 'Mondays 10:00'],
    [{ kind: 'WEEKLY', time: '09:00', weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] }, 'Weekdays at 09:00'],
    [{ kind: 'ONCE', at: '2026-11-16T18:00' }, 'Once'],
  ];
  for (const [raw, board] of cases) {
    const rule = parseRule(raw);
    assert.equal(scheduleRuleText(rule), board);
    assert.equal(scheduleRuleText(rule), sharedRuleText(rule as never, 'short'));
  }
  const card = createCard();
  assert.equal(card.when?.text, 'Daily 10:00 · Asia/Shanghai · first run tomorrow', '1/2 ④, 02-agent-first create card When');
});

test('(b) access: the May line and the Asked side say "Open a PR" and "It can\'t merge or deploy."', () => {
  assert.equal(scheduleMayText('CHECK_ONLY'), 'Check only · reads and reports, edits nothing');
  assert.equal(scheduleMayText('OPEN_PR'), "Open a PR · edits in its own worktree and opens a PR. It can't merge or deploy.");
  for (const level of ['CHECK_ONLY', 'OPEN_PR', 'LAND'] as const) assert.equal(scheduleMayText(level), sharedMayText(level));
});

test('(c, d) a failure: "failed 3 runs in a row", "ended without a report", in the card and in the push', () => {
  const copy = failedCopy({
    title: 'Nightly pg spec sweep',
    consecutiveFailures: 3,
    failureReason: 'NO_REPORT',
    plannedAt: new Date('2026-11-13T18:00:00Z'), // Nov 14, 02:00 in Shanghai
    timezone: TZ,
  });
  assert.equal(copy.title, 'Nightly pg spec sweep failed 3 runs in a row');
  assert.equal(
    copy.why,
    'The last run ended without a report (Nov 14, 02:00). It keeps running on schedule until you pause it. Open the '
    + 'run to see where it stopped, or ask a session to fix the prompt.',
  );
  assert.equal(copy.body, 'The last run ended without a report. It keeps running until you pause it.', '1/2 ⑤ push');
  const input = {
    title: 'Nightly pg spec sweep',
    consecutiveFailures: 3,
    run: { failureReason: 'NO_REPORT', reasonText: null, plannedAt: '2026-11-13T18:00:00.000Z' },
    timezone: TZ,
  };
  assert.deepEqual(
    { title: copy.title, body: copy.body, why: copy.why },
    { title: scheduleFailedPush(input).title, body: scheduleFailedPush(input).body, why: scheduleFailedWaiting(input).body },
  );
  assert.equal(
    failedCopy({ ...input, failureReason: 'ENGINE_CRASHED', plannedAt: new Date(input.run.plannedAt), consecutiveFailures: 1 }).title,
    'Nightly pg spec sweep failed',
  );
});

test('a reported failure says what the run reported, in one line of at most 120 characters', () => {
  const base = {
    title: 'Codex stable check',
    consecutiveFailures: 1,
    failureReason: 'REPORTED_FAILED',
    plannedAt: new Date('2026-11-14T02:00:00Z'), // Nov 14, 10:00 in Shanghai
    timezone: TZ,
  };
  const copy = failedCopy({ ...base, summary: 'The releases page returned 503.' });
  assert.equal(copy.title, 'Codex stable check failed');
  assert.equal(copy.body, 'The last run reported a failure: The releases page returned 503. It keeps running until you pause it.');
  assert.equal(
    copy.why,
    'The last run reported a failure: The releases page returned 503 (Nov 14, 10:00). It keeps running on schedule until '
    + 'you pause it. Open the run to see where it stopped, or ask a session to fix the prompt.',
  );
  const run = { failureReason: 'REPORTED_FAILED', reasonText: null, summary: 'The releases page returned 503.', plannedAt: base.plannedAt.toISOString() };
  const shared = { title: base.title, consecutiveFailures: 1, run, timezone: TZ };
  assert.equal(copy.body, scheduleFailedPush(shared).body);
  assert.equal(copy.why, scheduleFailedWaiting(shared).body);
  assert.ok(copy.why.includes(SCHEDULE_COPY.failureReasonsWithSummary.REPORTED_FAILED.replace('{summary}', 'The releases page returned 503')));
  // A long summary is one line of 120 characters.
  const long = failedCopy({ ...base, summary: `Line one\n${'x'.repeat(200)}` }).why;
  const said = long.slice('The last run reported a failure: '.length, long.indexOf(' (Nov 14'));
  assert.equal(said.length, 120);
  assert.ok(said.startsWith('Line one x') && said.endsWith('…'));
  // With no summary, and for every other reason, the board's own clause.
  assert.match(failedCopy({ ...base, summary: null }).why, /^The last run reported a failure \(Nov 14, 10:00\)\. /);
  assert.match(failedCopy({ ...base, failureReason: 'NO_REPORT', summary: 'ignored' }).why, /^The last run ended without a report \(/);
});

test('(c, e) a hold: "is held", naming the agent and its workspace', () => {
  const input = {
    title: 'Weekly dependency audit',
    reason: 'AGENT_DISABLED',
    plannedAt: new Date('2026-11-09T01:00:00Z'), // Monday 09:00 in Shanghai
    agentName: 'auditor',
    workspaceName: 'web',
    now: new Date('2026-11-14T03:00:00Z'),
    timezone: TZ,
  };
  const copy = heldCopy(input);
  assert.equal(copy.title, 'Weekly dependency audit is held');
  assert.equal(
    copy.why,
    'It could not start on Monday 09:00: the agent "auditor" in workspace web is disabled. Nothing runs until it is '
    + 'enabled and you resume.',
  );
  assert.equal(copy.body, copy.why, 'the push says what the card says');
  const shared = scheduleHeldWaiting({ ...input, heldReason: input.reason, plannedAt: input.plannedAt.toISOString() });
  assert.deepEqual({ title: copy.title, why: copy.why }, { title: shared.title, why: shared.body });
  // A refusal's message names neither: the boards' clause with "its agent".
  assert.equal(heldClause('AGENT_DISABLED'), 'its agent is disabled');
  assert.equal(
    heldClause('MODE_WIDER_THAN_ACCOUNT_DEFAULT'),
    SCHEDULE_COPY.heldReasons.MODE_WIDER_THAN_ACCOUNT_DEFAULT.clause,
  );
});

test('(c) a run\'s card: "wants to run a command", with its deadline and the next run', () => {
  const input = {
    title: 'Nightly pg spec sweep',
    deadline: new Date('2026-11-13T20:00:00Z'), // 04:00 in Shanghai
    nextAt: new Date('2026-11-14T18:00:00Z'), // tomorrow 02:00
    pattern: approvalPattern('Bash', { command: 'psql -h 127.0.0.1 -p 55490 -c "select 1"' }),
    workspaceName: 'apiserver',
    now: new Date('2026-11-13T18:03:00Z'),
    timezone: TZ,
  };
  assert.equal(input.pattern, 'psql:*');
  const copy = approvalCopy(input);
  assert.equal(copy.title, 'Nightly pg spec sweep wants to run a command');
  assert.equal(copy.body, 'If nobody answers by 04:00 this run fails; the next one starts tomorrow.');
  assert.equal(
    copy.why,
    "If nobody answers by 04:00 this run fails; the next one starts tomorrow. Always allow covers psql:* in apiserver: "
    + "later runs won't ask for this.",
  );
  const shared = scheduleApprovalWaiting({ ...input, deadline: input.deadline.toISOString(), nextAt: input.nextAt.toISOString() });
  assert.deepEqual(
    { title: copy.title, why: copy.why, body: copy.body },
    { title: shared.title, why: `${shared.body} ${shared.alwaysAllow}`, body: shared.body },
  );
  assert.equal(approvalCopy({ ...input, pattern: '' }).why, shared.body, 'a card with no rule to remember says no more');
});

test('(c) a run\'s widen: "Let X open PRs?", with Now and Asked', () => {
  const input = {
    title: 'Codex stable check',
    reason: 'Its run of Nov 13 found 0.49.0 and asks to open the upgrade PR itself from now on.',
    widens: ['ACCESS_LEVEL'] as const,
    now: CHECK,
    asked: PR,
    ruleNow: { kind: 'DAILY', time: '10:00' } as const,
    ruleAsked: null,
    workspaceNames: { 'ws-apiserver': 'apiserver' },
  };
  const copy = widenCopy({ ...input, widens: [...input.widens] });
  assert.equal(copy.title, 'Let Codex stable check open PRs?');
  assert.equal(
    copy.why,
    'Its run of Nov 13 found 0.49.0 and asks to open the upgrade PR itself from now on. Now: Check only. Asked: Open a '
    + "PR · edits in its own worktree and opens a PR. It can't merge or deploy.",
  );
  assert.equal(copy.title, scheduleEnvelopeTitle(input.title, input.widens));
  assert.equal(copy.why, scheduleWidenWaitingText({ ...input, widens: [...input.widens] }));
});

test('a run ending its own schedule: "X ended itself"', () => {
  assert.equal(goalReachedCopy('Release 2.0 freeze watch').title, 'Release 2.0 freeze watch ended itself');
});

test('(f) Runs in: "apiserver · Codex agent"', () => {
  const card = createCard();
  assert.equal(card.runsIn?.text, 'apiserver · Codex agent');
  assert.equal(card.runsIn?.text, scheduleRunsInText('apiserver', 'codex'));
  assert.equal(createCard({ engine: 'claude' }).runsIn?.text, 'apiserver · Claude agent');
  assert.equal(createCard({ engine: null }).runsIn?.text, 'apiserver');
});

test('(g) usage: "14 runs · 41 min", the block\'s title This month being the client\'s', async () => {
  const start = new Date('2026-11-10T02:00:00Z');
  const runs = Array.from({ length: 14 }, (_, i) => ({
    startedAt: start,
    endedAt: new Date(start.getTime() + (i === 0 ? 41 : 0) * 60_000),
    sessionId: null,
  }));
  const tx = { scheduleRun: { findMany: async () => runs } };
  const usage = await scheduleUsageThisMonth(tx as never, { id: 's1', timezone: TZ }, new Date('2026-11-14T03:00:00Z'));
  assert.equal(usage.text, '14 runs · 41 min');
  assert.equal(usage.text, scheduleUsageText(usage));
});

test('(h) the notice says what this task finds, as the boards do per task', () => {
  assert.equal(createCard({ findings: 'versions' }).notice, "You'll hear about new versions and failures only.");
  assert.equal(createCard({ findings: 'issues' }).notice, "You'll hear about new issues and failures only.");
  assert.equal(createCard().notice, "You'll hear about new findings and failures only.", 'a card that names none');
  assert.equal(createCard({ findings: 'versions' }).notice, scheduleCreateNotice('versions'));
});

test('(e) a schedule\'s view names its agent and the engine its runs start on', () => {
  const row = {
    id: 's1', title: 'Weekly dependency audit', intent: '', prompt: '', rule: { kind: 'DAILY', time: '10:00' }, timezone: TZ,
    workspaceId: 'ws-web', agentId: 'ag-1', accessLevel: 'CHECK_ONLY', runLimitMinutes: 30, envelopeWorkspaceId: 'ws-web',
    envelopeAccessLevel: 'CHECK_ONLY', envelopeRunsPerWeek: 7, envelopeRunLimitMinutes: 30, state: 'HELD',
    heldReason: 'AGENT_DISABLED', endedReason: null, note: null, revision: 1, startAt: new Date(), endAt: null,
    nextDueAt: null, consecutiveFailures: 0, createdFromSessionId: 'sess-1', createdAt: new Date(), endedAt: null,
  };
  const view = scheduleView(row as never, new Map([['ws-web', 'web']]), {
    agents: new Map([['ag-1', 'auditor']]),
    engines: new Map([['sess-1', 'codex']]),
  });
  assert.equal(view.agentName, 'auditor');
  assert.equal(view.engine, 'codex');
  assert.equal(view.ruleText, 'Daily 10:00');
  const bare = scheduleView(row as never, new Map());
  assert.equal(bare.agentName, null);
  assert.equal(bare.engine, null);
});

// ---------------------------------------------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------------------------------------------

const SRC = join(__dirname, '..', '..', 'src');

/** The string literals of a file, comments left out. */
function literals(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  return [...code.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0].slice(1, -1));
}

function serverSources(): { file: string; text: string }[] {
  const dir = join(SRC, 'schedules');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => ({ file: `schedules/${f}`, text: readFileSync(join(dir, f), 'utf8') }));
  const push = readFileSync(join(SRC, 'push', 'push.service.ts'), 'utf8');
  const at = push.indexOf('async notifySchedule(');
  assert.ok(at > 0, 'PushService.notifySchedule');
  files.push({ file: 'push/push.service.ts notifySchedule', text: push.slice(at, push.indexOf('\n  }\n', at)) });
  return files;
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

test('no board phrase is spelled out on the server: each comes from SCHEDULE_COPY', () => {
  // Each phrase of the copy between its placeholders, long enough to be a phrase and not a word ("Open", "Held") or
  // a refusal's "is no longer yours".
  const phrases = [...new Set(strings(SCHEDULE_COPY).flatMap((s) => s.split(/\{\w+\}/)).map((s) => s.trim()))]
    .filter((s) => s.length >= 20 && s.includes(' '));
  assert.ok(phrases.length > 30, `${phrases.length} phrases`);
  const found: string[] = [];
  for (const { file, text } of serverSources()) {
    for (const literal of literals(text)) {
      for (const phrase of phrases) if (literal.includes(phrase)) found.push(`${file} spells out "${phrase}" in '${literal}'`);
    }
  }
  assert.deepEqual(found, []);
});

test('none of the sentences the server wrote before it read the shared copy is back', () => {
  const old = [
    'is on hold', 'needs your approval', 'asks to do more', 'runs in a row;', 'ended without reporting',
    "won't run until you resume it", 'This month: ', 'Weekdays ${', 'Weekly ${', 'Once ${', 'Open PR',
    "; can't merge or deploy", 'A run is waiting to use', 'The last run failed: ',
  ];
  for (const { file, text } of serverSources()) {
    for (const literal of literals(text)) {
      for (const phrase of old) assert.ok(!literal.includes(phrase), `${file}: '${literal}'`);
    }
  }
});

test('a check-only approval names the complete command, while other approvals keep their prefixes', () => {
  const command = `python3 -c "print(open('watched.txt').read())"`;
  assert.equal(approvalPattern('Bash', { command }, true), command);
  assert.equal(approvalPattern('Bash', { command, orbitScheduleCheckOnly: true }), command);
  assert.equal(approvalPattern('Bash', { command: 'cd db && psql -c "select 1"' }), 'cd:*, psql:*');
  // An interpreter is never remembered: python3:* would cover every script.
  assert.equal(approvalPattern('Bash', { command }), '');
});
