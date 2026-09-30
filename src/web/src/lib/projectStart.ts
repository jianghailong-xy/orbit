import type {
  ProjectStartFinding,
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
/** Who asked, as the meta line says it. */
export const START_ASKED_BY_COORDINATOR = 'asked by the coordinator';
/** What a session row, its header and the pinned strip say while the card is waiting. */
export const READY_TO_START = 'Ready to start';
export const START_DONE_WHEN = 'Done when';
export const START_PLAN = 'Plan';
export const START_HOW_IT_RUNS = 'How it runs';
export const START_SUGGESTED_BY_COORDINATOR = 'suggested by the coordinator';
/** The link beside the plan's order, to the tasks it names. */
export const START_VIEW_TASKS = 'View tasks ›';
export const START_PROJECT_ACTION = 'Start the project';
/** What the armed composer asks for, once "Chat about this" has handed the reply to it. */
export const START_CHAT_PLACEHOLDER = 'What should change before it starts?';
/** What the ready check looked at, before the list of what it found true. */
export const START_CHECKED_PLAN = 'Orbit checked the plan:';
export const START_CHECKED_CRITERIA = 'every criterion has a task serving it';
export const START_CHECKED_RUNNERS = 'every task has a runner';
/** What a press the door did not take says, over the door's own message. */
export const START_NOT_RECORDED = 'That start was not recorded';
/** Why Start is dead on a card whose request no longer stands. */
export const START_REQUEST_GONE =
  'The plan changed after the coordinator asked, so this request no longer stands. Orbit shows '
  + 'the card again when the coordinator asks to start the new plan.';

/** The sections' own heads, with how many there are: "Done when · 4 criteria", "Plan · 5 tasks". */
export function startDoneWhenHead(count: number): string {
  return `${START_DONE_WHEN} · ${count} ${count === 1 ? 'criterion' : 'criteria'}`;
}

export function startPlanHead(count: number): string {
  return `${START_PLAN} · ${count} ${count === 1 ? 'task' : 'tasks'}`;
}

/** Which project, who asked and when, and the seal a press confirms — the version is last because
 *  it is what a reader needs only once they have read the rest. `askedAgo` is null for a card no
 *  coordinator asked for. */
export function startCardMeta(projectTitle: string, askedAgo: string | null, seal: string): string {
  const asked = askedAgo === null ? '' : ` · ${START_ASKED_BY_COORDINATOR} · ${askedAgo}`;
  return `${projectTitle}${asked} · seal ${seal}`;
}

/** The one paragraph the card keeps: what starting binds the project to, and what happens when the
 *  criteria move later — it asks again, and nothing stops. */
export function startExplanation(count: number): string {
  return (
    `Orbit derives done from these ${count} criteria and nothing else. If they change later, it `
    + 'asks you to confirm the new version — the project keeps running.'
  );
}

/** What the ready check found true, in the order it checks: served, runnable, and the repository
 *  the project integrates into when it has one. */
export function startCheckedLine(repository: string | null): string {
  const found = [
    START_CHECKED_CRITERIA,
    START_CHECKED_RUNNERS,
    ...(repository ? [`repository ${repositoryLabel(repository)}`] : []),
  ];
  return `${START_CHECKED_PLAN} ${found.join(' · ')}`;
}

/** What the coordinator said about the plan, as the card quotes it under the settings. */
export function startCoordinatorSays(why: string): string {
  return `Coordinator: “${why}”`;
}

/** A repository as a reader names it: `owner/repo` out of whatever URL the binding holds. */
export function repositoryLabel(url: string): string {
  const path = url.trim().replace(/\.git$/u, '').replace(/\/+$/u, '');
  const parts = path.split(/[/:]/u).filter(Boolean);
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : path;
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

/**
 * Which of the three questions a coordinator conversation's settlement card is asking: start this
 * project, confirm the criteria that changed since it started, or — for a started project nobody
 * ever confirmed — confirm them at all.
 */
export type SettlementQuestion = 'START' | 'CRITERIA_CHANGE' | 'CONFIRMATION';

// ── The words: How it runs ───────────────────────────────────────────────────────────────────

export const RUN_TASKS_LAND_ON = 'Tasks land on';
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
/** Said under an empty merge check while Automatic would merge the branch into main unchecked. */
export const RUN_NO_MERGE_CHECK_WARNING =
  'No merge check: with Automatic on, the branch merges into main with nothing run on the '
  + 'combined tree.';

/** The Automatic sentence for the line chosen: the merge half follows the line. */
export function runAutomaticHint(line: ProjectStartSettings['line']): string {
  return line === 'MAIN' ? RUN_AUTOMATIC_HINT_MAIN : RUN_AUTOMATIC_HINT_PROJECT_BRANCH;
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

// ── The plan, in one line ────────────────────────────────────────────────────────────────────

/** One task of the plan, as the order line reads it. `after` names its prerequisites by id. */
export interface PlanTask {
  id: string;
  title: string;
  after: readonly string[];
}

/**
 * What the order line calls a task: the marker its title opens with — "A · …", "① 服务端 · …",
 * "3) …", "B：…" — and otherwise the title itself, cut short. A plan is written with those markers
 * when its tasks are meant to be named by them, and a title with none is named whole.
 */
export function planTaskLabel(title: string): string {
  const text = title.trim();
  const circled = /^([①-⑳❶-❿])/u.exec(text);
  if (circled) return circled[1]!;
  const marked = /^([A-Za-z]|\d{1,2})(?:[.):：]|\s+[·\-–—:：|](?:\s|$))/u.exec(text);
  if (marked) return marked[1]!;
  return [...text].length > 24 ? `${[...text].slice(0, 23).join('')}…` : text;
}

function joinAnd(words: readonly string[]): string {
  return words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * The plan's order in one line — "A starts now · B, C after A · D after B · E after C and D": the
 * tasks that wait on the same prerequisites said together, in the order they can run, each group
 * after everything it waits on. Tasks are given oldest first, which is the order within a step;
 * an edge to a task outside `tasks` (settled work, another project) waits on nothing here.
 */
export function planOrderLine(tasks: readonly PlanTask[]): string {
  const index = new Map(tasks.map((task, at) => [task.id, at]));
  const label = new Map(tasks.map((task) => [task.id, planTaskLabel(task.title)]));
  const prerequisites = new Map(
    tasks.map((task) => [
      task.id,
      [...new Set(task.after)]
        .filter((id) => index.has(id) && id !== task.id)
        .sort((a, b) => index.get(a)! - index.get(b)!),
    ]),
  );
  // How far down the plan each task sits: one step after the furthest of what it waits on. A cycle
  // the server would never have allowed is cut rather than followed.
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
  const groups = new Map<string, { level: number; order: number; members: string[]; after: string[] }>();
  tasks.forEach((task, order) => {
    const after = prerequisites.get(task.id) ?? [];
    const key = after.join(',');
    const group = groups.get(key)
      ?? { level: depth(task.id, new Set()), order, members: [], after };
    group.members.push(task.id);
    groups.set(key, group);
  });
  return [...groups.values()]
    .sort((a, b) => a.level - b.level || a.order - b.order)
    .map((group) => {
      const who = group.members.map((id) => label.get(id)!).join(', ');
      if (group.after.length === 0) {
        return `${who} ${group.members.length === 1 ? 'starts' : 'start'} now`;
      }
      return `${who} after ${joinAnd(group.after.map((id) => label.get(id)!))}`;
    })
    .join(' · ');
}

/**
 * The ready check's warnings, in the owner's words: a task set to start by hand is named by the
 * label the order line gives it, and the merge check's warning is the row it is about rather than
 * a line here. A code this build does not know is said in the server's own words.
 */
export function startWarningLines(
  warnings: readonly ProjectStartFinding[],
  tasks: readonly Pick<PlanTask, 'id' | 'title'>[],
): string[] {
  const titles = new Map(tasks.map((task) => [task.id, task.title]));
  return warnings.flatMap((finding) => {
    if (finding.code === 'START_NO_MERGE_CHECK') return [];
    if (finding.code === 'START_TASKS_START_BY_HAND' && finding.tasks.length > 0) {
      return [startByHandWarning(
        finding.tasks.map((task) => planTaskLabel(titles.get(task.taskId) ?? task.title)),
      )];
    }
    return [finding.message];
  });
}

/** "B, C, D and E are set to start by hand — they wait for the coordinator even after the project
 *  starts." */
export function startByHandWarning(labels: readonly string[]): string {
  const one = labels.length === 1;
  return (
    `${joinAnd(labels)} ${one ? 'is' : 'are'} set to start by hand — ${one ? 'it waits' : 'they wait'} `
    + 'for the coordinator even after the project starts.'
  );
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
