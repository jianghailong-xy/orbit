import { IsBoolean, IsInt, IsOptional, IsString, Length, Matches, Min } from 'class-validator';
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

/**
 * An administrator's switch of a managed runner's data volume to a restored one
 * (POST /api/admin/managed-runners/:id/volume-switch, managed-runner-volume-switch.ts). The volume is the one under
 * the runner's fixed name in the managed namespace, named here by the UID the administrator verified: no name or
 * namespace a request carries can point the runner at another account's volume.
 */
export class ManagedRunnerVolumeSwitchDto {
  @IsString()
  @Length(1, 200)
  idempotencyKey!: string;

  /** The mapping's revision as the administrator read it. */
  @IsInt()
  @Min(1)
  revision!: number;

  /** The restored volume's own UID (on Kubernetes the claim's), as verified: a Kubernetes UID, not an Orbit id. */
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, { message: 'volumeUid must be the restored volume\'s UID' })
  volumeUid!: string;

  /** That the recorded volume is to be replaced although the manager has not found it missing (FAILED PVC_MISSING). */
  @IsOptional()
  @IsBoolean()
  confirmReplacement?: boolean;

  /** Why, in the administrator's words: kept in the audit record. */
  @IsString()
  @Length(1, 500)
  reason!: string;
}
