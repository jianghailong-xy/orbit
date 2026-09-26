import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { type ExecutionContext, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { Prisma } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { RunnerWikiController } from '../runner-api/runner-wiki.controller';
import { appendWikiContext, type WikiPushSubject } from './wiki-push';
import {
  readWikiRollout,
  WIKI_DISABLED,
  WIKI_ROLLOUT_MODES,
  wikiClaimFields,
  wikiDisabledError,
  wikiOnFor,
  WikiRolloutGuard,
  type WikiRollout,
} from './wiki-rollout';
import { WikiController } from './wiki.controller';

/**
 * The wiki's rollout flag (wiki-rollout.ts) without a database: how ORBIT_WIKI is read, who has the wiki under each
 * mode, what a refused request answers, what a claim carries, that both doors are closed on every route they have,
 * and that the push reads nothing for an account the wiki is off for. The same flag over real HTTP and PostgreSQL —
 * every route answered, the claim and the reclaim a runner receives — is wiki-rollout.pg.spec.ts, and the push
 * through the real delivery is a case of wiki-push.pg.spec.ts.
 */

const A = randomUUID();
const B = randomUUID();

// From build/wiki back to the repository root, as wiki-api.pg.spec.ts reads it.
const CONTRACT = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../contracts/wiki.contract.json'), 'utf8'),
) as {
  refusals: Array<{ code: string; httpStatus: number }>;
  agentSurface: { rollout: { env: string; values: string[]; default: string; canaryOwnersEnv: string } };
};

/** The flag as ORBIT_WIKI and ORBIT_WIKI_CANARY_OWNERS set it, for the length of `run`; restored after. */
async function withEnv<T>(env: { ORBIT_WIKI?: string; ORBIT_WIKI_CANARY_OWNERS?: string }, run: () => T | Promise<T>): Promise<T> {
  const saved = { mode: process.env.ORBIT_WIKI, owners: process.env.ORBIT_WIKI_CANARY_OWNERS };
  try {
    if (env.ORBIT_WIKI === undefined) delete process.env.ORBIT_WIKI;
    else process.env.ORBIT_WIKI = env.ORBIT_WIKI;
    if (env.ORBIT_WIKI_CANARY_OWNERS === undefined) delete process.env.ORBIT_WIKI_CANARY_OWNERS;
    else process.env.ORBIT_WIKI_CANARY_OWNERS = env.ORBIT_WIKI_CANARY_OWNERS;
    return await run();
  } finally {
    if (saved.mode === undefined) delete process.env.ORBIT_WIKI;
    else process.env.ORBIT_WIKI = saved.mode;
    if (saved.owners === undefined) delete process.env.ORBIT_WIKI_CANARY_OWNERS;
    else process.env.ORBIT_WIKI_CANARY_OWNERS = saved.owners;
  }
}

test('ORBIT_WIKI is read as on by default, and a value nobody can read as off', () => {
  assert.equal(readWikiRollout({}).mode, 'on');
  assert.deepEqual(readWikiRollout({}).problems, []);
  assert.equal(readWikiRollout({ ORBIT_WIKI: ' Canary ' }).mode, 'canary');
  const typo = readWikiRollout({ ORBIT_WIKI: 'of' });
  assert.equal(typo.mode, 'off');
  assert.match(typo.problems.join('\n'), /ORBIT_WIKI="of" is none of on, canary, off: the wiki is off/);
  // Watch's vocabulary is not this flag's: there is no worker a drain could leave running, so it reads as a typo.
  assert.equal(readWikiRollout({ ORBIT_WIKI: 'drain' }).mode, 'off');

  const canary = readWikiRollout({
    ORBIT_WIKI: 'canary',
    ORBIT_WIKI_CANARY_OWNERS: ` ${A.toUpperCase()}, ${uuidToBase62(B)} ,not an id`,
  });
  assert.deepEqual([...canary.canaryOwners].sort(), [A, B].sort(), 'a uuid in any case and a public id both name an account');
  assert.match(canary.problems.join('\n'), /names "not an id", which is no account id: it is ignored/);
  assert.match(readWikiRollout({ ORBIT_WIKI: 'canary' }).problems.join('\n'), /no account has the wiki/);

  const ignored = readWikiRollout({ ORBIT_WIKI: 'off', ORBIT_WIKI_CANARY_OWNERS: A });
  assert.equal(ignored.canaryOwners.size, 0);
  assert.match(ignored.problems.join('\n'), /read only under ORBIT_WIKI=canary, and the wiki is off: it is ignored/);
});

