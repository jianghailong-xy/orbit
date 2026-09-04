import { Type } from 'class-transformer';
import type { EvidenceCheckKind } from './task-evidence-envelope';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Matches,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { TaskStatus } from '@orbit/shared';
import type { CreatorType } from '@prisma/client';
import { IsPublicId } from '../common/public-id';
import { TASK_TERMINAL_REASONS, type TaskTerminalReason } from './task-supersession';
import {
  TASK_COMPLETION_POLICIES,
  TASK_VERDICTS,
  TaskCompletionPolicyValue,
  TaskVerdictValue,
} from '../projects/task-aggregation';
import {
  TASK_COMPLETION_CRITERIA,
  type TaskCompletionCriterionValue,
} from './task-completion-criterion';
import { MAX_TASK_CRITERION_OVERRIDE_REASON_CHARS } from './task-criterion-shape-advice';

const TASK_STATUSES = Object.values(TaskStatus);
const TASK_COMPLETION_POLICY_VALUES = [...TASK_COMPLETION_POLICIES];
const TASK_VERDICT_VALUES = [...TASK_VERDICTS];
const TASK_COMPLETION_CRITERION_VALUES = [...TASK_COMPLETION_CRITERIA];
const TASK_TERMINAL_REASON_VALUES = [...TASK_TERMINAL_REASONS];

/**
 * Bounds on one task's labels. Not a taxonomy — a stop on a caller that has confused the label
 * set with the description. Both are mirrored in the runner's MCP tool schema.
 */
export const TASK_LABEL_MAX_COUNT = 16;
export const TASK_LABEL_MAX_LENGTH = 64;

/** Same cap and same reasoning as the project's own criteria (see projects/dto.ts). */
export const MAX_TASK_ACCEPTANCE_CRITERIA_CHARS = 4_000;

/**
 * A day, matching 0236's `task_acceptance_timeout_shape_check`. Not a policy about how long work
 * may take — it is the point past which "this is a wall-clock budget for one command" stops being
 * a plausible reading of the number, and the runner holds the session's turn loop the whole time.
 */
export const MAX_TASK_ACCEPTANCE_TIMEOUT_SECONDS = 86_400;

/** One explicit completion-evidence submission. The source is caller identity, never payload prose. */
export class SubmitTaskCompletionEvidenceDto {
  @IsPublicId()
  sourceSessionId!: string;

  @IsObject()
  evidence!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  idempotencyKey?: string;
}

/** Runner/MCP submissions take their source Session from the authenticated execution header. */
export class SubmitRunnerTaskCompletionEvidenceDto {
  @IsObject()
  evidence!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  idempotencyKey?: string;
}

/** A human-reviewed, explicit conversion of one historical comment into structured evidence. */
export class ImportLegacyTaskCommentEvidenceDto {
  @IsPublicId()
  sourceCommentId!: string;

  @IsPublicId()
  sourceSessionId!: string;

  @IsObject()
  evidence!: Record<string, unknown>;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  idempotencyKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4_000)
  reviewNote!: string;

  /** Default false. Only an explicit true puts this one import on the APNs due ledger. */
  @IsOptional()
  @IsBoolean()
  devicePush?: boolean;
}

export class TaskLegacyEvidenceImportDto {
  @IsPublicId()
  id!: string;
  @IsPublicId()
  sourceCommentId!: string;
  @IsPublicId()
  sourceSessionId!: string;
  sourceAuthorType!: CreatorType;
  @IsPublicId()
  sourceAuthorId!: string;
  sourceCreatedAt!: Date;
  sourceDigest!: string;
  structuredEvidenceDigest!: string;
  @IsPublicId()
  importedById!: string;
  importedAt!: Date;
  idempotencyKey!: string;
  reviewNote!: string;
  devicePolicy!: 'IMMEDIATE' | 'IN_APP_ONLY';
}

/**
 * One check's citation, as the server resolved it.
 *
 * Echoed back so a submitter learns whether the handle they gave actually held. Without it the
 * only signal a submission carries is "no error", and "my citation resolved" and "my citation was
 * tolerated because a sibling one resolved" would look identical from the outside.
 */
export class TaskEvidenceCitationDto {
  kind!: EvidenceCheckKind;
  ref!: string;
  resolved!: boolean;
  reason!: string | null;
}

