/**
 * Scheduled tasks for the clients (docs/scheduled-tasks-design.md §9.2): the words the boards put on screen, the
 * shapes the REST doors answer with (§9.1, src/apiserver/src/schedules/schedule-views.ts), and the pure rules that
 * turn those shapes into what a client draws — the timeline's groups, a row's circle, a rule in words, the Costs
 * line, an envelope card's Now / Asked, and who made a change in the history.
 *
 * The copy is held to contracts/schedule.contract.json (`copy`) byte for byte, so OrbitKit and Android can pin the
 * same words. The boards are docs/mocks/scheduled-tasks/web/01-board.png, web/02-board.png and 02-agent-first.png;
 * their text is in web/capture/*.mjs and 02-agent-first.html. Placeholders are `{name}`, filled by scheduleFill.
 */

import { CONDITION_KEEPS_AWAKE_LINE, type ConditionCompareOp, type ConditionState } from './condition';

// ---------------------------------------------------------------------------------------------------------------
// Closed sets (schema.prisma, schedule-envelope.ts, schedule-attention.ts, schedule-runs.service.ts)
// ---------------------------------------------------------------------------------------------------------------

export const SCHEDULE_STATES = ['ACTIVE', 'PAUSED', 'HELD', 'ENDED'] as const;
export type ScheduleState = (typeof SCHEDULE_STATES)[number];

export const SCHEDULE_ACCESS_LEVELS = ['CHECK_ONLY', 'OPEN_PR', 'LAND'] as const;
export type ScheduleAccessLevel = (typeof SCHEDULE_ACCESS_LEVELS)[number];

export const SCHEDULE_CHANGED_BY = ['USER', 'SESSION', 'RUN'] as const;
export type ScheduleChangedBy = (typeof SCHEDULE_CHANGED_BY)[number];

export const SCHEDULE_ENDED_REASONS = ['DELETED', 'END_REACHED', 'GOAL_REACHED'] as const;
export type ScheduleEndedReason = (typeof SCHEDULE_ENDED_REASONS)[number];

/** CONDITION: a WHEN rule's condition fired; its `plannedAt` is the firing sample's time. */
export const SCHEDULE_RUN_TRIGGERS = ['SCHEDULED', 'CATCH_UP', 'MANUAL', 'CONDITION'] as const;
export type ScheduleRunTrigger = (typeof SCHEDULE_RUN_TRIGGERS)[number];

export const SCHEDULE_RUN_STATES = [
  'QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'NO_CHANGE', 'CHANGED', 'FAILED', 'SKIPPED', 'MISSED', 'HELD', 'CANCELLED',
] as const;
export type ScheduleRunState = (typeof SCHEDULE_RUN_STATES)[number];

/** §7.2, plus OVER_BUDGET, which S2d adds for a MISSED run. */
export const SCHEDULE_FAILURE_REASONS = [
  'RUNNER_UNAVAILABLE', 'RUNNER_FULL', 'QUOTA', 'ENGINE_CRASHED_BEFORE_START', 'REPORTED_FAILED', 'NO_REPORT', 'ENGINE_CRASHED',
  'APPROVAL_TIMEOUT', 'RUN_LIMIT', 'CANCELLED_BY_OWNER', 'OVER_BUDGET', 'LANDING_FAILED',
] as const;
export type ScheduleFailureReason = (typeof SCHEDULE_FAILURE_REASONS)[number];

/** §6.1. */
export const SCHEDULE_HELD_REASONS = [
  'WORKSPACE_NOT_OWNED', 'WORKSPACE_DELETED', 'WORKSPACE_DISABLED', 'AGENT_MISSING', 'AGENT_DISABLED',
  'OUTSIDE_ENVELOPE', 'ACCESS_NOT_ENFORCEABLE', 'MODE_WIDER_THAN_ACCOUNT_DEFAULT', 'NO_REPOSITORY', 'SESSION_REFUSED', 'WORKTREE_DISABLED',
] as const;
export type ScheduleHeldReason = (typeof SCHEDULE_HELD_REASONS)[number];

/** PROBE_COMMAND: a WHEN rule's probe command other than the one the owner approved. */
export const SCHEDULE_ENVELOPE_PARTS = ['WORKSPACE', 'ACCESS_LEVEL', 'RUNS_PER_WEEK', 'RUN_LIMIT', 'PROBE_COMMAND'] as const;
export type ScheduleEnvelopePart = (typeof SCHEDULE_ENVELOPE_PARTS)[number];

export const SCHEDULE_REQUEST_KINDS = ['CREATE', 'UPDATE'] as const;
export type ScheduleRequestKind = (typeof SCHEDULE_REQUEST_KINDS)[number];

export const SCHEDULE_REQUEST_STATES = ['PENDING', 'ALLOWED', 'DECLINED', 'SUPERSEDED'] as const;
export type ScheduleRequestState = (typeof SCHEDULE_REQUEST_STATES)[number];

/** The Waiting on you kinds no session can file (schedule-attention.ts). */
export const SCHEDULE_WAITING_KINDS = ['SCHEDULE_FAILED', 'SCHEDULE_HELD', 'SCHEDULE_APPROVAL', 'SCHEDULE_WIDEN'] as const;
export type ScheduleWaitingKind = (typeof SCHEDULE_WAITING_KINDS)[number];

/** Where a run's session stands in the history (§7.4). */
export const SCHEDULE_RUN_SESSION_STATES = ['OPEN', 'COMPLETED', 'TRASH', 'GONE'] as const;
export type ScheduleRunSessionState = (typeof SCHEDULE_RUN_SESSION_STATES)[number];

/** Why Allow withdrew a card instead of applying it (409 SCHEDULE_REQUEST_STALE). */
export const SCHEDULE_STALE_REASONS = ['REVISION_MOVED', 'WORKSPACE_GONE'] as const;
export type ScheduleStaleReason = (typeof SCHEDULE_STALE_REASONS)[number];

export const SCHEDULE_WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type ScheduleWeekday = (typeof SCHEDULE_WEEKDAYS)[number];

/** The refusals a control (Run now, Pause, Resume, Undo, Delete, Stop) can answer with; OVER_BUDGET comes with S2d. */
export const SCHEDULE_CONTROL_REFUSALS = [
  'SCHEDULE_NOT_FOUND', 'SCHEDULE_ENDED', 'SCHEDULE_NOT_ACTIVE', 'SCHEDULE_NOT_PAUSED', 'SCHEDULE_START_CHECK_FAILED',
  'SCHEDULE_LIMIT', 'SCHEDULE_UNDO_STALE', 'SCHEDULE_ALREADY_UNDONE', 'SCHEDULE_UNDO_CREATION',
  'SCHEDULE_REVISION_NOT_FOUND', 'SCHEDULE_RUN_NOT_FOUND', 'SCHEDULE_RUN_NOT_ACTIVE', 'SCHEDULE_RUN_ENDED',
  'SCHEDULE_OVER_BUDGET',
] as const;
export type ScheduleControlRefusal = (typeof SCHEDULE_CONTROL_REFUSALS)[number];

// ---------------------------------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------------------------------

