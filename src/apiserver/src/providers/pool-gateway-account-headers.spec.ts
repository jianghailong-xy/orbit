/**
 * A person of a pool cannot point somebody else's key at another organization or project (task
 * 34bVBK78jvplQ4yLbfsKR, found by the T2 tenant-isolation census). `OpenAI-Organization` and
 * `OpenAI-Project` choose the organization and project a request is made in; OpenAI answers one the key is
 * not in with a 401 for the key, and the gateway took every 401 for the key being wrong and marked it
 * INVALID — so a member could switch off, one by one, keys other people put in. Neither header reaches
 * OpenAI now, and a 401 on a request that came with either marks nothing; a 401 on any other request
 * still marks the key.
 *
 * PoolGatewayService.forward itself, behind a real HTTP server, with a recorder standing where OpenAI
 * stands (POOL_GATEWAY_UPSTREAM) and codex's recorded request (fixtures/codex-gateway-recording.json).
 * Only the database is replaced — a stand-in answering the one read a key with no share cap and no pause
 * makes — and SharedPoolsService, whose marks are recorded instead of written. The gateway end to end on
 * PostgreSQL is pool-gateway.pg.spec.ts.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';

import express from 'express';

import type { PrismaService } from '../prisma/prisma.service';
import { loginForwardedHeaders } from './codex-login-gateway';
import { forwardedHeaders, PoolGatewayService, type GatewayCaller } from './pool-gateway.service';
import type { PoolUsageLedger } from './pool-usage-ledger';
import { encryptSecret } from './provider-crypto';
import type { SharedPoolsService } from './shared-pools.service';

process.env.PROVIDER_SECRET_KEY ??= 'pool-gateway-account-headers-spec';

/** What codex 0.158 sent through a configured provider. */
const RECORDING = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../src/providers/fixtures/codex-gateway-recording.json'), 'utf8'),
) as { request: { headers: Array<[string, string]>; bodyBase64: string } };
const CODEX_BODY = Buffer.from(RECORDING.request.bodyBase64, 'base64');
/** Codex's own headers, but its credential; `host` and the length are the transport's. */
const CODEX_HEADERS = Object.fromEntries(
  RECORDING.request.headers.filter(([name]) => !['host', 'content-length', 'authorization'].includes(name)),
);

const POOL = randomUUID();
const ANN = randomUUID();
const MAX = randomUUID();
const SECRET = `sk-proj-${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
/** Ann's key, which Max's session runs on: no share cap and no pause, so reading it is all the gateway asks. */
const KEY = {
  id: randomUUID(), label: 'orbit-org-1', contributorId: ANN, state: 'ACTIVE', enabled: true, shareCap: null,
  spentUntil: null, throttledUntil: null, pausedAt: null, pausedUntil: null, keyHint: SECRET.slice(-4),
  secretEncrypted: encryptSecret(SECRET),
};
const CALLER: GatewayCaller = {
  poolId: POOL, poolLabel: 'Shared', poolOwnerId: ANN, userId: MAX, sessionId: randomUUID(), sessionOwnerId: MAX,
  accountId: null, keyId: KEY.id,
};

/** The one read the gateway makes; anything else it asked of the database would throw. */
const prisma = {
  poolApiKey: {
    findFirst: async ({ where }: { where: { id: string; poolId: string } }) =>
      where.id === KEY.id && where.poolId === POOL ? { ...KEY } : null,
  },
} as unknown as PrismaService;

/** The keys SharedPoolsService was told to mark INVALID. */
const marked: string[] = [];
const pools = {
  markKeyInvalid: async (keyId: string) => {
    marked.push(keyId);
    return true;
  },
} as unknown as SharedPoolsService;
const ledger = { record: () => undefined, pendingOthersCostMicros: () => 0 } as unknown as PoolUsageLedger;

interface Answer {
  status: number;
  contentType: string;
  body: string;
}
const openAIError = (code: string, message: string): Answer => ({
  status: 401,
  contentType: 'application/json',
  body: JSON.stringify({ error: { message, type: 'invalid_request_error', param: null, code } }),
});
/** OpenAI's 401s for a key asked in an organization or project it is not in, and for a key it does not know. */
const ORGANIZATION_MISMATCH = openAIError('mismatched_organization', 'OpenAI-Organization header should match organization for API key');
const PROJECT_MISMATCH = openAIError('mismatched_project', 'OpenAI-Project header should match project for API key');
const KEY_REFUSED = openAIError(
  'invalid_api_key',
  `Incorrect API key provided: ${SECRET.slice(0, 12)}****${SECRET.slice(-4)}. You can find your API key at https://platform.openai.com/account/api-keys.`,
);
const STREAM: Answer = {
  status: 200,
  contentType: 'text/event-stream; charset=utf-8',
  body: 'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-5.1-codex","usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
};

/** What the recorder standing in for OpenAI was sent, and what it answers with next. */
const seen: Array<{ headers: IncomingHttpHeaders }> = [];
let answer: Answer = STREAM;
let openai: Server;
let gatewayServer: Server;
let base: string;

