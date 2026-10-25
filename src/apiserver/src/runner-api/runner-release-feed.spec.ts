import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { answerRunnerRelease } from './runner-release.controller';
import type { RunnerReleasePolicy } from './runner-release';
import { RUNNER_RELEASE_DL_CACHE_MS, RUNNER_RELEASE_DL_READ_TIMEOUT_MS, RunnerReleaseFeed } from './runner-release-feed';

/**
 * What /dl publishes, as the apiserver reads it for the runner link (runner-release-feed.ts): read in the background
 * and never waited for, standing for a minute, and assigned exactly as GET /runner/release assigns it.
 */

const LATEST = '0.1.300';
const PREVIOUS = '0.1.299';
const BASE = 'http://web.invalid/dl/';
const POLICY = (rolloutPercent: number, rollback: string | null = null) => () => ({ policy: { rolloutPercent, rollback } });

/** A /dl that answers each file as `files` says, and records what was asked. */
function dl(files: Record<string, number | { version?: unknown }>) {
  const asked: string[] = [];
  const fetchDl = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const file = files[url.slice(BASE.length)];
    if (file === undefined) return new Response('{}', { status: 404 });
    if (typeof file === 'number') return new Response('{}', { status: file });
    return new Response(JSON.stringify(file), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fetchDl, asked };
}

const both = () => dl({ 'version.json': { version: LATEST }, 'previous/version.json': { version: PREVIOUS } });

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, pass: (ms: number) => { now += ms; } };
}

function logs() {
  const warned: string[] = [];
  const failed: string[] = [];
  return { warned, failed, log: { warn: (m: string) => warned.push(m), error: (m: string) => failed.push(m) } };
}

test('unset or not an http(s) URL, nothing is read and nothing is stated', async () => {
  const { fetch: fetchDl, asked } = both();
  for (const url of [undefined, '', '   ']) {
    const feed = new RunnerReleaseFeed(url, { fetch: fetchDl, policy: POLICY(100) });
    assert.equal(feed.published(), null);
    assert.equal(feed.assignedTo(randomUUID()), null);
    await feed.settled();
  }
  const { log, failed } = logs();
  const feed = new RunnerReleaseFeed('ftp://web/dl/', { fetch: fetchDl, log, policy: POLICY(100) });
  assert.equal(feed.assignedTo(randomUUID()), null);
  assert.equal(failed.length, 1);
  assert.match(failed[0], /RUNNER_RELEASE_DL_URL="ftp:\/\/web\/dl\/" is not an http\(s\) URL/);
  assert.deepEqual(asked, []);
});

test('the first ask starts a read and is answered without it; what the read found is assigned as GET /runner/release assigns it', async () => {
  const policies: RunnerReleasePolicy[] = [
    { rolloutPercent: 100, rollback: null },
    { rolloutPercent: 50, rollback: null },
    { rolloutPercent: 0, rollback: null },
    { rolloutPercent: 50, rollback: LATEST },
    { rolloutPercent: 50, rollback: PREVIOUS },
  ];
  for (const policy of policies) {
    const { fetch: fetchDl, asked } = both();
    const feed = new RunnerReleaseFeed(BASE, { fetch: fetchDl, policy: () => ({ policy }) });
    assert.equal(feed.assignedTo(randomUUID()), null, 'cold: nothing known yet, and nothing waited for');
    await feed.settled();
    assert.deepEqual(asked.sort(), [`${BASE}previous/version.json`, `${BASE}version.json`]);
    assert.deepEqual(feed.published(), { latest: LATEST, previous: PREVIOUS });
    for (let i = 0; i < 200; i += 1) {
      const runnerId = randomUUID();
      const { version, rollback } = answerRunnerRelease(runnerId, LATEST, PREVIOUS, { policy });
      assert.deepEqual(feed.assignedTo(runnerId), { version, rollback }, JSON.stringify(policy));
    }
  }
});

test('with no previous release published, the latest is assigned; a rollback with nowhere to go back to, nothing', async () => {
  const latestOnly = dl({ 'version.json': { version: LATEST } });
  const feed = new RunnerReleaseFeed(BASE, { fetch: latestOnly.fetch, policy: POLICY(0) });
  feed.published();
  await feed.settled();
  assert.deepEqual(feed.published(), { latest: LATEST, previous: null });
  assert.deepEqual(feed.assignedTo(randomUUID()), { version: LATEST, rollback: false });
  const rolledBack = new RunnerReleaseFeed(BASE, { fetch: latestOnly.fetch, policy: POLICY(100, LATEST) });
  rolledBack.published();
  await rolledBack.settled();
  assert.equal(rolledBack.assignedTo(randomUUID()), null, 'GET /runner/release answers 409: no runner is moved');
  const unreadablePointer = new RunnerReleaseFeed(BASE, { fetch: both().fetch, policy: () => ({ problems: ['it is not JSON'] }) });
  unreadablePointer.published();
  await unreadablePointer.settled();
  assert.equal(unreadablePointer.assignedTo(randomUUID()), null, 'GET /runner/release answers 409: nothing is assigned');
});