export const SCHEDULE_COPY = {
  nav: { scheduled: 'Scheduled' },
  page: {
    title: 'Scheduled',
    allWorkspaces: 'All workspaces',
    showPastRuns: 'Show past runs',
  },
  groups: {
    TODAY: 'Today',
    TOMORROW: 'Tomorrow',
    LATER: 'Later',
    PAUSED: 'Paused',
  },
  /** A day of the rest of the week, as a group name and in "First run Monday". */
  weekdays: {
    MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday', SUN: 'Sunday',
  },
  /** "Mondays 10:00". */
  weekdaysPlural: {
    MON: 'Mondays', TUE: 'Tuesdays', WED: 'Wednesdays', THU: 'Thursdays', FRI: 'Fridays', SAT: 'Saturdays', SUN: 'Sundays',
  },
  weekdaysShort: { MON: 'Mon', TUE: 'Tue', WED: 'Wed', THU: 'Thu', FRI: 'Fri', SAT: 'Sat', SUN: 'Sun' },
  months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  /** A day as a group's subtitle ("Fri, Nov 14", "Nov 17") and as a date in a sentence ("Nov 13"). */
  dates: {
    dayWithWeekday: '{weekday}, {month} {day}',
    day: '{month} {day}',
    today: 'Today',
    tomorrow: 'Tomorrow',
    todayLower: 'today',
    tomorrowLower: 'tomorrow',
    at: '{day} {time}',
  },
  /** A rule in words: `short` on cards and in the iOS inspector, `long` on a row's second line and the web inspector. */
  rules: {
    short: {
      daily: 'Daily {time}',
      weekday: '{weekdays} {time}',
      weekdays: 'Weekdays at {time}',
      days: '{days} {time}',
      once: 'Once',
    },
    long: {
      daily: 'Every day at {time}',
      weekday: 'Every {weekday} at {time}',
      weekdays: 'Weekdays at {time}',
      days: 'Every {days} at {time}',
      once: 'Once',
    },
    daysSeparator: ', ',
  },
  separator: ' · ',
  access: {
    CHECK_ONLY: { label: 'Check only', detail: 'reads and reports, edits nothing', brief: 'reads and reports' },
    OPEN_PR: {
      label: 'Open a PR',
      detail: "edits in its own worktree and opens a PR. It can't merge or deploy.",
      brief: "edits in its own worktree and opens a PR. It can't merge or deploy.",
    },
    LAND: {
      label: 'Edit and land on main',
      detail: "edits in its own worktree, then Orbit merges it into main after the run. It can't release or deploy.",
      brief: "edits in its own worktree, then Orbit merges it into main after the run. It can't release or deploy.",
    },
  },
  landing: { landed: 'Landed on main: {sha}.', failed: 'Could not land on main: {reason}' },
  costs: {
    upTo: 'Up to {runs}, {minutes} min each',
    upToLower: 'up to {runs}, {minutes} min each',
    runsOnly: 'up to {runs}',
    runs: { one: '{count} run a week', other: '{count} runs a week' },
    allowed: 'Allowed: {costs}',
  },
  row: {
    runningFor: 'running for {minutes} min',
    pausedOn: 'paused {date}',
    draft: 'draft, waiting for you',
    notified: 'you were notified',
    notNotified: 'not notified',
    /** The phone's row line (schedulePhoneRowLine): "Daily 12:00 · web · running 21 min", "… · draft". */
    runningShort: 'running {minutes} min',
    draftShort: 'draft',
  },
  tags: {
    failedInARow: 'Failed {count} in a row',
    held: 'Held',
    failed: 'Failed',
    known: 'Known',
    new: 'New',
  },
  /** Every run state's label, for the history and a past row's tag. */
  runStates: {
    QUEUED: 'Queued',
    RUNNING: 'Running',
    AWAITING_APPROVAL: 'Waiting for you',
    NO_CHANGE: 'No change',
    CHANGED: 'Changed',
    FAILED: 'Failed',
    SKIPPED: 'Skipped',
    MISSED: 'Missed',
    HELD: 'Held',
    CANCELLED: 'Cancelled',
  },
  /** Why a run failed, as a clause ("The last run ended without a report"); a run's own reasonText wins. */
  failureReasons: {
    RUNNER_UNAVAILABLE: 'found no runner online',
    RUNNER_FULL: 'waited for a full runner until its window closed',
    QUOTA: "hit the engine's usage limit",
    ENGINE_CRASHED_BEFORE_START: 'stopped before its engine started',
    REPORTED_FAILED: 'reported a failure',
    NO_REPORT: 'ended without a report',
    ENGINE_CRASHED: 'ended when its engine stopped',
    APPROVAL_TIMEOUT: 'waited 2 hours for an approval with no answer',
    RUN_LIMIT: 'ran past its run limit',
    CANCELLED_BY_OWNER: 'was stopped by you',
    OVER_BUDGET: 'was over what you allowed this week',
    LANDING_FAILED: 'could not land on main',
  },
  /** A run's reasonText as the server writes it (ScheduleRunView.reasonText), for the reasons whose sentence is shared. */
  runReasonTexts: {
    OVER_BUDGET: 'Not started: it had already started as many scheduled runs in the past 7 days as you allowed.',
  },
  /** A failure that reported what went wrong says it, in the failure card and its push (one line, 120 characters). */
  failureReasonsWithSummary: {
    REPORTED_FAILED: 'reported a failure: {summary}',
    LANDING_FAILED: 'could not land on main: {summary}',
  },
  /** Why a schedule is held, as a clause; `until` is what has to change before Resume. */
  heldReasons: {
    WORKSPACE_NOT_OWNED: { clause: 'the workspace {workspace} is no longer yours', until: 'it is yours again' },
    WORKSPACE_DELETED: { clause: 'the workspace {workspace} was deleted', until: 'it runs in another workspace' },
    WORKSPACE_DISABLED: { clause: 'the workspace {workspace} is disabled', until: 'it is enabled' },
    AGENT_MISSING: { clause: 'the agent "{agent}" no longer exists', until: 'it has an agent' },
    AGENT_DISABLED: { clause: 'the agent "{agent}" is disabled', until: 'it is enabled' },
    OUTSIDE_ENVELOPE: { clause: 'it no longer fits what you allowed', until: 'you allow it' },
    ACCESS_NOT_ENFORCEABLE: {
      clause: 'the engine it would run on cannot enforce its access level',
      until: 'it runs on an engine that can',
    },
    MODE_WIDER_THAN_ACCOUNT_DEFAULT: {
      // Says what to change: Plan as the account default holds a CHECK_ONLY run on Claude Code (Default, §6.2) and
      // every OPEN_PR run; Default holds neither.
      clause:
        "your account's default permission mode is narrower than its runs use (set it to Default in Settings > General)",
      until: 'your default mode allows it',
    },
    NO_REPOSITORY: { clause: 'the workspace {workspace} has no repository', until: 'it has one' },
    SESSION_REFUSED: { clause: "its run's session could not be opened", until: 'that is fixed' },
    WORKTREE_DISABLED: { clause: 'the workspace {workspace} has worktrees disabled', until: 'worktrees are enabled' },
  },
  heldWhere: ' in workspace {workspace}',
  /** Why a schedule is held, as the few words the phone's row line has room for ("agent disabled"). */
  heldShort: {
    WORKSPACE_NOT_OWNED: 'workspace not yours',
    WORKSPACE_DELETED: 'workspace deleted',
    WORKSPACE_DISABLED: 'workspace disabled',
    AGENT_MISSING: 'agent missing',
    AGENT_DISABLED: 'agent disabled',
    OUTSIDE_ENVELOPE: 'outside what you allowed',
    ACCESS_NOT_ENFORCEABLE: 'access not enforceable',
    MODE_WIDER_THAN_ACCOUNT_DEFAULT: 'wider than your default mode',
    NO_REPOSITORY: 'no repository',
    SESSION_REFUSED: 'session refused',
    WORKTREE_DISABLED: 'worktrees disabled',
  },
  endedReasons: {
    DELETED: 'deleted',
    END_REACHED: 'its end time passed',
    GOAL_REACHED: 'goal reached',
  },
  inspector: {
    nextRun: 'Next run',
    last: 'Last',
    whatItDoes: 'What it does',
    whatWasAsked: 'What was asked',
    yourWordsIn: 'Your words in {session}, {date}',
    notesForNextRun: 'Notes for the next run',
    leftByRunOf: 'Left by the run of {date}',
    thisMonth: 'This month',
    usage: { one: '{runs} run · {minutes} min', other: '{runs} runs · {minutes} min' },
    history: 'History',
    session: 'session',
    late: 'late',
    draftMeta: 'Draft · set up by the agent in {workspace} from what you typed',
  },
  actions: {
    runNow: 'Run now',
    pause: 'Pause',
    resume: 'Resume',
    change: 'Change…',
    rename: 'Rename…',
    delete: 'Delete',
    undo: 'Undo',
    open: 'Open',
    create: 'Create',
    notNow: 'Not now',
    openConversation: 'Open conversation',
    allow: 'Allow',
    openRun: 'Open run',
    pauseSchedule: 'Pause schedule',
    openSchedule: 'Open schedule',
    openAgentSettings: 'Open agent settings',
    alwaysAllow: 'Always allow',
    allowOnce: 'Allow once',
    deny: 'Deny',
    stop: 'Stop',
    openLastRun: 'Open last run',
  },
  deleteConfirm: {
    title: 'Delete “{title}”?',
    body:
      'It stops running: a run waiting to start is cancelled, and one under way finishes. Its runs and their '
      + 'sessions are kept, but the Scheduled page no longer shows it or its history, and you cannot undo this here.',
    confirm: 'Delete',
    cancel: 'Cancel',
  },
  /** The phone's Rename… (§8.4 *Rename*): an alert with one text field. Web and macOS edit the title in place. */
  renameAlert: {
    title: 'Rename Schedule',
    body: 'Only the name changes. When it runs and what it does stay the same.',
    cancel: 'Cancel',
    save: 'Save',
  },
  /** The phone's Stop on a run under way: asks first, as Delete does. */
  stopConfirm: {
    title: 'Stop this run?',
    body: 'It ends where it is and counts as stopped by you. Its session is kept, and the schedule runs again at its next time.',
    confirm: 'Stop',
    cancel: 'Cancel',
  },
  /** The decline button of an envelope card, by what it widens. */
  keep: {
    ACCESS_LEVEL: 'Keep check only',
    RUNS_PER_WEEK: 'Keep weekly',
    RUN_LIMIT: 'Keep {minutes} min',
    WORKSPACE: 'Keep in {workspace}',
    other: 'Keep as it is',
  },
  every: {
    minutes: 'Every {count} min',
    hour: 'Every hour',
    hours: 'Every {count} hours',
    window: '{interval}, {time}–{until}',
    from: '{interval} from {time}',
    days: '{rule}, {days}',
    workweek: 'Mon–Fri',
    weekend: 'weekends',
  },
  /** The planned end (§8.5) and the line a run of missed slots collapses into. */
  end: {
    until: 'until {when}',
    today: '{time} today',
    tomorrow: '{time} tomorrow',
    runLeft: '1 run left',
    runsLeft: '{count} runs left',
    missed: '{count} slots missed, {from}–{to}',
    missedDated: '{count} slots missed, {fromDate}, {from}–{toDate}, {to}',
    endLabel: 'Ends',
    extend: 'Extend the end',
    remove: 'Remove the end',
    extendAsk: '{title}: extend the end',
    removeAsk: '{title}: remove the end',
  },
  history: {
    who: { USER: 'You', SESSION: 'Session', RUN: 'Run', ALLOWED: 'You allowed' },
    fields: {
      title: 'Name',
      prompt: 'Prompt',
      readBack: 'Read-back',
      intent: 'What was asked',
      rule: 'Time',
      timezone: 'Time zone',
      endAt: 'Ends',
      maxRuns: 'Runs',
      accessLevel: 'Access',
      runLimitMinutes: 'Run limit',
      workspaceId: 'Workspace',
    },
    change: '{field} {before} → {after}',
    changeTo: '{field} → {after}',
    changeText: '{field}: {after}',
    ruleChange: '{before} → {after}',
    created: 'Created · {access} · {runs}',
    paused: 'Paused',
    resumed: 'Resumed',
    ended: 'Ended: {reason}',
    renamed: 'Renamed from “{title}”',
    minutes: '{minutes} min',
    noEnd: 'no end',
  },
  /** A schedule's change conversation (§8.2, board 03-change): Orbit's opening, its strip, its input. */
  changeConversation: {
    title: 'Change {title}',
    lead: 'What should change about {title}? This is what it does now:',
    does: 'Does',
    when: 'When',
    runsIn: 'Runs in',
    may: 'May',
    costs: 'Costs',
    tail:
      'I can change the time, the days, what it checks and how it reports right away, and you can undo it. More runs, '
      + 'longer runs, more access or another workspace need your Allow.',
    placeholder: 'Say what to change…',
    openSchedule: 'Open',
    openInScheduled: 'Open in Scheduled',
    conversation: 'conversation',
  },
  record: {
    changed: 'Changed {title}: {change}',
    ended: 'Ended {title}: {reason} · {by}',
    byThisRun: 'by this run',
    byYou: 'by you',
    byASession: 'by a session',
  },
  createCard: {
    title: 'Create scheduled task?',
    when: 'When',
    runsIn: 'Runs in',
    may: 'May',
    costs: 'Costs',
    today: 'Today',
    firstRun: 'First run {day}',
    firstRunInline: 'first run {day}',
    runsInEngine: '{workspace} · {engine} agent',
    zoneFromDevice: 'your time zone',
    notice: "You'll hear about new findings and failures only.",
    /** The notice with what this task finds ("versions", "issues"), as the boards word it per task. */
    noticeAbout: "You'll hear about new {findings} and failures only.",
  },
  envelopeCard: {
    landTitle: 'Let {title} land on main?',
    titles: {
      ACCESS_LEVEL: 'Let {title} open PRs?',
      RUNS_PER_WEEK: 'Let {title} run more often?',
      RUN_LIMIT: 'Let {title} run longer?',
      WORKSPACE: 'Let {title} run in {workspace}?',
      PROBE_COMMAND: 'Let {title} check with a new command?',
    },
    now: 'Now',
    asked: 'Asked',
    accessJoin: ' — ',
    appliesFromNextRun: 'Applies from the next run.',
    checkedEachRun: 'Each run checks this again before it starts.',
  },
  sessionPreview: {
    create: 'Waiting for you to confirm',
    envelope: 'Waiting for you to allow',
  },
  waiting: {
    title: 'Waiting on you',
    kinds: { schedule: 'Scheduled', run: 'Scheduled run' },
    failed: {
      title: '{title} failed',
      titleInARow: '{title} failed {count} runs in a row',
      body:
        'The last run {reason} ({when}). It keeps running on schedule until you pause it. Open the run to see where '
        + 'it stopped, or ask a session to fix the prompt.',
    },
    held: {
      title: '{title} is held',
      body: 'It could not start on {when}: {reason}. Nothing runs until {until} and you resume.',
    },
    approval: {
      title: '{title} wants to run a command',
      body: 'If nobody answers by {deadline} this run fails; the next one starts {next}.',
      alwaysAllow: "Always allow covers {pattern} in {workspace}: later runs won't ask for this.",
    },
    widen: {
      body: '{reason} Now: {now}. Asked: {asked}',
    },
  },
  /** A push's banner where it is not the Waiting on you card's own words (board 1/2 ⑤, 2/2 ④). */
  push: {
    failedBody: 'The last run {reason}. It keeps running until you pause it.',
    goalReachedTitle: '{title} ended itself',
    /**
     * §7.1: a run failed NO_REPORT or ENGINE_CRASHED that reported after the owner wrote to its session; replaces the
     * failure banner.
     */
    reportedLateTitle: '{title} reported after all',
    /** §8.5: a planned end (endAt or maxRuns) reached; also the ENDED row's read. */
    stoppedAsPlanned: 'Stopped as planned after {runs}',
  },
  empty: {
    lead: 'Nothing scheduled. Say what should happen and when; an agent sets it up and asks you once.',
    examples: [
      'Every day at 10:00, check the Codex stable release against our pinned version',
      'Every Monday at 9, list dependencies with known vulnerabilities',
      'At 18:00 today, check that the deploy is healthy and tell me',
    ],
  },
  quickAdd: {
    placeholder: 'Describe a scheduled task…',
    hint: '↵ to ask',
  },
  runSession: {
    crumb: 'Scheduled',
    runOf: 'run of {date}',
    strip: 'Scheduled run · planned {planned}, started {started} · access {access}',
    reported: 'Reported: {state}',
    agent: '{engine} agent',
    duration: '{minutes} min',
  },
} as const;

/** Fill `{name}` placeholders; a placeholder with no value is left as it is, so a missing value shows. */
export function scheduleFill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

const C = SCHEDULE_COPY;

/**
 * A WHEN rule's words (docs/condition-triggers-design.md §6.1; condition-triggers board ③ ⑥): the rule as a row and a
 * card say it, the create card's When lines, and what an envelope card for a new probe command says beside its title
 * (SCHEDULE_COPY.envelopeCard.titles.PROBE_COMMAND). Not yet in contracts/schedule.contract.json: OrbitKit and Android
 * take it there when they draw these lines (C6).
 */
export const SCHEDULE_CONDITION_COPY = {
  rules: {
    /** "Raw used above 90%": the condition in the agent's words. */
    short: '{condition}',
    long: 'When {condition}',
  },
  /** "Raw used above 90% for 10 min". */
  held: '{condition} for {duration}',
  rearm: 'Fires again only after it {rearm}.',
  rearmWhenFalse: 'Fires again once it no longer holds.',
  rearmOps: {
    GT: 'goes above {value}',
    GTE: 'reaches {value}',
    LT: 'drops below {value}',
    LTE: 'drops to {value}',
    EQ: 'reads {value}',
    EXIT_ZERO: 'succeeds again',
  },
  /** A repeat (§5.1): one more line under When, and the inspector's Condition block, in words. */
  repeat: 'And again every {interval} while it stays that way.',
  repeatUnits: { hour: 'hour', hours: '{count} hours', minute: 'minute', minutes: '{count} minutes' },
  checked: 'Checked every {interval} on {runner}, no model.',
  checkedNoRunner: 'Checked every {interval}, no model.',
  /** Under the check line, when the workspace is on Orbit Cloud (§4.2): it stays awake while the condition waits. */
  keepsAwake: CONDITION_KEEPS_AWAKE_LINE,
  seconds: '{count} s',
  minutes: '{count} min',
  hours: '{count} h',
  /** The decline button of a card for a new probe command. */
  keep: 'Keep the approved command',
  /** Under a card for a new probe command: changing the command is changing what was approved (board ⑥). */
  commandNote: 'It runs on its own, without a model, every time the condition is checked. Read it before you allow it.',
} as const;

const CC = SCHEDULE_CONDITION_COPY;

// ---------------------------------------------------------------------------------------------------------------
// REST shapes (schedule-views.ts, schedule-reads.service.ts, schedules.controller.ts)
// ---------------------------------------------------------------------------------------------------------------

/** A WHEN rule's condition (docs/condition-triggers-design.md §3), every default written out. */
export interface ScheduleWhenCondition {
  text: string;
  command: string;
  compare: { op: ConditionCompareOp; value: number | null };
  holdSeconds: number;
  rearm: { op: ConditionCompareOp; value: number | null } | null;
  intervalSeconds: number;
  unit: string | null;
  timeoutSeconds: number;
  /** Fire again every this many seconds while it still holds; null (or absent on an older rule) fires once. */
  repeatSeconds?: number | null;
}

export type ScheduleRule =
  | { kind: 'ONCE'; at: string }
  | { kind: 'DAILY'; time: string }
  | { kind: 'WEEKLY'; time: string; weekdays: ScheduleWeekday[] }
  /**
   * Sub-daily: slots every `minutes` (30, 60, 120, 180, 240, 360, 480 or 720) from `time` through `until`
   * (inclusive) or the end of the day, on `weekdays`, on the local wall clock. The server always writes `time` and
   * `weekdays`, so a client that predates EVERY reads it as a weekly rule.
   */
  | { kind: 'EVERY'; minutes: number; time: string; weekdays: ScheduleWeekday[]; until?: string }
  /** Starts when its condition fires; `conditionId` is null on a create card, before Create writes the condition. */
  | { kind: 'WHEN'; conditionId: string | null; runsPerWeek: number; condition: ScheduleWhenCondition };

/** A WHEN schedule's condition as a list shows it: the newest reading and its age (condition-triggers board ④). */
export interface ScheduleConditionReading {
  id: string;
  text: string;
  unit: string | null;
  state: ConditionState;
  lastValue: number | null;
  lastSampleAt: string | null;
}

export interface ScheduleEnvelope {
  workspaceId: string;
  accessLevel: ScheduleAccessLevel;
  runsPerWeek: number;
  runLimitMinutes: number;
  /** A WHEN rule's approved probe command, as its sha256; null or absent for a timed schedule. */
  commandHash?: string | null;
}

