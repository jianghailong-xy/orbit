import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ProjectStatus } from '@orbit/shared';

const PROJECT_STATUSES = Object.values(ProjectStatus);

/**
 * Bounds on a project's prose fields.
 *
 * Same reasoning as `MAX_TASK_LIST_INSTRUCTIONS_CHARS`, and the same number for `instructions`:
 * these are meant to be spliced into a prompt eventually, and an oversized value accepted here
 * would fail far from the edit that caused it. `goal` and `acceptanceCriteria` are capped lower
 * because a goal that needs four thousand characters is not a goal — it is the project.
 */
export const MAX_PROJECT_INSTRUCTIONS_CHARS = 10_000;
export const MAX_PROJECT_GOAL_CHARS = 4_000;
export const MAX_PROJECT_ACCEPTANCE_CRITERIA_CHARS = 4_000;

export class CreateProjectDto {
  @IsString()
  @MinLength(1)
  title!: string;

  /** What this project is trying to achieve. */
  @IsOptional() @IsString() @MaxLength(MAX_PROJECT_GOAL_CHARS) goal?: string;
  /** What would settle that the goal was reached. */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PROJECT_ACCEPTANCE_CRITERIA_CHARS)
  acceptanceCriteria?: string;
  /** How this project's work is to be done. Recorded only — nothing assembles it into a run
   *  prompt in this phase (see the Project model). */
  @IsOptional() @IsString() @MaxLength(MAX_PROJECT_INSTRUCTIONS_CHARS) instructions?: string;
}

export class UpdateProjectDto {
  @IsOptional() @IsString() @MinLength(1) title?: string;
  /** null clears the field, as on the task list's `instructions`: blank and absent must not be
   *  two different stored states. */
  @IsOptional() @IsString() @MaxLength(MAX_PROJECT_GOAL_CHARS) goal?: string | null;
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PROJECT_ACCEPTANCE_CRITERIA_CHARS)
  acceptanceCriteria?: string | null;
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PROJECT_INSTRUCTIONS_CHARS)
  instructions?: string | null;
  /** Where the work stands: OPEN, DONE (the goal was reached) or CANCELLED (it will not be). Not
   *  a filing state — moving a project out of somebody's way is a separate concern that must not
   *  be spelled by overwriting what happened to the work. */
  @IsOptional() @IsIn(PROJECT_STATUSES) status?: ProjectStatus;
}
