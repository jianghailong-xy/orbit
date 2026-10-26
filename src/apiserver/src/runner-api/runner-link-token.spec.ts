import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { mock, test } from 'node:test';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import type { Runner } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { RunnerLinkGatewayGuard, RunnerLinkTokenController } from './runner-link-token.controller';
import {
  CheckedRunnerLinkTokens,
  RUNNER_LINK_AUDIENCE,
  RUNNER_LINK_CELL,
  RUNNER_LINK_NOT_CONFIGURED,
  RUNNER_LINK_REVOCATION_WINDOW_MS,
  RUNNER_LINK_TOKEN_TTL_SECONDS,
  RunnerLinkTokenRefused,
  isRunnerLinkGateway,
  readRunnerLink,
  runnerLinkCredential,
  runnerLinkFrom,
  signRunnerLinkToken,
  verifyRunnerLinkToken,
  type RunnerLinkConfig,
  type RunnerLinkState,
} from './runner-link-token';
// The module object itself, whose `verify` runner-link-token.ts calls: what a spy on it counts.
import nodeCrypto = require('node:crypto');

/**
 * The runner link's connection tokens (runner-link-token.ts, docs/runner-link-design.md §5.4/§6.2):
 * the three settings, the token a runner is issued and what a verifier holding only the public key
 * makes of it — its claims, its hour, a signature or claim that was tampered with — the gateway's
 * secret, and both routes against a fake database. What the trigger revokes, and the routes through
 * the production apiserver, are `runner-link-token.pg.spec.ts`'s.
 */

const GATEWAY_TOKEN = 'g'.repeat(32) + '-gateway-secret';
const LINK_URL = 'wss://link.example.test/v1';
const RUNNER_ID = '0192f3b4-1c2d-7e8f-9a0b-1c2d3e4f5a6b';
const OWNER_ID = '0192f3b4-1c2d-7e8f-9a0b-1c2d3e4f5a6c';
const LEASE_OWNER = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
const TOKEN_HASH = createHash('sha256').update('runner-token').digest('hex');

/** RFC 8037 Appendix A.1's Ed25519 key, whose RFC 7638 thumbprint Appendix A.3 states. */
const RFC8037_KEY = createPrivateKey({
  key: {
    kty: 'OKP',
    crv: 'Ed25519',
    d: 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A',
    x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
  },
  format: 'jwk',
});

const base64Pem = (key: KeyObject) => Buffer.from(key.export({ format: 'pem', type: 'pkcs8' }) as string).toString('base64');

function settings(overrides: { signingKey?: string; linkUrl?: string; gatewayToken?: string } = {}) {
  return {
    signingKey: base64Pem(generateKeyPairSync('ed25519').privateKey),
    linkUrl: LINK_URL,
    gatewayToken: GATEWAY_TOKEN,
    ...overrides,
  };
}

function configured(overrides: Parameters<typeof settings>[0] = {}): RunnerLinkConfig {
  const { config, problems } = readRunnerLink(settings(overrides));
  assert.deepEqual(problems, []);
  assert.ok(config);
  return config;
}

function issue(config: RunnerLinkConfig, now = new Date('2026-10-25T04:00:00.000Z')) {
  return signRunnerLinkToken(
    config,
    { runnerId: RUNNER_ID, ownerId: OWNER_ID, cellId: RUNNER_LINK_CELL, leaseOwner: LEASE_OWNER, credential: runnerLinkCredential(TOKEN_HASH) },
    now,
  );
}

const decode = (segment: string) => JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof RunnerLinkTokenRefused, `refused with ${String(error)}`);
    return error.reason;
  }
  assert.fail('the token was accepted');
}

test('with none of the three settings the link is off, and there is nothing to report', () => {
  assert.deepEqual(readRunnerLink({}), { config: null, problems: [] });
  assert.deepEqual(readRunnerLink({ signingKey: ' ', linkUrl: '', gatewayToken: undefined }), { config: null, problems: [] });
});

