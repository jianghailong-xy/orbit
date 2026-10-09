import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BadRequestException, ConflictException, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Runner } from '@prisma/client';

import { sha256 } from '../common/crypto.util';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { RunnerAuthGuard } from './runner-auth.guard';
import { answerRunnerRelease, RunnerReleaseController } from './runner-release.controller';
import {
  assignRunnerRelease,
  compareRunnerReleaseVersions,
  describeRunnerRelease,
  loadRunnerReleasePolicy,
  readRunnerReleasePolicy,
  rolloutBucket,
  RUNNER_RELEASE_POLICY_FILE,
  type RunnerReleasePolicy,
} from './runner-release';

/**
 * Which of the two releases /dl publishes each runner is assigned (runner-release.ts): the rollout by a hash of the
 * runner's id, the rollback that points every runner at the previous release, and the pointer file both are read from.
 */

const LATEST = '0.1.216';
const PREVIOUS = '0.1.215';
const BOTH = { latest: LATEST, previous: PREVIOUS };
const RUNNERS = Array.from({ length: 2000 }, () => randomUUID());

const rollout = (rolloutPercent: number): RunnerReleasePolicy => ({ rolloutPercent, rollback: null });
const rollback = (version: string, rolloutPercent = 100): RunnerReleasePolicy => ({ rolloutPercent, rollback: version });

// Ids whose place in a rollout is known in advance: the first four bytes of their SHA-256, mod 100.
const AT_BUCKET = { 0: 'runner-6', 49: 'runner-37', 50: 'runner-42', 99: 'runner-16' } as const;

const LATEST_RELEASE = { version: LATEST, rollback: false, heldByRollout: false };
const HELD_AT_PREVIOUS = { version: PREVIOUS, rollback: false, heldByRollout: true };
const ROLLED_BACK = { version: PREVIOUS, rollback: true, heldByRollout: false };

test('the same runner id is assigned the same release, call after call', () => {
  for (const percent of [0, 50, 100]) {
    for (const id of RUNNERS) {
      const first = assignRunnerRelease(id, BOTH, rollout(percent));
      // A policy read afresh from the file's own JSON decides the same way.
      const reread = readRunnerReleasePolicy(JSON.parse(JSON.stringify(rollout(percent))));
      assert.ok('policy' in reread);
      assert.deepEqual(assignRunnerRelease(id, BOTH, rollout(percent)), first);
      assert.deepEqual(assignRunnerRelease(id, BOTH, reread.policy), first);
      assert.equal(rolloutBucket(id), rolloutBucket(id));
    }
  }
});

test('a runner’s place is the SHA-256 of its id: these ids sit on the edges of a rollout', () => {
  for (const [bucket, id] of Object.entries(AT_BUCKET)) assert.equal(rolloutBucket(id), Number(bucket), id);
  for (const id of RUNNERS) {
    const bucket = rolloutBucket(id);
    assert.ok(Number.isInteger(bucket) && bucket >= 0 && bucket < 100, `${id} fell in ${bucket}`);
  }
});

test('0% holds every runner at the previous release', () => {
  for (const id of [...RUNNERS, ...Object.values(AT_BUCKET)]) {
    assert.deepEqual(assignRunnerRelease(id, BOTH, rollout(0)), HELD_AT_PREVIOUS, id);
  }
});

test('100% gives every runner the latest release', () => {
  for (const id of [...RUNNERS, ...Object.values(AT_BUCKET)]) {
    assert.deepEqual(assignRunnerRelease(id, BOTH, rollout(100)), LATEST_RELEASE, id);
  }
});

test('50% gives the latest release to the runners in buckets 0-49 and holds buckets 50-99', () => {
  assert.deepEqual(assignRunnerRelease(AT_BUCKET[0], BOTH, rollout(50)), LATEST_RELEASE);
  assert.deepEqual(assignRunnerRelease(AT_BUCKET[49], BOTH, rollout(50)), LATEST_RELEASE);
  assert.deepEqual(assignRunnerRelease(AT_BUCKET[50], BOTH, rollout(50)), HELD_AT_PREVIOUS);
  assert.deepEqual(assignRunnerRelease(AT_BUCKET[99], BOTH, rollout(50)), HELD_AT_PREVIOUS);
  let latest = 0;
  for (const id of RUNNERS) {
    const assigned = assignRunnerRelease(id, BOTH, rollout(50));
    assert.deepEqual(assigned, rolloutBucket(id) < 50 ? LATEST_RELEASE : HELD_AT_PREVIOUS, id);
    if (assigned?.version === LATEST) latest += 1;
  }
  // Ids spread evenly: about half of 2000 random runners, nowhere near all or none.
  assert.ok(latest > 800 && latest < 1200, `${latest} of ${RUNNERS.length} runners got the latest release at 50%`);
});

