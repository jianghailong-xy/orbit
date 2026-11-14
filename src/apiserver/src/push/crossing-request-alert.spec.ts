import assert from 'node:assert/strict';
import { test } from 'node:test';

import { crossingRequestAlert } from './crossing-request-alert';
import { crossingCardSessionId } from '../projects/project-handoff.service';

const end = (coordinatorSessionId: string | null, trashed = false) => ({
  coordinatorSessionId,
  coordinatorSession: coordinatorSessionId ? { deletedAt: trashed ? new Date() : null } : null,
});

test('a move out of every project asks to take the task out of its project', () => {
  assert.deepEqual(crossingRequestAlert({
    kind: 'MOVE_TASK', title: 'Fix the  connector\nisolation', toProjectId: null,
    fromProject: { title: 'Ollama' }, toProject: null,
  }), { title: 'Take a task out of “Ollama”?', body: 'Fix the connector isolation' });
});

test('a move between projects names both ends', () => {
  assert.deepEqual(crossingRequestAlert({
    kind: 'MOVE_TASK', title: 'T', toProjectId: 'b',
    fromProject: { title: 'A' }, toProject: { title: 'B' },
  }), { title: 'Move a task from “A” to “B”?', body: 'T' });
});

test('a long title is cut with an ellipsis', () => {
  const { body } = crossingRequestAlert({
    kind: 'MOVE_TASK', title: 'x'.repeat(400), toProjectId: null,
    fromProject: { title: 'A' }, toProject: null,
  });
  assert.equal(body.length, 160);
  assert.ok(body.endsWith('…'));
});

test('the card is drawn by the target coordinator, or the source one for a move out', () => {
  assert.equal(crossingCardSessionId({ toProjectId: 'b', toProject: end('cb'), fromProject: end('ca') }), 'cb');
  assert.equal(crossingCardSessionId({ toProjectId: null, toProject: null, fromProject: end('ca') }), 'ca');
  // No coordinator, or one in Trash, draws nothing: the project page lists it instead.
  assert.equal(crossingCardSessionId({ toProjectId: 'b', toProject: end(null), fromProject: end('ca') }), null);
  assert.equal(crossingCardSessionId({ toProjectId: null, toProject: null, fromProject: end('ca', true) }), null);
});
