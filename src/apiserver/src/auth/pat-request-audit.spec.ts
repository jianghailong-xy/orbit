import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { ForbiddenException } from '@nestjs/common';
import { uuidToBase62 } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { PatRequestAudit, noteRefusal } from './pat-request-audit';
import { PatRefusal } from './pat-scope.decorator';

// PatRequestAudit's own rules (docs/personal-access-token-design.md §6.4), against a real node:http
// server and a stand-in for the one INSERT it makes: what a record says, that a caller who leaves
// before the answer is recorded all the same, and that a record which cannot be written is logged and
// goes no further. What the production app records through JwtAuthGuard and PostgreSQL is
// `pat-request-audit.pg.spec.ts`'s.

const GRANT = { userId: randomUUID(), tokenId: randomUUID() };
const RUNNER = randomUUID();
/** A request as Express has routed it: the route as registered, under the global prefix, and its params. */
const ROUTED = {
  route: { path: '/api/runners/:id/accounts/:engine/:account' },
  params: { id: RUNNER, engine: 'claude', account: 'work' },
};

type Data = Record<string, unknown>;

/** The audit, with every INSERT it attempts and every line it logs; `insert` answers each attempt. */
function audited(insert: () => Promise<unknown> = async () => undefined) {
  const inserts: Data[] = [];
  const warnings: string[] = [];
  const prisma = {
    activity: {
      create: ({ data }: { data: Data }) => {
        inserts.push(data);
        return insert();
      },
    },
  };
  const audit = new PatRequestAudit(prisma as unknown as PrismaService);
  (audit as unknown as { log: { warn(line: string): void } }).log = { warn: (line) => warnings.push(line) };
  return { audit, inserts, warnings };
}

type Routed = http.IncomingMessage & typeof ROUTED & { method: string };

/**
 * One request to a server standing where JwtAuthGuard does: `handle` gets the routed request and its
 * response. With `leave`, the caller goes away as soon as `handle` has returned, without the answer.
 */
async function request(method: string, handle: (req: Routed, res: http.ServerResponse) => void, leave = false): Promise<void> {
  let handled!: () => void;
  const handling = new Promise<void>((resolve) => (handled = resolve));
  const server = http.createServer((req, res) => {
    handle(Object.assign(req, structuredClone(ROUTED)) as Routed, res);
    handled();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, method, agent: false }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.end();
      if (!leave) {
        req.on('error', reject);
        return;
      }
      req.on('error', () => undefined);
      void handling.then(() => {
        req.destroy();
        resolve();
      });
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Waits for `count` INSERTs, then a little longer for any that should not come. */
async function settled(inserts: Data[], count: number): Promise<Data[]> {
  for (const deadline = Date.now() + 5_000; inserts.length < count && Date.now() < deadline;) await sleep(10);
  await sleep(100);
  return inserts;
}

const recordOf = (payload: Data, type = 'pat.request') => ({
  actorId: GRANT.userId,
  type,
  payload,
  credentialKind: 'PAT',
  credentialId: GRANT.tokenId,
});

test('a write is recorded once it is answered: the route as its controller spells it, the status, and only the params that name a row, as public ids', async () => {
  const { audit, inserts } = audited();
  await request('POST', (req, res) => {
    audit.watch(req, res, GRANT);
    res.statusCode = 201;
    res.end();
  });
  assert.deepEqual(await settled(inserts, 1), [
    recordOf({ method: 'POST', route: '/runners/:id/accounts/:engine/:account', status: 201, params: { id: uuidToBase62(RUNNER) } }),
  ]);
});

test('a read is never recorded', async () => {
  const { audit, inserts } = audited();
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    await request(method, (req, res) => {
      audit.watch(req, res, GRANT);
      res.end();
    });
  }
  assert.deepEqual(await settled(inserts, 0), []);
});

test("a request refused as a PatRefusal is recorded denied, with the refusal's code and what it names but not its prose; any other 403 is not a refusal", async () => {
  const { audit, inserts } = audited();
  await request('PATCH', (req, res) => {
    audit.watch(req, res, GRANT);
    noteRefusal(req, new PatRefusal({ code: 'PAT_SCOPE_MISSING', scope: 'workspaces:write', message: 'prose' }));
    res.statusCode = 403;
    res.end();
  });
  await request('DELETE', (req, res) => {
    audit.watch(req, res, GRANT);
    noteRefusal(req, new ForbiddenException({ code: 'NOT_A_TOKEN_REFUSAL', message: 'prose' }));
    res.statusCode = 403;
    res.end();
  });
  const route = '/runners/:id/accounts/:engine/:account';
  const params = { id: uuidToBase62(RUNNER) };
  assert.deepEqual(await settled(inserts, 2), [
    recordOf({ method: 'PATCH', route, status: 403, params, code: 'PAT_SCOPE_MISSING', scope: 'workspaces:write' }, 'pat.request.denied'),
    recordOf({ method: 'DELETE', route, status: 403, params }),
  ]);
});

test('a caller that leaves before the answer is recorded all the same, with no status, and the answer that comes later adds nothing', async () => {
  const { audit, inserts } = audited();
  let answered!: () => void;
  const late = new Promise<void>((resolve) => (answered = resolve));
  await request('POST', (req, res) => {
    audit.watch(req, res, GRANT);
    setTimeout(() => {
      res.statusCode = 201;
      res.end();
      answered();
    }, 300);
  }, true);
  await late;
  assert.deepEqual(await settled(inserts, 1), [
    recordOf({ method: 'POST', route: '/runners/:id/accounts/:engine/:account', status: null, params: { id: uuidToBase62(RUNNER) } }),
  ]);
});

test('a record that cannot be written is logged once and goes no further: not tried again, nothing thrown', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { audit, inserts, warnings } = audited(async () => {
      throw new Error('the database is gone');
    });
    await request('PUT', (req, res) => {
      audit.watch(req, res, GRANT);
      res.statusCode = 200;
      res.end();
    });
    assert.equal((await settled(inserts, 1)).length, 1);
    assert.deepEqual(warnings, [
      `could not record PUT /runners/:id/accounts/:engine/:account by access token ${GRANT.tokenId}: the database is gone`,
    ]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
