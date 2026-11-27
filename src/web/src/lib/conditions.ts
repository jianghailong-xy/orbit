import { queryOptions } from '@tanstack/react-query';
import {
  SCHEDULE_CONDITION_COPY,
  SCHEDULE_COPY,
  scheduleDurationText,
  scheduleFill,
  scheduleRepeatText,
  type ConditionCompare,
  type ConditionEventView,
  type ConditionView,
  type ScheduleConditionReading,
  type ScheduleListResponse,
  type ScheduleListRow,
  type ScheduleWhenCondition,
} from '@orbit/shared';
import { api } from '../api';
import { streamPoll } from './listBudget';
import type { SessionReachDeclaration } from './sessionReach';
import { sameResourceId } from './watches';

/**
 * Conditions on the web (docs/condition-triggers-design.md §9, board docs/mocks/condition-triggers/01-board.png
 * frames 2 to 6): the Scheduled page's "Waiting for a condition" group, the inspector's Condition and How it checks
 * blocks, and the run session's firing line. The words the server already writes (the create cards' lines, the
 * Waiting on you items) are drawn as it sends them; these are the ones a client composes from a condition's read.
 */
export const CONDITION_COPY = {
  group: 'Waiting for a condition',
  cantRead: "Can't read",
  checked: 'checked {age}',
  notReadYet: 'not read yet',
  justNow: 'just now',
  minutesAgo: '{count} min ago',
  hoursAgo: '{count} h ago',
  daysAgo: '{count} days ago',
  /** A startWhen task's row: "Task · once, when 3 or more OSDs are in · HPC". */
  taskLine: 'Task · once, when {condition}',
  sections: { condition: 'Condition', howItChecks: 'How it checks' },
  fires: {
    GT: 'Fires above {value}',
    GTE: 'Fires at {value} or more',
    LT: 'Fires below {value}',
    LTE: 'Fires at {value} or less',
    EQ: 'Fires at {value}',
    EXIT_ZERO: 'Fires when the check succeeds',
  },
  held: ' for {duration}',
  readyAgain: {
    GT: 'Ready again above {value}.',
    GTE: 'Ready again at {value} or more.',
    LT: 'Ready again below {value}.',
    LTE: 'Ready again at {value} or less.',
    EQ: 'Ready again at {value}.',
    EXIT_ZERO: 'Ready again once the check succeeds.',
  },
  readyWhenFalse: 'Ready again once it no longer holds.',
  every: 'Every {interval} on {runner}, without a model.',
  everyNoRunner: 'Every {interval}, without a model.',
  approved: 'Read-only. Approved by you on {date}.',
  history: {
    fired: 'Fired',
    firedAgain: 'Fired again',
    readyAgain: 'Ready again',
    cantRead: "Can't read",
    readAgain: 'Reads again',
    askedStillWaiting: 'Asked whether to keep waiting',
    condition: 'Condition',
    run: 'Run',
  },
  /** The run session's header for a run its condition started: "Fired 03:12 · 90.4% for 10 min · Check only". */
  firedAt: 'Fired {time}',
  firedAgainAt: 'Fired again {time}',
  waitingKind: 'Condition',
  actions: { pause: 'Pause', lookIntoIt: 'Look into it' },
  createTaskHeading: '📝 Confirm: create 1 task that starts on a condition?',
  facts: { startsWhen: 'Starts when', today: 'Today', ifNever: 'If never' },
} as const;

const K = CONDITION_COPY;

/**
 * Fields the parallel C6 server reads add (condition-triggers project): the Scheduled list's startWhen tasks, the
 * runner a condition is checked on, and the condition a Waiting on you item is about. Optional here: an older server
 * leaves them out, and the page then draws the schedules alone.
 */
export interface ScheduleWaitingTask {
  id: string;
  title: string;
  workspaceId: string;
  workspaceName: string | null;
  condition: ScheduleConditionReading;
}
export type ConditionScheduleList = ScheduleListResponse & { waitingTasks?: ScheduleWaitingTask[] };
export type ConditionRead = ConditionView & { runnerName?: string | null };

/** `GET /api/conditions/:id`: a condition's state, newest samples and events. */
export const conditionQuery = (id: string) =>
  queryOptions({
    queryKey: ['conditions', id] as const,
    // What it reads moves on its probe's samples, which no event announces (its poll reads them); a session event
    // can move it only as the run of the task it starts (lib/sessionReach).
    meta: {
      entities: ['task', 'session'],
      sessionReach: ((data: unknown) => {
        const taskId = (data as { taskId?: string | null } | undefined)?.taskId;
        return taskId ? { task: taskId } : 'none';
      }) satisfies SessionReachDeclaration,
    },
    queryFn: () => api<ConditionRead>(`/conditions/${encodeURIComponent(id)}`),
    refetchInterval: streamPoll(30_000),
  });

/** A reading with its unit, as the server's cards write it: "6.9%", "2 in", "412 GiB". */
export function readingText(value: number, unit: string | null): string {
  const shown = Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  if (!unit) return shown;
  return unit === '%' ? `${shown}%` : `${shown} ${unit}`;
}

