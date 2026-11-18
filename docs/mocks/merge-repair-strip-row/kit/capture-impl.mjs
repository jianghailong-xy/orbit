// The implementation's frames (no injection): the worktree as built.
import fs from 'node:fs';
import { launch, open, recovery, REPAIR, settle } from '/var/tmp/rpr-mock/lib.mjs';
const OUT = '/var/tmp/rpr-mock/impl'; fs.mkdirSync(OUT, { recursive: true });
const b = await launch();
const idle = { ...REPAIR, runState: 'AWAITING_INPUT', status: 'AWAITING_INPUT', lastTurnAt: '2026-09-28T11:58:00.000Z' };
const readyRec = recovery({ code: 'READY', checkedAt: '2026-09-28T11:59:30.000Z', candidateSha: 'd'.repeat(40), candidateTreeSha: 'e'.repeat(40), patch: 'diff', check: { status: 'unconfigured' } });
const conflictRec = recovery({ code: 'CONFLICT', phase: 'SOURCE_REPLAY', checkedAt: '2026-09-28T11:59:30.000Z', conflicts: ['src/apiserver/src/tasks/task-judgment-data-preserved.spec.ts', 'src/web/src/components/Transcript.tsx'] });
const shots = [
  ['01-running', {}, null],
  ['02-running-open', {}, (p) => p.click('.wt-repair-row .wt-expand')],
  ['03-ready', { over: { mergeRecovery: readyRec, mergeRepairSession: idle } }, null],
  ['04-conflict', { over: { mergeRecovery: conflictRec, mergeRepairSession: idle } }, null],
  ['05-checking', { over: { mergeRepairSession: idle, mergeStatus: 'pending', mergeRecoveryAction: 'preview' } }, null],
  ['06-phone', { size: 'phone' }, null],
  ['07-dark', { theme: 'dark' }, null],
];
try {
  for (const [name, opts, act] of shots) {
    const { page, context, errors } = await open(b, opts);
    if (act) { await act(page); await settle(page); }
    const info = await page.evaluate(() => ({ comp: Math.round(document.querySelector('.composer-box').getBoundingClientRect().top), vh: innerHeight,
      row: document.querySelector('.wt-repair-row')?.textContent, panel: !!document.querySelector('.wt-recovery') }));
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(name, JSON.stringify(info), errors.join(' | '));
    await context.close();
  }
} finally { await b.close(); }
