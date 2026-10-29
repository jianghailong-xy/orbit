import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ifConfirmed from './owner-confirmation-if-confirmed';

/**
 * What the owner's confirmation card says a DONE's work does next (`ifConfirmed.landing`), by the
 * project's delivery mode (§10.5 O-L2): an AGENT_PUSH project builds no candidate, so no merge card
 * follows — `AGENT_PUSHED`, never "merging into main asks you again". Read through the module, so this
 * file compiles on a tree from before the value existed and is red there for want of it.
 */
type Landing = (input: { deliveryMode: string | null | undefined; automatic: boolean }) => string;
const confirmationLanding = (input: Parameters<Landing>[0]): string => {
  const read = (ifConfirmed as unknown as { confirmationLanding?: Landing }).confirmationLanding;
  assert.ok(read, 'the card has no rule for how a DONE lands by delivery mode');
  return read(input);
};

test('an AGENT_PUSH project\'s DONE reads AGENT_PUSHED, whatever Automatic says', () => {
  assert.equal(confirmationLanding({ deliveryMode: 'AGENT_PUSH', automatic: false }), 'AGENT_PUSHED');
  assert.equal(confirmationLanding({ deliveryMode: 'AGENT_PUSH', automatic: true }), 'AGENT_PUSHED');
});

test('a PLATFORM project\'s DONE reads as before: Automatic merges it, or the owner is asked again', () => {
  assert.equal(confirmationLanding({ deliveryMode: 'PLATFORM', automatic: true }), 'AUTO_MAIN');
  assert.equal(confirmationLanding({ deliveryMode: 'PLATFORM', automatic: false }), 'LINE_THEN_OWNER');
});

test('a project with no binding read yet is PLATFORM, the column\'s default', () => {
  assert.equal(confirmationLanding({ deliveryMode: null, automatic: false }), 'LINE_THEN_OWNER');
  assert.equal(confirmationLanding({ deliveryMode: undefined, automatic: true }), 'AUTO_MAIN');
});
