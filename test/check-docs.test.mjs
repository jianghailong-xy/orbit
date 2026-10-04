import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkLocalLinks, formatIssue, lintMarkdown, publicFiles } from '../scripts/check-docs.mjs';

test('scope includes tracked public guides and excludes evidence, mocks, and agent instructions', () => {
  const files = ['README.md', 'CONTRIBUTING.md', 'AGENTS.md', 'CLAUDE.md', '.github/pull_request_template.md',
    'docs/first-run.md', 'docs/design.md', 'docs/evidence/result.md', 'docs/mocks/demo.md', 'data/private.md'];
  assert.deepEqual(publicFiles(files, ['docs/first-run.md']), [
    'README.md', 'CONTRIBUTING.md', '.github/pull_request_template.md', 'docs/first-run.md',
  ]);
});

test('lint applies the repository rules and prints issues in the markdownlint-cli2 format', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orbit-doc-lint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'guide.md');
  // MD041 (heading first), MD033 (inline HTML) and MD013 (line length) are off in the repository config.
  writeFileSync(file, `Intro with <b>HTML</b> ${'and a long line '.repeat(10)}end.\n\n# Title\n\n### Skipped\n\n` +
    'Trailing   \n\n#No space\n');
  const { config } = JSON.parse(readFileSync(new URL('../.markdownlint-cli2.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual((await lintMarkdown([file], config)).map(formatIssue), [
    `${file}:5 error MD001/heading-increment Heading levels should only increment by one level at a time [Expected: h2; Actual: h3]`,
    `${file}:7:9 error MD009/no-trailing-spaces Trailing spaces [Expected: 0 or 2; Actual: 3]`,
    `${file}:9:1 error MD018/no-missing-space-atx No space after hash on atx style heading [Context: "#No space"]`,
  ]);
});

test('local links validate GitHub headings, reference links, images, HTML IDs, and source line anchors', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orbit-doc-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'docs'));
  const documents = {
    'README.md': '# Overview\n',
    'docs/guide.md': '# Hello `world` & friends\n\n## Repeat\n\n## Repeat\n\nSetext title\n------------\n\n## 中文标题\n\n<a id="custom"></a>\n<a name="named"></a>\n<span data-id="false-id"></span>\n<input name="false-name">\n',
    'docs/image.png': 'fixture',
    'docs/source.js': '// line one\n// line two\n',
  };
  for (const [file, text] of Object.entries(documents)) writeFileSync(path.join(root, file), text);
  const tracked = new Set(Object.keys(documents));
  const check = (source) => checkLocalLinks('README.md', source, root, tracked, {});
  assert.deepEqual(await check('[same](#overview)\n\n# Overview\n' +
    '[heading](docs/guide.md#hello-world--friends) [duplicate](docs/guide.md#repeat-1)\n' +
    '[setext](docs/guide.md#setext-title) [unicode](docs/guide.md#%E4%B8%AD%E6%96%87%E6%A0%87%E9%A2%98)\n' +
    '[custom](docs/guide.md#custom) [named](docs/guide.md#named) ![image](docs/image.png) [source](docs/source.js#L1-L2)\n' +
    '[reference][guide]\n\n[guide]: docs/guide.md\n'), []);
  assert.match((await check('[missing](docs/missing.md)'))[0], /missing tracked local target/);
  assert.match((await check('[missing](docs/guide.md#missing)'))[0], /missing local anchor/);
  assert.match((await check('[missing](#missing)'))[0], /missing local anchor/);
  assert.match((await check('![missing](docs/missing.png)'))[0], /missing tracked local target/);
  assert.match((await check('[bad line](docs/source.js#L99)'))[0], /missing local anchor/);
  assert.match((await check('[bad line](docs/source.js#L3)'))[0], /missing local anchor/);
  assert.match((await check('[false ID](docs/guide.md#false-id)'))[0], /missing local anchor/);
  assert.match((await check('[false name](docs/guide.md#false-name)'))[0], /missing local anchor/);
  writeFileSync(path.join(root, 'docs/untracked.md'), '# Untracked\n');
  assert.match((await check('[untracked](docs/untracked.md)'))[0], /missing tracked local target/);
  assert.match((await check('[directory](docs/#untracked)'))[0], /missing tracked local target/);
  assert.deepEqual(await check('`[example](missing.md)`\n\n```md\n[example](missing.md)\n```'), []);
  assert.deepEqual(await check('[external](https://example.invalid/private) [mail](mailto:nobody@example.invalid)'), []);
});