/** The stated criterion the envelope named, and whether it still reads that way. */
export class TaskEvidenceCriterionMatchDto {
  key!: string;
  text!: string;
  matchesLive!: boolean;
}

/** The shared REST/runner/CLI/MCP read shape; every provenance and version field is required. */
export class TaskCompletionEvidenceDto {
  @IsPublicId()
  id!: string;
  @IsPublicId()
  taskId!: string;
  actorType!: CreatorType;
  @IsPublicId()
  actorId!: string;
  submittedAt!: Date;
  @IsPublicId()
  sourceSessionId!: string;
  @IsOptional()
  @IsPublicId()
  sourceAttemptId!: string | null;
  criterionRevision!: string;
  criterion!: Record<string, unknown>;
  evidence!: Record<string, unknown>;
  evidenceDigest!: string;
  revision!: string;
  idempotencyKeys!: string[];
  legacyImport!: TaskLegacyEvidenceImportDto | null;
  /**
   * What this submission's citations resolved to, one per `evidence.checks` entry and in that
   * order. Present on a submit receipt — including a replayed one — and null on a list read,
   * which re-derives nothing: the rows a stored envelope cited may have been deleted since, and
   * a `resolved` that quietly means "as of now" would be a different fact under the same name.
   */
  citations!: TaskEvidenceCitationDto[] | null;
  criterionMatch!: TaskEvidenceCriterionMatchDto | null;
}

/**
 * Unit L4: this write DECLARES that it crosses into another project.
 *
 * Presence is the declaration — §4 SC5 turns on exactly that, and it is why `HANDOFF_TASK` is an
 * operation rather than something the server infers: an inferred crossing would be satisfied by
 * accident, and "I did not realise it was another project" and "I am asking to move work between
 * two goals" would become the same request.
 *
 * It carries no authority. What it does is make the crossing askable: the server derives both ends,
 * files the question against the crossing (never against the session that asked, so it survives a
 * takeover), and refuses this write until somebody answers. The answer is the user's — or, when the
 * owner has put BOTH projects on AUTO, their own standing policy.
 */
export class TaskHandoffDto {
  /** Why this work belongs over there. Shown to whoever answers; never read by any gate. */
  @IsOptional() @IsString() @MaxLength(1_000) reason?: string;
}

