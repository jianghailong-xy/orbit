import { LANDING_CHECK_COPY, inheritedLandingCommand, inheritedLandingTimeout } from '../lib/landingCheck';
import { useRef, useState, type JSX } from 'react';
import Markdown from './Markdown';
import remarkGfm from 'remark-gfm';
import type { ApprovalInfo, PermissionRule } from '../api';
import { BatchGraph } from './BatchGraph';
import { CardActionButton, CardActions } from './CardAction';
import { ReviewCard } from './ReviewCard';
import { useIsMobile } from '../lib/useMediaQuery';
import { ENTER_HINT, SHORTCUT_HINT, useApproveHotkey, useCardKeyClaim } from './CardHotkey';
import { buildBatchGraph, describeShape } from '../lib/batchGraph';
import { rehypeCodeWords } from '../lib/codeWords';
import { ReferenceLink, referenceUrlTransform } from '../lib/markdownLinks';
import { markdownToPlainLines } from '../lib/markdownText';
import { mainBranchName } from '../lib/projectStart';
import { RUNNER_OFFLINE, RUNNER_ONLINE, runnerOfflineLastSeen } from '../lib/runnerCopy';
import { ago } from '../lib/runnerEngines';
import {
  OWNER_CONFIRMATION_SHOW_ALL,
  OWNER_CONFIRMATION_SHOW_LESS,
  REPORT_CLAMP,
} from './OwnerConfirmationCard';
import { bashCommandRules, type ApprovalTranslation } from '@orbit/shared';
import { shownQuestions } from '../lib/translation';
import type { HeldDecision } from '../lib/approvalDecisions';
import { CardTranslationFoot, UntranslatedDecisionFoot } from './TranslationParts';
import { CONDITION_COPY } from '../lib/conditions';
import { ToolCallBody, toolCallHeading, toolCallSummary } from './ToolCallBody';

/**
 * What the card says once nothing is listening for its answer.
 *
 * A card is `answerable={false}` when the turn that raised it is over — see WorkspaceView, which
 * computes it from the same two committed facts the server filters `listApprovals` on. Nothing was
 * written to the approval when that happened (the engine writes nothing at all when it abandons a
 * call), so the row still says PENDING and always will; what changed is that the poll loop which
 * would have carried a decision back died with the turn.
 *
 * The card stays on screen rather than vanishing. It is the only place the question is written
 * down, and a card that silently disappears mid-read is indistinguishable from one somebody else
 * answered. So it keeps its content, loses every action (`CardAction`'s one rule: an action that
 * cannot succeed is `disabled`) and carries this line.
 *
 * What it offers instead is the one path that still reaches the agent: a new message. It used to
 * say the question would come back, which was only ever true of the completion decision a
 * coordinator turn raised — and since 2026-09-10 that decision is no question at all but Orbit's
 * own card (`EvidenceDecisionCard.tsx`), drawn from the pending read.
 */
export const UNANSWERABLE_NOTE =
  'This turn has ended, so an answer here would reach nobody. ' +
  'If it still matters, say so in a new message.';

/** The line a dead card carries in place of its actions. */
function UnanswerableNote(): JSX.Element {
  return <p className="approval-stale">{UNANSWERABLE_NOTE}</p>;
}

/**
 * Declining one of Orbit's own asks.
 *
 * Saying no to a batch of tasks, a create or a restructure is a position, not a misfire: the agent
 * proposed something and the answer is "not this". So the decline hands the composer the same reply
 * a question's "Chat about this" does — the refusal and what to do instead ride back together as
 * one deny+message, rather than the agent learning only that it was refused and guessing.
 *
 * A plain tool-permission Reject keeps its old one-press meaning: refusing a shell command is not a
 * proposal being discussed, and asking for a sentence first would be a tax on saying no. The native
 * half is `Approvals.decliningPrefix` / `declinePlaceholder` (OrbitKit).
 */
export const decliningPrefix = (toolName: string | null | undefined): string =>
  toolName === 'orbit_dag_change'
    ? 'Leaving the graph alone: '
    : toolName === 'orbit_blocker_resolve'
      ? 'Leaving this open: '
      : toolName === 'orbit_integration_skip_merge_check'
        ? 'Checking it after all: '
        : toolName === 'orbit_project_update_integration'
          ? 'Leaving the check as it is: '
          : toolName === 'orbit_runner_delete' || toolName === 'orbit_agent_delete'
            ? 'Keeping it: '
            : toolName === 'orbit_browser_clear_logins'
              ? 'Keeping the saved logins: '
            : toolName === 'orbit_agent_update'
              ? 'Leaving it as it is: '
              : 'Not creating: ';

/** What the empty composer asks for while a decline is armed. */
export const DECLINE_PLACEHOLDER = 'Say what to do instead…';

// claude routes plan-mode "exit?" through the same permission tool as any other gated
// call; ExitPlanMode is the one worth a rich render (its input carries the plan).
const isPlan = (a: ApprovalInfo): boolean => a.toolName === 'ExitPlanMode';

// Orbit's own ask, not the engine's permission prompt for a tool call: a batch of dependency
// edits, raised by tasklist_propose_dag with the server-computed impact attached. Rendered richly
// because the ops are not the decision — what results from them is.
const isDagChange = (a: ApprovalInfo): boolean => a.toolName === 'orbit_dag_change';

interface DagPreview {
  listTitle?: string;
  ops?: Array<{
    op: 'add' | 'remove';
    taskTitle?: string;
    dependsOnTitle?: string;
    noop?: boolean;
  }>;
  changes?: Array<{ taskId: string; title?: string; from: string; to: string }>;
  becomingRunnable?: number;
  becomingManual?: number;
  becomingBlocked?: number;
  effectiveCount?: number;
  edgesBefore?: number;
  edgesAfter?: number;
}

/** Orbit's other own ask: a batch of new tasks, which is how a DAG gets built in the first place. */
const isBatch = (a: ApprovalInfo): boolean => a.toolName === 'orbit_task_batch';

interface BatchPreview {
  taskCount?: number;
  startingNow?: number;
  blocked?: number;
  needsManualStart?: number;
  notDispatchable?: number;
  internalEdges?: number;
  externalEdges?: number;
  lists?: Array<{ id: string; title: string }>;
  assignees?: Array<{ id: string; name: string; hasRunner: boolean }>;
  tasks?: Array<{
    title: string;
    dependsOnRefs?: string[];
    dependsOnTaskIds?: string[];
    ref?: string | null;
    /** A task that starts when its condition holds: the card's Starts when, Today and If never lines. */
    startWhen?: StartWhenCardLines;
  }>;
  titlesTruncated?: number;
}

/** The server's lines for a startWhen task's card (apiserver tasks/task-start-when.ts startWhenCardLines). */
interface StartWhenCardLines {
  startsWhen: string;
  checked: string;
  command: string;
  today: string;
  ifNever: string;
  awake?: string | null;
}

/** A single create's startWhen lines, when the task starts on a condition (condition-triggers ②). */
function startWhenOf(input: CreateInput | null): StartWhenCardLines | null {
  if (!input || input.isProject) return null;
  return input.preview?.tasks?.[0]?.startWhen ?? null;
}

/** Starts when, Today and If never (condition-triggers ②): the condition, how it is checked and its command. */
function StartWhenFacts({ lines }: { lines: StartWhenCardLines }): JSX.Element {
  const K = CONDITION_COPY.facts;
  return (
    <dl className="sched-card-facts create-start-when" data-start-when-facts="">
      <dt>{K.startsWhen}</dt>
      <dd data-fact="starts-when">
        <b>{lines.startsWhen}</b>
        <div className="sched-card-sub">{lines.checked}</div>
        {lines.awake ? <div className="sched-card-sub" data-fact="awake">{lines.awake}</div> : null}
        <code className="sched-command">{lines.command}</code>
      </dd>
      <dt>{K.today}</dt>
      <dd data-fact="today">{lines.today}</dd>
      <dt>{K.ifNever}</dt>
      <dd data-fact="if-never">{lines.ifNever}</dd>
    </dl>
  );
}

/**
 * Orbit's asks before a single create: one task, or one project. Nothing is created on the owner's
 * behalf without their yes, so the card carries the body the runner is about to send and shows the
 * parts of it a person decides on — what it is, and what would settle it.
 */
const isTaskCreate = (a: ApprovalInfo): boolean => a.toolName === 'orbit_task_create';
const isProjectCreate = (a: ApprovalInfo): boolean => a.toolName === 'orbit_project_create';

interface CreateInput {
  isProject: boolean;
  title: string;
  /** A task's description, or a project's goal. */
  prose: string;
  /** A project's stated criteria as a list, or a task's as one Markdown block; markdown either way. */
  criteria: string;
  /**
   * The server's own preview of what the write does, on a task create — the same report the batch
   * card reads: how many run within the minute, how many wait, how many nothing will ever trigger.
   * One task is a batch of one and the server computes it the same way, when it files the card.
   * Absent when that read failed, which costs the card its pill and nothing else.
   */
  preview: BatchPreview | null;
  /** The completion criterion the caller declared; empty on a project, which declares criteria instead. */
  criterion: string;
}

/** Where a single create lands and how it settles, under the pill. The assignee is deliberately not
 *  named: the create defaults it to the calling agent, so "unassigned" is a claim this card cannot
 *  make from the input — and when nothing can run it, the pill says so instead. */
