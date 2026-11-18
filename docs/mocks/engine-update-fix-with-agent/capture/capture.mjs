// node capture.mjs <worktree> <dist> <outDir>: the machine page's Engines section in four states.
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
const [wt, dist, out] = process.argv.slice(2);
const { chromium } = await import(`${wt}/node_modules/playwright/index.mjs`);
const { installFixtures } = await import(`${wt}/src/web/ui-migration/fixtures.mjs`);
const { RUNNER, WORKSPACE } = await import(`${wt}/src/web/ui-migration/session-fixtures.mjs`);
const server = http.createServer((req, res) => {
  let file = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[ext] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const h = (engine, over = {}) => ({ engine, installed: true, auth: 'yes', ...over });
const engines = [
  h('claude', { version: '2.1.325 (Claude Code)' }),
  h('codex', { version: 'codex-cli 0.169.0' }),
  h('opencode', { version: '1.0.98', auth: 'unknown' }),
];
const report = 'Claude Code — already current (2.1.325)\nCodex — updated 0.168.2 → 0.169.0\nOpenCode — update timed out after 5m0s';
const relay = { status: 'failed', engine: null, command: 'orbit engine-update', message: report, mode: 'update' };
const fix = { workspaceId: WORKSPACE.id, workspaceName: 'orbit-develop', engine: 'claude', engineName: 'Claude Code', blocked: null, fixing: [] };
const SESSION = '3A1b2C3d4E5f6G7h8I9j0K';
const scenes = {
  '1-ready': { install: relay, agentFix: fix },
  '2-fixing': { install: relay, agentFix: { ...fix, fixing: [{ kind: 'engineUpdateFailed', engine: null, sessionId: SESSION, workspaceId: WORKSPACE.id, workspaceName: 'orbit-develop' }] } },
  '3-blocked': { install: relay, engines: [h('claude', { version: '2.1.325 (Claude Code)', auth: 'no' }), engines[1], engines[2]],
    agentFix: { ...fix, blocked: { code: 'engineSignedOut', message: "An agent can't run here: orbit-develop uses Claude Code, which is signed out on this machine." } } },
  '4-fixed': { install: { ...relay, status: 'done', message: 'Claude Code — already current (2.1.325)\nCodex — already current (0.169.0)\nOpenCode — updated 1.0.98 → 1.0.112' },
    engines: [engines[0], engines[1], h('opencode', { version: '1.0.112', auth: 'unknown' })], agentFix: fix },
  '0-today': { install: relay, agentFix: undefined },
};
const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/admin-mock/fonts.conf' } });
const boxes = {};
for (const [name, s] of Object.entries(scenes)) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 }, deviceScaleFactor: 2 });
  await installFixtures(page);
  const runner = { ...RUNNER, name: 'vmi3753066', engines: s.engines ?? engines, install: s.install, agentFix: s.agentFix, capabilities: ['os:linux'], version: '0.1.261' };
  await page.route('**/api/runners', (r) => r.fulfill({ json: [runner] }));
  await page.route('**/api/runners/*/**', (r) => r.fulfill({ json: [] }));
  await page.goto(`${base}/settings/machines/${RUNNER.id}`);
  const section = page.locator('.machine-section-engines');
  await section.waitFor();
  await page.waitForTimeout(600);
  await section.scrollIntoViewIfNeeded();
  const sb = await section.boundingBox();
  const rb = await page.locator('.rd-engine-relay').boundingBox();
  const clip = { x: sb.x - 12, y: sb.y - 12, width: sb.width + 24, height: rb.y + rb.height - sb.y + 150 };
  await page.screenshot({ path: `${out}/${name}.png`, clip });
  boxes[name] = clip;
  await page.close();
}
console.log(JSON.stringify(boxes));
await browser.close(); server.close();
