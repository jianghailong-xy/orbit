// Compare a performance.browser.mjs attachment with the P0.2 baseline table.
// Baseline values are the median/p95 the P0.2 README derives from
// p0.2/baseline-run/chromium-light-desktop--record-browser-performance-baseline--browser-performance-samples.json.
import { readFileSync } from 'node:fs';

const [file] = process.argv.slice(2);
const d = JSON.parse(readFileSync(file, 'utf8'));

const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  const med = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  const p95 = s[Math.ceil(0.95 * n) - 1];
  return { med: +med.toFixed(1), p95: +p95.toFixed(1), n };
};

const baseline = {
  task: { med: 422.8, p95: 438.6 },
  project: { med: 694.7, p95: 702.2 },
  session: { med: 374.6, p95: 376.3 },
  'composer-fill': { med: 45.4, p95: 49.7 },
  'attachment-menu-open': { med: 431.1, p95: 447.1 },
  'attachment-menu-close': { med: 348.9, p95: 350.6 },
};

const rows = [];
for (const [k, v] of Object.entries(d.loads)) rows.push([k, stats(v.samples.map((s) => s.browserReadyMs))]);
for (const [k, v] of Object.entries(d.operations)) rows.push([k, stats(v.samples.map((s) => s.browserMs))]);

console.log('project:', d.project, 'observedAt:', d.observedAt);
console.log('hostStart load:', JSON.stringify(d.hostStart?.loadAverage), 'freeMB:', (d.hostStart?.freeMemoryBytes / 1048576) | 0);
console.log('hostEnd   load:', JSON.stringify(d.hostEnd?.loadAverage), 'freeMB:', (d.hostEnd?.freeMemoryBytes / 1048576) | 0);
console.log('observation\tP0.2 med\tnow med\tdelta\tP0.2 p95\tnow p95\tdelta\tn');
for (const [k, s] of rows) {
  const b = baseline[k] ?? {};
  console.log([
    k,
    b.med ?? 'n/a', s.med, b.med ? (s.med - b.med > 0 ? '+' : '') + (s.med - b.med).toFixed(1) : '',
    b.p95 ?? 'n/a', s.p95, b.p95 ? (s.p95 - b.p95 > 0 ? '+' : '') + (s.p95 - b.p95).toFixed(1) : '',
    s.n,
  ].join('\t'));
}
// FCP / navigation sanity (P0.2 recorded 1 navigation + 2 paints per load)
for (const [k, v] of Object.entries(d.loads)) {
  const s = v.samples[0];
  const nav = (s.navigation ?? []).length;
  const paint = (s.paint ?? []).length;
  console.log(`load ${k}: navigation entries ${nav}, paint entries ${paint} (first sample)`);
}
