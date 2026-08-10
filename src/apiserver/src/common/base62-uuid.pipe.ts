import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { toUuid } from '@orbit/shared';

/** Resolves a route `:id` that may be a base62 public id (the short form used
 *  in shareable URLs) or a raw UUID, to the canonical UUID the service layer
 *  queries by. Rejects input that is neither.
 *
 *  Belongs on EVERY id a caller supplies. Every id column is `@db.Uuid`, so an
 *  id that isn't one reaches Prisma as an unhandled P2023 (or, in the raw-SQL
 *  queries, a Postgres `invalid input syntax for type uuid`) and the caller
 *  sees a bare 500 it cannot act on. */
@Injectable()
export class Base62UuidPipe implements PipeTransform<string, string> {
  transform(value: string, metadata?: ArgumentMetadata): string {
    try {
      return toUuid(value);
    } catch {
      throw new BadRequestException(`invalid ${metadata?.data ?? 'id'}`);
    }
  }
}

/** Base62UuidPipe for an id that may legitimately be absent — a filter query
 *  rather than a path segment. An absent value stays absent; a present one that
 *  won't parse is refused rather than dropped, because silently ignoring a
 *  filter answers a narrow question with every row the caller can see. */
@Injectable()
export class OptionalBase62UuidPipe implements PipeTransform<string | undefined, string | undefined> {
  transform(value: string | undefined, metadata?: ArgumentMetadata): string | undefined {
    if (!value?.trim()) return undefined;
    return new Base62UuidPipe().transform(value, metadata);
  }
}