export function createDetail(input: CreateInput): string {
  const list = input.preview?.lists?.[0]?.title ?? '';
  return [list && `into ${list}`, input.criterion].filter(Boolean).join(' · ');
}

/** The caption over the field the owner is agreeing to. macOS/iOS: `Approvals.createDoneWhen`. */
export const CREATE_DONE_WHEN = 'Done when';

/** The single-task card's second yes: create the task and start its run in the same press, so the
 *  owner is not asked again to start it. macOS/iOS: `Approvals.createAndStartAction`; Android:
 *  `CardVerb.CREATE_AND_START`. */
export const CREATE_AND_START = 'Create and start';

/**
 * Whether the single-task card offers Create and start: only when the server's forecast says nothing
 * would start the task by itself (`needsManualStart` is 1). A task that starts on its own (now or at
 * its runAt), waits on a prerequisite, cannot run, or waits for its project to start has nothing for
 * the press to add, and a card whose forecast could not be read says nothing either way. Nor a card
 * the server did not mark `acceptsStartAfterCreate`: its runner, or the server itself, predates the
 * choice and would only create the task.
 * macOS/iOS: `Approvals.offersCreateAndStart`; Android: `ApprovalRules.offersCreateAndStart`.
 */
export function offersCreateAndStart(a: ApprovalInfo): boolean {
  if (!isTaskCreate(a)) return false;
  const input = (a.input ?? {}) as { preview?: BatchPreview; acceptsStartAfterCreate?: unknown };
  return input.acceptsStartAfterCreate === true && input.preview?.needsManualStart === 1;
}

/**
 * Whether Create and start is the card's primary answer, Enter included, with Create it beside it:
 * whenever it is offered, except on a task the agent filed with `autoRunWhenReady: false`. That is a
 * hold someone asked for, and pressing Enter out of habit should not start what they held.
 * macOS/iOS: `Approvals.createAndStartLeads`; Android: `ApprovalRules.createAndStartLeads`.
 */
export function createAndStartLeads(a: ApprovalInfo): boolean {
  return offersCreateAndStart(a) && (a.input as { autoRunWhenReady?: unknown }).autoRunWhenReady !== false;
}

/** Under a new project's criteria: approving the create is not confirming them — the project's
 *  start card asks that, once its coordinator has a plan to start. */
export const CREATE_CRITERIA_CONFIRMED_AT_START = 'You’ll confirm these when the project starts.';

/** The fold's own line, carrying its length the way the evidence card's claim fold does: this is the
 *  longest field on the card and the least decisive, and how much of it there is is what decides
 *  whether to open it. macOS/iOS: `Approvals.createFold`. */
export function createFoldLabel(noun: string, chars: number): string {
  return `the ${noun} (${chars} characters)`;
}

/** What the fold's control says once it is open. macOS/iOS: `Approvals.createFoldHide`. */
export function createFoldHideLabel(noun: string): string {
  return `hide the ${noun}`;
}

/** The noun the fold names, so a project's goal is never called a description. */
export const createFoldNoun = (input: CreateInput): string => (input.isProject ? 'goal' : 'description');

/**
 * Orbit's ask before an agent ends a project blocker.
 *
 * The one card here that is not about creating something: a blocker is the project saying it needs
 * a person, and `requiredAction` is addressed to the one reading this. So the card leads with what
 * the blocker asked for and puts the agent's argument that it no longer applies underneath — the
 * two sentences the decision is actually between.
 */
const isBlockerResolve = (a: ApprovalInfo): boolean => a.toolName === 'orbit_blocker_resolve';

/**
 * Orbit's ask before one landing runs WITHOUT its merge check (§2.4 J-S5). The fourth of the
 * coordinator's asks, and the one whose subject is a command: what the owner decides is whether that
 * command — shown verbatim — gets to hold up this landing, so the card leads with the command and
 * the red it produced, not with the word "skip".
 */
const isSkipMergeCheck = (a: ApprovalInfo): boolean => a.toolName === 'orbit_integration_skip_merge_check';

interface SkipMergeCheckInput {
  projectTitle: string;
  /** The DONE task whose landing this is. */
  taskTitle: string;
  /** The check command that will NOT run, as the project has it configured. */
  checkCommand: string;
  /** What that check said the last time, in the landing read's own words. */
  failure: string;
  /** Why the coordinator says this red is the check's rather than the delivery's. */
  reason: string;
  /** The project's main branch by name, which every merge into is still checked; main where the
   *  card names none (no repository bound, or a runner that predates it). */
  mainBranch: string;
}

function skipMergeCheckInput(a: ApprovalInfo): SkipMergeCheckInput | null {
  if (!isSkipMergeCheck(a)) return null;
  const obj = (a.input ?? {}) as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    projectTitle: text(obj.projectTitle),
    taskTitle: text(obj.taskTitle),
    checkCommand: text(obj.checkCommand),
    failure: text(obj.failure),
    reason: text(obj.reason),
    mainBranch: mainBranchName(text(obj.mainBranch)),
  };
}

/**
 * Orbit's ask before a session changes a project's merge check — the check run on the combined tree
 * before that project's work lands.
 *
 * The one integration setting an agent may propose: where the work LANDS stays the owner's alone
 * and is refused outright, but what is checked before it lands is a judgement the session holding a
 * failing check is the one that can make. So the card leads with the two commands — what the check
 * is now, and what it would become — because that difference is the whole of what is being decided.
 *
 * The server writes the change only against an ALLOWED card whose input reproduces the proposal it
 * is sent (`projects/project-integration-approval.ts`), so a card that misrepresents what would be
 * written does not merely mislead: the write it is attached to is refused.
 */
const isMergeCheckChange = (a: ApprovalInfo): boolean =>
  a.toolName === 'orbit_project_update_integration';

interface MergeCheckChangeInput {
  snapshot: Record<string, unknown>;
  projectTitle: string;
}

function mergeCheckChangeInput(a: ApprovalInfo): MergeCheckChangeInput | null {
  if (!isMergeCheckChange(a)) return null;
  const snapshot = (a.input ?? {}) as Record<string, unknown>;
  return { snapshot, projectTitle: typeof snapshot.projectTitle === 'string' ? snapshot.projectTitle : '' };
}

/**
 * Orbit's asks before a provider write: one of the owner's own providers created, changed or removed.
 * Drawn as the plain card — its body is the provider as it would be written, the key reduced to the
 * fact that one is being set — but, like every ask Orbit raises for itself, never waived by a rule.
 */
const isProviderWrite = (a: ApprovalInfo): boolean =>
  a.toolName === 'orbit_provider_create' ||
  a.toolName === 'orbit_provider_update' ||
  a.toolName === 'orbit_provider_delete';

/** What the endpoint speaks, by the `runtime` a provider is written with. */
const PROVIDER_PROTOCOLS: Record<string, string> = {
  claude: 'Anthropic Messages',
  codex: 'OpenAI Responses',
  kimi: 'Moonshot',
  antigravity: 'Gemini',
  cursor: 'Cursor User API Key',
};

export interface ProviderWriteInput {
  verb: 'add' | 'change' | 'delete';
  /** The label on an add, the slug otherwise: what the provider is called where the owner sees it. */
  name: string;
  /** The fields the write sets, in a fixed order; the key only as being set. */
  fields: Array<{ caption: string; value: string; mono: boolean }>;
  /** The model list it writes, or null when it leaves the list alone. */
  models: Array<{ value: string; label: string; context: string; isDefault: boolean }> | null;
}

/** 65536 → "64K", 1048576 → "1M": how a context window is said everywhere else. */
export function contextSize(tokens: number): string {
  if (tokens >= 1_048_576 && tokens % 1_048_576 === 0) return `${tokens / 1_048_576}M`;
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens % 1024 === 0) return `${tokens / 1024}K`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/**
 * A provider write as the card reads it: the fields by name rather than as the JSON the runner sent.
 * The runner files only what the write sets (`providerCard`), so an update shows its changes and
 * nothing it leaves alone.
 */
export function providerWriteInput(a: ApprovalInfo): ProviderWriteInput | null {
  if (!isProviderWrite(a)) return null;
  const obj = (a.input ?? {}) as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  const verb = a.toolName === 'orbit_provider_create' ? 'add'
    : a.toolName === 'orbit_provider_update' ? 'change' : 'delete';
  const fields: ProviderWriteInput['fields'] = [];
  const known = new Set(['slug', 'models']);
  const field = (key: string, caption: string, value: string, mono: boolean): void => {
    known.add(key);
    if (key in obj) fields.push({ caption, value, mono });
  };
  // On an add the label is the heading; on a change it is one of the things being written.
  if (verb === 'add') known.add('label');
  else field('label', 'Label', text(obj.label), false);
  const runtime = text(obj.runtime);
  field('runtime', 'Protocol', PROVIDER_PROTOCOLS[runtime] ? `${PROVIDER_PROTOCOLS[runtime]} (${runtime})` : runtime, false);
  field('baseUrl', 'Base URL', text(obj.baseUrl), true);
  field('apiKey', 'API key', 'Set — not shown', false);
  field('defaultModel', 'Default model', text(obj.defaultModel), true);
  // Anything a later runner sends that this card has no name for is still shown, never dropped.
  for (const [key, value] of Object.entries(obj)) {
    if (known.has(key)) continue;
    fields.push({ caption: key, value: typeof value === 'string' ? value : JSON.stringify(value), mono: true });
  }
  const models = Array.isArray(obj.models)
    ? obj.models.map((m) => {
        const row = (m ?? {}) as Record<string, unknown>;
        const value = text(row.value);
        return {
          value,
          label: text(row.label),
          context: typeof row.contextWindow === 'number' ? `${contextSize(row.contextWindow)} context` : '',
          isDefault: value !== '' && value === text(obj.defaultModel),
        };
      })
    : null;
  return { verb, name: verb === 'add' ? text(obj.label) : text(obj.slug), fields, models };
}

