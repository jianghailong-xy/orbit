// Drives a real `codex app-server` over stdio and records what turn/steer actually does.
// This is the evidence behind docs/codex-turn-steer-contract.md — every claim in that file
// that is marked 实测 came out of a run of this script.
//
//   node docs/evidence/codex-turn-steer-0.149.0/probe.mjs           # cheap cases, no model calls
//   node docs/evidence/codex-turn-steer-0.149.0/probe.mjs --live    # also the mid-turn cases (needs codex login)
//   CODEX_BIN=/path/to/codex node .../probe.mjs                     # probe another codex version
//
// The live cases spend real tokens and take a few minutes: they start turns that shell out to
// `sleep` so there is a long tool call to steer into.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CODEX = process.env.CODEX_BIN || 'codex';
const LIVE = process.argv.includes('--live');

const stateDir = mkdtempSync(join(tmpdir(), 'cx-steer-state-'));
const workDir = mkdtempSync(join(tmpdir(), 'cx-steer-work-'));
const proc = spawn(CODEX, ['app-server', '--stdio', '-c', `sqlite_home="${stateDir}"`], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

const t0 = Date.now();
const at = () => String(Date.now() - t0).padStart(6);
const waiters = new Map();
const echoes = [];
let completed = null;
let buf = '';

proc.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const w = waiters.get(String(msg.id));
      if (w) {
        waiters.delete(String(msg.id));
        w(msg);
      }
      continue;
    }
    if (msg.method === 'turn/completed') {
      completed = msg.params?.turn ?? null;
      console.log(at(), 'turn/completed status=' + completed?.status);
    } else if (msg.method === 'item/completed' && msg.params?.item?.type === 'userMessage') {
      echoes.push(msg.params.item.clientId);
      console.log(at(), 'item/completed userMessage clientId=' + msg.params.item.clientId);
    } else if (msg.method === 'item/completed' && msg.params?.item?.type === 'agentMessage') {
      console.log(at(), 'item/completed agentMessage ' + JSON.stringify((msg.params.item.text || '').slice(0, 60)));
    }
  }
});
proc.stderr.on('data', () => {});

let nextId = 0;
const req = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    waiters.set(String(id), resolve);
    proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
