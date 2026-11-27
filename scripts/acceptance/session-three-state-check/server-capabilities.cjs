// node server-capabilities.cjs <apiserver build dir> fixture.json
// Replaces every payload's hand-written `capabilities` with what the server's own withSessionCapabilities builds for a
// stored row of that shape (a released row has finishedAt set; a started, resumable one with an online runner).
const fs = require('node:fs');
const path = require('node:path');
const { withSessionCapabilities } = require(path.resolve(process.argv[2], 'sessions/session-state.js'));
const file = process.argv[3];
const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
const now = Date.now();
for (const r of rows) {
  const p = r.payload;
  if (!('capabilities' in p)) continue; // the two unknown-status rows carry none, as sent by a server that does not know the status
  const released = r.newFields ? p.released : ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(p.status);
  const ending = p.endReason === 'ended' && p.status === 'INTERRUPTED' && !released;
  const row = {
    status: p.status, endReason: p.endReason ?? null, completedAt: null, deletedAt: null,
    finishedAt: released ? new Date(now - 1000) : null, cancelRequestedAt: ending ? new Date(now - 500) : null,
    startedAt: new Date(now - 60000), numTurns: 1, runtimeSessionId: 'rt', assignedRunnerId: 'runner',
    assignedRunner: { id: 'runner', status: 'ONLINE', lastHeartbeatAt: new Date(now) },
  };
  const c = withSessionCapabilities(row, now).capabilities;
  p.capabilities = { canSend: c.canSend, canResume: c.canResume, resumeBlockedReason: c.resumeBlockedReason, canComplete: c.canComplete, canRestore: c.canRestore };
}
fs.writeFileSync(file, JSON.stringify(rows, null, 1) + '\n');