test('raising the percentage only ever adds runners to the latest release', () => {
  for (const id of RUNNERS) {
    let had = false;
    for (let percent = 0; percent <= 100; percent += 5) {
      const has = assignRunnerRelease(id, BOTH, rollout(percent))?.version === LATEST;
      assert.ok(has || !had, `${id} left the latest release when the rollout went up to ${percent}%`);
      had = has;
    }
    assert.ok(had, `${id} did not get the latest release at 100%`);
  }
});

test('a rollback assigns every runner the previous release, marked as a rollback, at any percentage', () => {
  for (const percent of [0, 50, 100]) {
    for (const id of [...RUNNERS, ...Object.values(AT_BUCKET)]) {
      assert.deepEqual(assignRunnerRelease(id, BOTH, rollback(LATEST, percent)), ROLLED_BACK, `${id} at ${percent}%`);
    }
  }
});

test('a rollback with no previous release to go to assigns nothing, so no runner moves', () => {
  for (const id of RUNNERS.slice(0, 50)) {
    assert.equal(assignRunnerRelease(id, { latest: LATEST, previous: null }, rollback(LATEST)), null);
  }
});

test('a rollback naming the previous release withdraws it: every runner gets the latest, nobody is held on it', () => {
  for (const percent of [0, 50, 100]) {
    for (const id of RUNNERS) {
      assert.deepEqual(assignRunnerRelease(id, BOTH, rollback(PREVIOUS, percent)), LATEST_RELEASE);
    }
  }
});

test('a rollback naming neither published release is ignored', () => {
  for (const id of RUNNERS) {
    assert.deepEqual(assignRunnerRelease(id, BOTH, rollback('0.1.210', 50)), assignRunnerRelease(id, BOTH, rollout(50)));
  }
});

test('with no previous release every runner gets the latest, whatever the percentage', () => {
  for (const percent of [0, 50]) {
    for (const id of RUNNERS.slice(0, 200)) {
      assert.deepEqual(assignRunnerRelease(id, { latest: LATEST, previous: null }, rollout(percent)), LATEST_RELEASE);
    }
  }
});

test('a "previous" release that is not older than the latest is not held at or rolled back to', () => {
  for (const previous of [LATEST, '0.1.300']) {
    for (const id of Object.values(AT_BUCKET)) {
      assert.deepEqual(assignRunnerRelease(id, { latest: LATEST, previous }, rollout(0)), LATEST_RELEASE);
      assert.equal(assignRunnerRelease(id, { latest: LATEST, previous }, rollback(LATEST)), null);
    }
  }
});

test('versions are ordered the way the runner orders them', () => {
  assert.equal(compareRunnerReleaseVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareRunnerReleaseVersions('0.1.9', '0.1.10'), -1);
  assert.equal(compareRunnerReleaseVersions('0.2', '0.1.99'), 1);
  assert.equal(compareRunnerReleaseVersions('0.1', '0.1.0'), 0);
});

test('the pointer is read with its defaults, and refused rather than guessed at when it cannot be', () => {
  assert.deepEqual(readRunnerReleasePolicy({}), { policy: { rolloutPercent: 100, rollback: null } });
  assert.deepEqual(readRunnerReleasePolicy({ rolloutPercent: 0, rollback: LATEST }), {
    policy: { rolloutPercent: 0, rollback: LATEST },
  });
  for (const rolloutPercent of [-1, 101, 12.5, '50', null]) {
    const read = readRunnerReleasePolicy({ rolloutPercent });
    assert.ok('problems' in read, `rolloutPercent ${JSON.stringify(rolloutPercent)} was taken`);
    assert.match(read.problems.join(), /rolloutPercent .* is not a whole number from 0 to 100/);
  }
  for (const value of [true, 1, 'v0.1.216', 'previous', '']) {
    const read = readRunnerReleasePolicy({ rollback: value });
    assert.ok('problems' in read, `rollback ${JSON.stringify(value)} was taken`);
    assert.match(read.problems.join(), /rollback .* is neither null nor a release version/);
  }
  for (const raw of [null, [], 'rollback', 50]) assert.ok('problems' in readRunnerReleasePolicy(raw));
});