test('all three make the configuration: the key and its public half, its RFC 7638 key id, the address and the secret', () => {
  const config = configured({ signingKey: base64Pem(RFC8037_KEY) });
  assert.equal(config.keyId, 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k', 'RFC 8037 A.3 states this thumbprint for its key');
  assert.equal(config.publicKey.export({ format: 'jwk' }).x, '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo');
  assert.equal(config.linkUrl, LINK_URL);
  assert.equal(config.gatewayToken, GATEWAY_TOKEN);
  assert.equal(configured({ linkUrl: 'ws://127.0.0.1:8443' }).linkUrl, 'ws://127.0.0.1:8443', 'ws:// is taken as well, for a local stack');
});

test('a missing or unusable setting leaves the link off, and says which, once each', () => {
  const off = (overrides: Parameters<typeof settings>[0]) => {
    const state = readRunnerLink(settings(overrides));
    assert.equal(state.config, null);
    assert.ok(state.problems.length > 0);
    for (const problem of state.problems) assert.match(problem, /: the runner link is off$/);
    return state.problems.join('\n');
  };
  assert.deepEqual(readRunnerLink({ linkUrl: LINK_URL }).problems, [
    'RUNNER_LINK_SIGNING_KEY is not set: the runner link is off',
    'RUNNER_LINK_GATEWAY_TOKEN is not set: the runner link is off',
  ]);
  assert.match(off({ signingKey: 'not-a-key' }), /RUNNER_LINK_SIGNING_KEY is not base64 of an Ed25519 private key in PEM/);
  const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  assert.match(off({ signingKey: pem }), /RUNNER_LINK_SIGNING_KEY is not base64/, 'the PEM itself, not base64 of it');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.match(off({ signingKey: base64Pem(rsa) }), /not base64 of an Ed25519 private key/, 'an RSA key is not an Ed25519 one');
  assert.match(off({ linkUrl: 'https://link.example.test' }), /RUNNER_LINK_URL="https:\/\/link.example.test" is not a ws:\/\/ or wss:\/\/ address/);
  assert.match(off({ linkUrl: 'link.example.test' }), /RUNNER_LINK_URL=.* is not a ws:\/\/ or wss:\/\/ address/);
  assert.match(off({ gatewayToken: 'short' }), /RUNNER_LINK_GATEWAY_TOKEN is shorter than 32 characters/);

  const logged: string[] = [];
  const state = runnerLinkFrom({ get: (name: string) => ({ RUNNER_LINK_URL: LINK_URL } as Record<string, string>)[name] }, { error: (line: string) => logged.push(line) });
  assert.equal(state.config, null);
  assert.deepEqual(logged, state.problems, 'each problem is logged once, as it was found');
  assert.deepEqual(runnerLinkFrom({ get: () => undefined }, { error: () => assert.fail('nothing set is nothing to log') }).problems, []);
});

test('a token names the runner, its tenant, the cell and its address, the process and the credential, for an hour', () => {
  const config = configured();
  const now = new Date('2026-10-25T04:00:00.400Z');
  const { token, claims } = issue(config, now);
  const [header, payload] = token.split('.');
  assert.deepEqual(decode(header), { alg: 'EdDSA', typ: 'JWT', kid: config.keyId });
  assert.deepEqual(decode(payload), claims);
  assert.deepEqual(Object.keys(claims).sort(), [
    'aud', 'cellId', 'credential', 'exp', 'iat', 'jti', 'leaseOwner', 'linkUrl', 'ownerId', 'runnerId',
  ]);
  assert.equal(claims.aud, RUNNER_LINK_AUDIENCE);
  assert.equal(claims.runnerId, RUNNER_ID);
  assert.equal(claims.ownerId, OWNER_ID);
  assert.equal(claims.cellId, 'cell-1');
  assert.equal(claims.linkUrl, LINK_URL);
  assert.equal(claims.leaseOwner, LEASE_OWNER);
  assert.equal(claims.credential, runnerLinkCredential(TOKEN_HASH));
  assert.match(claims.jti, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(claims.iat, Math.floor(now.getTime() / 1000));
  assert.equal(claims.exp - claims.iat, RUNNER_LINK_TOKEN_TTL_SECONDS);
  assert.equal(RUNNER_LINK_TOKEN_TTL_SECONDS, 3600);
  assert.notEqual(issue(config, now).claims.jti, claims.jti, 'every token is its own');
  assert.deepEqual(verifyRunnerLinkToken(token, config.publicKey, now), claims);
});

test('the signature is plain EdDSA over Ed25519: the 32 raw bytes of the public key are all a verifier needs', () => {
  const config = configured();
  const { token } = issue(config);
  const [header, payload, signature] = token.split('.');
  const raw = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: config.publicKey.export({ format: 'jwk' }).x! }, format: 'jwk' });
  assert.equal(verify(null, Buffer.from(`${header}.${payload}`), raw, Buffer.from(signature, 'base64url')), true);
  assert.equal(Buffer.from(signature, 'base64url').length, 64);
});

