import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request } from 'express';
import { uuidToBase62 } from '@orbit/shared';
import { publicIdHeaders } from './public-id-headers';

const UUID = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
const B62 = uuidToBase62(UUID);

function through(headers: Record<string, string>): Record<string, unknown> {
  const req = { headers } as unknown as Request;
  let called = false;
  publicIdHeaders(req, {} as never, () => {
    called = true;
  });
  assert.ok(called, 'the chain must continue whatever the headers said');
  return req.headers as unknown as Record<string, unknown>;
}

// The three headers `orbit mcp` and the `orbit` CLI attach, now that ORBIT_SESSION_ID and
// ORBIT_AGENT_ID are spelled base62 in the agent's environment.
test('the session-context headers arrive in either spelling', () => {
  for (const name of ['x-orbit-session-id', 'x-orbit-workspace-id', 'x-orbit-agent-id']) {
    assert.equal(through({ [name]: B62 })[name], UUID, `${name} decodes`);
    assert.equal(through({ [name]: UUID })[name], UUID, `${name} keeps the raw form`);
  }
});

// The whole point of the runner's flip being safe: a runner too old to have it keeps sending the
// raw form, and nothing downstream can tell the difference.
test('an older runner sending UUIDs is indistinguishable', () => {
  const old = through({ 'x-orbit-session-id': UUID, 'x-orbit-agent-id': UUID });
  const now = through({ 'x-orbit-session-id': B62, 'x-orbit-agent-id': B62 });
  assert.deepEqual(old, now);
});

// It rides in the same header block and is uuid-adjacent in shape, but it is a JWT: decoding it
// would corrupt a credential rather than normalize an address.
test('the orchestration token is not an id and is never touched', () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig';
  assert.equal(through({ 'x-orbit-session-token': token })['x-orbit-session-token'], token);
});

// This is not the place that judges an id. A header that cannot be spelled reaches the handler
// as it arrived, so the handler's own lookup produces the error the caller sees — the same one it
// produced before this middleware existed.
test('an unreadable header is passed through rather than rejected', () => {
  const out = through({ 'x-orbit-session-id': 'not-an-id!!' });
  assert.equal(out['x-orbit-session-id'], 'not-an-id!!');
});

// Absent is a legitimate state: a headless launchd/cron caller belongs to no session at all, and
// inventing a value for it would turn "no calling session" into "an unknown one".
test('an absent header stays absent', () => {
  assert.equal('x-orbit-session-id' in through({}), false);
});