export interface ScheduleLink {
  url: string;
  title?: string | null;
}

/** `GET /api/schedules/:id/runs`, `lastRun`, `recentRuns`, `POST /api/schedules/:id/run`. */
export interface ScheduleRunView {
  id: string;
  scheduleId: string;
  scheduleRevision: number;
  plannedAt: string;
  trigger: ScheduleRunTrigger;
  state: ScheduleRunState;
  attempt: number;
  startedAt: string | null;
  endedAt: string | null;
  sessionId: string | null;
  key: string | null;
  summary: string | null;
  links: unknown;
  /** A closed set (§7.2); typed loosely so a reason added later does not break a client. */
  failureReason: ScheduleFailureReason | (string & {}) | null;
  heldReason: ScheduleHeldReason | (string & {}) | null;
  /** S2d: the server's own line for why the run did not happen; preferred over the client's words when present. */
  reasonText?: string | null;
  /** Where the run's session stands (§7.4), where the door reads it. */
  session?: { id: string; state: ScheduleRunSessionState } | null;
}

/** A schedule as the list and the inspector read it. */
export interface ScheduleView {
  id: string;
  title: string;
  intent: string;
  prompt: string;
  rule: ScheduleRule;
  /** The server's own words for the rule ("Daily 10:00"); clients draw scheduleRuleText. */
  ruleText: string;
  timezone: string;
  workspaceId: string;
  workspaceName: string | null;
  agentId: string | null;
  /** The agent's name, so a hold can say 'the agent "auditor" is disabled'; null when it names none or is gone. */
  agentName: string | null;
  /** The engine its runs start on when the conversation it came from still names one ("codex"), else null. */
  engine: string | null;
  accessLevel: ScheduleAccessLevel;
  may: string;
  runLimitMinutes: number;
  runsPerWeek: number;
  envelope: ScheduleEnvelope;
  state: ScheduleState;
  heldReason: ScheduleHeldReason | (string & {}) | null;
  endedReason: ScheduleEndedReason | null;
  note: string | null;
  revision: number;
  startAt: string;
  /** The planned end by time (§8.5); null for none. */
  endAt: string | null;
  /** The planned end by count of started runs (§8.5); null for none. Absent from servers before it. */
  maxRuns?: number | null;
  /** The runs it has started in all, counted as the weekly budget counts them. Absent from servers before it. */
  runsStarted?: number;
  /** maxRuns minus runsStarted, at least 0; null without maxRuns. Absent from servers before it. */
  runsLeft?: number | null;
  nextDueAt: string | null;
  consecutiveFailures: number;
  createdFromSessionId: string | null;
  createdAt: string;
  endedAt: string | null;
  /** A WHEN rule's condition and its newest reading; null for a timed schedule. */
  condition?: ScheduleConditionReading | null;
}

export interface ScheduleListRow extends ScheduleView {
  lastRun: ScheduleRunView | null;
  /** When a PAUSED schedule was paused (its newest revision that paused it). On the REST list only. */
  pausedAt?: string | null;
}

/** A run as the Scheduled page places it: whether its finding was new, and whether the owner was told. */
export interface ScheduleTimelineRun extends ScheduleRunView {
  newFinding: boolean;
  notified: boolean;
}

/** `GET /api/schedules?state=&workspaceId=`. */
export interface ScheduleListResponse {
  schedules: ScheduleListRow[];
  /**
   * On the REST list only: the runs of the page's window, for every listed schedule — each run under way, and the
   * ended runs planned in the last 24 hours (the viewer's today, in any zone). The page needs no other read.
   */
  runs?: ScheduleTimelineRun[];
  /**
   * On the REST list only: the OPEN tasks that wait for their startWhen condition (docs/condition-triggers-design.md
   * §9), which the page lists beside the WHEN schedules in "Waiting for a condition", tagged Can't read when it
   * cannot be read. A task whose condition has fired or ended is not waiting and is not here.
   */
  waitingTasks?: ScheduleWaitingTask[];
}

/** A task that starts when its condition holds, as the Scheduled page lists it (condition-triggers board ④). */
export interface ScheduleWaitingTask {
  id: string;
  title: string;
  workspaceId: string;
  workspaceName: string | null;
  condition: ScheduleConditionReading;
}

export interface ScheduleFindingView {
  key: string;
  summary: string | null;
  firstRunId: string | null;
  lastSeenRunId: string | null;
  notifiedAt: string | null;
  /** The creating agent's own check, not a run's finding. */
  baseline: boolean;
  links: unknown;
  createdAt: string;
}

export interface ScheduleUsageView {
  since: string;
  runs: number;
  minutes: number;
  costUsd: number | null;
  text: string;
}

export interface ScheduleUndoDoor {
  method: 'POST';
  path: string;
  body: { revision: number };
}

/** A change's record: in the inspector's history and as the change line in the session that made it. */
export interface ScheduleChangeRecord {
  kind: 'SCHEDULE_CHANGE_RECORD';
  scheduleId: string;
  title: string;
  revision: number;
  changedBy: ScheduleChangedBy;
  sessionId: string | null;
  changed: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  undoOfRevision: number | null;
  undoneByRevision: number | null;
  /** The person's words that asked for it, when it came from the schedule's change conversation (§8.2). */
  askedText: string | null;
  createdAt: string;
  undo: ScheduleUndoDoor | null;
}

/**
 * Orbit's opening of a change conversation (§8.2): the schedule as it was when the conversation was opened, drawn
 * by every client from `SCHEDULE_COPY.changeConversation`. Kept on the session, so it still reads as the start of
 * the conversation after the schedule has changed.
 */
export interface ScheduleChangeOpening {
  scheduleId: string;
  title: string;
  revision: number;
  /** The read-back ("What it does"). */
  does: string;
  /** "Every day at 09:00 · Asia/Shanghai". */
  when: string;
  /** "apiserver · Codex agent". */
  runsIn: string;
  /** "Open a PR · edits in its own worktree and opens a PR; can't merge or deploy". */
  may: string;
  /** "Up to 7 runs a week, 30 min each". */
  costs: string;
}

/**
 * `GET /api/schedules/:id/change`: the schedule's open change conversation if it has one, and the opening a new one
 * would start with. `POST /api/schedules/:id/change {text}` opens one with the person's first words and answers
 * `{ sessionId }`.
 */
export interface ScheduleChangeConversationResponse {
  sessionId: string | null;
  opening: ScheduleChangeOpening;
}

/** The opening's rows, in order, as label and text. */
export function scheduleChangeOpeningRows(opening: ScheduleChangeOpening): Array<{ label: string; text: string }> {
  const T = C.changeConversation;
  return [
    { label: T.does, text: opening.does },
    { label: T.when, text: opening.when },
    { label: T.runsIn, text: opening.runsIn },
    { label: T.may, text: opening.may },
    { label: T.costs, text: opening.costs },
  ];
}

/**
 * The Scheduled page's chat (docs/scheduled-chat-design.md §4.1, board scheduled-chat 01): Orbit's opening, static
 * words around the account's live counts, and the tag its session carries in a session list. Its own constant, not a
 * group of SCHEDULE_COPY: that copy is contracts/schedule.contract.json's, generated into each native client.
 */
export const SCHEDULE_PAGE_CHAT_COPY = {
  fromScheduled: 'From Scheduled',
  summary: 'You have {count} scheduled {tasks}: {counts}.',
  task: 'task',
  tasks: 'tasks',
  active: '{count} active',
  paused: '{count} paused',
  held: '{count} held',
  failing: '{count} failing',
  none: 'none',
  next: 'Next: {title}, {when} on {workspace}.',
  nextAt: '{day} at {time}',
  deletedWorkspace: 'a deleted workspace',
  examplesLead: 'Ask about them, or tell me what to change. For example:',
  examples: [
    'Pause everything on orbit-ws04 until Monday',
    'Why did the last run take so long?',
    "Every weekday at 09:00, check a changelog and tell me what's new",
  ],
  envelope:
    'Moving a time, rewording what a task checks or how it reports applies at once, and you can undo it. More runs, '
    + 'longer runs, more access or another workspace need your Allow.',
  empty: {
    summary: 'You have no scheduled tasks yet.',
    examplesLead: "Say what should happen and when, and I'll set it up. For example:",
    examples: [
      "Every weekday at 09:00, check a changelog and tell me what's new",
      'Every hour until 18:00, watch the deploy and tell me if it fails',
    ],
    closing: 'Nothing runs until you say something.',
  },
} as const;

/** The account's schedules as the page chat's opening counts them: every schedule that has not ended. */
export interface SchedulePageChatCounts {
  total: number;
  active: number;
  paused: number;
  held: number;
  /** ACTIVE with its last run failed (`consecutiveFailures > 0`), a part of `active`. */
  failing: number;
}

/** The next run of an ACTIVE schedule, the soonest of them all. */
export interface SchedulePageChatNext {
  scheduleId: string;
  title: string;
  /** ISO instant. */
  at: string;
  timezone: string;
  workspaceId: string;
  workspaceName: string | null;
}

/**
 * Orbit's opening of the Scheduled page's chat (docs/scheduled-chat-design.md §4.1): drawn from the account's schedules
 * before any engine starts, and written nowhere. A client draws `summary` and `next` as the first paragraph, then
 * `examplesLead` with `examples` as a list, then `closing`.
 */
export interface SchedulePageChatOpening {
  counts: SchedulePageChatCounts;
  next: SchedulePageChatNext | null;
  /** "You have 4 scheduled tasks: 2 active, 2 paused, none failing." */
  summary: string;
  /** "Next: Engine version bump, tomorrow at 06:00 on orbit-ws01.", or null when nothing is due. */
  nextText: string | null;
  examplesLead: string;
  examples: string[];
  /** What applies at once and what needs Allow; on an empty account, that nothing runs until the person speaks. */
  closing: string;
}

/**
 * `GET /api/schedules/chat`: the account's open page chat, if any, and the opening a new one starts with.
 * `POST /api/schedules/chat {text, workspaceId}` opens one with the person's first words and answers
 * `SchedulePageChatOpenAnswer`.
 */
export interface SchedulePageChatResponse {
  sessionId: string | null;
  opening: SchedulePageChatOpening;
}

/** `POST /api/schedules/chat`: the chat the words went to, and whether this request made it. */
export interface SchedulePageChatOpenAnswer {
  sessionId: string;
  created: boolean;
}

/** The opening's words, from the counts and the next run, read at `now`. */
export function schedulePageChatOpening(input: {
  counts: SchedulePageChatCounts;
  next: SchedulePageChatNext | null;
  now: Date;
}): SchedulePageChatOpening {
  const T = SCHEDULE_PAGE_CHAT_COPY;
  const { counts, next } = input;
  if (counts.total === 0) {
    return {
      counts, next: null, summary: T.empty.summary, nextText: null,
      examplesLead: T.empty.examplesLead, examples: [...T.empty.examples], closing: T.empty.closing,
    };
  }
  const n = (count: number) => (count === 0 ? T.none : String(count));
  const parts = [scheduleFill(T.active, { count: n(counts.active) })];
  if (counts.paused > 0) parts.push(scheduleFill(T.paused, { count: counts.paused }));
  if (counts.held > 0) parts.push(scheduleFill(T.held, { count: counts.held }));
  parts.push(scheduleFill(T.failing, { count: n(counts.failing) }));
  const summary = scheduleFill(T.summary, {
    count: counts.total,
    tasks: counts.total === 1 ? T.task : T.tasks,
    counts: parts.join(', '),
  });
  let nextText: string | null = null;
  if (next) {
    const at = new Date(next.at);
    const day = scheduleDayText(at, input.now, next.timezone);
    nextText = scheduleFill(T.next, {
      title: next.title,
      when: scheduleFill(T.nextAt, {
        day: day === C.dates.today ? C.dates.todayLower : day === C.dates.tomorrow ? C.dates.tomorrowLower : day,
        time: localParts(at, next.timezone).time,
      }),
      workspace: next.workspaceName ?? T.deletedWorkspace,
    });
  }
  return { counts, next, summary, nextText, examplesLead: T.examplesLead, examples: [...T.examples], closing: T.envelope };
}

export interface ScheduleCardDecision {
  allow: string;
  decline: string;
}

export interface ScheduleRunsInLine {
  workspaceId: string;
  workspaceName: string | null;
  engine: string | null;
  text: string;
}

export interface ScheduleEnvelopeLines {
  runsIn: ScheduleRunsInLine;
  may: { accessLevel: ScheduleAccessLevel; text: string };
  costs: { runsPerWeek: number; runLimitMinutes: number; text: string };
}

interface ScheduleCardBase {
  id: string;
  kind: ScheduleRequestKind;
  state: ScheduleRequestState;
  askedBy: ScheduleChangedBy;
  askedBySessionId: string | null;
  scheduleId: string | null;
  createdAt: string;
  decidedAt: string | null;
  resultRevision: number | null;
  /** The owner-channel doors; null once decided. */
  decision: ScheduleCardDecision | null;
}

/** The create card (§8.1). */
export interface ScheduleCreateCard extends ScheduleCardBase, ScheduleEnvelopeLines {
  kind: 'CREATE';
  title: string;
  readBack: string;
  intent: string;
  when: {
    rule: ScheduleRule;
    timezone: string | null;
    firstRunAt: string | null;
    text: string;
    /** A WHEN rule's lines: the condition, the re-arm and how it is checked, and the command verbatim. */
    condition?: ScheduleWhenLines | null;
  };
  today: { key: string; summary: string | null; text: string } | null;
  notice: string;
  /** The Ends line (§8.5); null when the card names no end. Absent from servers before it. */
  ends?: ScheduleCardEnds | null;
  envelope: null;
}

/**
 * A create card's planned end (§8.5): the end the agent named, or on an EVERY rule that named none the server's
 * suggestion 7 days out. A PENDING card's suggestion offers No end (`ScheduleAllowBody.dropSuggestedEnd`); once
 * allowed, the card reads the end Create wrote, still `suggested`, or null after No end.
 */
