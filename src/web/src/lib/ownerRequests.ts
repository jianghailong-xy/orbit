import {
  CONDITION_STILL_WAITING_KIND,
  CONDITION_WAITING_KIND,
  SCHEDULE_COPY,
  SCHEDULE_WAITING_KINDS,
  type OwnerCardTranslation,
  type OwnerRequestChangeSpec,
} from '@orbit/shared';
import { CONDITION_COPY } from './conditions';
import { useEffect, useSyncExternalStore } from 'react';
import { formatSpan, sameResourceId } from './watches';

/**
 * Owner requests: what a session has asked the account owner to do (apiserver `owner-requests`).
 * The rules with no component in them: what a request says about itself, and the one thing the
 * server does not hold — a reminder for later.
 */

export type OwnerRequestKind =
  | 'DECISION' | 'SECRET' | 'MANUAL_STEP' | 'CONFIRM' | 'WIKI_CREATE'
  // A change to the owner's own Settings, proposed by a session (docs/settings-from-conversation-design.md §5.1).
  | 'SETTINGS_CHANGE'
  // A session asking the owner to reopen a DONE or CANCELLED project (docs/project-reopen-request-design.md).
  | 'PROJECT_REOPEN'
  // An agent on the Orbit Cloud runner asking the owner to sign in to a site in its browser (browser_request_sign_in).
  | 'BROWSER_SIGN_IN'
  // An agent proposing one setting of a runner, which the owner applies with one press (docs/design/owner-request-change.md).
  | 'CHANGE'
  // A scheduled task's items, which no session can file (apiserver schedules/schedule-attention.ts).
  | 'SCHEDULE_FAILED' | 'SCHEDULE_HELD' | 'SCHEDULE_APPROVAL' | 'SCHEDULE_WIDEN'
  // A condition's items (apiserver conditions/condition-attention.ts): it cannot be read, or a task's condition has
  // not held in 30 days.
  | 'CONDITION_UNKNOWN' | 'CONDITION_STILL_WAITING';
/** The kinds a session files, answered on the request's own doors. */
export type AgentRequestKind = Exclude<OwnerRequestKind, `SCHEDULE_${string}` | `CONDITION_${string}`>;
export type OwnerRequestState = 'PENDING' | 'DONE' | 'DECLINED' | 'EXPIRED' | 'WITHDRAWN';
export type OwnerRequestListFilter = 'open' | 'done' | 'declined' | 'all';

export interface OwnerRequestOption {
  label: string;
  description?: string;
}

export interface OwnerRequestStep {
  text: string;
  command?: string;
  link?: string;
}

export interface OwnerRequestSecretSpec {
  name: string;
  runnerId: string;
  envVar?: string;
  filePath?: string;
}

export type OwnerRequestSecretGrantState = 'PENDING_DELIVERY' | 'ACTIVE' | 'REMOVING' | 'REMOVED';

/** The request's latest secret grant: where the key it delivered stands. Never the value or anything derived from it. */
export interface OwnerRequestSecretGrant {
  state: OwnerRequestSecretGrantState;
  endReason: string | null;
  exposure: 'ENV' | 'FILE';
  expiresAt: string;
  deliveredAt: string | null;
  removedAt: string | null;
  removalNote: string | null;
  runnerOnline: boolean;
  runnerLastSeenAt: string | null;
}

