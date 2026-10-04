import { test, expect } from './harness.mjs';
import { sessionScenarios } from './session-scenarios.mjs';

// Replay the existing production scenario without changing any P0 screenshot
// assertion. This focused run reaches the notification even when an unrelated
// earlier P0 session screenshot differs; its full PNG is retained for comparison.
test('P2.3 production notification compatibility', async ({ evidence }, info) => {
  await sessionScenarios({ ...evidence, capture: async (name) => {
    if (name !== 'notification-error') return;
    const { page } = evidence;
    const region = page.getByRole('region', { name: 'Notifications', exact: true });
    await expect(region).toBeVisible();
    const appearance = await region.evaluate((el) => {
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      return { region: r.toJSON(), viewport: { width: innerWidth, height: innerHeight },
        style: { fontFamily: s.fontFamily, fontSize: s.fontSize, lineHeight: s.lineHeight, zIndex: s.zIndex },
        card: [...el.querySelectorAll('.toast')].map((card) => {
          const style = getComputedStyle(card);
          return { rect: card.getBoundingClientRect().toJSON(), background: style.background, border: style.border, shadow: style.boxShadow, color: style.color };
        }) };
    });
    await info.attach('notification-appearance', { body: JSON.stringify(appearance, null, 2), contentType: 'application/json' });
    await info.attach('production-notification', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
  } });
});
