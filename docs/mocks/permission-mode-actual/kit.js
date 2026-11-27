// Frame builders for docs/mocks/permission-mode-actual. Every UI string here is product copy (English).
const SHIELD = (c = 'currentColor') =>
  `<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="${c}" stroke-width="1.5" stroke-linejoin="round"><path d="M8 1.8 13 3.6v4.1c0 3-2.1 5.4-5 6.5-2.9-1.1-5-3.5-5-6.5V3.6L8 1.8Z"/></svg>`;

const TURN = {
  user: 'Run the staging migration check and tell me what fails.',
  asst: 'Ran it against staging: 14 of 14 checks passed. The slowest step was the index rebuild on <code>sessions</code> (41 s).',
  user2: 'Good. Now drop the old <code>runner_probe</code> table on staging.',
  asst2: 'Dropped it. Nothing else referenced it.',
};

// The mode-change line: who or what made the change, in one sentence. `client` is where the owner was.
const MODE_LINES = {
  ownerWeb: { text: 'Mode set to <b>Auto</b> by you, on the web', t: '14:02' },
  ownerIphone: { text: 'Mode set to <b>Accept Edits</b> by you, on iPhone', t: '14:06' },
  ownerAndroid: { text: 'Mode set to <b>Auto</b> by you, on Android', t: '14:09' },
  runnerFix: { text: 'Mode set back to <b>Auto</b> by the runner — Claude had started in Default', t: '03:05' },
  respawn: { text: 'Claude restarted; mode <b>Auto</b> re-applied', t: '14:21' },
  claimRoot: { text: 'Started in <b>Auto</b>, not Bypass — Bypass can’t run on a root runner', t: '09:00', gap: true },
  claimSched: { text: 'Started in <b>Auto</b> — scheduled runs always use Auto', t: '09:00' },
  modelNoAuto: { text: 'Mode now <b>Default</b> — you picked Haiku 4.5, which has no Auto', t: '14:30', gap: true },
};

const MODES = ['Default', 'Plan', 'Accept Edits', 'Auto', "Don't Ask", 'Bypass'];

// ───────────── Web ─────────────
function webLine(key, style) {
  const l = MODE_LINES[key];
  if (style === 'B2') return `<div class="chat-mode-div${l.gap ? ' is-gap' : ''}"><span>${l.text} · ${l.t}</span></div>`;
  return `<div class="chat-mode-line${l.gap ? ' is-gap' : ''}">${SHIELD()}<span>${l.text}</span><span class="t">${l.t}</span></div>`;
}
function webCapsule(c) {
  const cls = ['composer-pill', c.gap ? 'is-gap' : '', c.open ? 'is-open' : ''].join(' ');
  const lead = c.spin ? '<span class="spin"></span>' : c.dot ? '<span class="dot"></span>' : '';
  const label = c.to ? `${c.label} <span class="arrow">→</span> ${c.to}` : c.label;
  return `<span class="${cls}">${lead}${label}</span>`;
}
function webMenu({ checked, notes = {}, off = [], head, act, left = 104, bottom = 66 }) {
  const rows = MODES.map((m) => {
    const isOff = off.includes(m) || m === 'Bypass';
    const note = m === 'Bypass' ? 'unavailable on a root runner' : notes[m];
    return `<div class="opt${m === checked ? ' sel' : ''}${isOff ? ' off' : ''}">${m}${note ? ` <span class="note">— ${note}</span>` : ''}</div>`;
  }).join('');
  return `<div class="orbit-select-popup" style="left:${left}px;bottom:${bottom}px">${head ? `<div class="head">${head}</div>` : ''}${rows}${act ? `<div class="act">${act}</div>` : ''}</div>`;
}
function web(o) {
  const body = o.draft
    ? `<div style="height:100%;display:grid;place-items:center;color:var(--text-3);font-size:14px"><span>New session on <b style="color:var(--text-2)">workstation-gpu</b> · orbit</span></div>`
    : (o.lines ?? [
        `<div class="chat-msg chat-user">${TURN.user}</div>`,
        `<div class="chat-assistant">${TURN.asst}</div>`,
      ]).join('');
  return `<div class="w-frame">
    <div class="w-head">${o.draft ? 'New session' : 'Staging migration check'}<span class="w-sub">${o.draft ? '' : 'orbit · workstation-gpu'}</span></div>
    <div class="w-scroll">${body}</div>
    <div class="w-comp">
      ${o.strip ? `<div class="composer-strip">⚠ ${o.strip}</div>` : ''}
      <div class="composer-box${o.capsule.open ? ' is-open' : ''}">
        <div class="composer-field">${o.draft ? 'Send this workspace a task…' : 'Reply…'}</div>
        <div class="composer-toolbar">
          <span class="composer-plus">+</span>
          ${o.draft ? '<span class="composer-pill">orbit</span>' : ''}
          ${webCapsule(o.capsule)}
          <span class="composer-pill-spacer"></span>
          <span class="composer-model-chip"><span class="composer-model-name">${o.model ?? 'Opus 5.5'}</span><span class="composer-model-effort">${o.effort ?? 'Max'}</span></span>
          <span class="composer-usage"><i></i>41%</span>
          <span class="composer-send${o.draft ? ' off' : ''}">↑</span>
        </div>
      </div>
    </div>
    ${o.overlay ?? ''}
  </div>`;
}

