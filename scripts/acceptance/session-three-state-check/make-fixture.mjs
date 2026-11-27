// Builds fixture.json: session payloads as the project-tip server sends them, plus the same payloads with the new
// fields (phase, released, lastTurnOutcome, waitingOn, workFinished) absent, as an older server sends them.
import { writeFileSync } from 'node:fs';
const held = { canSend: true, canResume: false, resumeBlockedReason: 'NOT_TERMINAL', canComplete: true, canRestore: false };
const resumable = { canSend: true, canResume: true, resumeBlockedReason: null, canComplete: true, canRestore: false };
const ending = { canSend: false, canResume: false, resumeBlockedReason: 'ENDING', canComplete: false, canRestore: false };
const L = (s, rs, runState) => ({ id: 's', title: 't', status: s, runStatus: rs ?? s, runState, lifecycleState: 'OPEN' });
const cases = [
  // the seven statuses
  ['status PENDING (queued)', { ...L('PENDING', null, 'QUEUED'), queuedReason: null, phase: 'PENDING', released: false, lastTurnOutcome: null, waitingOn: null, workFinished: false, capabilities: held }],
  ['status RUNNING', { ...L('RUNNING', null, 'RUNNING'), phase: 'RUNNING', released: false, lastTurnOutcome: null, waitingOn: null, workFinished: false, capabilities: held }],
  ['status AWAITING_INPUT (held idle)', { ...L('AWAITING_INPUT', null, 'AWAITING_INPUT'), phase: 'IDLE', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: null, workFinished: false, capabilities: held }],
  ['status INTERRUPTED (held, stopped turn)', { ...L('INTERRUPTED', null, 'INTERRUPTED'), phase: 'IDLE', released: false, lastTurnOutcome: 'INTERRUPTED', waitingOn: null, workFinished: false, capabilities: held }],
  ['status SUCCEEDED (task run finished)', { ...L('SUCCEEDED', null, 'SUCCEEDED'), endReason: 'task_done', phase: 'IDLE', released: true, lastTurnOutcome: 'ANSWERED', waitingOn: null, workFinished: true, capabilities: resumable }],
  ['status FAILED (released by a failed turn)', { ...L('FAILED', null, 'FAILED'), phase: 'IDLE', released: true, lastTurnOutcome: 'FAILED', waitingOn: null, workFinished: false, capabilities: resumable }],
  ['status CANCELLED (released by End)', { ...L('CANCELLED', null, 'ENDED'), endReason: 'ended', phase: 'IDLE', released: true, lastTurnOutcome: 'ANSWERED', waitingOn: null, workFinished: false, capabilities: resumable }],
  // the named situations
  ['running a job with no turn', { ...L('AWAITING_INPUT', null, 'AWAITING_INPUT'), activity: 'BACKGROUND_JOB', runningBgCount: 1, runningBgJobCount: 1, phase: 'RUNNING', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: null, workFinished: false, capabilities: held }],
  ['waiting on an approval', { ...L('RUNNING', null, 'RUNNING'), pendingApprovals: 1, phase: 'RUNNING', released: false, lastTurnOutcome: null, waitingOn: 'PERSON', workFinished: false, capabilities: held }],
  ['on hold (queued, account paused)', { ...L('PENDING', null, 'QUEUED'), error: 'Account paused until 2099-01-01', queuedReason: null, phase: 'PENDING', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: 'HOLD', workFinished: false, capabilities: held }],
  ['ended, runner never confirmed', { ...L('FAILED', null, 'FAILED'), endReason: 'ended', error: 'cancel not honored', phase: 'IDLE', released: true, lastTurnOutcome: 'FAILED', waitingOn: null, workFinished: false, capabilities: resumable }],
  ['old plain row stored SUCCEEDED', { ...L('SUCCEEDED', null, 'SUCCEEDED'), phase: 'IDLE', released: true, lastTurnOutcome: 'ANSWERED', waitingOn: null, workFinished: false, capabilities: resumable }],
  ['ending after an interrupted turn', { ...L('INTERRUPTED', null, 'ENDED'), endReason: 'ended', phase: 'IDLE', released: false, lastTurnOutcome: 'INTERRUPTED', waitingOn: null, workFinished: false, capabilities: ending }],
  // activity as sessionActivitySql sends it: TURN for a parked session the engine's own turn or a sub-agent keeps busy, WAITING for a wake source
  ['parked, engine started its own turn', { ...L('AWAITING_INPUT', null, 'AWAITING_INPUT'), activity: 'TURN', phase: 'RUNNING', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: null, workFinished: false, capabilities: held }],
  ['parked, sub-agent running', { ...L('AWAITING_INPUT', null, 'AWAITING_INPUT'), activity: 'TURN', runningSubagentCount: 1, phase: 'RUNNING', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: null, workFinished: false, capabilities: held }],
  ['parked, will wake (watch or wake-up)', { ...L('AWAITING_INPUT', null, 'AWAITING_INPUT'), activity: 'WAITING', phase: 'IDLE', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: 'WAKE', workFinished: false, capabilities: held }],
  // the coordinator's note of 2026-11-19: a status word no client knows, and no capabilities
  ['unknown status, no capabilities, held', { id: 's', title: 't', status: 'HIBERNATING', lifecycleState: 'OPEN', phase: 'IDLE', released: false, lastTurnOutcome: null, waitingOn: null, workFinished: false }],
  ['unknown status, no capabilities, released', { id: 's', title: 't', status: 'HIBERNATING', lifecycleState: 'OPEN', phase: 'IDLE', released: true, lastTurnOutcome: 'ANSWERED', waitingOn: null, workFinished: false }],
];
// Every row carries `activity` as the server sends it (sessionActivitySql): TURN on every stored PENDING or RUNNING row.
for (const [, p] of cases) if (!('activity' in p)) p.activity = ['PENDING', 'RUNNING'].includes(p.status) ? 'TURN' : null;
const strip = (p) => { const { phase, released, lastTurnOutcome, waitingOn, workFinished, ...rest } = p; return rest; };
const out = [];
for (const [name, payload] of cases) {
  out.push({ name, newFields: true, payload });
  out.push({ name, newFields: false, payload: strip(payload) });
}
writeFileSync(new URL('./fixture.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(out.length, 'rows');
