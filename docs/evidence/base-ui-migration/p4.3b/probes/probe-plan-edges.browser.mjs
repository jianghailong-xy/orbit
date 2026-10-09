import { test, expect } from './harness.mjs';
import { P43B_PATHS, PLAN_FITS, installP43bFixtures } from './p43b-fixtures.mjs';

// Probe: the start dialog's plan graph (three tasks in a chain) on the project page. Where each node's
// centre is and where each edge runs (its path's centre and `d`), and how the dialog's transform moves while
// it opens; then the same with every animation and transition switched off before the dialog opens.
test('plan graph edges', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  const fixtures = await installP43bFixtures(page, { started: false });
  fixtures.state.graph = PLAN_FITS;
  const say = (what, value) => console.log(`PROBE ${process.env.TREE} ${testInfo.project.name} ${what} ${JSON.stringify(value)}`);
  const open = async () => {
    await page.locator('.project-open-items').getByRole('button', { name: /^Start/ }).first().click();
    // The dialog's transform from the press on, each change over 600ms.
    return page.evaluate(() => new Promise((resolve) => {
      const seen = []; const start = performance.now();
      const step = () => {
        const popup = document.querySelector('.ant-modal, .start-card-dialog');
        const t = popup ? getComputedStyle(popup).transform : 'none';
        if (seen.at(-1)?.t !== t) seen.push({ ms: Math.round(performance.now() - start), t });
        if (performance.now() - start < 600) requestAnimationFrame(step); else resolve(seen);
      };
      requestAnimationFrame(step);
    }));
  };
  const read = async () => {
    const graph = page.locator('.start-card-graph');
    await expect(graph.locator('.react-flow__node').first()).toBeVisible();
    await page.waitForTimeout(800);
    return graph.evaluate((el) => {
      const centre = (r) => Math.round((r.x + r.width / 2) * 1000) / 1000;
      return {
        nodes: [...el.querySelectorAll('.react-flow__node')].map((node) => centre(node.getBoundingClientRect())),
        edges: [...el.querySelectorAll('.react-flow__edge-path')].map((path) => ({ x: centre(path.getBoundingClientRect()), d: path.getAttribute('d') })),
      };
    });
  };
  await page.goto(P43B_PATHS.project);
  say('as-run transform', await open());
  say('as-run', await read());
  await page.reload();
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
  say('no-motion transform', await open());
  say('no-motion', await read());
});