test('the repository’s runner-release.json reads without a problem', () => {
  const read = loadRunnerReleasePolicy(RUNNER_RELEASE_POLICY_FILE);
  assert.ok('policy' in read, `runner-release.json: ${'problems' in read ? read.problems.join('; ') : ''}`);
});

test('a pointer file that is missing publishes the latest release to everyone; one that is not JSON is refused', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'runner-release-'));
  assert.deepEqual(loadRunnerReleasePolicy(path.join(dir, 'absent.json')), { policy: { rolloutPercent: 100, rollback: null } });
  writeFileSync(path.join(dir, 'broken.json'), '{ "rolloutPercent": 50,');
  assert.deepEqual(loadRunnerReleasePolicy(path.join(dir, 'broken.json')), { problems: ['it is not JSON'] });
  writeFileSync(path.join(dir, 'half.json'), '{ "rolloutPercent": 50 }');
  assert.deepEqual(loadRunnerReleasePolicy(path.join(dir, 'half.json')), { policy: { rolloutPercent: 50, rollback: null } });
});

test('the log says what every runner is assigned', () => {
  assert.equal(describeRunnerRelease(BOTH, rollout(100)), 'runner release 0.1.216 to every runner');
  assert.equal(
    describeRunnerRelease(BOTH, rollout(50)),
    'runner release 0.1.216 to 50% of runners; the rest are held at 0.1.215',
  );
  assert.equal(
    describeRunnerRelease(BOTH, rollback(LATEST)),
    'runner release 0.1.216 is rolled back: every runner is assigned 0.1.215',
  );
  assert.equal(
    describeRunnerRelease({ latest: LATEST, previous: null }, rollback(LATEST)),
    'runner-release.json rolls back 0.1.216, but /dl keeps no release before it: no runner is moved',
  );
  assert.equal(
    describeRunnerRelease(BOTH, rollback(PREVIOUS, 50)),
    'runner release 0.1.216 to every runner (0.1.215 is withdrawn)',
  );
  assert.equal(
    describeRunnerRelease(BOTH, rollback('0.1.210', 50)),
    'runner-release.json rolls back 0.1.210, which /dl no longer publishes: ignored. ' +
      'runner release 0.1.216 to 50% of runners; the rest are held at 0.1.215',
  );
});

/** The refusal code `attempt` throws as `type`, which the runner reads as "keep what you run". */
function refusal(attempt: () => unknown, type: typeof BadRequestException | typeof ConflictException): string | undefined {
  try {
    attempt();
  } catch (error) {
    assert.ok(error instanceof type, `${String(error)} is not a ${type.name}`);
    assert.notEqual(error.getStatus(), 404, 'a 404 tells the runner to install /dl/version.json');
    return (error.getResponse() as { code?: string }).code;
  }
  assert.fail('it was answered');
}

test('GET /api/runner/release answers for the authenticated runner from the image’s own pointer', () => {
  const controller = new RunnerReleaseController();
  const runner = { id: AT_BUCKET[99] } as Runner;
  const read = loadRunnerReleasePolicy(RUNNER_RELEASE_POLICY_FILE);
  assert.ok('policy' in read);
  const expected = assignRunnerRelease(runner.id, BOTH, read.policy);
  if (expected) assert.deepEqual(controller.assign(runner, LATEST, PREVIOUS), expected);
  if (read.policy.rollback !== LATEST) {
    assert.deepEqual(controller.assign(runner, LATEST, undefined), LATEST_RELEASE);
  }
});

