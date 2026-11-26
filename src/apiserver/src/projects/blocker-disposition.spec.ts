import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declaredPaths, pathsOutsideScope } from './blocker-disposition';

test('a repository named in prose is not a declared path, and a sentence\'s full stop is not part of one', () => {
  // The production run that raised it (2026-11-26): the whole declared scope read as
  // `jianghailong-xy/orbit-landing-test.`, and README.md as a file outside it.
  const declaration = {
    description: 'Add a line to README.md in the GitHub repository jianghailong-xy/orbit-landing-test.',
  };
  for (const url of [
    'https://github.com/jianghailong-xy/orbit-landing-test',
    'ssh://github.com/Jianghailong-XY/orbit-landing-test',
  ]) {
    assert.deepEqual(declaredPaths(declaration, url), [], url);
  }
  assert.deepEqual(declaredPaths({ description: 'Clone github.com/o/r.git, then o/r.' }, 'https://github.com/o/r'), []);
  // With no repository bound, the token is still read, without the full stop.
  assert.deepEqual(declaredPaths(declaration), ['jianghailong-xy/orbit-landing-test']);
});

test('real paths keep their scope when the sentence ends at them', () => {
  const found = declaredPaths(
    { description: 'Change src/apiserver/src/github/. Then docs/design/protected-branch-landing.md...' },
    'https://github.com/o/r',
  );
  assert.deepEqual(found, ['docs/design/protected-branch-landing.md', 'src/apiserver/src/github']);
  assert.deepEqual(pathsOutsideScope(['src/apiserver/src/github/a.ts', 'README.md'], found), ['README.md']);
});
