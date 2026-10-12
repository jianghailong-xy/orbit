import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readWikiExecutorSwitch, wikiExecutorClaimOwners, wikiExecutorServes } from './wiki-executor-switch';

/**
 * The executor switch (wiki-executor-switch.ts, contract `jobs.executor`): the flag that decides whether the server
 * runs a wiki job for an account, and the default that changes nothing.
 */

const OWNER = '3f1c1b3c-9d3a-4f2b-8a1e-0c7d5b2a6e11';
const OTHER = '5b1c1b3c-9d3a-4f2b-8a1e-0c7d5b2a6e22';

test('with nothing set the mode is runner: the old path, and no worker claims anything', () => {
  const sw = readWikiExecutorSwitch({});
  assert.equal(sw.mode, 'runner');
  assert.deepEqual([...sw.canaryOwners], []);
  assert.deepEqual(sw.problems, []);
  assert.equal(wikiExecutorServes(sw, OWNER), false);
  assert.deepEqual(wikiExecutorClaimOwners(sw), []);
});

test('server serves every account and claims without an owner filter', () => {
  const sw = readWikiExecutorSwitch({ ORBIT_WIKI_EXECUTOR: 'server' });
  assert.equal(sw.mode, 'server');
  assert.equal(wikiExecutorServes(sw, OWNER), true);
  assert.equal(wikiExecutorClaimOwners(sw), null);
  // The canary list is not read under another mode, and says so.
  const listed = readWikiExecutorSwitch({ ORBIT_WIKI_EXECUTOR: 'server', ORBIT_WIKI_EXECUTOR_CANARY_OWNERS: OWNER });
  assert.deepEqual([...listed.canaryOwners], []);
  assert.equal(listed.problems.length, 1);
  assert.match(listed.problems[0], /read only under ORBIT_WIKI_EXECUTOR=canary/u);
});

test('canary serves the accounts it lists, matched case-insensitively, and nothing else', () => {
  const sw = readWikiExecutorSwitch({ ORBIT_WIKI_EXECUTOR: 'canary', ORBIT_WIKI_EXECUTOR_CANARY_OWNERS: ` ${OWNER.toUpperCase()}, ${OTHER} ` });
  assert.equal(sw.mode, 'canary');
  assert.equal(wikiExecutorServes(sw, OWNER), true);
  assert.equal(wikiExecutorServes(sw, OTHER), true);
  assert.equal(wikiExecutorServes(sw, '11111111-2222-4333-8444-555555555555'), false);
  assert.deepEqual(wikiExecutorClaimOwners(sw), [OWNER.toLowerCase(), OTHER]);
});

test('a value nobody can read is read as runner, and a canary list with nothing usable is named', () => {
  const misspelled = readWikiExecutorSwitch({ ORBIT_WIKI_EXECUTOR: 'Server' } as NodeJS.ProcessEnv);
  assert.equal(misspelled.mode, 'server', 'case is not a misspelling');
  const wrong = readWikiExecutorSwitch({ ORBIT_WIKI_EXECUTOR: 'srv' });
  assert.equal(wrong.mode, 'runner');
  assert.match(wrong.problems[0], /is none of runner, canary, server/u);
  const empty = readWikiExecutorSwitch({ ORBIT_WIKI_EXECUTOR: 'canary', ORBIT_WIKI_EXECUTOR_CANARY_OWNERS: 'not-an-id' });
  assert.equal(empty.mode, 'canary');
  assert.deepEqual([...empty.canaryOwners], []);
  assert.deepEqual(empty.problems, [
    'ORBIT_WIKI_EXECUTOR_CANARY_OWNERS names "not-an-id", which is no account id: it is ignored',
    'ORBIT_WIKI_EXECUTOR=canary with no account in ORBIT_WIKI_EXECUTOR_CANARY_OWNERS: the server runs no wiki job for anyone',
  ]);
  assert.deepEqual(wikiExecutorClaimOwners(empty), [], 'under canary with nobody listed, nothing is claimed');
});