test('the modes, the default and the two variables are the contract\'s', () => {
  const rollout = CONTRACT.agentSurface.rollout;
  assert.equal(rollout.env, 'ORBIT_WIKI');
  assert.deepEqual([...WIKI_ROLLOUT_MODES].sort(), [...rollout.values].sort());
  assert.equal(readWikiRollout({}).mode, rollout.default);
  assert.equal(rollout.canaryOwnersEnv, 'ORBIT_WIKI_CANARY_OWNERS');
  assert.equal(readWikiRollout({ ORBIT_WIKI: 'canary', [rollout.canaryOwnersEnv]: A }).canaryOwners.has(A), true);
  assert.equal(CONTRACT.refusals.find((refusal) => refusal.code === WIKI_DISABLED)?.httpStatus, 404);
});

test('who has the wiki, and what their claims carry, under each mode', () => {
  const cases: Array<[string, WikiRollout, boolean, boolean, boolean]> = [
    // mode, rollout, A has it, B has it, a request that names no account has it
    ['on', readWikiRollout({ ORBIT_WIKI: 'on' }), true, true, true],
    ['canary', readWikiRollout({ ORBIT_WIKI: 'canary', ORBIT_WIKI_CANARY_OWNERS: uuidToBase62(A) }), true, false, false],
    ['off', readWikiRollout({ ORBIT_WIKI: 'off' }), false, false, false],
  ];
  for (const [mode, rollout, a, b, nobody] of cases) {
    assert.equal(wikiOnFor(rollout, A), a, `${mode}: A`);
    assert.equal(wikiOnFor(rollout, A.toUpperCase()), a, `${mode}: A spelled in capitals`);
    assert.equal(wikiOnFor(rollout, B), b, `${mode}: B`);
    assert.equal(wikiOnFor(rollout, null), nobody, `${mode}: no account`);
    // Absent while the wiki is on: exactly the payload every runner has always received.
    assert.deepEqual(wikiClaimFields(rollout, A), a ? {} : { wikiDisabled: true }, `${mode}: A's claim`);
    assert.deepEqual(wikiClaimFields(rollout, B), b ? {} : { wikiDisabled: true }, `${mode}: B's claim`);
  }
});

test('a refused request is the 404 a server without the wiki gives, with the code and the reason', () => {
  const error = wikiDisabledError(readWikiRollout({ ORBIT_WIKI: 'canary', ORBIT_WIKI_CANARY_OWNERS: A }));
  assert.ok(error instanceof NotFoundException);
  assert.equal(error.getStatus(), 404);
  const body = error.getResponse() as { code?: string; message?: string };
  assert.equal(body.code, WIKI_DISABLED);
  assert.match(body.message ?? '', /not on for this account on this Orbit server \(ORBIT_WIKI=canary\)/);
});

/** What Nest hands a guard: the request the credential guard before it has already filled in. */
function contextOf(request: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

/** The guard's answer: true, or the refusal it threw. */
function admits(request: Record<string, unknown>): true | { status: number; code?: string } {
  try {
    return new WikiRolloutGuard().canActivate(contextOf(request)) as true;
  } catch (error) {
    assert.ok(error instanceof NotFoundException, `the guard threw something else: ${String(error)}`);
    return { status: error.getStatus(), code: (error.getResponse() as { code?: string }).code };
  }
}

test('the guard admits the account the credential proved exactly when the wiki is on for it, on either door', async () => {
  const refused = { status: 404, code: WIKI_DISABLED };
  const userA = { user: { userId: A, email: 'a@wiki.invalid' } };
  const userB = { user: { userId: B, email: 'b@wiki.invalid' } };
  const runnerA = { runner: { id: randomUUID(), ownerId: A } };
  const runnerB = { runner: { id: randomUUID(), ownerId: B } };

  await withEnv({}, () => {
    for (const request of [userA, userB, runnerA, runnerB]) assert.equal(admits(request), true, 'the default is on');
  });
  await withEnv({ ORBIT_WIKI: 'canary', ORBIT_WIKI_CANARY_OWNERS: uuidToBase62(A) }, () => {
    assert.equal(admits(userA), true, 'the listed account, on the user door');
    assert.equal(admits(runnerA), true, 'the listed account\'s runner, on the runner door');
    assert.deepEqual(admits(userB), refused, 'an account the canary does not list, on the user door');
    assert.deepEqual(admits(runnerB), refused, 'its runner, on the runner door');
    assert.deepEqual(admits({}), refused, 'a request no credential guard vouched for');
  });
  await withEnv({ ORBIT_WIKI: 'off' }, () => {
    for (const request of [userA, userB, runnerA, runnerB]) assert.deepEqual(admits(request), refused, 'off is off for all');
  });
});

/** Every route a controller serves: its handlers' HTTP method and path, read the way Nest's router reads them. */
function routesOf(controller: new (...args: never[]) => unknown): string[] {
  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];
  const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string;
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype).flatMap((name) => {
    const handler = prototype[name];
    if (name === 'constructor' || typeof handler !== 'function') return [];
    const route = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
    if (route === undefined) return [];
    const method = methods[Reflect.getMetadata(METHOD_METADATA, handler) as number];
    return [`${method} /${prefix}/${route}`.replace(/\/+$/, '')];
  });
}

