/**
 * The Wiki while it has nothing to read (design §12.3.1, mock 41): one card of three steps — connect the
 * repository, confirm the plan, write the documents — that says what happens next, and at most one thing
 * to press.
 *
 * ONE CARD FOR EVERY EMPTY STATE. With no wiki at all it is the first step, whose button makes the wiki;
 * with a wiki it reads the same plan state Activity's Plan card reads (`wikiPlanLook`) and says where that
 * state stands on the way to something to read. It keeps nothing of its own: whether it is drawn, and what
 * it says, is worked out from the reads every time (`wikiStartShown`, `wikiStartCard`).
 *
 * THE STEPS' COLOURS ARE THE WIKI'S: amber waits on the owner, blue is the server at work, a tick is done,
 * grey has not come yet.
 *
 * RULES OVER THE READS, not over a page, because OrbitKit and Android draw the same card: the three
 * clients are held to the cases of `src/shared/src/wiki-start.fixture.json`.
 */
import { WIKI_DEFAULT_MAINTENANCE_SETTINGS, type WikiDocsDirectory, type WikiPlanState } from '@orbit/shared';
import { wikiCount } from './wikiArticles';
import { wikiAgo } from './wikiHealth';
import {
  WIKI_PLAN_DRAFT,
  WIKI_PLAN_DRAFTER_SERVER,
  WIKI_PLAN_NOTE_SERVER,
  WIKI_PLAN_OPEN,
  WIKI_PLAN_QUEUED_TEXT,
  WIKI_PLAN_VIEW_RUNNERS,
  WIKI_PLAN_WRITING_SOON,
  wikiPlanBuildJob,
  wikiPlanCard,
  wikiPlanFailedBuild,
  wikiPlanHeld,
  wikiPlanHeldText,
  wikiPlanJobCard,
  wikiPlanLook,
  wikiPlanOpenJob,
} from './wikiPlan';
import { WIKI_SET_UP, wikiMonthDay, wikiRunsADay } from './wikiReviewMode';

// ── The words ───────────────────────────────────────────────────────────────────────────────────

export const WIKI_START_TITLE = 'Set up this wiki';
export const WIKI_START_FIRST_TITLE = 'Set up your first wiki';
export const WIKI_START_LEAD = 'Documents for this codebase, written from its repository and sessions, for you and your agents.';
export const WIKI_START_FIRST_LEAD =
  'A wiki is documents for one codebase, written from its repository and sessions, for you and your agents.';
export const WIKI_START_CONNECT = 'Connect the repository';
export const WIKI_START_CONNECT_FIRST = 'Connect a repository';
export const WIKI_START_CONFIRM = 'Confirm the plan';
export const WIKI_START_WRITE = 'Write the documents';
export const WIKI_START_CONNECT_TEXT = 'Pick the workspace Orbit reads this repository from.';
export const WIKI_START_CONNECT_FIRST_TEXT = 'Pick a workspace. Its repository is what this wiki will describe.';
export const WIKI_START_NO_REPOSITORY = 'None of your workspaces has a repository yet. Add one, then come back.';
export const WIKI_START_CONFIRM_TODO = `The ${WIKI_PLAN_DRAFTER_SERVER} drafts the documents this wiki should have. Nothing is written until you confirm it.`;
export const WIKI_START_WRITE_TODO = 'They appear here one by one.';
export const WIKI_START_CONNECTED = 'Connected';
export const WIKI_START_DRAFTING_NOTE = 'Usually 1–2 hours. You can leave this page.';
export const WIKI_START_NO_PLAN = 'No plan yet. A plan lays out this wiki’s documents; nothing is written until you confirm it.';
export const WIKI_START_NOT_WRITTEN = 'No document is written yet.';
export const WIKI_CREATE = 'Create wiki';
export const WIKI_CREATE_OPEN = 'Create wiki…';
export const WIKI_CREATE_NOTE =
  `A wiki describes one repository and stays up to date from its sessions, tasks and receipts. Runs on the server with this deployment’s ${WIKI_PLAN_DRAFTER_SERVER}.`;
export const WIKI_WORKSPACE_OFFLINE = 'offline';
/** The way to another wiki (docs/wiki-explicit-creation-design.md §3.4): the Wiki group's last row and the head picker's last item. */
export const WIKI_NEW = 'New wiki…';
/** On a repository in the Create wiki form that already has a wiki in use: one repository, one wiki. */
export const WIKI_HAS_A_WIKI = 'Has a wiki';

