// What the session workspace's routes still reach of antd, statically (P5.3): p4.4/route-closure.mjs with the session
// routes it leaves out, and only those.
//
// usage: [TREE=checkout] node docs/evidence/base-ui-migration/p5.3/session-route-closure.mjs [AUDIT.json] > session-route-closure.json
//
// From WorkspaceConsole (the element of /workspaces/:id/*, /agents/:id/* and /sessions/:id) the import graph of
// src/web/src is walked as p4.4/route-closure.mjs walks it (static imports, re-exports and dynamic `import()`, relative
// specifiers only), and every module on the way that imports antd is reported with the chain that reaches it, the names
// the last link imports from it, and its owner by the audit's --check-owners rules. The signed-in shell is one entry of
// its own. AUDIT.json defaults to a fresh `audit-antd.mjs --json` of this tree. Reading only.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const { loadInventory, ownerGaps } = await import(`${root}src/web/scripts/audit-antd.mjs`);
// TREE (env) names another checkout whose src/web/src is walked (the same-commit reference, a sparse tree without the
// inventory); the inventory and the audit's rules are always this tree's.
const src = resolve(process.env.TREE ?? root, 'src/web/src');
const report = process.argv[2]
  ? JSON.parse(readFileSync(process.argv[2], 'utf8'))
  : JSON.parse((await import('node:child_process')).execFileSync('node', [resolve(root, 'src/web/scripts/audit-antd.mjs'), '--json'], { maxBuffer: 1 << 28 }).toString());
const inventory = loadInventory();
const files = new Map(report.files.map((file) => [file.path, file]));

// The session workspace's own routes (P5.3): App.tsx draws /workspaces/:id/*, /agents/:id/* and /sessions/:id with
// WorkspaceConsole, which draws WorkspaceView; the shell they are drawn in is listed once on its own.
const ROUTES = [
  ['(the signed-in shell: sidebar and session search)', 'components/AppShell.tsx'],
  ['/workspaces/:id/*, /agents/:id/*, /sessions/:id (the session workspace)', 'components/WorkspaceConsole.tsx'],
];

const IMPORT = /\b(?:import|export)\s+(type\s+)?(?:([\w$*{},\s]+?)\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
function resolveSpecifier(from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate;
  }
  return null;
}
const graph = new Map();
function edges(file) {
  if (graph.has(file)) return graph.get(file);
  const text = readFileSync(file, 'utf8');
  const out = [];
  for (const match of text.matchAll(IMPORT)) {
    if (match[1]) continue; // a type-only import loads nothing
    const target = resolveSpecifier(file, match[3] ?? match[4]);
    if (!target || target.endsWith('.css')) continue;
    out.push({ target, names: (match[2] ?? (match[4] ? 'import()' : '')).replace(/\s+/g, ' ').trim() });
  }
  graph.set(file, out);
  return out;
}
const rel = (file) => `src/web/src/${relative(src, file)}`;
const ownerOf = (path) => {
  const file = files.get(path);
  if (!file) return null;
  const owners = Object.keys(ownerGaps({ files: [file] }, inventory).owners);
  return owners[0] ?? null;
};
const antdOf = (path) => [...new Set((files.get(path)?.imports ?? []).filter((item) => item.family === 'antd')
  .flatMap((item) => item.bindings.map((binding) => binding.imported)))].sort();

/** Breadth-first from the entry: the first chain that reaches each module. */
function closure(entry) {
  const start = resolve(src, entry.split('#')[0]);
  const chain = new Map([[start, [{ module: rel(start), names: entry.includes('#') ? entry.split('#')[1] : '' }]]]);
  const queue = [start];
  while (queue.length) {
    const file = queue.shift();
    for (const { target, names } of edges(file)) {
      if (chain.has(target)) continue;
      // App.tsx's own landing draws only what the landing names; the rest of App.tsx is the router.
      if (entry.startsWith('App.tsx#') && file === start && !/Spinner|queries|workspaceOrder|idCodec|api/.test(target)) continue;
      chain.set(target, [...chain.get(file), { module: rel(target), names }]);
      queue.push(target);
    }
  }
  return chain;
}

const shell = closure('components/AppShell.tsx');
const out = { audit: report.baseline, records: inventory.records.map((record) => record.name), routes: [] };
for (const [route, entry] of ROUTES) {
  const reached = closure(entry);
  const antd = [];
  for (const [file, path] of reached) {
    const module = rel(file);
    const symbols = antdOf(module);
    if (!symbols.length) continue;
    // The signed-in shell is reported once, under its own entry.
    if (entry !== 'components/AppShell.tsx' && shell.has(file) && !entry.startsWith('pages/Shared') && !['pages/LoginPage.tsx', 'pages/SetupPage.tsx'].includes(entry)) {
      const viaPage = path.length > 1 && !path.slice(1).some((step) => step.module === 'src/web/src/components/AppShell.tsx');
      if (!viaPage) continue;
    }
    antd.push({ module, antd: symbols, owner: ownerOf(module), chain: path.map((step) => (step.names ? `${step.module} {${step.names}}` : step.module)) });
  }
  out.routes.push({ route, entry, modules: reached.size, antd });
}
console.log(JSON.stringify(out, null, 1));
