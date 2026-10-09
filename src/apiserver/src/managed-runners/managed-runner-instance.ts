import { ForbiddenException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { ManagedRunnerManagementState } from '@prisma/client';
import {
  MANAGED_RUNNER_GENERATION_HEADER,
  MANAGED_RUNNER_INSTANCE_CAPABILITY,
  MANAGED_RUNNER_INSTANCE_FENCED,
  MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED,
  MANAGED_RUNNER_INSTANCE_PENDING,
  MANAGED_RUNNER_INSTANCE_REQUIRED,
  MANAGED_RUNNER_INSTANCE_SUPERSEDED,
  MANAGED_RUNNER_POD_UID_HEADER,
  type ManagedRunnerReason,
} from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';

/**
 * Which instance of a managed runner may use its credential (docs/managed-runner-design.md,
 * "Identity and durable mapping" and "Single Pod and single writer protection").
 *
 * A managed runner's credential is issued for one generation, and a generation runs in exactly one
 * Pod, whose UID the manager records from the Kubernetes API once it has created it. Every request
 * made with that credential — heartbeat, claim, inbox poll, event batch, session lease operation,
 * and everything else the runner door serves — says which instance it comes from: the runner
 * declares MANAGED_RUNNER_INSTANCE_CAPABILITY and sends its generation and Pod UID. The runner
 * guards answer it here, before the handler runs:
 *
 *   no declaration, or a malformed one            403 MANAGED_RUNNER_INSTANCE_REQUIRED
 *   a generation below the mapping's              403 MANAGED_RUNNER_INSTANCE_SUPERSEDED (stop)
 *   a generation above it                         403 MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED
 *   the mapping FENCING, DELETING or DELETED      403 MANAGED_RUNNER_INSTANCE_FENCED (stop)
 *   no Pod recorded yet for the generation        503 MANAGED_RUNNER_INSTANCE_PENDING (retry)
 *   another Pod UID than the recorded one         403 MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED
 *
 * Only what the manager recorded authorizes: a heartbeat, a lease or the runner's own word never
 * does, and nothing here writes. A runner with no mapping — every self-managed runner — is not
 * asked anything, and whatever it sends is ignored; so an older runner keeps its protocol, and a
 * newer managed runner talking to an older server is simply not checked.
 *
 * Enforced whether or not ORBIT_MANAGED_RUNNERS_ENABLED is on, like the refusal to delete a managed
 * runner: turning management off freezes it, and must not hand a fenced or superseded instance its
 * credential back. It reads one row by its unique key and calls nothing else.
 */

/** The instance a request authenticated as, kept on the request for the handlers that re-check it. */
export interface ManagedRunnerInstance {
  mappingId: string;
  generation: number;
  podUid: string;
}

/** The fields of a mapping the decision reads. */
export interface ManagedRunnerInstanceRecord {
  id: string;
  generation: number;
  podUid: string | null;
  managementState: ManagedRunnerManagementState;
}

export type ManagedRunnerInstanceVerdict =
  | { authorized: true; instance: ManagedRunnerInstance }
  | { authorized: false; status: 403 | 503; reason: ManagedRunnerReason };

/** What a request says about the instance it comes from. */
export interface ManagedRunnerInstanceOffer {
  declared: boolean;
  generation: string | undefined;
  podUid: string | undefined;
}

/** No instance of the mapping is authorized in these states, whatever the request names. */
const REVOKED_STATES: ReadonlySet<ManagedRunnerManagementState> = new Set(['FENCING', 'DELETING', 'DELETED']);
/** …and in these, an authorized instance is not handed new work. */
const NO_CLAIM_STATES: ReadonlySet<ManagedRunnerManagementState> = new Set(['DRAINING']);

const GENERATION = /^[1-9][0-9]{0,9}$/;
const POD_UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

/** The offer in a request's headers. */
export function managedRunnerInstanceOffer(headers: Record<string, string | string[] | undefined>): ManagedRunnerInstanceOffer {
  const capabilities = headers['x-orbit-runner-capabilities'];
  const declared = (Array.isArray(capabilities) ? capabilities : capabilities === undefined ? [] : [capabilities])
    .some((value) => value.split(',').some((item) => item.trim().toLowerCase() === MANAGED_RUNNER_INSTANCE_CAPABILITY));
  return {
    declared,
    generation: one(headers[MANAGED_RUNNER_GENERATION_HEADER]),
    podUid: one(headers[MANAGED_RUNNER_POD_UID_HEADER])?.toLowerCase(),
  };
}

function refused(status: 403 | 503, code: string, message: string): ManagedRunnerInstanceVerdict {
  return { authorized: false, status, reason: { code, message, retryable: status === 503 } };
}

/** The decision, as a pure function of the mapping and the offer. */
export function managedRunnerInstanceVerdict(
  mapping: ManagedRunnerInstanceRecord,
  offer: ManagedRunnerInstanceOffer,
): ManagedRunnerInstanceVerdict {
  if (!offer.declared || !offer.generation || !GENERATION.test(offer.generation) || !offer.podUid || !POD_UID.test(offer.podUid)) {
    return refused(403, MANAGED_RUNNER_INSTANCE_REQUIRED,
      `This credential belongs to a managed runner. A request with it must declare ${MANAGED_RUNNER_INSTANCE_CAPABILITY} and name its generation and Pod UID; a runner that cannot is refused.`);
  }
  const generation = Number(offer.generation);
  if (generation < mapping.generation) {
    return refused(403, MANAGED_RUNNER_INSTANCE_SUPERSEDED,
      `Generation ${generation} of this managed runner has been replaced by generation ${mapping.generation}. This instance must stop; it is not authorized again.`);
  }
  if (generation > mapping.generation) {
    return refused(403, MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED, `Generation ${generation} of this managed runner was never authorized.`);
  }
  if (REVOKED_STATES.has(mapping.managementState)) {
    return refused(403, MANAGED_RUNNER_INSTANCE_FENCED,
      'This managed runner is being fenced: no instance of it is authorized until its previous instance is proven stopped.');
  }
  if (!mapping.podUid) {
    return refused(503, MANAGED_RUNNER_INSTANCE_PENDING, 'The manager has not recorded this instance yet; try again shortly.');
  }
  if (offer.podUid !== mapping.podUid.toLowerCase()) {
    return refused(403, MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED, `Pod ${offer.podUid} is not the instance authorized for generation ${generation}.`);
  }
  return { authorized: true, instance: { mappingId: mapping.id, generation, podUid: mapping.podUid } };
}

/** Whether an instance that authenticated may still be handed new work: re-read where work is handed out. */
export function managedRunnerInstanceClaimable(mapping: ManagedRunnerInstanceRecord | null, instance: ManagedRunnerInstance): boolean {
  if (!mapping || mapping.id !== instance.mappingId || NO_CLAIM_STATES.has(mapping.managementState)) return false;
  const verdict = managedRunnerInstanceVerdict(mapping, {
    declared: true,
    generation: String(instance.generation),
    podUid: instance.podUid,
  });
  return verdict.authorized;
}

function refusal(verdict: Extract<ManagedRunnerInstanceVerdict, { authorized: false }>): HttpException {
  return verdict.status === 503 ? new ServiceUnavailableException(verdict.reason) : new ForbiddenException(verdict.reason);
}

/**
 * The runner guards' step: undefined for a runner that is not managed, the authorized instance for
 * one that is, and a 403/503 refusal for anything else.
 */
export async function authorizeManagedRunnerInstance(
  prisma: Pick<PrismaService, 'managedRunner'>,
  runnerId: string,
  headers: Record<string, string | string[] | undefined>,
): Promise<ManagedRunnerInstance | undefined> {
  const mapping = await prisma.managedRunner.findUnique({
    where: { runnerId },
    select: { id: true, generation: true, podUid: true, managementState: true },
  });
  if (!mapping) return undefined;
  const verdict = managedRunnerInstanceVerdict(mapping, managedRunnerInstanceOffer(headers ?? {}));
  if (!verdict.authorized) throw refusal(verdict);
  return verdict.instance;
}

/** Re-read the mapping and refuse an instance that is no longer authorized (a long poll's later rounds). */
export async function reauthorizeManagedRunnerInstance(
  prisma: Pick<PrismaService, 'managedRunner'>,
  instance: ManagedRunnerInstance,
): Promise<void> {
  const mapping = await prisma.managedRunner.findUnique({
    where: { id: instance.mappingId },
    select: { id: true, generation: true, podUid: true, managementState: true },
  });
  const verdict = mapping
    ? managedRunnerInstanceVerdict(mapping, { declared: true, generation: String(instance.generation), podUid: instance.podUid })
    : refused(403, MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED, 'This managed runner has no mapping any more.');
  if (!verdict.authorized) throw refusal(verdict);
}
