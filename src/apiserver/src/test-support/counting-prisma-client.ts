import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * A real Prisma client that also records every SQL statement it sends.
 *
 * WHY THIS EXISTS
 * ---------------
 * "Is this read N+1?" is a question about STATEMENTS, and nothing in the repository could count
 * them. Counting Prisma calls instead — a `Proxy` over the client's delegates, which
 * `project-list-rollup.audit.pg.spec.ts` does for `$queryRaw` — answers a different question:
 * one `findMany` whose nested `select` reaches four relations is one call and may be several
 * statements, and whether that number grows with the rows is exactly the thing being asked.
 * `log_statement` plus the container log would answer it, but only for whoever can reach the
 * container, and it cannot be attributed to one call from inside a test.
 *
 * WHERE IT TAPS
 * -------------
 * Prisma 7 talks to PostgreSQL through a driver adapter, and every statement — reads, writes,
 * and the `BEGIN`/`COMMIT` around an interactive transaction — reaches it as `queryRaw` or
 * `executeRaw` on the adapter the client connected. Wrapping that one seam is enough to see
 * them all, in order, with their SQL.
 *
 * WHAT IT IS NOT
 * --------------
 * It counts what the client ASKS the driver to run, which is what a caller can be held
 * responsible for. It is not a `pg_stat_statements` census: a statement the adapter issues to
 * itself (a savepoint inside a nested transaction) is invisible here, because the adapter calls
 * its own `executeRaw` rather than the wrapper's. No read this counts uses one, and a caller
 * that trusts the number should prove the counter is live first — see the negative control in
 * `project-get-query-count.pg.spec.ts`.
 */
export interface RecordedStatements {
  /** Every statement sent since the last `reset`, in the order they were sent. */
  readonly sql: readonly string[];
  reset(): void;
}

/**
 * A client that behaves exactly like `prismaClientFor(url)` and keeps the statement log beside it.
 * Disconnect it the usual way; the log outlives the disconnect so it can still be read.
 */
export function countingPrismaClientFor(
  url: string,
): { prisma: PrismaClient; statements: RecordedStatements } {
  const sql: string[] = [];

  /** Count one queryable — the connected adapter, or a transaction started on it. */
  const counted = <T extends object>(queryable: T): T => new Proxy(queryable, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const method = value as (...args: never[]) => unknown;
      if (property === 'queryRaw' || property === 'executeRaw') {
        return (query: { sql: string }) => {
          sql.push(query.sql);
          return (method as (query: unknown) => unknown).call(target, query);
        };
      }
      if (property === 'startTransaction') {
        return async (...args: never[]) => counted(
          await (method as (...a: never[]) => Promise<object>).apply(target, args),
        );
      }
      return method.bind(target);
    },
  });

  const adapter = new PrismaPg(url);
  const countingAdapter = new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (property === 'connect') {
        return async () => counted(await target.connect());
      }
      return (value as (...args: never[]) => unknown).bind(target);
    },
  });

  return {
    prisma: new PrismaClient({ adapter: countingAdapter }),
    statements: {
      get sql() { return sql; },
      reset() { sql.length = 0; },
    },
  };
}
