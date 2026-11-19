// Frames for the "Landings like the chat" board, shot from the real web app at this worktree:
//   unshare -n ./run-ns.sh capture.mjs [scene…]
// Each scene writes shots/<scene>.png (2x) of the session pane, and its marks' boxes into marks.json.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { launch, open, settle, K } from './lib.mjs';
import { proposal } from './proposal4.mjs';
import { PATHS, FIXED_NOW } from '/root/.orbit/worktrees/01a1c548-51fd-7597-8625-78f9a70996c3/src/web/ui-migration/fixtures.mjs';

const only = process.argv.slice(2);
const marksFile = `${K}/marks.json`;
const marks = existsSync(marksFile) ? JSON.parse(readFileSync(marksFile, 'utf8')) : {};
const SID = PATHS.session.split('/').pop();
const handler = (req, url) => (req.method() === 'GET' && url.pathname === `/api/sessions/${SID}/events/page`)
  ? { events: [{ seq: 1, type: 'assistant', payload: { text: '…' }, turnId: 't', ts: FIXED_NOW }, { seq: 2, type: 'turn_end', payload: {}, turnId: 't', ts: FIXED_NOW }], hasMore: false }
  : undefined;

const paneBox = (page) => page.evaluate(() => {
  const r = document.querySelector('.workspace-view').getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
});

const browser = await launch();
for (const [name, scene] of Object.entries(proposal.scenes)) {
  if (only.length && !only.includes(name)) continue;
  try {
    const { page, errors, context } = await open(browser, { path: PATHS.session, width: 1700, height: scene.height ?? 1000, handler });
    await page.waitForSelector('.workspace-view .chat-assistant');
    await page.waitForTimeout(500);
    await page.addStyleTag({ content: proposal.css });
    await page.evaluate(proposal.inject, { html: scene.html, foot: proposal.foot, sub: proposal.sub });
    await settle(page);
    await page.waitForTimeout(300);
    await page.evaluate(() => { const b = document.querySelector('.workspace-view .workspace-sessions'); b.scrollTop = b.scrollHeight; });
    await settle(page);
    const clip = await paneBox(page);
    await page.screenshot({ path: `${K}/shots/${name}.png`, clip });
    marks[name] = { clip, boxes: await page.evaluate((clip) => Object.fromEntries([...document.querySelectorAll('[data-mk]')].map((el) => {
      const r = el.getBoundingClientRect();
      return [el.dataset.mk, { x: Math.round(r.left - clip.x), y: Math.round(r.top - clip.y), w: Math.round(r.width), h: Math.round(r.height) }];
    })), clip) };
    writeFileSync(marksFile, JSON.stringify(marks, null, 1));
    console.log('shot', name, JSON.stringify(clip), errors.length ? errors.slice(0, 3) : '');
    await context.close();
  } catch (error) {
    console.log('FAILED', name, error.message.split('\n')[0]);
  }
}
await browser.close();
