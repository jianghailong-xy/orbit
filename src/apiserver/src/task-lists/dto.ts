import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateTaskListDto {
  @IsString()
  @MinLength(1)
  title!: string;
}

/**
 * Standing instructions are capped well below MAX_PROMPT_CHARS (50k, the whole assembled
 * prompt). Without a cap the failure lands at the wrong end: an oversized value is accepted
 * here and then makes *every* dispatch of that list throw "prompt is too long", once per task
 * per sweep, far from the edit that caused it. 10k characters is a long procedure document and
 * still leaves the description and the template room to fit.
 */
export const MAX_TASK_LIST_INSTRUCTIONS_CHARS = 10_000;

export class UpdateTaskListDto {
  @IsOptional() @IsString() @MinLength(1) title?: string;
  /** How this list's work is done, spliced into every task run's prompt; null clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_TASK_LIST_INSTRUCTIONS_CHARS)
  instructions?: string | null;
  /** Emergency stop: holds back this list's dispatch without touching runs already in flight. */
  @IsOptional() @IsBoolean() paused?: boolean;
  /**
   * Cap on this list's concurrently RUNNING task sessions; null clears it (uncapped). The
   * ceiling matches the runner's own `maxConcurrent` bound — a per-list cap above the machine's
   * is not a cap at all.
   */
  @IsOptional() @IsInt() @Min(1) @Max(64) maxConcurrent?: number | null;
  /**
   * Why this change is being made, recorded on the revision. Ignored when the request touches no
   * policy field — a rename produces no revision to attach it to.
   */
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  /** Workspace that runs this list's coordination when it stalls; null clears it. */
  @IsOptional() @IsUUID() foremanWorkspaceId?: string | null;
  /**
   * Minutes of no activity, with work remaining, before a foreman is filed; null disables it.
   * Floored at 5 because the sweep itself runs once a minute and a run takes longer than that to
   * start — anything shorter would call a list stalled while it was still getting going.
   */
  @IsOptional() @IsInt() @Min(5) foremanStallMinutes?: number | null;
}

export class RestoreTaskListRevisionDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
