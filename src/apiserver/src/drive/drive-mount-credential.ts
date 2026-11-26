import {
  createParamDecorator,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
  SetMetadata,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { MANAGED_RUNNER_INSTANCE_FENCED } from '@orbit/shared';
import type { ManagedRunnerManagementState, Prisma, Runner } from '@prisma/client';
import { generateToken, sha256 } from '../common/crypto.util';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import {
  managedRunnerInstanceOffer,
  managedRunnerInstanceVerdict,
  type ManagedRunnerInstance,
} from '../managed-runners/managed-runner-instance';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The mount credential (docs/drive-technical-design.md §4.3, §8.2): what the mount daemon of one
 * managed-runner generation presents at /runner/drive/* (or its /runner/documents/* alias), and nowhere else.
 *
 *   - Issued per generation, beside that generation's runner credential; issuing one revokes every older generation's
 *     credential of the runner. Only the sha256 of the token is kept.
 *   - Accepted only by a controller marked AcceptsDriveMountCredential (the runner drive door); RunnerAuthGuard refuses it
 *     on every other route.
 *   - Every request also names its generation and instance UID, held to the runner guard's rules
 *     (managed-runner-instance.ts) with the credential's own generation: a generation below the mapping's answers
 *     403 MANAGED_RUNNER_INSTANCE_SUPERSEDED, a fenced or deleted mapping 403 …_FENCED, another instance UID
 *     403 …_NOT_AUTHORIZED, an instance the manager has not recorded yet 503 …_PENDING.
 *
 * The mount credential never enters the user's container, and the runner credential never enters the mounter (§6).
 */

const logger = new Logger('DriveMountCredential');

/** Every mount credential starts so, which is how RunnerAuthGuard tells it from a runner credential without a lookup. */
export const DRIVE_MOUNT_TOKEN_PREFIX = 'orbit_drive_mount_';

/** The metadata AcceptsDriveMountCredential sets on a controller. */
export const ACCEPTS_DRIVE_MOUNT_CREDENTIAL = 'orbit:accepts-drive-mount-credential';

/** A runner controller whose routes the mount daemon may call with its mount credential: the runner drive door only. */
export const AcceptsDriveMountCredential = (): ClassDecorator => SetMetadata(ACCEPTS_DRIVE_MOUNT_CREDENTIAL, true);

export const DRIVE_MOUNT_CREDENTIAL_REFUSED = 'DRIVE_MOUNT_CREDENTIAL_REFUSED';
export const DRIVE_MOUNT_CREDENTIAL_OUTSIDE_DRIVE = 'DRIVE_MOUNT_CREDENTIAL_OUTSIDE_DRIVE';

/** Which mount credential a request authenticated with, kept on the request beside the runner and its instance. */
export interface DriveMount {
  credentialId: string;
  generation: number;
}

/** The mount credential a request authenticated with, or undefined for the runner credential. */
export const CurrentDriveMount = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): DriveMount | undefined => ctx.switchToHttp().getRequest().driveMount as DriveMount | undefined,
);

export function isDriveMountToken(token: string): boolean {
  return token.startsWith(DRIVE_MOUNT_TOKEN_PREFIX);
}

/** The refusal of a mount credential on a route outside the drive door. */
export function driveMountCredentialOutsideDrive(): UnauthorizedException {
  return new UnauthorizedException({
    code: DRIVE_MOUNT_CREDENTIAL_OUTSIDE_DRIVE,
    message: 'A drive mount credential is accepted only by /runner/drive/*.',
  });
}

/**
 * A new mount credential for generation `generation` of `runnerId`'s managed runner, answered once as the token; every
 * credential of an older generation of the runner is revoked in the same transaction.
 */
export async function issueDriveMountCredential(
  prisma: PrismaService,
  input: { ownerId: string; runnerId: string; generation: number },
): Promise<{ id: string; token: string }> {
  // Made once, outside the transaction: a retried attempt inserts the same hash, the first having rolled back.
  const token = `${DRIVE_MOUNT_TOKEN_PREFIX}${generateToken(32)}`;
  const now = new Date();
  const created = await withTransactionRetry(prisma, async (tx: Prisma.TransactionClient) => {
    await tx.driveMountCredential.updateMany({
      where: { runnerId: input.runnerId, generation: { lt: input.generation }, revokedAt: null },
      data: { revokedAt: now },
    });
    return tx.driveMountCredential.create({
      data: { ownerId: input.ownerId, runnerId: input.runnerId, generation: input.generation, tokenHash: sha256(token), createdAt: now },
      select: { id: true },
    });
  }, loggedRetry(logger, 'drive.issueMountCredential'));
  return { id: created.id, token };
}

