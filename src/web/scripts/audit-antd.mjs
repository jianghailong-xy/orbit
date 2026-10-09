#!/usr/bin/env node
// Conservative, dependency-free inventory. Comments are intentionally included.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const hash = (text) => createHash('sha256').update(text).digest('hex');
function headCommit() {
  const marker = resolve(root, '.git');
  const git = statSync(marker).isDirectory() ? marker : resolve(root, readFileSync(marker, 'utf8').trim().replace(/^gitdir:\s*/, ''));
  const head = readFileSync(resolve(git, 'HEAD'), 'utf8').trim();
  if (!head.startsWith('ref: ')) return head;
  const ref = head.slice(5);
  const common = existsSync(resolve(git, 'commondir')) ? resolve(git, readFileSync(resolve(git, 'commondir'), 'utf8').trim()) : git;
  for (const directory of [git, common]) {
    if (existsSync(resolve(directory, ref))) return readFileSync(resolve(directory, ref), 'utf8').trim();
  }
  const packed = readFileSync(resolve(common, 'packed-refs'), 'utf8').split('\n').find((line) => line.endsWith(` ${ref}`));
  if (!packed) throw new Error(`Cannot resolve Git HEAD: ${ref}`);
  return packed.split(' ')[0];
}
const family = (name) => {
  if (/^antd(?:\/|$)/.test(name)) return 'antd';
  if (/^@ant-design\/icons(?:-svg)?(?:\/|$)/.test(name)) return 'icons';
  if (/^@ant-design\/v5-patch-for-react-19(?:\/|$)/.test(name)) return 'react19-patch';
  if (name.startsWith('@ant-design/')) return 'ant-design-support';
  if (/^(?:@rc-component\/|rc-)/.test(name)) return 'rc-support';
  return null;
};

function bindings(clause, typeOnly) {
  const clean = clause.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim();
  const named = clean.match(/\{([^}]*)\}/)?.[1];
  const items = (named ?? '').split(',').filter((item) => item.trim()).map((item) => {
    const typed = /^\s*type\s+/.test(item);
    const [imported, local = imported] = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
    return { imported, local, typeOnly: typeOnly || typed };
  });
  const prefix = clean.split('{')[0].replace(/,\s*$/, '').trim();
  if (prefix.startsWith('* as ')) items.unshift({ imported: '*', local: prefix.slice(5).trim(), typeOnly });
  else if (prefix) items.unshift({ imported: 'default', local: prefix, typeOnly });
  return items;
}

