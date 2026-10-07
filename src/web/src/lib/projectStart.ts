import type {
  ProjectOpenItemRow,
  ProjectOpenItemsView,
  ProjectStartSettingKey,
  ProjectStartSettings,
  StartProjectRequestBody,
  StartProjectResponse,
} from '@orbit/shared';
import { api } from '../api';

/**
 * Starting a project, as the browser draws and presses it: the words of the "Start this project?"
 * card (`StartProjectCard.tsx`), of the "Confirm the new criteria?" card (`CriteriaChangeCard.tsx`),
 * of the settings a start leaves behind (the receipt, `ProjectStartedCard.tsx`), and the one write,
 * `POST /projects/:id/start`.
 *
 * EVERY WORD IS HERE, AND NOWHERE ELSE. The three clients share no compiler, so the native cards
 * (OrbitKit) hold the same sentences by hand and their copy-parity tests read this file back: a
 * sentence re-worded at one end only turns nothing else red. So the copy of all four surfaces lives
 * in one module the tests can read, each sentence declared once — a constant, or a function for a
 * sentence with a number in it — and the components draw it without re-typing any of it.
 */

// ── The words: the start card ────────────────────────────────────────────────────────────────

/** The card's question, and the heading of the open item that asks it. */
export const START_PROJECT_TITLE = 'Start this project?';
/** What a session row, its header and the pinned strip say while the card is waiting. */
export const READY_TO_START = 'Ready to start';
/** The project page's status tag for a project nobody has started. */
export const NOT_STARTED = 'Not started';
export const START_DONE_WHEN = 'Done when';
export const START_PLAN = 'Plan';
export const START_HOW_IT_RUNS = 'How it runs';
/** The link under the plan, to the tasks it names. */
export const START_VIEW_TASKS = 'View tasks ›';
export const START_PROJECT_ACTION = 'Start the project';
/** What the armed composer asks for, once "Chat about this" has handed the reply to it. */
export const START_CHAT_PLACEHOLDER = 'What should change before it starts?';
/** The card's header when nobody asked — the owner's own Start… — and, after it, when the project
 *  has no coordinator either. */
export const START_NOBODY_ASKED = 'Nobody asked yet';
export const START_NO_COORDINATOR_YET = 'no coordinator yet';
/** What the coordinator's own words are headed with, and the press that shows all of them. */
export const START_COORDINATOR = 'Coordinator';
export const START_MORE = 'More';
export const START_LESS = 'Less';
/** What a press the door did not take says, over the door's own message. */
export const START_NOT_RECORDED = 'That start was not recorded';
/** Why Start is dead on a card whose request no longer stands. */
export const START_REQUEST_GONE =
  'The plan changed after the coordinator asked, so this request no longer stands. Orbit shows '
  + 'the card again when the coordinator asks to start the new plan.';

/** The sections' own heads, with how many there are: "Done when · 4 criteria", "Plan · 12 tasks in 7
 *  levels" — the levels said only when there are more than one, and only when the plan was drawn in
 *  them (a folded graph is just "Plan · N tasks"). */
export function startDoneWhenHead(count: number): string {
  return `${START_DONE_WHEN} · ${count} ${count === 1 ? 'criterion' : 'criteria'}`;
}

export function startPlanHead(count: number, levels = 1): string {
  const head = `${START_PLAN} · ${count} ${count === 1 ? 'task' : 'tasks'}`;
  return levels > 1 ? `${head} in ${levels} levels` : head;
}

/** Who asked, under the project's name: "The coordinator asked 56m ago". `ago` is each end's own
 *  clock words; an end whose clock cannot say says the words alone. */
export const START_COORDINATOR_ASKED = 'The coordinator asked';
export function startAskedLine(ago: string): string {
  return `${START_COORDINATOR_ASKED} ${ago}`;
}

/** The header line of a card nobody asked for: "Nobody asked yet", and "· no coordinator yet" when
 *  there is not one to ask. */
export function startNobodyAskedLine(hasCoordinator: boolean): string {
  return hasCoordinator ? START_NOBODY_ASKED : `${START_NOBODY_ASKED} · ${START_NO_COORDINATOR_YET}`;
}

/** The one paragraph the card keeps: what starting binds the project to, and what happens when the
 *  criteria move later — it asks again, and nothing stops. */
