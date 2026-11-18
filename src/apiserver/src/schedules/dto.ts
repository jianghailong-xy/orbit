/**
 * The bodies the schedule doors take. The service validates every field itself (schedules.service.ts); these
 * declare what passes the global whitelist, nothing more. There is no REST body that creates or changes a schedule:
 * those come only from a session's tools (`ScheduleCreateDto`, `ScheduleUpdateDto` are the runner doors').
 */
import { IsPublicId } from '../common/public-id';
import { IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, Min, ValidateIf } from 'class-validator';

export class ScheduleCreateDto {
  @IsString() @MaxLength(4000) intent!: string;
  @IsString() @MaxLength(200) title!: string;
  @IsString() @MaxLength(20000) prompt!: string;
  @IsObject() rule!: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(100) timezone?: string;
  @IsIn(['CHECK_ONLY', 'OPEN_PR', 'LAND']) accessLevel!: 'CHECK_ONLY' | 'OPEN_PR' | 'LAND';
  @IsOptional() @IsInt() @Min(1) runLimitMinutes?: number;
  @IsOptional() @IsDateString() endAt?: string;
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

export class ScheduleUndoDto {
  @IsInt() @Min(2) revision!: number;
}

/** The owner's press on a card. `timezone` is the pressing device's, taken only by a create card that names none. */
export class ScheduleDecisionDto {
  @IsOptional() @IsString() @MaxLength(100) timezone?: string;
}

/** The Scheduled page's quick-add line (§8.1): a sentence, and the workspace the line shows. */
export class ScheduleDraftDto {
  @IsPublicId() workspaceId!: string;
  @IsString() @MaxLength(4000) text!: string;
}