before(async () => {
  openai = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ headers: req.headers });
      res.writeHead(answer.status, { 'content-type': answer.contentType });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => openai.listen(0, '127.0.0.1', resolve));
  const gateway = new PoolGatewayService(prisma, pools, ledger, `http://127.0.0.1:${(openai.address() as AddressInfo).port}/v1`);
  // The path and the caller are PoolGatewayController's to settle; this is the session it settled on.
  const app = express();
  app.post('/api/gw/codex/responses', (req, res) => gateway.forward(req, res, CALLER));
  gatewayServer = createServer(app);
  await new Promise<void>((resolve) => gatewayServer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(gatewayServer.address() as AddressInfo).port}`;
});

after(async () => {
  for (const server of [gatewayServer, openai]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** Codex's recorded request on Max's session token, with `extra` headers as the sender wrote them. */
function send(extra: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/api/gw/codex/responses`, {
      method: 'POST',
      headers: { ...CODEX_HEADERS, authorization: 'Bearer orbit-gw-max-session', ...extra, 'content-length': String(CODEX_BODY.length) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.end(CODEX_BODY);
  });
}

const errorOf = (sent: { body: string }) => (JSON.parse(sent.body) as { error: { code: string; message: string } }).error;

test("neither header reaches OpenAI, in whatever case it was written, and the rest of codex's request does", async () => {
  // What both gateways build their headers with: the login pools' too.
  const incoming = {
    'content-type': 'application/json',
    'OpenAI-Organization': 'org-elsewhere',
    'openai-project': 'proj_elsewhere',
    'OPENAI-PROJECT': 'proj_other',
  };
  assert.deepEqual(forwardedHeaders(incoming, SECRET, 7), {
    'content-type': 'application/json',
    authorization: `Bearer ${SECRET}`,
    'content-length': '7',
  });
  assert.deepEqual(loginForwardedHeaders(incoming, 'ey.access', 'acct-owner', 7), {
    'content-type': 'application/json',
    authorization: 'Bearer ey.access',
    'content-length': '7',
    'chatgpt-account-id': 'acct-owner',
  });

  answer = STREAM;
  seen.length = 0;
  const sent = await send({ 'OpenAI-Organization': 'org-elsewhere', 'OpenAI-Project': 'proj_elsewhere' });
  assert.equal(sent.status, 200, sent.body);
  assert.equal(sent.body, STREAM.body);
  assert.equal(seen.length, 1);
  const [upstream] = seen;
  assert.equal(upstream.headers['openai-organization'], undefined, 'OpenAI-Organization reached OpenAI');
  assert.equal(upstream.headers['openai-project'], undefined, 'OpenAI-Project reached OpenAI');
  assert.equal(upstream.headers.authorization, `Bearer ${SECRET}`);
  for (const [name, value] of Object.entries(CODEX_HEADERS)) {
    assert.equal(upstream.headers[name], value, `codex's ${name} header did not arrive as sent`);
  }
});

test('a 401 on a request that named its own organization or project marks nothing, and says why without OpenAI\'s words', async () => {
  for (const [header, value, refusal] of [
    ['OpenAI-Organization', 'org-elsewhere', ORGANIZATION_MISMATCH],
    ['OpenAI-Project', 'proj_elsewhere', PROJECT_MISMATCH],
    // The request decides, not the words of the answer: a sender who tried to steer the key gets nothing
    // written on it, whatever OpenAI says. The next request without them — every one codex sends — would.
    ['openai-organization', 'org-elsewhere', KEY_REFUSED],
  ] as const) {
    answer = refusal;
    seen.length = 0;
    marked.length = 0;
    const sent = await send({ [header]: value });
    assert.equal(seen.length, 1, 'the request did not reach OpenAI');
    assert.equal(seen[0].headers[header.toLowerCase()], undefined, `${header} reached OpenAI`);
    assert.deepEqual(marked, [], `a 401 on a request with its own ${header} marked the key INVALID`);
    assert.equal(sent.status, 403, sent.body);
    const error = errorOf(sent);
    assert.equal(error.code, 'orbit_pool_key_rejected');
    assert.equal(
      error.message,
      `orbit-org-1 (sk-…${SECRET.slice(-4)}) was rejected by OpenAI on a request that named its own organization or project — ` +
        'the Orbit pool gateway does not forward OpenAI-Organization or OpenAI-Project, and the key stays in "Shared"',
    );
    assert.ok(!sent.body.includes(SECRET.slice(0, 12)), "OpenAI's words about the key reached the member");
    assert.ok(!sent.body.includes('header should match'), "OpenAI's words reached the member");
  }
});

test('a 401 on a request that named neither still marks the key INVALID', async () => {
  answer = KEY_REFUSED;
  seen.length = 0;
  marked.length = 0;
  const sent = await send({});
  assert.equal(seen.length, 1);
  assert.deepEqual(marked, [KEY.id]);
  assert.equal(sent.status, 403, sent.body);
  assert.equal(errorOf(sent).code, 'orbit_pool_key_rejected');
  assert.equal(
    errorOf(sent).message,
    `orbit-org-1 (sk-…${SECRET.slice(-4)}) was rejected by OpenAI — it stays out of "Shared" until its contributor or an admin ` +
      'replaces it, and your next turn moves to another key',
  );
  assert.ok(!sent.body.includes(SECRET.slice(0, 12)), "OpenAI's words about the key reached the member");
});
