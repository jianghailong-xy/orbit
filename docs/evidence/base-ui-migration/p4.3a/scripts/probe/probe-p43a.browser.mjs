import { appendFileSync } from 'node:fs';
import { test, expect } from './harness.mjs';
import { P43A_PATHS, installP43aFixtures } from './p43a-fixtures.mjs';

// One-off measurement probe (not part of the delivery): boxes and computed styles of the parts the
// same-commit comparison found differing, read the same way on both trees.
const OUT = process.env.PROBE_OUT;
const TREE = process.env.TREE;
const box = (locator) => locator.evaluate((el, pseudo) => {
  const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
  return { x: r.x, y: r.y, w: r.width, h: r.height, fontSize: s.fontSize, lineHeight: s.lineHeight, color: s.color, bg: s.backgroundColor,
    margin: s.margin, padding: s.padding, radius: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].join(' '),
    border: s.border, textAlign: s.textAlign, display: s.display, verticalAlign: s.verticalAlign, cls: el.className?.baseVal ?? el.className };
});
const record = (testInfo, name, value) => appendFileSync(OUT, JSON.stringify({ tree: TREE, env: testInfo.project.name, name, value }) + '\n');

test('probe', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  const fixtures = await installP43aFixtures(page);
  const phone = !!testInfo.project.use.isMobile;
  await page.goto(P43A_PATHS.project);
  const card = page.getByRole('region', { name: 'Coordinator' });
  const caret = card.getByRole('button', { name: /More coordinator actions/ });
  await expect(caret).toBeVisible();
  record(testInfo, 'caret', await box(caret));
  record(testInfo, 'caret-svg', await box(caret.locator('svg')));
  record(testInfo, 'caret-icon', await box(caret.locator('.anticon').first()));
  record(testInfo, 'lead', await box(card.getByRole('button', { name: /Reply to coordinator/ })));
  await caret.click();
  await page.waitForTimeout(600);
  record(testInfo, 'caret-open', await box(caret));

  if (phone) {
    await page.keyboard.press('Escape');
    const acceptance = page.locator('[data-project-block="acceptance-criteria"]');
    await acceptance.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    const parts = async (step) => {
      for (const [name, sel] of [['card', '.orbit-card, .ant-card'], ['head', '.orbit-card-head, .ant-card-head'], ['title', '.orbit-card-title, .ant-card-head-title'],
        ['standing', '.acceptance-standing'], ['row1', '.acceptance-row >> nth=0'], ['row2', '.acceptance-row >> nth=1'], ['more', '.acceptance-more'],
        ['moreButton', '.acceptance-more-button'], ['method', '.acceptance-method-body'], ['toggle', '.acceptance-method-toggle >> nth=0']]) {
        const l = acceptance.locator(sel).first();
        if (await l.count()) record(testInfo, `acceptance-${step}-${name}`, await box(l));
      }
      record(testInfo, `acceptance-${step}-scrollY`, await page.evaluate(() => scrollY));
    };
    await parts('before');
    await acceptance.getByRole('button', { name: "How it's checked" }).first().click();
    await page.waitForTimeout(400);
    await parts('after');
  }

  await page.goto(`${P43A_PATHS.createdIn}`);
  const chip = page.locator('.tasks-createdin');
  await expect(chip).toBeVisible();
  record(testInfo, 'chip', await box(chip));
  record(testInfo, 'chip-close', await box(chip.getByRole('button', { name: 'Remove this filter' })));
  record(testInfo, 'chip-close-svg', await box(chip.locator('svg').last()));

  await page.goto(P43A_PATHS.tasks);
  await page.locator('.tasks-scope-trigger').click();
  await page.waitForTimeout(500);
  const menu = page.getByRole('menu').filter({ visible: true }).last();
  record(testInfo, 'menu', await box(menu));
  const wave = page.getByRole('menuitem', { name: /^UI migration wave 1/ });
  record(testInfo, 'menu-item-wave', await box(wave));
  record(testInfo, 'menu-item-wave-row', await box(wave.locator('.tasks-scope-row')));
  record(testInfo, 'menu-item-all', await box(page.getByRole('menuitem', { name: /^All tasks/ })));
  await page.keyboard.press('Escape');

  const labels = page.locator('.tasks-labelfilter');
  await labels.click();
  await page.waitForTimeout(500);
  const option = page.locator('[role="option"], .ant-select-item-option').filter({ visible: true }).filter({ hasText: /^ui-migration/ }).first();
  record(testInfo, 'label-option', await box(option));
  record(testInfo, 'label-option-name', await box(option.locator('.tasks-labelopt-name')));
  record(testInfo, 'label-option-count', await box(option.locator('.tasks-labelopt-count')));
  record(testInfo, 'label-opt', await box(option.locator('.tasks-labelopt')));
  await page.keyboard.press('Escape');

  await page.locator('.task-row').filter({ hasText: 'Review keyboard focus order' }).getByRole('checkbox').click();
  await page.locator('.tasks-bulkbar').getByRole('button', { name: /Set assignee$/ }).click();
  const assign = page.locator('[role="dialog"]').filter({ hasText: 'Set assignee' }).last();
  await assign.getByRole('combobox').click();
  await page.waitForTimeout(500);
  record(testInfo, 'assign-field', await box(assign.locator('.orbit-select, .ant-select').first()));
  const first = page.locator('[role="option"], .ant-select-item-option').filter({ visible: true }).first();
  record(testInfo, 'assign-first-option', await box(first));
  record(testInfo, 'assign-list', await box(page.locator('.orbit-select-popup, .ant-select-dropdown').filter({ visible: true }).last()));
  await fixtures.state;
});
