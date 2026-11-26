// Mock only. Draws the Plan usage popover with the shipped classes of src/web/src/index.css
// (.cu-pop, .cu-rc-*), so what is new on the board is only what the proposal adds (.cra-*).

const SHIELD =
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8 7.5 9.5 4.300-1.500 7.5-4.900 7.5-9.500V6L12 3Z"/><path d="m8.800 12 2.300 2.300 4.200-4.400"/></svg>';
const SPIN =
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.600" stroke-linecap="round"><path d="M12 3a9 9 0 1 1-9 9"/></svg>';

const ACCOUNTS = {
  def: { name: 'Default', five: 100, week: 64, count: '2 available', expiry: 'Next expires Dec 3', age: 'Updated 2 min ago' },
  work: { name: 'work@example.com', five: 38, week: 100, count: '1 available', expiry: 'Expires Dec 11', age: 'Updated just now' },
  side: { name: 'side@example.com', five: 6, week: 21, count: '3 available', expiry: 'Next expires Nov 30', age: 'Updated 4 min ago' },
};
const RESETS = { five: 'Resets Nov 26, 9:40 PM', week: 'Resets Nov 30, 8:00 AM' };

const bar = (pct) =>
  `<div class="runner-util ${pct >= 100 ? 'spent' : pct >= 90 ? 'full' : ''}"><span class="runner-util-fill" style="width:${pct}%"></span></div>`;

const windows = (a) =>
  [
    ['5-hour limit', a.five, RESETS.five],
    ['Weekly limit', a.week, RESETS.week],
  ]
    .map(
      ([label, pct, reset]) =>
        `<div class="cu-row"><div class="cu-head"><span class="cu-label">${label}</span><span class="cu-pct">${pct}%</span></div>${bar(pct)}<div class="cu-reset">${reset}</div></div>`,
    )
    .join('');

const accountRow = (name, note) =>
  `<div class="cu-account"><div class="cu-head"><span class="cu-label">Account</span><span class="cu-account-name">${name}</span></div>${note ? `<div class="cu-reset">${note}</div>` : ''}</div>`;

const button = (label, disabled, small) =>
  `<button class="cra-btn${small ? ' cra-btn-sm' : ''}" ${disabled ? 'disabled' : ''}>${label}</button>`;

const status = (tone, title, detail) =>
  `<div class="cu-rc-status cu-rc-status--${tone}"><span class="cu-rc-status-icon">${tone === 'progress' ? SPIN : '●'}</span><div><div class="cu-rc-status-title">${title}</div><div>${detail}</div></div></div>`;

/** Today's card, unchanged: tinted block, then the status line or the one action. */
const card = (a, o = {}) =>
  `<section class="cu-rc${o.bare ? ' cra-bare' : ''}"><div class="cu-rc-card"><span class="cu-rc-icon">${SHIELD}</span><div class="cu-rc-body"><div class="cu-rc-title">Reset credit</div><div class="cu-rc-count">${o.count ?? a.count}</div><div class="cu-rc-meta">${a.expiry}</div><div class="cu-rc-meta${o.stale ? ' cu-rc-stale' : ''}">${o.age ?? a.age}</div></div></div>${
    o.status ?? button('Use reset credit', o.disabled)
  }${o.reason ? `<div class="cu-rc-reason">${o.reason}</div>` : ''}</section>`;

/** Proposal A: another account — its name, its two windows on one line, then the same card. */
const other = (a, o = {}) =>
  `<div class="cra-acct">${accountRow(a.name).replace('cu-account"', 'cu-account cra-other"')}<div class="cra-summary">5-hour <b class="${a.five >= 100 ? 'cra-spent' : ''}">${a.five}%</b> · Weekly <b class="${a.week >= 100 ? 'cra-spent' : ''}">${a.week}%</b></div>${card(a, { ...o, bare: true })}</div>`;

/** Alternative B: another account as one compact card with the action inside it. */
const compact = (a) =>
  `<div class="cra-compact"><span class="cu-rc-icon">${SHIELD}</span><div class="cra-compact-body"><div class="cra-compact-name">${a.name}</div><div class="cu-rc-meta">5-hour ${a.five}% · Weekly ${a.week}%</div><div class="cu-rc-meta"><b>${a.count}</b> · ${a.expiry}</div></div>${button('Use', false, true)}</div>`;

const pop = (body, o = {}) =>
  `<div class="cra-pop${o.phone ? ' cra-pop-phone' : ''}"${o.maxHeight ? ` style="max-height:${o.maxHeight}px;overflow:hidden"` : ''}><div class="cra-title">Plan usage</div><div class="cu-pop cu-pop-reset">${body}</div></div>`;

const { def, work, side } = ACCOUNTS;
const head = (a) => accountRow(a.name) + windows(a);

const FRAMES = {
  'today-default': () => pop(head(def) + card(def)),
  'today-added': () => pop(head(work)),
  'a-default': () => pop(head(def) + card(def) + other(work) + other(side)),
  'a-added': () => pop(head(work) + card(work) + other(def) + other(side)),
  'a-states': () =>
    pop(
      head(def) +
        card(def, {
          status: status('progress', 'Using reset credit…', 'The runner is redeeming 1 credit with Codex.'),
        }) +
        other(work, {
          disabled: true,
          stale: true,
          age: 'Updated 26 min ago · out of date',
          reason: 'Usage is out of date. Waiting for the runner to refresh it.',
        }) +
        other(side),
    ),
  'a-scroll': () => pop(head(def) + card(def) + other(work) + other(side), { maxHeight: 520 }),
  'a-phone': () => pop(head(def) + card(def) + other(work), { phone: true, maxHeight: 640 }),
  'b-default': () =>
    pop(head(def) + card(def) + `<div class="cra-others"><div class="cra-others-h">Other accounts</div>${compact(work)}${compact(side)}</div>`),
  confirm: () =>
    `<div class="cra-dialog"><div class="cra-dialog-title">Use reset credit?</div><p class="cu-rc-confirm-text">This consumes 1 earned credit and resets eligible Codex usage windows. This action can’t be undone.</p><div class="cu-rc-confirm-usage cra-confirm-box"><div><span>Account</span><span class="cu-rc-confirm-value">work@example.com</span></div><div><span>Current usage</span><span class="cu-rc-confirm-value">100% → reset</span></div></div><p class="cu-rc-confirm-note">1 available · Expires Dec 11. Your conversations and their context aren’t affected.</p><div class="cra-dialog-foot">${button('Cancel', false, true).replace('cra-btn ', 'cra-btn cra-btn-plain ')}${button('Use reset', false, true)}</div></div>`,
};

for (const el of document.querySelectorAll('[data-frame]')) el.innerHTML = FRAMES[el.dataset.frame]();
