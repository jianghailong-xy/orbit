import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SCHEDULE_ACCESS_LEVELS,
  SCHEDULE_CHANGED_BY,
  SCHEDULE_CIRCLES,
  SCHEDULE_CONTROL_REFUSALS,
  SCHEDULE_COPY,
  SCHEDULE_RUN_STATUS_COPY,
  SCHEDULE_ENDED_REASONS,
  SCHEDULE_ENVELOPE_PARTS,
  SCHEDULE_FAILURE_REASONS,
  SCHEDULE_HELD_REASONS,
  SCHEDULE_REQUEST_KINDS,
  SCHEDULE_REQUEST_STATES,
  SCHEDULE_RUN_SESSION_STATES,
  SCHEDULE_RUN_STATES,
  SCHEDULE_RUN_TRIGGERS,
  SCHEDULE_STALE_REASONS,
  SCHEDULE_STATES,
  SCHEDULE_WAITING_KINDS,
  SCHEDULE_WEEKDAYS,
  type ScheduleChangeRecord,
  scheduleAllowedText,
  scheduleChangeLineText,
  scheduleCostsParts,
  scheduleCreateNotice,
  scheduleEndText,
  scheduleMissedText,
  scheduleFailedPush,
  scheduleGoalReachedPushTitle,
  scheduleEnvelopeNote,
  scheduleEnvelopeSides,
  scheduleEnvelopeTitle,
  scheduleHistoryWho,
  scheduleKeepLabel,
  scheduleMayText,
  schedulePhoneRowLine,
  scheduleRecordText,
  scheduleRuleText,
  scheduleUsageText,
  scheduleWidenWaitingText,
} from './schedule';

/**
 * Holds src/shared/src/schedule.ts to contracts/schedule.contract.json: the copy byte for byte, the closed sets
 * against the server's own (schema.prisma, schedule-attention.ts, schedule-envelope.ts), and every board phrase the
 * contract lists against the function that has to produce it.
 */

