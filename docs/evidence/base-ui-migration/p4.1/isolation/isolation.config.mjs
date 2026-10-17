// Scratch (not committed): the P0 profile test on the delivery, compared with the P0 expected screenshots,
// optionally with one forced layout read right after lib/toast appends its screen-reader region.
import baseline from '/root/.orbit/worktrees/3402ff96-4293-56f4-8940-d723dd9fa681/src/web/ui-migration/playwright.config.mjs';
const output = process.env.ISO_OUTPUT;
if (!output) throw new Error('Set ISO_OUTPUT');
export default {
  ...baseline,
  testDir: '/var/tmp/p4.1-293463/isolation',
  testMatch: 'isolation.browser.mjs',
  testIgnore: [],
  globalSetup: ['/root/.orbit/worktrees/3402ff96-4293-56f4-8940-d723dd9fa681/src/web/ui-migration/environment.mjs', '/root/.orbit/worktrees/3402ff96-4293-56f4-8940-d723dd9fa681/src/web/ui-migration/expected-screenshots.mjs'],
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
};
