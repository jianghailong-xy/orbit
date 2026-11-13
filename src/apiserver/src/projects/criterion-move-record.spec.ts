import assert from 'node:assert/strict';
import test from 'node:test';

import { criterionMoveRecord, type CriterionMoveRow } from './criterion-move-record';

/**
 * The fold behind the move record (board 02 G/I): each criterion counts once per side — its newest
 * move — and only while that move is still where it stands. The statement is the pg spec's
 * (`criterion-move.pg.spec.ts`).
 */

const A = 'project-a';
const B = 'project-b';
const C = 'project-c';
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 11, 19, minutes));
const key = (id: string) => `key-${id}`;

function move(over: Partial<CriterionMoveRow>): CriterionMoveRow {
  return {
    id: 'act', created_at: at(0), definition_id: 'crit-4', from_project_id: A, to_project_id: B,
    from_ordinal: 4, definition_project_id: B, text: 'External prerequisites settled',
    from_title: 'CBAI Phase 0', to_title: 'CBAI Phase 0 · follow-up', ...over,
  };
}

test('the source lists what it moved out; the destination\'s criterion says where it came from', () => {
  const rows = [move({})];
  const source = criterionMoveRecord(A, rows, key);
  assert.deepEqual(source.movedOut, [{
    criterionKey: 'key-crit-4', definitionId: 'crit-4', ordinal: 4, text: 'External prerequisites settled',
    toProjectId: B, toProjectTitle: 'CBAI Phase 0 · follow-up', movedAt: at(0),
  }]);
  assert.equal(source.movedFrom.size, 0);
  const target = criterionMoveRecord(B, rows, key);
  assert.deepEqual(target.movedOut, []);
  assert.deepEqual(target.movedFrom.get('crit-4'), { fromProjectId: A, fromProjectTitle: 'CBAI Phase 0', movedAt: at(0) });
});

test('only the newest move of a criterion counts: moved on, or moved back', () => {
  // A → B, then B → C: A still moved it out (to B, its own move); B moved it out to C; C has it from B.
  const onward = [
    move({ id: '2', created_at: at(5), from_project_id: B, to_project_id: C, definition_project_id: C, from_ordinal: 2, from_title: 'B', to_title: 'C' }),
    move({ id: '1', definition_project_id: C }),
  ];
  assert.equal(criterionMoveRecord(B, onward, key).movedOut[0].toProjectId, C);
  assert.equal(criterionMoveRecord(B, onward, key).movedFrom.size, 0, 'it is no longer in B');
  assert.equal(criterionMoveRecord(C, onward, key).movedFrom.get('crit-4')?.fromProjectId, B);
  // A → B, then B → A: A did not "move it out", and reads it as moved from B.
  const back = [
    move({ id: '2', created_at: at(5), from_project_id: B, to_project_id: A, definition_project_id: A, from_title: 'B', to_title: 'A' }),
    move({ id: '1', definition_project_id: A }),
  ];
  assert.deepEqual(criterionMoveRecord(A, back, key).movedOut, []);
  assert.equal(criterionMoveRecord(A, back, key).movedFrom.get('crit-4')?.fromProjectId, B);
});

test('a record whose criterion or other project is gone is left out; unnumbered records sort last', () => {
  assert.deepEqual(criterionMoveRecord(A, [move({ text: null, definition_project_id: null })], key).movedOut, []);
  assert.deepEqual(criterionMoveRecord(A, [move({ to_title: null })], key).movedOut, []);
  assert.equal(criterionMoveRecord(B, [move({ from_title: null })], key).movedFrom.size, 0);
  const sorted = criterionMoveRecord(A, [
    move({ id: '3', definition_id: 'x', from_ordinal: null, created_at: at(9) }),
    move({ id: '2', definition_id: 'y', from_ordinal: 5, created_at: at(8) }),
    move({ id: '1', definition_id: 'z', from_ordinal: 2, created_at: at(7) }),
  ], key);
  assert.deepEqual(sorted.movedOut.map((m) => m.definitionId), ['z', 'y', 'x']);
});