/**
 * Orbit's asks before a session deletes one of the account's runners or workspaces (runner_delete,
 * agent_delete). The asker sends only the id: what the card shows is the server's reading of what
 * goes, written when the card was filed (`runner-delete-approval.ts`), so it leads with names the
 * owner knows. The delete goes through only against a card a person answered, so like every ask
 * Orbit raises for itself it is never waived by a rule.
 */
const isRunnerDelete = (a: ApprovalInfo): boolean => a.toolName === 'orbit_runner_delete';
const isWorkspaceDelete = (a: ApprovalInfo): boolean => a.toolName === 'orbit_agent_delete';

interface DeleteInput {
  noun: 'runner' | 'workspace';
  name: string;
  /** Where it stands: a runner online or last seen, the runner a workspace is on. */
  status: string;
  /** A workspace's folder. */
  workDir: string | null;
  /** The workspaces that go with a runner. */
  workspaces: Array<{ name: string; workDir: string | null }>;
}

function deleteInput(a: ApprovalInfo, now: number): DeleteInput | null {
  const runner = isRunnerDelete(a);
  if (!runner && !isWorkspaceDelete(a)) return null;
  const obj = (a.input ?? {}) as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  if (runner) {
    const seen = text(obj.lastHeartbeatAt);
    return {
      noun: 'runner',
      name: text(obj.displayName) || text(obj.name),
      status: obj.online === true ? RUNNER_ONLINE : seen ? runnerOfflineLastSeen(ago(seen, now)) : RUNNER_OFFLINE,
      workDir: null,
      workspaces: (Array.isArray(obj.workspaces) ? obj.workspaces : []).map((w) => {
        const row = (w ?? {}) as Record<string, unknown>;
        return { name: text(row.name), workDir: text(row.workDir) || null };
      }),
    };
  }
  const host = (obj.runner ?? {}) as Record<string, unknown>;
  const hostName = text(host.displayName) || text(host.name);
  return {
    noun: 'workspace',
    name: text(obj.name),
    status: hostName ? `On ${hostName}` : 'On no runner',
    workDir: text(obj.workDir) || null,
    workspaces: [],
  };
}

/**
 * Orbit's asks before a session writes what decides a workspace's next session (agent_create and
 * agent_update naming its variables, folder, instructions, runner or worktree setting). The server
 * files the card with its own reading of the workspace, and writes only against a card a person
 * answered (`runner-workspace-approval.ts`), so like every ask Orbit raises for itself it is never
 * waived by a rule. It shows each variable's name and its value in full: the owner decides by reading
 * them, and the server erases the values from the card once it is answered.
 */
const isWorkspaceCreate = (a: ApprovalInfo): boolean => a.toolName === 'orbit_agent_create';
const isWorkspaceUpdate = (a: ApprovalInfo): boolean => a.toolName === 'orbit_agent_update';

/** What the yes reaches, under the facts. macOS/iOS: `Approvals.workspaceWriteNote`; Android: `WorkspaceWriteCards.note`. */
export const WORKSPACE_WRITE_NOTE =
  'Every later session in this workspace starts with this, in any permission mode. ' +
  'A variable can run code as soon as the engine starts.';

interface WorkspaceWriteInput {
  creating: boolean;
  name: string;
  /** The runner it is on, or a new one goes on. */
  status: string;
  /** Its folder as it stands. */
  workDir: string | null;
  /** The variables it would hold, by name: null when the write leaves them alone. */
  env: Array<{ name: string; value: string }> | null;
  /** The variables on it now that the write takes away, since it replaces the whole map. */
  envRemoved: string[];
  /** The rest of the write, in the order a person decides in. */
  fields: Array<{ caption: string; value: string }>;
}

function workspaceWriteInput(a: ApprovalInfo): WorkspaceWriteInput | null {
  const creating = isWorkspaceCreate(a);
  if (!creating && !isWorkspaceUpdate(a)) return null;
  const obj = (a.input ?? {}) as Record<string, unknown>;
  // A server that predates this card files what the asker sent: the plain card shows all of that.
  if (obj.changes === null || typeof obj.changes !== 'object') return null;
  const changes = obj.changes as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  const runnerName = (v: unknown): string => {
    const row = (v ?? {}) as Record<string, unknown>;
    return text(row.displayName) || text(row.name);
  };
  const host = runnerName(obj.runner);
  // An empty string is a field being cleared, which a blank block on a card would not say.
  const written = (v: unknown): string => text(v) || 'Cleared';
  const fields: WorkspaceWriteInput['fields'] = [];
  if (changes.workDir !== undefined) fields.push({ caption: 'Working directory', value: written(changes.workDir) });
  if (changes.systemPrompt !== undefined) fields.push({ caption: 'Base instructions', value: written(changes.systemPrompt) });
  if (changes.appendSystemPrompt !== undefined) fields.push({ caption: 'Runtime instructions', value: written(changes.appendSystemPrompt) });
  if (changes.runner !== undefined) fields.push({ caption: 'Runner', value: runnerName(changes.runner) });
  if (changes.enableWorktree !== undefined) {
    fields.push({
      caption: 'Worktree',
      value: changes.enableWorktree === true ? 'Each session gets its own git worktree' : 'Sessions run in the shared folder',
    });
  }
  if (!creating && changes.name !== undefined) fields.push({ caption: 'Name', value: written(changes.name) });
  if (changes.description !== undefined) fields.push({ caption: 'Description', value: written(changes.description) });
  if (changes.defaultMergeTarget !== undefined) fields.push({ caption: 'Merge target', value: written(changes.defaultMergeTarget) });
  const env = changes.env;
  return {
    creating,
    name: text(obj.name),
    status: host ? `On ${host}` : 'On no runner',
    workDir: text(obj.workDir) || null,
    env: env !== null && typeof env === 'object'
      ? Object.entries(env as Record<string, unknown>)
          .map(([name, value]) => ({ name, value: text(value) }))
          .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
      : null,
    envRemoved: Array.isArray(obj.envRemoved) ? obj.envRemoved.map(text) : [],
    fields,
  };
}

interface BlockerResolveInput {
  projectTitle: string;
  /** What the blocker asks for — the sentence written for a person to act on. */
  requiredAction: string;
  /** Why the agent says it no longer blocks. */
  reason: string;
  kind: string;
  /** The task it is about, when it is about one. */
  subjectTitle: string;
}

function blockerResolveInput(a: ApprovalInfo, shown?: ApprovalTranslation): BlockerResolveInput | null {
  if (!isBlockerResolve(a)) return null;
  const obj = (a.input ?? {}) as Record<string, unknown>;
  const blocker = (obj.blocker ?? {}) as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    projectTitle: text(obj.projectTitle),
    requiredAction: text(blocker.requiredAction),
    reason: shown?.reason || text(obj.reason),
    kind: text(blocker.kind),
    subjectTitle: text(blocker.subjectTitle),
  };
}

/** `shown`: the card's translation (orbitCardTranslation) while it is drawn translated; each field it
 *  lacks is the original's. */
function createInput(a: ApprovalInfo, shown?: ApprovalTranslation): CreateInput | null {
  const project = isProjectCreate(a);
  if (!project && !isTaskCreate(a)) return null;
  const obj = (a.input ?? {}) as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  const items = Array.isArray(obj.acceptanceCriteriaItems) ? obj.acceptanceCriteriaItems : [];
  return {
    isProject: project,
    title: shown?.title || text(obj.title),
    prose: (project ? shown?.goal : shown?.description) || text(project ? obj.goal : obj.description),
    criteria: project
      ? items
          .map((c, i) => shown?.acceptanceCriteriaItems?.[i]?.text || text((c as { text?: unknown } | null)?.text))
          .filter(Boolean)
          .map((t) => `- ${t}`)
          .join('\n')
      : shown?.acceptanceCriteria || text(obj.acceptanceCriteria),
    // The same key the batch card reads, for the same reason: the counts are the decision and the
    // body is not. A project create has no dispatch to report, so it carries none.
    preview: project ? null : (obj.preview as BatchPreview | undefined) ?? null,
    criterion: text(obj.completionCriterion),
  };
}

/** `shown`: the card's translation while it is drawn translated; `shown.tasks[i]` is `preview.tasks[i]`. */
function batchPreview(input: unknown, shown?: ApprovalTranslation): BatchPreview {
  const obj = (input ?? {}) as { preview?: BatchPreview };
  const preview = obj.preview ?? {};
  if (!shown?.tasks || !preview.tasks) return preview;
  return { ...preview, tasks: preview.tasks.map((t, i) => ({ ...t, title: shown.tasks?.[i]?.title || t.title })) };
}

