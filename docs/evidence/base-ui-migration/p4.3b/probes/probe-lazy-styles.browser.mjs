import { test, expect } from './harness.mjs';
import { EMPTY_GRAPH, P43B_PATHS, installP43bFixtures } from './p43b-fixtures.mjs';
import { PILOT_PATHS, installPilotFixtures } from './pilot-fixtures.mjs';

// Probe: the page once the lazy dependency graphs have loaded, on this tree (production build) — the
// stylesheets in document order (linked files by stem, the hash dropped; inline <style> elements counted),
// and the computed styles of what the lazily loaded stylesheets draw: React Flow's canvas, pane, viewport,
// an edge and its zoom controls (TaskDependencyGraph-*.css), the graph's own marks, and the project graph's
// empty state (ProjectDependencyGraph-*.css on the delivery: Orbit's Empty). For the coordinator's
// 2026-10-09 question: do lazily loaded parts keep their styles now that the first page has one stylesheet.
const PROPS = ['display', 'position', 'overflow', 'zIndex', 'cursor', 'transformOrigin', 'stroke', 'strokeWidth', 'fill',
  'boxShadow', 'backgroundColor', 'borderBottom', 'borderRadius', 'width', 'height', 'color', 'fontSize', 'lineHeight',
  'textAlign', 'padding', 'margin'];

const snapshot = (page, targets) => page.evaluate(({ targets, props }) => {
  const sheets = [];
  let inline = 0;
  for (const sheet of document.styleSheets) {
    if (sheet.href) sheets.push(new URL(sheet.href).pathname.replace(/^\/assets\//u, '').replace(/-[\w-]{8}\.css$/u, '.css'));
    else inline += 1;
  }
  const styles = {};
  for (const [label, selector] of Object.entries(targets)) {
    const el = document.querySelector(selector);
    if (!el) { styles[label] = null; continue; }
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    styles[label] = { ...Object.fromEntries(props.map((p) => [p, s[p]])), box: [Math.round(r.width), Math.round(r.height)] };
  }
  return { sheets, inline, styles };
}, { targets, props: PROPS });

const log = (testInfo, what, value) => console.log(`PROBE ${process.env.TREE} ${testInfo.project.name} ${what} ${JSON.stringify(value)}`);

test('the project graph, loaded lazily: stylesheets and computed styles', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  const fixtures = await installP43bFixtures(page);
  await page.goto(P43B_PATHS.project);
  const strip = page.getByTestId('project-dependency-graph');
  await expect(strip.locator('.pdg-task').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const graph = '[data-testid="project-dependency-graph"]';
  log(testInfo, 'project graph', await snapshot(page, {
    canvas: `${graph} .react-flow`, pane: `${graph} .react-flow__pane`, viewport: `${graph} .react-flow__viewport`,
    edge: `${graph} .react-flow__edge-path`, controls: `${graph} .react-flow__controls`, zoom: `${graph} .react-flow__controls-button`,
    task: `${graph} .pdg-task`, fold: `${graph} .pdg-fold`, maximize: `${graph} .tdg-maximize`,
  }));
  fixtures.state.graph = EMPTY_GRAPH;
  await page.reload();
  const empty = page.getByText('No tasks to draw yet', { exact: true });
  await expect(empty).toBeVisible();
  log(testInfo, 'project graph empty', await snapshot(page, {
    empty: '.orbit-empty, .ant-empty', image: '.orbit-empty-image, .ant-empty-image', description: '.orbit-empty-description, .ant-empty-description',
  }));
});

test('a task graph, loaded lazily: stylesheets and computed styles', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installPilotFixtures(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(PILOT_PATHS.task);
  await expect(page.locator('.tdg-canvas .tdg-node').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  log(testInfo, 'task graph', await snapshot(page, {
    canvas: '.tdg-canvas .react-flow', pane: '.tdg-canvas .react-flow__pane', viewport: '.tdg-canvas .react-flow__viewport',
    edge: '.tdg-canvas .react-flow__edge-path', zoom: '.tdg-canvas .react-flow__controls-button', node: '.tdg-canvas .tdg-node',
    maximize: '.tdg-maximize',
  }));
});