test('a token expires an hour after it was issued', () => {
  const config = configured();
  const issuedAt = new Date('2026-10-25T04:00:00.000Z');
  const { token, claims } = issue(config, issuedAt);
  const at = (seconds: number) => new Date(issuedAt.getTime() + seconds * 1000);
  assert.equal(verifyRunnerLinkToken(token, config.publicKey, at(0)).exp, claims.exp);
  assert.equal(verifyRunnerLinkToken(token, config.publicKey, at(3599.999)).exp, claims.exp);
  assert.equal(refusal(() => verifyRunnerLinkToken(token, config.publicKey, at(3600))), 'EXPIRED');
  assert.equal(refusal(() => verifyRunnerLinkToken(token, config.publicKey, at(86_400))), 'EXPIRED');
});

test('a token whose signature passed is not checked again while it lives, and only under the key that checked it', () => {
  const config = configured();
  const now = new Date('2026-10-25T04:00:00.000Z');
  const { token, claims } = issue(config, now);
  const [header, , signature] = token.split('.');
  const checks = mock.method(nodeCrypto, 'verify');
  try {
    assert.deepEqual(verifyRunnerLinkToken(token, config.publicKey, now), claims);
    assert.deepEqual(verifyRunnerLinkToken(token, config.publicKey, new Date(now.getTime() + 60_000)), claims);
    assert.equal(checks.mock.callCount(), 1, 'the next call of the connection is not checked again');
    assert.equal(refusal(() => verifyRunnerLinkToken(token, configured().publicKey, now)), 'SIGNATURE', 'another key checks it afresh');
    const forged = `${header}.${encode({ ...claims, runnerId: OWNER_ID })}.${signature}`;
    assert.equal(refusal(() => verifyRunnerLinkToken(forged, config.publicKey, now)), 'SIGNATURE', 'its signature on other claims');
    assert.equal(refusal(() => verifyRunnerLinkToken(forged, config.publicKey, now)), 'SIGNATURE', 'a refused token is not kept');
    assert.equal(checks.mock.callCount(), 4);
    assert.equal(refusal(() => verifyRunnerLinkToken(token, config.publicKey, new Date(claims.exp * 1000))), 'EXPIRED', 'its expiry is read each time');
  } finally {
    checks.mock.restore();
  }
});

test('the checked tokens kept are bounded: when full, the expired go first, then the oldest', () => {
  const config = configured();
  const tokens = new CheckedRunnerLinkTokens(2);
  const claims = (exp: number) => ({ ...issue(config).claims, exp });
  const at = (seconds: number) => new Date(seconds * 1000);
  const kept = (...names: string[]) => names.map((name) => tokens.get(name, config.publicKey) !== undefined);
  tokens.remember('a', config.publicKey, claims(10), at(0));
  tokens.remember('b', config.publicKey, claims(1000), at(0));
  tokens.remember('c', config.publicKey, claims(1000), at(20));
  assert.deepEqual(kept('a', 'b', 'c'), [false, true, true], 'the expired one went');
  tokens.remember('d', config.publicKey, claims(1000), at(20));
  assert.deepEqual(kept('b', 'c', 'd'), [false, true, true], 'then the oldest');
  assert.equal(tokens.get('c', configured().publicKey), undefined, 'a token is kept under the key that checked it');
});

test("a token this server did not sign, or that was changed after it was, is refused", () => {
  const config = configured();
  const now = new Date('2026-10-25T04:00:00.000Z');
  const { token, claims } = issue(config, now);
  const [header, payload, signature] = token.split('.');
  const check = (candidate: string, key = config.publicKey) => refusal(() => verifyRunnerLinkToken(candidate, key, now));

  assert.equal(check(`${header}.${encode({ ...claims, runnerId: OWNER_ID })}.${signature}`), 'SIGNATURE', 'another runner');
  assert.equal(check(`${header}.${encode({ ...claims, exp: claims.exp + 86_400 })}.${signature}`), 'SIGNATURE', 'a longer life');
  assert.equal(check(token, configured().publicKey), 'SIGNATURE', 'another key');
  assert.equal(check(`${header}.${payload}.${signature.slice(0, 20)}`), 'SIGNATURE', 'a cut signature');
  assert.equal(check(`${encode({ alg: 'none' })}.${payload}.`), 'MALFORMED', 'an unsigned token');
  assert.equal(check(`${encode({ alg: 'HS256', typ: 'JWT' })}.${payload}.${signature}`), 'MALFORMED', 'another algorithm');
  assert.equal(check(`${header}.${payload}`), 'MALFORMED');
  assert.equal(check('not a token at all'), 'MALFORMED');
  assert.equal(check(`${header}.not-json.${signature}`), 'MALFORMED');

  // Signed with this key, for another audience: not a connection token.
  const other = `${header}.${encode({ ...claims, aud: 'orbit-service-token' })}`;
  const signed = `${other}.${sign(null, Buffer.from(other), config.signingKey).toString('base64url')}`;
  assert.equal(check(signed), 'AUDIENCE');
});