test('the route answers by the runner’s id, and the pointer it is read under', () => {
  assert.deepEqual(answerRunnerRelease(AT_BUCKET[49], LATEST, PREVIOUS, { policy: rollout(50) }), LATEST_RELEASE);
  assert.deepEqual(answerRunnerRelease(AT_BUCKET[50], LATEST, PREVIOUS, { policy: rollout(50) }), HELD_AT_PREVIOUS);
  assert.deepEqual(answerRunnerRelease(AT_BUCKET[50], LATEST, undefined, { policy: rollout(50) }), LATEST_RELEASE);
  for (const id of Object.values(AT_BUCKET)) {
    assert.deepEqual(answerRunnerRelease(id, LATEST, PREVIOUS, { policy: rollback(LATEST, 50) }), ROLLED_BACK);
  }
});

test('the route refuses — never with a 404 — what it cannot answer, so the runner keeps its release', () => {
  const policy = { policy: rollout(50) };
  for (const [latest, previous] of [
    [undefined, PREVIOUS],
    ['', PREVIOUS],
    ['latest', PREVIOUS],
    [[LATEST, LATEST], PREVIOUS],
    [LATEST, ''],
    [LATEST, 'v0.1.215'],
    [LATEST, [PREVIOUS, PREVIOUS]],
  ] as const) {
    assert.equal(
      refusal(() => answerRunnerRelease(AT_BUCKET[0], latest, previous, policy), BadRequestException),
      'RUNNER_RELEASE_VERSION_INVALID',
      `latest=${JSON.stringify(latest)} previous=${JSON.stringify(previous)}`,
    );
  }
  assert.equal(
    refusal(() => answerRunnerRelease(AT_BUCKET[0], LATEST, undefined, { policy: rollback(LATEST) }), ConflictException),
    'RUNNER_RELEASE_ROLLBACK_UNAVAILABLE',
  );
  assert.equal(
    refusal(
      () => answerRunnerRelease(AT_BUCKET[0], LATEST, PREVIOUS, { problems: ['rolloutPercent "50" is not a whole number'] }),
      ConflictException,
    ),
    'RUNNER_RELEASE_POINTER_UNREADABLE',
  );
});

const HTTP_TOKEN = 'runner-release-http-token';
const HTTP_RUNNER = { id: AT_BUCKET[50], ownerId: randomUUID() };

@Module({
  controllers: [RunnerReleaseController],
  providers: [
    RunnerAuthGuard,
    {
      provide: PrismaService,
      // The two reads RunnerAuthGuard makes: the runner whose token hashes to the presented one, and
      // its managed runner mapping — none: a self-managed runner, whose credential is bound to nothing.
      useValue: {
        runner: {
          findFirst: async ({ where }: { where: { tokenHash: string } }) =>
            where.tokenHash === sha256(HTTP_TOKEN) ? HTTP_RUNNER : null,
        },
        managedRunner: { findUnique: async () => null },
      },
    },
  ],
})
class RunnerReleaseHttpModule {}

test('over HTTP, the runner token says which runner is asking and the query which releases /dl publishes', async (t) => {
  const app = await NestFactory.create(RunnerReleaseHttpModule, { logger: false, abortOnError: false });
  // As main.ts sets the app up.
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = await app.getUrl();
  const auth = { authorization: `Bearer ${HTTP_TOKEN}` };

  const read = loadRunnerReleasePolicy(RUNNER_RELEASE_POLICY_FILE);
  assert.ok('policy' in read);
  const answered = await fetch(`${base}/api/runner/release?latest=${LATEST}&previous=${PREVIOUS}`, { headers: auth });
  assert.equal(answered.status, 200);
  assert.deepEqual(await answered.json(), assignRunnerRelease(HTTP_RUNNER.id, BOTH, read.policy));

  assert.equal((await fetch(`${base}/api/runner/release?latest=${LATEST}`)).status, 401, 'no runner token');
  assert.equal(
    (await fetch(`${base}/api/runner/release?latest=${LATEST}`, { headers: { authorization: 'Bearer another' } })).status,
    401,
    'a token no runner holds',
  );
  const refused = await fetch(`${base}/api/runner/release?latest=latest`, { headers: auth });
  assert.equal(refused.status, 400);
  assert.equal(((await refused.json()) as { code?: string }).code, 'RUNNER_RELEASE_VERSION_INVALID');
});
