/**
 * The temporary self-hosting fence used while the outcome reconciler is being built.
 *
 * A green worktree is not delivery evidence.  The source must have a durable Orbit merge receipt,
 * the target must still contain it, and a different verifier must execute the acceptance suite in
 * a clean checkout of the target SHA that is about to release downstream work.  This value is pure
 * so the coordinator gate and the bootstrap manifest judge exactly the same facts.
 */
export interface BootstrapMergeReceiptFact {
  result: 'MERGED' | 'ALREADY_MERGED' | 'CONFLICT' | 'ERROR';
  sourceSha: string;
  targetBranch: string;
  targetShaAfter: string | null;
}
export interface BootstrapVerifierFact {
  verifierId: string;
  checkoutSha: string;
  clean: boolean;
  expectedExitCode: number;
  actualExitCode: number;
  executions: number;
  failures: number;
  skipped: number;
}

export interface BootstrapDeliveryFacts {
  authorId: string;
  sourceSha: string;
  targetBranch: string;
  currentTargetSha: string;
  receipt: BootstrapMergeReceiptFact | null;
  targetContainsSource: boolean;
  verifier: BootstrapVerifierFact | null;
}

export type BootstrapDeliveryBlock =
  | 'SOURCE_NOT_LANDED'
  | 'TARGET_SHA_UNVERIFIABLE'
  | 'VERIFIER_NOT_INDEPENDENT'
  | 'TARGET_CHECKOUT_NOT_CLEAN'
  | 'TARGET_RERUN_EMPTY'
  | 'TARGET_RERUN_SKIPPED'
  | 'TARGET_RERUN_FAILED';

export type BootstrapDeliveryDecision =
  | { decision: 'ALLOWED'; targetSha: string; executions: number }
  | { decision: BootstrapDeliveryBlock; detail: string };

const SHA = /^[0-9a-f]{40}$/;

export function decideBootstrapDeliveryFence(
  facts: BootstrapDeliveryFacts,
): BootstrapDeliveryDecision {
  const sourceSha = facts.sourceSha.trim().toLowerCase();
  const targetSha = facts.currentTargetSha.trim().toLowerCase();
  const receipt = facts.receipt;
  if (
    !SHA.test(sourceSha)
    || !receipt
    || !['MERGED', 'ALREADY_MERGED'].includes(receipt.result)
    || receipt.sourceSha.trim().toLowerCase() !== sourceSha
    || receipt.targetBranch !== facts.targetBranch
    || !facts.targetContainsSource
  ) {
    return {
      decision: 'SOURCE_NOT_LANDED',
      detail: 'the source needs a matching merge receipt and must be contained by the target',
    };
  }
  if (!SHA.test(targetSha) || !receipt.targetShaAfter || !SHA.test(receipt.targetShaAfter)) {
    return {
      decision: 'TARGET_SHA_UNVERIFIABLE',
      detail: 'the receipt and current target must name full checkable SHAs',
    };
  }
  const verifier = facts.verifier;
  if (!verifier || verifier.verifierId === facts.authorId) {
    return {
      decision: 'VERIFIER_NOT_INDEPENDENT',
      detail: 'the clean target rerun must be recorded by an independent verifier',
    };
  }
  if (verifier.checkoutSha.trim().toLowerCase() !== targetSha) {
    return {
      decision: 'TARGET_SHA_UNVERIFIABLE',
      detail: 'the verifier did not run against the current target SHA',
    };
  }
  if (!verifier.clean) {
    return {
      decision: 'TARGET_CHECKOUT_NOT_CLEAN',
      detail: 'the verifier checkout contains changes not named by the target SHA',
    };
  }
  if (verifier.executions <= 0) {
    return { decision: 'TARGET_RERUN_EMPTY', detail: 'the target rerun executed no checks' };
  }
  if (verifier.skipped !== 0) {
    return { decision: 'TARGET_RERUN_SKIPPED', detail: 'a skipped check is missing evidence' };
  }
  if (
    verifier.failures !== 0
    || verifier.actualExitCode !== verifier.expectedExitCode
  ) {
    return { decision: 'TARGET_RERUN_FAILED', detail: 'the clean target rerun did not pass' };
  }
  return { decision: 'ALLOWED', targetSha, executions: verifier.executions };
}
