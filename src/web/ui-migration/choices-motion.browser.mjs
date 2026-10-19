import { test, expect } from '@playwright/test';

const fixture = '/ui-migration/choices.html';
const surface = '.sample-surface';
const errors = new WeakMap();
test.beforeEach(async ({ page }) => {
  errors.set(page, []);
  page.on('pageerror', (error) => errors.get(page).push(error.message));
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) await info.attach('motion-diagnostic', {
    body: JSON.stringify(await page.evaluate(() => ({ url: location.href, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      records: window.choiceMotion?.records, observations: window.choiceMotion?.observations })), null, 2), contentType: 'application/json',
  });
  expect(errors.get(page)).toEqual([]);
});

async function arm(page, selector = surface, midpoint = false) {
  await page.evaluate(({ selector, midpoint }) => {
    const state = { records: [], observations: [], active: true, animations: new Set() };
    window.choiceMotion = state;
    const sample = () => {
      if (state.observations.length < 32 && document.querySelector(selector)) state.observations.push({
        nodes: [...document.querySelectorAll(selector)].map((node) => ({ attributes: Object.fromEntries([...node.attributes].map((a) => [a.name, a.value])),
          animation: getComputedStyle(node).animationName, display: getComputedStyle(node).display, opacity: getComputedStyle(node).opacity })),
        animations: document.getAnimations().map((animation) => ({ name: animation.animationName, constructor: animation.constructor.name,
          target: animation.effect?.target?.className, state: animation.playState, time: animation.currentTime })),
      });
      for (const animation of document.getAnimations()) {
        const node = animation.effect?.target;
        if (animation.constructor.name !== 'CSSAnimation' || animation.playState === 'finished'
          || !node || !(node.matches(selector) || node.querySelector(selector)) || state.animations.has(animation)) continue;
        state.animations.add(animation);
        const style = getComputedStyle(node);
        if (midpoint) {
          animation.pause();
          animation.currentTime = animation.effect.getTiming().duration / 2;
        }
        state.records.push({ name: animation.animationName, duration: animation.effect.getTiming().duration,
          frames: animation.effect.getKeyframes(), origin: style.transformOrigin, filter: style.filter,
          side: node.getAttribute('data-side'), opacity: style.opacity, samples: [] });
      }
      for (const [index, animation] of [...state.animations].entries()) {
        if (animation.playState === 'finished' || animation.playState === 'idle') continue;
        const node = animation.effect.target;
        const box = node.getBoundingClientRect();
        state.records[index].samples.push({ time: animation.currentTime, opacity: getComputedStyle(node).opacity,
          connected: node.isConnected, box: { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height } });
      }
    };
    // Capture registration as well as painted frames. A frame-only observer can
    // miss a short WebKit animation while a navigation/interaction is settling.
    state.started = sample;
    document.addEventListener('animationstart', state.started, true);
    const frame = () => {
      sample();
      if (state.active) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, { selector, midpoint });
}

async function resumeAfterShot(page, info, name) {
  await page.waitForFunction(() => window.choiceMotion.records.length > 0);
  await info.attach(name, { body: await page.screenshot({ animations: 'allow' }), contentType: 'image/png' });
  await page.evaluate(() => { for (const animation of window.choiceMotion.animations) animation.play(); });
}

async function capture(page) {
  await page.waitForFunction(() => window.choiceMotion.records.length > 0);
  // Unmount can cancel a CSSAnimation. Reading its newly replaced `finished`
  // promise afterward can wait indefinitely; observe its terminal state instead.
  await page.waitForFunction(() => [...window.choiceMotion.animations].every((animation) =>
    animation.playState === 'finished' || animation.playState === 'idle'));
  return page.evaluate(() => {
    const state = window.choiceMotion;
    state.active = false;
    document.removeEventListener('animationstart', state.started, true);
    [...state.animations].forEach((animation, index) => { state.records[index].endState = animation.playState; });
    return state.records;
  });
}

async function open(page, kind) {
  const region = page.getByRole('region', { name: 'Appearance sample' });
  if (['expiry', 'search', 'multiple'].includes(kind)) await region.getByRole('combobox').click();
  else if (kind === 'tooltip') await region.getByRole('button').hover();
  else await region.getByRole('button').click();
}

const directions = [
  { name: 'bottom', query: '', side: 'bottom' },
  { name: 'top', query: '&side=top&anchor=bottom', side: 'top' },
  { name: 'flipped', query: '&anchor=bottom', side: 'top' },
];
for (const kind of ['attachment', 'expiry', 'search', 'multiple', 'popover', 'tooltip']) for (const direction of directions) {
  test(`normal ${direction.name} entrance and exit motion of ${kind} stays in view`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const samples = {};
    await page.goto(`${fixture}?sample=${kind}${direction.query}`);
    await page.evaluate(() => document.fonts.ready);
    await arm(page, surface, direction.name === 'bottom');
    await open(page, kind);
    await expect(page.locator(`${surface}:visible`)).toBeVisible();
    if (direction.name === 'bottom') await resumeAfterShot(page, info, 'orbit-enter-midpoint');
    samples.orbit = { enter: await capture(page) };
    await expect(page.locator(`${surface}:visible`)).toBeVisible();
    await expect(page.locator(surface)).toHaveAttribute('data-side', direction.side);
    await arm(page, surface, direction.name === 'bottom');
    if (kind === 'tooltip') await page.mouse.move(0, 0);
    else await page.mouse.click(3, 60);
    if (direction.name === 'bottom') await resumeAfterShot(page, info, 'orbit-exit-midpoint');
    samples.orbit.exit = await capture(page);
    await expect(page.locator(`${surface}:visible`)).toHaveCount(0);
    await info.attach('motion', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
    const viewport = page.viewportSize();
    for (const phase of ['enter', 'exit']) for (const record of samples.orbit[phase]) for (const frame of record.samples) {
      expect(frame.connected).toBe(true);
      expect(frame.box.x).toBeGreaterThanOrEqual(0);
      expect(frame.box.y).toBeGreaterThanOrEqual(0);
      expect(frame.box.right).toBeLessThanOrEqual(viewport.width);
      expect(frame.box.bottom).toBeLessThanOrEqual(viewport.height);
    }
  });
}

for (const kind of ['popover', 'tooltip']) for (const align of ['center', 'end']) test(`${kind} ${align} zoom runs its entrance and exit`, async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const samples = {};
  await page.goto(`${fixture}?sample=${kind}&align=${align}&anchor=${align === 'end' ? 'right' : 'center'}`);
  await page.evaluate(() => document.fonts.ready);
  await arm(page);
  await open(page, kind);
  samples.orbit = { enter: await capture(page) };
  await arm(page);
  if (kind === 'tooltip') await page.mouse.move(0, 0);
  else await page.mouse.click(3, 60);
  samples.orbit.exit = await capture(page);
  await expect(page.locator(`${surface}:visible`)).toHaveCount(0);
  await info.attach('motion', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
});

for (const anchor of ['left', 'right']) test(`submenu ${anchor} edge zoom stays in view`, async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const samples = {};
  await page.goto(`${fixture}?sample=submenu&anchor=${anchor}`);
  await page.evaluate(() => document.fonts.ready);
  await arm(page);
  await open(page, 'submenu');
  await capture(page);
  const selector = '.orbit-menu[data-nested]';
  await arm(page, selector);
  await page.getByRole('menuitem', { name: 'Provider' }).hover();
  await expect(page.getByRole('menuitem', { name: 'Codex' })).toBeVisible();
  samples.orbit = { enter: await capture(page) };
  const box = await page.locator(selector).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
  await expect(page.locator(selector)).toHaveAttribute('data-side', anchor === 'right' ? 'left' : 'right');
  await arm(page, selector);
  await page.mouse.click(3, 60);
  samples.orbit.exit = await capture(page);
  await expect(page.getByRole('menuitem', { name: 'Codex' })).toHaveCount(0);
  await info.attach('motion', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
});
