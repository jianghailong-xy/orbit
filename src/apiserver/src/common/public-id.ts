import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
  applyDecorators,
} from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsUUID, ValidationOptions } from 'class-validator';
import { toUuid } from '@orbit/shared';

/**
 * THE RULE, in one place: every id a caller supplies is a *public id* — either the base62 short
 * form the clients put in URLs (`/sessions/343dlzsYWKo5z8l2M8tsB`) or the raw UUID. Both resolve
 * to the UUID the `@db.Uuid` columns key by; anything else is a 400 that names the field.
 *
 * Without it the id reaches Prisma as-is and a caller who pasted a link gets a bare 500 —
 * P2023 `Inconsistent column data`, or `invalid input syntax for type uuid` from the raw-SQL
 * list queries — with nothing to act on.
 *
 * Why this is DECLARED at each id rather than inferred globally from the field name: the wire
 * is full of id-named fields that are not public ids and would break if normalized —
 * `clientTurnId` (a free-form idempotency key), `toolUseId` (`toolu_01…`), `bundleId`
 * (`com.orbit.ios`), `operationId` / `requestId` (opaque attempt tokens), `limitId` (a Codex
 * rate-limit bucket name), `runtimeSessionId` / `claudeSessionId` (the engine's own id). Several
 * ride the runner protocol, where a wrong 400 would break already-installed runners.
 *
 * One class covers all three positions, and which one it is decides required-vs-optional — so
 * the distinction can't be got wrong by reaching for the wrong pipe:
 *   `@Param('id', PublicIdPipe)`                     — required; an empty segment is a 400
 *   `@Query('workspaceId', PublicIdPipe)`                — optional; absent stays absent
 *   `@Body(PublicIdPipe.forFields('workspaceId')) dto: T`    — for bodies class-validator never sees
 * DTO *classes* declare it as a field decorator instead: `@IsPublicId()`.
 */
@Injectable()
export class PublicIdPipe implements PipeTransform<unknown, unknown> {
  /** Body field names to normalize; unset for a scalar param/query.
   *
   *  Deliberately NOT a constructor parameter. `@Param('id', PublicIdPipe)` hands Nest the
   *  CLASS, and Nest instantiates it through the DI container — a constructor arg there is a
   *  dependency it must resolve, so a `string[]` parameter makes every route using the class
   *  form fail at boot with "can't resolve dependencies of the PublicIdPipe (?)". Keeping the
   *  constructor empty is what lets one class serve both forms. */
  private fields?: readonly string[];

  /** Body form: `@Body(PublicIdPipe.forFields('workspaceId'))`. */
  static forFields(...fields: string[]): PublicIdPipe {
    const pipe = new PublicIdPipe();
    pipe.fields = fields;
    return pipe;
  }

  transform(value: unknown, metadata?: ArgumentMetadata): unknown {
    if (this.fields) return this.normalizeFields(value);
    // A route param is part of the address: `undefined` here would reach Prisma as "no filter"
    // and match an arbitrary row, so an empty one has to be refused. A query is a filter, and
    // an absent filter is a legitimate request for the unfiltered list.
    if (!isPresent(value)) {
      if (metadata?.type === 'query') return undefined;
      throw new BadRequestException(`invalid ${metadata?.data ?? 'id'}`);
    }
    return resolve(value, metadata?.data);
  }

  /** Only the listed fields are touched, so this adds no whitelisting the DTO didn't ask for
   *  and can't silently drop a field an older client still sends. */
  private normalizeFields(body: unknown): unknown {
    if (!body || typeof body !== 'object') return body;
    const record = body as Record<string, unknown>;
    for (const field of this.fields!) {
      if (!isPresent(record[field])) continue;
      record[field] = resolve(record[field], field);
    }
    return body;
  }
}

/** The same rule bound for class-validator, for the DTO classes the global ValidationPipe does
 *  see. Normalizes first, then validates; an undecodable value is left alone so `@IsUUID`
 *  reports it with its usual message. */
export function IsPublicId(options?: ValidationOptions) {
  const normalize = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    try {
      return toUuid(value);
    } catch {
      return value;
    }
  };
  return applyDecorators(
    Transform(({ value }) => (Array.isArray(value) ? value.map(normalize) : normalize(value))),
    IsUUID('all', options),
  );
}

function isPresent(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function resolve(value: unknown, field: string | undefined): string {
  try {
    return toUuid(value as string);
  } catch {
    throw new BadRequestException(`invalid ${field ?? 'id'}`);
  }
}