/** A saved account secret, by label only: no route returns a value. */
export interface AccountSecret {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

export interface OwnerRequest {
  id: string;
  kind: OwnerRequestKind;
  state: OwnerRequestState;
  title: string;
  why: string;
  blocksTaskIds: string[];
  ifUnanswered: string | null;
  options: OwnerRequestOption[] | null;
  recommendedOption: number | null;
  steps: OwnerRequestStep[] | null;
  secretSpec: OwnerRequestSecretSpec | null;
  /** SECRET: what ends the key (design §6.1) — its task, or, for a session with no task, the session. */
  secretScope?: 'TASK' | 'SESSION';
  secretGrant: OwnerRequestSecretGrant | null;
  /** CHANGE: the runner setting asked for, and its value when it was asked (the server reads `before`). */
  changeSpec?: OwnerRequestChangeSpec | null;
  verifyHint: string | null;
  /** WIKI_CREATE: the repository the wiki is asked for, and the asking session's workspace it would read it from. */
  repoUrlNorm?: string | null;
  workspaceId?: string | null;
  /** BROWSER_SIGN_IN: the site to sign in to, the Orbit Cloud runner whose browser it is, and the asking session's title. */
  browserSite?: string | null;
  browserRunnerId?: string | null;
  askedBySessionTitle?: string | null;
  /** SCHEDULE_*: the schedule, run, approval card and change request the item is about. */
  scheduleId?: string | null;
  scheduleRunId?: string | null;
  approvalId?: string | null;
  scheduleChangeRequestId?: string | null;
  /** CONDITION_*: the condition the item is about, which names its schedule or task. */
  conditionId?: string | null;
  /** SETTINGS_CHANGE: `{ changes: [{ key, from, to, tier }] }`, which the card draws (lib/settingsChange). */
  payload?: unknown;
  expiresAt: string | null;
  askedBySessionId: string;
  projectId: string | null;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  resolvedBySessionId: string | null;
  resolutionNote: string | null;
  /** DECISION: the option and text; WIKI_CREATE once DONE: the wiki made. */
  answer: { option?: number; text?: string; spaceId?: string; name?: string; applied?: number; actualBefore?: number } | null;
  /** The client that ended it, from `X-Orbit-Client`. Not served yet: without it the summary names no device. */
  resolvedClient?: string | null;
  /** The agent-written fields in the owner's language (Settings › Translation); null or absent until translated. */
  translation?: OwnerCardTranslation | null;
  createdAt: string;
}

export const WAITING_ON_YOU = 'Waiting on you';

export const KIND_TAGS: Readonly<Record<OwnerRequestKind, string>> = {
  DECISION: 'DECISION',
  SECRET: 'SECRET',
  MANUAL_STEP: 'STEPS',
  CONFIRM: 'CONFIRM',
  WIKI_CREATE: 'WIKI',
  SETTINGS_CHANGE: 'SETTINGS',
  PROJECT_REOPEN: 'REOPEN',
  BROWSER_SIGN_IN: 'SIGN IN',
  CHANGE: 'SETTING',
  SCHEDULE_FAILED: SCHEDULE_COPY.waiting.kinds.schedule,
  SCHEDULE_HELD: SCHEDULE_COPY.waiting.kinds.schedule,
  SCHEDULE_APPROVAL: SCHEDULE_COPY.waiting.kinds.run,
  SCHEDULE_WIDEN: SCHEDULE_COPY.waiting.kinds.schedule,
  CONDITION_UNKNOWN: CONDITION_COPY.waitingKind,
  CONDITION_STILL_WAITING: CONDITION_COPY.waitingKind,
};

/** The BROWSER_SIGN_IN card's words (Orbit Cloud browser board). Signed in is answered from the browser tab, not the card. */
export const BROWSER_SIGN_IN_COPY = {
  eyebrow: 'Sign in needed · Orbit Cloud browser',
  fromSession: (title: string) => `From session ${title}`,
  note: 'You sign in yourself; Orbit never sees your password. The login stays on this runner, and every agent on it can use it.',
  openBrowser: 'Open browser',
  notNow: 'Not now',
  signedIn: (site: string) => `Signed in to ${site}`,
  action: 'Sign in',
} as const;

/** The CHANGE card's words; OrbitKit's and Android's cards say the same ones. */
export const CHANGE_COPY = {
  tag: 'SETTING',
  primary: 'Apply',
  setting: (runner: string) => `${runner} · Max Concurrent`,
  runningNow: (n: number) => `${n} running now`,
  wasWhenAsked: (before: number) => `Was ${before} when asked.`,
  lowering: (n: number) => `Nothing running stops. New sessions wait until fewer than ${n} run.`,
  raising: (n: number) => `Up to ${n} sessions can run at once on this machine.`,
  numberLabel: 'Max Concurrent',
  applied: (runner: string, from: number, to: number, requested: number) =>
    `Applied: ${runner} Max Concurrent ${from} → ${to}${to !== requested ? ` (asked for ${requested})` : ''}`,
} as const;

/** The number typed on a CHANGE card: an integer of at least 1, or null. */
export function changeNumber(text: string): number | null {
  const n = /^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN;
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

const DEVICES: Readonly<Record<string, string>> = {
  web: 'Web',
  ios: 'iPhone',
  macos: 'Mac',
  android: 'Android',
};

/** The device a request was ended from, or null when the server did not say. */
export function deviceLabel(client: string | null | undefined): string | null {
  return client ? (DEVICES[client] ?? null) : null;
}

/** A pending request whose deadline has passed. The door refuses it; the sweep writes EXPIRED within a minute. */
export function pastDeadline(request: Pick<OwnerRequest, 'expiresAt'>, now: number): boolean {
  return request.expiresAt !== null && Date.parse(request.expiresAt) <= now;
}

/** The header's right half after "Asked …": how long is left, or nothing when there is no deadline. */
export function expiryText(request: Pick<OwnerRequest, 'expiresAt'>, now: number): string | null {
  if (request.expiresAt === null) return null;
  const left = Date.parse(request.expiresAt) - now;
  return left <= 0 ? 'expired' : `expires in ${formatSpan(left)}`;
}

/** A link the card may open: only a web page, because the address is an agent's words. */
export function openableLink(link: string): string | null {
  try {
    const { protocol } = new URL(link);
    return protocol === 'http:' || protocol === 'https:' ? link : null;
  } catch {
    return null;
  }
}

/**
 * The questions this session still has waiting on the owner that a Complete would end (`POST /sessions/:id/complete`
 * with `withdrawPendingQuestions`): every PENDING one it asked and not past its deadline, but a schedule's or a
 * condition's card, which the server leaves to its own flow. Without them, a Complete keeps the session in Completed.
 */
export function questionsCompleteEnds(
  requests: readonly OwnerRequest[],
  sessionId: string,
  now: number,
): OwnerRequest[] {
  return requests.filter((request) => sameResourceId(request.askedBySessionId, sessionId)
    && request.state === 'PENDING'
    && !pastDeadline(request, now)
    && !(SCHEDULE_WAITING_KINDS as readonly string[]).includes(request.kind)
    && request.kind !== CONDITION_WAITING_KIND
    && request.kind !== CONDITION_STILL_WAITING_KIND);
}

/** The confirmation Complete asks for when the session still has questions waiting on the owner. */
export const COMPLETE_WITH_QUESTIONS_COPY = {
  title: (count: number) => (count === 1
    ? 'This session has a question waiting on you'
    : `This session has ${count} questions waiting on you`),
  description: (count: number) => (count === 1
    ? 'Completing it withdraws the question unanswered, and the session goes ahead as if nobody answered.'
    : 'Completing it withdraws them unanswered, and the session goes ahead as if nobody answered.'),
  confirm: 'Complete and withdraw',
  cancel: 'Keep it open',
} as const;

/** Whether one of these pending requests holds this task up. */
export function isTaskHeld(requests: readonly Pick<OwnerRequest, 'blocksTaskIds'>[], taskId: string): boolean {
  return requests.some((request) => request.blocksTaskIds.some((id) => sameResourceId(id, taskId)));
}

/* ── Chat about this ───────────────────────────────────────────────────────────────────────────────
   A request talked about rather than answered: the next send is an ordinary turn to the session that
   asked, with the request named in front of the typed words. Nothing is resolved — the card stays, and
   its own buttons stay the ways out. OrbitKit's `OwnerRequests` and Android's say the same words. */

/** What the armed composer's bar says, ahead of the request's title. */
export const OWNER_REQUEST_CHAT_PREFIX = 'About your request: ';
/** What the empty composer asks for while armed. */
export const OWNER_REQUEST_CHAT_PLACEHOLDER = 'Ask about this request…';

/** What rides in front of the owner's words: which request, and that it is still open. */
export function ownerRequestChatContext(request: Pick<OwnerRequest, 'id' | 'title'>): string {
  return `The owner pressed Chat about this on your request “${request.title}” (owner request ${request.id}). `
    + 'It is still open: not marked done and not declined. Their message:';
}

/* ── How a resolution turn reads ──────────────────────────────────────────────────────────────── */

const RESOLUTION_HEAD = /^Orbit owner request \S+ \([A-Z_]+\) ended (DONE|DECLINED|EXPIRED|WITHDRAWN)[:.] /;
const RESOLUTION_MARK = 'This turn was queued by Orbit when the request ended, not typed by a person.';

const RESOLUTION_LABELS: Readonly<Record<string, string>> = {
  DONE: 'Owner action resolved',
  DECLINED: 'Owner declined the request',
  EXPIRED: 'Owner request expired',
  WITHDRAWN: 'Owner request withdrawn',
};

/** The divider drawn for the turn Orbit starts when a request ends, or null for any other turn. */
export function resolutionTurnLabel(text: string): string | null {
  if (!text.includes(RESOLUTION_MARK)) return null;
  const head = RESOLUTION_HEAD.exec(text);
  return head ? `${RESOLUTION_LABELS[head[1]]} · turn started automatically` : null;
}

/* ── Remind me later ──────────────────────────────────────────────────────────────────────────────
   The server has no snooze, so a reminder belongs to this browser: it folds the card here, and
   changes nothing about the request itself. */

const SNOOZE_KEY = 'orbit:owner-request-snoozes';
const HOUR = 3_600_000;

export const SNOOZE_CHOICES: readonly { key: string; label: string; ms: number }[] = [
  { key: '1h', label: 'In 1 hour', ms: HOUR },
  { key: '4h', label: 'In 4 hours', ms: 4 * HOUR },
  { key: '1d', label: 'Tomorrow', ms: 24 * HOUR },
];

/** The choices that come back before the deadline: a reminder after it would remind nobody. */
export function snoozeChoices(request: Pick<OwnerRequest, 'expiresAt'>, now: number) {
  const deadline = request.expiresAt === null ? Infinity : Date.parse(request.expiresAt);
  return SNOOZE_CHOICES.filter((choice) => now + choice.ms < deadline);
}

const EMPTY: Record<string, number> = {};
let snoozes: Record<string, number> | null = null;
const listeners = new Set<() => void>();

function readSnoozes(): Record<string, number> {
  if (snoozes) return snoozes;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? '{}');
    snoozes = parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : EMPTY;
  } catch {
    snoozes = EMPTY;
  }
  return snoozes;
}

function writeSnoozes(next: Record<string, number>): void {
  snoozes = next;
  try {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify(next));
  } catch {
    // A browser refusing storage still folds the card for as long as this page lives.
  }
  listeners.forEach((listener) => listener());
}

export function snoozeRequest(id: string, until: number): void {
  writeSnoozes({ ...readSnoozes(), [id]: until });
}

export function wakeRequest(id: string): void {
  const { [id]: _gone, ...rest } = readSnoozes();
  writeSnoozes(rest);
}

/** Tests start from an empty browser. */
export function resetSnoozesForTest(): void {
  snoozes = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every reminder this browser holds, and a redraw when the soonest one falls due. */
export function useSnoozes(): Readonly<Record<string, number>> {
  const current = useSyncExternalStore(subscribe, readSnoozes, readSnoozes);
  useEffect(() => {
    const now = Date.now();
    const due = Object.entries(current).filter(([, until]) => until > now).map(([, until]) => until);
    if (due.length === 0) return;
    const timer = setTimeout(() => writeSnoozes({ ...readSnoozes() }), Math.min(...due) - now);
    return () => clearTimeout(timer);
  }, [current]);
  return current;
}
