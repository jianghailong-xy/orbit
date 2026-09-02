import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';

/**
 * Generated values from contracts/runner-write-protocol.json.
 *
 * The bootstrap acceptance suite hashes that file and compares both language implementations to
 * these values.  Keeping the digest beside the revision makes "same binary version" insufficient
 * evidence of wire compatibility: a locally rebuilt CLI with a different contract is refused.
 */
export const RUNNER_WRITE_CAPABILITY_REVISION = 2;
export const RUNNER_WRITE_SCHEMA_REVISION = 2;
export const RUNNER_WRITE_MINIMUM_CAPABILITY_REVISION = 1;
export const RUNNER_WRITE_MINIMUM_SCHEMA_REVISION = 1;
export const RUNNER_WRITE_CONTRACT_DIGEST =
  'bbdd980c70dc56bfd09dfc311c41b3fdff8727912642ee4f529d8ddf36d3a696';
export const RUNNER_WRITE_LEGACY_CONTRACT_DIGEST = 'runner-write-v1';

export const RUNNER_WRITE_HEADERS = {
  capabilityRevision: 'x-orbit-runner-capability-revision',
  schemaRevision: 'x-orbit-runner-schema-revision',
  contractDigest: 'x-orbit-runner-contract-digest',
  cliVersion: 'x-orbit-cli-version',
} as const;

export const RUNNER_WRITE_RESPONSE_HEADERS = {
  capabilityRevision: 'X-Orbit-Server-Capability-Revision',
  schemaRevision: 'X-Orbit-Server-Schema-Revision',
  contractDigest: 'X-Orbit-Server-Contract-Digest',
} as const;

export type RunnerWriteProtocolMode = 'CURRENT' | 'LEGACY_N_MINUS_ONE';

export interface RunnerWriteProtocolOffer {
  capabilityRevision?: string | string[];
  schemaRevision?: string | string[];
  contractDigest?: string | string[];
  cliVersion?: string | string[];
}

export interface RunnerWriteProtocolAgreement {
  mode: RunnerWriteProtocolMode;
  capabilityRevision: number;
  schemaRevision: number;
  contractDigest: string;
}

export interface RunnerWriteProtocolRefusal {
  code:
    | 'RUNNER_PROTOCOL_REVISION_INCOMPLETE'
    | 'RUNNER_PROTOCOL_REVISION_INVALID'
    | 'RUNNER_PROTOCOL_REVISION_UNSUPPORTED'
    | 'RUNNER_PROTOCOL_CONTRACT_MISMATCH';
  kind: 'REFUSAL';
  message: string;
  requiredAction: 'UPGRADE_OR_ROLL_BACK_ORBIT_CLI';
  cliVersion: string | null;
  offered: {
    capabilityRevision: string | null;
    schemaRevision: string | null;
    contractDigest: string | null;
  };
  supported: {
    minimumCapabilityRevision: number;
    capabilityRevision: number;
    minimumSchemaRevision: number;
    schemaRevision: number;
    contractDigest: string;
  };
}

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '').trim() : (value ?? '').trim();
}

function refusal(
  code: RunnerWriteProtocolRefusal['code'],
  offer: RunnerWriteProtocolOffer,
  message: string,
): RunnerWriteProtocolRefusal {
  return {
    code,
    kind: 'REFUSAL',
    message,
    requiredAction: 'UPGRADE_OR_ROLL_BACK_ORBIT_CLI',
    cliVersion: one(offer.cliVersion) || null,
    offered: {
      capabilityRevision: one(offer.capabilityRevision) || null,
      schemaRevision: one(offer.schemaRevision) || null,
      contractDigest: one(offer.contractDigest) || null,
    },
    supported: {
      minimumCapabilityRevision: RUNNER_WRITE_MINIMUM_CAPABILITY_REVISION,
      capabilityRevision: RUNNER_WRITE_CAPABILITY_REVISION,
      minimumSchemaRevision: RUNNER_WRITE_MINIMUM_SCHEMA_REVISION,
      schemaRevision: RUNNER_WRITE_SCHEMA_REVISION,
      contractDigest: RUNNER_WRITE_CONTRACT_DIGEST,
    },
  };
}

/**
 * Negotiate one runner write.  A completely headerless client is the deployed N-1 shape and is
 * admitted to the field translator below.  Once a client advertises a revision, ambiguity is no
 * longer compatibility: current revisions require the exact digest, and unknown tuples fail
 * closed with a stable machine-readable refusal.
 */
