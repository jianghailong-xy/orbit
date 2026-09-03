import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * The delivery half of the 2026-09-02 removal.
 *
 * 0182 gave a judgment request a durable in-app inbox item and a retryable device projection, and
 * `JudgmentDeliveryService` was the resident worker that leased, sent and expired them. All of it
 * went with the request. What this guards is that it went WITHOUT a replacement: the point of the
 * decision was to leave the space empty, and a "temporary" nudge, timer or outbox put back in the
 * push module would be exactly the thing it removed.
 */

const API = path.resolve(__dirname, '../..');
const ROOT = path.resolve(API, '../..');
const PUSH = path.join(API, 'src/push');

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

test('the delivery worker, its alert and their specs are deleted', () => {
  for (const file of ['judgment-delivery.service.ts', 'judgment-delivery.spec.ts',
    'judgment-delivery.pg.spec.ts', 'judgment-alert.ts', 'judgment-alert.spec.ts',
    'judgment-push.spec.ts']) {
    assert.equal(existsSync(path.join(PUSH, file)), false, `push/${file} must be deleted`);
  }
  // Nothing judgment-shaped is left in the directory at all.
  const remaining = readdirSync(PUSH).filter((file) => /judgment/i.test(file));
  assert.deepEqual(remaining, ['judgment-delivery-removal.spec.ts']);
});

test('the push module keeps only the sender, and gained no resident process', () => {
  const module = read('src/apiserver/src/push/push.module.ts');
  assert.match(module, /providers: \[PushService\]/u);
  assert.match(module, /exports: \[PushService\]/u);
  assert.doesNotMatch(module, /Judgment/u);
  assert.doesNotMatch(module, /setInterval|setTimeout|OnModuleInit|OnApplicationBootstrap/u);

  const service = read('src/apiserver/src/push/push.service.ts');
  assert.doesNotMatch(service, /deliverJudgmentRequest|judgmentAlert|JudgmentPushResult/u);
  // The APNs sender itself is untouched: session pushes and the badge sync are not this change's.
  assert.match(service, /scheduleBadgeSync/u);
  assert.match(service, /needsYouSessions/u);

  const controller = read('src/apiserver/src/push/push.controller.ts');
  assert.doesNotMatch(controller, /judgments\?\.kick|JudgmentDeliveryService/u);
  assert.match(controller, /deviceToken\.upsert/u, 'device registration is not part of the removal');
});

test('the removal migration takes the inbox and the outbox, and adds no table in their place', () => {
  const removal = readFileSync(
    path.join(API, 'prisma/migrations/0228_task_judgment_removal/migration.sql'), 'utf8',
  );
  assert.match(removal, /DROP TABLE "task_judgment_push_delivery";/u);
  assert.match(removal, /DROP TABLE "task_judgment_inbox_item";/u);
  assert.doesNotMatch(removal, /CREATE\s+TABLE/iu, 'the removal creates no table of any kind');

  // The one surviving device table is `device_token`, which predates all of this.
  //
  // The web inbox this used to check is gone too. 0228 left it standing on its project acceptance
  // half; migration 0229 removed that half on a later account-owner decision, so the page, both
  // its routes and the sidebar entry that badged it went with it. Asserted as an absence, because
  // a page that came back would come back reading an endpoint that is no longer served.
  for (const gone of [
    'src/web/src/pages/JudgmentInboxPage.tsx',
    'src/web/src/pages/ProjectAcceptanceReviewPage.tsx',
    'src/web/src/lib/projectAcceptance.ts',
  ]) {
    assert.equal(existsSync(path.join(ROOT, gone)), false, `${gone} survives 0229`);
  }
  assert.doesNotMatch(read('src/web/src/App.tsx'), /judgments/u,
    'the judgment routes must be gone with the pages they mounted');
});
