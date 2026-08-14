import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastValueFrom, of } from 'rxjs';
import { NEVER_PUBLIC_ID_FIELDS, toUuid, uuidToBase62 } from '@orbit/shared';
import { PublicIdInterceptor } from './public-id.interceptor';

const UUID = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
const OTHER = '019fcbf3-0fa8-7f83-9302-46b25389cb16';
const B62 = uuidToBase62(UUID);

/** Run a response body through the interceptor the way Nest does. `asking` is a client that opted
 *  in to Phase 3's `id`-is-the-public-id format. */
function through<T>(body: T, opts: { asking?: boolean } = {}): Promise<T> {
  const interceptor = new PublicIdInterceptor();
  const request = { headers: opts.asking ? { 'x-orbit-id-format': 'public' } : {} };
  const context = { switchToHttp: () => ({ getRequest: () => request }) };
  return lastValueFrom(
    interceptor.intercept(context as never, { handle: () => of(body) } as never),
  ) as Promise<T>;
}

test('adds the base62 twin beside every public id', async () => {
  const out = await through({ id: UUID, sessionId: OTHER, title: 'x' });
  assert.equal(out.id, UUID, 'the UUID spelling still ships for clients that read it');
  assert.equal((out as Record<string, unknown>).publicId, B62);
  assert.equal((out as Record<string, unknown>).sessionPublicId, uuidToBase62(OTHER));
  assert.equal(toUuid((out as Record<string, string>).publicId), UUID, 'twin round-trips');
});

test('twins array ids as a whole, or not at all', async () => {
  const ok = await through({ taskIds: [UUID, OTHER] });
  assert.deepEqual((ok as Record<string, unknown>).taskPublicIds, [B62, uuidToBase62(OTHER)]);

  // A partially-encoded array is worse than an absent one: nothing tells the caller which
  // elements are in which spelling.
  const mixed = await through({ taskIds: [UUID, 'not-an-id'] });
  assert.ok(!('taskPublicIds' in (mixed as object)));
});

// The whole reason the encode set is an allowlist rather than "every uuid-shaped value".
test('never twins a lease or fence token', async () => {
  const fences = Object.fromEntries([...NEVER_PUBLIC_ID_FIELDS].map((f) => [f, UUID]));
  const out = await through({ ...fences });
  for (const field of NEVER_PUBLIC_ID_FIELDS) {
    assert.equal(out[field], UUID, `${field} unchanged`);
    assert.deepEqual(
      Object.keys(out).filter((k) => k.startsWith(field.replace(/Id$/, '')) && k.endsWith('PublicId')),
      [],
      `${field} must not gain a twin`,
    );
  }
});

// Response bodies carry opaque engine JSON: a Claude `tool_use` block's `id` is `toolu_01…`.
// Throwing there would turn a working transcript endpoint into a 500.
test('leaves a value that is not a UUID alone', async () => {
  const out = await through({ id: 'toolu_01ABC', sessionId: null });
  assert.equal(out.id, 'toolu_01ABC');
  assert.ok(!('publicId' in out));
  assert.equal((out as Record<string, unknown>).sessionPublicId, null, 'a null id twins as null');
});

test('never overwrites a twin the handler set itself', async () => {
  const out = await through({ id: UUID, publicId: 'chosen-by-the-handler' });
  assert.equal((out as Record<string, unknown>).publicId, 'chosen-by-the-handler');
});

test('reaches ids nested in arrays and objects', async () => {
  const out = await through({ sessions: [{ id: UUID, workspace: { id: OTHER } }] });
  const session = out.sessions[0] as Record<string, unknown>;
  assert.equal(session.publicId, B62);
  assert.equal((session.workspace as Record<string, unknown>).publicId, uuidToBase62(OTHER));
});

// Nest's @Sse handlers emit through the same next.handle() pipe, so the frames get twinned too —
// which is what keeps a session's REST payload and its live stream speaking the same dialect.
test('twins an SSE frame, which rides the same pipe', async () => {
  const out = await through({ data: { seq: 7, type: 'session.updated', sessionId: UUID } });
  assert.equal((out.data as Record<string, unknown>).sessionPublicId, B62);
});

// A cycle must not hang the response. The cap is depth, not visited-set, matching the alias
// interceptor it sits beside.
test('terminates on a self-referencing body', async () => {
  const body: Record<string, unknown> = { id: UUID };
  body.self = body;
  const out = await through(body);
  assert.equal(out.publicId, B62);
});

// ── Phase 3: `id` IS the public id, for clients that ask ──────────────────────────────────────

// The default has to stay the old shape forever, not just for now: the clients this protects are
// the ones nobody can enumerate — a browser tab open since last month, a TestFlight build whose
// owner has not opened the App Store. They never send the header, so they never notice Phase 3.
test('a client that does not ask keeps getting the UUID in id', async () => {
  const out = await through({ id: UUID, sessionId: OTHER });
  assert.equal(out.id, UUID);
  assert.equal(out.sessionId, OTHER);
});

test('a client that asks gets the public id in id, and the twin agrees', async () => {
  const out = await through({ id: UUID, sessionId: OTHER, title: 'x' }, { asking: true });
  assert.equal(out.id, B62);
  assert.equal((out as Record<string, unknown>).publicId, B62);
  assert.equal(out.sessionId, uuidToBase62(OTHER));
  assert.equal(toUuid(out.id), UUID, 'still names the same row');
  assert.equal(out.title, 'x', 'nothing else is touched');
});

test('the flip reaches nested ids and id arrays', async () => {
  const out = await through(
    { sessions: [{ id: UUID, taskIds: [OTHER] }] },
    { asking: true },
  );
  const session = out.sessions[0] as Record<string, unknown>;
  assert.equal(session.id, B62);
  assert.deepEqual(session.taskIds, [uuidToBase62(OTHER)]);
});

// The single most dangerous thing Phase 3 could do. A fence token is compared byte-for-byte and
// interpolated into raw SQL as `::uuid`; hand a runner a base62 `leaseOwner` and it echoes back
// something that either 500s the cast or — worse — never matches, which is how a merge wedges
// and takes the runner's whole queue with it. Asking for public ids must not reach these.
test('asking for public ids still never touches a lease or fence token', async () => {
  const fences = Object.fromEntries([...NEVER_PUBLIC_ID_FIELDS].map((f) => [f, UUID]));
  const out = (await through({ id: UUID, ...fences }, { asking: true })) as Record<string, unknown>;
  assert.equal(out.id, B62, 'the flip did happen');
  for (const field of NEVER_PUBLIC_ID_FIELDS) {
    assert.equal(out[field], UUID, `${field} must survive byte-for-byte`);
  }
});

// `toUuid` is what the server runs on every id it receives, so this is the actual round trip a
// runner performs: read the fence out of a response, send it back, have it compared.
test('a fence token round-trips through the pipe unchanged', async () => {
  const out = await through({ leaseOwner: UUID, operationId: OTHER }, { asking: true });
  assert.equal(toUuid(out.leaseOwner as string), UUID);
  assert.equal(toUuid(out.operationId as string), OTHER);
});

test('a non-UUID id is left alone even when the client asked', async () => {
  const out = await through({ id: 'toolu_01ABC' }, { asking: true });
  assert.equal(out.id, 'toolu_01ABC');
});
