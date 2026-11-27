// The server's own payloads for the Background mark's paths that the Apple clients decode: for the 23 cases of the
// cross-client display check (the payload fixture's cases plus the board's cases it does not seed), each session's
// listRow, sessionSummary (`session.updated`), taskRun and searchHit (null for the settled landing, which search never
// answers), real rows read back through the tip's services (sessions/session-payloads.fixture.ts). `live` is one parked
// session as `session.updated` reports it while a background job is added and then cleared. `web` beside each payload is
// what web's own sessionDisplayState / sessionMarks / sessionRowIcons (src/web/src/lib/sessionDisplay.ts) answer for it. OrbitKit's
// BackgroundMarkPayloadTests reads the result, background-payloads.json.
//   DATABASE_URL=<throwaway, migrated> node make-background-payloads.cjs    (apiserver built: tsc -p tsconfig.test.json)
'use strict';
const path = require('node:path');
const fs = require('node:fs');

const repo = path.resolve(__dirname, '../../../..');
const api = path.join(repo, 'src/apiserver');
const fixture = require(path.join(api, 'build/sessions/session-payloads.fixture.js'));
const { RunStatus } = require(require.resolve('@prisma/client', { paths: [api] }));

const tomorrow = () => new Date(Date.now() + 24 * 3600_000);
const bg = (ids, jobs) => ({
  runningBgShells: ids,
  ...(jobs ? { runningBgJobs: ids, runningBgJobActivity: Object.fromEntries(ids.map((i) => [i, Date.now() - 30_000])) } : {}),
});
const approval = (db, _owner, sessionId) => db.approval.create({
  data: { sessionId, toolName: 'Bash', input: { command: 'rm -rf build' }, toolUseId: `toolu_${sessionId}` },
});

fixture.FIXTURE_CASES.push(
  { label: 'ended, runner never confirmed', status: RunStatus.FAILED, row: { endReason: 'ended', error: 'cancel not honored', lastTurnOutcome: 'FAILED' } },
  { label: 'old plain row stored SUCCEEDED', status: RunStatus.SUCCEEDED, row: { lastTurnOutcome: 'ANSWERED' } },
  { label: 'ending after an interrupted turn', status: RunStatus.INTERRUPTED, row: { endReason: 'ended', lastTurnOutcome: 'INTERRUPTED', cancelRequestedAt: tomorrow() } },
  { label: 'parked, engine started its own turn', status: RunStatus.AWAITING_INPUT, row: { lastTurnOutcome: 'ANSWERED', engineTurnActive: true } },
  { label: 'parked, sub-agent running', status: RunStatus.AWAITING_INPUT, row: { lastTurnOutcome: 'ANSWERED', runningSubagents: ['sub_walk'] } },
  { label: 'parked, background process left up', status: RunStatus.AWAITING_INPUT, row: { lastTurnOutcome: 'ANSWERED', ...bg(['sh_walk'], false) } },
  { label: 'parked, retry armed', status: RunStatus.AWAITING_INPUT, row: { lastTurnOutcome: 'ANSWERED', retryAt: tomorrow() } },
  { label: 'failed, retry armed', status: RunStatus.FAILED, row: { lastTurnOutcome: 'FAILED', error: 'provider overloaded', retryAt: tomorrow() } },
  { label: 'failed, runner offline', status: RunStatus.FAILED, row: { lastTurnOutcome: 'FAILED', error: 'runner offline' } },
  { label: 'approval beside a background job', status: RunStatus.RUNNING, row: bg(['bgj_walk2'], true), arm: approval },
  {
    label: 'interrupted, a process up, retry armed', status: RunStatus.INTERRUPTED,
    row: { lastTurnOutcome: 'INTERRUPTED', retryAt: tomorrow(), ...bg(['sh_walk3'], false) },
  },
);

/** Web's two display functions, bundled from the tip's source. */
async function webDisplay() {
  const { rolldown } = require(require.resolve('rolldown', { paths: [path.join(repo, 'src/web')] }));
  const bundle = await rolldown({ input: path.join(repo, 'src/web/src/lib/sessionDisplay.ts'), platform: 'node' });
  const { output } = await bundle.generate({ format: 'cjs' });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', output[0].code)(module, module.exports, require);
  return module.exports;
}

async function main() {
  const web = await webDisplay();
  const answer = (payload) => ({
    state: web.sessionDisplayState(payload).word,
    marks: web.sessionMarks(payload).map((m) => web.SESSION_MARKS[m].word),
    rowIcons: web.sessionRowIcons(payload),
  });
  const read = (payload) => (payload ? { payload, web: answer(payload) } : null);

  const stack = fixture.connect(process.env.DATABASE_URL);
  const world = await fixture.buildWorld(stack.db, 'background');
  const payloads = await fixture.readPayloads(stack, world);
  const cases = fixture.FIXTURE_CASES.map((c) => {
    const p = payloads.get(c.label);
    return {
      name: c.label, listRow: read(p.listRow), sessionSummary: read(p.sessionSummary), taskRun: read(p.taskRun),
      searchHit: read(p.searchHit),
    };
  });

  // The parked conversation, listed with nothing in the background, then a job added to its row, then cleared.
  const id = world.ids.get('AWAITING_INPUT');
  const step = async (name) => ({
    name,
    listRow: read((await stack.sessions.listRowsByIds(world.ownerId, [id]))[0]),
    sessionSummary: read(await stack.realtime.buildSessionSummary(id)),
  });
  const live = [await step('before')];
  await stack.db.session.update({ where: { id }, data: bg(['bgj_live'], true) });
  live.push(await step('job added'));
  await stack.db.session.update({ where: { id }, data: { runningBgShells: [], runningBgJobs: [], runningBgJobActivity: {} } });
  live.push(await step('job cleared'));

  const out = path.join(__dirname, 'background-payloads.json');
  fs.writeFileSync(out, JSON.stringify({ cases, live }, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 1) + '\n');
  console.log(`${cases.length} cases, ${live.length} live steps -> ${out}`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
