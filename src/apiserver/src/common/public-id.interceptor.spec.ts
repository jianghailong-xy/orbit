import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastValueFrom, of } from 'rxjs';
import { NEVER_PUBLIC_ID_FIELDS, toUuid, uuidToBase62 } from '@orbit/shared';
import { PublicIdInterceptor } from './public-id.interceptor';

const UUID = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
const OTHER = '019fcbf3-0fa8-7f83-9302-46b25389cb16';
const B62 = uuidToBase62(UUID);

/** Run a response body through the interceptor the way Nest does. `runner: true` puts the request
 *  on the runner protocol, the one surface that keeps UUIDs. */
function through<T>(body: T, opts: { runner?: boolean } = {}): Promise<T> {
  const interceptor = new PublicIdInterceptor();
  const request = { originalUrl: opts.runner ? '/api/runner/sessions/x/meta' : '/api/sessions/x' };
  const context = { switchToHttp: () => ({ getRequest: () => request }) };
  return lastValueFrom(
    interceptor.intercept(context as never, { handle: () => of(body) } as never),
  ) as Promise<T>;
}

test('serves the public id in `id`, with the twin beside it', async () => {
  const out = await through({ id: UUID, sessionId: OTHER, title: 'x' });
  assert.equal(out.id, B62, 'the id IS the public id — no negotiation, one spelling');
  assert.equal(out.sessionId, uuidToBase62(OTHER));
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

// ── The runner protocol is the one surface that keeps UUIDs ───────────────────────────────────

test('the flip is consistent across a payload', async () => {
  const out = await through({ id: UUID, sessionId: OTHER, title: 'x' });
  assert.equal(out.id, B62);
  assert.equal((out as Record<string, unknown>).publicId, B62);
  assert.equal(out.sessionId, uuidToBase62(OTHER));
  assert.equal(toUuid(out.id), UUID, 'still names the same row');
  assert.equal(out.title, 'x', 'nothing else is touched');
});

test('the flip reaches nested ids and id arrays', async () => {
  const out = await through({ sessions: [{ id: UUID, taskIds: [OTHER] }] });
  const session = out.sessions[0] as Record<string, unknown>;
  assert.equal(session.id, B62);
  assert.deepEqual(session.taskIds, [uuidToBase62(OTHER)]);
});

// The single most dangerous thing Phase 3 could do. A fence token is compared byte-for-byte and
// interpolated into raw SQL as `::uuid`; hand a runner a base62 `leaseOwner` and it echoes back
// something that either 500s the cast or — worse — never matches, which is how a merge wedges
// and takes the runner's whole queue with it. Asking for public ids must not reach these.
test('the flip never touches a lease or fence token', async () => {
  const fences = Object.fromEntries([...NEVER_PUBLIC_ID_FIELDS].map((f) => [f, UUID]));
  const out = (await through({ id: UUID, ...fences })) as Record<string, unknown>;
  assert.equal(out.id, B62, 'the flip did happen');
  for (const field of NEVER_PUBLIC_ID_FIELDS) {
    assert.equal(out[field], UUID, `${field} must survive byte-for-byte`);
  }
});

// `toUuid` is what the server runs on every id it receives, so this is the actual round trip a
// runner performs: read the fence out of a response, send it back, have it compared.
test('a fence token round-trips through the pipe unchanged', async () => {
  const out = await through({ leaseOwner: UUID, operationId: OTHER });
  assert.equal(toUuid(out.leaseOwner as string), UUID);
  assert.equal(toUuid(out.operationId as string), OTHER);
});

test('a non-UUID id is left alone even when the client asked', async () => {
  const out = await through({ id: 'toolu_01ABC' });
  assert.equal(out.id, 'toolu_01ABC');
});


// The reason this boundary exists at all. A runner does not link to anything — it writes the ids
// it receives straight into filesystem paths and git ref names, and compares lease tokens that
// travel beside them byte-for-byte. Re-spelling those is not a formatting change, it is re-keying
// state that already exists on disk on a machine this server does not control; a runner too old
// to normalize would orphan a live session's base ref and compute every later diff against the
// wrong commit, silently. `runner.version` showed one on 0.1.98 when this was written.
test('the runner protocol keeps UUIDs, ids and all', async () => {
  const out = await through({ id: UUID, sessionId: OTHER, leaseOwner: UUID }, { runner: true });
  assert.equal(out.id, UUID, 'a runner keys its scratch dir and base ref by this');
  assert.equal(out.sessionId, OTHER);
  assert.equal(out.leaseOwner, UUID);
});

// It still gets the twin, so a runner that wants the short form has it without a second request —
// what it must never get is a DIFFERENT value under the name it already keys by.
test('the runner protocol still receives the twin alongside', async () => {
  const out = await through({ id: UUID }, { runner: true });
  assert.equal((out as Record<string, unknown>).publicId, B62);
});

// Path-matched, so a route that merely mentions runners is not mistaken for the runner protocol.
test('only the runner protocol prefix is excluded', async () => {
  const out = await through({ id: UUID });
  assert.equal(out.id, B62, '/api/runners (the user-facing list) flips like everything else');
});
