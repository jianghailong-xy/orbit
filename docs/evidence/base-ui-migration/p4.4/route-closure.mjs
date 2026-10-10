// What each non-session route still reaches of antd, statically: P4.4's stage check over the inventory.
//
// usage: node docs/evidence/base-ui-migration/p4.4/route-closure.mjs [AUDIT.json] > route-closure.json
//
// Every route App.tsx declares outside the session workspace is listed with the module its element comes from. From
// that module the import graph of src/web/src is walked (static imports, re-exports and dynamic `import()`, relative
// specifiers only), and every module on the way that imports antd (the audit's own reading of the file) is reported
// with the import chain that reaches it, the names the last link imports from it, and its owner by the audit's
// --check-owners rules (P0.1 inventory plus the inventory-delta records). The shell every signed-in route is drawn in
// (AppShell: the sidebar and the session search) is one entry of its own rather than repeated under each route.
// AUDIT.json defaults to a fresh `audit-antd.mjs --json` of this tree. Reading only; nothing is written to the repo.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const { loadInventory, ownerGaps } = await import(`${root}src/web/scripts/audit-antd.mjs`);
const src = resolve(root, 'src/web/src');
const report = process.argv[2]
  ? JSON.parse(readFileSync(process.argv[2], 'utf8'))
  : JSON.parse((await import('node:child_process')).execFileSync('node', [resolve(root, 'src/web/scripts/audit-antd.mjs'), '--json'], { maxBuffer: 1 << 28 }).toString());
const inventory = loadInventory();
const files = new Map(report.files.map((file) => [file.path, file]));

// The routes App.tsx declares, with the module their element is drawn by; the session workspace's own routes
// (/workspaces/:id/*, /agents/:id/*, /sessions/:id and the legacy session redirects) are left out on purpose.
const ROUTES = [
  ['/s/:token (task, project, wiki or session link)', 'pages/SharedLinkPage.tsx'],
  ['/s/:token/t/:taskId', 'pages/SharedLinkPage.tsx'],
  ['/s/:token/d/:slug', 'pages/SharedWikiPage.tsx'],
  ['/s/:token/c/:sessionId (a shared conversation)', 'pages/SharedSessionPage.tsx'],
  ['/login', 'pages/LoginPage.tsx'],
  ['/setup', 'pages/SetupPage.tsx'],
  ['/enroll', 'pages/EnrollPage.tsx'],
  ['/cli-login', 'pages/CliLoginPage.tsx'],
  ['(the signed-in shell: sidebar and session search)', 'components/AppShell.tsx'],
  ['/ (the default landing)', 'App.tsx#DefaultLanding'],
  ['/tasks, /tasks/:id, /lists/:key', 'pages/TaskRoute.tsx'],
  ['/settings/profile', 'pages/ProfilePage.tsx'],
  ['/settings', 'pages/SettingsPage.tsx'],
  ['/settings/shared-links', 'pages/SharedLinksPage.tsx'],
  ['/settings/access-tokens', 'pages/AccessTokensPage.tsx'],
  ['/admin', 'pages/AdminUsersPage.tsx'],
  ['/admin/sign-in', 'pages/AdminSignInPage.tsx'],
  ['/infrastructure', 'pages/InfrastructurePage.tsx'],
  ['/providers/new, /providers/new/:slug, /providers/:id', 'pages/ProviderConnectPage.tsx'],
  ['/providers/pools/:id', 'pages/ProviderPoolPage.tsx'],
  ['/following', 'pages/FollowingPage.tsx'],
  ['/projects, /projects/:id, /projects/:id/tasks/:taskId', 'pages/ProjectsPage.tsx'],
  ['/wiki and its routes', 'pages/WikiPage.tsx'],
  ['/runners/register', 'components/RunnerRegisterGuide.tsx'],
  ['/runners/:id', 'pages/RunnerDetailPage.tsx'],
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