export function startExplanation(count: number): string {
  return (
    `Orbit derives done from these ${count} criteria and nothing else. If they change later, it `
    + 'asks you to confirm the new version — the project keeps running.'
  );
}

/**
 * What pressing Start does, said under the button: who it opens, what starts at once, and what it
 * confirms — "Starts P1a now · confirms these 7 criteria · seal 3f2a…". A start that opens the
 * project's first coordinator says that first and leaves the seal out, so the line still fits.
 */
export function startBarCaption(input: {
  opensCoordinator: boolean;
  /** The labels of the tasks Orbit starts the moment the project starts. */
  startsNow: readonly string[];
  criteria: number;
  seal: string;
}): string {
  const parts = [
    ...(input.opensCoordinator ? ['opens a coordinator'] : []),
    ...(input.startsNow.length > 0 ? [`starts ${joinAnd(input.startsNow)} now`] : []),
    input.criteria === 1 ? 'confirms this criterion' : `confirms these ${input.criteria} criteria`,
    ...(input.opensCoordinator ? [] : [`seal ${input.seal}`]),
  ];
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/**
 * Whether the project has been started — its `started_at`, off the project read — or null for a
 * read that does not say. Started is the one fact the three settlement cards turn on: an unstarted
 * project is asked by the start card, a started one by the confirmation cards. Automatic
 * (`coordinatorEnabled`) no longer says it: it is how a started project runs, not whether it does.
 */
export function projectStarted(project: { startedAt?: string | null }): boolean | null {
  return project.startedAt === undefined ? null : project.startedAt !== null;
}

/** The start's row on a page about the project: the coordinator's open request, or the owner's own
 *  Start… while nobody has asked. */
export type StartPageRow = { kind: 'asked'; row: ProjectOpenItemRow } | { kind: 'own' };

/**
 * Which start row a page draws — the project page's Open items and the project's sessions page alike
 * (OrbitKit `StartProject.pageRow`). Only a project nobody has started draws one: a read that does not
 * say whether it started is not a project waiting to be started. And the owner's own Start… only once
 * the open-items read has answered: a request still on its way is not a project nobody asked about.
 */
export function startPageRow(
  started: boolean | null | undefined,
  items: Pick<ProjectOpenItemsView, 'startRequest'> | undefined,
): StartPageRow | null {
  if (started !== false || items === undefined) return null;
  return items.startRequest ? { kind: 'asked', row: items.startRequest } : { kind: 'own' };
}

/**
 * Which of the three questions a coordinator conversation's settlement card is asking: start this
 * project, confirm the criteria that changed since it started, or — for a started project nobody
 * ever confirmed — confirm them at all.
 */
export type SettlementQuestion = 'START' | 'CRITERIA_CHANGE' | 'CONFIRMATION';

// ── The words: How it runs ───────────────────────────────────────────────────────────────────

export const RUN_TASKS_LAND_ON = 'Tasks land on';
export const RUN_EXECUTION = 'Execution';
export const RUN_INTEGRATION = 'Integration';
export const RUN_LINE_PROJECT_BRANCH = 'A project branch';
export const RUN_LINE_PROJECT_BRANCH_HINT =
  'Recommended when tasks depend on each other: they land here first and are checked together.';
export const RUN_LINE_MAIN = 'Directly into main';
export const RUN_LINE_MAIN_HINT = 'For a single task or an urgent fix. Every merge into main asks you.';
export const RUN_AUTOMATIC = 'Automatic';
/** What Automatic means, on a project branch: the coordinator runs the project, merges included. */
export const RUN_AUTOMATIC_HINT_PROJECT_BRANCH =
  'The coordinator runs it for you: it decides when each task is done, handles conflicts and '
  + 'failed checks, and merges the branch into main once the merge check passes — with a receipt '
  + 'you can revert. The criteria and anything irreversible stay yours.';
/** …and directly into main, where the merging half is the one thing it never does by itself. */
export const RUN_AUTOMATIC_HINT_MAIN =
  'The coordinator runs it for you: it decides when each task is done and handles conflicts and '
  + 'failed checks. Merging into main always asks you — a project that lands directly on main '
  + 'never merges by itself. The criteria and anything irreversible stay yours.';
export const RUN_SWITCH_ON = 'On';
export const RUN_SWITCH_OFF = 'Off';
export const RUN_AT_MOST = 'At most';
export const RUN_MERGE_CHECK = 'Merge check';
export const RUN_MERGE_CHECK_HINT =
  'Runs on the combined tree before anything lands — on the project branch and again before main.';
export const RUN_MERGE_CHECK_PLACEHOLDER = 'No check — work lands once it rebases cleanly';
/** The merge check's row on the start card, folded to its value, and what an empty one means. */
export const RUN_MERGE_CHECK_SET = 'Set';
export const RUN_MERGE_CHECK_NONE = 'None';
export const RUN_MERGE_CHECK_NONE_SAYS = 'Work lands once it rebases cleanly.';
/** Said under an empty merge check while Automatic would merge the branch into main unchecked. */
export const RUN_NO_MERGE_CHECK_WARNING =
  'No merge check: with Automatic on, the branch merges into main with nothing run on the '
  + 'combined tree.';

/** The Automatic sentence for the line chosen: the merge half follows the line. */
export function runAutomaticHint(line: ProjectStartSettings['line']): string {
  return line === 'MAIN' ? RUN_AUTOMATIC_HINT_MAIN : RUN_AUTOMATIC_HINT_PROJECT_BRANCH;
}

/** The start card's one sentence under the switch: who decides what, for the line and merge check
 *  chosen. What still comes to the owner is the list beneath it (`startComesToYou`). */
export const RUN_AUTOMATIC_ON_CHECKED =
  'The coordinator decides when each task is done and merges into main once the merge check '
  + 'passes — with a receipt you can revert.';
export const RUN_AUTOMATIC_ON_UNCHECKED =
  'The coordinator decides when each task is done and merges into main by itself — with a receipt '
  + 'you can revert.';
export const RUN_AUTOMATIC_ON_MAIN =
  'The coordinator decides when each task is done. Each merge into main still asks you.';
export const RUN_AUTOMATIC_OFF = 'You decide when each task is done and when the branch goes into main.';
export const RUN_AUTOMATIC_OFF_MAIN = 'You decide when each task is done, and each merge into main asks you.';

export function runAutomaticSays(
  automatic: boolean,
  line: ProjectStartSettings['line'],
  hasMergeCheck: boolean,
): string {
  if (!automatic) return line === 'MAIN' ? RUN_AUTOMATIC_OFF_MAIN : RUN_AUTOMATIC_OFF;
  if (line === 'MAIN') return RUN_AUTOMATIC_ON_MAIN;
  return hasMergeCheck ? RUN_AUTOMATIC_ON_CHECKED : RUN_AUTOMATIC_ON_UNCHECKED;
}

/** Said under the switch when Automatic is on and the project has no coordinator to run it yet:
 *  the start opens one (`POST /projects/:id/start`). */
export const START_OPENS_COORDINATOR =
  'This project has no coordinator yet. Orbit opens one where its tasks run when it starts.';

// ── The words: what still comes to the owner ─────────────────────────────────────────────────

export const START_COMES_TO_YOU = 'Comes to you';
export const START_DECIDE_DONE = 'Whether each task is done';
export const START_YOU_CONFIRM = 'you confirm it';
export const START_PROBLEMS = 'Problems along the way';
export const START_PROBLEMS_DETAIL = 'conflicts, failed checks';
export const START_MERGING_INTO_MAIN = 'Merging the branch into main';
export const START_EACH_MERGE_INTO_MAIN = 'Each merge into main';
export const START_CRITERIA_CHANGES = 'Any change to the criteria';

/** "11 reviews": the evidence the owner decides on when Automatic is off. */
export function startReviews(count: number): string {
  return `${count} ${count === 1 ? 'review' : 'reviews'}`;
}

/** More tasks the owner confirms than one list should name. */
export function startTasksYouConfirm(count: number): string {
  return `${count} tasks you confirm`;
}

/** "Problems it can’t resolve within 2 h": what reaches the owner of an Automatic project, after the
 *  project's escalation window. */
export function startProblemsUnresolved(within: string): string {
  return `Problems it can’t resolve within ${within}`;
}

/** An escalation window as the list says it: "30 min", "2 h". */
export function startWithin(seconds: number): string {
  return seconds < 3600 ? `${Math.max(1, Math.round(seconds / 60))} min` : `${Math.round(seconds / 3600)} h`;
}

/** One line of the list: what comes to the owner, and a few words after it. */
export interface StartComesToYouItem {
  text: string;
  detail: string | null;
}

/**
 * What still comes to the owner once the project starts with these settings — the consequence of
 * the Automatic switch, listed rather than described, so flipping it shows what it costs.
 *
 * Read off the settings and the plan's own tasks, by the rules the server runs: an OWNER_CONFIRMED
 * task is always the owner's to confirm; with Automatic off every EVIDENCE_JUDGMENT task's evidence
 * comes to them, and so does every problem (nothing is handed to the coordinator); a branch merges
 * into main on the owner's word unless Automatic is on, and a project that lands directly on main
 * never merges by itself; with Automatic on, a problem reaches the owner only after the project's
 * escalation window. Criteria are always the owner's.
 */
export function startComesToYou(input: {
  automatic: boolean;
  line: ProjectStartSettings['line'];
  /** The plan's OWNER_CONFIRMED tasks, by the order line's label and their title. */
  ownerConfirmed: ReadonlyArray<{ label: string; title: string }>;
  /** How many of its tasks are settled by a judgment of their evidence. */
  evidenceJudged: number;
  escalationSeconds: number;
}): StartComesToYouItem[] {
  const confirms: StartComesToYouItem[] = input.ownerConfirmed.length > 3
    ? [{ text: startTasksYouConfirm(input.ownerConfirmed.length), detail: null }]
    : input.ownerConfirmed.map((task) => ({ text: `${task.label} · ${task.title}`, detail: START_YOU_CONFIRM }));
  const merges: StartComesToYouItem[] = input.line === 'MAIN'
    ? [{ text: START_EACH_MERGE_INTO_MAIN, detail: null }]
    : input.automatic ? [] : [{ text: START_MERGING_INTO_MAIN, detail: null }];
  const criteria = { text: START_CRITERIA_CHANGES, detail: null };
  if (input.automatic) {
    return [
      ...confirms,
      ...merges,
      criteria,
      { text: startProblemsUnresolved(startWithin(input.escalationSeconds)), detail: null },
    ];
  }
  return [
    { text: START_DECIDE_DONE, detail: input.evidenceJudged > 0 ? startReviews(input.evidenceJudged) : null },
    ...confirms,
    { text: START_PROBLEMS, detail: START_PROBLEMS_DETAIL },
    ...merges,
    criteria,
  ];
}

// ── The words: the footnote under How it runs ────────────────────────────────────────────────

export const START_AUTOMATIC_BY_DEFAULT = 'Automatic is on by default';
export const START_COORDINATOR_SUGGESTED_OFF = 'the coordinator suggested off';
export const START_REST_SUGGESTED = 'The rest is the coordinator’s suggestion.';
export const START_CHANGE_LATER = 'You can change any of these later on the project page.';

/** Whose settings these are, and that they can change: Automatic is the owner's default whatever a
 *  coordinator suggested, and the rest is the coordinator's suggestion when one asked. */
export function startHowItRunsNote(asked: boolean, suggestedOff: boolean): string {
  const automatic = suggestedOff
    ? `${START_AUTOMATIC_BY_DEFAULT} (${START_COORDINATOR_SUGGESTED_OFF}).`
    : `${START_AUTOMATIC_BY_DEFAULT}.`;
  return [automatic, ...(asked ? [START_REST_SUGGESTED] : []), START_CHANGE_LATER].join(' ');
}

/** The words after the number box: "At most [3] tasks at a time". */
export function runTasksAtATime(count: number | null): string {
  return `${count === 1 ? 'task' : 'tasks'} at a time`;
}

/** Whether the merge check row is the amber one: Automatic on a project branch with nothing to run
 *  on the combined tree before the branch merges into main — the ready check's own warning. */
export function runMergeCheckMissing(
  settings: Pick<ProjectStartSettings, 'line' | 'automatic' | 'mergeCheckCommand'>,
): boolean {
  return settings.automatic && settings.line === 'PROJECT_BRANCH' && !settings.mergeCheckCommand?.trim();
}

// ── The words: the project page ──────────────────────────────────────────────────────────────

/**
 * The start card's way in from the project page. A coordinator's request is answered on the card in
 * its conversation, and the Open items row takes the reader there ("Review") rather than drawing a
 * second copy; with no request, the row is the owner's own "Start…", which opens the same card over
 * the page, set by the default rule.
 */
export const START_ROW_ASKED = 'The coordinator asked';
export const START_ROW_OWN = 'Start…';
export const START_ROW_NOT_ASKED = 'not asked yet';

/** Why a reader arrives in the coordinator conversation from "Review" (`?intent=start-project`): to
 *  find the start card, which the conversation scrolls to once it is drawn. */
export const START_PROJECT_INTENT = 'start-project';

/** A line as a sentence names it, mid-sentence: "a project branch", "directly into main". */
export function runLineInSentence(line: ProjectStartSettings['line']): string {
  return line === 'MAIN' ? 'directly into main' : 'a project branch';
}

/** The request's row under its title: who asked, and what it suggests — "The coordinator asked · a
 *  project branch · Automatic on · at most 3 at a time". */
export function startRequestSummary(settings: ProjectStartSettings): string {
  return [
    START_ROW_ASKED,
    runLineInSentence(settings.line),
    `${RUN_AUTOMATIC} ${settings.automatic ? 'on' : 'off'}`,
    `at most ${settings.maxConcurrentTasks} at a time`,
  ].join(' · ');
}

/** The integration row of a project nobody has started: where its tasks land is the start's to
 *  decide — "Tasks land on: decided when you start — the coordinator suggests a project branch". */
export const RUN_LINE_DECIDED_AT_START = 'decided when you start';
export const RUN_LINE_SUGGESTED = 'the coordinator suggests';

/** "How it runs", once the project is started: the settings the start card set, in one block. */
export const RUN_APPLIES_FROM_NEXT_TASK = 'applies from the next task';
export const RUN_ESCALATE_AFTER = 'Escalate after';
export const RUN_ESCALATE_HINT = 'Items the coordinator hasn’t handled by then come to you.';
export const RUN_SAVE = 'Save';
/** What a Save the doors did not take says, over the door's own message. */
export const RUN_NOT_SAVED = 'These settings were not saved';
export const RUN_PAUSE = 'Pause project';
export const RUN_PAUSE_HINT = 'Stops new tasks, wake-ups and merges into main. Running tasks finish.';
export const RUN_RESUME = 'Resume project';
export const RUN_NOT_PAUSED = 'The project was not paused';
export const RUN_NOT_RESUMED = 'The project was not resumed';

/** Why Tasks land on is read-only: the line started integrating — `since` is "2h ago" — and moving
 *  it would orphan what already landed on it. */
export function runLineLocked(since: string | null): string {
  return `This project started integrating${since ? ` ${since}` : ''}, so the line it lands on can `
    + 'no longer change. Merge it into main, or give up the branch, to start another.';
}

/** What a paused project says before what pausing does: since when — "Paused 2h ago." */
export function runPausedSince(since: string): string {
  return `Paused ${since}.`;
}

// ── The settings a start left behind, in one line ────────────────────────────────────────────

export const RUN_SUMMARY_MERGE_CHECK_SET = 'merge check set';
export const RUN_SUMMARY_NO_MERGE_CHECK = 'no merge check';
/** What a setting that is not what the coordinator suggested says when it is pointed at. */
export const RUN_SETTING_DIFFERS = 'Not what the coordinator suggested';

/** A project branch as a line names it: without `refs/heads/`, and `project/<id>` down to the first
 *  five characters of the id, which is how a reader tells two of them apart. */
export function shortBranch(ref: string): string {
  const name = ref.replace(/^refs\/heads\//u, '');
  const project = /^project\/(.{6,})$/u.exec(name);
  return project ? `project/${project[1]!.slice(0, 5)}…` : name;
}

/** One setting of the one-line summary, and whether it is not what the start was asked for. */
export interface RunSettingsPart {
  key: ProjectStartSettingKey;
  text: string;
  differs: boolean;
}

/** The settings a start left the project with, in card order: the line, Automatic, concurrency and
 *  the merge check — "project/34Wvw… · Automatic on · 3 tasks at a time · merge check set". */
export function runSettingsParts(
  settings: ProjectStartSettings,
  differs: readonly ProjectStartSettingKey[] = [],
): RunSettingsPart[] {
  const tasks = settings.maxConcurrentTasks;
  const parts: Array<Omit<RunSettingsPart, 'differs'>> = [
    {
      key: 'line',
      text: settings.line === 'MAIN'
        ? RUN_LINE_MAIN
        : settings.projectBranchName
          ? shortBranch(settings.projectBranchName)
          : RUN_LINE_PROJECT_BRANCH,
    },
    { key: 'automatic', text: `${RUN_AUTOMATIC} ${settings.automatic ? 'on' : 'off'}` },
    { key: 'maxConcurrentTasks', text: `${tasks} ${runTasksAtATime(tasks)}` },
    {
      key: 'mergeCheckCommand',
      text: settings.mergeCheckCommand ? RUN_SUMMARY_MERGE_CHECK_SET : RUN_SUMMARY_NO_MERGE_CHECK,
    },
  ];
  return parts.map((part) => ({ ...part, differs: differs.includes(part.key) }));
}

export function runSettingsLine(settings: ProjectStartSettings): string {
  return runSettingsParts(settings).map((part) => part.text).join(' · ');
}

// ── The plan, by level ───────────────────────────────────────────────────────────────────────

/** One task of the plan. `after` names its prerequisites by id; the two settlement facts are what the
 *  card marks it by (Now, You) and counts in what comes to the owner. */
export interface PlanTask {
  id: string;
  title: string;
  after: readonly string[];
  completionCriterion?: string;
  autoRunWhenReady?: boolean;
}

/**
 * What the plan calls a task: the marker its title opens with — "A · …", "① 服务端 · …", "3) …",
 * "B：…", "P1 Web：…", "P1a · …" — and otherwise the title itself, cut short. A plan is written with
 * those markers when its tasks are meant to be named by them, and a title with none is named whole.
 */
export function planTaskLabel(title: string): string {
  const text = title.trim();
  const circled = /^([①-⑳❶-❿])/u.exec(text);
  if (circled) return circled[1]!;
  const marked = /^([A-Za-z]|\d{1,2})(?:[.):：]|\s+[·\-–—:：|](?:\s|$))/u.exec(text);
  if (marked) return marked[1]!;
  // A capital, one or two digits and at most one small letter — "P1", "D12", "P1a" — is a code
  // rather than a word, so a space after it is separator enough.
  const coded = /^([A-Z]\d{1,2}[a-z]?)(?:[.):：]|\s)/u.exec(text);
  if (coded) return coded[1]!;
  return [...text].length > 24 ? `${[...text].slice(0, 23).join('')}…` : text;
}

