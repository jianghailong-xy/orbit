// Today's first sign-in of a new account, shot from the real web app at HEAD.
//   unshare -n ./run-ns.sh /var/tmp/onboard-mock/today capture.mjs [scene…]
import { launch, open, settle, K } from './lib.mjs';
import * as D from './data.mjs';
const only = process.argv.slice(2);
const scenes = [];
const scene = (name, fn) => scenes.push({ name, fn });
const NEW = { runners: [], workspaces: [] };

scene('t-login', async (b) => {
  const s = await open(b, { path: '/login', routes: {}, init: () => localStorage.removeItem('orbit_token') });
  return s;
});
scene('t-m-preparing', async (b) => open(b, { path: '/', routes: D.fleetRoutes({ runners: [D.R_OFF], workspaces: [D.WS(D.R_OFF)], managed: D.MR.preparing }) }));
scene('t-m-model', async (b) => open(b, { path: '/', routes: D.fleetRoutes({ runners: [D.R_OUT], workspaces: [D.WS(D.R_OUT)], managed: D.MR.model }) }));
scene('t-m-machines', async (b) => open(b, { path: `/infrastructure?runner=${D.RID}`, routes: D.fleetRoutes({ runners: [D.R_OUT], workspaces: [D.WS(D.R_OUT)], managed: D.MR.model }) }));
scene('t-m-ready', async (b) => open(b, { path: '/', routes: D.fleetRoutes({ runners: [D.R_IN], workspaces: [D.WS(D.R_IN)], managed: D.MR.available }) }));
scene('t-s-register', async (b) => open(b, { path: '/', routes: D.fleetRoutes(NEW) }));
scene('t-s-draft', async (b) => open(b, { path: '/', routes: D.fleetRoutes({ runners: [{ ...D.R_OUT, name: 'mia-macbook', hostname: 'mia-macbook', registerDir: '/Users/mia' }], workspaces: [] }) }));

const b = await launch();
for (const sc of scenes) {
  if (only.length && !only.includes(sc.name)) continue;
  const s = await sc.fn(b);
  await s.page.waitForTimeout(1500);
  await s.page.evaluate(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); while (w.nextNode()) { const n = w.currentNode; if (n.textContent.includes('Baseline Reviewer')) n.textContent = 'Mia Chen'; } });
  await settle(s.page);
  await s.page.screenshot({ path: `${K}/shots/${sc.name}.png` });
  console.log(sc.name, s.page.url().replace(/^https?:\/\/[^/]+/, ''), s.errors.slice(0, 2).join(' | '));
  await s.context.close();
}
await b.close();
