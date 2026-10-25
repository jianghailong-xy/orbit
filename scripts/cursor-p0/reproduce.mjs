#!/usr/bin/env node
// P0a: black-box experiments against the pinned real Cursor CLI in ACP mode (Linux).
//   node scripts/cursor-p0/reproduce.mjs                 every scenario (spends real prompts, see README)
//   node scripts/cursor-p0/reproduce.mjs --only a,b      a subset; other scenario results are kept
//   node scripts/cursor-p0/reproduce.mjs --zero          only the scenarios that send no prompt
//   node scripts/cursor-p0/reproduce.mjs --list          names, and the real prompts each one spends
// Exit code is non-zero when a selected scenario fails, a guard trips, or the CLI is not the pinned build.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { release, cpus } from 'node:os';
import { ScenarioContext, realCursorState } from './lib/harness.mjs';
import { writeProtocol } from './lib/record.mjs';
import { VERSION, PINNED_VERSION, TARBALL_SHA256, ACTIVE_TARBALL_SHA256, AGENT, P0_ROOT, readApiKey, promptsSpent, PROMPT_CAP, LEDGER, LEDGER_NAME, LEDGERS } from './lib/env.mjs';
import { zeroA } from './scenarios/zero-a.mjs';
import { zeroB } from './scenarios/zero-b.mjs';
import { real } from './scenarios/real.mjs';
import { macos } from './scenarios/macos.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
// --selftest: the prompt scenarios against selftest-fake-agent.mjs, into scratch directories only.
const selftest = args.includes('--selftest');
if (selftest) process.env.CURSOR_P0_SELFTEST = '1';
// Each ledger's runs have directories of their own, so a later task never overwrites an earlier one's
// recordings (P0a's sit at the top level). Recordings of a build other than the pinned one are for
// comparison only, not replay material: their fixtures stay in scratch.
const defaultOut = LEDGER_NAME === 'p0a' ? join(repoRoot, 'docs', 'evidence', 'cursor-cli', VERSION) : join(repoRoot, 'docs', 'evidence', 'cursor-cli', VERSION, LEDGER_NAME);
const defaultFixtures = VERSION !== PINNED_VERSION ? join(P0_ROOT, 'fixtures', VERSION, LEDGER_NAME)
  : LEDGER_NAME === 'p0a' ? join(repoRoot, 'src', 'runner-go', 'testdata', 'cursor') : join(repoRoot, 'src', 'runner-go', 'testdata', 'cursor', LEDGER_NAME);
const out = opt('--out') ?? (selftest ? join(P0_ROOT, 'selftest', 'evidence') : defaultOut);
const fixturesDir = opt('--fixtures') ?? (selftest ? join(P0_ROOT, 'selftest', 'fixtures') : defaultFixtures);
const all = [...zeroA, ...zeroB, ...real, ...(process.platform === 'darwin' ? macos : [])];

if (args.includes('--list')) {
  for (const s of all) console.log(`${s.name.padEnd(44)} real prompts: ${s.real}`);
  console.log(`total real prompts for a full run: ${all.reduce((a, s) => a + s.real, 0)}`);
  process.exit(0);
}
const only = opt('--only')?.split(',').map(s => s.trim()).filter(Boolean);
// --summary-only: rebuild summary.json, manifest.json and the fixture index from what is on disk.
const summaryOnly = args.includes('--summary-only');
const selected = summaryOnly ? [] : all.filter(s => (only ? only.includes(s.name) : args.includes('--zero') ? s.real === 0 : selftest ? s.real > 0 : true));
if (only) for (const n of only) if (!all.some(s => s.name === n)) { console.error(`unknown scenario: ${n}`); process.exit(2); }
const validPlatforms = [['linux', 'x64'], ['darwin', 'arm64']];
if (!validPlatforms.some(([os, arch]) => process.platform === os && process.arch === arch)) { console.error('P0 covers linux/x64 and darwin/arm64 only'); process.exit(2); }