export class CreateTaskDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsOptional() @IsString() description?: string;
  // The workspace assigned to execute the task. Must be owned by the caller.
  @IsOptional() @IsPublicId() assigneeId?: string;
  // The list this task belongs to. Must be owned by the caller.
  @IsOptional() @IsPublicId() listId?: string;
  // The project this task is work towards. Must be owned by the caller. Orthogonal to listId:
  // a list decides how the task runs, a project states what it is for.
  @IsOptional() @IsPublicId() projectId?: string;
  // Unit L3: the coordination scope this write claims to be made under, as one opaque field
  // (`psc:v1:<projectId>:<generation>`).
  //
  // NOT a credential and not `@IsPublicId`: it contains no secret, any client can compute it, and
  // the server derives the real scope from the session row and only COMPARES. What it buys is that
  // a projectId which disagrees with the generation beside it is not representable, and that every
  // write records which coordination scope authored it. A client that sends none is scoped exactly
  // the same way (§8 CM1 — a missing token is not authorization); all it loses is the ability to
  // be told WHICH half moved when a rotation refuses it.
  @IsOptional() @IsString() @MaxLength(128) scopeToken?: string;
  // Unit L4: declare that this write crosses into another project (see TaskHandoffDto). Only
  // meaningful together with an explicit `projectId` — a crossing has to name where it is going.
  @IsOptional() @ValidateNested() @Type(() => TaskHandoffDto) handoff?: TaskHandoffDto;
  // The task this one is a part of. Must be owned by the caller and belong to the same project —
  // a subtask of work in another project is a statement no reader could act on.
  @IsOptional() @IsPublicId() parentTaskId?: string;
  // What would settle that this task is actually done.
  @IsOptional()
  @IsString()
  @MaxLength(MAX_TASK_ACCEPTANCE_CRITERIA_CHARS)
  acceptanceCriteria?: string;
  // Unit T6: which of the PROJECT's stated acceptance criteria this new work serves, as one of the
  // `key` values `project_get` returns.
  //
  // Required of a judgment session and of nobody else (`refuseTaskOpening`), which is why it is
  // optional here: a person filing work has never had to justify it to a gate, and making the
  // field mandatory at the DTO would refuse every task the product creates today.
  //
  // Migration 0232 gave it a landing place. The key itself is still not stored — it is content
  // addressed, so it changes every time somebody edits the criterion's words — but what it
  // RESOLVES to is: `Task.criterionDefinitionId` (the criterion's stable id, a live relation) and
  // `Task.criterionRevision` (what that criterion's revision was at this moment). The resolution
  // happens against the project the write lands in, so a key that named a criterion when the
  // criteria said one thing is refused, not silently dropped, after a person rewrites them.
  @IsOptional() @IsString() @MaxLength(64) criterionKey?: string;
  // EXECUTABLE is intentionally only this pair: one command, one expected exit code.
  @IsOptional() @IsString() acceptanceCommand?: string;
  @IsOptional() @IsInt() acceptanceExpectedExitCode?: number;
  // How long that command may run. Omitted is the runner's two-minute default, which is the only
  // budget this replaces — it buys wall-clock and decides nothing about the outcome.
  @IsOptional() @IsInt() @Min(1) @Max(MAX_TASK_ACCEPTANCE_TIMEOUT_SECONDS)
  acceptanceTimeoutSeconds?: number;
  // One ordinary completion criterion. Optional to VALIDATION only: both write doors run
  // `requireExplicitCompletionCriterion` before the service, and an omission they cannot translate
  // from an unambiguous legacy shape (the executable pair, or a VERIFICATION_PASSED policy /
  // verifier relation) is refused there rather than read as EVIDENCE_JUDGMENT. Class-validator has
  // no way to express "required unless another field implies it", which is why the requirement is
  // stated at the door and not with a decorator here.
  @IsOptional() @IsIn(TASK_COMPLETION_CRITERION_VALUES)
  completionCriterion?: TaskCompletionCriterionValue;
  // Audit material for deliberately keeping a criterion that the acceptance prose makes the
  // server question. Optional on the first attempt; a mismatch without it returns an ADVISORY.
  @IsOptional() @IsString() @MaxLength(MAX_TASK_CRITERION_OVERRIDE_REASON_CHARS)
  completionCriterionOverrideReason?: string;
  // How this task's own completion is decided once it has subtasks. Omitted is MANUAL, which is
  // what every task has always been: nothing completes it but a status write. See §13.1.
  @IsOptional() @IsIn(TASK_COMPLETION_POLICY_VALUES) completionPolicy?: TaskCompletionPolicyValue;
  // The task this one exists to check (§13.2). Naming it here is what makes a verification
  // filable on purpose rather than only by the automatic verifyOnDone path — and it is the
  // precondition for everything the verdict does, since `verdict` is refused on a task that
  // verifies nothing and `VERIFICATION_PASSED` counts only checks pointed at the subject.
  //
  // The subject must be owned by the caller, must not be this task, must not itself be a
  // verification, and must be in the same project — aggregation reads one project's tasks, so a
  // check filed across that line would be one nothing can ever count.
  @IsOptional() @IsPublicId() verifiesTaskId?: string;
  // §13.6 SU7: the attempt this new task REPLACES. The successor and the link are written in one
  // transaction — the point of the field is that there is no window in which the replacement
  // exists and the thing it replaced does not know.
  //
  // Without it, recording a supersession takes two calls, and this deployment has already paid for
  // the gap between them: a fresh review was created saying "replacement for the earlier attempt"
  // in its description, the second call was never made, and the abandoned attempt was re-dispatched
  // by the control loop weeks later because nothing structured said it had been replaced.
  //
  // The predecessor must be CANCELLED or FAILED, owned by the caller, in the same project as this
  // new task, and not already replaced (SU2–SU5, plus a compare-and-set so two concurrent
  // replacements produce one winner and one 409 rather than a pointer that depends on timing).
  //
  // There is deliberately no `supersedesRef` for a task created by this same batch: SU4 refuses a
  // predecessor that has not stopped, batch-created tasks are OPEN, and a parameter that is
  // refused every time it is used is worse than one that does not exist.
  @IsOptional() @IsPublicId() supersedesTaskId?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  // The earliest time this task may start automatically (ISO 8601, stored and returned UTC).
  // Omitted means unscheduled, which is what every task has always been. Distinct from dueDate on
  // purpose: that is a deadline nothing dispatches on, this is a trigger — see Task.runAt.
  //
  // One-shot. The first run actually accepted consumes it, so there is no recurrence to express
  // and no cron expression to accept.
  @IsOptional() @IsDateString() runAt?: string;
  // Provider/model this task's runs use, overriding the assignee workspace's own. The provider must
  // be a built-in engine slug or one of the caller's enabled configured providers; omitted (or
  // null) inherits from the assignee, which is the historical behaviour.
  @IsOptional() @IsString() @MaxLength(64) provider?: string | null;
  @IsOptional() @IsString() @MaxLength(200) model?: string | null;
  // Prerequisite task ids this new task should wait on (each must be owned by the
  // caller). The task only runs once they're all DONE.  //
  // Name the SUBJECT, not its verification task. "B waits for A to be verified" is spelled
  // `dependsOn: A`: once anything checks A, §13.3 DEP holds that edge until A's latest check has
  // actually PASSED — a check that finished DONE with a FAIL verdict does not release it, and
  // neither does re-opening the question with a new check. An edge naming the CHECK resolves to
  // the same epoch, so old plans keep working, but it reads as being about one particular run
  // when what the author meant was the work.
  @IsOptional() @IsArray() @IsPublicId({ each: true }) dependsOnTaskIds?: string[];
  // Auto-run once all prerequisites are DONE (default true). Ignored without deps.
  @IsOptional() @IsBoolean() autoRunWhenReady?: boolean;
  // Free-text grouping labels, orthogonal to listId (see Task.labels). Stored trimmed and
  // deduplicated, case as given, since filtering matches exactly.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TASK_LABEL_MAX_COUNT)
  @IsString({ each: true })
  @MaxLength(TASK_LABEL_MAX_LENGTH, { each: true })
  labels?: string[];
}