const ROOT = path.resolve(__dirname, '../../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CONTRACT: any = JSON.parse(read('contracts/schedule.contract.json'));
const SCHEMA = read('src/apiserver/prisma/schema.prisma');

function prismaEnum(name: string): string[] {
  const body = SCHEMA.match(new RegExp(`enum ${name} \\{([^}]*)\\}`))?.[1] ?? '';
  return body.split('\n').map((l) => l.trim()).filter((l) => /^[A-Z_]+$/.test(l));
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

describe('schedule contract', () => {
  it('SCHEDULE_COPY is the contract copy, byte for byte', () => {
    expect(CONTRACT.copy).toEqual(JSON.parse(JSON.stringify(SCHEDULE_COPY)));
  });

  it('SCHEDULE_RUN_STATUS_COPY is the contract runStatusCopy, byte for byte', () => {
    expect(CONTRACT.runStatusCopy).toEqual(JSON.parse(JSON.stringify(SCHEDULE_RUN_STATUS_COPY)));
  });

  it('every line is English', () => {
    for (const s of strings(SCHEDULE_COPY)) expect(s, s).not.toMatch(/[㐀-鿿]/);
  });

  it('the closed sets are the contract sets', () => {
    expect(CONTRACT.closedSets).toEqual(JSON.parse(JSON.stringify({
      scheduleStates: SCHEDULE_STATES,
      accessLevels: SCHEDULE_ACCESS_LEVELS,
      changedBy: SCHEDULE_CHANGED_BY,
      endedReasons: SCHEDULE_ENDED_REASONS,
      runTriggers: SCHEDULE_RUN_TRIGGERS,
      runStates: SCHEDULE_RUN_STATES,
      failureReasons: SCHEDULE_FAILURE_REASONS,
      heldReasons: SCHEDULE_HELD_REASONS,
      envelopeParts: SCHEDULE_ENVELOPE_PARTS,
      requestKinds: SCHEDULE_REQUEST_KINDS,
      requestStates: SCHEDULE_REQUEST_STATES,
      waitingKinds: SCHEDULE_WAITING_KINDS,
      runSessionStates: SCHEDULE_RUN_SESSION_STATES,
      staleReasons: SCHEDULE_STALE_REASONS,
      weekdays: SCHEDULE_WEEKDAYS,
      controlRefusals: SCHEDULE_CONTROL_REFUSALS,
      circles: SCHEDULE_CIRCLES,
    })));
  });

  it('the closed sets match the server', () => {
    expect([...SCHEDULE_STATES]).toEqual(prismaEnum('ScheduleState'));
    expect([...SCHEDULE_ACCESS_LEVELS]).toEqual(prismaEnum('ScheduleAccessLevel'));
    expect([...SCHEDULE_CHANGED_BY]).toEqual(prismaEnum('ScheduleChangedBy'));
    expect([...SCHEDULE_ENDED_REASONS]).toEqual(prismaEnum('ScheduleEndedReason'));
    expect([...SCHEDULE_RUN_TRIGGERS]).toEqual(prismaEnum('ScheduleRunTrigger'));
    expect([...SCHEDULE_RUN_STATES]).toEqual(prismaEnum('ScheduleRunState'));
    expect([...SCHEDULE_REQUEST_KINDS]).toEqual(prismaEnum('ScheduleChangeRequestKind'));
    expect([...SCHEDULE_REQUEST_STATES]).toEqual(prismaEnum('ScheduleChangeRequestState'));
    const attention = read('src/apiserver/src/schedules/schedule-attention.ts');
    expect(attention).toContain(`SCHEDULE_ITEM_KINDS = [${SCHEDULE_WAITING_KINDS.map((k) => `'${k}'`).join(', ')}]`);
    const envelope = read('src/apiserver/src/schedules/schedule-envelope.ts');
    expect(envelope).toContain(`EnvelopePart = ${SCHEDULE_ENVELOPE_PARTS.map((p) => `'${p}'`).join(' | ')}`);
    const runs = read('src/apiserver/src/schedules/schedule-runs.service.ts');
    expect(runs).toContain(`state: ${SCHEDULE_RUN_SESSION_STATES.map((s) => `'${s}'`).join(' | ')}`);
    const design = read('docs/scheduled-tasks-design.md');
    for (const reason of SCHEDULE_HELD_REASONS) expect(design).toContain(`\`${reason}\``);
    for (const reason of SCHEDULE_FAILURE_REASONS.filter((r) => r !== 'OVER_BUDGET')) expect(design).toContain(`\`${reason}\``);
  });

  it('every run state and reason has its words', () => {
    expect(Object.keys(SCHEDULE_COPY.runStates)).toEqual([...SCHEDULE_RUN_STATES]);
    expect(Object.keys(SCHEDULE_COPY.failureReasons)).toEqual([...SCHEDULE_FAILURE_REASONS]);
    expect(Object.keys(SCHEDULE_COPY.heldReasons)).toEqual([...SCHEDULE_HELD_REASONS]);
    expect(Object.keys(SCHEDULE_COPY.endedReasons)).toEqual([...SCHEDULE_ENDED_REASONS]);
    expect(Object.keys(SCHEDULE_COPY.access)).toEqual([...SCHEDULE_ACCESS_LEVELS]);
    expect(Object.keys(SCHEDULE_COPY.envelopeCard.titles).sort()).toEqual([...SCHEDULE_ENVELOPE_PARTS].sort());
  });

  it('the server reads its sentences from here (src/apiserver/src/schedules/schedule-copy.spec.ts pins each)', () => {
    const views = read('src/apiserver/src/schedules/schedule-views.ts');
    for (const fn of ['scheduleCreateNotice', 'scheduleCreateWhen', 'scheduleMayText', 'scheduleRunsInText', 'scheduleUsageText']) {
      expect(views, fn).toContain(`  ${fn},`);
    }
    const attention = read('src/apiserver/src/schedules/schedule-attention.ts');
    for (const fn of [
      'scheduleApprovalWaiting', 'scheduleFailedPush', 'scheduleFailedWaiting', 'scheduleHeldClause', 'scheduleHeldWaiting',
      'scheduleWidenWaitingText', 'scheduleEnvelopeTitle', 'scheduleGoalReachedPushTitle', 'scheduleStoppedAsPlannedText',
    ]) {
      expect(attention, fn).toContain(`  ${fn},`);
    }
  });

  it('the server writes the Costs line with the shared function', () => {
    const views = read('src/apiserver/src/schedules/schedule-views.ts');
    expect(views).toMatch(/import \{\n  scheduleCostsText,\n[^}]*\} from '@orbit\/shared';/);
    expect(views).not.toMatch(/function scheduleCostsText/);
  });
});

describe('board phrases', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const P: any = CONTRACT.boardPhrases;

  it('the pushes and the create card\'s last line', () => {
    // 1/2 ⑤: the failure's banner.
    expect(scheduleFailedPush({
      title: 'Nightly pg spec sweep',
      consecutiveFailures: 3,
      run: { failureReason: 'NO_REPORT', reasonText: null, plannedAt: '2026-11-13T18:00:00.000Z' },
      timezone: 'Asia/Shanghai',
    })).toEqual({
      title: 'Nightly pg spec sweep failed 3 runs in a row',
      body: 'The last run ended without a report. It keeps running until you pause it.',
    });
    // A reported failure says what the run reported.
    expect(scheduleFailedPush({
      title: 'Codex stable check',
      consecutiveFailures: 1,
      run: { failureReason: 'REPORTED_FAILED', reasonText: null, summary: 'The releases page returned 503.', plannedAt: '2026-11-14T02:00:00.000Z' },
      timezone: 'Asia/Shanghai',
    }).body).toBe('The last run reported a failure: The releases page returned 503. It keeps running until you pause it.');
    // 02-agent-first ⑤: a run that ended its own schedule.
    expect(scheduleGoalReachedPushTitle('Release 2.0 freeze watch')).toBe('Release 2.0 freeze watch ended itself');
    // 2/2 ①, 1/2 ④: per task.
    expect(scheduleCreateNotice('versions')).toBe("You'll hear about new versions and failures only.");
    expect(scheduleCreateNotice('issues')).toBe("You'll hear about new issues and failures only.");
    expect(scheduleCreateNotice(null)).toBe(SCHEDULE_COPY.createCard.notice);
    expect(scheduleCreateNotice('findings')).toBe(SCHEDULE_COPY.createCard.notice);
  });

  it.each(P.rules.map((r: { text: string; form: string }) => [`${r.form}: ${r.text}`, r]))('rule %s', (_n, r: any) => {
    expect(scheduleRuleText(r.rule, r.form)).toBe(r.text);
  });

  it.each(P.costs.map((c: { text: string }) => [c.text, c]))('costs %s', (_n, c: any) => {
    const parts = scheduleCostsParts(c.runsPerWeek, c.runLimitMinutes);
    expect(parts.text).toBe(c.text);
    expect(parts.emphasis).toBe(c.emphasis);
    expect(parts.before + parts.emphasis + parts.after).toBe(c.text);
  });

  it('allowed, usage, may', () => {
    for (const a of P.allowed) expect(scheduleAllowedText(a)).toBe(a.text);
    for (const u of P.usage) expect(scheduleUsageText(u)).toBe(u.text);
    for (const m of P.may) expect(scheduleMayText(m.accessLevel)).toBe(m.text);
  });

  it.each(P.envelope.map((e: { board: string }) => [e.board, e]))('envelope card %s', (_n, e: any) => {
    const sides = scheduleEnvelopeSides(e);
    expect(sides.now?.text).toBe(e.nowText);
    expect(sides.asked.text).toBe(e.askedText);
    expect(sides.asked.lead).toBe(e.askedLead);
    expect(scheduleEnvelopeTitle('Codex stable check', e.widens)).toBe(e.title);
    expect(scheduleKeepLabel(e.widens, e.now)).toBe(e.keep);
    expect(scheduleEnvelopeNote(e.widens)).toBe(e.note);
    if (e.waitingBody) expect(scheduleWidenWaitingText({ ...e, reason: e.waitingReason })).toBe(e.waitingBody);
  });

  it.each(P.phoneRows.map((r: { text: string }) => [r.text, r]))('phone row %s', (_n, r: any) => {
    expect(schedulePhoneRowLine(r.schedule, r.opts)).toBe(r.text);
  });

  it('every held reason has its few words', () => {
    expect(Object.keys(SCHEDULE_COPY.heldShort)).toEqual([...SCHEDULE_HELD_REASONS]);
  });

  it.each(P.history.map((h: { text: string }) => [h.text, h]))('history %s', (_n, h: any) => {
    const record: ScheduleChangeRecord = {
      kind: 'SCHEDULE_CHANGE_RECORD',
      scheduleId: 's1',
      title: h.title ?? 'Codex stable check',
      revision: h.revision ?? 4,
      changedBy: h.changedBy,
      sessionId: null,
      changed: Object.keys(h.after),
      before: h.before,
      after: h.after,
      undoOfRevision: null,
      undoneByRevision: null,
      createdAt: '2026-11-14T04:19:00.000Z',
      undo: null,
    };
    expect(scheduleRecordText(record)).toBe(h.text);
    expect(scheduleHistoryWho(record).text).toBe(h.who);
    if (h.line) expect(scheduleChangeLineText(record)).toBe(h.line);
  });

  it('the board copy the capture scripts show is in SCHEDULE_COPY', () => {
    const all = new Set(strings(SCHEDULE_COPY));
    for (const s of [
      'Scheduled', 'All workspaces', 'Show past runs', 'Today', 'Tomorrow', 'Monday', 'Paused',
      'Failed 3 in a row'.replace('3', '{count}'), 'Held', 'Failed', 'Known', 'New', 'Next run', 'Last', 'Run now',
      'Pause', 'Change…', 'What it does', 'What was asked', 'Notes for the next run', 'This month', 'History',
      'Create scheduled task?', 'When', 'Runs in', 'May', 'Costs', 'Not now', 'Create', 'Open conversation', 'Allow',
      'Keep weekly', 'Keep check only', 'Undo', 'Open', 'Waiting on you', 'Open run', 'Pause schedule',
      'Open agent settings', 'Resume', 'Always allow', 'Allow once', 'Deny', 'Scheduled run',
      'Describe a scheduled task…', '↵ to ask', 'Applies from the next run.',
      'Nothing scheduled. Say what should happen and when; an agent sets it up and asks you once.',
      'Every day at 10:00, check the Codex stable release against our pinned version',
      'Every Monday at 9, list dependencies with known vulnerabilities',
      'At 18:00 today, check that the deploy is healthy and tell me',
      'Waiting for you to confirm', 'Waiting for you to allow', 'You', 'Session', 'Run', 'You allowed',
      'ended without a report', 'running for {minutes} min', 'draft, waiting for you', 'you were notified',
      'not notified', 'Left by the run of {date}', 'Your words in {session}, {date}',
    ]) {
      expect(all.has(s), s).toBe(true);
    }
  });
  it('words the planned end, the collapsed missed row and a maxRuns revision from the contract copy', () => {
    const now = new Date('2025-11-14T04:30:00.000Z');
    const end = (endAt: string | null, maxRuns: number | null, runsLeft: number | null) =>
      scheduleEndText({ endAt, maxRuns, runsLeft }, now, 'Asia/Shanghai');
    expect(end('2025-11-14T10:00:00.000Z', null, null)).toBe('until 18:00 today');
    expect(end('2025-11-15T10:00:00.000Z', null, null)).toBe('until 18:00 tomorrow');
    expect(end('2025-11-25T10:00:00.000Z', null, null)).toBe('until Nov 25');
    expect(end(null, 6, 3)).toBe('3 runs left');
    expect(end(null, 6, 1)).toBe('1 run left');
    expect(end(null, null, null)).toBeNull();
    expect(scheduleMissedText(
      [{ plannedAt: '2025-11-13T17:00:00.000Z' }, { plannedAt: '2025-11-14T00:30:00.000Z' }], 'Asia/Shanghai',
    )).toBe('2 slots missed, 01:00–08:30');
    expect(scheduleMissedText(
      [{ plannedAt: '2025-11-19T22:00:00.000Z' }, { plannedAt: '2025-11-20T06:30:00.000Z' }], 'UTC',
    )).toBe('2 slots missed, Nov 19, 22:00–Nov 20, 06:30');
    const record = (before: unknown, after: unknown) => ({
      before: { maxRuns: before }, after: { maxRuns: after }, revision: 3,
    } as unknown as ScheduleChangeRecord);
    expect(scheduleRecordText(record(4, 6))).toContain('Runs 4 → 6');
    expect(scheduleRecordText(record(4, null))).toContain('Runs 4 → no end');
  });
});
