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
  IsUUID,
  Max,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { TaskStatus } from '@orbit/shared';

const TASK_STATUSES = Object.values(TaskStatus);

export class CreateTaskDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsOptional() @IsString() description?: string;
  // The agent assigned to execute the task. Must be owned by the caller.
  @IsOptional() @IsUUID() assigneeId?: string;
  // The list this task belongs to. Must be owned by the caller.
  @IsOptional() @IsUUID() listId?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  // Prerequisite task ids this new task should wait on (each must be owned by the
  // caller). The task only runs once they're all DONE.
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) dependsOnTaskIds?: string[];
  // Auto-run once all prerequisites are DONE (default true). Ignored without deps.
  @IsOptional() @IsBoolean() autoRunWhenReady?: boolean;
}

export class UpdateTaskDto {
  @IsOptional() @IsString() @MinLength(1) title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsIn(TASK_STATUSES) status?: TaskStatus;
  // null clears the assignment; a string (re)assigns to that agent.
  @IsOptional() @IsUUID() assigneeId?: string | null;
  // null detaches from its list; a string (re)assigns to that list.
  @IsOptional() @IsUUID() listId?: string | null;
  @IsOptional() @IsDateString() dueDate?: string | null;
  // Full replacement for this task's prerequisites. Omit to keep them unchanged;
  // pass [] to clear them all.
  @ValidateIf((_dto, value) => value !== undefined)
  @IsArray()
  @IsUUID('all', { each: true })
  dependsOnTaskIds?: string[];
  // Auto-run once all prerequisites are DONE.
  @IsOptional() @IsBoolean() autoRunWhenReady?: boolean;
}

export class AddDependencyDto {
  // The prerequisite task this task should wait on. Must be owned by the caller, differ
  // from the task itself, and not introduce a dependency cycle.
  @IsUUID('all') dependsOnTaskId!: string;
}

export class ExpandDependencyGraphDto {
  /** The visible task whose prerequisite or dependent branch should be expanded. */
  @IsUUID('all') anchorTaskId!: string;

  @IsIn(['prerequisites', 'dependents'])
  direction!: 'prerequisites' | 'dependents';

  /** Every task node currently present in the client snapshot. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  knownTaskIds!: string[];

  /**
   * Direct neighbors whose anchor-side edge is already present. This is deliberately
   * separate from knownTaskIds: a diamond can make a node visible through another
   * branch before this anchor's edge has been loaded.
   */
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
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
  @IsUUID('all', { each: true })
  taskIds!: string[];
}

export class BatchExecuteDto {
  // The tasks to run. Tasks without a responsible agent / bound runner are skipped
  // server-side rather than failing the batch.
  @IsArray() @IsString({ each: true }) taskIds!: string[];

  // When set, caps how many of THIS batch's tasks run at once. It applies only to this
  // batch (the claim queue gates the batch's live sessions on it) and never touches any
  // runner's persistent max_concurrent — independent of the per-runner cap. Rest queue.
  @IsOptional() @IsInt() @Min(1) @Max(64) maxConcurrent?: number;
}

export class BatchStopDto {
  // The tasks whose in-flight session (running or queued) should be cancelled. Tasks
  // with no stoppable session are silently no-ops.
  @IsArray() @IsString({ each: true }) taskIds!: string[];
}

export class BatchDeleteDto {
  // Hard-delete the caller's matching tasks. Unknown and cross-tenant ids are ignored;
  // duplicates are collapsed by TasksService before reaching PostgreSQL.
  @IsArray() @IsUUID('all', { each: true }) taskIds!: string[];
}

export class BatchAssignDto {
  @IsArray() @IsString({ each: true }) taskIds!: string[];

  // The agent to set as responsible for every selected task; null clears the assignment.
  @IsOptional() @IsString() assigneeId?: string | null;
}

export class CreateTaskCommentDto {
  @IsString()
  @MinLength(1)
  body!: string;

  // Agent ids @-mentioned in the comment. Each owned agent is notified and triggered
  // on this task; unknown/non-owned ids are silently dropped (see TasksService).
  @IsOptional() @IsArray() @IsString({ each: true }) mentions?: string[];
}
