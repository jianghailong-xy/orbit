import type {
  IntegrationTimelineEntry,
  OpenItemWorkSessionReturnReason,
  ProjectOpenItemRow,
  SessionLandingView,
} from '@orbit/shared';
import { toUuid } from '@orbit/shared';
import { elapsedLabel } from './projectAttention';

/**
 * A failed landing handed first to the task's own session, which wrote the work (contract revision 42,
 * §12.5 W5–W8, §12.7; owner ruling 2026-11-22 on docs/mocks/landing-fix-own-session, web a–e). Every
 * word the web adds for it is here once: the card in that session, the landing window's Fixing state
 * and hand-back, the three timeline rows, the Open items group and the task row.
 */
export const LANDING_FIX_COPY = {
  /** The card's eyebrow and its pill (web a ①). */
  FROM_ORBIT_LANDING: 'FROM ORBIT · LANDING',
  CONFLICT: 'Conflict',
  CHECKS_FAILED: 'Checks failed',
  COULD_NOT_LAND_ON: 'Orbit could not land your work on',
  NOTHING_WAS_PUSHED: 'Nothing was pushed.',
  THE_PROJECT_BRANCH: 'the project branch',
  /** The card's foot: the turn's last paragraph, said for the reader. */
  FOOT: (branch: string): string =>
    `Orbit lands the new commit and runs the checks again. Do not push ${branch}. `
    + 'Not yours to fix? End your turn without committing and say why.',
  /** The one line once its fix is landing again (web a ③). */
  LANDING: 'Landing',
  AGAIN: 'again',

  /** The landing's state word while the task's session holds it (web b ①): purple, neither amber nor red. */
  FIXING: 'Fixing',
  ITS_OWN_SESSION_IS_ON_IT: 'its own session is on it',
  THE_TASKS_SESSION: 'The task’s session',
  IS_FIXING_IT: 'is fixing it',
  IS_ON_IT: 'is on it',
  ROUND: (round: number): string => `round ${round} of ${LANDING_FIX_ROUND_LIMIT}`,
  OPEN_SESSION: 'Open Session',
  /** The Open items row's door, lower case as the board draws it (web d ①). */
  OPEN_SESSION_LINK: 'Open session',
  /** The session row of the task's own session while it fixes its landing (web a ③). */
  SESSION_ROW_LINE: 'Landing · the task’s session is fixing it',
  /** The task row's integration segment (web e ②). */
  TASK_ROW: 'Landing · fixing',
  /** The Open items group (web d ①). */
  GROUP: 'Being fixed by its session',

  /** The timeline rows' second lines (web b ②, c ②). */
  IT_WROTE_THIS_WORK: 'It wrote this work',
  LAST_WORDS_BELOW: 'Its last words are on the card below.',

  /** The hand-back card (web c ①). */
  COORDINATOR: 'Coordinator',
  HAS_IT: 'has it',
  JUST_NOW: 'just now',
  SAID_NOTHING: 'It said nothing about it.',
  /** The window's footer while a landing is in its own session's hands (web b ③). */
  DECISIONS_SESSION_FIRST: 'Decisions: the task’s own session first, then the coordinator',
} as const;

/** How many rounds of fixes the task's own session gets for one landing (§12.5 W8, appendix A-Q32). */
export const LANDING_FIX_ROUND_LIMIT = 2;

/** What the hand-back card says the session did, by why it was handed back (§12.4 `work_session_return_reason`). */
export const LANDING_FIX_RETURNED_BECAUSE: Readonly<Record<OpenItemWorkSessionReturnReason, string>> = {
  NO_NEW_COMMIT: 'The task’s session ended its turn without a new commit:',
  TURN_FAILED: 'The task’s session’s fix turn failed. What it said last:',
  SESSION_ENDED: 'The task’s session was ended before it landed a fix. What it said last:',
  ROUNDS_EXHAUSTED: `The task’s session has used its ${LANDING_FIX_ROUND_LIMIT} rounds of fixes. What it said last:`,
  TASK_MOVED_ON: 'The task moved on. What its session said last:',
};

/** The three timeline rows revision 42 added (§12.7), which the window draws on their own lines. */
export const LANDING_FIX_ENTRY_KINDS: ReadonlySet<string> = new Set([
  'HANDED_TO_SESSION', 'FIXED_BY_SESSION', 'RETURNED_TO_COORDINATOR',
]);

/** A branch said as the card says it: the project's own branch by role, any other by name. */
export function landingFixBranchWords(branch: string): string {
  return branch.startsWith('project/') ? LANDING_FIX_COPY.THE_PROJECT_BRANCH : branch;
}

/** `4m`, or `just now` under a minute — how long something has been in someone's hands. */
export function landingFixSince(at: string | null | undefined, now: number): string {
  const label = elapsedLabel(at, now);
  return label === null || label === '<1m' ? LANDING_FIX_COPY.JUST_NOW : label;
}