test('what a read found stands for a minute; the next read starts then, and what stood is answered until it ends', async () => {
  const time = clock();
  let latest = LATEST;
  const asked: string[] = [];
  let release!: () => void;
  let gate: Promise<void> | null = null;
  const fetchDl = (async (input: string | URL | Request) => {
    asked.push(String(input));
    if (gate) await gate;
    const version = String(input).endsWith('previous/version.json') ? PREVIOUS : latest;
    return new Response(JSON.stringify({ version }), { status: 200 });
  }) as typeof fetch;
  const feed = new RunnerReleaseFeed(BASE, { fetch: fetchDl, now: time.now, policy: POLICY(100) });
  feed.published();
  await feed.settled();
  assert.equal(asked.length, 2);

  time.pass(RUNNER_RELEASE_DL_CACHE_MS - 1);
  assert.deepEqual(feed.published(), { latest: LATEST, previous: PREVIOUS });
  await feed.settled();
  assert.equal(asked.length, 2, 'within the minute, nothing is read again');

  // /dl moves on; the minute passes, and the read it starts is slow.
  latest = '0.1.301';
  gate = new Promise((resolve) => { release = resolve; });
  time.pass(1);
  assert.deepEqual(feed.published(), { latest: LATEST, previous: PREVIOUS }, 'what stood is answered while the read runs');
  assert.deepEqual(feed.published(), { latest: LATEST, previous: PREVIOUS });
  assert.equal(asked.length, 4, 'one read at a time');
  release();
  await feed.settled();
  assert.deepEqual(feed.published(), { latest: '0.1.301', previous: PREVIOUS });
});

test('a failed read states no release for a minute, and is logged once in ten minutes however often it fails', async () => {
  const time = clock();
  const { log, warned } = logs();
  const failures: Array<Record<string, number | { version?: unknown }>> = [
    { 'version.json': 500, 'previous/version.json': { version: PREVIOUS } },
    { 'previous/version.json': { version: PREVIOUS } },
    { 'version.json': { version: LATEST }, 'previous/version.json': 503 },
    { 'version.json': { version: 'not a version' }, 'previous/version.json': { version: PREVIOUS } },
    { 'version.json': {}, 'previous/version.json': { version: PREVIOUS } },
  ];
  for (const files of failures) {
    const failing = dl(files);
    const feed = new RunnerReleaseFeed(BASE, { fetch: failing.fetch, now: time.now, log, policy: POLICY(100) });
    feed.published();
    await feed.settled();
    assert.equal(feed.published(), null, JSON.stringify(files));
    assert.equal(feed.assignedTo(randomUUID()), null);
  }
  assert.equal(warned.length, 5, 'each feed logs its first failure');
  assert.match(warned[0], /version\.json answered 500/);
  assert.match(warned[2], /previous\/version\.json answered 503/);
  assert.match(warned[3], /names no release version/);

  // One feed failing again and again.
  const failing = dl({ 'version.json': 500 });
  const feed = new RunnerReleaseFeed(BASE, { fetch: failing.fetch, now: time.now, log, policy: POLICY(100) });
  for (let minute = 0; minute < 25; minute += 1) {
    feed.published();
    await feed.settled();
    assert.equal(feed.published(), null);
    time.pass(RUNNER_RELEASE_DL_CACHE_MS);
  }
  assert.equal(failing.asked.filter((u) => u.endsWith('/dl/version.json')).length, 25, 'read again each minute');
  assert.equal(warned.length, 5 + 3, 'logged at its first failure, and again ten and twenty minutes later');

  // A read that succeeds after failures states the release again.
  let up = false;
  const recovering = (async (input: string | URL | Request) =>
    up ? both().fetch(input) : new Response('{}', { status: 502 })) as typeof fetch;
  const recovered = new RunnerReleaseFeed(BASE, { fetch: recovering, now: time.now, log, policy: POLICY(100) });
  recovered.published();
  await recovered.settled();
  assert.equal(recovered.published(), null);
  up = true;
  time.pass(RUNNER_RELEASE_DL_CACHE_MS);
  recovered.published();
  await recovered.settled();
  assert.deepEqual(recovered.assignedTo(randomUUID()), { version: LATEST, rollback: false });
});

test('a /dl that never answers is given up on after its two seconds, and stated as nothing', { timeout: 20_000 }, async () => {
  const held: ServerResponse[] = [];
  const server = createServer((_req, res) => { held.push(res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { log, warned } = logs();
    const feed = new RunnerReleaseFeed(`http://127.0.0.1:${(server.address() as AddressInfo).port}/dl`, { log, policy: POLICY(100) });
    const started = Date.now();
    assert.equal(feed.assignedTo(randomUUID()), null);
    assert.ok(Date.now() - started < 100, 'asking never waits for the read');
    await feed.settled();
    const took = Date.now() - started;
    assert.ok(took >= RUNNER_RELEASE_DL_READ_TIMEOUT_MS - 50 && took < RUNNER_RELEASE_DL_READ_TIMEOUT_MS + 1_000, `gave up after ${took} ms`);
    assert.equal(feed.published(), null);
    assert.equal(warned.length, 1);
    assert.equal(held.length, 2, 'both manifests were asked for, at /dl/ with its slash added');
  } finally {
    for (const res of held) res.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
