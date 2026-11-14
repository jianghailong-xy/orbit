import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectApiRoutes, renderApiReference } from './api-reference';

/**
 * Writes docs/api-reference.md from the routes the application mounts.
 *
 *   npm run api:reference      # regenerate the committed page
 *   node dist/api-reference/generate-api-reference.js --check
 *
 * The `--check` form is what `api-reference.spec.ts` asserts in CI; `npm run api:reference` is the
 * same renderer, so a maintainer who adds a controller runs one command and commits the diff.
 */
export const API_REFERENCE_FILE = path.resolve(__dirname, '../../../../docs/api-reference.md');

async function main(): Promise<void> {
  const markdown = renderApiReference(await collectApiRoutes());
  if (process.argv.includes('--check')) {
    const committed = readFileSync(API_REFERENCE_FILE, 'utf8');
    if (committed !== markdown) {
      console.error(
        `${path.relative(process.cwd(), API_REFERENCE_FILE)} is out of date. Regenerate it with \`npm run api:reference\`.`,
      );
      process.exitCode = 1;
    }
    return;
  }
  mkdirSync(path.dirname(API_REFERENCE_FILE), { recursive: true });
  writeFileSync(API_REFERENCE_FILE, markdown);
  console.log(`Wrote ${path.relative(process.cwd(), API_REFERENCE_FILE)}`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
