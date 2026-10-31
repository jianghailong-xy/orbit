// Scenes for docs/mocks/claude-region-check.
import { IDS, infraRoutes } from './data.mjs'; // a copy of ../../infrastructure-focus/capture/data.mjs

/** localStorage the Machines & models page keeps its folds in. */
const folds = (runnersOpen = [], groupsOpen = []) => ({
  fn: ({ r, g }) => {
    localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify(r));
    localStorage.setItem('orbit:providers-open-accounts', JSON.stringify(g));
  },
  arg: { r: runnersOpen, g: groupsOpen },
});

/** The card of the machine named `name`, padded. */
const card = (name, pad = 14) => async (page) => page.evaluate(({ name, pad }) => {
  const c = [...document.querySelectorAll('.re-runner-card')].find((el) => el.textContent.includes(name));
  if (!c) throw new Error('no card ' + name);
  const r = c.getBoundingClientRect();
  return { x: Math.max(0, r.left - pad), y: Math.max(0, r.top - pad), width: r.width + 2 * pad, height: r.height + 2 * pad };
}, { name, pad });

export const SCENES = {
  'mm-today': {
    path: '/infrastructure', routes: infraRoutes(), width: 1280, height: 1400, init: folds([IDS.hpc]),
    clip: card('HPC'),
  },
};

/* ── the session page: a Claude session on HPC whose next turn the region check refused ── */
import { SESSION, WORKSPACE, SESSION_PATH, SESSION_TIME } from '/var/tmp/region-gate-mock/today/src/web/ui-migration/session-fixtures.mjs';
import { runners as fleet, providers as sampleKeys, IDS as FLEET } from './data.mjs';

export const REGION = { checkedAt: '2026-09-28T11:58:00.000Z', claudePath: 'mainland China', viaProxy: false };
const hpcAsSessionRunner = () => {
  const hpc = fleet().find((r) => r.name === 'HPC');
  // PROTOTYPE: the region verdict rides Claude's engine health (see prototype.patch).
  return { ...hpc, id: WORKSPACE.runnerId, region: REGION, engines: hpc.engines.map((e) => (e.engine === 'claude' ? { ...e, regionBlocked: true } : e)) };
};
const T1 = 'turn-0001', T2 = 'turn-0002';
const priorTurn = [
  { seq: 1, type: 'user', payload: { text: 'The login test fails about one run in five. Find out why and fix it.' }, turnId: T1, ts: '2026-09-28T11:20:00.000Z' },
  { seq: 2, type: 'assistant', payload: { text: 'The test waits a fixed **500 ms** for the session cookie, and the token refresh sometimes takes longer under load.\n\nI replaced the sleep with a wait on the cookie itself, and the test passed 50 runs in a row.' }, turnId: T1, ts: '2026-09-28T11:24:00.000Z' },
  { seq: 3, type: 'turn_end', payload: {}, turnId: T1, ts: '2026-09-28T11:24:00.000Z' },
];
const nextMessage = { seq: 4, type: 'user', payload: { text: 'Now do the same for the sign-up test.' }, turnId: T2, ts: '2026-09-28T11:59:00.000Z' };
const refused = (over = {}) => ({
  ...SESSION, workspace: { ...WORKSPACE, name: 'orbit-develop' }, title: 'Fix the flaky login test', status: 'PENDING', runState: 'QUEUED', engineStartedAt: null, numTurns: 0,
  error: 'CLAUDE_REGION_UNSUPPORTED: HPC’s connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude. [CN]',
  updatedAt: '2026-09-28T11:59:00.000Z', lastTurnAt: '2026-09-28T11:24:00.000Z', ...over,
});
const sessionRoutes = (session, events) => () => ({
  'GET /api/runners': [hpcAsSessionRunner()],
  'GET /api/workspaces': [{ ...WORKSPACE, name: 'orbit-develop', runner: { id: WORKSPACE.runnerId, name: 'HPC', displayName: 'HPC' } }],
  'GET /api/sessions': [session],
  'GET /api/providers': sampleKeys(),
  'GET /api/providers/mine': sampleKeys(),
  [`GET /api${SESSION_PATH}`]: session,
  [`GET /api${SESSION_PATH}/events/page`]: { events, hasMore: false },
});
const mainColumn = (pad = 0) => async (page) => page.evaluate((pad) => {
  const card = document.querySelector('.chat-authfix');
  if (!card) throw new Error('no card');
  let col = card.parentElement;
  while (col && col.getBoundingClientRect().width < 600) col = col.parentElement;
  const r = col.getBoundingClientRect();
  return { x: Math.max(0, r.left - pad), y: Math.max(0, r.top - pad), width: Math.min(1280, r.width + 2 * pad), height: Math.min(r.height + 2 * pad, 900) };
}, pad);

