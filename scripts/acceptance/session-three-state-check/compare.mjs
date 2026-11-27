// node compare.mjs web.json apple.json android.json -> markdown table, one row per fixture row, with an "explained" column.
import { readFileSync } from 'node:fs';
const [w, a, d] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, 'utf8')));
const norm = { SEND: 'send', RESUME: 'resume', CREATE: 'create', BLOCK: 'block', turns: 'send', resume: 'resume' };
// Android signals a refused send by throwing the server's resumeBlockedReason: that is the block.
const n = (x) => (String(x).startsWith('ERR') ? 'block' : (norm[x] ?? x));
const explain = (flags, row, s) => {
  if (!flags.length) return '';
  const out = [];
  const f1 = flags.includes('SEND') && s[2] === 'turns' && s[0] === 'RESUME';
  if (f1) out.push('defect F1: Android posts /turns to a released session; the server answers SESSION_ENDED (sessions.service.ts:7882)');
  if (!row.newFields) {
    const rest = flags.filter((f) => !(f === 'SEND' && f1));
    if (rest.length) out.push(`accepted, older server only (F3, F4, F6): ${rest.join(',')}`);
  } else {
    if (flags.includes('WORD') && row.name.startsWith('unknown status')) out.push('defect F2, fix task filed');
    if (flags.includes('RUN')) out.push('defect: task-run label disagrees');
  }
  return out.join('; ') || 'UNEXPLAINED';
};
console.log('| case | fields | send: web / apple / android | wait over: web / apple / android | state word: web / apple / android | task-run label: web / apple / android | disagree on | explained |');
console.log('|---|---|---|---|---|---|---|---|');
for (let i = 0; i < w.length; i++) {
  const s = [w[i].send, a[i].send, d[i].send], o = [w[i].waitOver, a[i].waitOver, d[i].waitOver], t = [w[i].word, a[i].word, d[i].word], r = [w[i].run, a[i].run, d[i].run];
  const flags = [new Set(s.map(n)).size > 1 && 'SEND', new Set(o).size > 1 && 'WAIT', new Set(t).size > 1 && 'WORD', new Set(r).size > 1 && 'RUN'].filter(Boolean);
  console.log(`| ${w[i].name} | ${w[i].newFields ? 'new' : 'absent'} | ${s.join(' / ')} | ${o.join(' / ')} | ${t.join(' / ')} | ${r.join(' / ')} | ${flags.join(',') || '-'} | ${explain(flags, w[i], s)} |`);
}
