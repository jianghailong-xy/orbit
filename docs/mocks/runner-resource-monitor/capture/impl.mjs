// The implemented Resources section (no injection), fed a fake GET /runners/:id/resources.
//   unshare -n ./run-ns.sh <dist-impl> impl.mjs
import { launch, open, settle, K } from './lib.mjs';
import * as D from './data.mjs';
const GB = 1024 ** 3;
const R = { ...D.R_IN, name: 'studio', hostname: 'studio.local', registerDir: '/home/mia', reposRoot: '/home/mia/orbit-repos', activeSessions: 2,
  capabilities: [...D.R_IN.capabilities, 'machine-resources/v1'] };
const WS = { ...D.WS(R), name: 'orbit', workDir: '/home/mia/code/orbit', workDirFreeBytes: 198 * GB, workDirTotalBytes: 926 * GB };
const series = (seed, base, amp, n, end) => { let x = base; const out = []; for (let i = 0; i < n; i++) { seed = (seed * 16807) % 2147483647; x += ((seed / 2147483647) - 0.5) * amp; out.push(Math.max(1, Math.min(99, x))); } out[n - 1] = end; return out; };
const answer = (endMs, warn) => {
  const n = 120, cpu = series(7, 36, 9, n, 38), mem = series(11, warn ? 90 : 66, 2, n, warn ? 94 : 68), disk = series(3, 79, 0.2, n, 79);
  return {
    at: new Date(endMs).toISOString(),
    latest: { cpuPercent: 38.2, cpuCores: 8, load1: 3.04, memTotalBytes: 32 * GB, memAvailableBytes: (warn ? 0.06 : 0.32) * 32 * GB, diskTotalBytes: 926 * GB, diskFreeBytes: 198 * GB },
    samples: cpu.map((c, i) => ({ at: new Date(endMs - (n - 1 - i) * 30_000).toISOString(), cpu: Math.round(c * 10) / 10, mem: Math.round(mem[i] * 10) / 10, disk: Math.round(disk[i] * 10) / 10 })),
  };
};
const b = await launch();
for (const [name, r, warn, size] of [['impl-live', R, false, 'desktop'], ['impl-warn', R, true, 'desktop'], ['impl-off', { ...R, online: false, status: 'OFFLINE', lastHeartbeatAt: D.ago(14) }, false, 'desktop'], ['impl-old', D.R_IN, false, 'desktop'], ['impl-phone', R, false, 'phone']]) {
  const routes = D.fleetRoutes({ runners: [{ ...r, id: R.id }], workspaces: [WS] });
  const end = r.online ? D.NOW - 10_000 : D.NOW - 14 * 60_000;
  routes[`GET /api/runners/${R.id}/resources`] = answer(end, warn);
  const s = await open(b, { path: `/settings/machines/${R.id}`, routes, size, height: 1500 });
  await s.page.waitForTimeout(1500); await settle(s.page);
  await s.page.screenshot({ path: `${K}/shots/${name}.png`, fullPage: true });
  console.log(name, s.errors.filter((e) => !e.includes('501')).slice(0, 2).join(' | '));
  await s.context.close();
}
await b.close();
