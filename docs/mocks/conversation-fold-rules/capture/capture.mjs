// unshare -n ./run-ns.sh capture.mjs [scene ...] → shots/<name>.png
import { launch, open, plainEvents, coordinatorEvents, settle } from '/var/tmp/fold-rule-mock/lib.mjs';
const OUT = '/var/tmp/fold-rule-mock/shots';
async function clipOf(page) {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.chat-user-wrap, [data-seq]')];
    const first = nodes[0].getBoundingClientRect();
    let bottom = 0, left = 1e9, right = 0;
    for (const n of nodes) { const r = n.getBoundingClientRect(); if (r.height) { bottom = Math.max(bottom, r.bottom); left = Math.min(left, r.left); right = Math.max(right, r.right); } }
    const x = Math.max(0, Math.round(left - 24));
    return { x, y: Math.max(0, Math.round(first.top - 16)), width: Math.min(window.innerWidth - x, Math.round(right - left + 48)), height: Math.round(bottom - first.top + 40) };
  });
}
async function shot(browser, name, opts) {
  const { page, context, errors } = await open(browser, opts);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400); await settle(page);
  const clip = await clipOf(page);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
  console.log(name, JSON.stringify(clip), errors.length ? errors.slice(0, 3) : 'ok');
  await context.close();
}
const P = () => ({ events: plainEvents() });
const C = () => ({ events: coordinatorEvents(), coordinator: true, title: 'Coordinator · Runner link v1' });
const scenes = {
  'p-today': (b) => shot(b, 'p-today', P()),
  'p-job': (b) => shot(b, 'p-job', { ...P(), rules: ['job'] }),
  'p-question': (b) => shot(b, 'p-question', { ...P(), rules: ['question'] }),
  'p-long': (b) => shot(b, 'p-long', { ...P(), rules: ['long'] }),
  'p-last': (b) => shot(b, 'p-last', { ...P(), rules: ['last'] }),
  'c-today': (b) => shot(b, 'c-today', C()),
  'c-job-question': (b) => shot(b, 'c-job-question', { ...C(), rules: ['job', 'question'] }),
  'c-long': (b) => shot(b, 'c-long', { ...C(), rules: ['long'] }),
  'c-last': (b) => shot(b, 'c-last', { ...C(), rules: ['last'] }),
};
const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenes);
const browser = await launch();
try { for (const n of want) await scenes[n](browser); } finally { await browser.close(); }
