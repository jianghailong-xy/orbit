// Builds one platform's board: window.PLATFORM = 'web' | 'iphone' | 'android'.
// Captions are the owner's working language; every string inside a frame is product copy (English).
(function () {
  const P = window.PLATFORM;
  const F = { web, iphone, android: droid }[P];
  const line = { web: webLine, iphone: iLine, android: aLine }[P];
  const user = (t) => (P === 'web' ? `<div class="chat-msg chat-user">${t}</div>` : P === 'iphone' ? `<div class="i-user">${t}</div>` : `<div class="a-user">${t}</div>`);
  const asst = (t) => (P === 'web' ? `<div class="chat-assistant">${t}</div>` : P === 'iphone' ? `<div class="i-asst">${t}</div>` : `<div class="a-asst">${t}</div>`);
  // Menu anchored over the capsule. Web: an Orbit Select popup; iPhone: a glass menu; Android: a Material menu.
  const menu = (o) =>
    P === 'web' ? webMenu(o.draft ? { ...o, left: 150 } : o) : P === 'iphone' ? iMenu({ ...o, notes: phoneNotes(o.notes) }) : aMenu({ ...o, notes: phoneNotes(o.notes) });
  const phoneNotes = (n = {}) =>
    Object.fromEntries(Object.entries(n).map(([k, v]) => [k, typeof v === 'string' ? { text: v[0].toUpperCase() + v.slice(1) } : v]));
  const tip = (html) =>
    P === 'web'
      ? `<div class="orbit-tooltip" style="left:96px;bottom:70px">${html.replace(/<\/?b>/g, '')}</div>`
      : P === 'iphone'
        ? `<div class="i-pop" style="left:16px;bottom:104px">${html}</div>`
        : `<div class="a-tip" style="left:16px;bottom:100px">${html}</div>`;
  const where = { web: '网页', iphone: 'iPhone', android: 'Android' }[P];

  const frame = (tag, caption, o) =>
    `<div><div>${F(o)}</div><div class="b-cap" style="${P === 'web' ? 'width:820px' : ''}">${tag ? `<span class="b-tag ${tag.cls ?? ''}">${tag.t}</span>` : ''}${caption}</div></div>`;
  const sec = (h, p, frames) => `<section class="b-sec"><h2>${h}</h2><p>${p}</p><div class="b-row">${frames.join('')}</div></section>`;

  const out = [];
  out.push(`<h1 class="b-title">运行中的权限模式 · ${where}</h1>
  <p class="b-lede">Mode 胶囊显示会话<b>实际在跑</b>的模式（引擎报告的那个），不再是存储的意图加客户端猜测（WorkspaceView.tsx ~8311 的 clampPermissionModeForModel）。意图仍存着、从不被改写；菜单里的 ✓ 标的是意图。差距按 R1 应当罕见且短暂。框内文字均为产品英文文案；壳是手绘的，web 的类名与配色取自 index.css（composer-pill / chat-note / chat-notice / orbit-select-popup）。</p>
  <div class="b-decide is-decided"><h3>三处已定：主人 2026-11-19 选了 A1、B1、C1（各处的推荐方案）</h3><ol>
    <li><b>A. 差距怎么显示</b>：<span class="b-tag rec">✓ 选定 A1</span> A1 胶囊内写 “Default → Auto” 加转圈，原因在悬停/点开的菜单头里（推荐）；<span class="b-dropped">A2 胶囊只写 “Default”（琥珀色），输入框上方加一行原因。</span></li>
    <li><b>B. 对话里的模式变更行</b>：<span class="b-tag rec">✓ 选定 B1</span> B1 像 “⊘ interrupted” 那样的安静左对齐行，带盾形图标（推荐）；<span class="b-dropped">B2 居中分隔线。</span></li>
    <li><b>C. 开始前的选择器</b>：<span class="b-tag rec">✓ 选定 C1</span> C1 有 Auto 的模型不加任何提示，没有 Auto 的模型在 Auto 一行写明并仍可选（推荐）；<span class="b-dropped">C2 没有 Auto 的模型直接禁用 Auto，给出 “换到有 Auto 的模型” 的动作。</span></li></ol></div>`);

  // ① running == intent
  out.push(
    sec('① 胶囊显示实际模式（与意图一致）', '常态：胶囊就是引擎报告的模式，没有任何附加标记。打开菜单时 ✓ 在意图上，此时两者相同。', [
      frame(null, '<b>①a</b> 会话在 Auto 下运行：胶囊写 Auto。', { capsule: { label: 'Auto' } }),
      frame(null, '<b>①b</b> 打开菜单：✓ 在 Auto；没有提示行。Bypass 在 root runner 上照旧禁用。', {
        capsule: { label: 'Auto', open: true },
        overlay: menu({ checked: 'Auto' }),
      }),
    ]),
  );

  // ② gap
  out.push(
    sec(
      '② 实际模式与意图不同（罕见、短暂）',
      '短暂差距：Claude 以 Default 起步，runner 正在把它切回 Auto（几秒）。持续差距：交互会话换到没有 Auto 的模型（任务按 R1/R2 不会出现这种情况）。',
      [
        frame({ t: 'A1', cls: 'rec' }, '<b>短暂</b> 胶囊写 “Default → Auto” 加转圈，琥珀色；悬停（手机上点按）给出原因。纠正完成后回到 ①a，并在对话里留一行（③）。', {
          capsule: { label: 'Default', to: 'Auto', gap: true, spin: true },
          overlay: tip(GAP.transientHead),
        }),
        frame({ t: 'A1', cls: 'rec' }, '<b>持续</b> 胶囊写 “Default” 加琥珀点；菜单头说明原因与解决办法，✓ 仍在意图 Auto 上。', {
          capsule: { label: 'Default', gap: true, dot: true, open: true },
          model: 'Haiku 4.5',
          effort: 'High',
          overlay: menu({ checked: 'Auto', head: GAP.persistentHead, notes: { Auto: 'not on Haiku 4.5, runs as Default' } }),
        }),
        frame({ t: 'A2', cls: 'alt' }, '<b>短暂</b> 胶囊只写实际的 “Default”，输入框上方一行琥珀色原因。更显眼，但几秒后消失会让输入框上下跳一下。', {
          capsule: { label: 'Default', gap: true },
          strip: GAP.transientStrip,
        }),
        frame({ t: 'A2', cls: 'alt' }, '<b>持续</b> 同上，原因行一直留着，直到换回有 Auto 的模型或改了模式。', {
          capsule: { label: 'Default', gap: true },
          model: 'Haiku 4.5',
          effort: 'High',
          strip: GAP.persistentStrip,
        }),
      ],
    ),
  );

  // ③ transcript line
  const all = (style) => [
    user(TURN.user),
    line('claimRoot', style),
    line('runnerFix', style),
    asst('Ran it against staging: 14 of 14 checks passed.'),
    line('ownerWeb', style),
    line('ownerIphone', style),
    line('ownerAndroid', style),
    line('respawn', style),
    line('claimSched', style),
    line('modelNoAuto', style),
  ];
  out.push(
    sec(
      '③ 对话里记录每一次模式变更，以及是谁/什么改的',
      '为了一屏看全，一帧里把所有来源都排出来了（真实对话里很少会挤在一起）：主人（标明客户端：web / iPhone / Android / Mac）、runner 纠正、重启后重新应用、领取时的替换（root 上的 Bypass、定时任务）。仍与意图不同的行用琥珀色。',
      [
        frame({ t: 'B1', cls: 'rec' }, '安静的左对齐行，与 “⊘ interrupted” 同一档（chat-note 的灰、13px），前面一个盾形图标；web 右侧是时间。', {
          capsule: { label: 'Default', gap: true, dot: true },
          model: 'Haiku 4.5',
          effort: 'High',
          lines: all('B1'),
        }),
        frame({ t: 'B2', cls: 'alt' }, '居中的分隔线，读作“从这里起换了模式”。更醒目，但和回合分隔、日期分隔更难区分，换行时两侧的线会被挤没。', {
          capsule: { label: 'Default', gap: true, dot: true },
          model: 'Haiku 4.5',
          effort: 'High',
          lines: all('B2'),
        }),
      ],
    ),
  );

  // ④ picker before start
  out.push(
    sec(
      '④ 会话开始前的选择器：Auto 的可用提示',
      '一次探测不再把 Auto 从模型上拿走，所以有 Auto 的模型（Opus 5.5 等）不需要任何“可能不可用”的提示。只有目录里确实没有 Auto 的模型才说明。',
      [
        frame({ t: 'C1 · C2', cls: '' }, '<b>④a</b> Opus 5.5：Auto 一行没有提示，两个方案相同。', {
          draft: true,
          capsule: { label: 'Auto', open: true },
          overlay: menu({ checked: 'Auto', draft: true }),
        }),
        frame({ t: 'C1', cls: 'rec' }, 'Haiku 4.5：Auto 仍可选并写明 “starts in Default”；胶囊显示将要实际起步的 Default（琥珀点），菜单头解释。意图保留，换回 Opus 5.5 即恢复 Auto。', {
          draft: true,
          model: 'Haiku 4.5',
          effort: 'High',
          capsule: { label: 'Default', gap: true, dot: true, open: true },
          overlay: menu({ draft: true, checked: 'Auto', head: GAP.draftHead, notes: { Auto: 'not on Haiku 4.5, starts in Default' } }),
        }),
        frame({ t: 'C2', cls: 'alt' }, 'Haiku 4.5：Auto 灰掉不可选，底部给 “Use Opus 5.5 for Auto”。规则更硬，但会改写主人存下的意图（与项目“意图从不被改写”相冲）。', {
          draft: true,
          model: 'Haiku 4.5',
          effort: 'High',
          capsule: { label: 'Default', open: true },
          overlay: menu({
            draft: true,
            checked: 'Default',
            notes: { Auto: P === 'web' ? 'not on Haiku 4.5' : { text: 'Not on Haiku 4.5', off: true } },
            off: ['Auto'],
            act: 'Use Opus 5.5 for Auto',
          }),
        }),
      ],
    ),
  );
  document.getElementById('b').innerHTML = out.join('');
})();
