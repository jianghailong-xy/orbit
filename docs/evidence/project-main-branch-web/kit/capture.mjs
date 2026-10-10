// The board's frames ②③④⑥⑦⑨⑩ (and ⑪), shot from the real pages of the session's tree with the
// board's own clips (docs/mocks/project-main-branch: capture.mjs), the menu found as the house
// Combobox draws it. Writes shots/<frame>.png at 2x and shots/rects.json (clip + marked rects, CSS px).
// usage: unshare -n ./run-ns.sh capture.mjs [scene…]
import { writeFileSync, readFileSync } from 'node:fs';
import { launch, openStartCard, openProjectPage, rect, BASES } from './lib.mjs';

// The start card at the approved 720 (6bd2990a4, not on main yet), as the board shot it, so the
// frames compare rows rather than widths.
const CARD_720 = '.start-card{max-width:720px}';
const only = process.argv.slice(2);
const rects = {};
const base = BASES.real;
const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/** The rect of `text` inside the first element matching `selector`, across text nodes. */
async function textRect(page, selector, text, nth = 0) {
  return page.locator(selector).first().evaluate((el, [needle, which]) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let all = '';
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push({ node, start: all.length });
      all += node.data;
    }
    let at = -1;
    for (let seen = 0; seen <= which; seen += 1) {
      at = all.indexOf(needle, at + 1);
      if (at < 0) return null;
    }
    const locate = (offset) => {
      const hit = [...nodes].reverse().find((n) => n.start <= offset);
      return [hit.node, offset - hit.start];
    };
    const range = document.createRange();
    range.setStart(...locate(at));
    range.setEnd(...locate(at + needle.length));
    return range.getBoundingClientRect().toJSON();
  }, [text, nth]);
}

