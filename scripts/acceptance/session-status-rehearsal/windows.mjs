// The rehearsal's records, window by window (task T17): for each window, the lock waits the sampler saw
// (locks.jsonl), every load call's answer by the release that gave it (load-calls.jsonl), and what the writer loop
// wrote (writer-loop.jsonl's 10 s summaries: statements and rows changed).
//   node windows.mjs <out dir> <name>=<from ISO>..<to ISO> [...]
// "Waiters" counts distinct backends seen waiting; a wait is the waiter's statement time when sampled, so an upper
// bound. HTTP errors are every answer of 400 or more, and status 0 (no connection: a container being replaced).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...specs] = process.argv.slice(2);
const lines = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
  try { return [JSON.parse(l)]; } catch { return []; }
}) : []);
const locks = lines('locks.jsonl');
const calls = lines('load-calls.jsonl');
const writer = lines('writer-loop.jsonl').filter((l) => l.summary || l.final);

for (const spec of specs) {
  const [name, range] = spec.split('=');
  const [from, to] = range.split('..').map((x) => Date.parse(x));
  const inside = (t) => { const v = Date.parse(t); return v >= from && v < to; };
  console.log(`## ${name} (${new Date(from).toISOString()} .. ${new Date(to).toISOString()}, ${Math.round((to - from) / 1000)} s)`);

  const waiters = new Map(); // pid+query -> longest
  for (const s of locks.filter((x) => inside(x.t))) {
    for (const w of s.waits ?? []) {
      const k = `${w.pid}`;
      const prev = waiters.get(k);
      if (!prev || w.waitingMs > prev.waitingMs) waiters.set(k, { ...w, t: s.t });
    }
  }
  const top = [...waiters.values()].sort((a, b) => b.waitingMs - a.waitingMs);
  console.log(`locks: ${waiters.size} waiters${top.length ? '; longest:' : ''}`);
  for (const w of top.slice(0, 6)) {
    console.log(`  ${w.waitingMs} ms at ${w.t} [${w.app || '-'}] ${w.query} | waits for ${JSON.stringify(w.waitingFor)} | behind ${JSON.stringify((w.blockedBy ?? []).map((b) => `[${b.app || '-'}] ${b.state}: ${b.query}`))}`);
  }

  const by = new Map();
  for (const c of calls.filter((x) => inside(x.t))) {
    const k = c.side;
    const s = by.get(k) ?? { n: 0, errors: {}, maxMs: 0, lists: 0, list500: 0 };
    s.n++; s.maxMs = Math.max(s.maxMs, c.ms);
    if (c.op.startsWith('list')) { s.lists++; if (c.status >= 500) s.list500++; }
    if (c.status === 0 || c.status >= 400) {
      const e = `${c.op} ${c.status}`;
      s.errors[e] = (s.errors[e] ?? 0) + 1;
    }
    by.set(k, s);
  }
  for (const [side, s] of [...by.entries()].sort()) {
    console.log(`calls ${side}: ${s.n} (session lists ${s.lists}, of them 5xx ${s.list500}), errors ${JSON.stringify(s.errors)}, max ${s.maxMs} ms`);
  }
  if (!by.size) console.log('calls: none');
  const errs = calls.filter((x) => inside(x.t) && (x.status === 0 || x.status >= 400));
  for (const e of errs.slice(0, 12)) console.log(`  error ${e.t} ${e.target} (${e.side}) ${e.op} ${e.status} ${e.detail ?? ''}`.slice(0, 260));

  // The writer's summaries are cumulative: the window's work is the last one inside it minus the last one before it.
  const before = writer.filter((x) => Date.parse(x.t) < from).pop();
  const last = writer.filter((x) => Date.parse(x.t) < to).pop();
  if (last && last !== before) {
    const a = before?.summary ?? before?.final ?? {};
    const b = last.summary ?? last.final;
    const out = Object.entries(b).map(([op, v]) => {
      const p = a[op] ?? { n: 0, rows: 0, errors: 0 };
      return `${op} ${v.n - p.n} statements, ${v.rows - p.rows} rows, ${v.errors - p.errors} errors (max ${v.maxMs} ms so far)`;
    });
    console.log(`writer: ${out.join('; ')}`);
  } else console.log('writer: no summary in this window');
  console.log('');
}
