import { useRef, useState, type JSX } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ApprovalInfo, PermissionRule } from '../api';
import { BatchGraph } from './BatchGraph';
import { CardActionButton, CardActions } from './CardAction';
import { ReviewCard } from './ReviewCard';
import { useIsMobile } from '../lib/useMediaQuery';
import { ENTER_HINT, SHORTCUT_HINT, useApproveHotkey, useCardKeyClaim } from './CardHotkey';
import { buildBatchGraph, describeShape } from '../lib/batchGraph';
import { ReferenceLink, referenceUrlTransform } from '../lib/markdownLinks';
import { markdownToPlainLines } from '../lib/markdownText';
import { mainBranchName } from '../lib/projectStart';
import {
  OWNER_CONFIRMATION_SHOW_ALL,
  OWNER_CONFIRMATION_SHOW_LESS,
  REPORT_CLAMP,
} from './OwnerConfirmationCard';
import { bashCommandRules } from '@orbit/shared';

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
  tasks?: Array<{ title: string; dependsOnRefs?: string[]; dependsOnTaskIds?: string[]; ref?: string | null }>;
  titlesTruncated?: number;
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
  projectTitle: string;
  /** The check as the project stands, or null when it has none. */
  current: string | null;
  /** What it would become; null clears it. */
  next: string | null;
  /** The budget for the new check, in seconds, when the proposal named one. */
  timeout: number | null;
}

function mergeCheckChangeInput(a: ApprovalInfo): MergeCheckChangeInput | null {
  if (!isMergeCheckChange(a)) return null;
  const obj = (a.input ?? {}) as Record<string, unknown>;
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
  const timeout = obj.mergeCheckTimeoutSeconds;
  return {
    projectTitle: text(obj.projectTitle) ?? '',
    current: text(obj.currentMergeCheckCommand),
    next: text(obj.mergeCheckCommand),
    // Absent means the budget is left as it is, which is not the same as "no budget" — so a
    // proposal that named none shows no second line rather than a zero.
    timeout: typeof timeout === 'number' ? timeout : null,
  };
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

function blockerResolveInput(a: ApprovalInfo): BlockerResolveInput | null {
  if (!isBlockerResolve(a)) return null;
  const obj = (a.input ?? {}) as Record<string, unknown>;
  const blocker = (obj.blocker ?? {}) as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    projectTitle: text(obj.projectTitle),
    requiredAction: text(blocker.requiredAction),
    reason: text(obj.reason),
    kind: text(blocker.kind),
    subjectTitle: text(blocker.subjectTitle),
  };
}

function createInput(a: ApprovalInfo): CreateInput | null {
  const project = isProjectCreate(a);
  if (!project && !isTaskCreate(a)) return null;
  const obj = (a.input ?? {}) as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  const items = Array.isArray(obj.acceptanceCriteriaItems) ? obj.acceptanceCriteriaItems : [];
  return {
    isProject: project,
    title: text(obj.title),
    prose: text(project ? obj.goal : obj.description),
    criteria: project
      ? items
          .map((c) => text((c as { text?: unknown } | null)?.text))
          .filter(Boolean)
          .map((t) => `- ${t}`)
          .join('\n')
      : text(obj.acceptanceCriteria),
    // The same key the batch card reads, for the same reason: the counts are the decision and the
    // body is not. A project create has no dispatch to report, so it carries none.
    preview: project ? null : (obj.preview as BatchPreview | undefined) ?? null,
    criterion: text(obj.completionCriterion),
  };
}

function batchPreview(input: unknown): BatchPreview {
  const obj = (input ?? {}) as { preview?: BatchPreview };
  return obj.preview ?? {};
}

