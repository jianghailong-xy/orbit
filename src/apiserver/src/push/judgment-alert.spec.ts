import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgmentAlert, type JudgmentAlertInput } from './judgment-alert';

const input: JudgmentAlertInput = {
  recipientId: '019d2f9b-1f33-7ad5-92ae-4eb692024d72',
  requestId: '019d2f9b-216d-7c62-a5c6-5bdb84b272bb',
  requestVersion: 1,
  taskId: '019d2f9b-21df-70ed-bcee-ae6fbb468a86',
  taskTitle: 'Release the signed macOS client',
  projectId: '019d2f9b-2248-7a8b-8d86-ec257fe5553d',
  projectTitle: 'Orbit 0.2 launch',
  requiredAction: 'REVIEW_EVIDENCE_AND_SIGN_OFF',
  deepLink: '/tasks/019d2f9b-21df-70ed-bcee-ae6fbb468a86?judgmentRequest=019d2f9b-216d-7c62-a5c6-5bdb84b272bb',
  openCount: 1,
};

test('judgment push names project, task, required action and direct link without claiming a signature', () => {
  const alert = judgmentAlert(input);
  assert.match(alert.title, /Orbit 0\.2 launch/);
  assert.match(alert.body, /Release the signed macOS client/);
  assert.match(alert.body, /needs your human sign-off/);
  assert.match(alert.body, new RegExp(input.deepLink.replace(/[?]/g, '\\?')));
  assert.doesNotMatch(alert.body, /has been signed|was signed|approved|notification delivered/i);

  assert.equal(alert.payload.kind, 'human-signoff-required');
  assert.equal(alert.payload.requiredAction, 'REVIEW_EVIDENCE_AND_SIGN_OFF');
  assert.equal(alert.payload.deepLink, input.deepLink);
  assert.equal(alert.payload.judgmentRequestID, input.requestId);
  assert.equal(alert.payload.taskID, input.taskId);
  assert.equal(alert.payload.projectID, input.projectId);
});

test('a burst may collapse into one summary without erasing any request identity', () => {
  const single = judgmentAlert(input);
  const summary = judgmentAlert({ ...input, requestId: 'another-request', openCount: 4 });

  assert.equal(single.collapseId, summary.collapseId, 'one recipient gets one replaceable APNs thread');
  assert.match(summary.body, /and 3 more need your human sign-off/);
  assert.equal(summary.payload.judgmentRequestID, 'another-request');
  assert.equal(summary.payload.openJudgmentCount, 4);
});