test('the credential fingerprint is the first 32 hex characters of a sha256 over the runner token hash', () => {
  const fingerprint = runnerLinkCredential(TOKEN_HASH);
  assert.match(fingerprint, /^[0-9a-f]{32}$/);
  assert.equal(runnerLinkCredential(TOKEN_HASH), fingerprint);
  assert.notEqual(runnerLinkCredential(createHash('sha256').update('rotated').digest('hex')), fingerprint);
  assert.notEqual(fingerprint, TOKEN_HASH.slice(0, 32), 'the hash the runner row keeps is not handed out');
});

test("only the gateway's secret, as a bearer, opens the revocation list", () => {
  const config = configured();
  assert.equal(isRunnerLinkGateway(config, `Bearer ${GATEWAY_TOKEN}`), true);
  for (const header of [undefined, '', 'Bearer', 'Bearer ', GATEWAY_TOKEN, `Basic ${GATEWAY_TOKEN}`, `Bearer ${GATEWAY_TOKEN}x`, `Bearer ${GATEWAY_TOKEN.slice(1)}`]) {
    assert.equal(isRunnerLinkGateway(config, header), false, String(header));
  }
});

// ── The routes, on a fake database ────────────────────────────────────────────────────────────────

const runner = { id: RUNNER_ID, ownerId: OWNER_ID, tokenHash: TOKEN_HASH } as Runner;

function database(cells = new Map<string, string>(), revocations: Array<{ credential: string; revokedAt: Date }> = []) {
  const writes: unknown[] = [];
  const reads: unknown[] = [];
  const prisma = {
    tenantCell: {
      findUnique: async ({ where }: { where: { ownerId: string } }) => {
        const cellId = cells.get(where.ownerId);
        return cellId ? { cellId } : null;
      },
      createMany: async (args: { data: Array<{ ownerId: string; cellId: string }>; skipDuplicates: boolean }) => {
        writes.push(args);
        for (const row of args.data) if (!cells.has(row.ownerId)) cells.set(row.ownerId, row.cellId);
        return { count: 1 };
      },
      findUniqueOrThrow: async ({ where }: { where: { ownerId: string } }) => ({ cellId: cells.get(where.ownerId)! }),
    },
    runnerLinkRevocation: {
      findMany: async (args: { where: { revokedAt: { gte: Date } } }) => {
        reads.push(args);
        return revocations.filter((row) => row.revokedAt >= args.where.revokedAt.gte);
      },
    },
  };
  return { prisma: prisma as unknown as PrismaService, writes, reads, cells };
}

const on = (config: RunnerLinkConfig): RunnerLinkState => ({ config, problems: [] });
const OFF: RunnerLinkState = { config: null, problems: [] };

function asGateway(authorization?: string): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ headers: authorization === undefined ? {} : { authorization } }) }) } as unknown as ExecutionContext;
}

async function answer(run: () => unknown): Promise<{ status: number; body: unknown }> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof HttpException, String(error));
    return { status: error.getStatus(), body: error.getResponse() };
  }
  assert.fail('answered without refusing');
}

test('with the link off both routes answer 404 RUNNER_LINK_NOT_CONFIGURED, before anything is read', async () => {
  const db = database();
  const controller = new RunnerLinkTokenController(db.prisma, OFF);
  const issued = await answer(() => controller.issue(runner, { leaseOwner: LEASE_OWNER }));
  assert.equal(issued.status, 404);
  assert.equal((issued.body as { code: string }).code, RUNNER_LINK_NOT_CONFIGURED);
  const listed = await answer(() => new RunnerLinkGatewayGuard(OFF).canActivate(asGateway(`Bearer ${GATEWAY_TOKEN}`)));
  assert.equal(listed.status, 404);
  assert.equal((listed.body as { code: string }).code, RUNNER_LINK_NOT_CONFIGURED);
  assert.deepEqual([db.writes, db.reads, [...db.cells]], [[], [], []]);
});

