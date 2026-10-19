export default async function (page) {
  const back = page.locator('.workspace-back, .session-pane-back, button[aria-label^="Back"]').first();
  await back.tap();
  await page.waitForTimeout(500);
  const demo = page.locator('.session-col .session-row').filter({ hasText: 'Demo for the design review' }).first();
  const box = await demo.boundingBox();
  await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    const touch = new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y });
    target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
    window.__held = { target, touch };
  }, { x: box.x + 120, y: box.y + box.height / 2 });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const { target, touch } = window.__held;
    target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [touch] }));
  });
  await page.waitForTimeout(500);
}
