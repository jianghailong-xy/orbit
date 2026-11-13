import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { collectApiRoutes, renderApiReference } from './api-reference';

/**
 * docs/api-reference.md is generated from the controllers the application mounts. This keeps it
 * true: a controller, route, guard or body type added without regenerating the page fails here,
 * where the message names the command that fixes it.
 */
test('docs/api-reference.md matches the routes the application mounts', async () => {
  const expected = renderApiReference(await collectApiRoutes());
  const committed = readFileSync(path.resolve(__dirname, '../../../../docs/api-reference.md'), 'utf8');
  assert.equal(
    committed,
    expected,
    'docs/api-reference.md is out of date; regenerate it with `npm run api:reference`.',
  );
});