SCENES['s-full-B'] = {
  path: SESSION_PATH, routes: sessionRoutes(refused(), [...priorTurn, nextMessage]), width: 1280, height: 900,
  clip: async () => ({ x: 0, y: 0, width: 1280, height: 900 }),
};
SCENES['s-full-A'] = {
  path: SESSION_PATH, routes: sessionRoutes(refused({ title: 'Fix the flaky sign-up test' }), [{ ...nextMessage, seq: 1 }]), width: 1280, height: 900,
  clip: async () => ({ x: 0, y: 0, width: 1280, height: 900 }),
};

/* the new-session engine list on HPC (today: how it looks; the proposal is injected by act) */
const openNewSession = async (page) => {
  await page.locator('.session-new').first().click();
  await page.waitForTimeout(1200);
};
SCENES['hero-today'] = {
  path: SESSION_PATH, routes: sessionRoutes(refused(), [...priorTurn, nextMessage]), width: 1280, height: 900,
  act: openNewSession,
  clip: async () => ({ x: 0, y: 0, width: 1280, height: 900 }),
};

/* ── proposal injections into the real page (the app's own classes, so its own CSS) ── */
const ICON_WARN = () => document.querySelector('.runner-attention .anticon-warning')?.outerHTML ?? '';
export const injectMachineCard = async (page) => page.evaluate(() => {
  const cards = [...document.querySelectorAll('.re-runner-card')];
  const hpc = cards.find((c) => c.querySelector('.re-runner')?.textContent === 'HPC');
  const warnIcon = document.querySelector('.runner-attention .anticon-warning')?.outerHTML ?? '';
  // ① the card head: an attention line, the same kind a signed-out engine raises
  const copy = hpc.querySelector('.re-runner-copy');
  const att = document.createElement('span');
  att.className = 'runner-attention warn';
  att.innerHTML = `${warnIcon}<span>Claude Code can’t use Anthropic here</span>`;
  att.dataset.mark = 'att';
  copy.appendChild(att);
  // ② no chip for an engine that can't take a session (as for a signed-out one)
  const chip = [...hpc.querySelectorAll('.mc-chip')].find((c) => c.textContent.includes('Claude Code'));
  chip?.remove();
  // ③ the Claude Code row
  const row = hpc.querySelector('.re-row[data-engine="claude"]');
  row.dataset.mark = 'row';
  row.querySelector('.re-meta').innerHTML = '2.1.302 · 3 accounts<span class="re-upd">checked 6m ago</span>';
  row.querySelector('.re-status').innerHTML = '<span title="Region not supported" class="orbit-badge orbit-badge-orange" data-mark="badge"><span>Region not supported</span></span>';
  row.querySelector('.re-quota').innerHTML = '<span class="re-quota-none">—</span>';
  row.querySelector('.re-act').innerHTML = '<button type="button" class="orbit-button orbit-button-default orbit-button-small re-action" data-mark="check"><span>Check again</span></button>';
  const note = document.createElement('div');
  note.className = 're-login-note';
  note.dataset.mark = 'note';
  note.innerHTML = '<div class="rsi-hint">Claude’s connection from this machine is in mainland China, where Anthropic doesn’t offer Claude, so Orbit won’t use Anthropic accounts or keys here, or start a Claude sign-in. Claude Code still runs with other providers’ keys. <a href="https://www.anthropic.com/supported-countries" target="_blank" rel="noreferrer">Supported regions</a></div>'
    + '<div class="rsi-hint" style="margin-top:4px;opacity:.8">Checked 2m ago · Claude’s connection: mainland China (no proxy)</div>';
  row.appendChild(note);
});
const markBox = (key) => async (page) => page.evaluate((key) => {
  const el = document.querySelector(`[data-mark="${key}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}, key);

SCENES['mm-new'] = {
  path: '/infrastructure', routes: infraRoutes(), width: 1280, height: 1400, init: folds([IDS.hpc]),
  act: injectMachineCard, clip: card('HPC'),
  boxes: { att: markBox('att'), row: markBox('row'), badge: markBox('badge'), check: markBox('check'), note: markBox('note') },
};

/* the session list row and the new-session engine list */
const injectListRow = async (page) => page.evaluate(() => {
  const sub = [...document.querySelectorAll('.session-col *')].find((e) => e.children.length === 0 && e.textContent.trim() === 'Waiting for slot');
  if (sub) { sub.textContent = 'Anthropic unavailable on HPC'; sub.dataset.mark = 'listrow'; }
  // the header's status words, and no working clock: nothing is working on a held run
  const head = document.querySelector('.workspace-sub');
  if (head && head.textContent.startsWith('Waiting for slot')) { head.textContent = head.textContent.replace('Waiting for slot', 'Anthropic unavailable on HPC'); head.dataset.mark = 'headsub'; }
  document.querySelectorAll('.chat-turn-head').forEach((h) => { if (/^Working for/.test(h.textContent.trim())) h.remove(); });
});
const injectHeroClosed = async (page) => page.evaluate(() => {
  const hero = document.querySelector('.np-hero');
  hero.querySelector('.np-empty-copy')?.remove();
  hero.querySelector('.np-current-model')?.remove();
  const sum = document.createElement('div');
  sum.className = 'np-summary';
  sum.dataset.mark = 'summary';
  sum.innerHTML = '<b>Claude Code</b><span class="np-dot">·</span>Region not supported on this runner<span class="np-dot">·</span><a href="/infrastructure">Details</a>';
  hero.appendChild(sum);
});
const injectHeroList = async (page) => page.evaluate(() => {
  const row = [...document.querySelectorAll('.np-row')].find((r) => r.querySelector('.np-row-name')?.textContent === 'Claude Code');
  const a = document.createElement('a');
  a.className = 'np-row np-unavailable';
  a.href = '/infrastructure';
  a.dataset.mark = 'heroRow';
  a.innerHTML = row.innerHTML;
  a.querySelector('.np-row-model').className = 'np-row-model np-fix';
  a.querySelector('.np-row-model').textContent = 'Region not supported';
  row.replaceWith(a);
});
SCENES['hero-new'] = {
  path: SESSION_PATH, routes: sessionRoutes(refused(), [...priorTurn, nextMessage]), width: 1280, height: 900,
  act: async (page) => { await openNewSession(page); await injectListRow(page); },
  clip: async () => ({ x: 0, y: 0, width: 1280, height: 900 }),
  boxes: { summary: markBox('summary'), listrow: markBox('listrow') },
};
SCENES['hero-new-open'] = {
  path: SESSION_PATH, routes: sessionRoutes(refused(), [...priorTurn, nextMessage]), width: 1280, height: 900,
  act: async (page) => { await openNewSession(page); await injectListRow(page); await page.locator('.np-card').first().click(); await page.waitForTimeout(700); await injectHeroList(page); },
  clip: async () => ({ x: 0, y: 0, width: 1280, height: 900 }),
  boxes: { heroRow: markBox('heroRow') },
};
SCENES['s-B'] = {
  path: SESSION_PATH, routes: sessionRoutes(refused(), [...priorTurn, nextMessage]), width: 1280, height: 900,
  act: injectListRow,
  clip: async () => ({ x: 0, y: 0, width: 1280, height: 900 }),
  boxes: { card: '.chat-authfix', listrow: markBox('listrow'), headsub: markBox('headsub') },
};
SCENES['s-A'] = {
  path: SESSION_PATH, routes: sessionRoutes(refused({ title: 'Fix the flaky sign-up test' }), [{ ...nextMessage, seq: 1 }]), width: 1280, height: 900,
  act: injectListRow,
  clip: async () => ({ x: 0, y: 0, width: 1280, height: 900 }),
  boxes: { card: '.chat-authfix', listrow: markBox('listrow') },
};

/** The rect of the text inside the first element matching `sel` (or carrying data-mark=`sel`). */
const textBox = (sel) => async (page) => page.evaluate((sel) => {
  const el = document.querySelector(sel) ?? document.querySelector(`[data-mark="${sel}"]`);
  if (!el) return null;
  const range = document.createRange();
  range.selectNodeContents(el);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0);
  const last = rects[rects.length - 1];
  const first = rects[0];
  return { x: first.left, y: first.top, width: last.right - first.left, height: last.bottom - first.top, endX: last.right, endY: (last.top + last.bottom) / 2 };
}, sel);
SCENES['s-B'].boxes = {
  listrow: textBox('listrow'), headsub: textBox('headsub'),
  why: textBox('.run-never-started-why'), subject: textBox('.run-never-started-subject'),
  detail: '.chat-authfix-last', actions: textBox('.chat-authfix-actions'), foot: textBox('.run-never-started-foot'),
};

/* the composer's Provider menu: Anthropic-bound credentials carry the reason, other keys stay pickable */
const injectProviderMenu = async (page) => page.evaluate(() => {
  const ANTHROPIC = ['Default', 'Personal Max', 'Work'];
  const menus = [...document.querySelectorAll('[role="menu"]')];
  const sub = menus.find((m) => m.textContent.includes('API keys'));
  for (const item of sub.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')) {
    const name = item.querySelector('.composer-provider-name, .composer-account-row-name');
    if (!name) continue;
    const text = name.textContent.trim();
    if (!ANTHROPIC.includes(text)) continue;
    item.classList.add('composer-provider-fix');
    const textNode = [...name.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim() === text);
    if (textNode) textNode.textContent = `${text} — Region not supported`;
    else name.append(' — Region not supported');
    item.dataset.mark = item.dataset.mark ?? ('prov-' + text.replace(/\W+/g, ''));
  }
  const keys = [...sub.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].find((i) => i.textContent.trim() === 'DeepSeek');
  if (keys) keys.dataset.mark = 'prov-ok';
});
SCENES['prov-new'] = {
  path: SESSION_PATH, routes: sessionRoutes(refused(), [...priorTurn, nextMessage]), width: 1280, height: 900,
  act: async (page) => {
    await injectListRow(page);
    await page.locator('button.composer-model-chip').click();
    await page.waitForTimeout(600);
    await page.locator('[role="menuitem"]').filter({ hasText: /Provider/ }).first().hover();
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      const sub = [...document.querySelectorAll('[role="menu"]')].find((m) => m.textContent.includes('API keys'));
      for (const item of sub?.querySelectorAll('[role="menuitem"], [role="menuitemradio"]') ?? []) {
        const t = item.textContent.trim();
        if (t.startsWith('Personal Max')) item.dataset.mark = 'prov-PersonalMax';
        if (t.startsWith('DeepSeek')) item.dataset.mark = 'prov-ok';
        if (t.startsWith('Default')) item.dataset.mark = 'prov-Default';
      }
    });
  },
  clip: async () => ({ x: 0, y: 0, width: 1280, height: 900 }),
  keepMouse: true,
  boxes: { anth: markBox('prov-PersonalMax'), def: markBox('prov-Default'), ok: markBox('prov-ok') },
};
