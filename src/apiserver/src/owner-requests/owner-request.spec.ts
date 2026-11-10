import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OWNER_REQUEST_ALERT_BODY_MAX,
  OWNER_REQUEST_KINDS,
  OWNER_REQUEST_STATES,
  OwnerRequestNotFileable,
  canTransition,
  normalizeOwnerRequest,
  ownerRequestAlert,
  ownerRequestPushCategory,
} from './owner-request';

test('only PENDING moves, and only to a terminal state; every terminal state is final', () => {
  for (const from of OWNER_REQUEST_STATES) {
    for (const to of OWNER_REQUEST_STATES) {
      const legal = from === 'PENDING' && to !== 'PENDING';
      assert.equal(canTransition(from, to), legal, `${from} → ${to}`);
    }
  }
});

test('each kind carries only its own fields', () => {
  const now = new Date();
  const base = { title: 't', why: 'w' };
  assert.throws(() => normalizeOwnerRequest({ ...base, kind: 'CONFIRM', steps: [{ text: 'x' }] }, now), OwnerRequestNotFileable);
  assert.throws(() => normalizeOwnerRequest({ ...base, kind: 'MANUAL_STEP', steps: [] }, now), OwnerRequestNotFileable);
  assert.throws(() => normalizeOwnerRequest({ ...base, kind: 'DECISION', recommendedOption: 0 }, now), OwnerRequestNotFileable);
  assert.throws(
    () => normalizeOwnerRequest({ ...base, kind: 'SECRET', secretSpec: { name: 'k', runnerId: 'r' } }, now),
    OwnerRequestNotFileable,
  );
  const secret = normalizeOwnerRequest(
    { ...base, kind: 'SECRET', secretSpec: { name: ' k ', runnerId: 'r', filePath: ' /etc/key ' } },
    now,
  );
  assert.deepEqual(secret.secretSpec, { name: 'k', runnerId: 'r', filePath: '/etc/key' });
});

test('the lock-screen alert is the kind over a title cut to one line', () => {
  for (const kind of OWNER_REQUEST_KINDS) {
    const alert = ownerRequestAlert(kind, 'x'.repeat(500));
    assert.ok(alert.title.length <= 20, alert.title);
    assert.ok(alert.body.length <= OWNER_REQUEST_ALERT_BODY_MAX);
    assert.ok(alert.body.endsWith('…'));
  }
  assert.deepEqual(ownerRequestAlert('DECISION', 'Which\n  database?'), { title: 'Decision needed', body: 'Which database?' });
});

test('each kind has its own push category, the one the clients register its actions under', () => {
  assert.deepEqual(OWNER_REQUEST_KINDS.map(ownerRequestPushCategory), [
    'ORBIT_OWNER_REQUEST_DECISION',
    'ORBIT_OWNER_REQUEST_SECRET',
    'ORBIT_OWNER_REQUEST_MANUAL_STEP',
    'ORBIT_OWNER_REQUEST_CONFIRM',
  ]);
});