function dagInput(input: unknown, shown?: ApprovalTranslation): { preview: DagPreview; note: string } {
  const obj = (input ?? {}) as { preview?: DagPreview; note?: unknown };
  return {
    preview: obj.preview ?? {},
    note: shown?.note || (typeof obj.note === 'string' ? obj.note : ''),
  };
}

/**
 * Settings › Translation on Orbit's own cards (board docs/mocks/session-translation/04-owner-cards.html,
 * part 2): the card's translation when it carries a field this card draws. Undefined when there is
 * none, it failed (the card is drawn as the agent wrote it), or the card is not one of these five.
 * macOS/iOS and Android draw the same fields.
 */
export function orbitCardTranslation(a: ApprovalInfo): ApprovalTranslation | undefined {
  const t = a.translation;
  if (!t || t.failed) return undefined;
  const has = isTaskCreate(a)
    ? Boolean(t.title || t.description || t.acceptanceCriteria)
    : isProjectCreate(a)
      ? Boolean(t.title || t.goal || t.acceptanceCriteriaItems?.some((c) => c.text))
      : isBatch(a)
        ? Boolean(t.tasks?.some((task) => task.title))
        : isBlockerResolve(a)
          ? Boolean(t.reason)
          : isDagChange(a)
            ? Boolean(t.note)
            : false;
  return has ? t : undefined;
}

function planText(input: unknown): string {
  if (input && typeof input === 'object' && 'plan' in input) {
    const p = (input as { plan?: unknown }).plan;
    if (typeof p === 'string') return p;
  }
  return '';
}

// Derive the rules for "always allow", or [] when none apply: questions/plans aren't
// repeatable. A Bash line yields one rule per distinct sub-command prefix (so `cd x && git
// add …` remembers both, not just the leading `cd`); other tools get a single tool-wide rule
// (no ruleContent).
export function rememberRulesFor(a: ApprovalInfo): PermissionRule[] {
  // A DAG change joins questions and plans in having no repeatable form. "Always allow
  // restructuring this campaign's dependencies" is not a rule anyone means to write, and the
  // whole point of the card is that each batch releases a different set of tasks.
  if (a.toolName === 'AskUserQuestion' || isPlan(a) || isDagChange(a) || isBatch(a)) return [];
  // Nor does a single create: a standing yes would be the owner's rule switched off. Nor ending a
  // blocker — "always let this session clear whatever stops its project" is the one rule that would
  // make every card after it a formality. Nor a provider write, which would be a standing yes to
  // whatever endpoint and key the next one names.
  // Nor a skip: "always let this conversation land past the check" is every later landing unchecked,
  // which is the project's setting and not a rule this card may leave behind.
  //
  // Nor a merge check, and this one has teeth on BOTH sides: the server writes a session's merge
  // check only against a card a PERSON answered (an auto-allowed row does not count), so a standing
  // rule would be a switch that turns the change into a refusal the agent cannot read — the owner
  // believing they had allowed it, and every later proposal coming back as a 403 telling the agent
  // to ask for a card that is already answered.
  //
  // Nor a delete, for the same reason: the server deletes only on a card a person answered, so a
  // standing yes would answer nothing — and each delete is a different runner or workspace anyway.
  // Nor a workspace write, which the server takes on the same terms, and each one writes other values.
  // Nor clearing the browser's saved logins (browser_clear_logins): the server clears only on a card a person answered.
  if (isTaskCreate(a) || isProjectCreate(a) || isBlockerResolve(a) || isProviderWrite(a)
    || isSkipMergeCheck(a) || isMergeCheckChange(a) || isRunnerDelete(a) || isWorkspaceDelete(a)
    || isWorkspaceCreate(a) || isWorkspaceUpdate(a) || a.toolName === 'orbit_browser_clear_logins') {
    return [];
  }
  if (a.toolName === 'Bash') {
    const cmd =
      a.input && typeof a.input === 'object'
        ? (a.input as { command?: unknown }).command
        : undefined;
    if ((a.input as { orbitScheduleCheckOnly?: boolean })?.orbitScheduleCheckOnly === true) {
      return typeof cmd === 'string' && cmd.trim() ? [{ toolName: 'Bash', ruleContent: cmd }] : [];
    }
    return typeof cmd === 'string' ? bashCommandRules(cmd) : [];
  }
  return [{ toolName: a.toolName }];
}

// The command prefixes (or tool name for non-Bash) behind a set of remember rules.
function ruleNames(rules: PermissionRule[]): string[] {
  return rules.map((r) =>
    r.toolName === 'Bash' && r.ruleContent ? r.ruleContent.replace(/:\*$/, '') : r.toolName,
  );
}

// The human-readable scope shown on the "remember" button, capped so a long compound
// line stays readable (the full list rides along in the button's title).
function rememberLabel(rules: PermissionRule[]): string {
  const names = ruleNames(rules);
  return names.length <= 4 ? names.join(', ') : `${names.slice(0, 4).join(', ')} +${names.length - 4}`;
}

type OnDecide = (
  id: string,
  behavior: 'allow' | 'deny',
  answers?: Record<string, string[]>,
  message?: string,
  rememberRules?: PermissionRule[],
  /** The single-task card's Create and start (`CREATE_AND_START`); every other press leaves it out. */
  startAfterCreate?: boolean,
  /** Settings › Translation's Send as written, after the decision was refused 422 TRANSLATION_FAILED. */
  sendAsWritten?: boolean,
) => unknown;

/** "Couldn't translate, so it wasn't sent · Retry · Send as written" under a card whose decision the
 *  server refused 422 TRANSLATION_FAILED, its first sentence saying why when the refusal did (frame 5):
 *  each press posts the held decision again. */
function UntranslatedFoot({ id, held, onDecide }: { id: string; held: HeldDecision; onDecide: OnDecide }) {
  const post = (sendAsWritten: boolean) => async () =>
    onDecide(id, held.behavior, held.answers, held.message, held.rememberRules, held.startAfterCreate, sendAsWritten || undefined);
  return (
    <div className="approval-untranslated-row">
      <UntranslatedDecisionFoot
        onRetry={post(false)}
        onSendAsWritten={post(true)}
        failureReason={held.failureReason}
        httpStatus={held.httpStatus}
      />
    </div>
  );
}

/** A question form's picks and typed answers seeded from a held decision's answers, so the card
 *  that comes back after a 422 TRANSLATION_FAILED still shows what the owner answered. */
function seededAnswers(questions: QItem[], held: HeldDecision | undefined) {
  const sel: Record<string, string[]> = {};
  const custom: Record<string, string> = {};
  if (!held?.answers) return { sel, custom };
  for (const qq of questions) {
    const q = qq.question ?? '';
    const given = held.answers[q];
    if (!given) continue;
    const labels = new Set((qq.options ?? []).map((o) => o?.label ?? ''));
    sel[q] = given.filter((a) => labels.has(a));
    const typed = given.filter((a) => !labels.has(a));
    if (typed.length) custom[q] = typed.join(', ');
  }
  return { sel, custom };
}

/** An inline card for a pending tool-permission request: an interactive multiple-choice
 *  form for AskUserQuestion, otherwise a plain allow/deny (with a rich render for plans). */
