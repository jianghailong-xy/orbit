import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastValueFrom, of } from 'rxjs';
import { NEVER_PUBLIC_ID_FIELDS, toUuid, uuidToBase62 } from '@orbit/shared';
import { PublicIdInterceptor } from './public-id.interceptor';

const UUID = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
const OTHER = '019fcbf3-0fa8-7f83-9302-46b25389cb16';
const B62 = uuidToBase62(UUID);

/** Run a response body through the interceptor the way Nest does. */
function through<T>(body: T): Promise<T> {
  const interceptor = new PublicIdInterceptor();
  return lastValueFrom(
    interceptor.intercept({} as never, { handle: () => of(body) } as never),
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