// ── the turn in the task's own session (web a ①) ──────────────────────────────────────────────

/**
 * The landing-fix turn (`landing-fix:v1:<jobId>`, apiserver projects/landing-fix-turn.ts
 * `landingFixMessage`), read back from its words: they are written only from rows that no longer
 * change, so the same failure always reads the same. Null for any other text.
 */
export interface LandingFixTurn {
  taskTitle: string;
  /** The branch it could not land on, short: `project/<id>`. */
  target: string;
  state: 'CONFLICT' | 'CHECK_FAILED';
  /** The failure's sentence, without its closing colon: `Conflict while rebasing onto project/x at 41ac9e0`. */
  failure: string;
  /** For a conflict, how it got there (`rebasing onto`, `merging into`, `syncing main into`), and the tip it was on. */
  verb: string | null;
  targetSha: string | null;
  /** The conflicting files, or the failure lines of the check that failed. */
  lines: string[];
  /** The numbered steps it is asked to take, as the turn words them. */
  steps: string[];
  /** The landing session the turn names as its full record, or null when it named none. */
  landingSessionId: string | null;
}

const HEAD = /^Orbit could not land your work for "([\s\S]*)" on (\S+)\.$/;
const CONFLICT_LINE = /^Conflict while (rebasing onto|merging into|syncing \S+ into) (\S+?)(?: at (\S+))?:$/;
const CHECK_LINE = /^The check "[^"]*"[\s\S]* failed on the combined tree[\s\S]*:$/;
const RECORD_LINE = /^The full record: landing (\S+)\.$/;
const NO_FILES = '(the runner named no files)';

/** Whether an id the turn names is one a link can be built from (`not recorded` is not). */
function validId(id: string): boolean {
  try {
    toUuid(id);
    return true;
  } catch {
    return false;
  }
}

export function parseLandingFixTurn(text: string | null | undefined): LandingFixTurn | null {
  if (!text || !text.startsWith('Orbit could not land your work for "')) return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const head = HEAD.exec(lines[0] ?? '');
  if (!head) return null;
  const failureAt = lines.findIndex((line, index) => index > 0 && line.trim() !== '');
  const failureLine = lines[failureAt] ?? '';
  const conflict = CONFLICT_LINE.exec(failureLine);
  const check = !conflict && CHECK_LINE.test(failureLine);
  if (!conflict && !check) return null;
  const pushedAt = lines.findIndex((line) => line.startsWith('Nothing was pushed.'));
  if (pushedAt < 0) return null;
  const body = lines.slice(failureAt + 1, pushedAt).filter((line) => line.trim() !== '');
  const listed = conflict
    ? body.flatMap((line) => line === NO_FILES ? [] : line.split(', ').map((file) => file.trim()).filter(Boolean))
    : body;
  const steps = lines.map((line) => /^[1-3]\. (.+)$/.exec(line)?.[1] ?? null).filter((step): step is string => step !== null);
  const record = lines.map((line) => RECORD_LINE.exec(line)?.[1] ?? null).find((id) => id != null) ?? null;
  return {
    taskTitle: head[1],
    target: head[2],
    state: conflict ? 'CONFLICT' : 'CHECK_FAILED',
    failure: failureLine.replace(/:$/, ''),
    verb: conflict ? conflict[1] : null,
    targetSha: conflict ? conflict[3] ?? null : null,
    lines: listed,
    steps,
    landingSessionId: record && validId(record) ? record : null,
  };
}

/** The card's sentence over the files: the failure, the target said as `the project branch`. */
export function landingFixFailureWords(turn: LandingFixTurn): { before: string; sha: string | null; after: string } {
  if (turn.state === 'CONFLICT' && turn.verb) {
    return { before: `Conflict while ${turn.verb} ${landingFixBranchWords(turn.target)}${turn.targetSha ? ' at ' : ''}`, sha: turn.targetSha, after: '.' };
  }
  return { before: turn.failure, sha: null, after: '.' };
}

/** The steps as the card says them: the target by its role, as the sentence over them does. */
export function landingFixSteps(turn: LandingFixTurn): string[] {
  const words = landingFixBranchWords(turn.target);
  return turn.steps.map((step) => step.split(turn.target).join(words));
}

// ── the landing window (web b, c) ─────────────────────────────────────────────────────────────

/** One of the three rows, with what the window says under it. */
export interface LandingFixEvent {
  entry: IntegrationTimelineEntry;
  /** Which round of fixes a hand-off is (1-based), counted over the landing's hand-offs in order. */
  round: number | null;
}

