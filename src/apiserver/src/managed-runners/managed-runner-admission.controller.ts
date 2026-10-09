import { timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  HttpCode,
  Inject,
  Injectable,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import { sha256 } from '../common/crypto.util';
import { MachineProtocol } from '../common/machine-protocol';
import { PrismaService } from '../prisma/prisma.service';
import {
  admissionReviewResponse,
  claimNamesOf,
  decidePodAdmission,
  type PodAdmissionDecision,
  type PodAdmissionMapping,
  type PodAdmissionRequest,
} from './managed-runner-admission';
import { MANAGED_RUNNER_GATE, managedRunnerDisabledError, type ManagedRunnerGate } from './managed-runner-gate';
import type { ManagedRunnerProfile } from './managed-runner-profile';
import { MANAGED_RUNNER_RUNTIME, type ManagedRunnerRuntime } from './managed-runner-runtime';
import { managedRunnerUnavailableReason } from './managed-runner-status';

/**
 * Who may call the admission webhook: the Kubernetes API server of the managed environment, with the
 * bearer token the profile holds the hash of (`admission.webhookTokenSha256`; the API server sends
 * it through its AdmissionConfiguration kubeconfig). Off, the route answers as a server without the
 * feature, 404; enabled without a valid profile, 503. The webhook is installed with
 * `failurePolicy: Fail`, so every one of these answers — like a timeout, a database error or Orbit
 * being down — refuses the Pod.
 */
@Injectable()
export class ManagedRunnerAdmissionGuard implements CanActivate {
  constructor(
    @Inject(MANAGED_RUNNER_GATE) private readonly gate: ManagedRunnerGate,
    @Inject(MANAGED_RUNNER_RUNTIME) private readonly runtime: ManagedRunnerRuntime | null,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.gate.enabled) throw managedRunnerDisabledError();
    if (!this.runtime?.available) throw new ServiceUnavailableException(managedRunnerUnavailableReason());
    const header: string | undefined = context.switchToHttp().getRequest().headers?.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const presented = Buffer.from(token ? sha256(token) : '', 'utf8');
    const expected = Buffer.from(this.runtime.profile.admission.webhookTokenSha256, 'utf8');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      throw new UnauthorizedException('the managed runner admission webhook needs its bearer token');
    }
    return true;
  }
}

/**
 * What the API server posts: an AdmissionReview. Its ids are Kubernetes UIDs and object names, never
 * Orbit's public ids, so no field of it is decoded.
 */
export interface AdmissionReviewBody {
  apiVersion?: unknown;
  kind?: unknown;
  request?: Record<string, unknown> | null;
}

/** The AdmissionReview body, checked only as far as the decision depends on it. */
function admissionRequest(review: AdmissionReviewBody | null | undefined): PodAdmissionRequest {
  const request = review?.request;
  if (review?.kind !== 'AdmissionReview' || review.apiVersion !== 'admission.k8s.io/v1' || !request || typeof request !== 'object') {
    throw new BadRequestException('expected an admission.k8s.io/v1 AdmissionReview with a request');
  }
  if (typeof request.uid !== 'string' || !request.uid || typeof request.operation !== 'string') {
    throw new BadRequestException('the AdmissionReview request needs its uid and operation');
  }
  return request as unknown as PodAdmissionRequest;
}

/**
 * The decision for one request, with each claim it names resolved to its mapping in the database:
 * ownership comes from the mapping, never from the Pod's labels. A failed read throws, which the
 * API server, with `failurePolicy: Fail`, takes as a refusal.
 */
export async function reviewPodAdmission(
  prisma: Pick<PrismaService, 'managedRunner'>,
  profile: ManagedRunnerProfile,
  request: PodAdmissionRequest,
): Promise<PodAdmissionDecision> {
  const claims = [...new Set([...claimNamesOf(request.object), ...claimNamesOf(request.oldObject)])];
  const rows = claims.length && request.namespace === profile.kubernetes.namespace
    ? await prisma.managedRunner.findMany({
      where: { clusterKey: profile.clusterKey, namespace: profile.kubernetes.namespace, pvcName: { in: claims } },
      select: {
        ownerId: true,
        runnerId: true,
        generation: true,
        pvcName: true,
        pvcUid: true,
        podUid: true,
        managementState: true,
        resourceOperationKind: true,
        resourceOperationState: true,
      },
    })
    : [];
  const mappings = new Map<string, PodAdmissionMapping | null>(claims.map((name) => [name, null]));
  for (const row of rows) mappings.set(row.pvcName, row);
  return decidePodAdmission(request, mappings, {
    namespace: profile.kubernetes.namespace,
    managerUsername: profile.admission.managerUsername,
    image: profile.runner.image,
  });
}

/**
 * POST /api/managed-runner/admission — the single-Pod admission webhook
 * (managed-runner-admission.ts). Raw ids both ways (`@MachineProtocol()`): the answer echoes the
 * request's `uid` exactly. 200 with `allowed` true or false is a decision; anything else is the
 * webhook failing, which the API server turns into a refusal.
 */
@MachineProtocol()
@UseGuards(ManagedRunnerAdmissionGuard)
@Controller('managed-runner/admission')
export class ManagedRunnerAdmissionController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(MANAGED_RUNNER_RUNTIME) private readonly runtime: ManagedRunnerRuntime | null,
  ) {}

  @Post()
  @HttpCode(200)
  async review(@Body() body: AdmissionReviewBody) {
    const request = admissionRequest(body);
    const runtime = this.runtime;
    if (!runtime?.available) throw new ServiceUnavailableException(managedRunnerUnavailableReason());
    return admissionReviewResponse(request.uid, await reviewPodAdmission(this.prisma, runtime.profile, request));
  }
}
