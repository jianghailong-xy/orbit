// Runs the apps' drawing lines (WikiDiagram.swift's, between its marks) as the Android page runs them, in Chromium or WebKit.
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { KIT, browser, page } from '../scripts/lib.mjs';

const [root, kind = 'chromium'] = process.argv.slice(2);
const swift = readFileSync(join(root, 'src/macos/OrbitApp/Sources/OrbitApp/Views/WikiDiagram.swift'), 'utf8');
const start = '        // wiki diagram drawing: from here', end = '        // wiki diagram drawing: to here';
const draw = swift.slice(swift.indexOf(start), swift.indexOf(end) + end.length);
const diagrams = { ...JSON.parse(readFileSync(join(KIT, 'diagrams.json'), 'utf8')), groups: JSON.parse(readFileSync(join(KIT, 'diagrams-groups.json'), 'utf8')).stored };
const out = join(KIT, 'out', `native-${kind}`);
mkdirSync(out, { recursive: true });
const b = await browser(kind);
const results = {};
for (const theme of ['light', 'dark']) {
  const p = await page(b, { theme, width: 360, figureCss: theme === 'dark' ? '.wk-dc-diagram { background: #232426 !important; }' : '' });
  await p.addScriptTag({ content: `async function draw(source, dark, room) {\n${draw}\n}` });
  for (const [name, source] of Object.entries(diagrams)) {
    for (const room of [336, 2000]) {
      const r = await p.evaluate(async ({ source, dark, room }) => {
        document.getElementById('col').innerHTML = '<figure class="wk-dc-diagram"><div id="figure"></div></figure>';
        const size = await draw(source, dark, room);
        const svg = document.querySelector('#figure > svg');
        return { size, id: svg.id, masks: svg.querySelectorAll('mask').length, masked: svg.querySelectorAll('[mask]').length,
          titles: [...svg.querySelectorAll('g.cluster-label')].map((t) => t.getAttribute('transform')) };
      }, { source, dark: theme === 'dark', room });
      results[`${name}-${theme}-${room}`] = r;
      if (room === 336) await p.locator('#figure').screenshot({ path: join(out, `${name}-${theme}.png`) });
    }
  }
  await p.close();
}
await b.close();
for (const [k, v] of Object.entries(results)) console.log(k, JSON.stringify(v));