const notify = (method, params) => proc.stdin.write(JSON.stringify({ method, params }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outcome = (m) => (m.error ? 'ERROR ' + JSON.stringify(m.error) : 'OK ' + JSON.stringify(m.result).slice(0, 200));

const init = await req('initialize', {
  clientInfo: { name: 'orbit-probe', title: 'Orbit Probe', version: '0.1.0' },
  capabilities: { experimentalApi: true },
});
console.log('userAgent:', init.result?.userAgent);
notify('initialized', {});

const thread = await req('thread/start', {
  cwd: workDir,
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
  threadSource: 'orbit-probe',
});
const threadId = thread.result?.thread?.id;
console.log('threadId:', threadId);

const DEAD_TURN = '01a02538-0000-7000-8000-000000000000';

// --- cheap cases: every rejection Orbit has to classify, none of them reach the model ---
console.log('\n## rejections');
console.log('R1 no active turn      :', outcome(await req('turn/steer', {
  threadId, expectedTurnId: DEAD_TURN, input: [{ type: 'text', text: 'hi' }], clientUserMessageId: 'R1',
})));
console.log('R2 missing field       :', outcome(await req('turn/steer', {
  threadId, input: [{ type: 'text', text: 'hi' }],
})));
console.log('R3 bad thread id       :', outcome(await req('turn/steer', {
  threadId: 'thr_nope', expectedTurnId: DEAD_TURN, input: [{ type: 'text', text: 'hi' }],
})));
console.log('R4 unknown method      :', outcome(await req('turn/steerX', { threadId })));
console.log('R5 unknown params field:', outcome(await req('turn/steer', {
  threadId, expectedTurnId: DEAD_TURN, input: [{ type: 'text', text: 'hi' }], bogusUnknownField: 1,
})));

if (!LIVE) {
  console.log('\n(skipping the mid-turn cases; pass --live to run them)');
  proc.stdin.end();
  proc.kill();
  process.exit(0);
}

const startTurn = async (clientId, text) => {
  echoes.length = 0;
  completed = null;
  const started = await req('turn/start', {
    threadId,
    clientUserMessageId: clientId,
    input: [{ type: 'text', text }],
    cwd: workDir,
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
  });
  return started.result?.turn?.id;
};
const awaitCompletion = async (maxMs = 180000) => {
  for (let waited = 0; waited < maxMs && !completed; waited += 500) await sleep(500);
  await sleep(1500);
};

// --- A: steer lands in the running turn, produces no second turn ---
console.log('\n## A: steer into a long tool call');
let turnId = await startTurn('A-start', 'Run the shell command `sleep 40` and wait for it to finish. Then reply with exactly the word ALPHA and stop.');
console.log(at(), 'turn/start ->', turnId);
await sleep(6000);
console.log(at(), 'A1 wrong expectedTurnId :', outcome(await req('turn/steer', {
  threadId, expectedTurnId: DEAD_TURN, input: [{ type: 'text', text: 'no' }], clientUserMessageId: 'A1',
})));
const acceptedAt = Date.now();
console.log(at(), 'A2 correct              :', outcome(await req('turn/steer', {
  threadId, expectedTurnId: turnId, input: [{ type: 'text', text: 'Also reply with the word BRAVO on its own line.' }], clientUserMessageId: 'A2',
})));
await sleep(1500);
console.log(at(), 'A3 SAME clientUserMessageId again:', outcome(await req('turn/steer', {
  threadId, expectedTurnId: turnId, input: [{ type: 'text', text: 'Also reply with the word BRAVO on its own line.' }], clientUserMessageId: 'A2',
})));
await sleep(1500);
console.log(at(), 'A4 with a `model` override:', outcome(await req('turn/steer', {
  threadId, expectedTurnId: turnId, input: [{ type: 'text', text: 'x' }], model: 'gpt-5.6', clientUserMessageId: 'A4',
})));
await awaitCompletion();
const echoLagMs = null; // printed inline above; see transcript.md for the measured gap
console.log('A: echoes =', JSON.stringify(echoes), 'turnStatus =', completed?.status, 'echoLag(see timestamps)', echoLagMs);
console.log(at(), 'A5 steer after the turn ended:', outcome(await req('turn/steer', {
  threadId, expectedTurnId: turnId, input: [{ type: 'text', text: 'late' }], clientUserMessageId: 'A5',
})));
const readA = await req('thread/read', { threadId, includeTurns: true });
for (const t of readA.result?.thread?.turns ?? []) {
  console.log(' turn', t.id, t.status, (t.items || []).map((i) => i.type + (i.clientId ? `(${i.clientId})` : '')).join(' | '));
}
void acceptedAt;

// --- B: interrupt while a steer is still buffered ---
console.log('\n## B: interrupt with a buffered steer');
turnId = await startTurn('B-start', 'Run `sleep 25` in the shell, wait, then reply with the word ALPHA.');
console.log(at(), 'immediate steer (0ms after turn/start):', outcome(await req('turn/steer', {
  threadId, expectedTurnId: turnId, input: [{ type: 'text', text: 'Also reply with CHARLIE.' }], clientUserMessageId: 'B-steer',
})));
await sleep(8000);
console.log(at(), 'turn/interrupt          :', outcome(await req('turn/interrupt', { threadId, turnId })));
console.log(at(), 'steer right after it    :', outcome(await req('turn/steer', {
  threadId, expectedTurnId: turnId, input: [{ type: 'text', text: 'post-interrupt' }], clientUserMessageId: 'B-post',
})));
await awaitCompletion(20000);
console.log('B: echoes =', JSON.stringify(echoes), 'turnStatus =', completed?.status);

// --- C: steering a turn that is about to finish on its own ---
console.log('\n## C: racing the end of a short turn');
for (const delay of [0, 1200, 2500, 4000]) {
  turnId = await startTurn('C' + delay, 'Reply with exactly the word OK and nothing else.');
  await sleep(delay);
  const r = await req('turn/steer', {
    threadId, expectedTurnId: turnId, input: [{ type: 'text', text: 'Also say ZULU.' }], clientUserMessageId: 'C' + delay + '-steer',
  });
  await awaitCompletion(40000);
  console.log(`C delay=${delay}ms steer=${r.error ? 'REJECTED ' + r.error.message : 'ACCEPTED'}` +
    ` echoed=${echoes.includes('C' + delay + '-steer')} turnStatus=${completed?.status}`);
  await sleep(500);
}

proc.stdin.end();
proc.kill();
process.exit(0);
