/**
 * The bodies the schedule doors take. The service validates every field itself (schedules.service.ts); these
 * declare what passes the global whitelist, nothing more. No REST body creates or changes a schedule but its name
 * (`ScheduleRenameDto`): the rest comes only from a session's tools (`ScheduleCreateDto`, `ScheduleUpdateDto` are the
 * runner doors').
 */
import { IsPublicId } from '../common/public-id';
import { IsBoolean, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, Min, ValidateIf } from 'class-validator';

export class ScheduleCreateDto {
  @IsString() @MaxLength(4000) intent!: string;
  @IsString() @MaxLength(200) title!: string;
  @IsString() @MaxLength(20000) prompt!: string;
  @IsObject() rule!: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(100) timezone?: string;
  @IsIn(['CHECK_ONLY', 'OPEN_PR', 'LAND']) accessLevel!: 'CHECK_ONLY' | 'OPEN_PR' | 'LAND';
  @IsOptional() @IsInt() @Min(1) runLimitMinutes?: number;
  @IsOptional() @IsDateString() endAt?: string;
  /** The planned end by count of started runs (§8.5). */
  @IsOptional() @IsInt() @Min(1) maxRuns?: number;
  @IsOptional() @IsString() @MaxLength(500) readBack?: string;
  @IsOptional() @IsString() @MaxLength(60) findings?: string;
  @IsOptional() @IsObject() baseline?: { key: string; summary?: string; links?: string[] };
}

export class ScheduleUpdateDto {
  @IsOptional() @IsString() @MaxLength(4000) intent?: string;
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(20000) prompt?: string;
  @IsOptional() @IsObject() rule?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(100) timezone?: string;
  /** null clears it. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() endAt?: string | null;
  /** null clears it; at or below the runs already started is refused (SCHEDULE_MAX_RUNS_ALREADY_REACHED). */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) maxRuns?: number | null;
  @IsOptional() @IsIn(['CHECK_ONLY', 'OPEN_PR', 'LAND']) accessLevel?: 'CHECK_ONLY' | 'OPEN_PR' | 'LAND';
  @IsOptional() @IsInt() @Min(1) runLimitMinutes?: number;
  /** The schedule read back as it is after this change; a rule change without one leaves the read to derive it. */
  @IsOptional() @IsString() @MaxLength(500) readBack?: string;
  /** Another workspace of the owner's: always outside the envelope, so it waits on a card. */
  @IsOptional() @IsPublicId() workspaceId?: string;
}

export class ScheduleRunReportDto {
  @IsIn(['NO_CHANGE', 'CHANGED', 'FAILED']) outcome!: 'NO_CHANGE' | 'CHANGED' | 'FAILED';
  @IsOptional() @IsString() @MaxLength(500) key?: string;
  @IsString() @MaxLength(4000) summary!: string;
  @IsOptional() @IsString({ each: true }) links?: string[];
  /** Replaces the schedule's note; null clears it. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() note?: string | null;
}

/** Rename (§8.4): the one change a surface makes directly, and the title is all it carries. */
export class ScheduleRenameDto {
  @IsString() @MaxLength(200) title!: string;
}

export class ScheduleUndoDto {
  @IsInt() @Min(2) revision!: number;
}

/**
 * The owner's press on a card. `timezone` is the pressing device's, taken only by a create card that names none.
 * `dropSuggestedEnd` is the create card's No end (§8.5): Create writes no end instead of the suggested one.
 */
export class ScheduleDecisionDto {
  @IsOptional() @IsString() @MaxLength(100) timezone?: string;
  @IsOptional() @IsBoolean() dropSuggestedEnd?: boolean;
}

/** The Scheduled page's quick-add line (§8.1): a sentence, and the workspace the line shows. */
/** A change conversation's first words (§8.2). */
export class ScheduleChangeDto {
  @IsString() @MaxLength(4000) text!: string;
}

export class ScheduleDraftDto {
  @IsPublicId() workspaceId!: string;
  @IsString() @MaxLength(4000) text!: string;
}
