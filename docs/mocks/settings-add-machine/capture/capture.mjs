// Settings → Machines → + , today vs proposal, existing account and brand-new account. Real web pages.
//   unshare -n ./run-ns.sh <tree> capture.mjs <prefix> [scene…]
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { launch, open, settle, K } from './lib.mjs';
import * as D from './data.mjs';
const [prefix, ...only] = process.argv.slice(2);
const mk = (i, name, online) => ({ ...D.R_IN, id: `3${'4wAbCdEfGhIjKlMnOpQrS'.slice(0, 20)}${i}`, name, hostname: name, online,
  status: online ? 'ONLINE' : 'OFFLINE', lastHeartbeatAt: online ? D.ago(0.2) : D.ago(600), position: i, registerDir: '/home/mia' });
const FLEET = [mk(1, 'gpu-box', false), mk(2, 'studio', true), mk(3, 'workstation', false), mk(4, 'mia-mac-mini.local', false), mk(5, 'build@lab', false)];
const NEWBOX = mk(6, 'new-box', true);
const boxesFile = `${K}/shots/boxes.json`;
const boxes = existsSync(boxesFile) ? JSON.parse(readFileSync(boxesFile, 'utf8')) : {};
const box = async (page, name, sel) => {
  const b = await page.locator(sel).first().boundingBox().catch(() => null);
  if (b) boxes[`${prefix}-${name}`] = b;
};
const shot = async (s, name) => {
  await s.page.waitForTimeout(800);
  await s.page.evaluate(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); while (w.nextNode()) { const n = w.currentNode; if (n.textContent.includes('Baseline Reviewer')) n.textContent = 'Mia Chen'; else if (n.textContent.includes('Orbit, Baseline')) n.textContent = n.textContent.replace('Orbit, Baseline', 'Orbit, Mia'); } });
  await settle(s.page);
  await s.page.screenshot({ path: `${K}/shots/${prefix}-${name}.png` });
  console.log(prefix, name, s.page.url().replace(/^https?:\/\/[^/]+/, ''), s.errors.slice(0, 2).join(' | '));
};
const scenes = [];
const scene = (name, fn) => scenes.push({ name, fn });
const ADD = 'button[aria-label="Register a machine"]';

scene('fleet', async (b) => {
  const s = await open(b, { path: '/settings/general', routes: D.fleetRoutes({ runners: FLEET, workspaces: [] }) });
  await box(s.page, 'plus', ADD);
  await shot(s, 'fleet-0');
  await s.page.click(ADD);
  await s.page.waitForTimeout(1200);
  await shot(s, 'fleet-1');
  return s;
});
scene('online', async (b) => {
  let n = 0;
  const r = D.fleetRoutes({ runners: FLEET, workspaces: [] });
  r['GET /api/runners'] = () => (++n > 2 ? [...FLEET, NEWBOX] : FLEET);
  r[`GET /api/runners/${NEWBOX.id}`] = NEWBOX;
  const s = await open(b, { path: '/settings/general', routes: r });
  await s.page.click(ADD);
  await s.page.waitForTimeout(12000);
  await shot(s, 'online');
  return s;
});
scene('new', async (b) => {
  const s = await open(b, { path: '/', routes: D.fleetRoutes({ runners: [], workspaces: [] }) });
  await s.page.waitForTimeout(1500);
  await shot(s, 'new-landing');
  return s;
});
scene('newsettings', async (b) => {
  const s = await open(b, { path: '/settings/general', routes: D.fleetRoutes({ runners: [], workspaces: [] }) });
  await box(s.page, 'plus0', ADD);
  await box(s.page, 'row0', 'a.settings-nav-row[href="/settings/machines/new"]');
  await box(s.page, 'group0', '[role="group"][aria-label="Machines"]');
  await shot(s, 'new-settings-0');
  await s.page.click(ADD);
  await s.page.waitForTimeout(1500);
  await shot(s, 'new-settings-1');
  return s;
});

const b = await launch();
for (const sc of scenes) {
  if (only.length && !only.includes(sc.name)) continue;
  const s = await sc.fn(b);
  await s.context.close();
}
await b.close();
writeFileSync(boxesFile, JSON.stringify(boxes, null, 1));
