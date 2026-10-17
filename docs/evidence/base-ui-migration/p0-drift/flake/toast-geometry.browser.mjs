import { test, expect } from './harness.mjs';
import { PATHS } from './fixtures.mjs';

// b-class evidence for the success pill in the P0 settings-saved / profile-validation captures:
// the same steps as page-scenarios.mjs up to each capture, then the pill's geometry and the
// computed styles that decide where and how it is painted.
async function pill(page, text) {
  return page.evaluate((t) => {
    const copy = [...document.querySelectorAll('section[aria-label="Notifications"] *')].find((el) => el.children.length === 0 && el.textContent === t);
    const card = copy?.closest('.toast');
    const section = card?.closest('section[aria-label="Notifications"]');
    const layer = section?.parentElement;
    const style = (el, keys) => el ? Object.fromEntries(keys.map((k) => [k, getComputedStyle(el)[k]])) : null;
    return {
      card: card && { className: card.className, rect: card.getBoundingClientRect().toJSON(),
        style: style(card, ['willChange', 'transform', 'position', 'left', 'right', 'width', 'height', 'borderRadius', 'boxShadow', 'backgroundColor', 'opacity', 'animationName', 'animationDelay']) },
      text: copy && { rect: copy.getBoundingClientRect().toJSON(), style: style(copy, ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color']) },
      section: section && { className: section.className, inlineStyle: section.getAttribute('style'), rect: section.getBoundingClientRect().toJSON(),
        style: style(section, ['position', 'left', 'right', 'top', 'width', 'zIndex', 'transform']) },
      host: layer && { tag: layer.tagName, className: layer.className, popover: layer.getAttribute('popover'),
        topLayer: (() => { try { return layer.matches(':popover-open'); } catch { return false; } })(), parent: layer.parentElement?.tagName },
      viewport: { innerWidth, clientWidth: document.documentElement.clientWidth },
    };
  }, text);
}

test('success pill geometry: settings-saved', async ({ evidence }, info) => {
  const { page } = evidence;
  await page.goto(PATHS.settings);
  await expect(page.getByText('Default permission mode', { exact: true })).toBeVisible();
  await page.getByRole('switch').first().click();
  const region = page.getByRole('region', { name: 'Notifications', exact: true });
  await expect(region.getByText('Setting saved', { exact: true })).toBeVisible();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await info.attach('pill', { body: JSON.stringify(await pill(page, 'Setting saved'), null, 2), contentType: 'application/json' });
});

test('success pill geometry: profile-validation', async ({ evidence }, info) => {
  const { page } = evidence;
  await page.goto(PATHS.profile);
  const save = page.getByRole('button', { name: /^(?:loading )?Save$/ });
  await expect(save).toBeDisabled();
  await page.locator('input[autocomplete="name"]').fill('Baseline Reviewer Updated');
  await save.click();
  const region = page.getByRole('region', { name: 'Notifications', exact: true });
  await expect(region.getByText('Name saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByText('Enter a new password', { exact: true })).toBeVisible();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await info.attach('pill', { body: JSON.stringify(await pill(page, 'Name saved'), null, 2), contentType: 'application/json' });
});
