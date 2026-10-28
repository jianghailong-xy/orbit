import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  ENGINE_SESSION_DOORS,
  ENGINE_SESSION_FIELD_CASES,
  ENGINE_SESSION_GUARD_SITES,
  ENGINE_SESSION_RUNNER_ROUTES,
  ENGINE_SESSION_USER_ROUTES,
  fieldCaseRegistryStatus,
} from './engine-session-cases';

/**
 * The route census of the engine-path guard (docs/project-integration-line-contract.md §2.9 LS6).
 *
 * It is checked BOTH ways, like `common/lock-order.spec.ts` checks its write inventory:
 *
 *   1. every non-GET route that names a session under /sessions or /runner/sessions, derived from
 *      the tenant-isolation registries, is in `ENGINE_SESSION_DOORS` — so a new door cannot be
 *      added without naming the guard that refuses a LANDING, and a deleted one cannot leave a
 *      stale line;
 *   2. every guard site's snippet is still in its source — so deleting an assertion (the
 *      "deliberately omit one entry" case the acceptance asks for) turns this red;
 *   3. the six body/query field cases are registered where the isolation census expects them.
 */
const read = (rel: string) => readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

const USER = ENGINE_SESSION_USER_ROUTES;
const RUNNER = ENGINE_SESSION_RUNNER_ROUTES;
const DOORS = ENGINE_SESSION_DOORS;

test('the user door is exactly the 33 session-naming routes the registries hold', () => {
  // The count is a statement, not a convenience: when a route is added the number and the list both
  // change in one diff, which is what makes "32 → 33" reviewable.
  assert.equal(USER.length, 33, `derived user routes: ${USER.join(', ')}`);
  const mapped = Object.keys(DOORS).filter((key) => !key.includes(' /runner/sessions/'));
  assert.deepEqual([...mapped].sort(), USER, 'a user route has no line in ENGINE_SESSION_DOORS, or a line names no route');
});

test('the runner door is exactly the 30 session-naming routes the registries hold', () => {
  assert.equal(RUNNER.length, 30, `derived runner routes: ${RUNNER.join(', ')}`);
  const mapped = Object.keys(DOORS).filter((key) => key.includes(' /runner/sessions/'));
  assert.deepEqual([...mapped].sort(), RUNNER, 'a runner route has no line in ENGINE_SESSION_DOORS, or a line names no route');
});

test('the six field cases are registered in the tenant-isolation registries', () => {
  const keys = Object.keys(ENGINE_SESSION_FIELD_CASES);
  assert.equal(keys.length, 6, `field cases: ${keys.join(', ')}`);
  for (const { key, registered } of fieldCaseRegistryStatus()) {
    assert.equal(registered, true, `field case "${key}" is not in either isolation registry: its door moved or was renamed`);
  }
});

test('every door names a guard site, and every guard site is in the source', () => {
  const sources = new Map<string, string>();
  for (const [name, site] of Object.entries(ENGINE_SESSION_GUARD_SITES)) {
    if (!sources.has(site.file)) sources.set(site.file, read(`src/${site.file}`));
    const source = sources.get(site.file)!;
    assert.ok(
      source.includes(site.snippet),
      `${name}: ${site.file} no longer contains its assertion — "${site.snippet.split('\n')[0]}"`,
    );
  }
  for (const [route, site] of Object.entries(DOORS)) {
    assert.ok(site in ENGINE_SESSION_GUARD_SITES, `${route} names guard site ${site}, which does not exist`);
  }
  for (const [key, field] of Object.entries(ENGINE_SESSION_FIELD_CASES)) {
    assert.ok(field.guard in ENGINE_SESSION_GUARD_SITES, `${key} names guard site ${field.guard}, which does not exist`);
  }
});

test('every guard site is reached from a door or a field case (no dead assertion)', () => {
  const used = new Set([...Object.values(DOORS), ...Object.values(ENGINE_SESSION_FIELD_CASES).map((f) => f.guard)]);
  for (const name of used) assert.ok(name in ENGINE_SESSION_GUARD_SITES, name);
  for (const name of Object.keys(ENGINE_SESSION_GUARD_SITES)) {
    assert.ok(used.has(name), `${name} is no longer reached from any door: remove it or add the door that needs it`);
  }
});