export function scanText(path, source) {
  const category = path === 'package-lock.json' ? 'lockfile' : path === 'src/web/package.json' ? 'manifest'
    : /(?:\.(?:test|spec)\.[^/]+$|\/(?:__tests__|__mocks__|test|tests)\/)/.test(path) ? 'test' : 'production';
  const imports = [];
  const lineAt = (offset) => source.slice(0, offset).split('\n').length;
  const addImport = (match, kind, module, clause = '', typed = false) => {
    if (family(module)) imports.push({ kind, module, family: family(module), line: lineAt(match.index), bindings: bindings(clause, typed) });
  };
  // Lexical import inventory supports multiline named/default/namespace imports and re-exports.
  const staticImport = /\b(import|export)\s+(type\s+)?((?:[\w$*]+(?:\s+as\s+[\w$]+)?\s*,?\s*)?(?:\{[^}]*\})?)\s+from\s*(['"])([^'"]+)\4/g;
  for (const match of source.matchAll(staticImport)) addImport(match, match[1], match[5], match[3], !!match[2]);
  for (const match of source.matchAll(/(?<!@)\bimport\s*(['"])([^'"]+)\1/g)) addImport(match, 'side-effect', match[2]);
  for (const match of source.matchAll(/\b(import|require)\s*\(\s*(['"`])([^'"`]+)\2/g)) {
    addImport(match, match[1] === 'import' ? 'dynamic-or-import-type' : match[1], match[3]);
  }
  for (const match of source.matchAll(/\b((?:vi|jest)\.(?:mock|doMock|unmock|doUnmock|importActual|importMock))\s*(?:<[^>]*>)?\s*\(\s*(['"`])([^'"`]+)\2/g)) addImport(match, match[1], match[3]);
  for (const match of source.matchAll(/@import\s+(?:url\(\s*)?(['"])([^'"]+)\1/g)) addImport(match, 'css-import', match[2]);
  imports.sort((a, b) => a.line - b.line || a.module.localeCompare(b.module) || a.kind.localeCompare(b.kind));
  const antdBindings = imports.filter((item) => item.family === 'antd').flatMap((item) => item.bindings);
  const aliases = (names) => antdBindings.filter((item) => names.includes(item.imported)).map((item) => item.local.replace(/[$]/g, '\\$'));
  const providerNames = aliases(['App', 'ConfigProvider']);
  const themeNames = aliases(['theme']);
  const rules = [
    ['antd-reference', /\bantd\b/i],
    ['ant-selector', /\.ant-[\w-]*/],
    ['ant-class', /(?<![\w@-])ant-[\w-]*/],
    ['icon-reference', /@ant-design\/icons(?:-svg)?\b/],
    ['icon-class', /(?<![\w-])anticon(?:-[\w-]+)?\b/],
    ['react19-patch', /@ant-design\/v5-patch-for-react-19\b/],
    ['ant-design-support', /@ant-design\/(?!icons\b|v5-patch-for-react-19\b)[\w-]+/],
    ['rc-support', /(?:@rc-component\/[\w-]+|(?<![\w-])rc-[\w-]+)/],
    ['use-app', /\buseApp\s*\(/],
    ['use-token', /\buseToken\s*\(/],
    ['imperative-confirm', /\b\w+\s*(?:\?\.|\.)\s*confirm\s*\(/],
    ['imperative-feedback', /\b(?:modal|Modal|message|notification)\s*(?:\?\.|\.)\s*(?:info|success|error|warning|warn|open|loading|destroyAll|destroy)\s*\(/],
    ['internal-ref', /\b(?:resizableTextArea|nativeElement|InputRef|TextAreaRef|RefSelectProps|GetRef)\b/],
    ['ref-focus', /\b\w+\.current(?:\?\.|\.)focus\s*\(/],
  ];
  if (providerNames.length) rules.push(['provider', new RegExp(`<\\s*(?:${providerNames.join('|')})(?=[\\s/>])`)]);
  if (themeNames.length) rules.push(['theme', new RegExp(`\\b(?:${themeNames.join('|')})\\s*\\.`)]);
  const hits = [];
  for (const [index, text] of source.split('\n').entries()) {
    for (const [kind, expression] of rules) if (expression.test(text)) hits.push({ kind, line: index + 1, text: text.trim() });
  }
  return { path, category, sha256: hash(source), imports, hits };
}

function sourcePaths(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourcePaths(path) : [relative(root, path)];
  });
}

export function retirementBlockers(files) {
  // Deliberately includes comments and test assertions; icons/support packages alone are allowed.
  const blocked = new Set(['antd-reference', 'ant-class', 'react19-patch', 'internal-ref']);
  return files.filter((file) => file.imports.some((item) => ['antd', 'react19-patch'].includes(item.family))
    || file.hits.some((hit) => blocked.has(hit.kind))).map((file) => file.path);
}

// --check-owners: every use point needs an owner in the P0.1 inventory or in a dated record under
// inventory-delta/ (later records win). A file is a use point when it imports antd or the v5 patch or
// has one of OWNER_KINDS; index.css is matched line by line on its hit text, never on line numbers.
const OWNER_KINDS = ['antd-reference', 'ant-class', 'ant-selector', 'internal-ref', 'use-app', 'use-token', 'react19-patch'];
const CSS_PATH = 'src/web/src/index.css';
const CSS_KINDS = ['antd-reference', 'ant-class'];

export function loadInventory(directory = resolve(root, 'docs/evidence/base-ui-migration')) {
  const json = (name) => JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
  const testPhases = new Map();
  let phase;
  for (const line of readFileSync(resolve(directory, 'routes-and-tests.md'), 'utf8').split('\n')) {
    phase = line.match(/^### (P[\d.]+) /)?.[1] ?? phase;
    const test = line.match(/^\| `([^`]+\.(?:test|spec)\.[^`]+)` \|/)?.[1];
    if (test && phase) testPhases.set(`src/web/src/${test}`, phase);
  }
  const deltas = resolve(directory, 'inventory-delta');
  const records = existsSync(deltas) ? readdirSync(deltas).filter((name) => /^\d{4}-\d{2}-\d{2}[\w.-]*\.json$/.test(name)).sort()
    .map((name) => ({ ...JSON.parse(readFileSync(resolve(deltas, name), 'utf8')), name })) : [];
  return { baseline: json('audit-baseline.json'), ownership: json('ownership.json'), css: json('css-ownership.json'), testPhases, records };
}

export function ownerGaps(report, { baseline, ownership, css, testPhases, records }) {
  const owners = new Map([...Object.entries(ownership.files).map(([path, entry]) => [path, { owner: entry.phase, from: 'P0.1' }]),
    ...[...testPhases].map(([path, owner]) => [path, { owner, from: 'P0.1' }])]);
  const baseFiles = new Map(baseline.files.map((file) => [file.path, file]));
  const key = (hit) => `${hit.kind}\0${hit.text}`;
  const slots = new Map();
  const add = (hit, slot, count = 1) => slots.set(key(hit), [...(slots.get(key(hit)) ?? []), ...Array.from({ length: count }, () => ({ ...slot }))]);
  for (const hit of baseFiles.get(CSS_PATH)?.hits.filter((item) => CSS_KINDS.includes(item.kind)) ?? []) {
    add(hit, { owner: css.groups.find((group) => group.from <= hit.line && hit.line <= group.to)?.phase, from: 'P0.1' });
  }
  const inactive = {};
  for (const record of records) {
    Object.assign(inactive, record.inactiveOwners);
    for (const [path, entry] of Object.entries(record.files ?? {})) owners.set(path, { owner: entry.owner, pending: entry.pending, from: record.name });
    for (const entry of record.css ?? []) {
      const slot = { owner: entry.owner, pending: entry.pending, from: record.name };
      if (entry.status === 'reassigned') for (const existing of slots.get(key(entry)) ?? []) Object.assign(existing, slot);
      else add(entry, slot, entry.count);
    }
  }
  const signature = (file) => new Set([
    ...file.imports.filter((item) => ['antd', 'react19-patch'].includes(item.family))
      .flatMap((item) => (item.bindings.length ? item.bindings.map((binding) => binding.imported) : [`${item.kind}:${item.module}`])),
    ...file.hits.filter((hit) => OWNER_KINDS.includes(hit.kind)).map((hit) => hit.kind),
  ]);
  const result = { unowned: [], pending: [], owners: {} };
  const judge = (point, entry) => {
    const owner = entry?.owner?.split('→').at(-1).trim();
    if (entry?.pending) result.pending.push({ ...point, candidates: entry.pending.candidates, record: entry.from });
    else if (!owner) result.unowned.push({ ...point, reason: 'no owner' });
    else if (inactive[owner]) result.unowned.push({ ...point, reason: `owner ${owner}: ${inactive[owner]}` });
    else result.owners[owner] = (result.owners[owner] ?? 0) + 1;
  };
  for (const file of report.files) {
    if (file.path === CSS_PATH) {
      const seen = new Map();
      for (const hit of file.hits.filter((item) => CSS_KINDS.includes(item.kind))) {
        seen.set(key(hit), (seen.get(key(hit)) ?? -1) + 1);
        judge({ path: file.path, line: hit.line, kind: hit.kind, text: hit.text }, slots.get(key(hit))?.[seen.get(key(hit))]);
      }
    } else if (['production', 'test'].includes(file.category) && signature(file).size) {
      const entry = owners.get(file.path);
      const before = baseFiles.get(file.path);
      const grown = entry?.from === 'P0.1' ? [...signature(file)].filter((item) => !before || !signature(before).has(item)) : [];
      if (grown.length) result.unowned.push({ path: file.path, reason: `new since P0.1, not in a delta record: ${grown.join(', ')}` });
      else judge({ path: file.path }, entry);
    }
  }
  result.owners = Object.fromEntries(Object.entries(result.owners).sort());
  return result;
}

function audit() {
  const paths = [...sourcePaths(resolve(root, 'src/web/src')), 'src/web/package.json', 'package-lock.json'].sort();
  const files = paths.map((path) => scanText(path, readFileSync(resolve(root, path), 'utf8')));
  const manifest = JSON.parse(readFileSync(resolve(root, 'src/web/package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
  const declared = Object.entries(manifest).filter(([section]) => /^(?:dev|peer|optional)?[Dd]ependencies$/.test(section))
    .flatMap(([section, entries]) => Object.entries(entries).filter(([name]) => family(name)).map(([name, version]) => ({ section, name, version, family: family(name) })));
  const locked = Object.entries(lock.packages).flatMap(([path, entry]) => {
    const name = path.split('node_modules/').at(-1);
    return family(name) ? [{ path, name, version: entry.version, family: family(name), dependencies: entry.dependencies ?? {}, peerDependencies: entry.peerDependencies ?? {} }] : [];
  });
  const count = (predicate) => files.filter(predicate).length;
  const hasImport = (file, group) => file.imports.some((item) => item.family === group);
  const hasHit = (file, kind) => file.hits.some((hit) => hit.kind === kind);
  const kinds = [...new Set(files.flatMap((file) => file.hits.map((hit) => hit.kind)))].sort();
  return {
    schemaVersion: 1,
    baseline: { commit: headCommit(), scopeHash: hash(files.map((file) => `${file.path}\0${file.sha256}\n`).join('')) },
    scope: ['src/web/src/**', 'src/web/package.json', 'package-lock.json'],
    limitations: [
      'Lexical scan, not a TypeScript parser or runtime trace. Includes comments and string literals; manual review must distinguish live use from explanations or negative assertions.',
      'Literal static/side-effect/dynamic/CommonJS/mock imports and re-exports are inventoried. Computed module names, computed class names and indirect aliases require manual review.',
      'Provider and theme hits use direct named-import aliases; useApp/useToken/confirm/ref matches are conservative candidates, not semantic ownership proofs.',
      'Each kind is reported once per matching source line, not once per occurrence. Test classification uses test/spec filenames and test/mock directory names.',
      'All source files in this scope are read as UTF-8. This audit does not cover generated bundles, files outside scope, or visual/keyboard behavior.',
      '--check-retired rejects antd references, ant-* class tokens, known internal-ref patterns and the v5 React 19 patch even in comments/tests. Icons, anticon and support packages alone do not block; review support-package reachability separately.',
    ],
    counts: {
      scannedFiles: files.length,
      productionFiles: count((file) => file.category === 'production'),
      testFiles: count((file) => file.category === 'test'),
      antdProductionFiles: count((file) => file.category === 'production' && hasImport(file, 'antd')),
      antdTestFiles: count((file) => file.category === 'test' && hasImport(file, 'antd')),
      antSelectorTestFiles: count((file) => file.category === 'test' && hasHit(file, 'ant-selector')),
      antClassTestFiles: count((file) => file.category === 'test' && hasHit(file, 'ant-class')),
      iconProductionFiles: count((file) => file.category === 'production' && hasImport(file, 'icons')),
      iconTestFiles: count((file) => file.category === 'test' && hasImport(file, 'icons')),
      relevantSourceFiles: count((file) => ['production', 'test'].includes(file.category) && (file.imports.length > 0 || file.hits.length > 0)),
      hitLines: Object.fromEntries(kinds.map((kind) => [kind, files.reduce((sum, file) => sum + file.hits.filter((hit) => hit.kind === kind).length, 0)])),
      retirementBlockingFiles: retirementBlockers(files).length,
    },
    dependencies: { declared, locked },
    files,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--json', '--check-retired', '--check-owners', '--help'].includes(arg))) {
    console.error('Unknown option. Use --help.');
    process.exitCode = 2;
  } else if (args.includes('--help')) {
    console.log('Usage: node src/web/scripts/audit-antd.mjs [--json] [--check-retired]\nScans src/web/src and web manifest/root lockfile. --check-retired exits 1 for remaining antd/class/internal-ref/patch references; independent icons are permitted.\n       node src/web/scripts/audit-antd.mjs --check-owners\nRead-only: exits 1 when a use point has no owner in the P0.1 inventory or docs/evidence/base-ui-migration/inventory-delta/*.json; lists the ones awaiting the coordinator.');
  } else if (args.includes('--check-owners')) {
    if (args.length > 1) {
      console.error('--check-owners runs alone.');
      process.exitCode = 2;
    } else {
      const report = audit();
      const inventory = loadInventory();
      const result = ownerGaps(report, inventory);
      console.log(JSON.stringify({ baseline: report.baseline, records: inventory.records.map((record) => record.name), ...result }, null, 2));
      if (result.unowned.length) {
        console.error(`Ownership gaps: ${result.unowned.length} use points have no owner. Migrate them in this batch if in scope, otherwise report them to the coordinator.`);
        process.exitCode = 1;
      }
    }
  } else {
    const report = audit();
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else console.log(JSON.stringify({ baseline: report.baseline, counts: report.counts, declaredDependencies: report.dependencies.declared }, null, 2));
    if (args.includes('--check-retired') && report.counts.retirementBlockingFiles > 0) {
      console.error(`Retirement blocked: ${report.counts.retirementBlockingFiles} files. Use --json for paths and line evidence.`);
      process.exitCode = 1;
    }
  }
}
