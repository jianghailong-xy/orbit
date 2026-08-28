import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BootstrapDeliveryFacts,
  decideBootstrapDeliveryFence,
} from './bootstrap-delivery-fence';

const SOURCE = '1'.repeat(40);
const LANDED = '2'.repeat(40);
const TARGET = '3'.repeat(40);

function green(): BootstrapDeliveryFacts {
  return {
    authorId: 'author-session',
    sourceSha: SOURCE,
    targetBranch: 'main',
    currentTargetSha: TARGET,
    receipt: {
      result: 'MERGED',
      sourceSha: SOURCE,
      targetBranch: 'main',
      targetShaAfter: LANDED,
    },
    targetContainsSource: true,
    verifier: {
      verifierId: 'independent-verifier',
      checkoutSha: TARGET,
      clean: true,
      expectedExitCode: 0,
      actualExitCode: 0,
      executions: 17,
      failures: 0,
      skipped: 0,
    },
  };
}

test('an unmerged worktree cannot unlock downstream work', () => {
  const facts = green();
  facts.receipt = null;
  facts.targetContainsSource = false;
  assert.equal(decideBootstrapDeliveryFence(facts).decision, 'SOURCE_NOT_LANDED');
});

test('a receipt alone is insufficient when target containment is no longer true', () => {
  const facts = green();
  facts.targetContainsSource = false;
  assert.equal(decideBootstrapDeliveryFence(facts).decision, 'SOURCE_NOT_LANDED');
});

test('a failed clean rerun at the exact target SHA blocks release', () => {
  const facts = green();
  facts.verifier!.actualExitCode = 1;
  facts.verifier!.failures = 1;
  assert.equal(decideBootstrapDeliveryFence(facts).decision, 'TARGET_RERUN_FAILED');
});

test('a different, dirty, or skipped target run cannot masquerade as verification', () => {
  let facts = green();
  facts.verifier!.checkoutSha = LANDED;
  assert.equal(decideBootstrapDeliveryFence(facts).decision, 'TARGET_SHA_UNVERIFIABLE');

  facts = green();
  facts.verifier!.verifierId = facts.authorId;
  assert.equal(decideBootstrapDeliveryFence(facts).decision, 'VERIFIER_NOT_INDEPENDENT');

  facts = green();
  facts.verifier!.clean = false;
  assert.equal(decideBootstrapDeliveryFence(facts).decision, 'TARGET_CHECKOUT_NOT_CLEAN');

  facts = green();
  facts.verifier!.skipped = 1;
  assert.equal(decideBootstrapDeliveryFence(facts).decision, 'TARGET_RERUN_SKIPPED');
});

test('only receipt + containment + independent clean target success unlocks', () => {
  assert.deepEqual(decideBootstrapDeliveryFence(green()), {
    decision: 'ALLOWED',
    targetSha: TARGET,
    executions: 17,
  });
});
