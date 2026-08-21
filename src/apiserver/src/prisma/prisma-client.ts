import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma 7 no longer reads the connection URL from `schema.prisma` (nor from the removed
 * `datasources` constructor option) — the client connects through a driver adapter that the
 * caller builds. Every client in the API server is opened here so there is one place that
 * knows we talk to Postgres over `pg`.
 */
export function prismaClientFor(url: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg(url) });
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
