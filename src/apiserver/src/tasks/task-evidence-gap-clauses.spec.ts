import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { parseEvidenceEnvelope, storedEvidenceEnvelope } from './task-evidence-envelope';

const BASE = { claim: 'done', checks: [{ kind: 'TOOL_CALL', ref: 'bgj_1' }] };
const FOLLOW_UP = '34w9LTVT5qdqRU5urBqQt';

function shapeRefusal(evidence: unknown): string {
  try {
    parseEvidenceEnvelope(evidence);
  } catch (error) {
    assert.ok(error instanceof BadRequestException);
    const body = error.getResponse() as { code: string; message: string };
    assert.equal(body.code, 'EVIDENCE_ENVELOPE_INVALID');
    return body.message;
  }
  assert.fail('expected a shape refusal');
}

test('plain-text gaps parse as before and carry no gapClauses', () => {
  const envelope = parseEvidenceEnvelope({ ...BASE, gaps: ['not on a phone'] });
  assert.deepEqual(envelope.gaps, ['not on a phone']);
  assert.equal('gapClauses' in envelope, false);
});

test('gapClauses parse beside gaps, which stay strings, and read back from the stored envelope', () => {
  const evidence = {
    ...BASE,
    gaps: ['not on a phone', 'dark mode unchecked'],
    gapClauses: [
      { gap: 0, criterionClause: 'on a phone', followUpTaskId: FOLLOW_UP },
      { gap: 1, criterionClause: 'in dark mode' },
    ],
  };
  const envelope = parseEvidenceEnvelope(evidence);
  assert.deepEqual(envelope.gaps, ['not on a phone', 'dark mode unchecked']);
  assert.deepEqual(envelope.gapClauses, evidence.gapClauses);
  assert.deepEqual(storedEvidenceEnvelope(evidence)?.gapClauses, evidence.gapClauses);
});

test('a gapClauses entry has to point at one gap, once, name a clause and a task id', () => {
  const gaps = ['not on a phone'];
  assert.match(shapeRefusal({ ...BASE, gaps, gapClauses: {} }), /gapClauses must be an array/);
  assert.match(shapeRefusal({ ...BASE, gaps, gapClauses: [{ gap: 1, criterionClause: 'x' }] }), /gapClauses\[0\]\.gap must be the index/);
  assert.match(shapeRefusal({ ...BASE, gaps, gapClauses: [{ gap: 0.5, criterionClause: 'x' }] }), /gap must be the index/);
  assert.match(shapeRefusal({ ...BASE, gaps, gapClauses: [{ gap: 0 }] }), /missing criterionClause/);
  assert.match(shapeRefusal({ ...BASE, gaps, gapClauses: [{ gap: 0, criterionClause: ' ' }] }), /must not be blank/);
  assert.match(
    shapeRefusal({ ...BASE, gaps, gapClauses: [{ gap: 0, criterionClause: 'x' }, { gap: 0, criterionClause: 'y' }] }),
    /marks evidence\.gaps\[0\] a second time/,
  );
  assert.match(
    shapeRefusal({ ...BASE, gaps, gapClauses: [{ gap: 0, criterionClause: 'x', followUpTaskId: 'not an id!' }] }),
    /followUpTaskId must be a task id/,
  );
  assert.match(
    shapeRefusal({ ...BASE, gaps, gapClauses: [{ gap: 0, criterionClause: 'x', note: 'y' }] }),
    /carries note/,
  );
});