function joinAnd(words: readonly string[]): string {
  return words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** One task as a level of the plan lists it. */
export interface PlanLevelTask {
  id: string;
  label: string;
  title: string;
  /** Orbit starts it the moment the project does: first level, and not set to start by hand. */
  now: boolean;
  /** The owner confirms it (OWNER_CONFIRMED). */
  you: boolean;
}

/**
 * The plan in levels — the batch-create review's rule (`buildBatchGraph`, OrbitKit `batchLevels`): a
 * task sits one level after the deepest of what it waits on, and tasks on one level do not wait on
 * each other. Tasks are given oldest first, which is the order within a level; an edge to a task
 * outside `tasks` (settled work, another project) waits on nothing here, and a cycle the server would
 * never have allowed is cut rather than followed.
 */
export function planLevels(tasks: readonly PlanTask[]): PlanLevelTask[][] {
  const index = new Map(tasks.map((task, at) => [task.id, at]));
  const prerequisites = new Map(
    tasks.map((task) => [
      task.id,
      [...new Set(task.after)].filter((id) => index.has(id) && id !== task.id),
    ]),
  );
  const level = new Map<string, number>();
  const depth = (id: string, seen: Set<string>): number => {
    const known = level.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const after = prerequisites.get(id) ?? [];
    const at = after.length === 0 ? 0 : 1 + Math.max(...after.map((each) => depth(each, seen)));
    level.set(id, at);
    return at;
  };
  const levels: PlanLevelTask[][] = [];
  for (const task of tasks) {
    const at = depth(task.id, new Set());
    (levels[at] ??= []).push({
      id: task.id,
      label: planTaskLabel(task.title),
      title: task.title,
      now: at === 0 && task.autoRunWhenReady !== false,
      you: task.completionCriterion === 'OWNER_CONFIRMED',
    });
  }
  return levels.filter((each) => each !== undefined);
}

/** "5 in parallel": a level of more than one task. */
export function startInParallel(count: number): string {
  return `${count} in parallel`;
}

export const START_NOW = 'Now';
export const START_YOU = 'You';

/** A task's title without the label the plan already calls it by: "P1a · wiki-worker …" is listed
 *  as "P1a" and "wiki-worker …". */
export function planTaskRest(title: string, label: string): string {
  const text = title.trim();
  if (label === text || !text.startsWith(label)) return text;
  return text.slice(label.length).replace(/^\s*[.):：·\-–—|]?\s*/u, '') || text;
}

