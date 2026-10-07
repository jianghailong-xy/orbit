import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';
import type { ManagedRunnerWriteRequest } from '@orbit/shared';

/**
 * The body of every managed runner write. It names no runner, workspace, PVC or node: the mapping
 * is always the caller's own, so nothing a request carries can point at another account's.
 */
export class ManagedRunnerWriteDto implements ManagedRunnerWriteRequest {
  @IsString()
  @Length(1, 200)
  idempotencyKey!: string;

  /** The revision the caller read; required by retry, sleep and delete. */
  @IsOptional()
  @IsInt()
  @Min(1)
  revision?: number;
}
