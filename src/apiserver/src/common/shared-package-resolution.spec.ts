import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Which copy of `@orbit/shared` the compiler is allowed to believe.
 *
 * `src/shared/dist` is a gitignored build artifact, and for as long as it was the package's type
 * entry every apiserver typecheck read it -- through `node_modules/@orbit/shared`, which is a
 * symlink, so a worktree read the MAIN checkout's copy of it rather than its own. On 2026-09-10
 * that copy was six days old and `tsc -p tsconfig.test.json` reported seven errors about fields
 * (`refreshModelCatalog`, `enginePhase`, `minFreeDiskMb`) that had been sitting in
 * `src/shared/src/dto.ts` the whole time. The errors named apiserver files, so they read as a
 * broken change; nothing was broken, and they stopped an EXECUTABLE criterion at its first step.
 * It ran the other way too: a worktree editing `src/shared/src` typechecked against a build of
 * some other tree, so its own edit was neither used nor checked.
 *
 * The `exports` map is what settles it -- the compiler resolves through the `types` condition to
 * the source, the runtime keeps resolving to `dist/index.js`, and there is no artifact left in
 * between that can go stale. Both halves are asserted here, because either one alone is a
 * regression: source for the runtime would ask the image for TypeScript it does not ship, and
 * dist for the compiler is the bug this file exists about.
 */

const SHARED = path.resolve(__dirname, '../../../shared');

const manifest = JSON.parse(readFileSync(path.join(SHARED, 'package.json'), 'utf8')) as {
  main: string;
  types: string;
  exports: { '.': Record<string, string> };
};

test('the compiler resolves @orbit/shared to its source, never to a build artifact', () => {
  const conditions = manifest.exports['.'];
  assert.equal(conditions.types, './src/index.ts');
  assert.ok(existsSync(path.join(SHARED, 'src/index.ts')));

  // Conditions are matched in declaration order, so `types` has to be first or the catch-all
  // answers before the compiler ever reaches it.
  assert.equal(Object.keys(conditions)[0], 'types');

  // The legacy field says the same thing, so a resolver that ignores `exports` cannot quietly
  // land back on the artifact -- and so the two fields never disagree in front of a reader.
  assert.equal(manifest.types, 'src/index.ts');
});

test('the runtime still loads the built JavaScript', () => {
  // The image ships `src/shared/dist` and not `src/shared/src` (src/apiserver/Dockerfile), so a
  // runtime condition pointing at source would resolve to a path that is not in the container.
  assert.equal(manifest.exports['.'].default, './dist/index.js');
  assert.equal(manifest.main, 'dist/index.js');
});