export function ApprovalPanel({
  approval,
  onDecide,
  active = false,
  answerable = true,
  onChatAbout,
  onDecline,
  rememberable = true,
  subagent = null,
  untranslated,
}: {
  approval: ApprovalInfo;
  /** For a card a SubAgent asked: its delegate call's description, '' when unknown. Drawn as a grey line above the
   *  card (docs/subagent-design.md §5.3). Null for a card the session asked itself. */
  subagent?: string | null;
  onDecide: OnDecide;
  /** The decision last pressed here, refused 422 TRANSLATION_FAILED (`useApprovalDecisions`). */
  untranslated?: HeldDecision;
  /** Whether this session's runtime honours remember rules (`approvalRememberOffered`). False
   *  drops "Always allow" and its shortcut: the card is Approve / Reject only. */
  rememberable?: boolean;
  active?: boolean;
  /** Whether an answer to this card can still reach anybody — see UNANSWERABLE_NOTE. */
  answerable?: boolean;
  onChatAbout?: (id: string, question: string, about: string) => void;
  /** Arm the composer to decline one of Orbit's own asks with the reason beside it; absent, the
   *  press falls back to denying where it stands. See `decliningPrefix`. */
  onDecline?: (id: string, toolName: string, subject: string) => void;
}): JSX.Element {
  const isQuestion = approval.toolName === 'AskUserQuestion';
  const narrow = useIsMobile();
  const [reviewOpen, setReviewOpen] = useState(false);
  // One flip for the whole card (board 04-owner-cards, mark A), never persisted.
  const cardTranslation = orbitCardTranslation(approval);
  const [cardOriginal, setCardOriginal] = useState(false);
  const cardShown = cardOriginal ? undefined : cardTranslation;
  const compact = isPlan(approval) || isProjectCreate(approval);
  // A dead card owns no hotkey and shows no shortcut hint: the caller already skips it when
  // choosing the active card, and this holds even when something else calls it directly.
  const armed = active && answerable && (!narrow || !compact || reviewOpen);
  // "Always allow" — the running session stops asking (claude's engine matches future calls),
  // and the rule is kept on this session's workspace so its other sessions start with it too.
  // Empty for questions/plans and Bash commands with no clean prefix; a compound Bash line
  // yields one rule per distinct sub-command.
  const rules = isQuestion || !rememberable ? [] : rememberRulesFor(approval);
  // One claim for the card, so that the two triggers below are one card asking rather than two.
  // The keys are the card's only while it is the highest card asking: a question card above it on
  // the screen holds them first, and this one holds them over every card below it (`CardHotkey.ts`)
  // — the hint goes with the keys, because it and the keys are one fact.
  const anchor = useRef<HTMLDivElement>(null);
  const keys = useCardKeyClaim(armed && !isQuestion, anchor);
  // Plain card: Enter approves; ⌘/Ctrl + Enter always-allows (only when that option exists).
  // Questions have no submit hotkey — they submit only via the Submit button.
  // Where Create and start leads, Enter presses it: the hint and the key go with the filled button.
  const startLeads = createAndStartLeads(approval);
  const startAfterCreate = () => onDecide(approval.id, 'allow', undefined, undefined, undefined, true);
  useApproveHotkey(keys, () => (startLeads ? startAfterCreate() : onDecide(approval.id, 'allow')), {
    requireMod: false,
    anchor,
  });
  useApproveHotkey(keys && rules.length > 0, () => {
    if (rules.length) onDecide(approval.id, 'allow', undefined, undefined, rules);
  }, { anchor });
  if (isQuestion) {
    // A form over options, whatever the options say. The completion decision is Orbit's own card
    // (`EvidenceDecisionCard.tsx`), drawn from the pending read; a question offering the same two
    // answers is still only a question.
    return (
      <QuestionForm
        approval={approval}
        onDecide={onDecide}
        answerable={answerable}
        onChatAbout={onChatAbout}
        untranslated={untranslated}
      />
    );
  }
  // Settings › Translation (3A): the plan and a tool card's description as the owner reads them.
  const shown = approval.translation && !approval.translation.failed ? approval.translation : undefined;
  const plan = isPlan(approval) ? (shown?.plan || planText(approval.input)) : '';
  const translatedDescription = shown?.description;
  const dag = isDagChange(approval) ? dagInput(approval.input, cardShown) : null;
  const batch = isBatch(approval) ? batchPreview(approval.input, cardShown) : null;
  const create = createInput(approval, cardShown);
  const blocker = blockerResolveInput(approval, cardShown);
  const skipCheck = skipMergeCheckInput(approval);
  const mergeCheck = mergeCheckChangeInput(approval);
  const deleting = deleteInput(approval, Date.now());
  const writing = workspaceWriteInput(approval);
  const provider = providerWriteInput(approval);
  // What the composer's bar would name as the thing not being done: the proposal's own subject, and
  // never the tool's name, which says nothing about what is not being created. Null for everything
  // that is not one of Orbit's own asks — a plan, a tool call — which keeps its one-press Reject.
  const declineSubject: string | null = dag
    ? (dag.preview.listTitle ?? 'this list')
    : batch
      ? `${batch.taskCount ?? 0} new task${batch.taskCount === 1 ? '' : 's'}`
      : create
        // The agent reads this: the title as it wrote it, whichever language the card is in.
        ? (createInput(approval)?.title ?? create.title)
        : blocker
          ? (blocker.subjectTitle || blocker.kind || 'this blocker')
          : skipCheck
            ? (skipCheck.taskTitle || 'this landing')
          : mergeCheck
            ? `${mergeCheck.projectTitle || 'this project'}'s merge check`
          : deleting
            ? (deleting.name || `this ${deleting.noun}`)
          : writing
            ? (writing.name || 'this workspace')
            : null;
  // A plain tool call: none of the shapes above, so the card reads the call itself (ToolCallBody).
  const plainCall = !isPlan(approval) && !dag && !batch && !create && !blocker && !skipCheck && !mergeCheck
    && !deleting && !writing && !provider;
  const heading = isPlan(approval)
          ? '📋 Confirm: exit plan mode and proceed with this plan?'
          : dag
            ? `🔗 Confirm: restructure dependencies in ${dag.preview.listTitle ?? 'this list'}?`
            : batch
              ? `🧩 Confirm: create ${batch.taskCount ?? 0} task${batch.taskCount === 1 ? '' : 's'}?`
              : create
                ? create.isProject
                  ? `📁 Confirm: create project “${create.title}”?`
                  // A task's own name is the card's first row, where it can wrap to as many lines
                  // as it needs; the header carries the count, exactly as the batch card's does.
                  : startWhenOf(create)
                    ? CONDITION_COPY.createTaskHeading
                    : '📝 Confirm: create 1 task?'
                : blocker
                  ? `🚧 Confirm: this no longer blocks ${blocker.projectTitle || 'the project'}?`
                  : skipCheck
                    ? `⏭ Confirm: land ${skipCheck.taskTitle || 'this task'} without the merge check?`
                    : mergeCheck
                      ? LANDING_CHECK_COPY.CONFIRM_TITLE
                      : deleting
                        ? `🗑 Confirm: delete ${deleting.noun} “${deleting.name || `this ${deleting.noun}`}”?`
                        : writing
                          ? `⚙️ Confirm: ${writing.creating ? 'create' : 'change'} workspace “${writing.name || 'this workspace'}”?`
                          : provider
                            ? `🔌 Confirm: ${provider.verb} provider${provider.name ? ` “${provider.name}”` : ''}?`
                            : toolCallHeading(approval.toolName, approval.input);
  const createAndStartButton = (tone: 'primary' | 'accent') => (
    <CardActionButton
      tone={tone}
      disabled={!answerable}
      title="Create the task and start its run now, so you are not asked again to start it."
      onClick={startAfterCreate}
    >
      {CREATE_AND_START}
      {keys && tone === 'primary' && <span className="approval-kbd">{ENTER_HINT}</span>}
    </CardActionButton>
  );
  return (
    <ReviewCard enabled={compact} title={heading}
      summary={plainCall ? toolCallSummary(approval.toolName, approval.input) : markdownToPlainLines(plan || create?.prose || '')}
      meta={!answerable ? 'No longer waiting for an answer' : undefined}
      open={reviewOpen} onOpenChange={setReviewOpen}>
    <div ref={anchor} className="approval-card">
      {subagent !== null && (
        <div className="approval-subagent">{subagent ? `Agent · ${subagent}` : 'Agent'}</div>
      )}
      <div className="approval-head">
        {heading}
        {plainCall && approval.toolName && <span className="approval-tool-chip">{approval.toolName}</span>}
      </div>
      {/* A create is read top to bottom like a plan, so it grows instead of scrolling. */}
      <div className={`approval-body${plan || create || blocker || skipCheck || mergeCheck || deleting || writing || provider || plainCall ? ' is-plan' : ''}`}>
        {plan ? (
          <Markdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeCodeWords]}
            urlTransform={referenceUrlTransform}
            components={{ a: ReferenceLink }}
          >
            {plan}
          </Markdown>
        ) : dag ? (
          <DagChangeBody note={dag.note} preview={dag.preview} />
        ) : batch ? (
          <BatchCreateBody preview={batch} />
        ) : create ? (
          <CreateBody input={create} />
        ) : blocker ? (
          <BlockerResolveBody input={blocker} />
        ) : skipCheck ? (
          <SkipMergeCheckBody input={skipCheck} />
        ) : mergeCheck ? (
          <MergeCheckChangeBody input={mergeCheck} />
        ) : deleting ? (
          <DeleteBody input={deleting} />
        ) : writing ? (
          <WorkspaceWriteBody input={writing} />
        ) : provider ? (
          <ProviderWriteBody input={provider} />
        ) : (
          <ToolCallBody toolName={approval.toolName} input={approval.input} translatedDescription={translatedDescription} />
        )}
        {cardTranslation && (
          <CardTranslationFoot flipped={cardOriginal} onFlip={() => setCardOriginal((v) => !v)} />
        )}
      </div>
      {!answerable && <UnanswerableNote />}
      {untranslated && answerable && <UntranslatedFoot id={approval.id} held={untranslated} onDecide={onDecide} />}
      <CardActions className="approval-actions">
        {startLeads && createAndStartButton('primary')}
        <CardActionButton
          tone={startLeads ? 'accent' : 'primary'}
          disabled={!answerable}
          onClick={() => onDecide(approval.id, 'allow')}
        >
          {isPlan(approval)
            ? 'Approve & run'
            : dag
              ? 'Apply changes'
              : batch
                ? // The count, not "them": the question above it scrolls away on a long batch. The
                  // native card says the same (`Approvals.batchCreateAction`).
                  `Create ${batch.taskCount ?? 0} task${batch.taskCount === 1 ? '' : 's'}`
                : create
                  ? 'Create it'
                  : blocker
                    ? 'Resolve it'
                    : skipCheck
                      ? 'Land it without the check'
                      : mergeCheck
                        ? LANDING_CHECK_COPY.CONFIRM_ACTION
                        : deleting
                          ? 'Delete it'
                          : writing
                            ? (writing.creating ? 'Create it' : 'Save changes')
                            : provider
                              ? PROVIDER_ACTIONS[provider.verb]
                              : 'Approve'}
          {keys && !startLeads && <span className="approval-kbd">{ENTER_HINT}</span>}
        </CardActionButton>
        {/* On a held task Create and start is still offered, but second: Create it keeps Enter. */}
        {offersCreateAndStart(approval) && !startLeads && createAndStartButton('accent')}
        {rules.length > 0 && (
          <CardActionButton
            tone="accent"
            disabled={!answerable}
            title={`Stop asking about calls like this — here and in this workspace's other sessions: ${ruleNames(rules).join(', ')}. Revocable in the workspace's settings.`}
            onClick={() => onDecide(approval.id, 'allow', undefined, undefined, rules)}
          >
            Always allow <code className="approval-rule">{rememberLabel(rules)}</code>
            {keys && <span className="approval-kbd">{SHORTCUT_HINT}</span>}
          </CardActionButton>
        )}
        <CardActionButton
          tone="secondary"
          disabled={!answerable}
          onClick={() => {
            // One of Orbit's own proposals: the press is "not this, and here is what instead",
            // so it arms the composer and the refusal rides back with the next send. Everything
            // else — a plan, a tool call — is denied where it stands.
            if (declineSubject !== null && onDecline) {
              setReviewOpen(false);
              onDecline(approval.id, approval.toolName ?? '', declineSubject);
            } else {
              onDecide(approval.id, 'deny');
            }
          }}
        >
          {/* Orbit's own asks say what the question card says, because the press does what the
              question card's press does. A plan and a plain tool call keep their own words: both
              are refused where they stand, with nothing to discuss. */}
          {isPlan(approval) ? 'Keep planning' : declineSubject !== null ? '💬 Chat about this' : 'Reject'}
        </CardActionButton>
      </CardActions>
    </div>
    </ReviewCard>
  );
}

