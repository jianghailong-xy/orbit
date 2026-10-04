import { test, expect } from '@playwright/test';

async function appearance(control) {
  return control.evaluate((element) => {
    const texts = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim()) continue;
      const style = getComputedStyle(node.parentElement);
      let opacity = 1;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const ancestor = getComputedStyle(parent);
        opacity *= Number(ancestor.opacity);
        if (ancestor.display === 'none' || ancestor.visibility === 'hidden') opacity = 0;
      }
      if (!opacity) continue;
      texts.push({ text: node.textContent, color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight, opacity });
    }
    return texts;
  });
}

for (const kind of ['expiry', 'account', 'search']) test(`${kind} dims the current value while open and restores it on Escape`, async ({ page }, info) => {
  const samples = {};
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const system of ['antd', 'orbit']) {
    await page.goto(`/ui-migration/choices.html?sample=${kind}&system=${system}`);
    await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
    await page.evaluate(() => document.fonts.ready);
    const region = page.getByRole('region', { name: 'Appearance sample' });
    const choice = region.getByRole('combobox');
    const control = page.locator('.sample-choice');
    samples[system] = { closed: await appearance(control) };
    await choice.click();
    await expect(page.locator('.sample-surface:visible')).toBeVisible();
    samples[system].open = await appearance(control);
    await info.attach(`${system}-${kind}-open-value`, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    await page.keyboard.press('Escape');
    await expect(choice).toHaveAttribute('aria-expanded', 'false');
    await expect(choice).toBeFocused();
    samples[system].restored = await appearance(control);
  }
  await info.attach('open-value', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
  expect(samples.orbit).toEqual(samples.antd);
  expect(samples.orbit.closed).toHaveLength(1);
  expect(samples.orbit.open).toHaveLength(1);
  expect(samples.orbit.closed[0].opacity).toBe(1);
  expect(samples.orbit.open[0].opacity).toBe(.25);
  expect(samples.orbit.restored).toEqual(samples.orbit.closed);
  expect(errors).toEqual([]);
});