// ── The words: the change card, and the receipts ─────────────────────────────────────────────

export const CRITERIA_CHANGE_TITLE = 'Confirm the new criteria?';
/** The list of changes, as a screen reader is told it; drawn as the list itself. */
export const CRITERIA_CHANGE_WHAT_CHANGED = 'What changed';
export const CRITERIA_CHANGE_NEW = 'New';
export const CRITERIA_CHANGE_STRICTER = 'Stricter check';
/** A criterion changed some other way — reworded, or its check rewritten — which only an approved
 *  proposal lands, and only while the confirmation was already behind. */
export const CRITERIA_CHANGE_REVISED = 'Changed';
/** Where the project stands, as the change card's meta line says it: running, and not held. */
export const CRITERIA_CHANGE_RUNNING = 'running';
export const CRITERIA_CHANGE_EXPLAINS =
  'The project keeps running. Orbit marks it done only against criteria you’ve confirmed, so until '
  + 'you confirm these it stays open even if every task finishes.';
export const CRITERIA_CHANGE_CHAT_PLACEHOLDER = 'What should change about these?';

/** The check a stricter criterion replaced, under the one it has now. */
export function criteriaChangeWas(method: string): string {
  return `was: ${method}`;
}

/** "5 · New", "2 · Stricter check": which criterion, and what happened to it. */
export function criteriaChangeKind(ordinal: number, kind: string): string {
  return `${ordinal} · ${kind}`;
}