test('a token is issued only for a process identity: the leaseOwner the heartbeats carry', async () => {
  const db = database();
  const controller = new RunnerLinkTokenController(db.prisma, on(configured()));
  for (const body of [{}, { leaseOwner: '' }, { leaseOwner: 'not-a-uuid' }, undefined]) {
    const refused = await answer(() => controller.issue(runner, body as { leaseOwner?: string }));
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(db.writes, [], 'nothing is placed for a request that is refused');
});

test("the first request places the tenant in cell-1 with ON CONFLICT DO NOTHING; later ones only read it", async () => {
  const config = configured();
  const db = database();
  const controller = new RunnerLinkTokenController(db.prisma, on(config));
  const first = await controller.issue(runner, { leaseOwner: LEASE_OWNER.toUpperCase() });
  assert.deepEqual(db.writes, [{ data: [{ ownerId: OWNER_ID, cellId: 'cell-1' }], skipDuplicates: true }]);
  const second = await controller.issue(runner, { leaseOwner: LEASE_OWNER });
  assert.equal(db.writes.length, 1, 'a placed tenant is read, not placed again');

  assert.deepEqual(Object.keys(first).sort(), ['cellId', 'expiresAt', 'linkUrl', 'token']);
  assert.equal(first.cellId, 'cell-1');
  assert.equal(first.linkUrl, LINK_URL);
  const claims = verifyRunnerLinkToken(first.token, config.publicKey, new Date());
  assert.equal(first.expiresAt, new Date(claims.exp * 1000).toISOString());
  assert.deepEqual(
    { runnerId: claims.runnerId, ownerId: claims.ownerId, cellId: claims.cellId, linkUrl: claims.linkUrl, leaseOwner: claims.leaseOwner, credential: claims.credential },
    { runnerId: RUNNER_ID, ownerId: OWNER_ID, cellId: 'cell-1', linkUrl: LINK_URL, leaseOwner: LEASE_OWNER, credential: runnerLinkCredential(TOKEN_HASH) },
    'the process identity as the heartbeat parser spells it, and the credential the request authenticated with',
  );
  assert.ok(Math.abs(claims.exp * 1000 - Date.now() - 3600_000) < 60_000, 'about an hour from now');
  assert.notEqual(verifyRunnerLinkToken(second.token, config.publicKey, new Date()).jti, claims.jti);
});

test('the revocation list reaches back a token\'s lifetime and ten minutes, and gives fingerprints only', async () => {
  const now = Date.now();
  const db = database(new Map(), [
    { credential: 'a'.repeat(32), revokedAt: new Date(now - RUNNER_LINK_REVOCATION_WINDOW_MS - 60_000) },
    { credential: 'b'.repeat(32), revokedAt: new Date(now - 30 * 60_000) },
  ]);
  const listed = await new RunnerLinkTokenController(db.prisma, on(configured())).revocations();
  assert.equal(RUNNER_LINK_REVOCATION_WINDOW_MS, 70 * 60_000);
  const since = (db.reads[0] as { where: { revokedAt: { gte: Date } } }).where.revokedAt.gte;
  assert.ok(Math.abs(since.getTime() - (now - RUNNER_LINK_REVOCATION_WINDOW_MS)) < 5_000);
  assert.deepEqual(listed, {
    since: since.toISOString(),
    revocations: [{ credential: 'b'.repeat(32), revokedAt: new Date(now - 30 * 60_000).toISOString() }],
  });
});

test("the gateway's guard: 401 for anything but its secret, through for the secret", async () => {
  const guard = new RunnerLinkGatewayGuard(on(configured()));
  for (const header of [undefined, 'Bearer wrong', `Basic ${GATEWAY_TOKEN}`]) {
    const refused = await answer(() => guard.canActivate(asGateway(header)));
    assert.equal(refused.status, 401, String(header));
    assert.equal((refused.body as { code: string }).code, 'RUNNER_LINK_GATEWAY_UNAUTHORIZED');
  }
  assert.equal(guard.canActivate(asGateway(`Bearer ${GATEWAY_TOKEN}`)), true);
});
