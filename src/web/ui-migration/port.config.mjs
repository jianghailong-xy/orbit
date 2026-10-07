import { defineConfig } from '@playwright/test';

// Runs one of the existing ui-migration configs (P32_BASE_CONFIG, e.g. choices.config.mjs) unchanged
// except for its server port (P32_PORT): another checkout on the same machine may already hold the
// fixed port. Copy into src/web/ui-migration/ of the tree under test; it is not part of the delivery.
const base = (await import(`./${process.env.P32_BASE_CONFIG}`)).default;
const port = Number(process.env.P32_PORT);
if (!base.webServer || !port) throw new Error('Set P32_BASE_CONFIG (a config with a webServer) and P32_PORT');
const output = process.env.P32_OUTPUT;
export default defineConfig({
  ...base,
  ...(output ? { outputDir: output, reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]] } : {}),
  use: { ...base.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: { ...base.webServer, command: base.webServer.command.replace(/--port \d+/, `--port ${port}`), url: `http://127.0.0.1:${port}` },
});
