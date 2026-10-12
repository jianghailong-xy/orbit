export default async function (page) {
  const row = page.locator('.session-col .session-row').filter({ hasText: 'Ship the release notes' }).first();
  await row.locator('.session-icon').hover();
  await page.waitForTimeout(800);
  const samples = await page.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => requestAnimationFrame(r));
      const tip = [...document.querySelectorAll('[role="tooltip"]')].find((el) => el.getBoundingClientRect().width > 0);
      const pos = tip ? (tip.closest('.orbit-floating-positioner') ?? tip.closest('.ant-tooltip') ?? tip) : null;
      const r = pos?.getBoundingClientRect();
      out.push(r ? `${r.x.toFixed(2)},${r.y.toFixed(2)}` : 'none');
    }
    return out;
  });
  console.log('SAMPLES', [...new Set(samples)].join(' | '));
}
