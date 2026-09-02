#!/usr/bin/env node
// Which specs a change is answerable for.
//
// The fast gate runs the specs that belong to what changed; the full run is what covers the rest.
// Keeping the choice here, as a function of a list of paths, is what lets the boundary be tested
// rather than described: a migration-only change selects nothing, which is the exact shape of
// failure the fast gate is not allowed to be trusted for.
//
// Reads changed repository-relative paths on stdin or argv, one per line, and writes the specs to
// run -- also repository-relative -- to stdout. Paths it does not recognise select nothing; that
// is not an error, it is the answer.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = 'src/apiserver/src/';

/** The three spec suffixes a source file can have a sibling under. */
const SIBLING_SUFFIXES = ['.spec.ts', '.pg.spec.ts', '.http.spec.ts'];

export function selectSpecs(changed, exists = (relative) => existsSync(path.join(ROOT, relative))) {
  const selected = new Set();
  for (const raw of changed) {
    const relative = raw.trim();
    if (!relative.startsWith(SRC) || !relative.endsWith('.ts')) continue;
    if (relative.endsWith('.spec.ts')) {
      // A deleted spec selects nothing: there is no longer anything to run, and the artifact it
      // left behind is the build-orphan stage's business, not this one's.
      if (exists(relative)) selected.add(relative);
      continue;
    }
    if (relative.endsWith('.d.ts')) continue;
    const stem = relative.slice(0, -'.ts'.length);
    for (const suffix of SIBLING_SUFFIXES) {
      const sibling = `${stem}${suffix}`;
      if (exists(sibling)) selected.add(sibling);
    }
  }
  return [...selected].sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const input = argv.length > 0 ? argv : readFileSync(0, 'utf8').split('\n');
  const specs = selectSpecs(input.flatMap((line) => line.split('\n')).filter(Boolean));
  if (specs.length > 0) process.stdout.write(`${specs.join('\n')}\n`);
}
