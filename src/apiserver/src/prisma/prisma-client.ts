import { createHash } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma 7 no longer reads the connection URL from `schema.prisma` (nor from the removed
 * `datasources` constructor option) — the client connects through a driver adapter that the
 * caller builds. Every client in the API server is opened here so there is one place that
 * knows we talk to Postgres over `pg`.
 */
export function prismaClientFor(url: string): PrismaClient {
  return new PrismaClient({ adapter: pgAdapterFor(url) });
}

/**
 * The mark of a statement sent as a named prepared statement. The adapter sends every statement unnamed, which
 * PostgreSQL parses, analyses and plans again on each execution; a named one is parsed once per connection, and
 * planned once when PostgreSQL's generic plan serves it (plan_cache_mode auto). A statement opts in by starting with
 * this mark: one whose text is fixed, everything that varies being a parameter, and that runs often enough for the
 * saving to matter. The runner link's heartbeat statement is one (readLinkBeat): unnamed it cost the database about
 * 1.6 ms of CPU a beat, named about 0.2 ms (task O1, measured with pgbench on the load test stack).
 */
export const PREPARED_STATEMENT = '/* prepared */';

/** The name a marked statement is prepared under, one per distinct text; none for any other statement. */
export function preparedStatementName(query: { sql: string }): string | undefined {
  if (!query.sql.startsWith(PREPARED_STATEMENT)) return undefined;
  return `orbit_${createHash('sha256').update(query.sql).digest('hex').slice(0, 32)}`;
}

/** The adapter's options for every client: marked statements are named (preparedStatementName). */
export const PG_ADAPTER_OPTIONS = {
  // Typed by the adapter as always naming; no name leaves a statement unnamed, as without a generator.
  statementNameGenerator: preparedStatementName as (query: { sql: string }) => string,
};

/** The driver adapter every client in the API server connects through. */
export function pgAdapterFor(url: string): PrismaPg {
  return new PrismaPg(url, PG_ADAPTER_OPTIONS);
}

/**
 * The deployment's connection URL. Prisma used to raise "Environment variable not found:
 * DATABASE_URL" itself; with the adapter an unset URL would instead reach `pg` and surface
 * as a confusing localhost connection failure, so it is checked here.
 */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Environment variable not found: DATABASE_URL');
  return url;
}