function dagInput(input: unknown): { preview: DagPreview; note: string } {
  const obj = (input ?? {}) as { preview?: DagPreview; note?: unknown };
  return {
    preview: obj.preview ?? {},
    note: typeof obj.note === 'string' ? obj.note : '',
  };
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
function rememberRulesFor(a: ApprovalInfo): PermissionRule[] {
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
  if (isTaskCreate(a) || isProjectCreate(a) || isBlockerResolve(a) || isProviderWrite(a)
    || isSkipMergeCheck(a) || isMergeCheckChange(a)) {
    return [];
  }
  if (a.toolName === 'Bash') {
    const cmd =
      a.input && typeof a.input === 'object'
        ? (a.input as { command?: unknown }).command
        : undefined;
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
) => void;

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
}: {
  approval: ApprovalInfo;
  onDecide: OnDecide;
  /** Whether this session's runtime honours remember rules (`approvalRememberOffered`). False
   *  drops "Always allow" and its shortcut: the card is Approve / Reject only. */
  rememberable?: boolean;
  active?: boolean;
  /** Whether an answer to this card can still reach anybody — see UNANSWERABLE_NOTE. */
  answerable?: boolean;
  onChatAbout?: (id: string, question: string) => void;
  /** Arm the composer to decline one of Orbit's own asks with the reason beside it; absent, the
   *  press falls back to denying where it stands. See `decliningPrefix`. */
  onDecline?: (id: string, toolName: string, subject: string) => void;
}): JSX.Element {
  const isQuestion = approval.toolName === 'AskUserQuestion';
  const narrow = useIsMobile();
  const [reviewOpen, setReviewOpen] = useState(false);
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
  useApproveHotkey(keys, () => onDecide(approval.id, 'allow'), { requireMod: false, anchor });
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
      />
    );
  }
  const plan = isPlan(approval) ? planText(approval.input) : '';
  const dag = isDagChange(approval) ? dagInput(approval.input) : null;
  const batch = isBatch(approval) ? batchPreview(approval.input) : null;
  const create = createInput(approval);
  const blocker = blockerResolveInput(approval);
  const skipCheck = skipMergeCheckInput(approval);
  const mergeCheck = mergeCheckChangeInput(approval);
  // What the composer's bar would name as the thing not being done: the proposal's own subject, and
  // never the tool's name, which says nothing about what is not being created. Null for everything
  // that is not one of Orbit's own asks — a plan, a tool call — which keeps its one-press Reject.
  const declineSubject: string | null = dag
    ? (dag.preview.listTitle ?? 'this list')
    : batch
      ? `${batch.taskCount ?? 0} new task${batch.taskCount === 1 ? '' : 's'}`
      : create
        ? create.title
        : blocker
          ? (blocker.subjectTitle || blocker.kind || 'this blocker')
          : skipCheck
            ? (skipCheck.taskTitle || 'this landing')
          : mergeCheck
            ? `${mergeCheck.projectTitle || 'this project'}'s merge check`
            : null;
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
                  : '📝 Confirm: create 1 task?'
                : blocker
                  ? `🚧 Confirm: this no longer blocks ${blocker.projectTitle || 'the project'}?`
                  : skipCheck
                    ? `⏭ Confirm: land ${skipCheck.taskTitle || 'this task'} without the merge check?`
                    : mergeCheck
                      ? `🔧 Confirm: change the merge check of ${mergeCheck.projectTitle || 'this project'}?`
                      : `🔓 Approve tool call: ${approval.toolName}`;
  return (
    <ReviewCard enabled={compact} title={heading}
      summary={markdownToPlainLines(plan || create?.prose || '')}
      meta={!answerable ? 'No longer waiting for an answer' : undefined}
      open={reviewOpen} onOpenChange={setReviewOpen}>
    <div ref={anchor} className="approval-card">
      <div className="approval-head">
        {heading}
      </div>
      {/* A create is read top to bottom like a plan, so it grows instead of scrolling. */}
      <div className={`approval-body${plan || create || blocker || skipCheck || mergeCheck ? ' is-plan' : ''}`}>
        {plan ? (
          <Markdown
            remarkPlugins={[remarkGfm]}
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
        ) : (
          <pre className="approval-input">{JSON.stringify(approval.input ?? {}, null, 2)}</pre>
        )}
      </div>
      {!answerable && <UnanswerableNote />}
      <CardActions className="approval-actions">
        <CardActionButton
          tone="primary"
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
                        ? 'Change the check'
                        : 'Approve'}
          {keys && <span className="approval-kbd">{ENTER_HINT}</span>}
        </CardActionButton>
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
        urlTransform={referenceUrlTransform}
        components={{ a: ReferenceLink }}
      >
        {input.requiredAction}
      </Markdown>
      <p className="dag-approval-caption">The agent says it no longer blocks</p>
      <Markdown
        remarkPlugins={[remarkGfm]}
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
  const current = input.current ?? 'no check configured';
  const next = input.next ?? 'no check — nothing runs on the combined tree';
  return (
    <div className="dag-approval">
      <p className="dag-approval-note">
        Run on the combined tree before this project's work lands. Nothing else about the
        project's integration line changes.
      </p>
      <Command label="now" command={current} />
      <Command label="after" command={next} />
      {input.timeout !== null && (
        <p className="dag-approval-caption">killed after {input.timeout}s</p>
      )}
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

/** AskUserQuestion: pick option(s) per question and submit, like Claude's TUI. The picks
 *  ride back to claude as `answers` (question text → labels) on an `allow`. */
function QuestionForm({
  approval,
  onDecide,
  answerable,
  onChatAbout,
}: {
  approval: ApprovalInfo;
  onDecide: OnDecide;
  answerable: boolean;
  onChatAbout?: (id: string, question: string) => void;
}): JSX.Element {
  const [reviewOpen, setReviewOpen] = useState(false);
  const questions = questionsOf(approval.input);
  const [sel, setSel] = useState<Record<string, string[]>>({});
  // Free-text answers, keyed by question text — claude's AskUserQuestion always lets
  // the user type their own answer instead of picking a listed option.
  const [custom, setCustom] = useState<Record<string, string>>({});
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
          onClick={() => { setReviewOpen(false); onChatAbout?.(approval.id, chatLabel); }}
        >
          💬 Chat about this
        </CardActionButton>
      </CardActions>
    </div>
    </ReviewCard>
  );
}
