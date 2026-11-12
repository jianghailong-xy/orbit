import { useEffect, useSyncExternalStore } from 'react';
import { formatSpan, sameResourceId } from './watches';

/**
 * Owner requests: what a session has asked the account owner to do (apiserver `owner-requests`).
 * The rules with no component in them: what a request says about itself, and the one thing the
 * server does not hold — a reminder for later.
 */

export type OwnerRequestKind = 'DECISION' | 'SECRET' | 'MANUAL_STEP' | 'CONFIRM';
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
  verifyHint: string | null;
  expiresAt: string | null;
  askedBySessionId: string;
  projectId: string | null;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  resolvedBySessionId: string | null;
  resolutionNote: string | null;
  answer: { option?: number; text?: string } | null;
  /** The client that ended it, from `X-Orbit-Client`. Not served yet: without it the summary names no device. */
  resolvedClient?: string | null;
  createdAt: string;
}

export const WAITING_ON_YOU = 'Waiting on you';

export const KIND_TAGS: Readonly<Record<OwnerRequestKind, string>> = {
  DECISION: 'DECISION',
  SECRET: 'SECRET',
  MANUAL_STEP: 'STEPS',
  CONFIRM: 'CONFIRM',
};

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

/** Whether one of these pending requests holds this task up. */
export function isTaskHeld(requests: readonly Pick<OwnerRequest, 'blocksTaskIds'>[], taskId: string): boolean {
  return requests.some((request) => request.blocksTaskIds.some((id) => sameResourceId(id, taskId)));
}

/* ── How a resolution turn reads ──────────────────────────────────────────────────────────────── */

const RESOLUTION_HEAD = /^Orbit owner request \S+ \([A-Z_]+\) ended (DONE|DECLINED|EXPIRED|WITHDRAWN): /;
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