/** How many tasks one batch-create call may write. Mirrored in the runner's MCP tool schema. */
export const TASK_BATCH_CREATE_MAX = 50;

/**
 * How many edges one DAG proposal may rewrite.
 *
 * A cap on how much a single approval can be made to mean. Fifty is well past any restructure a
 * person reads and judges in one card; past that the honest description of what they are doing is
 * clicking approve on a number rather than on a change.
 */
export const MAX_DAG_OPS = 50;

/** How many task titles a batch-create approval card shows before it starts counting instead. */
export const DAG_PREVIEW_TITLES = 12;

export class CreateTaskBatchItemDto extends CreateTaskDto {
  // Caller-supplied label for THIS item, used only to wire the batch together internally — its
  // dependencies (dependsOnRefs) and its subtasks (parentRef) — since the real ids don't exist
  // yet. Never stored.
  @IsOptional() @IsString() @MinLength(1) @MaxLength(64) ref?: string;

  // Prerequisites created by this same batch, addressed by their `ref`. Each must belong to an
  // EARLIER item, which keeps the batch acyclic by construction. Adds to dependsOnTaskIds,
  // which stays reserved for tasks that already exist.
  @IsOptional() @IsArray() @IsString({ each: true }) dependsOnRefs?: string[];

  // The parent this item is a part of, created by this same batch and addressed by its `ref` —
  // what lets a decomposition land in one call, since the parent's id does not exist yet. Must
  // name an EARLIER item, which is both what makes the id available by the time this row is
  // written and what keeps the tree acyclic by construction. Mutually exclusive with
  // parentTaskId, which stays reserved for a parent that already exists: naming both is naming
  // two parents.
  @IsOptional() @IsString() @MinLength(1) @MaxLength(64) parentRef?: string;

  // The subject this item verifies, created by this same batch and addressed by its `ref`. Same
  // backward-only rule as the two above, and mutually exclusive with verifiesTaskId for the same
  // reason parentRef is with parentTaskId: naming both names two subjects.
  //
  // It exists so a phase and the check on that phase land in ONE all-or-nothing write. Filed as
  // two calls instead, the window between them is a phase whose completion policy is
  // VERIFICATION_PASSED with nothing pointed at it — a parent that can never complete.
  @IsOptional() @IsString() @MinLength(1) @MaxLength(64) verifiesRef?: string;
}

