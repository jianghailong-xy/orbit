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

/**
 * Whether the card calls the branch "on main" (`branchOnMain`), with receipts carrying what
 * `taskLanding` compares: a rework landed on the line after an older promotion is not on main by it,
 * nor by a newer promotion naming the earlier landing.
 */
const PROJECT_LINE = { upstream: ['main'], integration: ['project/p1'] };
const at = (minute: number) => new Date(Date.UTC(2026, 10, 15, 0, minute));
type Receipt = {
  result: string; targetBranch: string; sourceSha: string; targetShaAfter: string; createdAt: Date; detail: Record<string, never>;
};
const merged = (targetBranch: string, sourceSha: string, targetShaAfter: string, minute: number): Receipt => ({
  result: 'MERGED', targetBranch, sourceSha, targetShaAfter, createdAt: at(minute), detail: {},
});
const FIRST = { source: '1'.repeat(40), after: 'a'.repeat(40) };
const REWORK = { source: '2'.repeat(40), after: 'd'.repeat(40) };
const landedOnLine = (landing: typeof FIRST, minute: number) =>
  merged('project/p1', landing.source, landing.after, minute);
const promoted = (landing: typeof FIRST, minute: number) => merged('main', landing.after, 'e'.repeat(40), minute);
const onMainBy = (receipts: Receipt[], branchMerged: boolean | null) =>
  ifConfirmed.branchOnMain({ receipts, branches: PROJECT_LINE, branchMerged, judgedAgainst: 'main' });
const REWORKED = [landedOnLine(FIRST, 1), promoted(FIRST, 2), landedOnLine(REWORK, 3)];

test('an older promotion and a newer line receipt: not YES, the runner\'s verdict answers', () => {
  assert.equal(onMainBy(REWORKED, false), 'NO');
  assert.equal(onMainBy(REWORKED, null), 'UNKNOWN');
});

test('a newer promotion naming the earlier landing does not put the rework on main', () => {
  assert.equal(onMainBy([...REWORKED, promoted(FIRST, 4)], false), 'NO');
});

test('a newer upstream receipt naming the rework\'s landing puts the branch on main', () => {
  assert.equal(onMainBy([...REWORKED, promoted(REWORK, 4)], false), 'YES');
});

test('upstream receipts alone answer YES as before, with or without the fields the rule compares', () => {
  assert.equal(onMainBy([promoted(FIRST, 1)], false), 'YES');
  assert.equal(ifConfirmed.branchOnMain({
    receipts: [{ result: 'MERGED', targetBranch: 'main' }], branches: PROJECT_LINE, branchMerged: false,
    judgedAgainst: 'main',
  }), 'YES');
});
