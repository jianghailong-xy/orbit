/**
 * The /api/gw/anthropic gateway's upstream guard (docs/claude-engine-openai-gateway-design.md §5.3, decision D3):
 * the gateway calls only https://api.openai.com and the hosts ORBIT_GATEWAY_UPSTREAM_HOSTS lists, resolves the host
 * before connecting, refuses private, loopback, link-local and unlisted addresses, and never follows a 3xx.
 *
 *  - A key row whose host is private, loopback, link-local or unlisted (by its literal address or by what its name
 *    resolves to) is refused 403 in Anthropic's error shape, naming the key, and no socket is opened: neither
 *    net.Socket#connect, tls.connect nor the gateway's agent is ever called, and the upstream sees nothing.
 *  - An allowed host is called, on the address the guard checked.
 *  - A 3xx from upstream is answered as an error and not followed: one request upstream, one connection.
 *  - With the flag on, a key whose host the gateway may not call is not offered the claude engine.
 */
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import net, { type AddressInfo, type LookupFunction, type Socket } from 'node:net';
import tls from 'node:tls';
import { after, before, mock, test } from 'node:test';

import { AgentProvider, credentialEngines } from '@orbit/shared';
import type { Request, Response } from 'express';
import express from 'express';

import { DisabledAccounts } from '../auth/disabled-accounts';
import { sha256 } from '../common/crypto.util';
import type { PrismaService } from '../prisma/prisma.service';
import { AnthropicGatewayController } from './anthropic-gateway.controller';
import type { AnthropicLoginGatewayService } from './anthropic-login-gateway.service';
import { AnthropicGatewayService } from './anthropic-gateway.service';
import { GATEWAY_UPSTREAM_HOSTS_ENV, isNonPublicAddress, upstreamUrlRefusal, vetUpstream } from './gateway-upstream';
import { ANTHROPIC_GATEWAY_FLAG, engineTableOptions } from './key-gateway';
import { encryptSecret } from './provider-crypto';

process.env.PROVIDER_SECRET_KEY ??= 'gateway-upstream-spec';

const SECRET = 'sk-proj-gateway-upstream-spec-0123456789';
const USER = '0190f3c2-0000-7000-8000-0000000000cc';
const PUBLIC_ADDRESS = '203.0.113.10';

/** What the stand-in resolver answers per name; a name it does not know fails as DNS would. */
const DNS: Record<string, Array<{ address: string; family: number }>> = {
  'api.openai.com': [{ address: PUBLIC_ADDRESS, family: 4 }],
  'redirects.example.test': [{ address: '198.51.100.20', family: 4 }],
  'intranet.example.test': [{ address: '192.168.1.20', family: 4 }],
  'loopback.example.test': [{ address: '::1', family: 6 }],
  'mapped.example.test': [{ address: '::ffff:127.0.0.1', family: 6 }],
  'metadata.example.test': [{ address: '169.254.169.254', family: 4 }],
  'mixed.example.test': [{ address: '198.51.100.30', family: 4 }, { address: '10.0.0.5', family: 4 }],
  'unlisted.example.com': [{ address: '198.51.100.40', family: 4 }],
};
const resolved: string[] = [];

/** Keys by token; each key's endpoint is its token's case. */
const KEYS: Record<string, string> = {
  allowed: 'https://api.openai.com/v1',
  redirect: 'https://redirects.example.test/v1',
  privateLiteral: 'https://10.1.2.3/v1',
  privateName: 'https://intranet.example.test/v1',
  loopbackLiteral: 'https://127.0.0.1:8443/v1',
  loopbackV6Literal: 'https://[::1]/v1',
  loopbackName: 'https://loopback.example.test/v1',
  loopbackMapped: 'https://mapped.example.test/v1',
  linkLocalLiteral: 'https://169.254.169.254/latest',
  linkLocalV6Literal: 'https://[fe80::1]/v1',
  linkLocalName: 'https://metadata.example.test/v1',
  mixedName: 'https://mixed.example.test/v1',
  unlisted: 'https://unlisted.example.com/v1',
  plainHttp: 'http://api.openai.com/v1',
};
const LISTED = [
  'redirects.example.test', 'intranet.example.test', 'loopback.example.test', 'mapped.example.test',
  'metadata.example.test', 'mixed.example.test', '10.1.2.3', '127.0.0.1', '::1', '169.254.169.254', 'fe80::1',
];

function token(name: string): string {
  return `orbit-gwk-gateway-upstream-${name}`;
}