/** Which project, that it is running, how many criteria before and now, and the seal a press
 *  confirms. */
export function criteriaChangeMeta(
  projectTitle: string,
  confirmedCount: number,
  count: number,
  seal: string,
): string {
  return `${projectTitle} · ${CRITERIA_CHANGE_RUNNING} · ${confirmedCount} → ${count} criteria · seal ${seal}`;
}

/** The criteria that read as they were confirmed, by number — and the confirmed ones that are gone,
 *  counted, because no text of theirs is left to show. */
export function criteriaChangeUnchanged(ordinals: readonly number[], removed: number): string {
  const same = ordinals.length === 0 ? '' : `${ordinals.join(', ')} unchanged`;
  const gone = removed === 0 ? '' : `${removed} removed`;
  return [same, gone].filter(Boolean).join(' · ');
}

export function criteriaChangeShowAll(count: number): string {
  return `Show all ${count}`;
}

export function criteriaChangeConfirmLabel(count: number): string {
  return `Confirm ${count} ${count === 1 ? 'criterion' : 'criteria'}`;
}

/** What a re-confirmation's receipt adds after the seal: what the new version changed, counted. */
export function criteriaChangeSummary(changes: {
  added: number;
  stricter: number;
  revised: number;
  removed: number;
}): string {
  return [
    changes.added > 0 ? `${changes.added} new` : '',
    changes.stricter > 0 ? `${changes.stricter} stricter` : '',
    changes.revised > 0 ? `${changes.revised} changed` : '',
    changes.removed > 0 ? `${changes.removed} removed` : '',
  ].filter(Boolean).join(', ');
}

/**
 * Where a press on the change card leaves what it confirmed — "1 new, 1 stricter" — for the receipt
 * of that confirmation, under the seal it signed. Kept by this window only: once a set is confirmed
 * nothing is left changed, so the confirmation read cannot say it afterwards, and a receipt drawn
 * on another device or after a reload says the seal and the count without it.
 */
export const confirmedChangesKey = (projectId: string, digest: string) =>
  ['project', projectId, 'confirmed-changes', digest] as const;

/** The current window's receipt summary, kept on the project so the transcript reader can observe
 * it while the confirmation digest changes from the old seal to the one just confirmed. */
export const confirmedChangesProjectKey = (projectId: string) =>
  ['project', projectId, 'confirmed-changes'] as const;

// ── The write ────────────────────────────────────────────────────────────────────────────────

/**
 * `POST /projects/:id/start` — the owner's own, one write: the criteria confirmed by the seal they
 * read, and the settings on the card. A seal that moved, or a project already started, is a 409
 * and nothing is written.
 */
export const startProject = (
  projectId: string,
  body: StartProjectRequestBody,
): Promise<StartProjectResponse> =>
  api<StartProjectResponse>(`/projects/${encodeURIComponent(projectId)}/start`, {
    method: 'POST',
    body,
  });