export class CreateTasksBatchDto {
  // Created in order, all-or-nothing: if any item is invalid, no task is written.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TASK_BATCH_CREATE_MAX)
  @ValidateNested({ each: true })
  @Type(() => CreateTaskBatchItemDto)
  tasks!: CreateTaskBatchItemDto[];

  /**
   * Unit L7: judge this plan and write none of it.
   *
   * The same admission, the same preflight, the same order — and then it stops, returning where
   * every item would land (project id, title, status, acceptance epoch), every finding including
   * the warnings a refusal body leaves out, and how many rows the real call would add. A batch
   * create is the most consequential thing an agent does here and the least visible: the request is
   * fifty titles and the result is a graph of work filed against somebody's goals.
   *
   * Writes nothing at all, including the QUESTION a crossing would otherwise file: a dry run that
   * declared a handoff would have a preview leaving a pending approval behind it. A crossing with
   * no answer yet is reported as the refusal it is, which is what a reader wants to know before
   * they submit rather than after.
   */
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

export class DagOpDto {
  @IsIn(['add', 'remove']) op!: 'add' | 'remove';
  /** The dependent. Must belong to the list being restructured. */
  @IsPublicId() taskId!: string;
  /** The prerequisite. May live in another list — cross-list waits are an ordinary shape. */
  @IsPublicId() dependsOnTaskId!: string;
}

export class ProposeDagDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_DAG_OPS)
  @ValidateNested({ each: true })
  @Type(() => DagOpDto)
  ops!: DagOpDto[];
  /** Why, carried onto the approval card. The reason a human can judge the change at all. */
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class UpdateTaskDto {
  @IsOptional() @IsString() @MinLength(1) title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsIn(TASK_STATUSES) status?: TaskStatus;
  // null clears the assignment; a string (re)assigns to that workspace.
  @IsOptional() @IsPublicId() assigneeId?: string | null;
  // null detaches from its list; a string (re)assigns to that list.
  @IsOptional() @IsPublicId() listId?: string | null;
  // null detaches from its project; a string (re)files it under that project. Rejected when it
  // would leave this task in a different project from its parent or its subtasks — see
  // TasksService.assertHierarchyConsistent.
  @IsOptional() @IsPublicId() projectId?: string | null;
  // See CreateTaskDto.scopeToken. Compared, never trusted.
  @IsOptional() @IsString() @MaxLength(128) scopeToken?: string;
  // Unit L4: declare that this write crosses into another project (see TaskHandoffDto). Only
  // meaningful together with an explicit `projectId` — a crossing has to name where it is going.
  @IsOptional() @ValidateNested() @Type(() => TaskHandoffDto) handoff?: TaskHandoffDto;
  // null detaches from its parent; a string makes this task part of that one. Rejected for a
  // self-parent, for a cycle, and across projects.
  @IsOptional() @IsPublicId() parentTaskId?: string | null;
  // null clears the criteria; a string replaces them.
  @IsOptional()
  @IsString()
  @MaxLength(MAX_TASK_ACCEPTANCE_CRITERIA_CHARS)
  acceptanceCriteria?: string | null;
  // Null/null clears EXECUTABLE's evidence fields; omission preserves the stored values.
  @IsOptional() @IsString() acceptanceCommand?: string | null;
  @IsOptional() @IsInt() acceptanceExpectedExitCode?: number | null;
  // Three-state: omitted preserves the stored budget, null returns the task to the runner's
  // default, a number replaces it.
  @IsOptional() @IsInt() @Min(1) @Max(MAX_TASK_ACCEPTANCE_TIMEOUT_SECONDS)
  acceptanceTimeoutSeconds?: number | null;
  // Omit to preserve it. A criterion is never nullable: EVIDENCE_JUDGMENT is the explicit normal
  // choice rather than clearing the field or escalating after another criterion failed.
  @IsOptional() @IsIn(TASK_COMPLETION_CRITERION_VALUES)
  completionCriterion?: TaskCompletionCriterionValue;
  @IsOptional() @IsDateString() dueDate?: string | null;
  // Three-state like dueDate above: omit to keep the current schedule, null to cancel it, an ISO
  // instant to (re)schedule. Rescheduling a task whose dispatch is in flight is safe — the
  // consumption is a compare-and-set on the instant it read, so this write wins rather than being
  // cleared by the run it raced.
  @IsOptional() @IsDateString() runAt?: string | null;
  // null goes back to inheriting the assignee workspace's provider/model; a string pins this task's
  // runs to that provider / model id. Omit to leave the current pin alone.
  @IsOptional() @IsString() @MaxLength(64) provider?: string | null;
  @IsOptional() @IsString() @MaxLength(200) model?: string | null;
  // Full replacement for this task's prerequisites. Omit to keep them unchanged;
  // pass [] to clear them all.  //
  // Name the SUBJECT, not its verification task. "B waits for A to be verified" is spelled
  // `dependsOn: A`: once anything checks A, §13.3 DEP holds that edge until A's latest check has
  // actually PASSED — a check that finished DONE with a FAIL verdict does not release it, and
  // neither does re-opening the question with a new check. An edge naming the CHECK resolves to
  // the same epoch, so old plans keep working, but it reads as being about one particular run
  // when what the author meant was the work.
  @ValidateIf((_dto, value) => value !== undefined)
  @IsArray()
  @IsPublicId({ each: true })
  dependsOnTaskIds?: string[];
  // Auto-run once all prerequisites are DONE.
  @IsOptional() @IsBoolean() autoRunWhenReady?: boolean;
  // How this task's completion is decided. Switching to MANUAL stops aggregation without undoing
  // whatever it last concluded; switching away from it hands the status to the subtasks.
  @IsOptional() @IsIn(TASK_COMPLETION_POLICY_VALUES) completionPolicy?: TaskCompletionPolicyValue;
  // The task this one exists to check. Three-state: omit to leave the relation alone, null to
  // detach it, an id to point this task at that subject. Refused once this task has concluded
  // anything (§13.2 V7): the consequences already applied are keyed on (verifier, revision) and
  // name the subject they were about, so re-pointing afterwards would leave the ledger asserting
  // a conclusion about a task the verifier no longer checks. File a new verification instead.
  @IsOptional() @IsPublicId() verifiesTaskId?: string | null;
  // The later attempt that replaced this one (§13.6). Three-state like the links above: omit to
  // leave it alone, null to unlink, an id to record that this attempt was superseded. Only a
  // CANCELLED or FAILED task may name one, the successor must be in the same project, and linking
  // writes nothing to `status` — the original outcome is the fact being kept.
  @IsOptional() @IsPublicId() supersededByTaskId?: string | null;
  // Why this task stopped, when its status alone does not say. Setting a successor implies
  // 'SUPERSEDED' and needs no explicit value; 'ABANDONED' is for the other case, a task dropped
  // with nothing replacing it.
  @ValidateIf((_dto, value) => value !== null)
  @IsOptional()
  @IsIn(TASK_TERMINAL_REASON_VALUES)
  terminalReason?: TaskTerminalReason | null;
  // This verification task's conclusion about its subject. Three-state like the pins above: omit
  // to leave it alone, null to revoke it, a value to record it. Only a task that names a subject
  // (verifiesTaskId) can carry one, and a revoked PASS reopens whatever it had completed.
  @ValidateIf((_dto, value) => value !== null)
  @IsOptional()
  @IsIn(TASK_VERDICT_VALUES)
  verdict?: TaskVerdictValue | null;
  // Full replacement for this task's labels, like dependsOnTaskIds above: omit to leave them
  // alone, pass [] to clear them.
  @ValidateIf((_dto, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(TASK_LABEL_MAX_COUNT)
  @IsString({ each: true })
  @MaxLength(TASK_LABEL_MAX_LENGTH, { each: true })
  labels?: string[];
}

export class AddDependencyDto {
  // The prerequisite task this task should wait on. Must be owned by the caller, differ
  // from the task itself, and not introduce a dependency cycle.  //
  // Name the SUBJECT, not its verification task. "B waits for A to be verified" is spelled
  // `dependsOn: A`: once anything checks A, §13.3 DEP holds that edge until A's latest check has
  // actually PASSED — a check that finished DONE with a FAIL verdict does not release it, and
  // neither does re-opening the question with a new check. An edge naming the CHECK resolves to
  // the same epoch, so old plans keep working, but it reads as being about one particular run
  // when what the author meant was the work.
  @IsPublicId() dependsOnTaskId!: string;
}

export class ExpandDependencyGraphDto {
  /** The visible task whose prerequisite or dependent branch should be expanded. */
  @IsPublicId() anchorTaskId!: string;

  @IsIn(['prerequisites', 'dependents'])
  direction!: 'prerequisites' | 'dependents';

  /** Every task node currently present in the client snapshot. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsPublicId({ each: true })
  knownTaskIds!: string[];

  /**
   * Direct neighbors whose anchor-side edge is already present. This is deliberately
   * separate from knownTaskIds: a diamond can make a node visible through another
   * branch before this anchor's edge has been loaded.
   */
  @IsArray()
  @ArrayMaxSize(1000)
  @IsPublicId({ each: true })
  loadedNeighborTaskIds!: string[];

  @IsOptional() @IsInt() @Min(1) @Max(100) limit?: number;

  /** Opaque branch token returned by dependency-graph or the previous expansion. */
  @IsString() @MinLength(1) cursor!: string;
}

export class RefreshDependencyGraphNodesDto {
  /** Current client snapshot ids; duplicates are collapsed by TasksService. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsPublicId({ each: true })
  taskIds!: string[];
}

/**
 * The id of one PRESS of a run button, or of one tool invocation — never of the run it starts.
 *
 * Two calls carrying the same one are ONE request: the Session a task run writes is named after
 * this token, so a client that retries a POST it never got an answer to gets back the Session its
 * first attempt created, whatever status that run has reached by then, instead of starting a second
 * one or being refused.
 *
 * Optional, and a caller that sends none is not refused: the server mints one, which still makes
 * two doors racing over one task collapse onto a single run. What it cannot do is make a RETRY the
 * same request — a token the caller never received is one it cannot send again — so a client that
 * wants that property has to name its own press. Same field, same spelling and same reasoning as
 * `TriggerProjectCoordinatorDto.triggerId`.
 */
export class RunTaskDto {
  @IsOptional() @IsPublicId() triggerId?: string;
}

/** How many tasks one press of the bulk Run may name. See the field's own note. */
export const BATCH_EXECUTE_MAX_TASKS = 200;

export class BatchExecuteDto {
  // The tasks to run. Tasks without a responsible workspace / bound runner are skipped
  // server-side rather than failing the batch.
  //
  // Bounded, and the bound is a correctness one rather than a courtesy: one press is evaluated
  // under a LEASE (0137), and a press whose dispatch loop can run for longer than the lease is one
  // a takeover can join halfway through. The cap keeps the work inside a renewable lease's reach —
  // and the loop re-proves its lease before every item, so a press that still outlives it stops
  // instead of applying effects beside its successor.
  @IsArray() @ArrayMaxSize(BATCH_EXECUTE_MAX_TASKS) @IsPublicId({ each: true }) taskIds!: string[];

  // When set, caps how many of THIS batch's tasks run at once. It applies only to this
  // batch (the claim queue gates the batch's live sessions on it) and never touches any
  // runner's persistent max_concurrent — independent of the per-runner cap. Rest queue.
  @IsOptional() @IsInt() @Min(1) @Max(64) maxConcurrent?: number;

  /** This press's identity, exactly as on `RunTaskDto` — one press, one run per task in it. */
  @IsOptional() @IsPublicId() triggerId?: string;
}

export class BatchStopDto {
  // The tasks whose in-flight session (running or queued) should be cancelled. Tasks
  // with no stoppable session are silently no-ops.
  @IsArray() @IsPublicId({ each: true }) taskIds!: string[];
}

export class BatchDeleteDto {
  // Hard-delete the caller's matching tasks. Unknown and cross-tenant ids are ignored;
  // duplicates are collapsed by TasksService before reaching PostgreSQL.
  @IsArray() @IsPublicId({ each: true }) taskIds!: string[];
}

export class BatchAssignDto {
  @IsArray() @IsPublicId({ each: true }) taskIds!: string[];

  // The workspace to set as responsible for every selected task; null clears the assignment.
  @IsOptional() @IsPublicId() assigneeId?: string | null;
}

export class CreateTaskCommentDto {
  @IsString()
  @MinLength(1)
  body!: string;

  // Workspace ids @-mentioned in the comment. Each owned workspace is notified and triggered
  // on this task; unknown/non-owned ids are silently dropped (see TasksService).
  @IsOptional() @IsArray() @IsPublicId({ each: true }) mentions?: string[];
}
