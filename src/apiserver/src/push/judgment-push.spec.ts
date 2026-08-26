import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { PushService } from './push.service';
import type { JudgmentAlertInput } from './judgment-alert';

function config(enabled = true): ConfigService {
  const values: Record<string, string> = enabled ? {
    APNS_KEY_ID: 'key-id',
    APNS_TEAM_ID: 'team-id',
    APNS_KEY: Buffer.from('test-key').toString('base64'),
  } : {};
  return { get: (key: string) => values[key] } as ConfigService;
}

const input: JudgmentAlertInput = {
  recipientId: '019d2f9b-1f33-7ad5-92ae-4eb692024d72',
  requestId: '019d2f9b-216d-7c62-a5c6-5bdb84b272bb',
  requestVersion: 1,
  taskId: '019d2f9b-21df-70ed-bcee-ae6fbb468a86',
  taskTitle: 'Review delivery',
  projectId: null,
  projectTitle: null,
  requiredAction: 'REVIEW_EVIDENCE_AND_SIGN_OFF',
  deepLink: '/tasks/task?judgmentRequest=request',
  openCount: 1,
};

test('an unavailable sender and an account with no device are durable BLOCKED outcomes', async () => {
  const disabled = new PushService({} as never, config(false));
  const noConfig = await disabled.deliverJudgmentRequest(input);
  assert.equal(noConfig.outcome, 'BLOCKED');
  assert.equal(noConfig.code, 'PUSH_NOT_CONFIGURED');

  const noDevice = new PushService({
    deviceToken: { findMany: async () => [] },
  } as never, config());
  const absent = await noDevice.deliverJudgmentRequest(input);
  assert.equal(absent.outcome, 'BLOCKED');
  assert.equal(absent.code, 'NO_DEVICES');
  assert.equal(absent.requiredAction, 'REGISTER_DEVICE');
});

test('APNs acceptance is a delivery receipt; zero accepted devices remains retryable', async () => {
  const prisma = {
    deviceToken: {
      findMany: async () => [{ token: 'device', environment: 'sandbox' }],
    },
  };
  const service = new PushService(prisma as never, config());
  (service as any).authToken = () => 'auth';
  const calls: Array<{ body: string; collapseId: string }> = [];
  (service as any).deliver = async (
    _tokens: unknown,
    body: string,
    _type: unknown,
    _priority: unknown,
    _auth: unknown,
    collapseId: string,
  ) => {
    calls.push({ body, collapseId });
    return calls.length === 1 ? 0 : 1;
  };

  const offline = await service.deliverJudgmentRequest(input);
  assert.equal(offline.outcome, 'RETRY');
  assert.equal(offline.code, 'PUSH_NOT_ACCEPTED');

  const repaired = await service.deliverJudgmentRequest(input);
  assert.deepEqual(repaired.outcome, 'DELIVERED');
  if (repaired.outcome === 'DELIVERED') assert.equal(repaired.devices, 1);
  assert.equal(calls[0].collapseId, calls[1].collapseId, 'a retry replaces instead of stacking');
  assert.equal(JSON.parse(calls[1].body).kind, 'human-signoff-required');
});

test('a thrown APNs transport failure is returned to the durable ledger as retryable', async () => {
  const service = new PushService({
    deviceToken: {
      findMany: async () => [{ token: 'device', environment: 'sandbox' }],
    },
  } as never, config());
  (service as any).authToken = () => 'auth';
  (service as any).deliver = async () => {
    throw new Error('simulated APNs outage');
  };

  const failed = await service.deliverJudgmentRequest(input);
  assert.equal(failed.outcome, 'RETRY');
  assert.equal(failed.code, 'PUSH_FAILED');
  assert.match(failed.error, /simulated APNs outage/);
  assert.equal(failed.payload.kind, 'human-signoff-required');
});