// ───────────── iPhone ─────────────
function iStatus() {
  return `<div class="status"><span>9:41</span><span class="r">▂▄▆ &nbsp;<span style="font-size:13px">5G</span> <span class="bat"></span></span></div>`;
}
function iLine(key, style) {
  const l = MODE_LINES[key];
  if (style === 'B2') return `<div class="i-mode-div${l.gap ? ' is-gap' : ''}"><span>${l.text}</span></div>`;
  return `<div class="i-mode-line${l.gap ? ' is-gap' : ''}">${SHIELD()}<span>${l.text}</span></div>`;
}
function iMenu({ checked, notes = {}, head, act, left = 20, bottom = 100 }) {
  const rows = MODES.map((m) => {
    const off = m === 'Bypass' || notes[m]?.off;
    const sub = m === 'Bypass' ? 'Unavailable on a root runner' : notes[m]?.text;
    return `<div class="it${off ? ' off' : ''}"><span class="ck">${m === checked ? '✓' : ''}</span><span>${m}${sub ? `<span class="sub">${sub}</span>` : ''}</span></div>`;
  }).join('');
  return `<div class="i-dim"></div><div class="i-menu" style="left:${left}px;bottom:${bottom}px">${head ? `<div class="head">${head}</div>` : ''}${rows}${act ? `<div class="it act"><span class="ck"></span><span>${act}</span></div>` : ''}</div>`;
}
function iphone(o) {
  const c = o.capsule;
  const lead = c.spin ? '<span class="spin" style="width:12px;height:12px"></span>' : c.dot ? '<span class="dot"></span>' : '';
  const label = c.to ? `${c.label} → ${c.to}` : c.label;
  const body = o.draft
    ? `<div style="position:absolute;top:240px;left:0;right:0;text-align:center;color:rgba(60,60,67,.6);font-size:15px">New session on <b style="color:#000">workstation-gpu</b></div>`
    : (o.lines ?? [`<div class="i-user">${TURN.user}</div>`, `<div class="i-asst">${TURN.asst}</div>`]).join('');
  return `<div class="phone">${iStatus()}
    <div class="i-nav"><span class="i-circ">☰</span><span class="i-title">${o.draft ? 'New session' : 'Staging migration check'}<small>${o.draft ? 'orbit' : 'orbit · workstation-gpu'}</small></span><span class="i-circ">⋯</span></div>
    <div class="i-scroll">${body}</div>
    <div class="i-comp">
      ${o.strip ? `<div class="i-strip">⚠ <span>${o.strip}</span></div>` : ''}
      <div class="i-box"><div class="i-field">${o.draft ? 'Send this workspace a task…' : 'Reply…'}</div>
        <div class="i-bar"><span class="i-plus">+</span>
          <span class="i-mode${c.gap ? ' is-gap' : ''}${c.open ? ' is-open' : ''}">${lead}${label}</span>
          <span class="i-model"><b>${o.model ?? 'Opus 5.5'}</b> ${o.effort ?? 'Max'}</span>
          <span class="i-send${o.draft ? ' off' : ''}">↑</span></div></div>
    </div>
    ${o.overlay ?? ''}<div class="home"></div></div>`;
}

