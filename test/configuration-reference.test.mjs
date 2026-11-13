import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The configuration reference states every Compose substitution this repository reads. The
// checklist is generated from the files themselves, so a variable added to a Compose file (or
// to .env.example) without a table row here turns the Documentation workflow red instead of
// shipping an undocumented setting.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const COMPOSE_FILES = [
  'docker-compose.yml',
  'deploy/macos-runner-signing.yml',
  'deploy/managed-runner/remote-host/compose.yml',
];

/** Every `${NAME` and every `NAME=` line .env.example offers, commented out or not. */
export function documentedVariables(files) {
  const names = new Set();
  for (const file of files) {
    const source = readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1]);
    if (file === '.env.example') {
      for (const match of source.matchAll(/^#? ?([A-Z][A-Z0-9_]*)=/gm)) names.add(match[1]);
    }
  }
  return [...names].sort();
}

/** The variable names the reference states as the first column of a table row. */
export function referenceVariables(markdown) {
  const names = new Set();
  for (const match of markdown.matchAll(/^\| `([A-Z][A-Z0-9_]*)`/gm)) names.add(match[1]);
  return names;
}

test('every Compose and .env.example variable has a row in the configuration reference', () => {
  const markdown = readFileSync(path.join(root, 'docs/configuration.md'), 'utf8');
  const documented = referenceVariables(markdown);
  const missing = documentedVariables([...COMPOSE_FILES, '.env.example']).filter((name) => !documented.has(name));
  assert.deepEqual(missing, [], `undocumented variables: ${missing.join(', ')}`);
});

test('every configuration table states a type, a requirement, a purpose, and whether it is a secret', () => {
  const markdown = readFileSync(path.join(root, 'docs/configuration.md'), 'utf8');
  const lines = markdown.split('\n');
  const headerIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith('| Variable |'));
  assert.ok(headerIndexes.length > 0, 'the reference has at least one configuration table');
  for (const { line, index } of headerIndexes) {
    assert.match(line, /^\| Variable \| Type \| Required \/ default \| Purpose \| Secret\? \|/, `table at line ${index + 1}`);
  }
});
