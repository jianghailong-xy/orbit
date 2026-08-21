// Real Orbit API smoke for a Codex steer during a long tool call.
//
// Auth: ORBIT_SMOKE_TOKEN, ORBIT_SMOKE_EMAIL/PASSWORD, or (for the local Compose deployment)
// ORBIT_SMOKE_OWNER_PUBLIC_ID. Workspace: ORBIT_SMOKE_WORKSPACE, otherwise a live `orbit`
// workspace is selected. Optional ORBIT_SMOKE_BASE defaults to http://127.0.0.1:2086.

import { randomUUID } from 'node:crypto';
import {
  assert,
  assertDeliveryLifecycle,
  assertFinalAnswer,
  assertOneTurnContainsBothMessages,
  chooseWorkspace,
  conciseEvents,
  publicIdToUuid,
  readCodexThread,
  smokeApi,
  waitForSettled,
  waitForTool,
} from './smoke-lib.mjs';

const { api } = await smokeApi();
const workspaceId = await chooseWorkspace(api);
const marker = randomUUID().slice(0, 8);
const initialMarker = `API_INITIAL_${marker}`;
const steerMarker = `API_STEER_${marker}`;
const initialPrompt =
  `Remember ${initialMarker}. Use the shell tool to run sleep 20 and wait for it to finish. ` +
  'While it runs, a follow-up may arrive. After the tool finishes, obey the newest follow-up in ' +
  'this same turn. If none arrives, answer exactly API_MISSED. Do not finish before the tool.';
const steerText = `Newest instruction ${steerMarker}: the final answer must be exactly API_STEER_APPLIED_${marker}.`;
const expectedAnswer = `API_STEER_APPLIED_${marker}`;

const created = await api('/sessions', {
  method: 'POST',
  body: JSON.stringify({
    title: `6R API idempotent steer ${marker}`,
    prompt: initialPrompt,
    workspaceId,
    provider: 'codex',
    permissionMode: 'dontAsk',
  }),
});
const sessionId = created.publicId || created.id;
const { event: toolEvent } = await waitForTool(api, sessionId);

// The duplicate models a retry after a successful HTTP response was lost. Same idempotency key,
// same durable Orbit turn, and — because Codex itself does not de-duplicate — exactly one engine
// item are all asserted below.
const clientTurnId = randomUUID();
const requestBody = JSON.stringify({ clientTurnId, content: steerText });
const first = await api(`/sessions/${sessionId}/turns`, { method: 'POST', body: requestBody });
const duplicate = await api(`/sessions/${sessionId}/turns`, { method: 'POST', body: requestBody });
const steerTurnId = first.turnId;
assert(first.kind === 'steer', `first response kind=${first.kind}, want steer`);
assert(duplicate.kind === 'steer', `duplicate response kind=${duplicate.kind}, want steer`);
assert(steerTurnId, `first response omitted turnId: ${JSON.stringify(first)}`);
assert(
  steerTurnId === duplicate.turnId,
  `duplicate request created two Orbit turns: ${steerTurnId} / ${duplicate.turnId}`,
);

const { detail, events } = await waitForSettled(api, sessionId);
assert(detail.status === 'AWAITING_INPUT', `session status=${detail.status}, want AWAITING_INPUT`);
assert(detail.numTurns === 1, `session numTurns=${detail.numTurns}, want 1`);
const delivery = assertDeliveryLifecycle(events, steerTurnId);
const thread = await readCodexThread(detail.runtimeSessionId);
const threadEvidence = assertOneTurnContainsBothMessages(
  thread,
  initialMarker,
  steerMarker,
  publicIdToUuid(steerTurnId),
);
assertFinalAnswer(thread, expectedAnswer);

console.log(
  'API_SMOKE_PASS=' +
    JSON.stringify({
      sessionId,
      initialOrbitTurnId: toolEvent.turnId,
      steerOrbitTurnId: steerTurnId,
      clientTurnId,
      firstKind: first.kind,
      duplicateKind: duplicate.kind,
      duplicateSameOrbitTurn: steerTurnId === duplicate.turnId,
      runtimeThreadId: detail.runtimeSessionId,
      codexTurnId: threadEvidence.codexTurnId,
      steerItemId: threadEvidence.steerItemId,
      steerClientId: threadEvidence.steerClientId,
      userMessageItemsInTurn: threadEvidence.userMessageItems,
      delivery,
      numTurns: detail.numTurns,
      status: detail.status,
      finalAnswer: expectedAnswer,
      events: conciseEvents(events, steerTurnId),
    }),
);