export function negotiateRunnerWriteProtocol(
  offer: RunnerWriteProtocolOffer,
): RunnerWriteProtocolAgreement | RunnerWriteProtocolRefusal {
  const capabilityText = one(offer.capabilityRevision);
  const schemaText = one(offer.schemaRevision);
  const digest = one(offer.contractDigest);

  if (!capabilityText && !schemaText && !digest) {
    return {
      mode: 'LEGACY_N_MINUS_ONE',
      capabilityRevision: 1,
      schemaRevision: 1,
      contractDigest: RUNNER_WRITE_LEGACY_CONTRACT_DIGEST,
    };
  }
  if (!capabilityText || !schemaText) {
    return refusal(
      'RUNNER_PROTOCOL_REVISION_INCOMPLETE',
      offer,
      'Runner writes must advertise capability and schema revisions together.',
    );
  }
  if (!/^\d+$/.test(capabilityText) || !/^\d+$/.test(schemaText)) {
    return refusal(
      'RUNNER_PROTOCOL_REVISION_INVALID',
      offer,
      'Runner capability and schema revisions must be positive decimal integers.',
    );
  }
  const capabilityRevision = Number(capabilityText);
  const schemaRevision = Number(schemaText);
  if (capabilityRevision === 1 && schemaRevision === 1) {
    if (digest && digest !== RUNNER_WRITE_LEGACY_CONTRACT_DIGEST) {
      return refusal(
        'RUNNER_PROTOCOL_CONTRACT_MISMATCH',
        offer,
        'The N-1 runner revision is known, but its advertised contract digest is not.',
      );
    }
    return {
      mode: 'LEGACY_N_MINUS_ONE',
      capabilityRevision,
      schemaRevision,
      contractDigest: digest || RUNNER_WRITE_LEGACY_CONTRACT_DIGEST,
    };
  }
  if (
    capabilityRevision !== RUNNER_WRITE_CAPABILITY_REVISION
    || schemaRevision !== RUNNER_WRITE_SCHEMA_REVISION
  ) {
    return refusal(
      'RUNNER_PROTOCOL_REVISION_UNSUPPORTED',
      offer,
      'This server accepts only its current runner write contract and the explicit N-1 contract.',
    );
  }
  if (digest !== RUNNER_WRITE_CONTRACT_DIGEST) {
    return refusal(
      'RUNNER_PROTOCOL_CONTRACT_MISMATCH',
      offer,
      'Runner and server claim the same revision but describe different write contracts.',
    );
  }
  return {
    mode: 'CURRENT',
    capabilityRevision,
    schemaRevision,
    contractDigest: digest,
  };
}

type CompletionDeclaration = {
  completionCriterion?: string | null;
  acceptanceCommand?: string | null;
  acceptanceExpectedExitCode?: number | null;
  completionPolicy?: string | null;
  verifiesTaskId?: string | null;
};

/** Translate only legacy declarations whose intent is unambiguous; omission never means human. */
export function translateLegacyRunnerCompletionDeclaration<T extends CompletionDeclaration>(
  declaration: T,
  itemIndex?: number,
): T {
  if (declaration.completionCriterion != null) return declaration;
  const subject = itemIndex == null ? 'task' : `tasks[${itemIndex}]`;
  const command = declaration.acceptanceCommand ?? null;
  const exitCode = declaration.acceptanceExpectedExitCode ?? null;
  if (command != null || exitCode != null) {
    if (command == null || exitCode == null) {
      throw new BadRequestException({
        code: 'RUNNER_LEGACY_COMPLETION_SHAPE_INVALID',
        kind: 'REFUSAL',
        itemIndex: itemIndex ?? null,
        requiredAction: 'SEND_BOTH_EXECUTABLE_ACCEPTANCE_FIELDS',
        message: `${subject} must send acceptanceCommand and acceptanceExpectedExitCode together.`,
      });
    }
    declaration.completionCriterion = 'EXECUTABLE';
    return declaration;
  }
  if (
    declaration.verifiesTaskId != null
    || declaration.completionPolicy === 'VERIFICATION_PASSED'
  ) {
    declaration.completionCriterion = 'VERIFICATION';
    return declaration;
  }
  throw new BadRequestException({
    code: 'RUNNER_COMPLETION_CRITERION_REQUIRED',
    kind: 'REFUSAL',
    itemIndex: itemIndex ?? null,
    requiredAction: 'DECLARE_COMPLETION_CRITERION_EXPLICITLY',
    message:
      `${subject}.completionCriterion is required at the runner boundary; omission is never `
      + 'translated to EVIDENCE_JUDGMENT.',
  });
}

@Injectable()
export class RunnerWriteProtocolInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<{
      method?: string;
      headers?: Record<string, string | string[] | undefined>;
    }>();
    const response = http.getResponse<{ setHeader(name: string, value: string): void }>();
    response.setHeader(
      RUNNER_WRITE_RESPONSE_HEADERS.capabilityRevision,
      String(RUNNER_WRITE_CAPABILITY_REVISION),
    );
    response.setHeader(
      RUNNER_WRITE_RESPONSE_HEADERS.schemaRevision,
      String(RUNNER_WRITE_SCHEMA_REVISION),
    );
    response.setHeader(RUNNER_WRITE_RESPONSE_HEADERS.contractDigest, RUNNER_WRITE_CONTRACT_DIGEST);

    if (!['GET', 'HEAD', 'OPTIONS'].includes((request.method ?? '').toUpperCase())) {
      const headers = request.headers ?? {};
      const agreement = negotiateRunnerWriteProtocol({
        capabilityRevision: headers[RUNNER_WRITE_HEADERS.capabilityRevision],
        schemaRevision: headers[RUNNER_WRITE_HEADERS.schemaRevision],
        contractDigest: headers[RUNNER_WRITE_HEADERS.contractDigest],
        cliVersion: headers[RUNNER_WRITE_HEADERS.cliVersion],
      });
      if ('code' in agreement) throw new ConflictException(agreement);
    }
    return next.handle();
  }
}
