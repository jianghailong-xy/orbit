import { BadRequestException, Injectable, PipeTransform, applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsUUID, ValidationOptions } from 'class-validator';
import { toUuid } from '@orbit/shared';

/**
 * Body-side counterparts of Base62UuidPipe (see base62-uuid.pipe.ts). An id in a request body
 * comes from the same places as one in a URL — copied out of a client link, echoed from a tool
 * result — so it has to accept the same two spellings: the base62 public id or a raw UUID.
 *
 * Two of them because the bodies come in two shapes. DTO *classes* run through the global
 * ValidationPipe, so a decorator can normalize and validate in place. Several DTOs are plain
 * interfaces (or inline types), which class-validator never sees at all — those need the pipe.
 */

/** Validated id field: normalizes a base62 public id to its UUID, then validates. An
 *  undecodable value is left as-is so `@IsUUID` produces the 400 with its usual message. */
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

/** Normalizes the named id fields of an unvalidated body. Only the listed fields are touched —
 *  everything else passes through untouched, so this adds no whitelisting the DTO didn't ask
 *  for and cannot silently drop a field an older client still sends. */
@Injectable()
export class PublicIdBodyPipe implements PipeTransform<unknown, unknown> {
  constructor(private readonly fields: readonly string[]) {}

  transform(body: unknown): unknown {
    if (!body || typeof body !== 'object') return body;
    const record = body as Record<string, unknown>;
    for (const field of this.fields) {
      const value = record[field];
      if (typeof value !== 'string' || !value.trim()) continue;
      try {
        record[field] = toUuid(value);
      } catch {
        throw new BadRequestException(`invalid ${field}`);
      }
    }
    return body;
  }
}
