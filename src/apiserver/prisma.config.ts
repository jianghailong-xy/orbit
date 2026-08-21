// Prisma 7 moved the connection URL out of schema.prisma: the schema now only
// declares the provider, and every CLI command (migrate/db/studio) reads the URL
// from here instead. `dotenv/config` keeps `cp .env.example .env` working the way
// it did when the CLI still loaded `.env` on its own.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
});