/** Every live mount credential of a runner's generations below `generation`, revoked: what retiring a generation does. */
export async function revokeDriveMountCredentials(
  prisma: Pick<PrismaService, 'driveMountCredential'>,
  runnerId: string,
  belowGeneration: number,
): Promise<number> {
  const { count } = await prisma.driveMountCredential.updateMany({
    where: { runnerId, generation: { lt: belowGeneration }, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count;
}

/**
 * The runner and instance a mount credential speaks for, or the refusal: an unknown or revoked token is 401; the
 * runner's owner disabled is the caller's `admit` to refuse; then the instance is held to the runner guard's rules with
 * the credential's generation, which the request must also name.
 */
export async function authorizeDriveMount(
  prisma: Pick<PrismaService, 'driveMountCredential' | 'managedRunner'>,
  token: string,
  headers: Record<string, string | string[] | undefined>,
  admit: (runner: Runner & { owner: { disabledAt: Date | null } }) => Runner,
): Promise<{ runner: Runner; instance: ManagedRunnerInstance; mount: DriveMount }> {
  const credential = await prisma.driveMountCredential.findUnique({
    where: { tokenHash: sha256(token) },
    include: { runner: { include: { owner: { select: { disabledAt: true } } } } },
  });
  if (!credential || credential.revokedAt) {
    throw new UnauthorizedException({ code: DRIVE_MOUNT_CREDENTIAL_REFUSED, message: 'This drive mount credential is not valid.' });
  }
  const runner = admit(credential.runner);
  const mapping = await prisma.managedRunner.findUnique({
    where: { runnerId: credential.runnerId },
    select: { id: true, generation: true, podUid: true, managementState: true },
  });
  if (!mapping) {
    throw new ForbiddenException({
      code: MANAGED_RUNNER_INSTANCE_FENCED,
      message: 'This managed runner is gone: no instance of it is authorized.',
      retryable: false,
    });
  }
  const offer = managedRunnerInstanceOffer(headers ?? {});
  if (offer.generation !== undefined && offer.generation !== String(credential.generation)) {
    throw new ForbiddenException({
      code: 'MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED',
      message: `This mount credential was issued for generation ${credential.generation}, not ${offer.generation}.`,
      retryable: false,
    });
  }
  const verdict = managedRunnerInstanceVerdict(mapping, offer);
  if (!verdict.authorized) {
    throw verdict.status === 503 ? new ServiceUnavailableException(verdict.reason) : new ForbiddenException(verdict.reason);
  }
  return { runner, instance: verdict.instance, mount: { credentialId: credential.id, generation: credential.generation } };
}

/**
 * The commit fence (§8.2): inside the commit's own transaction, the mapping read FOR SHARE and the instance held to it
 * again, so a commit racing a generation change lands before the change or is refused.
 */
export async function fenceManagedInstance(tx: Prisma.TransactionClient, instance: ManagedRunnerInstance): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string; generation: number; pod_uid: string | null; management_state: string }>>`
    SELECT "id", "generation", "pod_uid", "management_state" FROM "managed_runner" WHERE "id" = ${instance.mappingId}::uuid FOR SHARE`;
  const mapping = rows[0];
  if (!mapping) {
    throw new ForbiddenException({ code: MANAGED_RUNNER_INSTANCE_FENCED, message: 'This managed runner is gone.', retryable: false });
  }
  const verdict = managedRunnerInstanceVerdict(
    { id: mapping.id, generation: mapping.generation, podUid: mapping.pod_uid, managementState: mapping.management_state as ManagedRunnerManagementState },
    { declared: true, generation: String(instance.generation), podUid: instance.podUid },
  );
  if (!verdict.authorized) {
    throw verdict.status === 503 ? new ServiceUnavailableException(verdict.reason) : new ForbiddenException(verdict.reason);
  }
}

