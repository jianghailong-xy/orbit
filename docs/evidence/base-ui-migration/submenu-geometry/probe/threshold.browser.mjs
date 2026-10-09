import { test, expect } from '@playwright/test';

// Probe: where the submenu starts to flip. The sample (fixed, anchor=center) is moved so that its parent menu's
// Provider item ends a whole number of pixels before the layout viewport's right edge, across the point where the
// short submenu no longer fits; each system's side and box are recorded at each position. Records; asserts nothing.
const fixture = '/ui-migration/choices.html';
test.use({ trace: 'off' });
const press = (info, locator) => info.project.use.hasTouch ? locator.tap() : locator.click();
const surfaces = { orbit: '.orbit-menu[data-nested]',
  antd: '.ant-dropdown-menu-submenu-popup:not(.ant-dropdown-menu-submenu-hidden) .ant-dropdown-menu-sub' };

async function still(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const moving = /-(appear|enter|leave)\b/;
    let last = '';
    for (let count = 0; count < 120; count += 1) {
      await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const boxes = JSON.stringify([...document.querySelectorAll('[role="menu"], [aria-label="Appearance sample"] button')].map((node) => node.getBoundingClientRect()));
      if (boxes === last && document.getAnimations().every((animation) => animation.playState !== 'running')
        && [...document.querySelectorAll('.ant-dropdown, .ant-dropdown-menu-submenu-popup')].every((node) => !moving.test(node.className))) return;
      last = boxes;
    }
  });
}

async function at(page, info, system, left) {
  await page.goto(`${fixture}?sample=submenu&system=${system}&anchor=center`);
  await page.mouse.move(0, 0);
  await page.evaluate(async (left) => {
    document.querySelector('.choices-sample').style.left = `${left}px`;
    scrollTo(0, 1);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    scrollTo(0, 0);
  }, left);
  await still(page);
  await press(info, page.getByRole('region', { name: 'Appearance sample' }).getByRole('button').first());
  const item = page.getByRole('menuitem', { name: 'Provider' });
  await expect(item).toBeVisible();
  await still(page);
  const box = await item.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await expect(page.locator(surfaces[system])).toBeVisible();
  await still(page);
  return page.evaluate((selector) => {
    const round = (value) => Math.round(value * 1000) / 1000;
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.trim() === 'Provider').getBoundingClientRect();
    const sub = [...document.querySelectorAll(selector)].at(-1).getBoundingClientRect();
    return { clientWidth: document.documentElement.clientWidth, visual: round(visualViewport.width),
      item: [round(item.x), round(item.right)], sub: [round(sub.x), round(sub.right), round(sub.width)] };
  }, surfaces[system]);
}

test('flip threshold', async ({ page }, info) => {
  test.setTimeout(1_200_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const width = page.viewportSize().width;
  // The Provider item ends 126.063px after the menu's left edge and the short submenu is 76.375px wide.
  const edge = Math.floor(width - 126.063 - 76.375);
  const record = [];
  for (let left = edge - 12; left <= edge + 4; left += 1) {
    const row = { left };
    for (const system of ['antd', 'orbit']) row[system] = await at(page, info, system, left);
    record.push(row);
  }
  await info.attach('threshold', { body: JSON.stringify(record, null, 1), contentType: 'application/json' });
});
