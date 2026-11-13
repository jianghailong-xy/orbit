import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

/**
 * A test that reads another client's source (iOS/macOS, Android, or the shared tables) to hold the same
 * words on both sides FAILS when that file is missing, and never skips (evidence-addressee design §6,
 * D5 = A). A skipped parity check is green on exactly the day its counterpart went missing, and on
 * 2026-11-12 one such skip let a task pass. This reads every test under src/ and fails naming any
 * cross-client one that skips.
 */
const SRC = fileURLToPath(new URL('.', import.meta.url));
const SELF = fileURLToPath(import.meta.url);

function tests(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : tests(path);
    return /\.test\.tsx?$/.test(entry.name) && path !== SELF ? [path] : [];
  });
}

it('no test that reads another client skips', () => {
  const files = tests(SRC);
  expect(files.length, `found too few tests under ${SRC} to have looked`).toBeGreaterThan(50);
  const other = /\bmacos\/|\bandroid\/|src\/shared\//;
  const skip = /\b(?:it|test|describe)\.(?:skip|skipIf|runIf|todo)\b|\b(?:ctx|context)\.skip\(/;
  const offenders = files
    .filter((file) => {
      const text = readFileSync(file, 'utf8');
      return other.test(text) && skip.test(text);
    })
    .map((file) => file.slice(SRC.length));
  expect(offenders, "these read another client's file and skip when it is missing; make a missing file a failure naming it").toEqual([]);
});