function tokenRow(name: string, baseUrl: string) {
  return {
    sessionId: '0190f3c2-0000-7000-8000-0000000000dd',
    userId: USER,
    expiresAt: new Date(Date.now() + 3_600_000),
    revokedAt: null,
    provider: {
      id: '0190f3c2-0000-7000-8000-000000000002', slug: `key-${name}`, ownerId: USER, runtime: 'codex', baseUrl,
      apiKeyEnc: encryptSecret(SECRET), enabled: true, presetSlug: 'openai', followsPreset: true, models: [],
    },
    session: {
      status: 'RUNNING', ownerId: USER, provider: `key-${name}`, engine: 'claude', model: 'gpt-5.1', completedAt: null,
      deletedAt: null, cancelRequestedAt: null, endReason: null, owner: { disabledAt: null },
    },
  };
}

let upstream: Server;
let gateway: Server;
let base: string;
let controller: AnthropicGatewayController;
/** What the server standing in for every upstream was sent. */
const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
/** Every connection the gateway's agent was asked to open: the host it named and what its pinned lookup answers. */
const agentConnections: Array<{ host: string; lookup?: LookupFunction }> = [];

const STREAM = [
  { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.1' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
  { type: 'response.output_text.delta', output_index: 0, delta: 'Hello' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } },
  { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.1', status: 'completed', usage: { input_tokens: 7, output_tokens: 1 }, output: [] } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

type PinnedLookup = (host: string, options: object, callback: (e: Error | null, address: string, family: number) => void) => void;

const TURN = { model: 'gpt-5.1', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] };

before(async () => {
  upstream = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ url: req.url!, headers: req.headers });
      if (req.headers.host === 'redirects.example.test') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end(STREAM);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const rows = new Map(Object.entries(KEYS).map(([name, url]) => [sha256(token(name)), tokenRow(name, url)]));
  const prisma = {
    keyGatewayToken: { findUnique: async ({ where }: { where: { tokenHash: string } }) => rows.get(where.tokenHash) ?? null },
  } as unknown as PrismaService;
  const service = new AnthropicGatewayService(prisma, new DisabledAccounts(prisma));
  service.resolveHost = async (host) => {
    resolved.push(host);
    const answer = DNS[host];
    if (!answer) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    return answer;
  };
  // The gateway's agent: records what it is asked to connect to, and opens that connection to the stand-in
  // upstream in plain HTTP (an allowed host is "called" when it gets here).
  service.agent = new (class extends HttpsAgent {
    override createConnection(options: { host?: string; lookup?: LookupFunction }): Socket {
      agentConnections.push({ host: String(options.host), lookup: options.lookup });
      return net.connect(upstreamPort, '127.0.0.1');
    }
  })();
  controller = new AnthropicGatewayController(service, {} as AnthropicLoginGatewayService);
  const app = express();
  app.all(/^\/api\/gw\/anthropic(\/.*)?$/, (req, res) => void controller.forward(req, res));
  gateway = createServer(app);
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  process.env[ANTHROPIC_GATEWAY_FLAG] = 'true';
  process.env[GATEWAY_UPSTREAM_HOSTS_ENV] = LISTED.join(', ');
});