function union(...rs) {
  const list = rs.filter(Boolean);
  const x = Math.min(...list.map((r) => r.x));
  const y = Math.min(...list.map((r) => r.y));
  const right = Math.max(...list.map((r) => r.x + r.width));
  const bottom = Math.max(...list.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

async function shoot(page, name, clip, marked, errors) {
  const c = { x: Math.round(clip.x), y: Math.round(clip.y), width: Math.round(clip.width), height: Math.round(clip.height) };
  await page.screenshot({ path: `/mnt/data/wmb/kit/shots/${name}.png`, clip: c, caret: 'hide' });
  rects[name] = { clip: c, ...marked };
  const missing = Object.keys(marked).filter((k) => !marked[k]);
  console.log(name, JSON.stringify(c), missing.length ? `MISSING ${missing}` : 'ok', errors.length ? `PAGE ERRORS ${errors}` : '');
}

/** The card from the coordinator's words down to the note under How it runs. */
async function cardClip(page) {
  const card = await rect(page, '.start-card');
  const quote = await rect(page, '.start-card-quote');
  const note = await rect(page, '.start-card-settings + .start-card-note');
  return { x: card.x - 14, y: quote.y - 8, width: card.width + 28, height: note.y + note.height - quote.y + 22 };
}

const startField = '.start-card .main-branch-select input[role="combobox"]';
const popup = (page) => page.locator('.orbit-select-popup').last();

async function openMenu(page) {
  await page.locator(startField).click();
  await popup(page).waitFor();
  await page.evaluate(frame);
  await page.waitForTimeout(400);
  return popup(page).evaluate((el) => el.getBoundingClientRect().toJSON());
}

const scenes = {
  // ② the card: Main branch under Tasks land on, the coordinator's master, every sentence on master.
  async '01b-start-proposal'(browser) {
    const { ctx, page, errors } = await openStartCard(browser, { base, css: CARD_720 });
    await page.locator('.start-card-settings').scrollIntoViewIfNeeded();
    await page.evaluate(frame);
    await shoot(page, '01b-start-proposal', await cardClip(page), {
      autoMaster: await textRect(page, '.start-card-settings .start-card-hint', 'merges into master'),
      mainRow: await rect(page, '.start-card-row:nth-child(3)'),
    }, errors);
    await ctx.close();
  },
  // ③ the menu open: the runner's branches, whose they are, and what the choice decides.
  async '01c-menu'(browser) {
    const { ctx, page, errors } = await openStartCard(browser, { base, css: CARD_720 });
    await page.locator('.start-card-settings').scrollIntoViewIfNeeded();
    const pop = await openMenu(page);
    const settings = await rect(page, '.start-card-settings');
    const u = union(settings, pop);
    await shoot(page, '01c-menu', { x: u.x - 14, y: settings.y - 8, width: u.width + 28, height: Math.max(u.y + u.height, settings.y + settings.height) - settings.y + 18 }, {
      head: await rect(page, '.main-branch-menu-head'),
      foot: await rect(page, '.main-branch-menu-foot'),
      select: await rect(page, '.start-card .main-branch-select'),
    }, errors);
    await ctx.close();
  },
  // ④ a typed name the runner never reported, offered as itself.
  async '01d-typed'(browser) {
    const { ctx, page, errors } = await openStartCard(browser, { base, css: CARD_720 });
    await page.locator('.start-card-settings').scrollIntoViewIfNeeded();
    await openMenu(page);
    await page.keyboard.type('release/3.0');
    await page.locator('.main-branch-option.is-typed').waitFor();
    await page.evaluate(frame);
    await page.waitForTimeout(400);
    const row = await rect(page, '.start-card-row:nth-child(3)');
    const pop = await popup(page).evaluate((el) => el.getBoundingClientRect().toJSON());
    const u = union(row, pop);
    await shoot(page, '01d-typed', { x: u.x - 14, y: row.y - 1, width: u.width + 28, height: u.y + u.height - row.y + 15 }, {
      typed: await rect(page, '.main-branch-option.is-typed'),
    }, errors);
    await ctx.close();
  },
  // ⑥ the second project in the repository: the last choice, and where it came from.
  async '01k-memory-start'(browser) {
    const { ctx, page, errors } = await openStartCard(browser, { base, css: CARD_720, second: true });
    await page.locator('.start-card-settings').scrollIntoViewIfNeeded();
    await page.evaluate(frame);
    const card = await rect(page, '.start-card');
    const title = await rect(page, '.start-card-project');
    const note = await rect(page, '.start-card-settings + .start-card-note');
    const label = await textRect(page, '.start-card-settings', 'Main branch');
    const hint = await textRect(page, '.start-card-settings', 'Your last choice for acme/payments-api');
    const select = await rect(page, '.start-card .main-branch-select');
    await shoot(page, '01k-memory-start', { x: card.x - 14, y: title.y - 12, width: card.width + 28, height: note.y + note.height - title.y + 26 }, {
      title,
      mainRow: union(label, select, hint),
      hint,
    }, errors);
    await ctx.close();
  },
  // ⑦ the menu tags the last choice.
  async '01l-memory-menu'(browser) {
    const { ctx, page, errors } = await openStartCard(browser, { base, css: CARD_720, second: true });
    await page.locator('.start-card-settings').scrollIntoViewIfNeeded();
    const pop = await openMenu(page);
    const row = await rect(page, '.start-card-row:nth-child(3)');
    const u = union(row, pop);
    await shoot(page, '01l-memory-menu', { x: u.x - 14, y: row.y - 1, width: u.width + 28, height: u.y + u.height - row.y + 15 }, {
      tag: await rect(page, '.main-branch-tag'),
    }, errors);
    await ctx.close();
  },
  // ⑨ How it runs on a started project: the row, the repository's next default, master everywhere.
  async '01g-run-proposal'(browser) {
    const { ctx, page, errors } = await openProjectPage(browser, { base });
    const run = await rect(page, '.project-run-settings');
    const label = await textRect(page, '.project-run-settings-grid', 'Main branch');
    const select = await rect(page, '.project-run-settings .main-branch-select');
    await shoot(page, '01g-run-proposal', { x: run.x - 12, y: run.y - 12, width: run.width + 24, height: run.height + 24 }, {
      mainRow: union(label, select),
      remembers: await textRect(page, '.project-run-settings-grid', 'New projects in acme/payments-api start with your last choice.'),
      lineMaster: await textRect(page, '.project-run-lines', 'Directly into master'),
      autoMaster: await textRect(page, '.project-run-settings-grid', 'merges the branch into master'),
      pauseMaster: await textRect(page, '.project-run-pause-hint', 'merges into master'),
    }, errors);
    await ctx.close();
  },
  // ⑩ locked with the line: read-only, the reason under the row.
  async '01h-run-locked'(browser) {
    const { ctx, page, errors } = await openProjectPage(browser, { base, locked: true });
    const run = await rect(page, '.project-run-settings');
    const select = await rect(page, '.project-run-settings .main-branch-select');
    const sentence = await rect(page, '.project-run-settings .project-integration-setting:has(.main-branch-select) .project-integration-setting-hint');
    await shoot(page, '01h-run-locked', { x: run.x - 12, y: run.y - 12, width: run.width + 24, height: run.height + 24 }, {
      locked: union(select, sentence),
    }, errors);
    await ctx.close();
  },
  // ⑪ the integration row under the title.
  async '01j-line-proposal'(browser) {
    const { ctx, page, errors } = await openProjectPage(browser, { base, locked: true });
    const line = await rect(page, '.project-integration');
    await shoot(page, '01j-line-proposal', { x: line.x - 10, y: line.y - 10, width: line.width + 20, height: line.height + 20 }, {
      ahead: await textRect(page, '.project-integration', 'ahead of master'),
      synced: await textRect(page, '.project-integration', 'synced with master'),
    }, errors);
    await ctx.close();
  },
  // Beyond the board: a project with no repository has no main branch to choose — no row on the
  // card (the line directly into main, as before), none in How it runs, and the lock sentence stays
  // under the line.
  async 'x1-no-repo-start'(browser) {
    const NONE = { repository: null, branches: null, lastMainBranch: null };
    const { ctx, page, errors } = await openStartCard(browser, { base, css: CARD_720, suggestMain: false, integration: NONE });
    await page.locator('.start-card-settings').scrollIntoViewIfNeeded();
    await page.evaluate(frame);
    await shoot(page, 'x1-no-repo-start', await cardClip(page), {
      settings: await rect(page, '.start-card-settings'),
    }, errors);
    await ctx.close();
  },
  async 'x2-no-repo-run'(browser) {
    const NONE = { repository: null, branches: null, lastMainBranch: null, upstreamRef: 'main', upstreamChosenAt: null };
    const { ctx, page, errors } = await openProjectPage(browser, { base, locked: true, integration: NONE });
    const run = await rect(page, '.project-run-settings');
    await shoot(page, 'x2-no-repo-run', { x: run.x - 12, y: run.y - 12, width: run.width + 24, height: run.height + 24 }, {
      line: await rect(page, '.project-run-settings .project-integration-setting'),
    }, errors);
    await ctx.close();
  },
};

const browser = await launch();
try {
  for (const [name, run] of Object.entries(scenes)) {
    if (only.length && !only.includes(name)) continue;
    await run(browser);
  }
} finally {
  await browser.close();
}
const file = '/mnt/data/wmb/kit/shots/rects.json';
let prev = {};
try { prev = JSON.parse(readFileSync(file, 'utf8')); } catch {}
writeFileSync(file, JSON.stringify({ ...prev, ...rects }, null, 1));
