// The implemented welcome card on the real pages of this worktree.
import { launch, open, settle, K } from './lib.mjs';
import * as D from './data.mjs';
const only = process.argv.slice(2);
const NEW = { runners: [], workspaces: [] };
const fix = (page) => page.evaluate(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); while (w.nextNode()) { const n = w.currentNode; if (n.textContent.includes('Baseline Reviewer')) n.textContent = 'Mia Chen'; } });
const me = { 'GET /api/users/me': { id: 'u', email: 'mia@example.com', name: 'Mia Chen', createdAt: '2026-09-28T00:00:00Z', preferences: {} } };
const scenes = {
  'a-managed': (b) => open(b, { path: '/', routes: { ...D.fleetRoutes({ runners: [D.R_OFF], workspaces: [D.WS(D.R_OFF)], managed: D.MR.preparing }), ...me } }),
  'a-model': (b) => open(b, { path: '/', routes: { ...D.fleetRoutes({ runners: [D.R_OUT], workspaces: [D.WS(D.R_OUT)], managed: D.MR.model }), ...me } }),
  'a-ready': async (b) => { const s = await open(b, { path: '/', routes: { ...D.fleetRoutes({ runners: [D.R_IN], workspaces: [{ ...D.WS(D.R_IN), lastProvider: 'claude' }], managed: D.MR.available }), ...me } }); await s.page.waitForTimeout(1200); await s.page.locator('.welcome-example').first().click(); return s; },
  'a-machine': (b) => open(b, { path: '/', routes: { ...D.fleetRoutes({ runners: [{ ...D.R_OUT, name: 'mia-macbook', hostname: 'mia-macbook', registerDir: '/Users/mia' }], workspaces: [] }), ...me } }),
  'a-register': (b) => open(b, { path: '/', routes: { ...D.fleetRoutes(NEW), ...me } }),
};
const b = await launch();
for (const [name, fn] of Object.entries(scenes)) {
  if (only.length && !only.includes(name)) continue;
  const s = await fn(b);
  await s.page.waitForTimeout(1800);
  await fix(s.page);
  await settle(s.page);
  await s.page.screenshot({ path: `${K}/shots/${name}.png` });
  console.log(name, s.page.url().replace(/^https?:\/\/[^/]+/, ''), s.errors.filter((e) => !e.includes('501')).slice(0, 3).join(' | '));
  await s.context.close();
}
await b.close();