export interface ScheduleCardEnds {
  endAt: string | null;
  maxRuns: number | null;
  suggested: boolean;
}

/** The envelope card (§4): *Now* and *Asked*. */
export interface ScheduleEnvelopeCard extends ScheduleCardBase {
  kind: 'UPDATE';
  title: string | null;
  readBack: null;
  intent: null;
  when: null;
  runsIn: null;
  may: null;
  costs: null;
  today: null;
  notice: null;
  proposed: Record<string, unknown>;
  envelope: {
    widens: ScheduleEnvelopePart[];
    now: ScheduleEnvelopeLines | null;
    asked: ScheduleEnvelopeLines;
  };
}

export type ScheduleCard = ScheduleCreateCard | ScheduleEnvelopeCard;

/** `GET /api/schedules/:id`: the inspector. */
export interface ScheduleDetailResponse {
  schedule: ScheduleView;
  readBack: string;
  lastRun: ScheduleRunView | null;
  recentRuns: ScheduleRunView[];
  findings: ScheduleFindingView[];
  usage: ScheduleUsageView;
  history: ScheduleChangeRecord[];
  pendingCards: ScheduleCard[];
}

/** `GET /api/schedules/:id/runs?limit=&before=`. */
export interface ScheduleRunsResponse {
  runs: ScheduleRunView[];
}

/** `POST /api/schedules/:id/run` and `POST /api/schedule-runs/:id/stop`. */
export interface ScheduleRunAnswer {
  run: ScheduleRunView;
}

/** `POST /api/schedules/:id/{pause,resume}` and `DELETE /api/schedules/:id`. */
export interface ScheduleControlAnswer {
  schedule: ScheduleView;
  record: ScheduleChangeRecord | null;
}

/** `POST /api/schedules/:id/undo`. */
export type ScheduleUpdateAnswer =
  | { outcome: 'APPLIED'; changed: true; note: string; schedule: ScheduleView; record: ScheduleChangeRecord | null }
  | { outcome: 'UNCHANGED'; changed: false; schedule: ScheduleView }
  | { outcome: 'PENDING'; changed: false; note: string; card: ScheduleCard };

export interface ScheduleUndoBody {
  revision: number;
}

/** `GET /api/schedule-requests?state=&kind=`. */
export interface ScheduleRequestsResponse {
  requests: ScheduleCard[];
}

/** `GET /api/schedules/drafts`: the account's PENDING create cards. */
export interface ScheduleDraftsResponse {
  drafts: ScheduleCreateCard[];
}

/** `POST /api/schedules/drafts`: the quick-add line opens an ordinary session with the sentence. */
export interface ScheduleDraftBody {
  workspaceId: string;
  text: string;
}

export interface ScheduleDraftAnswer {
  sessionId: string;
  session: unknown;
}

/** One try of a run (§7.2): the session it opened, and how far that session got. */
export interface ScheduleRunTry {
  sessionId: string;
  /** When the try's session was opened. */
  startedAt: string;
  /** Whether a runner claimed the session (its engine was started, or tried to be). */
  claimed: boolean;
  /** Whether the session's first turn reached its engine. */
  reachedEngine: boolean;
}

/** The full runner, run or batch a run's current session waits behind (sessions/queued-reason-sql.ts). */
export interface ScheduleRunQueueGate {
  queuedReason: 'runner_at_capacity' | 'tree_at_capacity' | 'batch_at_capacity' | (string & {});
  queuedActive: number | null;
  queuedLimit: number | null;
  queuedHeldByJobs: number | null;
  /** When the session went PENDING: what the wait counts from. */
  since: string;
  /** The run's catch-up deadline: past it, the run is MISSED (RUNNER_FULL). */
  deadline: string;
}

/**
 * What a run's session shows of the run it serves beside `run` (board docs/mocks/scheduled-run-not-started ②③④):
 * its tries, when it gave up, its next try, the schedule's next run, and the queue its session waits in.
 */
export interface ScheduleRunSessionStatus {
  /** Every try the run made, oldest first. */
  tries: ScheduleRunTry[];
  /** Which of `tries` this session is, from 1; null when it is none of them. */
  thisTry: number | null;
  /** When a run that ended with no try reaching its engine gave up; null otherwise. */
  gaveUpAt: string | null;
  /** A QUEUED run's next try. */
  notBeforeAt: string | null;
  /** The schedule's next run. */
  nextDueAt: string | null;
  /** The gate holding the run's current session while a full runner, run or batch does; null otherwise. */
  queue: ScheduleRunQueueGate | null;
}

/** `GET /api/sessions/:id/schedule-cards`. */
export interface SessionScheduleCardsResponse {
  /** A scheduled run's session (runSource SCHEDULE): the run it serves, however old; null for any other session. */
  run: ScheduleRunView | null;
  /** Beside `run`: where it stands for this session. Null when `run` is; absent from servers before it. */
  runStatus?: ScheduleRunSessionStatus | null;
  cards: ScheduleCard[];
  records: ScheduleChangeRecord[];
  /**
   * A schedule's change conversation (§8.2): Orbit's opening, as the schedule was when it was opened, for its strip
   * and its first message. Null on every other session (and on servers before it).
   */
  change?: ScheduleChangeOpening | null;
}

/**
 * `POST /api/schedule-requests/:id/allow`: a zone only for a CREATE card that names none; `dropSuggestedEnd` is the
 * create card's No end (§8.5), so Create writes no end instead of the suggested one.
 */
export interface ScheduleAllowBody {
  timezone?: string;
  dropSuggestedEnd?: boolean;
}

/** `POST /api/schedule-requests/:id/{allow,decline}`. */
export interface ScheduleDecisionAnswer {
  outcome: 'ALLOWED' | 'DECLINED' | 'STALE' | (string & {});
  card: ScheduleCard;
  schedule: ScheduleView | null;
}

