import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthCredential } from '../common/current-user.decorator';
import { senderClientColumns, senderClientOfRequest, sentFromOf } from './turn-sender-client';

const LOGIN: AuthCredential = { kind: 'LOGIN' };
const TERMINAL: AuthCredential = { kind: 'TERMINAL', terminalId: 't', runnerId: 'r', machineName: 'build-box' };

test('an owner request names its app by X-Orbit-Client, an iOS device by X-Orbit-Device', () => {
  assert.deepEqual(senderClientOfRequest(LOGIN, 'web/0.1.114', undefined), { client: 'web' });
  assert.deepEqual(senderClientOfRequest(undefined, 'web/0.1.114', undefined), { client: 'web' });
  assert.deepEqual(senderClientOfRequest(LOGIN, 'ios/1.2.3', 'ipad'), { client: 'ios', detail: 'ipad' });
  assert.deepEqual(senderClientOfRequest(LOGIN, 'ios/1.2.3', 'iPhone'), { client: 'ios', detail: 'iphone' });
  assert.deepEqual(senderClientOfRequest(LOGIN, 'ios/1.2.3', 'a watch'), { client: 'ios' });
  assert.deepEqual(senderClientOfRequest(LOGIN, 'macos/1.2.3', 'ipad'), { client: 'macos' });
  assert.deepEqual(senderClientOfRequest(LOGIN, 'android/2.0.1', undefined), { client: 'android' });
});

test('a TERMINAL credential is the terminal on its machine, whatever headers it sends', () => {
  assert.deepEqual(senderClientOfRequest(TERMINAL, 'web/1', 'ipad'), { client: 'terminal', detail: 'build-box' });
});

test('a header naming no app, a token and an administrator’s view record nothing', () => {
  for (const header of [undefined, '', 'web', 'feishu/1', 'session/1', 'terminal/1', 'runner/1', 'iPhone']) {
    assert.equal(senderClientOfRequest(LOGIN, header, undefined), undefined, String(header));
  }
  const pat: AuthCredential = { kind: 'PAT', tokenId: 'p', scopes: [], workspaceIds: [] };
  assert.equal(senderClientOfRequest(pat, 'web/1', undefined), undefined);
  const viewing: AuthCredential = { kind: 'IMPERSONATION', administratorId: 'a', expiresAt: 0 };
  assert.equal(senderClientOfRequest(viewing, 'web/1', undefined), undefined);
});

test('the columns keep a machine name to one line', () => {
  assert.deepEqual(senderClientColumns(undefined), {});
  assert.deepEqual(senderClientColumns({ client: 'terminal', detail: ' build\n box ' }), {
    senderClient: 'terminal', senderClientDetail: 'build box',
  });
  assert.deepEqual(senderClientColumns({ client: 'web' }), { senderClient: 'web', senderClientDetail: null });
});

test('sentFrom is read off the sender session, the outside sender, or the turn’s own columns', () => {
  const card = { fromSessionId: 's', fromTitle: 'Worker: criterion 3', fromAgentName: 'orbit' };
  assert.deepEqual(sentFromOf({ senderClient: null }, card, null), { client: 'session', sessionTitle: 'Worker: criterion 3' });
  assert.deepEqual(sentFromOf({ senderClient: 'feishu' }, undefined, { source: 'FEISHU', name: 'Li Wei' }),
    { client: 'feishu', name: 'Li Wei' });
  assert.deepEqual(sentFromOf({ senderClient: 'feishu' }, undefined, null), { client: 'feishu' });
  assert.deepEqual(sentFromOf({ senderClient: 'ios', senderClientDetail: 'ipad' }, undefined, null), { client: 'ios', device: 'ipad' });
  assert.deepEqual(sentFromOf({ senderClient: 'ios', senderClientDetail: 'watch' }, undefined, null), { client: 'ios' });
  assert.deepEqual(sentFromOf({ senderClient: 'terminal', senderClientDetail: 'build-box' }, undefined, null),
    { client: 'terminal', machineName: 'build-box' });
  for (const client of ['web', 'macos', 'android', 'runner'] as const) {
    assert.deepEqual(sentFromOf({ senderClient: client }, undefined, null), { client });
  }
  assert.equal(sentFromOf({ senderClient: null }, undefined, null), null);
  assert.equal(sentFromOf({ senderClient: 'something-else' }, undefined, null), null);
});