/** "1 min ago", "just now", "3 h ago": a reading's age. */
export function readingAgeText(at: string | null, now: number): string {
  if (!at) return K.notReadYet;
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  if (minutes < 1) return K.justNow;
  if (minutes < 60) return scheduleFill(K.minutesAgo, { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return scheduleFill(K.hoursAgo, { count: hours });
  return scheduleFill(K.daysAgo, { count: Math.floor(hours / 24) });
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** A condition that cannot be read: tagged Can't read, at the head of Waiting for a condition. */
export function conditionCantRead(reading: Pick<ScheduleConditionReading, 'state'> | null | undefined): boolean {
  return reading?.state === 'UNKNOWN';
}

/** A WHEN schedule's condition, from its rule. */
export function whenCondition(schedule: Pick<ScheduleListRow, 'rule'>): ScheduleWhenCondition | null {
  return schedule.rule.kind === 'WHEN' ? schedule.rule.condition : null;
}

/** "When raw used above 90% · HPC": a WHEN schedule's row line, without the access level the board leaves off. */
export function conditionScheduleLine(schedule: Pick<ScheduleListRow, 'rule' | 'workspaceName'>): string {
  const condition = whenCondition(schedule);
  const rule = condition ? scheduleFill(SCHEDULE_CONDITION_COPY.rules.long, { condition: lowerFirst(condition.text) }) : '';
  return [rule, schedule.workspaceName].filter(Boolean).join(SCHEDULE_COPY.separator);
}

/** "Task · once, when 3 or more OSDs are in · HPC". */
export function conditionTaskLine(task: ScheduleWaitingTask): string {
  return [scheduleFill(K.taskLine, { condition: lowerFirst(task.condition.text) }), task.workspaceName]
    .filter(Boolean)
    .join(SCHEDULE_COPY.separator);
}

/** A row's right side: the newest reading and its age. */
export function conditionRowReading(reading: ScheduleConditionReading, now: number): { value: string | null; age: string } {
  return {
    value: reading.lastValue === null ? null : readingText(reading.lastValue, reading.unit),
    age: readingAgeText(reading.lastSampleAt, now),
  };
}

function compareValue(compare: ConditionCompare | null, unit: string | null): string {
  return compare?.value === null || compare?.value === undefined ? '' : readingText(compare.value, unit);
}

/** "Fires above 90% for 10 min. Ready again below 85%." and, with a repeat, the repeat sentence. */
export function conditionFiringLines(c: {
  compare: ConditionCompare;
  holdSeconds: number;
  rearm: ConditionCompare | null;
  unit: string | null;
  repeatSeconds?: number | null;
}): { firing: string; repeat: string | null } {
  const fires = scheduleFill(K.fires[c.compare.op], { value: compareValue(c.compare, c.unit) })
    + (c.holdSeconds > 0 ? scheduleFill(K.held, { duration: scheduleDurationText(c.holdSeconds) }) : '');
  const ready = c.rearm ? scheduleFill(K.readyAgain[c.rearm.op], { value: compareValue(c.rearm, c.unit) }) : K.readyWhenFalse;
  return { firing: `${fires}. ${ready}`, repeat: scheduleRepeatText(c.repeatSeconds) };
}

/** "Every 5 min on workstation-gpu, without a model." */
export function conditionEveryText(intervalSeconds: number, runner: string | null | undefined): string {
  const interval = scheduleDurationText(intervalSeconds);
  return runner ? scheduleFill(K.every, { interval, runner }) : scheduleFill(K.everyNoRunner, { interval });
}

/**
 * Where the gauge bar puts the reading, the firing line and the re-arm line, as fractions of its width: on 0 to a
 * quarter past the largest of the three, and a percentage on no more than 0 to 100.
 */
export function conditionGauge(c: Pick<ConditionView, 'compare' | 'rearm' | 'unit' | 'lastValue'>): {
  value: number | null;
  fire: number | null;
  rearm: number | null;
} | null {
  if (c.compare.op === 'EXIT_ZERO' || c.compare.value === null || c.compare.value === undefined) return null;
  const numbers = [c.compare.value, c.rearm?.value ?? null, c.lastValue].filter((n): n is number => typeof n === 'number');
  const largest = Math.max(...numbers.map((n) => Math.abs(n)), 1) * 1.25;
  const max = c.unit === '%' ? Math.min(100, largest) : largest;
  const at = (n: number | null | undefined) => (typeof n === 'number' ? Math.min(1, Math.max(0, n / max)) : null);
  return { value: at(c.lastValue), fire: at(c.compare.value), rearm: at(c.rearm?.value) };
}

/** A history line for a FIRED or READY_AGAIN event, and for the can't-read spells: "Fired · 90.4% for 10 min". */
export function conditionEventText(event: ConditionEventView, c: { unit: string | null; holdSeconds: number }): string {
  const value = event.value === null ? null : readingText(event.value, c.unit);
  switch (event.kind) {
    case 'FIRED': {
      const what = event.repeat ? K.history.firedAgain : K.history.fired;
      if (!value) return what;
      const held = c.holdSeconds > 0 ? scheduleFill(K.held, { duration: scheduleDurationText(c.holdSeconds) }) : '';
      return `${what}${SCHEDULE_COPY.separator}${value}${held}`;
    }
    case 'READY_AGAIN':
      return value ? `${K.history.readyAgain}${SCHEDULE_COPY.separator}${value}` : K.history.readyAgain;
    case 'CANT_READ':
      return K.history.cantRead;
    case 'READ_AGAIN':
      return value ? `${K.history.readAgain}${SCHEDULE_COPY.separator}${value}` : K.history.readAgain;
    case 'ASKED_STILL_WAITING':
      return K.history.askedStillWaiting;
  }
}

/** The FIRED event that started a run, newest first as the read lists them. */
export function firingOfRun(c: Pick<ConditionView, 'events'> | null | undefined, runId: string): ConditionEventView | null {
  return c?.events.find((e) => e.kind === 'FIRED' && e.runId !== null && sameResourceId(e.runId, runId)) ?? null;
}
