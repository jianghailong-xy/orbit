import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ProjectsController } from './projects.controller';
import {
  ownerRatificationReference,
  withoutOwnerRatificationCapability,
} from './owner-ratification-surface';

const OWNER = '019fcda0-d021-72a2-a914-2f4de38f4b01';
const PROJECT = '019fcda0-d021-72a2-a914-2f4de38f4b02';
const REQUEST = '019fcda0-d021-72a2-a914-2f4de38f4b03';
const CTA = '019fcda0-d021-72a2-a914-2f4de38f4b04';
const CONTRACT = 'a'.repeat(64);

function controller(acceptance: object): ProjectsController {
  return new ProjectsController(
    {} as never,
    acceptance as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

test('owner REST surface exposes a pending inbox plus one canonical GET/POST decision channel', () => {
  const proto = ProjectsController.prototype;
  assert.equal(
    Reflect.getMetadata(PATH_METADATA, proto.pendingOwnerRatification),
    'ratification/pending',
  );
  assert.equal(
    Reflect.getMetadata(METHOD_METADATA, proto.pendingOwnerRatification),
    RequestMethod.GET,
  );
  assert.equal(Reflect.getMetadata(PATH_METADATA, proto.ownerRatification), ':id/ratification');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, proto.ownerRatification), RequestMethod.GET);
  assert.equal(
    Reflect.getMetadata(PATH_METADATA, proto.decideOwnerRatification),
    ':id/ratification',
  );
  assert.equal(
    Reflect.getMetadata(METHOD_METADATA, proto.decideOwnerRatification),
    RequestMethod.POST,
  );
});

test('controller derives owner from JWT context and preserves every exact decision binding', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const acceptance = {
    pendingOwnerRatificationInbox: async (...args: unknown[]) => {
      calls.push({ method: 'pending', args });
      return { total: 0, items: [] };
    },
    ownerRatification: async (...args: unknown[]) => {
      calls.push({ method: 'read', args });
      return { ratified: false };
    },
    ratifyByOwner: async (...args: unknown[]) => {
      calls.push({ method: 'decide', args });
      return { ok: true };
    },
  };
  const api = controller(acceptance);
  const body = {
    decision: 'APPROVE' as const,
    expectedContractDigest: CONTRACT,
    decisionRequestId: REQUEST,
    ctaToken: CTA,
    idempotencyKey: 'owner-ui-fixture:1',
  };

  await api.pendingOwnerRatification({ userId: OWNER } as never, '17');
  await api.ownerRatification({ userId: OWNER } as never, PROJECT);
  await api.decideOwnerRatification({ userId: OWNER } as never, PROJECT, body);
  assert.deepEqual(calls, [
    { method: 'pending', args: [OWNER, 17] },
    { method: 'read', args: [OWNER, PROJECT] },
    { method: 'decide', args: [OWNER, PROJECT, body] },
  ]);
  assert.equal('actorId' in body, false, 'the client cannot choose the authenticated owner');
});

test('canonical reference keeps linked obligation revision/watermark and cannot carry CTA', () => {
  const reference = ownerRatificationReference({
    projectId: PROJECT,
    projectTitle: 'Fixture',
    ownerId: OWNER,
    requestId: REQUEST,
    requestGeneration: 7n,
    contractDigest: CONTRACT,
    contractRevision: 11n,
    reasonCode: 'OWNER_RATIFICATION_REQUIRED',
    createdAt: '2026-08-29T00:00:00.000Z',
    expiresAt: '2099-09-05T00:00:00.000Z',
    linkedObligations: [{
      obligationId: 'b'.repeat(64),
      obligationRevision: 'c'.repeat(64),
      bindingDigest: 'd'.repeat(64),
      evaluatedThroughWatermark: '29',
      taskId: '019fcda0-d021-72a2-a914-2f4de38f4b05',
      reasonCode: 'OWNER_RATIFICATION_REQUIRED',
    }],
  });
  assert.equal(reference.decisionRequestId, REQUEST);
  assert.equal(reference.requestRevision, '7');
  assert.equal(reference.obligationId, 'b'.repeat(64));
  assert.equal(reference.obligationRevision, 'c'.repeat(64));
  assert.equal(reference.contractDigest, CONTRACT);
  assert.equal(reference.reason, 'OWNER_RATIFICATION_REQUIRED');
  assert.equal(reference.owner, 'OWNER');
  assert.equal(reference.evaluatedThroughWatermark, '29');
  assert.equal(JSON.stringify(reference).includes(CTA), false);
  assert.equal('ctaToken' in reference, false);
});

test('machine/cache/error redaction removes CTA recursively without damaging identity', () => {
  const value = {
    decisionRequest: {
      id: REQUEST,
      ctaToken: CTA,
      payload: { nested: { cta_token: CTA, contractDigest: CONTRACT } },
    },
  };
  const safe = withoutOwnerRatificationCapability(value) as typeof value;
  assert.equal(JSON.stringify(safe).includes(CTA), false);
  assert.equal(safe.decisionRequest.id, REQUEST);
  assert.equal(safe.decisionRequest.payload.nested.contractDigest, CONTRACT);
});
