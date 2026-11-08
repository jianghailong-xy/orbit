import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';

/**
 * Generated values from contracts/runner-write-protocol.json, whose digest the release manifest and the runner's
 * self-update check (src/runner-go/selfupdate.go). This server neither reads nor sends it: a client still sends
 * x-orbit-runner-contract-digest beside its revisions, because a server older than this one refuses revisions without it.
 */
export const RUNNER_WRITE_CAPABILITY_REVISION = 2;
export const RUNNER_WRITE_SCHEMA_REVISION = 2;
export const RUNNER_WRITE_MINIMUM_CAPABILITY_REVISION = 1;
export const RUNNER_WRITE_MINIMUM_SCHEMA_REVISION = 1;

export const RUNNER_WRITE_HEADERS = {
  capabilityRevision: 'x-orbit-runner-capability-revision',
  schemaRevision: 'x-orbit-runner-schema-revision',
  cliVersion: 'x-orbit-cli-version',
} as const;

export const RUNNER_WRITE_RESPONSE_HEADERS = {
  capabilityRevision: 'X-Orbit-Server-Capability-Revision',
  schemaRevision: 'X-Orbit-Server-Schema-Revision',
} as const;

export type RunnerWriteProtocolMode = 'CURRENT' | 'LEGACY_N_MINUS_ONE';

export interface RunnerWriteProtocolOffer {
  capabilityRevision?: string | string[];
  schemaRevision?: string | string[];
  cliVersion?: string | string[];
}

export interface RunnerWriteProtocolAgreement {
  mode: RunnerWriteProtocolMode;
  capabilityRevision: number;
  schemaRevision: number;
}

export interface RunnerWriteProtocolRefusal {
  code:
    | 'RUNNER_PROTOCOL_REVISION_INCOMPLETE'
    | 'RUNNER_PROTOCOL_REVISION_INVALID'
    | 'RUNNER_PROTOCOL_REVISION_UNSUPPORTED';
  kind: 'REFUSAL';
  message: string;
  requiredAction: 'UPGRADE_OR_ROLL_BACK_ORBIT_CLI';
  cliVersion: string | null;
  offered: {
    capabilityRevision: string | null;
    schemaRevision: string | null;
  };
  supported: {
    minimumCapabilityRevision: number;
    capabilityRevision: number;
    minimumSchemaRevision: number;
    schemaRevision: number;
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
    },
    supported: {
      minimumCapabilityRevision: RUNNER_WRITE_MINIMUM_CAPABILITY_REVISION,
      capabilityRevision: RUNNER_WRITE_CAPABILITY_REVISION,
      minimumSchemaRevision: RUNNER_WRITE_MINIMUM_SCHEMA_REVISION,
      schemaRevision: RUNNER_WRITE_SCHEMA_REVISION,
    },
  };
}

/**
 * Negotiate one runner write.  A completely headerless client is the deployed N-1 shape and is
 * admitted to the field translator below.  Once a client advertises a revision, ambiguity is no
 * longer compatibility: unknown tuples fail closed with a stable machine-readable refusal.
 */
export function negotiateRunnerWriteProtocol(
  offer: RunnerWriteProtocolOffer,
): RunnerWriteProtocolAgreement | RunnerWriteProtocolRefusal {
  const capabilityText = one(offer.capabilityRevision);
  const schemaText = one(offer.schemaRevision);

  if (!capabilityText && !schemaText) {
    return { mode: 'LEGACY_N_MINUS_ONE', capabilityRevision: 1, schemaRevision: 1 };
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
    return { mode: 'LEGACY_N_MINUS_ONE', capabilityRevision, schemaRevision };
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
  return { mode: 'CURRENT', capabilityRevision, schemaRevision };
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

    if (!['GET', 'HEAD', 'OPTIONS'].includes((request.method ?? '').toUpperCase())) {
      const headers = request.headers ?? {};
      const agreement = negotiateRunnerWriteProtocol({
        capabilityRevision: headers[RUNNER_WRITE_HEADERS.capabilityRevision],
        schemaRevision: headers[RUNNER_WRITE_HEADERS.schemaRevision],
        cliVersion: headers[RUNNER_WRITE_HEADERS.cliVersion],
      });
      if ('code' in agreement) throw new ConflictException(agreement);
    }
    return next.handle();
  }
}
