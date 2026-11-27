import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OWNER_REQUEST_ALERT_BODY_MAX,
  OWNER_REQUEST_KINDS,
  OWNER_REQUEST_STATES,
  OwnerRequestNotFileable,
  browserSignInSite,
  browserSignInTitle,
  canTransition,
  normalizeOwnerRequest,
  ownerRequestAlert,
  ownerRequestPushCategory,
  ownerRequestResolutionPayload,
  ownerRequestResolutionTurn,
  wikiCreateDeclinedMessage,
  wikiCreateTitle,
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
  assert.deepEqual(ownerRequestAlert('WIKI_CREATE', 'Create a wiki for lfs-builder?'),
    { title: 'Create a wiki?', body: 'Create a wiki for lfs-builder?' });
});

test('a WIKI_CREATE carries only why and ifUnanswered: Orbit writes its title and repository', () => {
  const now = new Date('2026-11-12T00:00:00Z');
  const filed = normalizeOwnerRequest({ kind: 'WIKI_CREATE', why: ' the owner asked for one ', ifUnanswered: 'no wiki' }, now);
  assert.equal(filed.title, undefined);
  assert.equal(filed.why, 'the owner asked for one');
  for (const extra of [{ title: 'Make one' }, { blocksTaskIds: [] }, { verifyHint: 'x' }, { expiresAt: '2027-01-01T00:00:00Z' }]) {
    assert.throws(() => normalizeOwnerRequest({ kind: 'WIKI_CREATE', why: 'w', ...extra }, now), OwnerRequestNotFileable);
  }
  assert.throws(() => normalizeOwnerRequest({ kind: 'WIKI_CREATE', why: ' ' }, now), OwnerRequestNotFileable);
  assert.equal(wikiCreateTitle('github.com/jianghailong-xy/lfs-builder'), 'Create a wiki for lfs-builder?');
  assert.equal(wikiCreateDeclinedMessage(new Date('2026-11-12T08:00:00Z')),
    'The owner declined a wiki for this repository on 2026-11-12.');
});

test('each kind has its own push category, the one the clients register its actions under', () => {
  assert.deepEqual(OWNER_REQUEST_KINDS.map(ownerRequestPushCategory), [
    'ORBIT_OWNER_REQUEST_DECISION',
    'ORBIT_OWNER_REQUEST_SECRET',
    'ORBIT_OWNER_REQUEST_MANUAL_STEP',
    'ORBIT_OWNER_REQUEST_CONFIRM',
    'ORBIT_OWNER_REQUEST_WIKI_CREATE',
    'ORBIT_OWNER_REQUEST_BROWSER_SIGN_IN',
    'ORBIT_OWNER_REQUEST_CHANGE',
  ]);
});

test('a CHANGE carries exactly one runner setting, v1 Max Concurrent of at least 1, and its turn reads applied', () => {
  const now = new Date('2026-11-24T00:00:00Z');
  const base = { kind: 'CHANGE' as const, title: 'Lower wikova to 6', why: 'headroom' };
  const filed = normalizeOwnerRequest({ ...base, change: { runnerId: ' r1 ', maxConcurrent: 6 } }, now);
  assert.deepEqual(filed.change, { runnerId: 'r1', maxConcurrent: 6 });
  for (const change of [undefined, {}, { runnerId: 'r1' }, { runnerId: 'r1', maxConcurrent: 0 }, { runnerId: 'r1', maxConcurrent: 1.5 }]) {
    assert.throws(() => normalizeOwnerRequest({ ...base, change: change as never }, now), OwnerRequestNotFileable, JSON.stringify(change));
  }
  assert.throws(
    () => normalizeOwnerRequest({ ...base, change: { runnerId: 'r1', maxConcurrent: 6, minFreeDiskMb: 1 } as never }, now),
    /change\.minFreeDiskMb is not a setting/,
  );
  assert.throws(() => normalizeOwnerRequest({ kind: 'CONFIRM', title: 't', why: 'w', change: { runnerId: 'r1', maxConcurrent: 6 } }, now),
    /change is only for a CHANGE request/);
  assert.deepEqual(ownerRequestAlert('CHANGE', 'Lower wikova to 6'), { title: 'Setting change', body: 'Lower wikova to 6' });

  const spec = { runnerId: 'r1', field: 'maxConcurrent', requested: 6, before: 12 };
  const ended = {
    id: 'req', kind: 'CHANGE', title: 't', options: null, secretSpec: null, changeSpec: spec, resolvedAt: now,
  };
  assert.deepEqual(
    ownerRequestResolutionPayload({ ...ended, state: 'DONE', answer: { applied: 8, actualBefore: 9 }, resolutionNote: null }).change,
    { ...spec, applied: 8, actualBefore: 9 },
  );
  assert.deepEqual(
    ownerRequestResolutionPayload({ ...ended, state: 'DECLINED', answer: null, resolutionNote: 'no' }).change,
    spec,
  );
  assert.match(
    ownerRequestResolutionTurn({ ...ended, state: 'WITHDRAWN', answer: null, resolutionNote: 'Replaced by a newer request' }),
    /ended WITHDRAWN\. A newer request for the same runner setting replaced it/,
  );
  assert.match(
    ownerRequestResolutionTurn({ ...ended, state: 'WITHDRAWN', answer: null, resolutionNote: 'no longer needed' }),
    /ended WITHDRAWN: this session withdrew it\./,
  );
});

test('a BROWSER_SIGN_IN is filed only by browser_request_sign_in: request_owner_action\'s door refuses the kind', () => {
  assert.throws(
    () => normalizeOwnerRequest({ kind: 'BROWSER_SIGN_IN', title: 'Sign in to github.com', why: 'w' }, new Date()),
    /filed with browser_request_sign_in/,
  );
  assert.deepEqual(ownerRequestAlert('BROWSER_SIGN_IN', browserSignInTitle('github.com')),
    { title: 'Sign in needed', body: 'Sign in to github.com' });
});

test('a sign-in site is the host the agent named; a URL is cut to its host, and anything else is refused', () => {
  assert.equal(browserSignInSite(' GitHub.com '), 'github.com');
  assert.equal(browserSignInSite('https://user:pw@github.com/login?return_to=%2Facme'), 'github.com');
  assert.equal(browserSignInSite('accounts.example.com:8443'), 'accounts.example.com:8443');
  for (const bad of ['', '  ', 'github.com/login', 'not a host', '-x.com', 'x'.repeat(254), 'javascript:alert(1)']) {
    assert.equal(browserSignInSite(bad), undefined, bad);
  }
});
