// Mutation check for task F (wakeups on a drained turn): each mutant edits the COMPILED build/ tree (never the
// source), runs wake-turn-drain.pg.spec on the long-lived dev PG (and the wiring unit spec), records which cases
// killed it, then restores every file byte for byte.
// Usage (from src/apiserver, after devpg.sh up and devpg.sh build): node /mnt/data/tmp/34pj6T76/mutants.mjs
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const WW = 'build/runner-api/wake-turn-withdraw.js';
const RP = 'build/realtime/reaper.service.js';
const RA = 'build/runner-api/runner-api.controller.js';
const SS = 'build/sessions/sessions.service.js';
const SETTLE = '(0, wake_turn_withdraw_1.settleUnrunWakeTurns)(tx, sessionId, { drained: true });';
const NOT_FAILED = "    if (standing !== 'FAILED')\n        return [];\n    return once.map(";
const COPY = '            await tx.sessionScheduledWakeup.create({\n                data: {\n                    sessionId,';

const mutants = [
  ['M1 the reap drains without settling', [[RP, `const droppedWakeups = await ${SETTLE}`, 'const droppedWakeups = [];']]],
  ['M2 a failed turn drains without settling', [[RA, `                droppedWakeups = await ${SETTLE}`, '                droppedWakeups = [];']]],
  ['M3 the runner\'s finalize drains without settling', [[RA, `const droppedWakeups = await ${SETTLE}`, 'const droppedWakeups = [];']]],
  ['M4 the owner\'s End of a queued session drains without settling', [[SS, `loop's runs (runner-api/wake-turn-withdraw.ts).\n                await ${SETTLE}`, "loop's runs (runner-api/wake-turn-withdraw.ts).\n                ;"]]],
  ['M5 the owner\'s End of a running session retires without settling', [[SS, `// (runner-api/wake-turn-withdraw.ts).\n                await ${SETTLE}`, '// (runner-api/wake-turn-withdraw.ts).\n                ;']]],
  ['M6 a turn handed to the engine is settled as unrun too', [[WW, "{ status: 'PENDING' }),", "{ status: { in: ['PENDING', 'IN_FLIGHT'] } }),"]]],
  ['M7 the counts are never corrected', [[WW, '    await uncountUnrunTicks(tx, filed);', '    ;']]],
  ['M8 one run fewer per tick, not per turn', [[WW, 'const runs = turnsOfLoop.get(loopId).size;', 'const runs = filed.filter((wakeup) => wakeup.loopId === loopId).length;']]],
  ['M9 only a drain corrects the counts', [[WW, '    await uncountUnrunTicks(tx, filed);', "    if ('drained' in unrun) await uncountUnrunTicks(tx, filed);"]]],
  ['M10 a drained tick is CANCELLED, not DROPPED', [[WW, "data: { state: 'DROPPED', settledAt },\n        });\n    }\n    const once", "data: { state: 'CANCELLED', settledAt },\n        });\n    }\n    const once"]]],
  ['M11 a one-shot of a recovering session is dropped', [[WW, "if (standing === 'FAILED_RECOVERING') {", 'if (false) {']]],
  ['M12 the drained row itself goes back to PENDING (no copy)', [[WW, COPY, "            await tx.sessionScheduledWakeup.update({ where: { id: newest.id }, data: { state: 'PENDING', clientTurnId: null, settledAt: null } });\n            if (false) await tx.sessionScheduledWakeup.create({\n                data: {\n                    sessionId,"]]],
  ['M13 the copy forgets when it was asked for', [[WW, '                    createdAt: newest.createdAt,\n', '']]],
  ['M14 a copy is made though a newer one waits', [[WW, '        if (!waiting) {', '        if (true) {']]],
  ['M15 a drop with a FAILED session is not told', [[WW, NOT_FAILED, "    if (true)\n        return [];\n    return once.map("]]],
  ['M16 a drop with an ended session is told too', [[WW, NOT_FAILED, "    if (standing === 'LIVE')\n        return [];\n    return once.map("]]],
  ['M17 the reaper does not push', [[RP, '(0, wake_turn_withdraw_1.signalDrainedWakeups)(this.push, this.log, outcome.droppedWakeups ?? []);', ';']]],
  ['M18 a failed turn does not push', [[RA, '(0, wake_turn_withdraw_1.signalDrainedWakeups)(this.push, this.logger, finalized.droppedWakeups ?? []);', ';']]],
  ['M19 the runner\'s finalize does not push', [[RA, '(0, wake_turn_withdraw_1.signalDrainedWakeups)(this.push, this.logger, outcome.droppedWakeups ?? []);', ';']]],
  ['M20 a drop is pushed twice', [[WW, '    for (const wakeup of dropped) {', '    for (const wakeup of [...dropped, ...dropped]) {']]],
  ['M21 a job\'s wake on a drained turn is kept', [[WW, '    await tx.backgroundJobWake.deleteMany({ where: { sessionId, clientTurnId } });', '    ;']]],
  ['M22 the reaper drops the PushService it is given', [[RP, '        this.push = push;\n', '']]],
];

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const files = [WW, RP, RA, SS];
const before = new Map(files.map((file) => [file, sha(file)]));
const results = [];
for (const [label, edits] of mutants) {
  const originals = new Map();
  let applied = true;
  for (const [file, from] of edits) {
    const source = originals.get(file) ?? readFileSync(file, 'utf8');
    originals.set(file, source);
    const count = source.split(from).length - 1;
    if (count !== 1) {
      results.push(`${label}: NOT APPLIED (found ${count} times in ${file}: ${JSON.stringify(from.slice(0, 80))})`);
      applied = false;
    }
  }
  if (!applied) continue;
  try {
    const current = new Map(originals);
    for (const [file, from, to] of edits) current.set(file, current.get(file).replace(from, to));
    for (const [file, text] of current) writeFileSync(file, text);
    const pg = spawnSync('bash', ['/mnt/data/tmp/34pj6T76/devpg.sh', 'run', 'src/apiserver/src/runner-api/wake-turn-drain.pg.spec.ts'], {
      encoding: 'utf8', timeout: 600_000,
    });
    const unit = spawnSync('node', ['--test', '--test-reporter=spec', 'build/realtime/reaper-push-wiring.spec.js'], { encoding: 'utf8', timeout: 120_000 });
    const failed = [...new Set([...`${pg.stdout}\n${unit.stdout}`.matchAll(/^\s*✖ (.+?) \(\d[\d.]*ms\)$/gm)].map((m) => m[1]))]
      .filter((name) => !name.startsWith('a wakeup filed onto a queued turn that its session'));
    const killed = (pg.status !== 0 || unit.status !== 0) && failed.length > 0;
    results.push(`${label}: ${killed ? `KILLED by\n    ${failed.join('\n    ')}` : `SURVIVED (pg exit ${pg.status}, unit exit ${unit.status})`}`);
  } finally {
    for (const [file, text] of originals) writeFileSync(file, text);
  }
}
const restored = files.every((file) => sha(file) === before.get(file));
results.push(`compiled files restored byte for byte: ${restored}`);
console.log(results.join('\n'));