test('both doors are closed by the flag on every route, after the credential guard', () => {
  for (const [controller, credential, atLeast] of [
    [WikiController, JwtAuthGuard, 13],
    [RunnerWikiController, RunnerAuthGuard, 3],
  ] as const) {
    // On the CLASS: a guard on the class runs before every handler, and a handler's own guards can only add to it,
    // never take it away — so no route this controller has, or is given later, can answer without asking the flag.
    assert.deepEqual(
      Reflect.getMetadata(GUARDS_METADATA, controller),
      [credential, WikiRolloutGuard],
      `${controller.name}: the flag is not the guard after the credential`,
    );
    const routes = routesOf(controller);
    assert.ok(routes.length >= atLeast, `${controller.name} serves ${routes.length} routes, fewer than ${atLeast}: ${routes.join(', ')}`);
    for (const name of Object.getOwnPropertyNames(controller.prototype).filter((own) => own !== 'constructor')) {
      const own = Reflect.getMetadata(GUARDS_METADATA, (controller.prototype as unknown as Record<string, object>)[name]);
      assert.ok(
        own === undefined || !(own as unknown[]).includes(WikiRolloutGuard),
        `${controller.name}.${name} repeats the flag's guard, so it would run twice`,
      );
    }
  }
});

/** A transaction no push for an account without the wiki may reach: every property read is recorded and throws. */
function untouchable(): { tx: Prisma.TransactionClient; touched: string[] } {
  const touched: string[] = [];
  const tx = new Proxy(
    {},
    {
      get(_target, property) {
        touched.push(String(property));
        throw new Error(`the database was reached through tx.${String(property)}`);
      },
    },
  );
  return { tx: tx as Prisma.TransactionClient, touched };
}

test('an account the wiki is off for is handed what it was going to be handed, and nothing is read', async () => {
  const subject: WikiPushSubject = {
    sessionId: randomUUID(),
    turnId: randomUUID(),
    leaseGeneration: randomUUID(),
    ownerId: B,
    workspaceId: randomUUID(),
    taskId: null,
    task: null,
    dispatchOrigin: 'USER',
    content: 'pick this up',
  };
  for (const [why, rollout] of [
    ['off', readWikiRollout({ ORBIT_WIKI: 'off' })],
    ['a canary that lists another account', readWikiRollout({ ORBIT_WIKI: 'canary', ORBIT_WIKI_CANARY_OWNERS: A })],
  ] as const) {
    const { tx, touched } = untouchable();
    assert.equal(await appendWikiContext(tx, subject, rollout), 'pick this up', `${why}: the content changed`);
    assert.deepEqual(touched, [], `${why}: the push read the database`);
  }

  // The paired positive: the same subject, with the wiki on for its account, goes to the database for its notes.
  for (const rollout of [readWikiRollout({ ORBIT_WIKI: 'on' }), readWikiRollout({ ORBIT_WIKI: 'canary', ORBIT_WIKI_CANARY_OWNERS: B })]) {
    const { tx, touched } = untouchable();
    await assert.rejects(appendWikiContext(tx, subject, rollout), /the database was reached/);
    assert.ok(touched.length > 0, `${rollout.mode}: the push never asked the database`);
  }
});