/** A done first step: where maintenance reads the repository from. */
export const wikiStartReadsFrom = (workspace: string | null): string => (workspace ? `Reads from ${workspace}` : WIKI_START_CONNECTED);
/** A done second step: `v1 confirmed Nov 2 · 34 documents`. */
export const wikiStartConfirmed = (version: number, day: string | null, documents: number): string =>
  `v${version} confirmed${day ? ` ${day}` : ''} · ${wikiCount(documents)} ${documents === 1 ? 'document' : 'documents'}`;
/** Under the workspace in the form that makes a wiki: what the wiki will be about, and how it gets there. */
export const wikiCreateRepositoryNote = (repository: string): string =>
  `This wiki will describe ${repository}. The server reads the repository through this workspace’s runner.`;

// ── Whether it is drawn ─────────────────────────────────────────────────────────────────────────

/**
 * Whether the home has nothing to read: no document of the confirmed plan written, and no topic article
 * listed in its place. The first document, or the first article, takes the card away.
 */
export const wikiStartShown = (written: number, topics: number): boolean => written === 0 && topics === 0;

// ── What it says ────────────────────────────────────────────────────────────────────────────────

export type WikiStartStepState = 'done' | 'wait' | 'run' | 'todo';
/** What a step's button does: the two forms on the spot, a draft on the spot, or the page that takes it on. */
export type WikiStartActionTo = 'create' | 'setUp' | 'draft' | 'plan' | 'runners';

export interface WikiStartStep {
  state: WikiStartStepState;
  title: string;
  text: string;
  note: string | null;
  /** Writing: how far, and the document being written now. */
  progress: { done: number; total: number; now: string | null } | null;
  action: { label: string; to: WikiStartActionTo; primary: boolean } | null;
}

export interface WikiStartCard {
  title: string;
  lead: string;
  steps: [WikiStartStep, WikiStartStep, WikiStartStep];
}

export interface WikiStartContext {
  now: number;
  /** Whether the space's maintenance is on. */
  maintenance: boolean;
  /** The workspace it reads the repository from, as `wikiWorkspaceLabel` names it; null while that is not known. */
  readsFrom: string | null;
  runnerOnline: boolean | null;
  /** The confirmed plan's documents, for the writing's count and the document being written. */
  directory?: WikiDocsDirectory | null;
}

const step = (over: Partial<WikiStartStep> & Pick<WikiStartStep, 'state' | 'title' | 'text'>): WikiStartStep => ({
  note: null,
  progress: null,
  action: null,
  ...over,
});

const openPlan = (primary: boolean): WikiStartStep['action'] => ({ label: WIKI_PLAN_OPEN, to: 'plan', primary });
const viewRunners: WikiStartStep['action'] = { label: WIKI_PLAN_VIEW_RUNNERS, to: 'runners', primary: true };
const CONFIRM_TODO = step({ state: 'todo', title: WIKI_START_CONFIRM, text: WIKI_START_CONFIRM_TODO });
const WRITE_TODO = step({ state: 'todo', title: WIKI_START_WRITE, text: WIKI_START_WRITE_TODO });

/** The second step before a version is confirmed: the draft, wherever it has got to. */
function confirmStep(state: WikiPlanState, context: WikiStartContext): WikiStartStep {
  const title = WIKI_START_CONFIRM;
  const open = wikiPlanOpenJob(state);
  const look = wikiPlanLook(state, { runnerOnline: context.runnerOnline });
  const wait = (text: string, action: WikiStartStep['action'], note: string | null = null) => step({ state: 'wait', title, text, note, action });
  if (look === 'held' && open) return wait(wikiPlanHeldText(open, 'runner_offline'), viewRunners);
  // What a draft that waits for the owner says is the Plan card's: how it went, and how many things to look at.
  if (look === 'draftFailed' || look === 'draftReady') {
    const card = wikiPlanCard(look, state, { now: context.now, docs: null, runnerOnline: context.runnerOnline });
    return wait(card.text!, openPlan(true), card.note);
  }
  if (look === 'queued') return step({ state: 'run', title, text: `Draft queued · ${WIKI_PLAN_QUEUED_TEXT}.`, action: openPlan(false) });
  if (look === 'drafting' && open) {
    const text = open.startedAt
      ? `Drafting the plan · attempt ${open.attempt ?? 1} of ${open.attemptsMax} · started ${wikiAgo(open.startedAt, context.now)}`
      : `Drafting the plan · ${WIKI_PLAN_WRITING_SOON}`;
    return step({ state: 'run', title, text, note: WIKI_START_DRAFTING_NOTE, action: openPlan(false) });
  }
  return wait(WIKI_START_NO_PLAN, { label: WIKI_PLAN_DRAFT, to: 'draft', primary: true }, WIKI_PLAN_NOTE_SERVER);
}