const version = spawnSync(AGENT, ['--version'], { env: { PATH: '/usr/bin:/bin', HOME: join(P0_ROOT, 'version-home') }, encoding: 'utf8' });
if (version.status !== 0 || version.stdout.trim() !== VERSION) { console.error(`not the pinned CLI: ${version.stdout || version.error}`); process.exit(2); }
const key = selftest ? null : readApiKey();
// --no-key-ok: run only the scenarios that never need the key (needsKey === false). Selected scenarios
// that need the key are skipped and reported, and the exit code stays non-zero for them.
const noKeyOk = args.includes('--no-key-ok');
const skippedNoKey = [];
if (!key && !noKeyOk && !selftest) { console.error('no Cursor API key at the configured key file; ask the owner to place it'); process.exit(2); }
const selectedToRun = !key && !selftest ? selected.filter(s => {
  const needs = s.needsKey !== false;
  if (needs) skippedNoKey.push(s.name);
  return !needs;
}) : selected;
const needed = selected.reduce((a, s) => a + s.real, 0);
const spent = promptsSpent().length;
if (!selftest && spent + needed > PROMPT_CAP) { console.error(`this selection needs ${needed} real prompts but only ${PROMPT_CAP - spent} of ${PROMPT_CAP} remain in ledger ${LEDGER_NAME}`); process.exit(2); }
if (!selftest && needed > 0 && VERSION !== PINNED_VERSION) { console.error(`real prompts go to the pinned build ${PINNED_VERSION} only, not ${VERSION}; use --zero`); process.exit(2); }
// An evidence directory belongs to one ledger (P0a's prompts-ledger.json predates the field).
const ledgerFile = join(out, 'prompts-ledger.json');
const ownerLedger = existsSync(ledgerFile) ? (JSON.parse(readFileSync(ledgerFile, 'utf8')).ledger ?? 'p0a') : null;
if (!selftest && ownerLedger && ownerLedger !== LEDGER_NAME) { console.error(`${relative(repoRoot, out)} holds ledger ${ownerLedger}'s runs; this run charges ${LEDGER_NAME} (set CURSOR_P0_LEDGER or --out)`); process.exit(2); }

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runRoot = join(P0_ROOT, 'runs', runId);
mkdirSync(join(out, 'scenarios'), { recursive: true });
mkdirSync(join(out, 'protocol'), { recursive: true });
mkdirSync(fixturesDir, { recursive: true });
const before = realCursorState();
const shared = {};
let failed = 0;
for (const s of selectedToRun) {
  const ctx = new ScenarioContext({ name: s.name, runId, runRoot, fixturesDir, key, shared });
  const startedAt = new Date().toISOString();
  process.stdout.write(`${s.name} … `);
  try {
    await s.run(ctx);
  } catch (e) {
    ctx.check('scenario ran to completion', false, String(e?.stack ?? e).split('\n').slice(0, 4).join(' | '));
  } finally {
    await ctx.dispose();
  }
  const stateAfter = realCursorState();
  ctx.check('the runner user\'s real ~/.cursor, ~/.config/cursor and ~/.local/share/cursor-agent are untouched', JSON.stringify(stateAfter) === JSON.stringify(before));
  const passed = ctx.checks.length > 0 && ctx.checks.every(c => c.ok);
  if (!passed) failed++;
  const protocolFile = join(out, 'protocol', `${s.name}.ndjson`);
  writeFileSync(protocolFile, '');
  const lines = writeProtocol(protocolFile, s.name, ctx.rec, ctx.red);
  const result = { name: s.name, runId, startedAt, finishedAt: new Date().toISOString(), passed, realPromptsDeclared: s.real, realPrompts: ctx.realPrompts,
    protocol: relative(out, protocolFile), protocolLines: lines, fixtures: ctx.fixtures, checks: ctx.checks, detail: ctx.detail };
  writeFileSync(join(out, 'scenarios', `${s.name}.json`), JSON.stringify(result, null, 1) + '\n');
  console.log(`${passed ? 'PASS' : 'FAIL'} (${ctx.checks.filter(c => c.ok).length}/${ctx.checks.length} checks${ctx.realPrompts.length ? `, ${ctx.realPrompts.length} ${selftest ? 'self-test (fake) prompts' : 'real prompts'}` : ''})`);
  for (const c of ctx.checks.filter(c => !c.ok)) console.log(`   ✗ ${c.name}${c.detail === undefined ? '' : ' — ' + JSON.stringify(c.detail).slice(0, 300)}`);
}