after(async () => {
  delete process.env[ANTHROPIC_GATEWAY_FLAG];
  delete process.env[GATEWAY_UPSTREAM_HOSTS_ENV];
  for (const server of [gateway, upstream]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A request through the real HTTP stack to the gateway. */
function send(name: string, path = '/api/gw/anthropic/v1/messages?beta=true'): Promise<{ status: number; body: string }> {
  const payload = Buffer.from(JSON.stringify(TURN));
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token(name)}`, 'content-type': 'application/json', 'content-length': String(payload.length) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * The controller called in-process with a stand-in request and response, so that no socket at all is in play:
 * any socket the gateway opened would be its own outbound one.
 */
async function forwardInProcess(name: string, path: string): Promise<{ status: number; body: { type: string; error: { type: string; message: string } } }> {
  const answer = { status: 0, body: undefined as unknown };
  const res = {
    headersSent: false,
    status(code: number) {
      answer.status = code;
      return res;
    },
    json(value: unknown) {
      answer.body = value;
      res.headersSent = true;
      return res;
    },
  };
  const req = { method: 'POST', url: path, originalUrl: path, headers: { authorization: `Bearer ${token(name)}` } };
  await controller.forward(req as unknown as Request, res as unknown as Response);
  return answer as { status: number; body: { type: string; error: { type: string; message: string } } };
}

const REFUSED: Array<[string, RegExp]> = [
  ['privateLiteral', /10\.1\.2\.3 is a private, loopback or link-local address/],
  ['privateName', /intranet\.example\.test resolves to 192\.168\.1\.20/],
  ['loopbackLiteral', /127\.0\.0\.1 is a private, loopback or link-local address/],
  ['loopbackV6Literal', /::1 is a private, loopback or link-local address/],
  ['loopbackName', /loopback\.example\.test resolves to ::1/],
  ['loopbackMapped', /mapped\.example\.test resolves to ::ffff:127\.0\.0\.1/],
  ['linkLocalLiteral', /169\.254\.169\.254 is a private, loopback or link-local address/],
  ['linkLocalV6Literal', /fe80::1 is a private, loopback or link-local address/],
  ['linkLocalName', /metadata\.example\.test resolves to 169\.254\.169\.254/],
  ['mixedName', /mixed\.example\.test resolves to 10\.0\.0\.5/],
  ['unlisted', /unlisted\.example\.com is not api\.openai\.com or a host listed in ORBIT_GATEWAY_UPSTREAM_HOSTS/],
  ['plainHttp', /is not an https URL/],
];

test('a key whose host is private, loopback, link-local or unlisted is refused before any connection is opened', async () => {
  const socketConnect = mock.method(net.Socket.prototype, 'connect');
  const tlsConnect = mock.method(tls, 'connect');
  const seenBefore = seen.length;
  const agentBefore = agentConnections.length;
  try {
    for (const [name, reason] of REFUSED) {
      for (const path of ['/api/gw/anthropic/v1/messages?beta=true', '/api/gw/anthropic/v1/messages/count_tokens?beta=true']) {
        resolved.length = 0;
        const answer = await forwardInProcess(name, path);
        assert.equal(answer.status, 403, `${name} ${path}`);
        assert.equal(answer.body.type, 'error');
        assert.equal(answer.body.error.type, 'permission_error');
        // In English, naming the key.
        assert.match(answer.body.error.message, new RegExp(`^The Orbit gateway does not call the endpoint of key "key-${name}": `));
        assert.match(answer.body.error.message, reason);
        assert.ok(!answer.body.error.message.includes(SECRET));
        // Unlisted names and non-https URLs are refused without even being resolved.
        if (name === 'unlisted' || name === 'plainHttp' || name.endsWith('Literal')) assert.deepEqual(resolved, [], name);
      }
    }
    assert.equal(socketConnect.mock.callCount(), 0, 'no net.Socket#connect');
    assert.equal(tlsConnect.mock.callCount(), 0, 'no tls.connect');
    assert.equal(agentConnections.length, agentBefore, 'the gateway agent opened nothing');
    assert.equal(seen.length, seenBefore, 'the upstream was sent nothing');
  } finally {
    socketConnect.mock.restore();
    tlsConnect.mock.restore();
  }
});

test('the same refusal comes back through the real HTTP route', async () => {
  const agentBefore = agentConnections.length;
  const answer = await send('linkLocalName');
  assert.equal(answer.status, 403);
  const parsed = JSON.parse(answer.body) as { type: string; error: { type: string; message: string } };
  assert.equal(parsed.error.type, 'permission_error');
  assert.match(parsed.error.message, /key "key-linkLocalName"/);
  assert.equal(agentConnections.length, agentBefore);
});

test('an allowed host is called, on the address the guard checked', async () => {
  seen.length = 0;
  agentConnections.length = 0;
  const answer = await send('allowed');
  assert.equal(answer.status, 200);
  assert.match(answer.body, /"text":"Hello"/);
  assert.equal(agentConnections.length, 1);
  assert.equal(agentConnections[0].host, 'api.openai.com');
  // The connection's own lookup answers only the vetted address: no second resolution can differ from the first.
  const lookup = agentConnections[0].lookup as unknown as PinnedLookup;
  const pinned = await new Promise<{ address: string; family: number }>((resolve, reject) => {
    lookup('api.openai.com', {}, (e, address, family) => (e ? reject(e) : resolve({ address, family })));
  });
  assert.deepEqual(pinned, { address: PUBLIC_ADDRESS, family: 4 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/v1/responses');
  assert.equal(seen[0].headers.host, 'api.openai.com');
  assert.equal(seen[0].headers.authorization, `Bearer ${SECRET}`);
});

test('a 3xx from upstream is answered as an error and not followed', async () => {
  seen.length = 0;
  agentConnections.length = 0;
  const answer = await send('redirect');
  assert.equal(answer.status, 502);
  const parsed = JSON.parse(answer.body) as { type: string; error: { type: string; message: string } };
  assert.equal(parsed.type, 'error');
  assert.equal(parsed.error.type, 'api_error');
  assert.equal(parsed.error.message, 'The endpoint of key "key-redirect" answered with a redirect (302), which the Orbit gateway does not follow.');
  // No Location header reaches Claude Code, which could otherwise follow it itself.
  assert.ok(!answer.body.includes('169.254.169.254'));
  // One request, one connection: the Location was never visited.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.host, 'redirects.example.test');
  assert.equal(agentConnections.length, 1);
  assert.equal(agentConnections[0].host, 'redirects.example.test');
});

test('count_tokens does not follow a 3xx either: one request, and the estimate answers', async () => {
  seen.length = 0;
  agentConnections.length = 0;
  const answer = await send('redirect', '/api/gw/anthropic/v1/messages/count_tokens?beta=true');
  assert.equal(answer.status, 200);
  assert.ok((JSON.parse(answer.body) as { input_tokens: number }).input_tokens > 0);
  assert.equal(seen.length, 1);
  assert.equal(agentConnections.length, 1);
});

test('the address ranges: private, loopback, link-local and the rest are not public; public ones are', () => {
  for (const address of [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '127.255.0.9', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:10.0.0.1', '::ffff:7f00:1', 'fc00::1', 'fd12::1',
    'fe80::1', 'ff02::1', 'not-an-address',
  ]) assert.equal(isNonPublicAddress(address), true, address);
  for (const address of ['8.8.8.8', '172.32.0.1', '203.0.113.10', '2606:4700::1111']) {
    assert.equal(isNonPublicAddress(address), false, address);
  }
});

test('the URL rule: https to api.openai.com or a listed host', () => {
  const listed = process.env[GATEWAY_UPSTREAM_HOSTS_ENV];
  try {
    process.env[GATEWAY_UPSTREAM_HOSTS_ENV] = 'Responses.Example.org.';
    assert.equal(upstreamUrlRefusal('https://api.openai.com/v1'), null);
    assert.equal(upstreamUrlRefusal('https://API.OpenAI.com./v1'), null);
    assert.equal(upstreamUrlRefusal('https://responses.example.org/v1'), null);
    assert.match(upstreamUrlRefusal('https://api.openai.com.evil.test/v1')!, /not api\.openai\.com or a host listed/);
    assert.match(upstreamUrlRefusal('https://user:pw@api.openai.com/v1')!, /user name or password/);
    assert.match(upstreamUrlRefusal('ftp://api.openai.com/v1')!, /not an https URL/);
    assert.match(upstreamUrlRefusal('not a url')!, /not a valid URL/);
    delete process.env[GATEWAY_UPSTREAM_HOSTS_ENV];
    assert.match(upstreamUrlRefusal('https://responses.example.org/v1')!, /not api\.openai\.com or a host listed/);
  } finally {
    process.env[GATEWAY_UPSTREAM_HOSTS_ENV] = listed;
  }
});

test('a resolver failure is thrown as it is, not taken for a refusal', async () => {
  await assert.rejects(vetUpstream('https://api.openai.com/v1', async () => {
    throw new Error('getaddrinfo EAI_AGAIN api.openai.com');
  }), (e: Error) => e.constructor.name === 'Error' && /EAI_AGAIN/.test(e.message));
});

test('with the flag on, a key whose host the gateway may not call is not offered the claude engine', () => {
  const key = (baseUrl: string) => ({ kind: 'key' as const, runtime: 'codex', presetSlug: 'openai', baseUrl, subscriptionToken: false });
  const engines = (baseUrl: string) => credentialEngines(key(baseUrl), engineTableOptions(baseUrl));
  assert.deepEqual(engines('https://api.openai.com/v1'), [AgentProvider.CODEX, AgentProvider.CLAUDE, AgentProvider.OPENCODE]);
  for (const baseUrl of [KEYS.privateLiteral, KEYS.loopbackLiteral, KEYS.linkLocalLiteral, KEYS.unlisted, KEYS.plainHttp]) {
    assert.ok(!engines(baseUrl).includes(AgentProvider.CLAUDE), baseUrl);
    assert.deepEqual(engines(baseUrl), [AgentProvider.CODEX, AgentProvider.OPENCODE], baseUrl);
  }
  // A listed public name is offered it; what it resolves to is checked at each request.
  assert.ok(engines(KEYS.redirect).includes(AgentProvider.CLAUDE));
  // With the flag off nothing changes, allowed host or not.
  process.env[ANTHROPIC_GATEWAY_FLAG] = 'false';
  try {
    assert.deepEqual(engines('https://api.openai.com/v1'), [AgentProvider.CODEX, AgentProvider.OPENCODE]);
  } finally {
    process.env[ANTHROPIC_GATEWAY_FLAG] = 'true';
  }
});