/** The third step, once a version is confirmed: its documents' writing, or that it stopped. */
function writeStep(state: WikiPlanState, context: WikiStartContext): WikiStartStep {
  const title = WIKI_START_WRITE;
  const build = wikiPlanBuildJob(state);
  if (build && wikiPlanHeld(build, context.runnerOnline)) {
    return step({ state: 'wait', title, text: wikiPlanHeldText(build, 'runner_offline'), action: viewRunners });
  }
  const card = wikiPlanJobCard(build ?? wikiPlanFailedBuild(state), {
    now: context.now,
    runnerOnline: context.runnerOnline,
    inForce: true,
    directory: context.directory ?? null,
  });
  if (card?.look === 'failed') return step({ state: 'wait', title, text: `${card.title} · ${card.text}`, action: openPlan(true) });
  if (card) return step({ state: 'run', title, text: `${card.title} · ${card.text}`, progress: card.progress, action: openPlan(false) });
  return step({ state: 'wait', title, text: WIKI_START_NOT_WRITTEN, action: openPlan(true) });
}

/**
 * The card of a wiki with nothing to read. The first step waits while there is no workspace to read the
 * repository through: a job held for one, or no plan, no job and maintenance not on. With a version confirmed
 * the second step is done whatever the first says, so a workspace lost later reads as what it is.
 */
export function wikiStartCard(state: WikiPlanState, context: WikiStartContext): WikiStartCard {
  const held = wikiPlanHeld(wikiPlanOpenJob(state) ?? wikiPlanBuildJob(state), context.runnerOnline);
  const noPlan = wikiPlanLook(state, { runnerOnline: context.runnerOnline }) === 'noPlan';
  const connect = (held !== null && held !== 'runner_offline') || (noPlan && !context.maintenance);
  const confirmed = state.confirmed;
  const first = connect
    ? step({ state: 'wait', title: WIKI_START_CONNECT, text: WIKI_START_CONNECT_TEXT, action: { label: WIKI_SET_UP, to: 'setUp', primary: true } })
    : step({ state: 'done', title: WIKI_START_CONNECT, text: wikiStartReadsFrom(context.readsFrom) });
  const second = confirmed
    ? step({ state: 'done', title: WIKI_START_CONFIRM, text: wikiStartConfirmed(confirmed.version, wikiMonthDay(confirmed.confirmedAt ?? ''), confirmed.docs.length) })
    : connect
      ? CONFIRM_TODO
      : confirmStep(state, context);
  const third = confirmed && !connect ? writeStep(state, context) : WRITE_TODO;
  return { title: WIKI_START_TITLE, lead: WIKI_START_LEAD, steps: [first, second, third] };
}

/**
 * The card of an account with no wiki: the same three steps, the first of which makes one — or, with no
 * workspace on a repository to make one from, says so and offers nothing to press.
 */
export function wikiStartFirstCard(workspaces: boolean): WikiStartCard {
  return {
    title: WIKI_START_FIRST_TITLE,
    lead: WIKI_START_FIRST_LEAD,
    steps: [
      workspaces
        ? step({ state: 'wait', title: WIKI_START_CONNECT_FIRST, text: WIKI_START_CONNECT_FIRST_TEXT, action: { label: WIKI_CREATE_OPEN, to: 'create', primary: true } })
        : step({ state: 'wait', title: WIKI_START_CONNECT_FIRST, text: WIKI_START_NO_REPOSITORY }),
      CONFIRM_TODO,
      WRITE_TODO,
    ],
  };
}

// ── The workspaces the two forms offer ──────────────────────────────────────────────────────────

/**
 * A repository as a wiki space names it (`normalizeRepoUrl` on the server, design §2.1): no scheme, user,
 * trailing `/` or `.git`, the scp form read as a path and the host in lower case, so every spelling of one
 * remote is one repository. Null when nothing is left. `wikiStart.test.ts` holds it to the server's answers.
 */
export function wikiRepositoryName(raw: string | null | undefined): string | null {
  let url = (raw ?? '').trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(\S+)$/u.exec(url);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(url)) url = `ssh://${scp[1]}/${scp[2]}`;
  const remote = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/]*)(.*)$/iu.exec(url);
  if (remote) url = `${remote[1]!.toLowerCase()}${remote[2]}`;
  for (;;) {
    const trimmed = url.replace(/\/+$/u, '').replace(/\.git$/u, '');
    if (trimmed === url) return url === '' ? null : url;
    url = trimmed;
  }
}

/** What a wiki is called when it is made: its repository's last segment. */
export const wikiRepositoryTitle = (repository: string): string => repository.split('/').filter(Boolean).at(-1) ?? repository;

