import { describe, expect, it } from 'vitest';
import fixture from '../../../../contracts/outcome-reconciler-v2.surfaces.fixture.json';
import { outcomeSemanticTuple, type OutcomeSemanticObligation } from './outcomeSurfaces';

describe('Outcome surface Web contract', () => {
  it('preserves the canonical fixture tuple without deriving Web-owned semantics', () => {
    for (const obligation of fixture.projection.obligations) {
      const semantic = obligation as OutcomeSemanticObligation;
      expect(outcomeSemanticTuple({ semantic })).toEqual({
        obligationId: obligation.obligationId,
        obligationRevision: obligation.obligationRevision,
        bindingDigest: obligation.bindingDigest,
        binding: obligation.binding,
        reason: obligation.reason,
        owner: obligation.owner,
        evaluatedThroughLogicalTime: obligation.evaluatedThroughLogicalTime,
        projectionRevision: obligation.projectionRevision,
      });
    }
  });
});
