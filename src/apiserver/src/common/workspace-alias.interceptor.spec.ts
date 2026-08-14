import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstValueFrom, of } from 'rxjs';
import { WorkspaceAliasInterceptor } from './workspace-alias.interceptor';

const run = (body: unknown) =>
  firstValueFrom(
    new WorkspaceAliasInterceptor().intercept({} as never, { handle: () => of(body) } as never),
  );

test('a renamed field is served under the old name too, so shipped clients keep reading it', async () => {
  const out = (await run({ id: 's1', workspaceId: 'w1' })) as Record<string, unknown>;
  assert.deepEqual(out, { id: 's1', workspaceId: 'w1', agentId: 'w1' });
});

test('a handler still emitting the old name gains the new one', async () => {
  const out = (await run({ agentId: 'w1', agentName: 'builder' })) as Record<string, unknown>;
  assert.equal(out.workspaceId, 'w1');
  assert.equal(out.workspaceName, 'builder');
});

test('nested objects and arrays are covered — session lists, not just single rows', async () => {
  const out = (await run([
    { id: 's1', workspace: { id: 'w1', name: 'orbit' } },
    { id: 's2', workspace: null },
  ])) as Array<Record<string, unknown>>;
  assert.deepEqual(out[0].agent, { id: 'w1', name: 'orbit' });
  // null is a real answer ("this session has no workspace"), and must survive as one.
  assert.equal(out[1].agent, null);
  assert.ok('agent' in out[1]);
});

test('an SSE frame is mirrored inside its data envelope', async () => {
  const out = (await run({ data: { type: 'session.updated', workspaceId: 'w1' } })) as {
    data: Record<string, unknown>;
  };
  assert.equal(out.data.agentId, 'w1');
});

test('a value the handler set on both names is left exactly as written', async () => {
  // The runner claim payload deliberately carries the legacy name with a different meaning of
  // "absent" (undefined vs null); mirroring must never overwrite a deliberate value.
  const out = (await run({ workspaceId: 'w1', agentId: 'legacy-id' })) as Record<string, unknown>;
  assert.equal(out.agentId, 'legacy-id');
  assert.equal(out.workspaceId, 'w1');
});

test('a Date survives as a Date rather than being walked into', async () => {
  const at = new Date('2026-08-14T00:00:00.000Z');
  const out = (await run({ createdAt: at })) as Record<string, unknown>;
  assert.equal(out.createdAt, at);
});

test('depth is bounded, so a deep or cyclic body cannot run away', async () => {
  const cyclic: Record<string, unknown> = { workspaceId: 'w1' };
  cyclic.self = cyclic;
  const out = (await run(cyclic)) as Record<string, unknown>;
  assert.equal(out.agentId, 'w1');
});
