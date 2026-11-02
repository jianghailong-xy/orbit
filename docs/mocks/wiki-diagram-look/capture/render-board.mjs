// Renders the board: each section.b-part as board-N.png beside board.html, after its marks are drawn.
// node render-board.mjs <board dir>
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { browser } from './lib.mjs';

const dir = process.argv[2];
const b = await browser();
const p = await b.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
await p.goto(pathToFileURL(join(dir, 'board.html')).href);
await p.waitForLoadState('networkidle');
await p.evaluate(() => Promise.all([...document.images].map((img) => img.decode().catch(() => {}))));
await p.evaluate(() => window.drawMarks());
const parts = await p.locator('section.b-part').count();
for (let i = 0; i < parts; i++) {
  await p.locator('section.b-part').nth(i).screenshot({ path: join(dir, `board-${i + 1}.png`) });
}
await b.close();
console.log(`${parts} parts`);
