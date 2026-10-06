import { test as base, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { installFixtures, installFixedDate } from './fixtures.mjs';

export { expect };
export const test = base.extend({
  scenario: ['default', { option: true }],
  evidence: async ({ page, scenario }, use, testInfo) => {
    const theme = testInfo.project.use.colorScheme;
    await installFixedDate(page);
    const api = await installFixtures(page, { theme, scenario });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const measurements = { project: testInfo.project.name, test: testInfo.title, browser: page.context().browser().version(), captures: [], timings: [] };
    async function measure(name, operation) {
      const start = performance.now();
      const result = await operation();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const end = performance.now();
      measurements.timings.push({ name, elapsedMs: end - start });
      return result;
    }
    async function capture(name, selectors = {}) {
      await page.evaluate(() => document.fonts.ready);
      for (const selector of Object.values(selectors)) {
        const locator = typeof selector === 'string' ? page.locator(selector).first() : selector;
        await expect(locator).toBeVisible();
        // Visibility alone accepts opacity:0 during an overlay's prepare phase.
        await expect.poll(() => locator.evaluate((el) => {
          for (let node = el; node; node = node.parentElement) {
            if (Number(getComputedStyle(node).opacity) < 1) return false;
          }
          return true;
        }), { message: `${name}: selected content has finished fading in` }).toBe(true);
      }
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      // Screenshot assertion waits for two identical frames. No visual masking or custom CSS.
      await expect(page).toHaveScreenshot(`${name}.png`);
      const styles = await page.evaluate(() => {
        const properties = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color', 'backgroundColor', 'border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'borderRadius', 'boxShadow', 'outline', 'outlineOffset', 'padding', 'gap', 'display', 'position', 'zIndex', 'transitionDuration', 'animationDuration'];
        const controls = [...document.querySelectorAll('h1,h2,h3,button,input,textarea,[role="button"],[role="combobox"],[role="switch"],[role="dialog"],[role="menu"],.toast-card')].filter((el) => el.getBoundingClientRect().width && el.getBoundingClientRect().height && getComputedStyle(el).visibility !== 'hidden');
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        context.font = `14px ${getComputedStyle(document.body).fontFamily}`;
        const glyphProbe = { text: 'Orbit baseline 0123 — 中文输入', font: context.font, width: context.measureText('Orbit baseline 0123 — 中文输入').width };
        return {
          glyphProbe,
          viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale, touch: navigator.maxTouchPoints },
          navigation: performance.getEntriesByType('navigation').map((entry) => entry.toJSON()),
          paint: performance.getEntriesByType('paint').map((entry) => entry.toJSON()),
          theme: document.documentElement.dataset.theme,
          tokens: Object.fromEntries(['--bg-base', '--bg-raised', '--text-1', '--text-2', '--border', '--brand'].map((name) => [name, getComputedStyle(document.documentElement).getPropertyValue(name).trim()])),
          documentWidth: document.documentElement.scrollWidth,
          graphGeometry: [...document.querySelectorAll('[data-testid="project-dependency-graph"],.pdg-task')].map((el) => ({ label: el.matches('.pdg-task') ? el.textContent : 'graph', ...el.getBoundingClientRect().toJSON() })),
          media: Object.fromEntries([600,640,960].map((width) => [width, matchMedia(`(max-width: ${width}px)`).matches])),
          controls: controls.map((el) => { const rect = el.getBoundingClientRect(), style = getComputedStyle(el); return {
            tag: el.tagName, role: el.getAttribute('role'), label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent?.trim().slice(0, 100),
            disabled: el.matches(':disabled'), focused: el === document.activeElement, hovered: el.matches(':hover'),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            style: Object.fromEntries(properties.map((key) => [key, style[key]])),
          }; }),
        };
      });
      if (testInfo.project.use.browserName === 'chromium') {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('DOM.enable');
        await cdp.send('CSS.enable');
        const { root } = await cdp.send('DOM.getDocument');
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.tdp-title, h1, .chat-assistant p' });
        if (nodeId) styles.renderedFonts = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
        await cdp.detach();
      }
      expect(styles.viewport.dpr).toBe(1);
      expect(styles.viewport.scale).toBe(1);
      expect(styles.viewport.width).toBe(page.viewportSize().width);
      expect(styles.theme).toBe(theme);
      const selected = {};
      for (const [label, selector] of Object.entries(selectors)) {
        const locator = typeof selector === 'string' ? page.locator(selector).first() : selector;
        await expect(locator).toBeVisible();
        selected[label] = await locator.evaluate((el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return { width: r.width, height: r.height, fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight, color: s.color, background: s.backgroundColor, border: s.border, radius: s.borderRadius, shadow: s.boxShadow }; });
      }
      measurements.captures.push({ name, ...styles, selected });
    }
    try {
      await use({ page, expect, capture, measure, api, measurements });
      api.assertHandled();
      expect(pageErrors, 'No unhandled errors in the real application').toEqual([]);
    } finally {
      const path = testInfo.outputPath('evidence.json');
      writeFileSync(path, JSON.stringify({ ...measurements, requests: api.requests, unhandled: api.unhandled, pageErrors }, null, 2) + '\n');
      await testInfo.attach('computed-styles-and-timings', { path, contentType: 'application/json' });
    }
  },
});
