import { defineConfig } from '@playwright/test';
import baseline from './choices.config.mjs';

// The evidence probes (probe-*.browser.mjs, copied into src/web/ui-migration of the tree under test with this file; not
// part of the delivery), on the choices configuration's dev server, which also serves the overlays and controls
// fixtures. PROBE_OUTPUT and PROBE_PORT keep each run's results and server apart; desktop environments only (hover).
const output = process.env.PROBE_OUTPUT;
const port = Number(process.env.PROBE_PORT || 4521);
export default defineConfig({
  ...baseline,
  testMatch: process.env.PROBE_MATCH || 'probe-*.browser.mjs',
  testIgnore: [],
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
  projects: baseline.projects.filter((project) => !project.use.isMobile),
  use: { ...baseline.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: { ...baseline.webServer, command: baseline.webServer.command.replace(/--port \d+/, `--port ${port}`), url: `http://127.0.0.1:${port}` },
});