// ───────────── Android ─────────────
function aStatus() {
  return `<div class="a-status"><span>9:41</span><span class="cam"></span><span class="r">▾ ▲ ▮</span></div>`;
}
function aLine(key, style) {
  const l = MODE_LINES[key];
  if (style === 'B2') return `<div class="a-mode-div${l.gap ? ' is-gap' : ''}"><span>${l.text}</span></div>`;
  return `<div class="a-mode-line${l.gap ? ' is-gap' : ''}">${SHIELD()}<span>${l.text}</span></div>`;
}
function aMenu({ checked, notes = {}, head, act, left = 16, bottom = 96 }) {
  const rows = MODES.map((m) => {
    const off = m === 'Bypass' || notes[m]?.off;
    const sub = m === 'Bypass' ? 'Unavailable on a root runner' : notes[m]?.text;
    return `<div class="it${m === checked ? ' sel' : ''}${off ? ' off' : ''}"><span class="ck">${m === checked ? '✓' : ''}</span><span>${m}${sub ? `<span class="sub">${sub}</span>` : ''}</span></div>`;
  }).join('');
  return `<div class="a-menu" style="left:${left}px;bottom:${bottom}px">${head ? `<div class="head">${head}</div>` : ''}${rows}${act ? `<div class="act">${act}</div>` : ''}</div>`;
}
function droid(o) {
  const c = o.capsule;
  const lead = c.spin ? '<span class="spin" style="width:12px;height:12px"></span>' : c.dot ? '<span class="dot"></span>' : '';
  const label = c.to ? `${c.label} → ${c.to}` : c.label;
  const body = o.draft
    ? `<div style="position:absolute;top:240px;left:0;right:0;text-align:center;color:var(--md-on-var);font-size:15px">New session on <b style="color:#1B1B21">workstation-gpu</b></div>`
    : (o.lines ?? [`<div class="a-user">${TURN.user}</div>`, `<div class="a-asst">${TURN.asst}</div>`]).join('');
  return `<div class="droid">${aStatus()}
    <div class="a-bar"><span class="a-ic">☰</span><span class="a-title">${o.draft ? 'New session' : 'Staging migration check'}<small>${o.draft ? 'orbit' : 'orbit · workstation-gpu'}</small></span><span class="a-ic">⋮</span></div>
    <div class="a-scroll">${body}</div>
    <div class="a-comp">
      ${o.strip ? `<div class="a-strip">⚠ <span>${o.strip}</span></div>` : ''}
      <div class="a-box"><div class="a-field">${o.draft ? 'Send this workspace a task…' : 'Reply…'}</div>
        <div class="a-tools"><span class="a-plus">+</span>
          <span class="a-chip${c.gap ? ' is-gap' : ''}${c.open ? ' is-open' : ''}">${lead}${label} ▾</span>
          <span class="a-model"><b>${o.model ?? 'Opus 5.5'}</b> ${o.effort ?? 'Max'}</span>
          <span class="a-send${o.draft ? ' off' : ''}">↑</span></div></div>
    </div>
    ${o.overlay ?? ''}<div class="a-gest"></div></div>`;
}

// Shared copy for the gap explanations.
const GAP = {
  transientHead: '<b>Running in Default.</b> Claude started below the Auto you asked for; the runner is switching it to Auto now.',
  persistentHead: '<b>Running in Default.</b> You asked for Auto, but Haiku 4.5 has no Auto. Pick a model with Auto to get it back.',
  transientStrip: 'Running in Default, not Auto — Claude started below Auto; the runner is switching it now.',
  persistentStrip: 'Running in Default, not Auto — Haiku 4.5 has no Auto.',
  draftHead: '<b>Starts in Default.</b> Haiku 4.5 has no Auto; your pick stays Auto and applies on a model that has it.',
};