// The summary covers every scenario result in the evidence directory, not only this run's.
const results = readdirSync(join(out, 'scenarios')).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(readFileSync(join(out, 'scenarios', f), 'utf8')));
const ledger = promptsSpent().map(e => ({ n: e.n, at: e.at, scenario: e.scenario, runId: e.runId, note: e.note, ...(e.version ? { version: e.version } : {}) }));
// The ledger's copy goes with the results that spent from it; a directory of zero-prompt runs gets none.
if (results.some(r => r.realPrompts.length > 0)) writeFileSync(ledgerFile, JSON.stringify({ ledger: LEDGER_NAME, task: LEDGERS[LEDGER_NAME].task, cap: PROMPT_CAP, spent: ledger.length, model: 'Auto (default[])', entries: ledger }, null, 1) + '\n');
const summary = {
  cli: { version: VERSION, pinned: VERSION === PINNED_VERSION, tarballSha256: ACTIVE_TARBALL_SHA256, launcherSha256: sha(join(dirname(AGENT), 'cursor-agent')), indexJsSha256: sha(join(dirname(AGENT), 'index.js')) },
  platform: { os: process.platform, arch: process.arch, kernel: release(), cpus: cpus().length, harnessNode: process.version },
  orbitCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim(),
  lastRunId: runId,
  ledger: LEDGER_NAME,
  realPromptsSpent: ledger.length,
  realPromptCap: PROMPT_CAP,
  skippedNoKey,
  realPromptsInTheseResults: results.reduce((a, r) => a + r.realPrompts.length, 0),
  realCursorDirsBefore: before,
  realCursorDirsAfter: realCursorState(),
  scenarios: results.map(r => {
    const a = existsSync(join(out, 'analysis', `${r.name}.json`)) ? JSON.parse(readFileSync(join(out, 'analysis', `${r.name}.json`), 'utf8')) : null;
    return { name: r.name, current: all.some(s => s.name === r.name), passed: r.passed, runId: r.runId, finishedAt: r.finishedAt, checks: r.checks.length,
      failedChecks: r.checks.filter(c => !c.ok).map(c => c.name), realPrompts: r.realPrompts.length,
      ...(a && a.runId === r.runId ? { postHocAnalysis: { file: `analysis/${r.name}.json`, reason: a.reason, correctedChecks: a.checks.length, hold: a.checks.filter(c => c.ok).length } } : {}) };
  }),
  allPassed: results.every(r => r.passed),
  allPassedOrExplained: results.every(r => {
    if (r.passed) return true;
    const f = join(out, 'analysis', `${r.name}.json`);
    if (!existsSync(f)) return false;
    const a = JSON.parse(readFileSync(f, 'utf8'));
    return a.runId === r.runId && a.checks.every(c => c.ok);
  }),
};
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
// Fixture index: every recorded process, with the checks its scenario asserted.
const index = ['# Cursor ACP 样本索引（生成文件）', '', `由 \`scripts/cursor-p0/reproduce.mjs\` 按 \`${relative(repoRoot, out)}/scenarios/*.json\` 生成。`, '',
  '| 样本 | 场景结果 | 场景断言 |', '| --- | --- | --- |'];
for (const r of results) for (const f of r.fixtures ?? []) {
  if (!existsSync(join(fixturesDir, f))) continue; // recorded into another fixtures directory (e.g. scratch)
  const meta = existsSync(join(fixturesDir, f, 'meta.json')) ? JSON.parse(readFileSync(join(fixturesDir, f, 'meta.json'), 'utf8')) : {};
  const analysis = existsSync(join(out, 'analysis', `${r.name}.json`)) ? `<br>更正后的断言见 \`${relative(repoRoot, out)}/analysis/${r.name}.json\`` : '';
  index.push(`| \`${f}\` | ${r.passed ? 'PASS' : 'FAIL'}${all.some(s => s.name === r.name) ? '' : '（旧场景定义）'} | ${r.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}`).join('<br>').replace(/\|/g, '\\|')}${analysis} |`);
}
writeFileSync(join(fixturesDir, 'INDEX.md'), index.join('\n') + '\n');
const manifest = {};
// A nested directory with a summary of its own (another ledger's runs, e.g. p0c/) has its own manifest.
const walk = d => { for (const n of readdirSync(d, { withFileTypes: true })) { const f = join(d, n.name); n.isDirectory() ? existsSync(join(f, 'summary.json')) || walk(f) : n.name !== 'manifest.json' && (manifest[relative(out, f)] = sha(f)); } };
walk(out);
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`\n${selectedToRun.length - failed}/${selectedToRun.length} selected scenarios passed on ${VERSION}${skippedNoKey.length ? `, ${skippedNoKey.length} skipped (no key): ${skippedNoKey.join(', ')}` : ''}; evidence in ${relative(repoRoot, out)}; real prompts spent so far ${ledger.length}/${PROMPT_CAP} (ledger ${LEDGER_NAME}: ${LEDGER})`);
process.exit(failed || skippedNoKey.length ? 1 : 0);

function sha(f) { return existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : null; }
