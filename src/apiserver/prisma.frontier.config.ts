import { defineConfig } from 'prisma/config';

const schema = process.env.ORBIT_FRONTIER_PRISMA_SCHEMA;
const migrations = process.env.ORBIT_FRONTIER_PRISMA_MIGRATIONS;
if (!schema || !migrations) {
  throw new Error('ORBIT_FRONTIER_PRISMA_SCHEMA and ORBIT_FRONTIER_PRISMA_MIGRATIONS are required');
}

/** Test-only config for replaying a historical migration frontier from an isolated directory. */
export default defineConfig({
  schema,
  migrations: { path: migrations },
  datasource: { url: process.env.DATABASE_URL },
});
