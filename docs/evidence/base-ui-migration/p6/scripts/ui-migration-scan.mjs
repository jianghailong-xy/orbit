// The internal-selector scan of src/web/ui-migration that P6 owes (project instructions: "P6 的内部选择器扫描须包含此
// 目录"), with the audit's own line rules (src/web/scripts/audit-antd.mjs scanText). Every file falls in one group:
//  - p0:      the standard P0 regression (playwright.config.mjs and what it runs and imports);
//  - fixture: the component fixtures' harnesses (foundation, controls, overlays, choices, toasts, composer);
//  - batch:   a batch's same-commit comparison tool, written to read that batch's reference tree on AntD as well
//             as its delivery on Orbit (selectors such as '.ant-modal-container, .orbit-overlay', and the
//             [class*="ant-"] census). Kept by the coordinator's 2026-10-10 decision; listed line by line.
// Exits 1 if a p0 or fixture file has a hit or imports the library, or if a file fits no group.
//
// usage: node docs/evidence/base-ui-migration/p6/scripts/ui-migration-scan.mjs > ui-migration-scan.json
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const { scanText } = await import(resolve(root, 'src/web/scripts/audit-antd.mjs'));
const dir = resolve(root, 'src/web/ui-migration');
const KINDS = ['antd-reference', 'ant-class', 'ant-selector', 'react19-patch', 'internal-ref', 'use-app', 'use-token', 'provider', 'theme'];
const BATCHES = [
  [/^pilot/, 'P3.2', 'the task detail / share / attachments pilot (pilot.config.mjs)'],
  [/^reviews/, 'P2 integration fix 34a0sy3NmYy7MLbOcqhkW', 'compact review cards (reviews.config.mjs)'],
  [/^p41/, 'P4.1', 'sign-in, setup, profile, settings'],
  [/^p42/, 'P4.2', 'providers, pools, runners, admin users'],
  [/^p43a/, 'P4.3a', 'task and project lists, pages and toolbars'],
  [/^p43b/, 'P4.3b', 'dependency graphs and decision cards'],
  [/^p44/, 'P4.4', 'wiki, shared pages, following and watches'],
  [/^p51/, 'P5.1', 'session navigation, search, outputs'],
  [/^p52/, 'P5.2', 'transcript pictures and their preview'],
  [/^p53/, 'P5.3', 'the session workspace'],
  [/^tasks-toolbar/, 'WebKit tasks toolbar fix 34coPBqt8gi229cVNds0E', 'tasks toolbar geometry'],
];
const FIXTURE = /^(foundation|controls|overlays|choices|toasts|composer)[\w.-]*$|^collect-(choice|composer|overlay)-evidence\.mjs$/;

const files = readdirSync(dir).filter((name) => !name.startsWith('.')).sort();
const report = { p0: [], fixture: [], batch: [] };
let failed = false;
for (const name of files) {
  const scan = scanText(relative(root, resolve(dir, name)), readFileSync(resolve(dir, name), 'utf8'));
  const imports = scan.imports.filter((item) => ['antd', 'react19-patch'].includes(item.family)).map((item) => `${item.kind} ${item.module}`);
  const hits = scan.hits.filter((hit) => KINDS.includes(hit.kind)).map((hit) => ({ line: hit.line, kind: hit.kind, text: hit.text }));
  const batch = BATCHES.find(([pattern]) => pattern.test(name));
  const group = batch ? 'batch' : FIXTURE.test(name) ? 'fixture' : 'p0';
  const entry = { file: name, imports, hits: hits.length };
  if (group === 'batch') Object.assign(entry, { batch: batch[1], purpose: batch[2], lines: hits });
  else if (imports.length || hits.length) { failed = true; entry.lines = hits; }
  report[group].push(entry);
}
const sum = (group) => report[group].reduce((n, entry) => n + entry.hits + entry.imports.length, 0);
console.log(JSON.stringify({ files: files.length, hits: { p0: sum('p0'), fixture: sum('fixture'), batch: sum('batch') }, ...report }, null, 1));
if (failed) { console.error('ui-migration scan: a P0 or fixture file still names the component library'); process.exitCode = 1; }
