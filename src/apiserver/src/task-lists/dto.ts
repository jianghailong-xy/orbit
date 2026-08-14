import { IsBoolean, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class CreateTaskListDto {
  @IsString()
  @MinLength(1)
  title!: string;
}

export class UpdateTaskListDto {
  @IsOptional() @IsString() @MinLength(1) title?: string;
  /** Emergency stop: holds back this list's dispatch without touching runs already in flight. */
  @IsOptional() @IsBoolean() paused?: boolean;
  /**
   * Cap on this list's concurrently RUNNING task sessions; null clears it (uncapped). The
   * ceiling matches the runner's own `maxConcurrent` bound — a per-list cap above the machine's
   * is not a cap at all.
   */
  @IsOptional() @IsInt() @Min(1) @Max(64) maxConcurrent?: number | null;
}
