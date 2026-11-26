// Renders legacy-baseline.md from the three recorded client files (node make-legacy-baseline-md.mjs > legacy-baseline.md).
import { readFileSync } from 'node:fs';
const load = (c) => JSON.parse(readFileSync(new URL(`./legacy-baseline.${c}.json`, import.meta.url), 'utf8'));
const web = load('web'), apple = load('apple'), android = load('android');
const yn = (a, b) => `${a ? 'Needs you' : ''}${b ? 'Working' : ''}` || '-';
const out = [
  '# Legacy baseline: what each client draws with the session facts absent',
  '',
  'Recorded from the code before any display change, by `legacyBaseline.test.ts` (web), `LegacyBaselineTests.swift` (OrbitKit) and',
  '`LegacyBaselineTest.kt` (Android) over the 18 `newFields: false` rows of `fixture.json`. These tests compare against the',
  '`legacy-baseline.<client>.json` files. `endReason` stays on the rows that had one: an older server sent it, and the legacy reading uses it.',
  '',
  '| case | web icon / word | web run badge | Apple icon / word | Apple run badge | Android mark / word | Android run badge | group web / Apple / Android |',
  '|---|---|---|---|---|---|---|---|',
];
web.rows.forEach((w, i) => {
  const a = apple.rows[i], d = android.rows[i];
  out.push(`| ${w.name} | ${w.icon} / ${w.word} | ${w.runBadge} | ${a.icon} / ${a.word} | ${a.runBadge} | ${d.mark} / ${d.word} | ${d.runBadge} | ${yn(w.needsYouGroup, w.workingGroup)} / ${yn(a.needsYouGroup, a.workingGroup)} / ${yn(d.needsYouGroup, d.workingGroup)} |`);
});
out.push('', '## Tasks list pill (web `taskStatusLabel`; the task payload carries `queuedOnHold`)', '', '| task | word |', '|---|---|');
for (const p of web.tasksListPill) out.push(`| ${p.name} | ${p.word} |`);
console.log(out.join('\n'));