/**
 * What is being ended, and what the agent says has changed.
 *
 * Two sentences, in the order the decision is made in: what this blocker asked a person to do, then
 * the argument that it is no longer needed. The agent's reason is second and marked as the agent's,
 * because it is a claim being judged rather than a fact being reported — and it is the text that
 * stays on the row afterwards as the resolution note.
 */
function BlockerResolveBody({ input }: { input: BlockerResolveInput }): JSX.Element {
  // What this wait is about, in one line: the task when it is about one, and otherwise the kind —
  // a blocker about a provider or the project itself has no task to name, and a card that then
  // said nothing at all above the sentence would read as though it came from nowhere.
  const about = input.subjectTitle ? `About ${input.subjectTitle}` : input.kind;
  return (
    <div className="dag-approval">
      {about && <p className="dag-approval-caption">{about}</p>}
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeCodeWords]}
        urlTransform={referenceUrlTransform}
        components={{ a: ReferenceLink }}
      >
        {input.requiredAction}
      </Markdown>
      <p className="dag-approval-caption">The agent says it no longer blocks</p>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeCodeWords]}
        urlTransform={referenceUrlTransform}
        components={{ a: ReferenceLink }}
      >
        {input.reason}
      </Markdown>
    </div>
  );
}

/**
 * What is being skipped, and what the coordinator says is the matter with it.
 *
 * Three sentences in the order the decision is made in: what this is about (the landing, named by the
 * task it delivers), the command that would not run — verbatim, on its own line, because the whole
 * question is whether THAT command should hold up THAT landing — and then the agent's claim that the
 * red is the check's rather than the work's, marked as the agent's for the same reason the blocker
 * card marks its own. The command is shown and not run: nothing here proves it would fail.
 *
 * Its neighbour below is the other half of that question — changing the command rather than going
 * past it — and the two cards are deliberately separate: an owner who lets this landing through has
 * not agreed to run something else next time.
 */
function SkipMergeCheckBody({ input }: { input: SkipMergeCheckInput }): JSX.Element {
  return (
    <div className="dag-approval">
      {input.projectTitle && <p className="dag-approval-caption">In {input.projectTitle}</p>}
      <p className="dag-approval-caption">This landing runs without the merge check</p>
      <pre className="approval-input">{input.checkCommand}</pre>
      {input.failure && <p className="dag-approval-foot">{input.failure}</p>}
      <p className="dag-approval-caption">The agent says this red is the check&rsquo;s, not the work&rsquo;s</p>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeCodeWords]}
        urlTransform={referenceUrlTransform}
        components={{ a: ReferenceLink }}
      >
        {input.reason}
      </Markdown>
      <p className="create-criteria-note">
        Once, and only this landing: the project&rsquo;s check command is unchanged, and the next
        landing and every merge into {input.mainBranch} are checked as before.
      </p>
    </div>
  );
}

/**
 * What goes, in the server's words: where it stands, then — for a runner — every workspace deleted
 * with it, by name, since those are what the owner may not have had in mind. Then what deleting
 * means, in the words the runner page's own Delete uses.
 */
