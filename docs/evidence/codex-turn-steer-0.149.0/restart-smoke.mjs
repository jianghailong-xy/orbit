// Three-phase real Runner-crash smoke. The caller pauses the Codex child between `prepare` and
// `send`, then kills and restarts only the disposable smoke Runner between `send` and `verify`.
// That makes the runner die after the steer is leased but before Codex can acknowledge it,
// covering the deliberately ambiguous delivery path without touching a production Runner. The
// caller uses the temporary database's IN_FLIGHT row as the exact lease linearization point.

import { randomUUID } from 'node:crypto';
import {
  assert,
  chooseWorkspace,
  conciseEvents,
  deadline,
  eventDelivery,
  eventPayload,
  itemText,
  publicIdToUuid,
  readCodexThread,
  sessionEvents,
  sleep,
  smokeApi,
  waitForTool,
} from './smoke-lib.mjs';

const phase = process.argv[2];
assert(['prepare', 'send', 'verify'].includes(phase), 'usage: restart-smoke.mjs prepare|send|verify');
const { api } = await smokeApi();

if (phase === 'prepare') {
  const workspaceId = await chooseWorkspace(api);
  const marker = randomUUID().slice(0, 8);
  const initialMarker = `RESTART_INITIAL_${marker}`;
  const created = await api('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      title: `6R Runner restart steer ${marker}`,
      prompt:
        `Remember ${initialMarker}. Use the shell tool to run sleep 120 and wait for it. ` +
        'A follow-up may arrive while it runs. Do not finish before the tool.',
      workspaceId,
      provider: 'codex',
      permissionMode: 'dontAsk',
    }),
  });
  const sessionId = created.publicId || created.id;
  const { event } = await waitForTool(api, sessionId);
  console.log(
    'RESTART_PREPARED=' +
      JSON.stringify({
        sessionId,
        sessionUuid: publicIdToUuid(sessionId),
        initialOrbitTurnId: event.turnId,
        marker,
      }),
  );
  process.exit(0);
}

const sessionId = process.env.ORBIT_RESTART_SESSION;
const marker = process.env.ORBIT_RESTART_MARKER;
assert(sessionId && marker, 'set ORBIT_RESTART_SESSION and ORBIT_RESTART_MARKER');
const steerText = `RESTART_STEER_${marker}: record this exactly once.`;
const clientTurnId = process.env.ORBIT_RESTART_CLIENT_TURN || `6r-restart-${marker}`;

const relevantEvents = (events, turnId) =>
  events.filter((event) => event.turnId === turnId && ['user', 'user_delivery'].includes(event.type));

async function waitForState(turnId, wanted, maxMs = 120_000) {
  let events = [];
  for (const until = deadline(maxMs); Date.now() < until; ) {
    events = await sessionEvents(api, sessionId);
    if (relevantEvents(events, turnId).some((event) => eventDelivery(event) === wanted)) return events;
    await sleep(50);
  }
  throw new Error(
    `turn ${turnId} never reached ${wanted}: ${JSON.stringify(relevantEvents(events, turnId).map(eventDelivery))}`,
  );
}

if (phase === 'send') {
  const response = await api(`/sessions/${sessionId}/turns`, {
    method: 'POST',
    body: JSON.stringify({ clientTurnId, content: steerText }),
  });
  assert(response.kind === 'steer', `restart response kind=${response.kind}, want steer`);
  assert(response.turnId, `restart response omitted turnId: ${JSON.stringify(response)}`);
  console.log(
    'RESTART_ACCEPTED=' +
      JSON.stringify({
        sessionId,
        steerOrbitTurnId: response.turnId,
        steerTurnUuid: publicIdToUuid(response.turnId),
        clientTurnId,
        marker,
      }),
  );
  process.exit(0);
}

const steerTurnId = process.env.ORBIT_RESTART_STEER_TURN;
assert(steerTurnId, 'set ORBIT_RESTART_STEER_TURN for verify');
let events = await waitForState(steerTurnId, 'failed');
let relevant = relevantEvents(events, steerTurnId);
const states = relevant.map(eventDelivery).filter(Boolean);
const bubbles = relevant.filter((event) => event.type === 'user');
const failures = relevant.filter(
  (event) => event.type === 'user_delivery' && eventDelivery(event) === 'failed',
);
assert(!states.includes('acknowledged'), `an ambiguous steer was incorrectly acknowledged: ${JSON.stringify(states)}`);
assert(bubbles.length === 1, `restart produced ${bubbles.length} user bubbles, want one`);
assert(failures.length === 1, `restart produced ${failures.length} failure reports, want one`);
const reason = String(eventPayload(failures[0]).reason || '');
assert(reason.includes('whether the engine read it is unknown'), `unexpected restart reason: ${reason}`);

const queuedResponse = await api(`/sessions/${sessionId}/turns`);
const queued = Array.isArray(queuedResponse) ? queuedResponse : queuedResponse?.turns || queuedResponse?.items || [];
assert(
  !queued.some((turn) => (turn.publicId || turn.id || turn.turnId) === steerTurnId),
  'ambiguous steer was requeued and could be delivered twice',
);

const detail = await api(`/sessions/${sessionId}`);
let codexCopies = null;
if (detail.runtimeSessionId) {
  const thread = await readCodexThread(detail.runtimeSessionId);
  codexCopies = (thread.turns || [])
    .flatMap((turn) => turn.items || [])
    .filter((item) => item.type === 'userMessage' && itemText(item).includes(steerText)).length;
  assert(codexCopies <= 1, `restart wrote the same steer ${codexCopies} times into Codex`);
}

// An activation response may be retried. Give it time to do so and prove the same stranded row
// is not announced or settled twice.
await sleep(2_000);
events = await sessionEvents(api, sessionId);
relevant = relevantEvents(events, steerTurnId);
assert(
  relevant.filter((event) => event.type === 'user').length === 1,
  'a later activation retry duplicated the user bubble',
);
assert(
  relevant.filter((event) => event.type === 'user_delivery' && eventDelivery(event) === 'failed').length === 1,
  'a later activation retry duplicated the failure report',
);

console.log(
  'RESTART_SMOKE_PASS=' +
    JSON.stringify({
      sessionId,
      steerOrbitTurnId: steerTurnId,
      marker,
      delivery: relevant.map(eventDelivery).filter(Boolean),
      userBubbles: relevant.filter((event) => event.type === 'user').length,
      failureReports: relevant.filter(
        (event) => event.type === 'user_delivery' && eventDelivery(event) === 'failed',
      ).length,
      failureReason: reason,
      queuedCopies: queued.filter((turn) => (turn.publicId || turn.id || turn.turnId) === steerTurnId).length,
      codexCopies,
      sessionStatus: detail.status,
      numTurns: detail.numTurns,
      events: conciseEvents(events, steerTurnId),
    }),
);