/** Where the landing stands with its own session, read off its timeline: the newest of the three rows. */
export interface LandingFixStanding {
  state: 'FIXING' | 'RETURNED';
  /** The task's own session that holds it, or held it. */
  sessionId: string | null;
  /** When it was handed to that session, or handed back. */
  at: string;
  /** The round it is in (FIXING) or was in when it came back (RETURNED). */
  round: number;
  returnReason: OpenItemWorkSessionReturnReason | null;
  /** The session's last words frozen at the hand-back (`data.lastMessage`); null when it said none or it is FIXING. */
  lastMessage: string | null;
}

function sessionOf(entry: IntegrationTimelineEntry): string | null {
  const id = entry.data?.sessionId ?? entry.actor?.sessionId ?? null;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** Each of the three rows in the landing's order, a hand-off numbered with its round. */
export function landingFixEvents(landing: Pick<SessionLandingView, 'timeline'> | null | undefined): LandingFixEvent[] {
  const out: LandingFixEvent[] = [];
  let handed = 0;
  for (const section of landing?.timeline?.sections ?? []) {
    for (const entry of section.entries) {
      if (!LANDING_FIX_ENTRY_KINDS.has(entry.kind)) continue;
      if (entry.kind === 'HANDED_TO_SESSION') handed += 1;
      out.push({ entry, round: entry.kind === 'HANDED_TO_SESSION' ? handed : null });
    }
  }
  return out;
}

/**
 * Whether an unsettled landing is in its own session's hands (FIXING) or was handed back to the coordinator
 * (RETURNED); null when neither is its newest fact — it was never handed, or a fix is landing again.
 */
export function landingFixStanding(
  landing: Pick<SessionLandingView, 'timeline' | 'settledAt'> | null | undefined,
): LandingFixStanding | null {
  if (!landing || landing.settledAt) return null;
  const events = landingFixEvents(landing);
  const last = events.at(-1);
  if (!last || last.entry.kind === 'FIXED_BY_SESSION') return null;
  const round = events.filter((event) => event.round !== null).at(-1)?.round ?? 1;
  const reason = last.entry.data?.returnReason ?? last.entry.reason ?? null;
  return {
    state: last.entry.kind === 'HANDED_TO_SESSION' ? 'FIXING' : 'RETURNED',
    sessionId: sessionOf(last.entry),
    at: last.entry.at,
    round,
    returnReason: typeof reason === 'string' && reason in LANDING_FIX_RETURNED_BECAUSE
      ? reason as OpenItemWorkSessionReturnReason : null,
    lastMessage: last.entry.kind === 'RETURNED_TO_COORDINATOR' ? landingFixLastWords(last.entry.data?.lastMessage as string | null | undefined) : null,
  };
}

/** The line under a hand-off: who it went to, and which round; under a hand-back, where its words are. */
export function landingFixEventSub(event: LandingFixEvent, events: readonly LandingFixEvent[], settled: boolean): string | null {
  const index = events.indexOf(event);
  if (event.entry.kind === 'HANDED_TO_SESSION') {
    const returned = events[index + 1]?.entry.kind === 'RETURNED_TO_COORDINATOR';
    const round = LANDING_FIX_COPY.ROUND(event.round ?? 1);
    return returned ? round : `${LANDING_FIX_COPY.IT_WROTE_THIS_WORK} · ${round}`;
  }
  if (event.entry.kind === 'RETURNED_TO_COORDINATOR' && index === events.length - 1 && !settled) {
    return LANDING_FIX_COPY.LAST_WORDS_BELOW;
  }
  return null;
}

/** The sha a fix landed again with, short, from the newest `Fixed in` row this session wrote; null when none. */
export function landingFixAgainSha(
  landing: Pick<SessionLandingView, 'timeline'> | null | undefined,
  sessionId: string | null,
  same: (a: string, b: string) => boolean = (a, b) => a === b,
): string | null {
  const fixed = landingFixEvents(landing)
    .filter((event) => event.entry.kind === 'FIXED_BY_SESSION')
    .filter((event) => {
      const by = sessionOf(event.entry);
      return sessionId == null || by == null || same(by, sessionId);
    })
    .at(-1);
  const sha = fixed?.entry.data?.sourceSha;
  return typeof sha === 'string' && sha !== '' ? sha.slice(0, 7) : null;
}

/** What a run said last, as the server quotes it in a hand-back (`runLastWords`): trimmed, cut at 1,200 characters. */
export function landingFixLastWords(text: string | null | undefined): string | null {
  const words = text?.trim() ?? '';
  if (!words) return null;
  return words.length > 1_200 ? `${words.slice(0, 1_200)}…` : words;
}

// ── open items and the project's sessions page (web d, and the left column) ───────────────────

/** An item in its task's own session's hands, and nobody else's yet (§12.7): listed under the group. */
export function heldByItsSession(row: Pick<ProjectOpenItemRow, 'workSession'>): boolean {
  return row.workSession != null && row.workSession.returnedAt == null;
}

/** An item its task's own session handed back to the coordinator (W7): the left column's Not landed card. */
export function handedBackBySession(row: Pick<ProjectOpenItemRow, 'workSession'>): boolean {
  return row.workSession != null && row.workSession.returnedAt != null;
}

/** The round a held item is in: the rounds its session has asked for, plus the one it is on. */
export function openItemFixRound(row: Pick<ProjectOpenItemRow, 'workSession'>): number {
  return Math.min(LANDING_FIX_ROUND_LIMIT, (row.workSession?.rounds ?? 0) + 1);
}

/** `conflict`, `checks failed`: the failure's word in a landing head. */
export function landingFixFailureWord(kind: string): string {
  return kind === 'INTEGRATION_CHECK_FAILED' ? 'checks failed' : 'conflict';
}

/** The row's title (web d ①): `Landing conflict · <task>`. */
export function openItemFixTitle(row: Pick<ProjectOpenItemRow, 'kind' | 'facts' | 'title'>): string {
  const what = row.kind === 'INTEGRATION_CHECK_FAILED' ? 'Landing checks failed' : 'Landing conflict';
  return `${what} · ${row.facts?.task?.title ?? row.title}`;
}

/** The row's line: `The task’s session is on it · 4m · round 1 of 2 · nothing was pushed`. */
export function openItemFixLine(row: Pick<ProjectOpenItemRow, 'workSession' | 'facts'>, now: number): string {
  return [
    `${LANDING_FIX_COPY.THE_TASKS_SESSION} ${LANDING_FIX_COPY.IS_ON_IT}`,
    landingFixSince(row.workSession?.offeredAt, now),
    LANDING_FIX_COPY.ROUND(openItemFixRound(row)),
    row.facts?.nothingLanded === false ? null : 'nothing was pushed',
  ].filter(Boolean).join(' · ');
}

/** The left column's card over a landing its own session is fixing, or one it handed back (web a ③, c). */
export interface LandingFixColumnCard {
  state: 'FIXING' | 'RETURNED';
  itemId: string;
  /** `conflict · its own session is on it`, `conflict · nothing was pushed`. */
  detail: string;
  task: string;
  /** The branch it lands on, short; null when the item does not say. */
  target: string | null;
  /** `The task’s session is fixing it · 4m · round 1 of 2`, `Coordinator has it · just now`. */
  line: string;
  sessionId: string;
  landingSessionId: string | null;
}

/**
 * The cards the left column draws, from the project's open items: one per landing its own session holds (and is
 * not already landing again), then one per landing it handed back to the coordinator that is still open.
 */
export function landingFixColumnCards(
  view: { withWorkSession?: readonly ProjectOpenItemRow[]; withCoordinator?: readonly ProjectOpenItemRow[] } | null | undefined,
  now: number,
): LandingFixColumnCard[] {
  const shortRef = (ref: string | null | undefined): string | null => ref ? ref.replace(/^refs\/heads\//, '') : null;
  const fixing = (view?.withWorkSession ?? [])
    .filter((row) => heldByItsSession(row) && row.handling == null)
    .map((row): LandingFixColumnCard => ({
      state: 'FIXING',
      itemId: row.itemId,
      detail: `${landingFixFailureWord(row.kind)} · ${LANDING_FIX_COPY.ITS_OWN_SESSION_IS_ON_IT}`,
      task: row.facts?.task?.title ?? row.title,
      target: shortRef(row.facts?.targetRef),
      line: [
        `${LANDING_FIX_COPY.THE_TASKS_SESSION} ${LANDING_FIX_COPY.IS_FIXING_IT}`,
        landingFixSince(row.workSession!.offeredAt, now),
        LANDING_FIX_COPY.ROUND(openItemFixRound(row)),
      ].join(' · '),
      sessionId: row.workSession!.sessionId,
      landingSessionId: row.landingSessionId ?? null,
    }));
  const returned = (view?.withCoordinator ?? [])
    .filter((row) => handedBackBySession(row) && row.handling == null
      && (row.kind === 'INTEGRATION_CONFLICT' || row.kind === 'INTEGRATION_CHECK_FAILED'))
    .map((row): LandingFixColumnCard => ({
      state: 'RETURNED',
      itemId: row.itemId,
      detail: `${landingFixFailureWord(row.kind)} · nothing was pushed`,
      task: row.facts?.task?.title ?? row.title,
      target: shortRef(row.facts?.targetRef),
      line: `${LANDING_FIX_COPY.COORDINATOR} ${LANDING_FIX_COPY.HAS_IT} · ${landingFixSince(row.workSession!.returnedAt, now)}`,
      sessionId: row.workSession!.sessionId,
      landingSessionId: row.landingSessionId ?? null,
    }));
  return [...fixing, ...returned];
}
