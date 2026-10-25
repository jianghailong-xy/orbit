import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { RunnerApiController } from './runner-api.controller';
import { LINK_GATEWAY_ID_HEADER, parseRunnerLinkGatewayId } from './runner-link-call';

/**
 * A heartbeat the link gateway forwarded (docs/runner-link-design.md §5.5, §5.7; runner-link-hints.ts): answered with
 * what waits for the runner beside today's response, for the gateway to state in HeartbeatAck.hints, and recorded in
 * presence with the gateway node that holds the connection. A heartbeat over HTTPS is answered and recorded exactly as
 * before: no new member, no new query.
 */

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const LEASE_OWNER = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const APPROVAL_ID = '44444444-4444-4444-8444-444444444444';

function heartbeatWorld(options: { hintsFail?: boolean; linkWatchers?: boolean } = {}) {
  const presenceWrites: Array<{ update: Record<string, unknown> }> = [];
  const hintQueries: string[] = [];
  const prisma = {
    runner: {
      update: async () => ({ maxConcurrent: 4, minFreeDiskMb: null }),
      findUnique: async () => null,
    },
    runnerPresence: {
      upsert: async (args: { update: Record<string, unknown> }) => {
        presenceWrites.push(args);
        return {};
      },
    },
    session: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    $queryRaw: async (...args: unknown[]) => {
      const sql = renderRawQuery(args).text;
      hintQueries.push(sql);
      // Every other read the route makes finds nothing.
      if (!sql.includes('conversation_turn')) return [];
      if (options.hintsFail) throw new Error('the database is failing over');
      return [{ inboxSessionIds: [SESSION_ID], claim: true, approvals: [{ sessionId: SESSION_ID, approvalId: APPROVAL_ID }] }];
    },
  } as never;
  const realtime = {
    drainCancellations: async () => [],
    failAbandonedWorktreeOperations: async () => undefined,
    drainMergeRequests: async () => [],
    drainCommitRequests: async () => [],
    drainArtifactRequests: async () => [],
    linkWatchersOf: (ids: string[]) => (options.linkWatchers === false
      ? null
      : { instance: 'i-1', sessions: ids.map((sessionId) => ({ sessionId, watchers: 2 })) }),
  } as never;
  const controller = new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never, {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);
  return { controller, presenceWrites, hintQueries };
}

const beat = { status: 'ONLINE', idleCapacity: 1, leaseOwner: LEASE_OWNER, supervisedSessionIds: [SESSION_ID] } as never;
const link = { leaseOwner: LEASE_OWNER, requestId: null, afterSeq: null, gatewayId: 'orbit-link-gateway-1' };

test('a heartbeat over HTTPS is answered as it always was: no linkHints, and no query for them', async () => {
  const w = heartbeatWorld();
  const answer = await w.controller.heartbeat({ id: RUNNER_ID, version: null, lastHeartbeatAt: new Date() }, beat);
  assert.equal('linkHints' in answer, false);
  assert.deepEqual(w.hintQueries.filter((sql) => sql.includes('conversation_turn')), []);
  assert.equal(w.presenceWrites[0].update.gatewayId, null);
  assert.equal(w.presenceWrites[0].update.linkState, 'HTTP');
});

test('a heartbeat the gateway forwarded is answered with what waits, and recorded with its gateway node', async () => {
  const w = heartbeatWorld();
  const answer = await w.controller.heartbeat(
    { id: RUNNER_ID, version: null, lastHeartbeatAt: new Date() }, beat, undefined, undefined, undefined, undefined, link,
  );
  assert.deepEqual(answer.linkHints, {
    inboxSessionIds: [SESSION_ID],
    claim: true,
    approvals: [{ sessionId: SESSION_ID, approvalId: APPROVAL_ID }],
    watchers: { instance: 'i-1', sessions: [{ sessionId: SESSION_ID, watchers: 2 }] },
  });
  // Today's response is all there besides.
  assert.equal(answer.maxConcurrent, 4);
  assert.deepEqual(answer.cancelSessionIds, []);
  const [sql] = w.hintQueries.filter((q) => q.includes('conversation_turn'));
  assert.match(sql, /"assigned_runner_id" = \?::uuid/);
  assert.match(sql, /t\.status = 'PENDING' OR \(t\.status = 'IN_FLIGHT' AND t\."lease_deadline_at" < now\(\)\)/);
  assert.match(sql, /s\.status = 'PENDING'/);
  // The approvals: decided ones of the runner's open sessions, while the reader the card names is still there.
  assert.match(sql, /JOIN "approval" a ON a\."session_id" = s\.id AND a\.status IN \('ALLOWED', 'DENIED'\)/);
  assert.match(sql, /WHEN a\."background_job_id" IS NOT NULL THEN a\."background_job_id" = ANY \(s\."running_bg_shells"\)/);
  assert.match(sql, /t\.id = a\."turn_id" AND t\.status <> 'ANSWERED'/);
  assert.match(sql, /c\."tool_use_id" = a\."tool_use_id" AND c\."finished_at" IS NOT NULL/);
  assert.equal(w.presenceWrites[0].update.gatewayId, 'orbit-link-gateway-1');
  assert.equal(w.presenceWrites[0].update.linkState, 'LINK');
});

test('a failed read of what waits leaves linkHints out, and the heartbeat answers anyway', async () => {
  const w = heartbeatWorld({ hintsFail: true });
  const answer = await w.controller.heartbeat(
    { id: RUNNER_ID, version: null, lastHeartbeatAt: new Date() }, beat, undefined, undefined, undefined, undefined, link,
  );
  assert.equal('linkHints' in answer, false, 'nothing said rather than that nothing waits');
  assert.equal(answer.maxConcurrent, 4);
});

test('without NATS the answer says what waits, and no watchers', async () => {
  const w = heartbeatWorld({ linkWatchers: false });
  const answer = await w.controller.heartbeat(
    { id: RUNNER_ID, version: null, lastHeartbeatAt: new Date() }, beat, undefined, undefined, undefined, undefined, link,
  );
  assert.deepEqual(answer.linkHints, {
    inboxSessionIds: [SESSION_ID], claim: true, approvals: [{ sessionId: SESSION_ID, approvalId: APPROVAL_ID }],
  });
});

test('the gateway node is read from its header, and only a plain name is', () => {
  assert.equal(parseRunnerLinkGatewayId({ [LINK_GATEWAY_ID_HEADER]: 'a1b2c3d4e5f6' }), 'a1b2c3d4e5f6');
  assert.equal(parseRunnerLinkGatewayId({}), null);
  assert.equal(parseRunnerLinkGatewayId({ [LINK_GATEWAY_ID_HEADER]: 'two words' }), null);
  assert.equal(parseRunnerLinkGatewayId({ [LINK_GATEWAY_ID_HEADER]: 'x'.repeat(129) }), null);
});
