import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { TaskStatus } from '@orbit/shared';
import { IsPublicId } from '../common/public-id';
import {
  TASK_COMPLETION_POLICIES,
  TASK_VERDICTS,
  TaskCompletionPolicyValue,
  TaskVerdictValue,
} from '../projects/task-aggregation';

const TASK_STATUSES = Object.values(TaskStatus);
const TASK_COMPLETION_POLICY_VALUES = [...TASK_COMPLETION_POLICIES];
const TASK_VERDICT_VALUES = [...TASK_VERDICTS];

/**
 * Bounds on one task's labels. Not a taxonomy — a stop on a caller that has confused the label
 * set with the description. Both are mirrored in the runner's MCP tool schema.
 */
export const TASK_LABEL_MAX_COUNT = 16;
export const TASK_LABEL_MAX_LENGTH = 64;

/** Same cap and same reasoning as the project's own criteria (see projects/dto.ts). */
export const MAX_TASK_ACCEPTANCE_CRITERIA_CHARS = 4_000;

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
  // The task this one is a part of. Must be owned by the caller and belong to the same project —
  // a subtask of work in another project is a statement no reader could act on.
  @IsOptional() @IsPublicId() parentTaskId?: string;
  // What would settle that this task is actually done.
  @IsOptional()
  @IsString()
  @MaxLength(MAX_TASK_ACCEPTANCE_CRITERIA_CHARS)
  acceptanceCriteria?: string;
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
  // caller). The task only runs once they're all DONE.
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
  // null detaches from its parent; a string makes this task part of that one. Rejected for a
  // self-parent, for a cycle, and across projects.
  @IsOptional() @IsPublicId() parentTaskId?: string | null;
  // null clears the criteria; a string replaces them.
  @IsOptional()
  @IsString()
  @MaxLength(MAX_TASK_ACCEPTANCE_CRITERIA_CHARS)
  acceptanceCriteria?: string | null;
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
  // pass [] to clear them all.
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
  // from the task itself, and not introduce a dependency cycle.
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

export class BatchExecuteDto {
  // The tasks to run. Tasks without a responsible workspace / bound runner are skipped
  // server-side rather than failing the batch.
  @IsArray() @IsPublicId({ each: true }) taskIds!: string[];

  // When set, caps how many of THIS batch's tasks run at once. It applies only to this
  // batch (the claim queue gates the batch's live sessions on it) and never touches any
  // runner's persistent max_concurrent — independent of the per-runner cap. Rest queue.
  @IsOptional() @IsInt() @Min(1) @Max(64) maxConcurrent?: number;
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
