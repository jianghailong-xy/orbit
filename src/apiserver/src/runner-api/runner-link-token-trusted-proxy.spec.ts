process.env.TRUSTED_PROXIES = '198.51.100.0/24';

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import type { Runner } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { RunnerLinkTokenController } from './runner-link-token.controller';
import { RUNNER_LINK_SAME_ORIGIN, readRunnerLink, type RunnerLinkConfig } from './runner-link-token';

/**
 * RUNNER_LINK_URL=same-origin behind a proxy TRUSTED_PROXIES names (runner-link-token.ts, sameOriginLinkUrl), which that
 * setting's module reads as it loads, hence the first line of this file. A request through it counts as proxied by who
 * connected, whatever its X-Forwarded-For says, so it cannot name the managed runners' plain address.
 */

const signingKey = Buffer.from(generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string).toString('base64');
const OWNER_ID = '0192f3b4-1c2d-7e8f-9a0b-1c2d3e4f5a6c';

function config(): RunnerLinkConfig {
  const state = readRunnerLink({
    signingKey,
    linkUrl: RUNNER_LINK_SAME_ORIGIN,
    gatewayToken: 'g'.repeat(40),
    publicOrigin: 'https://orbit.example.com',
    managedRunnerServerUrl: 'http://172.30.0.1:2086',
  });
  assert.ok(state.config);
  return state.config;
}

async function answer(headers: Record<string, string>): Promise<string> {
  const prisma = { tenantCell: { findUnique: async () => ({ cellId: 'cell-1' }) } } as unknown as PrismaService;
  const controller = new RunnerLinkTokenController(prisma, { config: config(), problems: [] });
  const runner = { id: '0192f3b4-1c2d-7e8f-9a0b-1c2d3e4f5a6b', ownerId: OWNER_ID, tokenHash: 'a'.repeat(64) } as unknown as Runner;
  const issued = await controller.issue(runner, { leaseOwner: '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f' }, { headers, socket: {} } as never);
  return issued.linkUrl;
}

test('a request through a proxy TRUSTED_PROXIES names gets the origin, even with one X-Forwarded-For entry and the managed runners\' host', async () => {
  const forged = { 'x-orbit-request-host': '172.30.0.1:2086', 'x-orbit-request-proto': 'http', 'x-forwarded-for': '198.51.100.7' };
  assert.equal(await answer({ ...forged, 'x-real-ip': '198.51.100.7' }), 'wss://orbit.example.com/runner-link');
  // From any other hop the same headers are a request that shows no proxy.
  assert.equal(await answer({ ...forged, 'x-forwarded-for': '172.30.0.2', 'x-real-ip': '172.30.0.2' }), 'ws://172.30.0.1:2086/runner-link');
});