function DeleteBody({ input }: { input: DeleteInput }): JSX.Element {
  return (
    <div className="dag-approval">
      <p className="dag-approval-note">{input.status}</p>
      {input.workDir && <pre className="approval-input">{input.workDir}</pre>}
      {input.noun === 'runner' && (input.workspaces.length > 0 ? (
        <>
          <p className="dag-approval-caption">Deleted with it</p>
          <ul className="dag-approval-ops">
            {input.workspaces.map((w, i) => (
              <li key={i} className="dag-op dag-op--remove">
                <span className="dag-op-verb">−</span>
                <span className="dag-op-text">{w.name}</span>
                {w.workDir && <span className="dag-op-noop">{w.workDir}</span>}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="dag-approval-foot">No workspaces are bound to it.</p>
      ))}
      <p className="create-criteria-note">
        {input.noun === 'runner'
          ? 'This removes the runner and its workspaces from your account. Re-register the machine to add it back.'
          : 'The workspace leaves your list but is not erased — its sessions and tasks are kept and stay linked to it.'}
      </p>
    </div>
  );
}

/**
 * What a workspace write does, in the server's words: which workspace and where it stands, each
 * variable by name and value, what a write of the variables takes away, then the rest of what changes.
 * A value is on its own line in full: a value cut short would be a yes to something nobody read.
 */
function WorkspaceWriteBody({ input }: { input: WorkspaceWriteInput }): JSX.Element {
  return (
    <div className="dag-approval">
      <p className="dag-approval-note">{input.status}</p>
      {input.workDir && <pre className="approval-input">{input.workDir}</pre>}
      {input.env && (
        <>
          <p className="dag-approval-caption">Environment variables</p>
          {input.env.length > 0
            ? input.env.map(({ name, value }) => (
                <pre key={name} className="approval-input">{`${name}=${value}`}</pre>
              ))
            : <p className="dag-approval-foot">No variables</p>}
        </>
      )}
      {input.envRemoved.length > 0 && (
        <>
          <p className="dag-approval-caption">Variables removed</p>
          <pre className="approval-input">{input.envRemoved.join('\n')}</pre>
        </>
      )}
      {input.fields.map(({ caption, value }) => (
        <Command key={caption} label={caption} command={value} />
      ))}
      <p className="create-criteria-note">{WORKSPACE_WRITE_NOTE}</p>
    </div>
  );
}

/**
 * What the merge check is now, and what it would become.
 *
 * Two commands and nothing else, because their difference IS the decision: everything else about
 * this project's integration line — which branch the work lands on — is not being asked about and
 * could not be given away here. The current value comes from the project read rather than from the
 * agent's recollection of it, which is the thing a person is here to check.
 *
 * A check that is being REMOVED says so in words: an empty line on the right reads as a loading
 * state, not as "no check at all".
 */
function MergeCheckChangeBody({ input }: { input: MergeCheckChangeInput }): JSX.Element {
  const raw = input.snapshot;
  const command = (value: unknown): string | null => typeof value === 'string' ? value : null;
  const seconds = (value: unknown): number | null => typeof value === 'number' ? value : null;
  const value = (key: string, after: boolean): unknown =>
    after && Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : raw[`current${key[0].toUpperCase()}${key.slice(1)}`];
  return (
    <div className="dag-approval">
      {input.projectTitle && <p className="dag-approval-note">{input.projectTitle}</p>}
      <div className="landing-check-confirmation">
        {(['landing', 'merge'] as const).map((layer) => (
          <section key={layer}>
            <h4>{layer === 'landing' ? LANDING_CHECK_COPY.LABEL : 'Merge check'}</h4>
            <p className="dag-approval-caption">{layer === 'landing' ? LANDING_CHECK_COPY.HINT : 'Runs before merging into main.'}</p>
            {[false, true].map((after) => {
              const check = command(value(`${layer}CheckCommand`, after));
              const timeout = seconds(value(`${layer}CheckTimeoutSeconds`, after));
              return <div key={String(after)}>
                <Command label={after ? 'after' : 'now'} command={check ?? (layer === 'landing'
                  ? inheritedLandingCommand(command(value('mergeCheckCommand', after))) : 'no check configured')} />
                <p className="dag-approval-caption">{LANDING_CHECK_COPY.TIMEOUT}: {timeout === null
                  ? layer === 'landing' ? inheritedLandingTimeout(seconds(value('mergeCheckTimeoutSeconds', after))) : '3600 seconds'
                  : `${timeout} seconds`}</p>
              </div>;
            })}
          </section>
        ))}
      </div>
      <p className="dag-approval-caption">{LANDING_CHECK_COPY.APPLIES}</p>
    </div>
  );
}

/** The yes on a provider write's card. The native card says the same (`ProviderWritePreview.action`). */
export const PROVIDER_ACTIONS: Record<ProviderWriteInput['verb'], string> = {
  add: 'Add it',
  change: 'Save changes',
  delete: 'Delete it',
};
export const PROVIDER_CHANGE_NOTE = 'Only the fields shown change. Everything else stays as it is.';
export const PROVIDER_DELETE_NOTE = 'The provider and its key are removed from your account.';
export const PROVIDER_MODELS_REPLACE = 'Models · replaces the current list';

/** A provider as it would be written: the fields by name, then the model list one model a row. */
function ProviderWriteBody({ input }: { input: ProviderWriteInput }): JSX.Element {
  return (
    <div className="dag-approval">
      {input.fields.length > 0 && (
        <dl className="provider-write-fields">
          {input.fields.map(({ caption, value, mono }) => (
            <div key={caption}>
              <dt>{caption}</dt>
              <dd>{mono ? <code>{value}</code> : value}</dd>
            </div>
          ))}
        </dl>
      )}
      {input.models && (
        <>
          <p className="dag-approval-caption">
            {input.verb === 'change' ? PROVIDER_MODELS_REPLACE : 'Models'}
          </p>
          <ul className="dag-approval-changes provider-write-models">
            {input.models.map((m) => (
              <li key={m.value}>
                <span>
                  <code>{m.value}</code>
                  {m.isDefault && <span className="provider-write-default">default</span>}
                </span>
                <span className="provider-write-model">{[m.label, m.context].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {input.verb === 'change' && <p className="dag-approval-foot">{PROVIDER_CHANGE_NOTE}</p>}
      {input.verb === 'delete' && <p className="dag-approval-note">{PROVIDER_DELETE_NOTE}</p>}
    </div>
  );
}

/** One command on the card: the label above it, the command as it would be run below. */
function Command({ label, command }: { label: string; command: string }): JSX.Element {
  return (
    <>
      <p className="dag-approval-caption">{label}</p>
      <pre className="approval-input">{command}</pre>
    </>
  );
}

/** What a single create would write. The batch card's skeleton, one size down: the consequence
 *  first, then where it lands and the name — and the two fields that used to be the whole card,
 *  folded. */
function CreateBody({ input }: { input: CreateInput }): JSX.Element {
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const noun = createFoldNoun(input);
  const detail = createDetail(input);
  const startWhen = startWhenOf(input);
  // A task's criteria is one prose block written as a prompt for the agent that will run it — the
  // field that turns into a wall. Its marks taken off, its lines kept, and folded at the ceiling the
  // owner-confirmation card folds a run's report at, which is the same kind of field read by the
  // same person. A project's criteria are a declared list of assertions, and the list is what
  // makes them readable.
  const said = markdownToPlainLines(input.criteria);
  const long = said.length > REPORT_CLAMP;
  return (
    <div className="dag-approval">
      <ImpactPills preview={input.preview} withZeroStarting={false} />
      {detail && <p className="dag-approval-foot">{detail}</p>}
      {!input.isProject && input.title && <p className="create-title">{input.title}</p>}
      {startWhen && <StartWhenFacts lines={startWhen} />}
      {input.prose && (
        <details
          className="create-fold"
          open={descriptionOpen}
          onToggle={(e) => setDescriptionOpen((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary>
            {descriptionOpen
              ? createFoldHideLabel(noun)
              : createFoldLabel(noun, input.prose.length)}
          </summary>
          <Markdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeCodeWords]}
            urlTransform={referenceUrlTransform}
            components={{ a: ReferenceLink }}
          >
            {input.prose}
          </Markdown>
        </details>
      )}
      {input.criteria && (
        <>
          <p className="dag-approval-caption">{CREATE_DONE_WHEN}</p>
          {input.isProject ? (
            <>
              <Markdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeCodeWords]}
                urlTransform={referenceUrlTransform}
                components={{ a: ReferenceLink }}
              >
                {input.criteria}
              </Markdown>
              <p className="create-criteria-note">{CREATE_CRITERIA_CONFIRMED_AT_START}</p>
            </>
          ) : (
            <>
              <p className="dag-approval-criteria">
                {long && !criteriaOpen ? `${said.slice(0, REPORT_CLAMP).trimEnd()}…` : said}
              </p>
              {long && (
                <button
                  type="button"
                  className="decision-ask-toggle"
                  aria-expanded={criteriaOpen}
                  onClick={() => setCriteriaOpen(!criteriaOpen)}
                >
                  {criteriaOpen ? OWNER_CONFIRMATION_SHOW_LESS : OWNER_CONFIRMATION_SHOW_ALL}
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The consequence lines a card leads with, in the order a person decides in. The batch card has led
 * with these since it was written; a single create reads the same lines, because one task is a batch
 * of one and the two cards saying the same kind of thing first is what makes one family of them.
 *
 * `withZeroStarting` is the one place the two differ: a batch states its running count even when it
 * is zero — the card is about counts, and "0" is an answer — where a single task that starts nothing
 * says nothing, since the pill it would get ("0 start running within the minute") reads as "nothing
 * will happen" on a card where the other lines are not there to qualify it.
 */
function impactLines(
  preview: BatchPreview,
  { withZeroStarting }: { withZeroStarting: boolean },
): Array<{ tone: '' | 'run' | 'block'; text: string }> {
  const starting = preview.startingNow ?? 0;
  const blocked = preview.blocked ?? 0;
  const manual = preview.needsManualStart ?? 0;
  const inert = preview.notDispatchable ?? 0;
  const lines: Array<{ tone: '' | 'run' | 'block'; text: string }> = [];
  if (starting > 0 || withZeroStarting) {
    lines.push({
      tone: starting > 0 ? 'run' : '',
      text: `${starting} start${starting === 1 ? 's' : ''} running within the minute`,
    });
  }
  if (blocked > 0) {
    lines.push({ tone: '', text: `${blocked} wait${blocked === 1 ? 's' : ''} on a prerequisite` });
  }
  if (manual > 0) {
    // Every root of a fresh DAG. Auto-run starts a task when a prerequisite finishes, so one
    // with no prerequisites is never picked up however unblocked it looks — saying "will
    // start" here is what this card got wrong before it was ever used.
    lines.push({
      tone: '',
      text: `${manual} need${manual === 1 ? 's' : ''} a manual start — nothing will trigger ${manual === 1 ? 'it' : 'them'}`,
    });
  }
  if (inert > 0) {
    // Not the same as blocked: nothing finishing will release these. They sit until a person
    // assigns them, so a batch that is silently all of these did nothing at all.
    lines.push({
      tone: 'block',
      text: `${inert} cannot run — unassigned, no runner, auto-run off, or the list is paused`,
    });
  }
  return lines;
}

/** Those lines as the card draws them: tinted, at the top, before anything else. */
function ImpactPills({ preview, withZeroStarting }: {
  preview: BatchPreview | null;
  withZeroStarting: boolean;
}): JSX.Element | null {
  if (!preview) return null;
  const lines = impactLines(preview, { withZeroStarting });
  if (lines.length === 0) return null;
  return (
    <div className="dag-approval-impact">
      {lines.map((l, i) => (
        <span key={i} className={`dag-impact${l.tone ? ` dag-impact--${l.tone}` : ''}`}>
          {l.text}
        </span>
      ))}
    </div>
  );
}

/**
 * What a batch would create, led by how much of it starts running.
 *
 * The titles are the least useful part and the most eye-catching, so they come last and only a
 * window of them. The decision is the counts: fifty tasks of which forty-eight wait on each other
 * costs two runs, and fifty independent ones costs fifty.
 */
function BatchCreateBody({ preview }: { preview: BatchPreview }): JSX.Element {
  const edges = (preview.internalEdges ?? 0) + (preview.externalEdges ?? 0);
  const tasks = preview.tasks ?? [];
  // Described from the window the card draws, not the whole batch — so the sentence says what the
  // picture shows, and the "+N more" below says what it does not.
  const graph = buildBatchGraph(tasks);
  const shape = describeShape(graph);
  return (
    <div className="dag-approval">
      <ImpactPills preview={preview} withZeroStarting />
      {(preview.lists?.length ?? 0) > 0 && (
        <p className="dag-approval-foot">
          into {preview.lists!.map((l) => l.title).join(', ')}
          {edges > 0 && ` · ${edges} dependency edge${edges === 1 ? '' : 's'}`}
        </p>
      )}
      <p className="dag-approval-caption">
        Tasks{shape ? ` — ${shape}` : ''}
      </p>
      {/* The picture — the project page's own canvas, drawn top to bottom on a card — or, when
          there is no shape to draw or none that fits this width, the titles. A chain of ten and ten
          unrelated tasks produce the same list and behave completely differently, and that is
          exactly what a picture shows and a list cannot. */}
      <BatchGraph
        tasks={tasks}
        fallback={
          <ul className="dag-approval-ops">
            {tasks.map((t, i) => (
              <li key={i} className="dag-op">
                <span className="dag-op-verb">+</span>
                <span className="dag-op-text">{t.title}</span>
                {((t.dependsOnRefs?.length ?? 0) + (t.dependsOnTaskIds?.length ?? 0)) > 0 && (
                  <span className="dag-op-noop">
                    waits on {(t.dependsOnRefs?.length ?? 0) + (t.dependsOnTaskIds?.length ?? 0)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        }
      />
      {(preview.titlesTruncated ?? 0) > 0 && (
        <p className="dag-approval-foot">+{preview.titlesTruncated} more</p>
      )}
    </div>
  );
}

/**
 * What a dependency restructure would do, in the order a person decides in.
 *
 * The consequence leads, because it is the part that is not visible in the ops. A batch reading
 * "remove 4 edges" is unremarkable until you know it releases 40 tasks, and the sweep collects
 * those within the minute — the edges are what is written, the released tasks are what happens.
 */
function DagChangeBody({ note, preview }: { note: string; preview: DagPreview }): JSX.Element {
  const runnable = preview.becomingRunnable ?? 0;
  const manual = preview.becomingManual ?? 0;
  const blocked = preview.becomingBlocked ?? 0;
  const ops = preview.ops ?? [];
  return (
    <div className="dag-approval">
      {note && <p className="dag-approval-note">{note}</p>}
      <div className="dag-approval-impact">
        {runnable > 0 && (
          <span className="dag-impact dag-impact--run">
            {runnable} task{runnable === 1 ? '' : 's'} become runnable — these start on the next sweep
          </span>
        )}
        {blocked > 0 && (
          <span className="dag-impact dag-impact--block">
            {blocked} task{blocked === 1 ? ' stops' : 's stop'} being runnable
          </span>
        )}
        {manual > 0 && (
          // Freed from waiting and still not going anywhere: losing your last prerequisite means
          // nothing is left to trigger you.
          <span className="dag-impact">
            {manual} stop{manual === 1 ? 's' : ''} waiting, but now need{manual === 1 ? 's' : ''} a manual start
          </span>
        )}
        {runnable === 0 && blocked === 0 && manual === 0 && (
          <span className="dag-impact">No task changes state — this only rewrites edges</span>
        )}
      </div>
      {ops.length > 0 && <p className="dag-approval-caption">Edges written</p>}
      <ul className="dag-approval-ops">
        {ops.map((o, i) => (
          <li key={i} className={`dag-op dag-op--${o.op}${o.noop ? ' is-noop' : ''}`}>
            <span className="dag-op-verb">{o.op === 'add' ? '+' : '−'}</span>
            <span className="dag-op-text">
              {o.taskTitle} {o.op === 'add' ? 'waits on' : 'no longer waits on'} {o.dependsOnTitle}
            </span>
            {o.noop && <span className="dag-op-noop">already so</span>}
          </li>
        ))}
      </ul>
      {(preview.changes?.length ?? 0) > 0 && (
        <>
        <p className="dag-approval-caption">Tasks that change state as a result</p>
        <ul className="dag-approval-changes">
          {preview.changes!.map((c) => (
            <li key={c.taskId}>
              <span className="dag-change-title">{c.title ?? c.taskId}</span>
              <span className="dag-change-move">
                {c.from} → {c.to}
              </span>
            </li>
          ))}
        </ul>
        </>
      )}
      <p className="dag-approval-foot">
        {preview.edgesBefore} → {preview.edgesAfter} edges
      </p>
    </div>
  );
}

type QOption = { label?: string; description?: string };
type QItem = { question?: string; header?: string; options?: QOption[]; multiSelect?: boolean };

function questionsOf(input: unknown): QItem[] {
  if (input && typeof input === 'object' && Array.isArray((input as { questions?: unknown }).questions)) {
    return (input as { questions: QItem[] }).questions;
  }
  return [];
}

/** What a chat reply to a question card answers, for ✦ Optimize (`replyingTo`): each question as the
 *  card shows it, with its options. */
export function questionReplyContext(questions: QItem[]): string {
  return questions
    .map((q) => {
      const title = [q.header, q.question].filter(Boolean).join(': ');
      const options = (q.options ?? [])
        .filter((o) => o.label)
        .map((o) => `- ${o.label}${o.description ? `: ${o.description}` : ''}`);
      return [title + (q.multiSelect ? ' (pick any)' : ''), ...options].join('\n');
    })
    .join('\n\n');
}

/** AskUserQuestion: pick option(s) per question and submit, like Claude's TUI. The picks
 *  ride back to claude as `answers` (question text → labels) on an `allow`. */
function QuestionForm({
  approval,
  onDecide,
  answerable,
  onChatAbout,
  untranslated,
}: {
  approval: ApprovalInfo;
  onDecide: OnDecide;
  answerable: boolean;
  onChatAbout?: (id: string, question: string, about: string) => void;
  untranslated?: HeldDecision;
}): JSX.Element {
  const [reviewOpen, setReviewOpen] = useState(false);
  // Shown in the owner's language once the server has translated the card (Settings › Translation, 3A).
  // Answers are keyed by what is shown; the server maps them back to the English the engine asked in.
  const questions = shownQuestions(questionsOf(approval.input), approval.translation);
  // A card back after its answer could not be translated starts from that answer (1A).
  const [seed] = useState(() => seededAnswers(questions, untranslated));
  const [sel, setSel] = useState<Record<string, string[]>>(seed.sel);
  // Free-text answers, keyed by question text — claude's AskUserQuestion always lets
  // the user type their own answer instead of picking a listed option.
  const [custom, setCustom] = useState<Record<string, string>>(seed.custom);
  // "Chat about this": rather than picking an option, the user replies conversationally
  // in the main composer (handled by WorkspaceView via onChatAbout). The reply still rides back
  // as a `deny` message so claude reads it as in-turn feedback instead of a forced option.
  const chatLabel = questions[0]?.header || questions[0]?.question || '';

  const toggle = (q: string, label: string, multi: boolean) => {
    setSel((prev) => {
      const cur = prev[q] ?? [];
      if (multi) {
        return { ...prev, [q]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      }
      return { ...prev, [q]: cur.includes(label) ? [] : [label] };
    });
    // Single-select: a listed option and free text are mutually exclusive.
    if (!multi) setCustom((prev) => (prev[q] ? { ...prev, [q]: '' } : prev));
  };

  const onCustom = (q: string, value: string, multi: boolean) => {
    setCustom((prev) => ({ ...prev, [q]: value }));
    // Single-select: typing a custom answer clears any picked option.
    if (!multi && value.trim()) setSel((prev) => (prev[q]?.length ? { ...prev, [q]: [] } : prev));
  };

  // A question is answered once it has a picked option or non-empty typed text.
  const answered = (qq: QItem): boolean => {
    const q = qq.question ?? '';
    return (sel[q]?.length ?? 0) > 0 || (custom[q]?.trim().length ?? 0) > 0;
  };
  const complete = questions.length > 0 && questions.every(answered);

  const submit = () => {
    if (!complete) return;
    const answers: Record<string, string[]> = {};
    for (const qq of questions) {
      const q = qq.question ?? '';
      const picks = [...(sel[q] ?? [])];
      const typed = custom[q]?.trim();
      if (typed) picks.push(typed);
      if (q && picks.length) answers[q] = picks;
    }
    onDecide(approval.id, 'allow', answers);
  };

  return (
    <ReviewCard title="Claude has a question for you"
      summary={questions.map((question) => question.question ?? '').join(' · ')}
      meta={!answerable ? 'No longer waiting for an answer' : `${questions.length} question${questions.length === 1 ? '' : 's'}`}
      open={reviewOpen} onOpenChange={setReviewOpen}>
    <div className="approval-card">
      <div className="approval-head">❓ Claude has a question for you</div>
      <div className="approval-body is-questions">
        <div className="chat-questions">
          {questions.map((qq, k) => {
            const q = qq.question ?? '';
            const multi = !!qq.multiSelect;
            const picked = sel[q] ?? [];
            return (
              <div className="chat-q" key={k}>
                {qq.header && <div className="chat-q-header">{qq.header}</div>}
                {q && <div className="chat-q-text">{q}</div>}
                <div className="chat-q-opts">
                  {(qq.options ?? []).map((o, j) => {
                    const label = o?.label ?? '';
                    const on = picked.includes(label);
                    return (
                      <button
                        type="button"
                        className={`chat-q-opt chat-q-opt-btn${on ? ' is-picked' : ''}`}
                        key={j}
                        disabled={!answerable}
                        onClick={() => toggle(q, label, multi)}
                      >
                        <span className="chat-q-opt-label">{label}</span>
                        {o?.description && <span className="chat-q-opt-desc">{o.description}</span>}
                      </button>
                    );
                  })}
                </div>
                <input
                  type="text"
                  className="chat-q-custom"
                  placeholder="Or type your own answer…"
                  value={custom[q] ?? ''}
                  disabled={!answerable}
                  onChange={(e) => onCustom(q, e.target.value, multi)}
                />
                {multi && <div className="chat-q-multi">Multiple choice</div>}
              </div>
            );
          })}
        </div>
      </div>
      {!answerable && <UnanswerableNote />}
      {untranslated && answerable && <UntranslatedFoot id={approval.id} held={untranslated} onDecide={onDecide} />}
      <CardActions className="approval-actions">
        {/* Unanswered questions cannot be submitted, so the control that would submit them is not
            pressable — the same rule the decision card's Confirm is under. */}
        <CardActionButton tone="primary" disabled={!answerable || !complete} onClick={submit}>
          Submit
        </CardActionButton>
        {/* Chatting about it is not a way around a dead card: the reply rides back as a `deny` on
            this same approval, through the same poll loop that is no longer there to read it. */}
        <CardActionButton
          tone="outline"
          disabled={!answerable}
          onClick={() => { setReviewOpen(false); onChatAbout?.(approval.id, chatLabel, questionReplyContext(questions)); }}
        >
          💬 Chat about this
        </CardActionButton>
      </CardActions>
    </div>
    </ReviewCard>
  );
}