/** The 409 body of a card Allow withdrew. */
export interface ScheduleRequestStaleError extends ScheduleDecisionAnswer {
  code: 'SCHEDULE_REQUEST_STALE';
  reason: ScheduleStaleReason;
  message: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Time, in the viewer's zone
// ---------------------------------------------------------------------------------------------------------------

interface LocalParts {
  /** Days since 1970-01-01 of the local calendar date: two dates' difference is a count of days. */
  dayNumber: number;
  month: number;
  day: number;
  weekday: ScheduleWeekday;
  time: string;
}

const WEEKDAY_OF_INTL: Record<string, ScheduleWeekday> = {
  Mon: 'MON', Tue: 'TUE', Wed: 'WED', Thu: 'THU', Fri: 'FRI', Sat: 'SAT', Sun: 'SUN',
};

function localParts(at: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const hour = Number(get('hour')) % 24;
  return {
    dayNumber: Math.round(Date.UTC(year, month - 1, day) / 86_400_000),
    month,
    day,
    weekday: WEEKDAY_OF_INTL[get('weekday')]!,
    time: `${String(hour).padStart(2, '0')}:${get('minute')}`,
  };
}

/** "Nov 14". */
export function scheduleDateText(at: Date, timezone: string): string {
  const p = localParts(at, timezone);
  return scheduleFill(C.dates.day, { month: C.months[p.month - 1]!, day: p.day });
}

/** "Fri, Nov 14". */
export function scheduleDayWithWeekdayText(at: Date, timezone: string): string {
  const p = localParts(at, timezone);
  return scheduleFill(C.dates.dayWithWeekday, {
    weekday: C.weekdaysShort[p.weekday],
    month: C.months[p.month - 1]!,
    day: p.day,
  });
}

/** "Today", "Tomorrow", "Monday" within the coming week, else "Nov 24". */
export function scheduleDayText(at: Date, now: Date, timezone: string): string {
  const p = localParts(at, timezone);
  const offset = p.dayNumber - localParts(now, timezone).dayNumber;
  if (offset === 0) return C.dates.today;
  if (offset === 1) return C.dates.tomorrow;
  if (offset > 1 && offset < 7) return C.weekdays[p.weekday];
  return scheduleFill(C.dates.day, { month: C.months[p.month - 1]!, day: p.day });
}

/** "Today 02:00", "Tomorrow 09:00", "Monday 09:00", "Nov 24 09:00": the inspector's next run. */
export function scheduleWhenText(at: Date, now: Date, timezone: string): string {
  return scheduleFill(C.dates.at, { day: scheduleDayText(at, now, timezone), time: localParts(at, timezone).time });
}

/** A slot that has passed, inside a sentence: "Monday 09:00" within the last week, else "Nov 10, 09:00". */
export function schedulePastWhenText(at: Date, now: Date, timezone: string): string {
  const p = localParts(at, timezone);
  const back = localParts(now, timezone).dayNumber - p.dayNumber;
  if (back >= 0 && back < 7) return scheduleFill(C.dates.at, { day: C.weekdays[p.weekday], time: p.time });
  return `${scheduleDateText(at, timezone)}, ${p.time}`;
}

/** "First run tomorrow" / "First run Monday". */
export function scheduleFirstRunText(at: Date, now: Date, timezone: string, inline = false): string {
  const day = scheduleDayText(at, now, timezone);
  const lowered = day === C.dates.today ? C.dates.todayLower : day === C.dates.tomorrow ? C.dates.tomorrowLower : day;
  return scheduleFill(inline ? C.createCard.firstRunInline : C.createCard.firstRun, { day: lowered });
}

// ---------------------------------------------------------------------------------------------------------------
// Rules and costs
// ---------------------------------------------------------------------------------------------------------------

const WORKWEEK: readonly ScheduleWeekday[] = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

/**
 * A rule in words. `short`: "Daily 10:00", "Mondays 10:00", "Weekdays at 09:00", "Mon, Thu 10:00", "Once".
 * `long`: "Every day at 02:00", "Every Monday at 09:00", "Weekdays at 09:00", "Every Mon, Thu at 10:00", "Once".
 * A ONCE rule's day and time are the row's time column and the card's first run, not the rule's words.
 */
export function scheduleRuleText(rule: ScheduleRule, form: 'short' | 'long' = 'short'): string {
  const t = C.rules[form];
  if (rule.kind === 'ONCE') return t.once;
  if (rule.kind === 'WHEN') {
    return scheduleFill(CC.rules[form], { condition: form === 'long' ? lowerFirst(rule.condition.text) : rule.condition.text });
  }
  if (rule.kind === 'DAILY') return scheduleFill(t.daily, { time: rule.time });
  if (rule.kind === 'EVERY') return everyRuleText(rule);
  const days = SCHEDULE_WEEKDAYS.filter((d) => rule.weekdays.includes(d));
  if (days.length === 7) return scheduleFill(t.daily, { time: rule.time });
  if (days.length === 5 && WORKWEEK.every((d) => days.includes(d))) return scheduleFill(t.weekdays, { time: rule.time });
  if (days.length === 1) {
    const d = days[0]!;
    return form === 'short'
      ? scheduleFill(C.rules.short.weekday, { weekdays: C.weekdaysPlural[d], time: rule.time })
      : scheduleFill(C.rules.long.weekday, { weekday: C.weekdays[d], time: rule.time });
  }
  return scheduleFill(t.days, { days: days.map((d) => C.weekdaysShort[d]).join(C.rules.daysSeparator), time: rule.time });
}

/** An EVERY rule's sentence, the same in both forms (design §9.2): "Every 30 min, 09:00–18:00, Mon–Fri", "Every hour". */
function everyRuleText(rule: Extract<ScheduleRule, { kind: 'EVERY' }>): string {
  const e = C.every;
  const interval = rule.minutes < 60
    ? scheduleFill(e.minutes, { count: rule.minutes })
    : rule.minutes === 60 ? e.hour : scheduleFill(e.hours, { count: rule.minutes / 60 });
  const text = rule.until
    ? scheduleFill(e.window, { interval, time: rule.time, until: rule.until })
    : rule.time === '00:00' ? interval : scheduleFill(e.from, { interval, time: rule.time });
  const days = SCHEDULE_WEEKDAYS.filter((d) => rule.weekdays.includes(d));
  if (days.length === 7) return text;
  const named = days.length === 5 && WORKWEEK.every((d) => days.includes(d))
    ? e.workweek
    : days.length === 2 && days.includes('SAT') && days.includes('SUN')
      ? e.weekend
      : days.map((d) => C.weekdaysShort[d]).join(C.rules.daysSeparator);
  return scheduleFill(e.days, { rule: text, days: named });
}

/**
 * A schedule's planned end as one line: "until 18:00 today", "until Nov 25", "3 runs left", or both joined by the
 * separator when it has an end by time and one by count. Null when it has no end.
 */
export function scheduleEndText(
  schedule: Pick<ScheduleView, 'endAt' | 'maxRuns' | 'runsLeft'>,
  now: Date,
  timezone: string,
): string | null {
  const e = C.end;
  const parts: string[] = [];
  if (schedule.endAt) {
    const at = new Date(schedule.endAt);
    const day = scheduleDayText(at, now, timezone);
    const time = localParts(at, timezone).time;
    const when = day === C.dates.today ? scheduleFill(e.today, { time })
      : day === C.dates.tomorrow ? scheduleFill(e.tomorrow, { time })
        : scheduleDateText(at, timezone);
    parts.push(scheduleFill(e.until, { when }));
  }
  if (schedule.maxRuns != null) {
    const left = schedule.runsLeft ?? schedule.maxRuns;
    parts.push(left === 1 ? e.runLeft : scheduleFill(e.runsLeft, { count: left }));
  }
  return parts.length ? parts.join(C.separator) : null;
}

/** "16 slots missed, 01:00–08:30", or with dates when the range spans days: "…, Nov 19, 22:00–Nov 20, 06:30". */
export function scheduleMissedText(runs: readonly Pick<ScheduleRunView, 'plannedAt'>[], timezone: string): string {
  const times = runs.map((r) => Date.parse(r.plannedAt));
  const first = localParts(new Date(Math.min(...times)), timezone);
  const last = localParts(new Date(Math.max(...times)), timezone);
  if (first.month === last.month && first.day === last.day) {
    return scheduleFill(C.end.missed, { count: runs.length, from: first.time, to: last.time });
  }
  const date = (p: typeof first) => scheduleFill(C.dates.day, { month: C.months[p.month - 1]!, day: p.day });
  return scheduleFill(C.end.missedDated, {
    count: runs.length, fromDate: date(first), from: first.time, toDate: date(last), to: last.time,
  });
}

/**
 * Collapses consecutive MISSED runs of one schedule into one item (two or more; a single one stays a run). A
 * schedule's streak ends at any other run of it between two missed ones. The collapsed item takes the place of the
 * first member in the list and the time of its last.
 */
export interface ScheduleMissedItem {
  kind: 'MISSED';
  schedule: ScheduleListRow;
  runs: ScheduleRunView[];
  at: string;
}
export function scheduleCollapseMissed(items: ScheduleTimelineItem[]): Array<ScheduleTimelineItem | ScheduleMissedItem> {
  const runItems = items.filter((i): i is Extract<ScheduleTimelineItem, { kind: 'RUN' }> => i.kind === 'RUN');
  const streakOf = new Map<ScheduleTimelineItem, ScheduleTimelineItem[]>();
  const bySchedule = new Map<string, typeof runItems>();
  for (const item of runItems) {
    const list = bySchedule.get(item.schedule.id) ?? [];
    list.push(item);
    bySchedule.set(item.schedule.id, list);
  }
  for (const list of bySchedule.values()) {
    list.sort((a, b) => Date.parse(a.run.plannedAt) - Date.parse(b.run.plannedAt));
    let streak: typeof runItems = [];
    const close = () => {
      if (streak.length > 1) for (const m of streak) streakOf.set(m, streak);
      streak = [];
    };
    for (const item of list) {
      if (item.run.state === 'MISSED') streak.push(item);
      else close();
    }
    close();
  }
  const out: Array<ScheduleTimelineItem | ScheduleMissedItem> = [];
  const done = new Set<ScheduleTimelineItem[]>();
  for (const item of items) {
    const streak = item.kind === 'RUN' ? (streakOf.get(item) as typeof runItems | undefined) : undefined;
    if (!streak || item.kind !== 'RUN') {
      out.push(item);
      continue;
    }
    if (done.has(streak)) continue;
    done.add(streak);
    out.push({ kind: 'MISSED', schedule: item.schedule, runs: streak.map((m) => m.run), at: streak[streak.length - 1]!.at });
  }
  return out;
}

/** Whether a row shows the repeat mark (↻) before its rule: a one-off does not. */
export function scheduleRuleRepeats(rule: ScheduleRule): boolean {
  return rule.kind !== 'ONCE';
}

/** "10 min", "45 s", "2 h": a hold or an interval as the card says it. */
export function scheduleDurationText(seconds: number): string {
  if (seconds < 60) return scheduleFill(CC.seconds, { count: seconds });
  if (seconds < 7200 || seconds % 3600 !== 0) return scheduleFill(CC.minutes, { count: Math.round(seconds / 60) });
  return scheduleFill(CC.hours, { count: seconds / 3600 });
}

/** A reading with its unit: "85%", "3 in", "2.0 GiB". */
export function scheduleReadingText(value: number, unit: string | null): string {
  if (!unit) return String(value);
  return unit === '%' ? `${value}%` : `${value} ${unit}`;
}

/** A WHEN rule's lines on the create card (condition-triggers board ③). */
export interface ScheduleWhenLines {
  /** "Raw used above 90% for 10 min". */
  text: string;
  /** "Fires again only after it drops below 85%. Checked every 5 min on workstation-gpu, no model." */
  detail: string;
  /** The probe command, verbatim: what Create approves. */
  command: string;
  /** "And again every 2 hours while it stays that way."; null for a condition with no repeat. */
  repeat: string | null;
  /** "Keeps this cloud workspace awake while it waits." under the check line, for a workspace on Orbit Cloud; null
   *  otherwise. */
  awake: string | null;
}

/** "2 hours", "hour", "90 minutes": a repeat's interval as the sentence says it. */
function repeatIntervalText(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? CC.repeatUnits.hour : scheduleFill(CC.repeatUnits.hours, { count: seconds / 3600 });
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? CC.repeatUnits.minute : scheduleFill(CC.repeatUnits.minutes, { count: minutes });
}

/**
 * A WHEN condition's repeat in words, for the create card's When block and the inspector's Condition block:
 * "And again every 2 hours while it stays that way."; null with no repeat.
 */
export function scheduleRepeatText(repeatSeconds: number | null | undefined): string | null {
  if (repeatSeconds === null || repeatSeconds === undefined) return null;
  return scheduleFill(CC.repeat, { interval: repeatIntervalText(repeatSeconds) });
}

export function scheduleWhenLines(
  condition: ScheduleWhenCondition,
  runner: string | null,
  keepsWorkspaceAwake = false,
): ScheduleWhenLines {
  const text = condition.holdSeconds > 0
    ? scheduleFill(CC.held, { condition: condition.text, duration: scheduleDurationText(condition.holdSeconds) })
    : condition.text;
  const rearm = condition.rearm
    ? scheduleFill(CC.rearm, {
        rearm: scheduleFill(CC.rearmOps[condition.rearm.op], {
          value: condition.rearm.value === null ? '' : scheduleReadingText(condition.rearm.value, condition.unit),
        }),
      })
    : CC.rearmWhenFalse;
  const interval = scheduleDurationText(condition.intervalSeconds);
  const checked = runner
    ? scheduleFill(CC.checked, { interval, runner })
    : scheduleFill(CC.checkedNoRunner, { interval });
  return {
    text,
    detail: `${rearm} ${checked}`,
    command: condition.command,
    repeat: scheduleRepeatText(condition.repeatSeconds),
    awake: keepsWorkspaceAwake ? CC.keepsAwake : null,
  };
}

/** "7 runs a week", "1 run a week". */
export function scheduleRunsPerWeekText(runsPerWeek: number): string {
  return scheduleFill(runsPerWeek === 1 ? C.costs.runs.one : C.costs.runs.other, { count: runsPerWeek });
}

/**
 * The Costs line, "Up to 7 runs a week, 30 min each". `emphasis` is the part the card sets in bold. The apiserver's
 * card lines read this same function (schedule-views.ts).
 */
export function scheduleCostsParts(runsPerWeek: number, runLimitMinutes: number): {
  text: string;
  before: string;
  emphasis: string;
  after: string;
} {
  const emphasis = scheduleRunsPerWeekText(runsPerWeek);
  const text = scheduleFill(C.costs.upTo, { runs: emphasis, minutes: runLimitMinutes });
  const at = text.indexOf(emphasis);
  return { text, before: text.slice(0, at), emphasis, after: text.slice(at + emphasis.length) };
}

export function scheduleCostsText(runsPerWeek: number, runLimitMinutes: number): string {
  return scheduleCostsParts(runsPerWeek, runLimitMinutes).text;
}

/** "Allowed: up to 7 runs a week, 30 min each", under This month. */
export function scheduleAllowedText(envelope: Pick<ScheduleEnvelope, 'runsPerWeek' | 'runLimitMinutes'>): string {
  return scheduleFill(C.costs.allowed, {
    costs: scheduleFill(C.costs.upToLower, {
      runs: scheduleRunsPerWeekText(envelope.runsPerWeek),
      minutes: envelope.runLimitMinutes,
    }),
  });
}

/** "14 runs · 41 min". */
export function scheduleUsageText(usage: Pick<ScheduleUsageView, 'runs' | 'minutes'>): string {
  return scheduleFill(usage.runs === 1 ? C.inspector.usage.one : C.inspector.usage.other, usage);
}

/** "Check only · reads and reports, edits nothing": the create card's May line. */
export function scheduleMayText(level: ScheduleAccessLevel): string {
  return `${C.access[level].label}${C.separator}${C.access[level].detail}`;
}

/** "Claude", "Codex": an engine id as the card names it. */
export function scheduleEngineName(engine: string): string {
  return capitalize(engine);
}

/** "apiserver · Codex agent". */
export function scheduleRunsInText(workspaceName: string, engine: string | null): string {
  return engine
    ? scheduleFill(C.createCard.runsInEngine, { workspace: workspaceName, engine: scheduleEngineName(engine) })
    : workspaceName;
}

/** The create card's last line: "You'll hear about new versions and failures only." `findings` defaults to findings. */
export function scheduleCreateNotice(findings?: string | null): string {
  const what = findings?.trim();
  return what ? scheduleFill(C.createCard.noticeAbout, { findings: what }) : C.createCard.notice;
}

/** The create card's When: "Daily 10:00 · Asia/Shanghai · first run tomorrow", with its parts. */
export function scheduleCreateWhen(card: Pick<ScheduleCreateCard, 'when'>, now: Date, viewerTimezone: string): {
  text: string;
  rule: string;
  zone: string;
  firstRun: string | null;
} {
  const zone = card.when.timezone ?? C.createCard.zoneFromDevice;
  const rule = scheduleRuleText(card.when.rule, 'short');
  const at = card.when.firstRunAt ? new Date(card.when.firstRunAt) : null;
  const tz = card.when.timezone ?? viewerTimezone;
  const firstRun = at ? scheduleFirstRunText(at, now, tz) : null;
  const inline = at ? scheduleFirstRunText(at, now, tz, true) : null;
  return { text: [rule, zone, inline].filter(Boolean).join(C.separator), rule, zone, firstRun };
}

// ---------------------------------------------------------------------------------------------------------------
// Circles
// ---------------------------------------------------------------------------------------------------------------

/**
 * A row's circle (board 1/2 ①): `open` is to come (a queued run wears clock hands in it), `running` turns, `done` a grey tick (no change, or already
 * reported), `new` a green tick (a new finding), `failed` red, `held` amber, `draft` dashed, `paused` faint, `muted`
 * a run that never did the work (skipped, missed, cancelled).
 */
export const SCHEDULE_CIRCLES = ['open', 'running', 'done', 'new', 'failed', 'held', 'draft', 'paused', 'muted'] as const;
export type ScheduleCircle = (typeof SCHEDULE_CIRCLES)[number];

export type ScheduleTagTone = 'new' | 'fail' | 'held' | 'mute';

export interface ScheduleCircleView {
  circle: ScheduleCircle;
  /** What sits inside the circle. */
  mark: 'check' | 'alert' | 'clock' | null;
  /** The label at the right of a row, if any. */
  tag: { tone: ScheduleTagTone; text: string } | null;
}

/**
 * A run's circle. A CHANGED run is `new` when its finding was new (its key's first run is this run), else a grey
 * tick tagged Known.
 */
export function scheduleRunCircle(
  run: Pick<ScheduleRunView, 'state'>,
  opts: { newFinding?: boolean } = {},
): ScheduleCircleView {
  const label = C.runStates[run.state];
  switch (run.state) {
    case 'QUEUED':
      return { circle: 'open', mark: 'clock', tag: null };
    case 'RUNNING':
      return { circle: 'running', mark: null, tag: null };
    case 'AWAITING_APPROVAL':
      return { circle: 'held', mark: 'alert', tag: { tone: 'held', text: label } };
    case 'NO_CHANGE':
      return { circle: 'done', mark: 'check', tag: { tone: 'mute', text: label } };
    case 'CHANGED':
      return opts.newFinding
        ? { circle: 'new', mark: 'check', tag: { tone: 'new', text: C.tags.new } }
        : { circle: 'done', mark: 'check', tag: { tone: 'mute', text: C.tags.known } };
    case 'FAILED':
      return { circle: 'failed', mark: 'alert', tag: { tone: 'fail', text: C.tags.failed } };
    case 'HELD':
      return { circle: 'held', mark: 'alert', tag: { tone: 'held', text: C.tags.held } };
    case 'SKIPPED':
    case 'MISSED':
    case 'CANCELLED':
      return { circle: 'muted', mark: 'check', tag: { tone: 'mute', text: label } };
  }
}

/** A schedule's circle on its next occurrence, or in Paused. A failing one whose next run is under way: scheduleRowCircle. */
export function scheduleCircle(
  schedule: Pick<ScheduleView, 'state' | 'consecutiveFailures'>,
  opts: { draft?: boolean } = {},
): ScheduleCircleView {
  if (opts.draft) return { circle: 'draft', mark: null, tag: null };
  switch (schedule.state) {
    case 'PAUSED':
      return { circle: 'paused', mark: null, tag: null };
    case 'HELD':
      return { circle: 'held', mark: 'alert', tag: { tone: 'held', text: C.tags.held } };
    case 'ENDED':
      return { circle: 'muted', mark: null, tag: null };
    case 'ACTIVE':
      if (schedule.consecutiveFailures > 0) {
        return {
          circle: 'failed',
          mark: 'alert',
          tag: {
            tone: 'fail',
            text: schedule.consecutiveFailures > 1
              ? scheduleFill(C.tags.failedInARow, { count: schedule.consecutiveFailures })
              : C.tags.failed,
          },
        };
      }
      return { circle: 'open', mark: null, tag: null };
  }
}

/** Whether one of `runs` (the list's timeline runs) is a run of this schedule under way: queued, running or waiting. */
export function scheduleRunUnderWay(
  schedule: Pick<ScheduleView, 'id'>,
  runs: readonly Pick<ScheduleRunView, 'scheduleId' | 'state'>[],
): boolean {
  return runs.some((run) => run.scheduleId === schedule.id && IN_PROGRESS.includes(run.state));
}

/**
 * Needs you: held, or failing with no run under way (§9.2) — the count beside Scheduled in the drawer. A failing
 * schedule whose next run is already under way (Run now, owner 2026-11-19) waits for that run: a failure puts it back,
 * an ended run that did not fail clears it.
 */
export function scheduleNeedsYou(
  schedule: Pick<ScheduleView, 'id' | 'state' | 'consecutiveFailures'>,
  runs: readonly Pick<ScheduleRunView, 'scheduleId' | 'state'>[] = [],
): boolean {
  if (schedule.state === 'HELD') return true;
  return schedule.state === 'ACTIVE' && schedule.consecutiveFailures > 0 && !scheduleRunUnderWay(schedule, runs);
}

/**
 * The count beside Scheduled in the drawer, the same on every client (owner 2026-11-19): the schedules that need you
 * (scheduleNeedsYou), the ACTIVE ones whose condition cannot be read, and the tasks waiting on a condition that cannot
 * be read.
 */
export function scheduleNeedsCount(
  list: Pick<ScheduleListResponse, 'schedules' | 'runs' | 'waitingTasks'> | null | undefined,
): number {
  if (!list) return 0;
  const runs = list.runs ?? [];
  const cantRead = (reading: Pick<ScheduleConditionReading, 'state'> | null | undefined) => reading?.state === 'UNKNOWN';
  const schedules = (list.schedules ?? []).filter((s) =>
    scheduleNeedsYou(s, runs) || (s.state === 'ACTIVE' && cantRead(s.condition))).length;
  return schedules + (list.waitingTasks ?? []).filter((t) => cantRead(t.condition)).length;
}

/** A schedule's row circle on the page: its Failed tag stays off while a run of it is under way. */
export function scheduleRowCircle(
  schedule: Pick<ScheduleView, 'id' | 'state' | 'consecutiveFailures'>,
  runs: readonly Pick<ScheduleRunView, 'scheduleId' | 'state'>[],
): ScheduleCircleView {
  if (schedule.state === 'ACTIVE' && !scheduleNeedsYou(schedule, runs)) return { circle: 'open', mark: null, tag: null };
  return scheduleCircle(schedule);
}

// ---------------------------------------------------------------------------------------------------------------
// A row's second line
// ---------------------------------------------------------------------------------------------------------------

/** Why a run failed, as a clause: the server's reasonText (S2d) when it has one. */
export function scheduleFailureClause(run: Pick<ScheduleRunView, 'failureReason' | 'reasonText'>): string | null {
  if (run.reasonText) return run.reasonText;
  if (!run.failureReason) return null;
  return (C.failureReasons as Record<string, string>)[run.failureReason] ?? null;
}

/** Why a schedule is held, as a clause: 'the agent "auditor" is disabled'. */
export function scheduleHeldClause(
  reason: string | null,
  names: { agent?: string | null; workspace?: string | null } = {},
): { clause: string; until: string } | null {
  const entry = reason ? (C.heldReasons as Record<string, { clause: string; until: string }>)[reason] : undefined;
  if (!entry) return null;
  return {
    clause: scheduleFill(entry.clause, {
      ...(names.agent ? { agent: names.agent } : {}),
      ...(names.workspace ? { workspace: names.workspace } : {}),
    })
      .replace('the agent "{agent}"', 'its agent')
      .replace('the workspace {workspace}', 'its workspace'),
    until: entry.until,
  };
}

/**
 * A schedule row's second line: "Every day at 02:00 · apiserver · Check only". A held schedule says why in place of
 * the access, a paused one when it paused; a running one adds how long, a draft that it waits for you.
 */
export function scheduleRowLine(
  schedule: Pick<ScheduleView, 'rule' | 'workspaceName' | 'accessLevel' | 'state' | 'heldReason'>,
  opts: {
    agentName?: string | null;
    pausedAt?: Date | null;
    timezone?: string;
    runningMinutes?: number | null;
    draft?: boolean;
  } = {},
): string {
  const parts: string[] = [scheduleRuleText(schedule.rule, 'long')];
  if (schedule.workspaceName) parts.push(schedule.workspaceName);
  if (schedule.state === 'HELD') {
    const held = scheduleHeldClause(schedule.heldReason, { agent: opts.agentName });
    parts.push(held?.clause ?? C.access[schedule.accessLevel].label);
  } else if (schedule.state === 'PAUSED' && opts.pausedAt && opts.timezone) {
    parts.push(scheduleFill(C.row.pausedOn, { date: scheduleDateText(opts.pausedAt, opts.timezone) }));
  } else {
    parts.push(C.access[schedule.accessLevel].label);
  }
  if (opts.runningMinutes != null) parts.push(scheduleFill(C.row.runningFor, { minutes: opts.runningMinutes }));
  if (opts.draft) parts.push(C.row.draft);
  return parts.join(C.separator);
}

/**
 * A schedule row's second line on a phone (iOS board 01 ②), one line: the short rule, then the workspace — or, held,
 * why in a few words — then "Open a PR" only when the schedule may open PRs, when it paused, how long it has been
 * running, or that it is a draft. "Daily 02:00 · apiserver", "Mondays 09:00 · agent disabled",
 * "Daily 12:00 · web · running 21 min", "Daily 09:00 · apiserver · Open a PR". The web's wide row keeps scheduleRowLine.
 */
export function schedulePhoneRowLine(
  schedule: Pick<ScheduleView, 'rule' | 'workspaceName' | 'accessLevel' | 'state' | 'heldReason'>,
  opts: { pausedAt?: Date | null; timezone?: string; runningMinutes?: number | null; draft?: boolean } = {},
): string {
  const parts: string[] = [scheduleRuleText(schedule.rule, 'short')];
  if (schedule.state === 'HELD') {
    const short = schedule.heldReason ? (C.heldShort as Record<string, string>)[schedule.heldReason] : undefined;
    parts.push(short ?? C.tags.held);
  } else {
    if (schedule.workspaceName) parts.push(schedule.workspaceName);
    if (schedule.accessLevel !== 'CHECK_ONLY') parts.push(C.access[schedule.accessLevel].label);
    if (schedule.state === 'PAUSED' && opts.pausedAt && opts.timezone) {
      parts.push(scheduleFill(C.row.pausedOn, { date: scheduleDateText(opts.pausedAt, opts.timezone) }));
    }
  }
  if (opts.runningMinutes != null) parts.push(scheduleFill(C.row.runningShort, { minutes: opts.runningMinutes }));
  if (opts.draft) parts.push(C.row.draftShort);
  return parts.join(C.separator);
}

/**
 * A past run's second line: "Ended without a report", "Reported a failure: The releases page returned 503",
 * "2.1.310 is out · you were notified".
 */
export function scheduleRunLine(
  run: Pick<ScheduleRunView, 'state' | 'summary' | 'failureReason' | 'reasonText'>,
  opts: { notified?: boolean } = {},
): string {
  if (run.state === 'FAILED' || run.state === 'MISSED' || run.state === 'HELD') {
    const clause = reportedFailureClause(run) ?? scheduleFailureClause(run);
    if (clause) return capitalize(clause);
    return C.runStates[run.state];
  }
  const parts: string[] = [run.summary ?? C.runStates[run.state]];
  if (run.state === 'CHANGED' || run.state === 'NO_CHANGE') parts.push(opts.notified ? C.row.notified : C.row.notNotified);
  return parts.join(C.separator);
}

// ---------------------------------------------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------------------------------------------

export type ScheduleTimelineGroupKey = 'TODAY' | 'TOMORROW' | 'DAY' | 'LATER' | 'PAUSED';

export type ScheduleTimelineItem =
  | { kind: 'SCHEDULE'; schedule: ScheduleListRow; at: string | null }
  | { kind: 'RUN'; schedule: ScheduleListRow; run: ScheduleRunView; at: string }
  | { kind: 'DRAFT'; card: ScheduleCreateCard; at: string };

export interface ScheduleTimelineGroup {
  key: ScheduleTimelineGroupKey;
  /** "Today", "Monday", "Later", "Paused". */
  title: string;
  /** "Fri, Nov 14" under Today and Tomorrow, "Nov 17" under a day, the count under Paused. */
  subtitle: string | null;
  items: ScheduleTimelineItem[];
}

const IN_PROGRESS: readonly ScheduleRunState[] = ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL'];

/**
 * The Scheduled page's groups (§9.2), in the viewer's zone:
 *
 *   * Today, Tomorrow, then each day of the coming week by its name ("Monday"), then Later. A schedule appears on
 *     the day of its next run, a draft on the day of its first. A run under way (queued, running or waiting for an
 *     approval) appears on its planned day; a run that has ended appears on today's list only with `showPastRuns`.
 *   * Paused: the schedules that do not run, held before paused; a held one has no next run to be placed on.
 *
 * There is no group of errors (owner 2026-11-19): the page lists the schedules, and a failing one is tagged on its own
 * row on the day of its next run (scheduleRowCircle). Ended schedules appear nowhere; empty groups are left out.
 * Within a day, items are in time order.
 */
export function scheduleTimeline(input: {
  schedules: ScheduleListRow[];
  /** Runs to place: what is under way, and today's ended runs for Show past runs. */
  runs?: ScheduleRunView[];
  drafts?: ScheduleCreateCard[];
  showPastRuns?: boolean;
  now: Date;
  timezone: string;
}): ScheduleTimelineGroup[] {
  const { now, timezone } = input;
  const today = localParts(now, timezone).dayNumber;
  const byId = new Map(input.schedules.map((s) => [s.id, s]));
  const days = new Map<number, ScheduleTimelineItem[]>();
  const later: ScheduleTimelineItem[] = [];
  const place = (item: ScheduleTimelineItem & { at: string }) => {
    const day = Math.max(localParts(new Date(item.at), timezone).dayNumber, today);
    if (day - today >= 7) later.push(item);
    else days.set(day, [...(days.get(day) ?? []), item]);
  };

  const paused = input.schedules.filter((s) => s.state === 'PAUSED' || s.state === 'HELD').sort((a, b) =>
    (a.state === 'HELD' ? 0 : 1) - (b.state === 'HELD' ? 0 : 1) || a.title.localeCompare(b.title));

  for (const s of input.schedules) {
    if (s.state === 'ACTIVE' && s.nextDueAt) place({ kind: 'SCHEDULE', schedule: s, at: s.nextDueAt });
  }
  for (const card of input.drafts ?? []) {
    if (card.when.firstRunAt) place({ kind: 'DRAFT', card, at: card.when.firstRunAt });
  }
  for (const run of input.runs ?? []) {
    const schedule = byId.get(run.scheduleId);
    if (!schedule) continue;
    if (IN_PROGRESS.includes(run.state)) {
      place({ kind: 'RUN', schedule, run, at: run.plannedAt });
    } else if (input.showPastRuns && localParts(new Date(run.plannedAt), timezone).dayNumber === today) {
      place({ kind: 'RUN', schedule, run, at: run.plannedAt });
    }
  }

  const byTime = (a: ScheduleTimelineItem, b: ScheduleTimelineItem) =>
    new Date(a.at ?? 0).getTime() - new Date(b.at ?? 0).getTime();
  const groups: ScheduleTimelineGroup[] = [];
  for (const day of [...days.keys()].sort((a, b) => a - b)) {
    const items = days.get(day)!.sort(byTime);
    const at = new Date(items[0]!.at!);
    const offset = day - today;
    const p = localParts(at, timezone);
    if (offset === 0 || offset === 1) {
      groups.push({
        key: offset === 0 ? 'TODAY' : 'TOMORROW',
        title: offset === 0 ? C.groups.TODAY : C.groups.TOMORROW,
        subtitle: scheduleDayWithWeekdayText(at, timezone),
        items,
      });
    } else {
      groups.push({ key: 'DAY', title: C.weekdays[p.weekday], subtitle: scheduleDateText(at, timezone), items });
    }
  }
  if (later.length) groups.push({ key: 'LATER', title: C.groups.LATER, subtitle: null, items: later.sort(byTime) });
  if (paused.length) {
    groups.push({
      key: 'PAUSED',
      title: C.groups.PAUSED,
      subtitle: String(paused.length),
      items: paused.map((s) => ({ kind: 'SCHEDULE' as const, schedule: s, at: null })),
    });
  }
  return groups;
}

// ---------------------------------------------------------------------------------------------------------------
// The envelope card: Now / Asked
// ---------------------------------------------------------------------------------------------------------------

const ACCESS_ORDER: Record<ScheduleAccessLevel, number> = { CHECK_ONLY: 0, OPEN_PR: 1, LAND: 2 };

/** The parts of `after` wider than `before`, in the card's order (schedule-envelope.ts widenedParts). */
export function scheduleWidenedParts(before: ScheduleEnvelope, after: ScheduleEnvelope): ScheduleEnvelopePart[] {
  const parts: ScheduleEnvelopePart[] = [];
  if (after.workspaceId !== before.workspaceId) parts.push('WORKSPACE');
  if (ACCESS_ORDER[after.accessLevel] > ACCESS_ORDER[before.accessLevel]) parts.push('ACCESS_LEVEL');
  if (after.runsPerWeek > before.runsPerWeek) parts.push('RUNS_PER_WEEK');
  if (after.runLimitMinutes > before.runLimitMinutes) parts.push('RUN_LIMIT');
  if (after.commandHash && after.commandHash !== (before.commandHash ?? null)) parts.push('PROBE_COMMAND');
  return parts;
}

export interface ScheduleEnvelopeSide {
  /** The part set in bold on Asked ("Daily 10:00", "Open a PR"). */
  lead: string;
  detail: string;
  text: string;
}

/** The part a card is about: access first, then where it runs, how often, how long. */
function headPart(widens: readonly ScheduleEnvelopePart[]): ScheduleEnvelopePart | null {
  for (const p of ['ACCESS_LEVEL', 'WORKSPACE', 'PROBE_COMMAND', 'RUNS_PER_WEEK', 'RUN_LIMIT'] as const) if (widens.includes(p)) return p;
  return null;
}

/**
 * An envelope card's Now and Asked lines (board 2/2 ② ③):
 *
 *   access:      Now "Check only — reads and reports"
 *                Asked "Open a PR — edits in its own worktree and opens a PR. It can't merge or deploy."
 *   how often:   Now "Mondays 10:00 · up to 1 run a week"
 *                Asked "Daily 10:00 · up to 7 runs a week, 30 min each"
 *
 * Now names the run limit only where it differs from Asked. `ruleNow` / `ruleAsked` are the schedule's rule and the
 * rule the change asks for (the card's `proposed.rule`, else the same).
 */
export function scheduleEnvelopeSides(input: {
  widens: readonly ScheduleEnvelopePart[];
  now: ScheduleEnvelope | null;
  asked: ScheduleEnvelope;
  ruleNow?: ScheduleRule | null;
  ruleAsked?: ScheduleRule | null;
  workspaceNames?: Record<string, string>;
}): { now: ScheduleEnvelopeSide | null; asked: ScheduleEnvelopeSide } {
  const part = headPart(input.widens);
  const side = (e: ScheduleEnvelope, rule: ScheduleRule | null | undefined, isNow: boolean): ScheduleEnvelopeSide => {
    if (part === 'ACCESS_LEVEL') {
      const a = C.access[e.accessLevel];
      const detail = isNow ? a.brief : a.detail;
      return { lead: a.label, detail, text: `${a.label}${C.envelopeCard.accessJoin}${detail}` };
    }
    if (part === 'PROBE_COMMAND') {
      // The command verbatim on both sides: what was approved, and what Allow would approve (board ⑥).
      const command = rule?.kind === 'WHEN' ? rule.condition.command : '';
      return { lead: command, detail: '', text: command };
    }
    const sameLimit = input.now?.runLimitMinutes === input.asked.runLimitMinutes;
    const costs = isNow && sameLimit
      ? scheduleFill(C.costs.runsOnly, { runs: scheduleRunsPerWeekText(e.runsPerWeek) })
      : scheduleFill(C.costs.upToLower, { runs: scheduleRunsPerWeekText(e.runsPerWeek), minutes: e.runLimitMinutes });
    const lead = part === 'WORKSPACE'
      ? (input.workspaceNames?.[e.workspaceId] ?? e.workspaceId)
      : rule ? scheduleRuleText(rule, 'short') : '';
    return { lead, detail: costs, text: lead ? `${lead}${C.separator}${costs}` : capitalize(costs) };
  };
  return {
    now: input.now ? side(input.now, input.ruleNow, true) : null,
    asked: side(input.asked, input.ruleAsked ?? input.ruleNow, false),
  };
}

/** "Let Codex stable check open PRs?" */
export function scheduleEnvelopeTitle(title: string, widens: readonly ScheduleEnvelopePart[], workspaceName?: string, accessLevel?: ScheduleAccessLevel): string {
  const part = headPart(widens) ?? 'RUNS_PER_WEEK';
  return scheduleFill(part === 'ACCESS_LEVEL' && accessLevel === 'LAND' ? C.envelopeCard.landTitle : C.envelopeCard.titles[part], { title, ...(workspaceName ? { workspace: workspaceName } : {}) });
}

/** The card's decline button: "Keep check only", "Keep weekly", else "Keep as it is". */
export function scheduleKeepLabel(
  widens: readonly ScheduleEnvelopePart[],
  now: ScheduleEnvelope | null,
  workspaceName?: string,
): string {
  const part = headPart(widens);
  if (part === 'ACCESS_LEVEL' && now?.accessLevel === 'CHECK_ONLY') return C.keep.ACCESS_LEVEL;
  if (part === 'RUNS_PER_WEEK' && now?.runsPerWeek === 1) return C.keep.RUNS_PER_WEEK;
  if (part === 'RUN_LIMIT' && now) return scheduleFill(C.keep.RUN_LIMIT, { minutes: now.runLimitMinutes });
  if (part === 'WORKSPACE' && workspaceName) return scheduleFill(C.keep.WORKSPACE, { workspace: workspaceName });
  if (part === 'PROBE_COMMAND') return CC.keep;
  return C.keep.other;
}

/** The note under an envelope card. */
export function scheduleEnvelopeNote(widens: readonly ScheduleEnvelopePart[]): string {
  if (widens.includes('PROBE_COMMAND')) return CC.commandNote;
  return widens.includes('ACCESS_LEVEL')
    ? `${C.envelopeCard.appliesFromNextRun} ${C.envelopeCard.checkedEachRun}`
    : C.envelopeCard.appliesFromNextRun;
}

/**
 * A widen card in Waiting on you: "<reason> Now: Check only. Asked: Open a PR · edits in its own worktree and opens a
 * PR. It can't merge or deploy." For access, Now is the label alone.
 */
export function scheduleWidenWaitingText(input: {
  reason: string;
  widens: readonly ScheduleEnvelopePart[];
  now: ScheduleEnvelope | null;
  asked: ScheduleEnvelope;
  ruleNow?: ScheduleRule | null;
  ruleAsked?: ScheduleRule | null;
  workspaceNames?: Record<string, string>;
}): string {
  const sides = scheduleEnvelopeSides(input);
  const access = headPart(input.widens) === 'ACCESS_LEVEL';
  const now = sides.now ? (access ? sides.now.lead : sides.now.text) : '';
  const asked = access ? `${sides.asked.lead}${C.separator}${sides.asked.detail}` : sides.asked.text;
  return scheduleFill(C.waiting.widen.body, { reason: input.reason, now, asked }).trim();
}

// ---------------------------------------------------------------------------------------------------------------
// History and the change line
// ---------------------------------------------------------------------------------------------------------------

export type ScheduleHistoryWho = 'USER' | 'SESSION' | 'RUN' | 'ALLOWED';

/**
 * Who a history entry names: You, Session or Run — and You allowed for a change a session or a run asked for that
 * grew the envelope, which only the owner's Allow can apply (§4).
 */
export function scheduleHistoryWho(record: Pick<ScheduleChangeRecord, 'changedBy' | 'before' | 'after'>): {
  who: ScheduleHistoryWho;
  text: string;
} {
  if (record.changedBy !== 'USER') {
    const before = record.before?.envelope as ScheduleEnvelope | undefined;
    const after = record.after?.envelope as ScheduleEnvelope | undefined;
    if (before && after && scheduleWidenedParts(before, after).length > 0) {
      return { who: 'ALLOWED', text: C.history.who.ALLOWED };
    }
  }
  return { who: record.changedBy, text: C.history.who[record.changedBy] };
}

function fieldValueText(field: string, value: unknown, names: Record<string, string>): string {
  if (value === null || value === undefined) return field === 'endAt' || field === 'maxRuns' ? C.history.noEnd : '';
  if (field === 'accessLevel') return C.access[value as ScheduleAccessLevel]?.label ?? String(value);
  if (field === 'runLimitMinutes') return scheduleFill(C.history.minutes, { minutes: Number(value) });
  if (field === 'workspaceId') return names[String(value)] ?? String(value);
  return String(value);
}

function ruleChangeText(before: ScheduleRule | undefined, after: ScheduleRule): { field: string | null; text: string } {
  if (
    before && before.kind !== 'ONCE' && after.kind !== 'ONCE' && before.kind !== 'WHEN' && after.kind !== 'WHEN'
    && before.kind !== 'EVERY' && after.kind !== 'EVERY'
  ) {
    const sameShape = before.kind === after.kind
      && (before.kind !== 'WEEKLY' || after.kind !== 'WEEKLY' || before.weekdays.join() === after.weekdays.join());
    if (sameShape && before.time !== after.time) {
      return {
        field: C.history.fields.rule,
        text: scheduleFill(C.history.change, { field: C.history.fields.rule, before: before.time, after: after.time }),
      };
    }
    if (before.time === after.time) {
      // "Daily → Mondays 10:00": the time is said once, after the arrow.
      const was = scheduleRuleText(before, 'short').slice(0, -before.time.length).trimEnd().replace(/ at$/, '');
      return { field: null, text: scheduleFill(C.history.ruleChange, { before: was, after: scheduleRuleText(after, 'short') }) };
    }
  }
  return {
    field: null,
    text: scheduleFill(C.history.ruleChange, {
      before: before ? scheduleRuleText(before, 'short') : '',
      after: scheduleRuleText(after, 'short'),
    }),
  };
}

/**
 * What a revision changed, as one line: "Time 10:00 → 09:00", "Access → Open a PR", "Prompt: …", "Daily → Mondays
 * 10:00", "Name: Codex check → Codex stable check", "Created · Check only · up to 7 runs a week", "Paused".
 * `field` is the label the change line lowercases ("Changed X: time 10:00 → 09:00").
 */
export function scheduleRecordParts(
  record: Pick<ScheduleChangeRecord, 'before' | 'after' | 'revision'>,
  names: Record<string, string> = {},
): { field: string | null; text: string } {
  const after = record.after ?? {};
  const before = record.before ?? {};
  if (record.revision === 1 || record.before === null) {
    const envelope = after.envelope as ScheduleEnvelope | undefined;
    const access = (after.accessLevel ?? envelope?.accessLevel) as ScheduleAccessLevel | undefined;
    return {
      field: null,
      text: scheduleFill(C.history.created, {
        access: access ? C.access[access].label : '',
        runs: envelope ? scheduleFill(C.costs.runsOnly, { runs: scheduleRunsPerWeekText(envelope.runsPerWeek) }) : '',
      }),
    };
  }
  if ('state' in after) {
    if (after.state === 'PAUSED') return { field: null, text: C.history.paused };
    if (after.state === 'ENDED') {
      const reason = (C.endedReasons as Record<string, string>)[String(after.endedReason)] ?? '';
      return { field: null, text: scheduleFill(C.history.ended, { reason }) };
    }
    if (after.state === 'ACTIVE') return { field: null, text: C.history.resumed };
  }
  const fields = Object.keys(after).filter((k) => k !== 'envelope' && k !== 'endedReason');
  const key = fields.find((k) => k === 'rule')
    ?? fields.find((k) => k === 'accessLevel')
    ?? fields[0];
  if (!key) return { field: null, text: '' };
  if (key === 'rule') return ruleChangeText(before.rule as ScheduleRule | undefined, after.rule as ScheduleRule);
  const label = (C.history.fields as Record<string, string>)[key] ?? key;
  const a = fieldValueText(key, after[key], names);
  if (key === 'prompt' || key === 'intent') return { field: label, text: scheduleFill(C.history.changeText, { field: label, after: a }) };
  if (key === 'title') {
    return { field: label, text: scheduleFill(C.history.changeText, { field: label, after: `${fieldValueText(key, before[key], names)} → ${a}` }) };
  }
  if (key === 'accessLevel') return { field: label, text: scheduleFill(C.history.changeTo, { field: label, after: a }) };
  return { field: label, text: scheduleFill(C.history.change, { field: label, before: fieldValueText(key, before[key], names), after: a }) };
}

/**
 * A person's rename as the history says it (§8.4 *Rename*): "Renamed from “Codex check”". Null for any other record,
 * an agent's new title included, which reads as every change does ("Name: Codex check → Codex stable check").
 */
export function scheduleRenamedText(record: Pick<ScheduleChangeRecord, 'changedBy' | 'before' | 'after'>): string | null {
  const keys = Object.keys(record.after ?? {});
  if (record.changedBy !== 'USER' || !record.before || keys.length !== 1 || keys[0] !== 'title') return null;
  return scheduleFill(C.history.renamed, { title: String(record.before.title) });
}

export function scheduleRecordText(
  record: Pick<ScheduleChangeRecord, 'before' | 'after' | 'revision'>,
  names: Record<string, string> = {},
): string {
  return scheduleRecordParts(record, names).text;
}

/**
 * The change line in a session: "Changed Codex stable check: time 10:00 → 09:00", or for an end "Ended Release 2.0
 * freeze watch: goal reached · by this run".
 */
export function scheduleChangeLineText(
  record: Pick<ScheduleChangeRecord, 'title' | 'before' | 'after' | 'revision' | 'changedBy'>,
  names: Record<string, string> = {},
): string {
  if (record.after?.state === 'ENDED') {
    const reason = (C.endedReasons as Record<string, string>)[String(record.after.endedReason)] ?? '';
    const by = record.changedBy === 'RUN' ? C.record.byThisRun : record.changedBy === 'USER' ? C.record.byYou : C.record.byASession;
    return scheduleFill(C.record.ended, { title: record.title, reason, by });
  }
  const parts = scheduleRecordParts(record, names);
  const change = parts.field && parts.text.startsWith(parts.field) ? lowerFirst(parts.text) : parts.text;
  return scheduleFill(C.record.changed, { title: record.title, change });
}

// ---------------------------------------------------------------------------------------------------------------
// Waiting on you
// ---------------------------------------------------------------------------------------------------------------

export interface ScheduleWaitingText {
  title: string;
  kind: string;
  body: string;
  actions: string[];
}

const SUMMARY_MAX = 120;

/**
 * The failure clause a failure card and its push say: a REPORTED_FAILED run's own summary, one line of at most 120
 * characters with no closing full stop ("reported a failure: The releases page returned 503"), else the reason's.
 */
function failedWaitingClause(run: Pick<ScheduleRunView, 'failureReason' | 'reasonText'> & { summary?: string | null }): string {
  return reportedFailureClause(run) ?? scheduleFailureClause(run) ?? C.failureReasons.REPORTED_FAILED;
}

/** A REPORTED_FAILED run's clause with its own summary, or null when the run has none (or the server's reasonText). */
function reportedFailureClause(run: Pick<ScheduleRunView, 'failureReason' | 'reasonText'> & { summary?: string | null }): string | null {
  const template = run.reasonText ? undefined
    : (C.failureReasonsWithSummary as Record<string, string>)[String(run.failureReason)];
  const flat = run.summary?.replace(/\s+/g, ' ').trim().replace(/[.。]+$/, '') ?? '';
  if (!template || !flat) return null;
  const summary = flat.length <= SUMMARY_MAX ? flat : `${flat.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;
  return scheduleFill(template, { summary });
}

/** A failed schedule's card: "Nightly pg spec sweep failed 3 runs in a row". */
export function scheduleFailedWaiting(input: {
  title: string;
  consecutiveFailures: number;
  run: Pick<ScheduleRunView, 'failureReason' | 'reasonText' | 'plannedAt'> & { summary?: string | null };
  timezone: string;
}): ScheduleWaitingText {
  const at = new Date(input.run.plannedAt);
  return {
    title: input.consecutiveFailures > 1
      ? scheduleFill(C.waiting.failed.titleInARow, { title: input.title, count: input.consecutiveFailures })
      : scheduleFill(C.waiting.failed.title, { title: input.title }),
    kind: C.waiting.kinds.schedule,
    body: scheduleFill(C.waiting.failed.body, {
      reason: failedWaitingClause(input.run),
      when: `${scheduleDateText(at, input.timezone)}, ${localParts(at, input.timezone).time}`,
    }),
    actions: [C.actions.openRun, C.actions.pauseSchedule],
  };
}

/**
 * A failure's push: the card's title, and "The last run ended without a report. It keeps running until you pause it."
 */
export function scheduleFailedPush(input: Parameters<typeof scheduleFailedWaiting>[0]): { title: string; body: string } {
  return {
    title: scheduleFailedWaiting(input).title,
    body: scheduleFill(C.push.failedBody, {
      reason: failedWaitingClause(input.run),
    }),
  };
}

/** A run ending its own schedule: "Release 2.0 freeze watch ended itself". */
export function scheduleGoalReachedPushTitle(title: string): string {
  return scheduleFill(C.push.goalReachedTitle, { title });
}

/** A run failed NO_REPORT or ENGINE_CRASHED that reported late, once the owner stepped in: "Nightly audit reported after all". */
export function scheduleReportedLatePushTitle(title: string): string {
  return scheduleFill(C.push.reportedLateTitle, { title });
}

/** §8.5: "Stopped as planned after 12 runs", "after 1 run": the planned-end push and an ENDED row's read. */
export function scheduleStoppedAsPlannedText(runs: number): string {
  return scheduleFill(C.push.stoppedAsPlanned, { runs: `${runs} ${runs === 1 ? 'run' : 'runs'}` });
}

/** A held schedule's card: "Weekly dependency audit is held". */
export function scheduleHeldWaiting(input: {
  title: string;
  heldReason: string | null;
  plannedAt: string;
  agentName?: string | null;
  workspaceName?: string | null;
  now: Date;
  timezone: string;
}): ScheduleWaitingText {
  const held = scheduleHeldClause(input.heldReason, { agent: input.agentName, workspace: input.workspaceName });
  const agent = input.heldReason === 'AGENT_DISABLED' || input.heldReason === 'AGENT_MISSING';
  const where = agent && input.agentName && input.workspaceName
    ? scheduleFill(C.heldWhere, { workspace: input.workspaceName })
    : '';
  const reason = held ? (where ? held.clause.replace(/ (is disabled|no longer exists)$/, `${where} $1`) : held.clause) : '';
  return {
    title: scheduleFill(C.waiting.held.title, { title: input.title }),
    kind: C.waiting.kinds.schedule,
    body: scheduleFill(C.waiting.held.body, {
      when: schedulePastWhenText(new Date(input.plannedAt), input.now, input.timezone),
      reason,
      until: held?.until ?? C.heldReasons.SESSION_REFUSED.until,
    }),
    actions: [agent ? C.actions.openAgentSettings : C.actions.openSchedule, C.actions.resume],
  };
}

/** A run's approval card: "Nightly pg spec sweep wants to run a command". */
export function scheduleApprovalWaiting(input: {
  title: string;
  deadline: string;
  nextAt: string | null;
  pattern: string;
  workspaceName: string;
  now: Date;
  timezone: string;
}): ScheduleWaitingText & { alwaysAllow: string } {
  const deadline = localParts(new Date(input.deadline), input.timezone).time;
  const nextDay = input.nextAt ? scheduleDayText(new Date(input.nextAt), input.now, input.timezone) : '';
  const next = nextDay === C.dates.today ? C.dates.todayLower : nextDay === C.dates.tomorrow ? C.dates.tomorrowLower : nextDay;
  return {
    title: scheduleFill(C.waiting.approval.title, { title: input.title }),
    kind: C.waiting.kinds.run,
    body: scheduleFill(C.waiting.approval.body, { deadline, next }),
    alwaysAllow: scheduleFill(C.waiting.approval.alwaysAllow, { pattern: input.pattern, workspace: input.workspaceName }),
    actions: [C.actions.alwaysAllow, C.actions.allowOnce, C.actions.deny],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// A run's session
// ---------------------------------------------------------------------------------------------------------------

/** "Scheduled run · planned 10:00, started 10:01 · access Check only". */
export function scheduleRunStripText(
  run: Pick<ScheduleRunView, 'plannedAt' | 'startedAt'>,
  accessLevel: ScheduleAccessLevel,
  timezone: string,
): string {
  return scheduleFill(C.runSession.strip, {
    planned: localParts(new Date(run.plannedAt), timezone).time,
    started: run.startedAt ? localParts(new Date(run.startedAt), timezone).time : '—',
    access: C.access[accessLevel].label,
  });
}

/** "run of Nov 13". */
export function scheduleRunOfText(run: Pick<ScheduleRunView, 'plannedAt'>, timezone: string): string {
  return scheduleFill(C.runSession.runOf, { date: scheduleDateText(new Date(run.plannedAt), timezone) });
}

/** "Reported: Changed · codex@0.49.0 · you were notified". */
export function scheduleReportedText(
  run: Pick<ScheduleRunView, 'state' | 'key'>,
  opts: { notified?: boolean } = {},
): string {
  const parts = [scheduleFill(C.runSession.reported, { state: C.runStates[run.state] })];
  if (run.key) parts.push(run.key);
  if (opts.notified) parts.push(C.row.notified);
  return parts.join(C.separator);
}

// ---------------------------------------------------------------------------------------------------------------
// A run's session when the run did not get under way in it (board docs/mocks/scheduled-run-not-started ②③④)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The card a run's session shows in place of its report and composer when the run never reached its engine there
 * (owner's B1): it did not run, it waits on a full runner, or it started on a later try. In
 * contracts/schedule.contract.json as `runStatusCopy`, which OrbitKit and Android pin.
 */
export const SCHEDULE_RUN_STATUS_COPY = {
  /** The strip of a run that did not start in this session: no start time to name. */
  strip: 'Scheduled run · planned {planned} · access {access}',
  didntRun: {
    title: "Didn't run",
    /** RUNNER_UNAVAILABLE: the runner was there and did not take it. */
    notPickedUp: "{runner} didn't pick it up on any of {tries} tries, so the run never started.",
    notPickedUpOnce: "{runner} didn't pick it up, so the run never started.",
    /** RUNNER_FULL: it waited in the runner's queue until its window closed. */
    full: '{runner} was full the whole time, so the run never started.',
    /** ENGINE_CRASHED_BEFORE_START. */
    engineFailed: "{runner} couldn't start the engine on any of {tries} tries, so the run never started.",
    engineFailedOnce: "{runner} couldn't start the engine, so the run never started.",
    quota: "The engine's usage limit was reached, so the run never started.",
    cancelled: 'You cancelled the run before it started.',
    nothingChanged: 'Nothing was changed.',
    gaveUp: 'gave up {time}',
    nextRun: 'Next run: {when}',
  },
  queued: {
    /** `Queued · runner full`; the gate's own tag for a full run or batch. */
    title: 'Queued · {tag}',
    waited: '{waited} · gives up at {deadline}',
    givesUp: 'Gives up at {deadline}',
  },
  startedOn: {
    title: 'Started on try {try}',
    body: 'This try stopped before its engine started ({why}). Try {try} started at {time}.',
    engineExited: '{engine} exited',
    notPickedUp: "{runner} didn't pick it up",
  },
  actions: {
    runNow: 'Run now',
    openSchedule: 'Open schedule',
    cancelRun: 'Cancel run',
    openRun: 'Open the run →',
  },
} as const;

const RS = SCHEDULE_RUN_STATUS_COPY;

/** Which card a run's session shows, if any: ② `DIDNT_RUN`, ③ `QUEUED_FULL`, ④ `STARTED_ON`. */
export type ScheduleRunStatusKind = 'DIDNT_RUN' | 'QUEUED_FULL' | 'STARTED_ON';

const GAVE_UP_STATES: readonly ScheduleRunState[] = ['MISSED', 'CANCELLED', 'SKIPPED'];

/**
 * The card for this session of the run, or null when its run reached its engine here (its report and composer are
 * the session's own then), or is between tries with nothing to say yet.
 *
 *   * ② the run ended with no try reaching its engine: from any of its tries' sessions;
 *   * ③ the run's current session waits on a full runner, run or batch: from it and from earlier tries;
 *   * ④ this try did not reach its engine, and the run's current session did.
 */
export function scheduleRunStatusKind(
  run: Pick<ScheduleRunView, 'state' | 'sessionId'>,
  status: ScheduleRunSessionStatus | null | undefined,
): ScheduleRunStatusKind | null {
  if (!status || status.thisTry === null) return null;
  const mine = status.tries[status.thisTry - 1];
  if (!mine || mine.reachedEngine) return null;
  if (status.gaveUpAt && GAVE_UP_STATES.includes(run.state)) return 'DIDNT_RUN';
  if (status.queue && run.state === 'RUNNING') return 'QUEUED_FULL';
  const current = run.sessionId ? status.tries.find((t) => t.sessionId === run.sessionId) : undefined;
  if (current && current.sessionId !== mine.sessionId && current.reachedEngine) return 'STARTED_ON';
  return null;
}

/** "Scheduled run · planned 03:32 · access Edit and land on main". */
export function scheduleRunNotStartedStripText(
  run: Pick<ScheduleRunView, 'plannedAt'>,
  accessLevel: ScheduleAccessLevel,
  timezone: string,
): string {
  return scheduleFill(RS.strip, { planned: localParts(new Date(run.plannedAt), timezone).time, access: C.access[accessLevel].label });
}

/** "tomorrow 06:00", "Monday 06:00", "Nov 24 06:00": a time inside a sentence. */
function inlineWhenText(at: Date, now: Date, timezone: string): string {
  return lowerDay(scheduleWhenText(at, now, timezone));
}

function lowerDay(text: string): string {
  for (const [day, lower] of [[C.dates.today, C.dates.todayLower], [C.dates.tomorrow, C.dates.tomorrowLower]] as const) {
    if (text.startsWith(day)) return lower + text.slice(day.length);
  }
  return text;
}

/** ② The reason a run did not run, as one sentence, then "Nothing was changed.". */
export function scheduleDidntRunReasonText(
  run: Pick<ScheduleRunView, 'failureReason'>,
  tries: number,
  runner: string,
): string {
  const n = { runner, tries };
  let reason: string;
  switch (run.failureReason) {
    case 'RUNNER_FULL':
      reason = scheduleFill(RS.didntRun.full, n);
      break;
    case 'CANCELLED_BY_OWNER':
      reason = RS.didntRun.cancelled;
      break;
    case 'QUOTA':
      reason = RS.didntRun.quota;
      break;
    case 'ENGINE_CRASHED_BEFORE_START':
      reason = scheduleFill(tries > 1 ? RS.didntRun.engineFailed : RS.didntRun.engineFailedOnce, n);
      break;
    default:
      reason = scheduleFill(tries > 1 ? RS.didntRun.notPickedUp : RS.didntRun.notPickedUpOnce, n);
  }
  return `${reason} ${RS.didntRun.nothingChanged}`;
}

/** ② The card's words: its title, reason, each try's time, when it gave up and the next run. */
export function scheduleDidntRunText(input: {
  run: Pick<ScheduleRunView, 'failureReason'>;
  status: Pick<ScheduleRunSessionStatus, 'tries' | 'gaveUpAt' | 'nextDueAt'>;
  runner: string;
  now: Date;
  timezone: string;
}): { title: string; reason: string; tries: string[]; gaveUp: string | null; next: string | null } {
  const { status, timezone } = input;
  return {
    title: RS.didntRun.title,
    reason: scheduleDidntRunReasonText(input.run, status.tries.length, input.runner),
    tries: status.tries.map((t) => localParts(new Date(t.startedAt), timezone).time),
    gaveUp: status.gaveUpAt
      ? scheduleFill(RS.didntRun.gaveUp, { time: localParts(new Date(status.gaveUpAt), timezone).time })
      : null,
    next: status.nextDueAt
      ? scheduleFill(RS.didntRun.nextRun, { when: inlineWhenText(new Date(status.nextDueAt), input.now, timezone) })
      : null,
  };
}

/**
 * ③ The card's title and its foot: "Queued · runner full", "Waiting 1 h 12 min · gives up at 03:32 tomorrow". The
 * sentence between them is the queued message's own (web queuedCapacity `capacityHeldMessageText`), said of the run.
 */
export function scheduleQueuedFullText(input: {
  tag: string;
  waited: string | null;
  deadline: string;
  now: Date;
  timezone: string;
}): { title: string; waited: string } {
  const at = new Date(input.deadline);
  const time = localParts(at, input.timezone).time;
  const day = scheduleDayText(at, input.now, input.timezone);
  const deadline = day === C.dates.today ? time : `${time} ${lowerDay(day)}`;
  return {
    title: scheduleFill(RS.queued.title, { tag: input.tag }),
    waited: scheduleFill(input.waited ? RS.queued.waited : RS.queued.givesUp, { waited: input.waited ?? '', deadline }),
  };
}

/** ④ "Started on try 3", and why this try stopped: "This try stopped before its engine started (Claude Code exited)…". */
export function scheduleStartedOnText(input: {
  run: Pick<ScheduleRunView, 'sessionId'>;
  status: Pick<ScheduleRunSessionStatus, 'tries' | 'thisTry'>;
  engine: string;
  runner: string;
  timezone: string;
}): { title: string; body: string } | null {
  const { tries } = input.status;
  const index = tries.findIndex((t) => t.sessionId === input.run.sessionId);
  const mine = input.status.thisTry === null ? undefined : tries[input.status.thisTry - 1];
  if (index < 0 || !mine) return null;
  const n = index + 1;
  const why = mine.claimed
    ? scheduleFill(RS.startedOn.engineExited, { engine: input.engine })
    : scheduleFill(RS.startedOn.notPickedUp, { runner: input.runner });
  return {
    title: scheduleFill(RS.startedOn.title, { try: n }),
    body: scheduleFill(RS.startedOn.body, { why, try: n, time: localParts(new Date(tries[index]!.startedAt), input.timezone).time }),
  };
}
