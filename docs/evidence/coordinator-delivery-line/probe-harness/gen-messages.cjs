// Writes the three fixture messages exactly as the apiserver builds them, for the probe's stub.
const path = require('node:path');
const build = process.argv[2];
const { buildCoordinatorDeliveryMessage } = require(path.join(build, 'projects/coordinator-judgment-opening.js'));
const { completionEvidenceRevisedFact } = require(path.join(build, 'projects/completion-input.js'));
const { dependentReadyFact, criterionUnlandedFact } = require(path.join(build, 'projects/coordinator-wake.js'));
const { base62ToUuid } = require('node:module').createRequire(path.join(build, 'index.js'))('@orbit/shared');
const PROJECT = '01a1926c-0000-7000-8000-00000000c0de';
const evidenceTask = base62ToUuid('34nmQgDgyywHNIUtjb9TD');
const evidence = completionEvidenceRevisedFact({ projectId: PROJECT, taskId: evidenceTask, revision: '1', criterionRevision: '1', evidenceDigest: 'e'.repeat(64) });
evidence.detail = { ...evidence.detail, title: 'Wiki model queue: one claim can take more requests than the concurrency room',
  criterion: { key: '34nmQgDgyywHNIUtjb9TD', text: 'Attach the test results: the new pg spec makes claimWikiModelRequests take the rescanning plan deterministically (EXPLAIN ANALYZE shows the subquery loops > 1); before the fix one claim takes more than the room, after it never does, and no job goes past its maxInFlightPerJob. wiki-model-queue.pg.spec.ts passes.' },
  escalationSeconds: 1800 };
const ready = dependentReadyFact({ projectId: PROJECT, taskId: base62ToUuid('34pVVKDohkOa6db1Z4vFF'), title: 'Switch the runner link to WebSocket', dispatchEpoch: 4 });
const unlanded = criterionUnlandedFact(PROJECT, 'k'.repeat(16), [
  { taskId: base62ToUuid('34nmQgDgyywHNIUtjb9TD'), status: 'DONE' },
  { taskId: base62ToUuid('34pVVKDohkOa6db1Z4vFF'), status: 'DONE' },
  { taskId: base62ToUuid('34pVGFQvGcjxSppunCWTK'), status: 'DONE' },
], 'ON_INTEGRATION_LINE');
const title = 'Runner link v1: runner ↔ control plane over WebSocket';
process.stdout.write(JSON.stringify({
  evidence: buildCoordinatorDeliveryMessage(evidence, title),
  ready: buildCoordinatorDeliveryMessage(ready, title),
  unlanded: buildCoordinatorDeliveryMessage(unlanded, title),
  ids: { evidenceTask: '34nmQgDgyywHNIUtjb9TD', readyTask: '34pVVKDohkOa6db1Z4vFF' },
}, null, 1));
