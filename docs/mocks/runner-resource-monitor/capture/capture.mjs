// Settings → Machines → studio: today, and the proposal's Resources section injected into the real page.
//   unshare -n ./run-ns.sh <dist> capture.mjs <scene…>
import { writeFileSync } from 'node:fs';
import { launch, open, settle, K } from './lib.mjs';
import * as D from './data.mjs';
import { inject } from './inject.mjs';
const only = process.argv.slice(2);
const GB = 1e9;
const R = { ...D.R_IN, name: 'studio', hostname: 'studio.local', displayName: null, registerDir: '/home/mia', reposRoot: '/home/mia/orbit-repos', activeSessions: 2, runsAsRoot: false };
const WS = (over = {}) => ({ ...D.WS(R), name: 'orbit', workDir: '/home/mia/code/orbit', workDirFreeBytes: 212 * GB, workDirTotalBytes: 994 * GB, ...over });
const routes = (r, ws = [WS()]) => D.fleetRoutes({ runners: [r], workspaces: ws });
const shot = async (s, name, h) => {
  await s.page.waitForTimeout(900);
  await s.page.evaluate(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); while (w.nextNode()) { const n = w.currentNode; if (n.textContent.includes('Baseline Reviewer')) n.textContent = 'Mia Chen'; } });
  await settle(s.page);
  await s.page.screenshot({ path: `${K}/shots/${name}.png`, fullPage: true });
  console.log(name, s.errors.slice(0, 2).join(' | '));
};
const scenes = { 
  today: async (b) => { const s = await open(b, { path: `/settings/machines/${R.id}`, routes: routes(R), height: 1500 }); await shot(s, 'today'); return s; },
};
for (const v of ['live', 'warn', 'offline', 'old']) scenes[v] = async (b) => {
  const r = v === 'offline' ? { ...R, online: false, status: 'OFFLINE', lastHeartbeatAt: D.ago(14) } : R;
  const ws = v === 'warn' ? [WS({ workDirFreeBytes: 41 * GB })] : [WS()];
  const s = await open(b, { path: `/settings/machines/${R.id}`, routes: routes(r, ws), height: 1500 });
  await inject(s.page, v); await shot(s, 'new-' + v); return s;
};
scenes.phone = async (b) => {
  const s = await open(b, { path: `/settings/machines/${R.id}`, routes: routes(R), size: 'phone', height: 1700 });
  await inject(s.page, 'live'); await shot(s, 'new-phone'); return s;
};
const b = await launch();
for (const [name, fn] of Object.entries(scenes)) { if (only.length && !only.includes(name)) continue; const s = await fn(b); await s.context.close(); }
await b.close();
