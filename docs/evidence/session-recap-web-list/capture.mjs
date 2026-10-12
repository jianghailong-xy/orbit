// The session list's recap rows on the real WorkspaceView: one session the server has recapped,
// one with only a last reply, one working. Light and dark, each a whole window and the list column
// alone; shots/report.json carries what every row's line read, and the run fails if any of them
// reads as anything else.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECAP_TEXT, REPLY, launch, open, settle, serveDist } from './lib.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'shots');
mkdirSync(OUT, { recursive: true });
const stop = await serveDist();

const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); };
const expectations = {
  'Recap on the session list row': `Recap · 5:38 PM ${RECAP_TEXT}`,
  'Drawer shadow fix': REPLY.lastAssistantText,
  'Rebuilding the transcript page': 'Running task_create…',
};

const report = {};
for (const theme of ['light', 'dark']) {
  const browser = await launch();
  try {
    const { page, errors } = await open(browser, { theme });
    await page.locator('.session-row').first().waitFor();
    await page.waitForTimeout(1500);
    await settle(page);
    const rows = await page.evaluate(() => [...document.querySelectorAll('.session-row')].map((el) => ({
      title: el.querySelector('.session-title')?.textContent ?? null,
      line: el.querySelector('.session-preview')?.textContent ?? null,
      label: el.querySelector('.session-preview-label')?.textContent ?? null,
    })));
    report[theme] = { rows, errors };
    for (const [title, line] of Object.entries(expectations)) {
      const row = rows.find((r) => r.title === title);
      check(!!row, `${theme}: no row titled ${title}`);
      if (row) check(row.line === line, `${theme}: "${title}" reads ${JSON.stringify(row.line)}, wanted ${JSON.stringify(line)}`);
    }
    const recapped = rows.find((r) => r.title === 'Recap on the session list row');
    const plain = rows.find((r) => r.title === 'Drawer shadow fix');
    check(recapped?.label === 'Recap · 5:38 PM', `${theme}: recap label reads ${JSON.stringify(recapped?.label)}`);
    check(plain?.label === null, `${theme}: the reply-only row carries a label: ${JSON.stringify(plain?.label)}`);
    await page.screenshot({ path: `${OUT}/${theme}-full.png` });
    await page.locator('.workspace-sessions.session-col-list').first()
      .screenshot({ path: `${OUT}/${theme}-list.png` });
    console.log(theme, 'ok', errors.length ? `page errors: ${errors.join(' | ')}` : '');
    for (const row of rows) console.log(`  ${row.title}: ${JSON.stringify(row.line)}`);
  } finally {
    await browser.close();
  }
}
writeFileSync(`${OUT}/report.json`, JSON.stringify({ report, problems }, null, 1));
await stop();
if (problems.length) {
  console.error('FAILED:\n' + problems.join('\n'));
  process.exit(1);
}
console.log('all rows read as expected');