/** One workspace as the forms offer it. */
export interface WikiWorkspaceChoice {
  id: string;
  label: string;
  /** Its repository (`wikiRepositoryName`), and the URL as the workspace records it. */
  repository: string | null;
  repoUrl: string | null;
  /** False when its runner is known to be offline. */
  online: boolean;
}

/** The choices in the order they are offered: every one a draft could start on first, then by name. */
export function wikiWorkspaceChoicesInOrder(choices: readonly WikiWorkspaceChoice[]): WikiWorkspaceChoice[] {
  const key = (choice: WikiWorkspaceChoice): string => choice.label.toLowerCase();
  return [...choices].sort((a, b) => Number(b.online) - Number(a.online) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** A repository the form that makes a wiki offers, with its workspaces; one that has a wiki already is greyed, not offered. */
export interface WikiRepositoryGroup {
  repository: string;
  choices: WikiWorkspaceChoice[];
  hasWiki: boolean;
}

/**
 * The repositories the form that makes a wiki groups its workspaces under, by name. A workspace with none is left out.
 * `wikis` are the repositories of the wikis in use (`repoUrlNorm`, not Trash's): their groups are `hasWiki`, since a
 * repository has one wiki (design §3.4) and the server refuses a second with 409 WIKI_SPACE_EXISTS.
 */
export function wikiRepositoryGroups(
  choices: readonly WikiWorkspaceChoice[],
  wikis: readonly (string | null | undefined)[] = [],
): WikiRepositoryGroup[] {
  const groups = new Map<string, WikiWorkspaceChoice[]>();
  for (const choice of wikiWorkspaceChoicesInOrder(choices)) {
    if (choice.repository) groups.set(choice.repository, [...(groups.get(choice.repository) ?? []), choice]);
  }
  const made = new Set(wikis.filter((repository): repository is string => Boolean(repository)));
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([repository, rows]) => ({ repository, choices: rows, hasWiki: made.has(repository) }));
}

/** The workspaces the form that makes a wiki lets one pick: those of the repositories with no wiki yet. */
export const wikiCreateOffered = (groups: readonly WikiRepositoryGroup[]): WikiWorkspaceChoice[] =>
  groups.filter((group) => !group.hasWiki).flatMap((group) => group.choices);

/**
 * The workspace a form opens on: the one maintenance already reads from; else the one the reader came
 * from, when its runner is not offline; else the first offered whose runner is not; else the first, since
 * a draft that waits for its runner says so on the card.
 */
export function wikiWorkspaceDefault(
  choices: readonly WikiWorkspaceChoice[],
  context: { current: string | null; from: string | null },
): string | null {
  if (context.current) return context.current;
  const offered = wikiWorkspaceChoicesInOrder(choices);
  const from = offered.find((choice) => choice.id === context.from && choice.online);
  return from?.id ?? offered.find((choice) => choice.online)?.id ?? offered[0]?.id ?? null;
}

// ── The card an agent files for a wiki (WIKI_CREATE, design §3.6) ───────────────────────────────

export const WIKI_CREATE_REPOSITORY = 'Repository';
export const WIKI_CREATE_READS_FROM = 'Reads from';
export const WIKI_CREATE_MAINTENANCE = 'Maintenance';
export const WIKI_CREATE_CHANGE_SETTINGS = 'Change settings…';
export const WIKI_CREATE_NOT_HERE = 'Not for this repository';
/** The maintenance a wiki made from the card starts with: the Create wiki form's defaults, on. */
export const WIKI_CREATE_MAINTENANCE_TEXT =
  `On · ${wikiRunsADay(WIKI_DEFAULT_MAINTENANCE_SETTINGS.dailyRunLimit)} · last ${WIKI_DEFAULT_MAINTENANCE_SETTINGS.lookbackDays} days`;

/** What a WIKI_CREATE card says it will make: the repository, the workspace it reads it from, and the maintenance. */
export interface WikiCreateCardFacts {
  repository: string | null;
  /** The filing session's workspace as the forms name it; null when it is not among the workspaces read. */
  readsFrom: string | null;
  offline: boolean;
  maintenance: string;
}

export function wikiCreateCardFacts(
  request: { repoUrlNorm?: string | null; workspaceId?: string | null },
  choices: readonly WikiWorkspaceChoice[],
): WikiCreateCardFacts {
  const workspace = request.workspaceId ? choices.find((choice) => choice.id === request.workspaceId) : undefined;
  return {
    repository: request.repoUrlNorm ?? null,
    readsFrom: workspace?.label ?? null,
    offline: workspace ? !workspace.online : false,
    maintenance: WIKI_CREATE_MAINTENANCE_TEXT,
  };
}
