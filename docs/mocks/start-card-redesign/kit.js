/* 2026-10-07 · Start 卡片重新设计 · 图板共用脚本
   数据是截图里的真实项目「Wiki 服务端执行与 System model」（34bmzOkov3xN2yLPrnsCk）：7 条标准、12 个任务，
   P10 是 OWNER_CONFIRMED（标准 6 要 owner 确认），其余 11 个是 EVIDENCE_JUDGMENT；协调者建议 Automatic 关、
   项目分支、最多 3 个、带合并检查。seal、"多久以前"是示意。
   owner 2026-10-07 定：Automatic 默认开（协调者建议关也一样，只在说明里提一句）；就绪检查的提醒不上 owner 的卡片；
   合并检查可以为空（写 None，不变色、不拒绝）；Automatic 开而项目还没有协调者时，按下 Start 顺手建一个。
   o.own = 没人请求、owner 自己点 Start…；o.noCoordinator = 项目还没有协调者；o.noMergeCheck = 合并检查为空。
   全局名都带 R / r 前缀：原理图板会和旧卡片的 kit.js 一起加载。 */

const R = {
  project: 'Wiki 服务端执行与 System model',
  why: '计划已写好：7 条验收标准都有任务对应，12 个任务的依赖已经连好。建议先在项目分支上合并、跑合并检查，再由你确认进 main，因为 main 会部署到生产。并发 3，让 P3–P7 可以并行。',
  criteria: [
    'wiki-worker 作为 compose 服务运行（Node.js，与 apiserver 同一镜像、不同入口），System model 的地址和 key 只出现在 wiki-worker 的环境里。',
    '所有 wiki 模型请求都经持久化队列 wiki_model_request 执行，同时在途的请求数不超过 ORBIT_WIKI_MODEL_CONCURRENCY。',
    'runner 通过 wiki-repo-op/v1 在心跳中领取并执行 snapshot、read、diff、anchors 四种仓库操作，不创建会话。',
    '核实、文章、导入、plan 起草/修订、文档构建、维护六条流水线，在 ORBIT_WIKI_EXECUTOR 为 server 时都由 wiki-worker 完成。',
    'Web 和 macOS/iOS 的 wiki 设置在服务端执行时不再提供 provider 选择，改为显示 System model 的模型名和状态。',
    '本部署切换到 ORBIT_WIKI_EXECUTOR=server：System model 已配置，wiki-worker 在运行，wiki 不再创建维护任务和会话。',
    '删除维护会话机制（claim 拒绝、干净启动、wiki-maintenance-run/v1、隐藏列表里任务的这种用法）和 runner 侧的模型代码。',
  ],
  // 按层：每个任务在"它最深的前置 + 1"那一层（BatchReview / web buildBatchGraph 的规则）
  levels: [
    [['P1a', 'wiki-worker 服务骨架与 System model 客户端', 'now']],
    [['P1b', 'wiki_job 作业表与模型请求队列']],
    [['P2', 'runner 仓库操作 wiki-repo-op/v1'], ['P3', '核实（verify）移到服务端']],
    [['P4', '文章（articles）移到服务端'], ['P5', '导入（import）移到服务端'], ['P6', 'plan 起草和修订移到服务端'],
     ['P7', '文档构建移到服务端'], ['P9', '客户端：wiki 设置与 Activity 运行详情']],
    [['P8', '维护运行移到服务端']],
    [['P10', '本部署切换到服务端执行', 'you']],
    [['P11', '删除旧路径与合同清理']],
  ],
  branch: 'project/34bmzOkov3xN2yLPrnsCk',
  mergeCheck: 'bash scripts/worktree-overlay.sh && (cd src/apiserver && rm -rf build && npm test) && (cd src/shared && npx vitest run) && …',
  seal: '7c1e9a42',
  repo: 'jianghailong-xy/orbit',
};

const RI = {
  bubble: '<svg class="f" width="14" height="13" viewBox="0 0 14 13"><path d="M7 0C3.1 0 0 2.5 0 5.6c0 1.7.9 3.2 2.4 4.2-.1.9-.5 1.8-1.2 2.5-.2.2 0 .6.3.5 1.4-.2 2.6-.8 3.4-1.5.7.2 1.4.3 2.1.3 3.9 0 7-2.5 7-5.6S10.9 0 7 0z"/></svg>',
  person: '<svg class="f" width="13" height="13" viewBox="0 0 13 13"><circle cx="6.5" cy="3.6" r="3"/><path d="M.6 12.4c.5-3 2.9-4.6 5.9-4.6s5.4 1.6 5.9 4.6c.1.3-.2.6-.5.6H1.1c-.3 0-.6-.3-.5-.6z"/></svg>',
  spark: '<svg class="f" width="14" height="14" viewBox="0 0 14 14"><path d="M7 0c.4 3.6 2.4 5.6 7 7-4.6 1.4-6.6 3.4-7 7-.4-3.6-2.4-5.6-7-7 4.6-1.4 6.6-3.4 7-7z"/></svg>',
  check: '<svg class="f" width="15" height="15" viewBox="0 0 15 15"><circle cx="7.5" cy="7.5" r="7.5"/><path d="M4.3 7.7 6.5 9.8 10.8 5.2" fill="none" stroke="#2C2C2E" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  tri: '<svg class="f ic" width="16" height="15" viewBox="0 0 16 15"><path d="M6.6 1.1c.6-1.1 2.2-1.1 2.8 0l6.1 11.2c.6 1.1-.2 2.4-1.4 2.4H1.9C.7 14.7-.1 13.4.5 12.3z"/><rect x="7.15" y="4.4" width="1.7" height="5.6" rx=".85" fill="#2C2C2E"/><circle cx="8" cy="12" r="1" fill="#2C2C2E"/></svg>',
  down: '<svg class="i chev" width="12" height="12" viewBox="0 0 12 12" stroke-width="1.8"><path d="M2.5 4.3 6 7.8l3.5-3.5"/></svg>',
  right: '<svg class="i chev" width="8" height="13" viewBox="0 0 8 13" stroke-width="1.8"><path d="m1.5 1.5 5 5-5 5"/></svg>',
  up: '<svg class="i chev" width="12" height="12" viewBox="0 0 12 12" stroke-width="1.8"><path d="M2.5 7.7 6 4.2l3.5 3.5"/></svg>',
  updown: '<svg class="i" width="9" height="13" viewBox="0 0 9 13" stroke-width="1.6"><path d="M1.5 4.5 4.5 1.5l3 3M1.5 8.5l3 3 3-3"/></svg>',
  focus: '<svg class="f" width="15" height="17" viewBox="0 0 15 17"><rect x="0" y="0" width="15" height="17" rx="3"/><circle cx="7.5" cy="6.2" r="2.4" fill="#000"/><path d="M3.2 13.2c.6-2.2 2.3-3.2 4.3-3.2s3.7 1 4.3 3.2z" fill="#000"/></svg>',
};

/* 会找你的事：由 Automatic、落地线和每个任务的完成方式推出来（P10 = OWNER_CONFIRMED，其余 11 个 = EVIDENCE_JUDGMENT） */
function rComesToYou(automatic) {
  const items = automatic
    ? [['P10 · 本部署切换到服务端执行', 'you confirm it'],
       ['Any change to the criteria', ''],
       ["Problems it can't resolve within 2 h", '']]
    : [['Whether each task is done', '11 reviews'],
       ['P10 · 本部署切换到服务端执行', 'you confirm it'],
       ['Problems along the way', 'conflicts, failed checks'],
       ['Merging the branch into main', ''],
       ['Any change to the criteria', '']];
  return `<div class="r-ctu" data-k="ctu">
    <div class="t">Comes to you</div>
    ${items.map(([x, d]) => `<div class="it">${RI.person}<span class="x">${x}${d ? `<span class="d"> · ${d}</span>` : ''}</span></div>`).join('')}
  </div>`;
}

/* 整页。o：{ automatic } */
function rPage(o) {
  const auto = o.automatic !== false;
  const autoSub = auto
    ? `The coordinator decides when each task is done and merges into main ${o.noMergeCheck ? 'by itself' : 'once the merge check passes'} — with a receipt you can revert.`
    : 'You decide when each task is done and when the branch goes into main.';
  return `<div class="r-pg">
    <div data-k="head">
      <div class="r-title">${R.project}</div>
      <div class="r-meta">${o.own ? (o.noCoordinator ? 'Nobody asked yet · no coordinator yet' : 'Nobody asked yet') : 'The coordinator asked 56m ago'}</div>
      ${o.own ? '' : `<div class="r-quote" data-k="quote"><div class="r-qh">${RI.bubble}<span>Coordinator</span></div><p>${R.why}</p><span class="r-more">More</span></div>`}
    </div>

    <div class="r-sh" data-k="done">Done when · 7 criteria</div>
    <div data-k="donebody">
      <div class="r-pn">
        ${R.criteria.map((t, i) => `<div class="r-row ${i ? 'sep in40' : ''}"><div class="r-cr"><i>${i + 1}</i><p>${t}</p></div></div>`).join('')}
        <div class="r-row sep in40" style="padding-left:40px"><span class="r-link">Read all 7 in full</span></div>
      </div>
      <div class="r-ft">Orbit derives done from these 7 criteria and nothing else. If they change later, it asks you to confirm the new version — the project keeps running.</div>
    </div>

    <div class="r-sh" data-k="how">How it runs</div>
    <div data-k="howbody">
      <div class="r-pn">
        <div class="r-row" data-k="auto">
          <div class="r-h">Automatic<span class="r-sw ${auto ? 'on' : ''}"></span></div>
          <div class="r-s">${autoSub}</div>
          ${auto && o.noCoordinator ? `<div class="r-opens" data-k="opens">${RI.spark}<span>This project has no coordinator yet. Orbit opens one in <b>orbit-develop</b> on HPC — where its tasks run — when it starts.</span></div>` : ''}
          ${rComesToYou(auto)}
        </div>
        <div data-k="rest">
        <div class="r-row sep" data-k="line"><div class="r-h">Tasks land on<span class="v">A project branch ${RI.updown}</span></div></div>
        <div class="r-row sep" data-k="merge"><div class="r-h">Merge check<span class="q">${o.noMergeCheck ? 'None' : 'Set'}</span>${RI.right}</div>${o.noMergeCheck ? '<div class="r-s">Work lands once it rebases cleanly.</div>' : ''}</div>
        <div class="r-row sep"><div class="r-h">At most<span class="q">3 tasks at a time</span><span class="r-stp"><span>−</span><span>+</span></span></div></div>
        </div>
      </div>
      <div class="r-ft" data-k="howft">${o.own
        ? 'Automatic is on by default. You can change any of these later on the project page.'
        : `Automatic is on by default${o.suggestedOff ? ' (the coordinator suggested off)' : ''}. The rest is the coordinator's suggestion. You can change any of these later on the project page.`}</div>
    </div>

    <div class="r-sh" data-k="plan">Plan · 12 tasks in 7 levels</div>
    <div class="r-pn" data-k="planbody">
      <div class="r-lvs">
        ${R.levels.map((lv, i) => `<div class="r-lv"><span class="n">${i + 1}</span>
          ${lv.length === 1
            ? lv.map(([k, t, tag]) => `<div class="r-tk"><b>${k}</b><span>${t}</span>${tag === 'now' ? '<i class="r-pill now">Now</i>' : ''}${tag === 'you' ? `<i class="r-pill you">${RI.person}You</i>` : ''}</div>`).join('')
            : `<div class="r-tk many"><b>${lv.map(([k]) => k).join(' · ')}</b><em class="par">${lv.length} in parallel</em></div>`}
        </div>`).join('')}
      </div>
      <div class="r-row sep"><span class="r-link">View tasks ›</span></div>
    </div>

  </div>`;
}

/* 底栏那一行：按下等于什么 */
function rBarCaption(o) {
  const opens = o.noCoordinator && o.automatic !== false;
  return opens
    ? 'Opens a coordinator · starts P1a now · confirms these 7 criteria'
    : `Starts P1a now · confirms these 7 criteria · seal ${R.seal}`;
}

function rPhone(v, o) {
  return `<div class="phone" data-v="${v}">
    <div class="status"><span class="l">9:55 ${RI.focus}</span>
      <span class="r"><span class="bars"><i style="height:4px"></i><i style="height:6.5px"></i><i style="height:9px"></i><i style="height:11.5px"></i></span>
      <span style="font-size:15px">5G</span><span class="batt"><b>48</b><i></i></span></span></div>
    <div class="sheet"><div class="r-sc">${rPage(o)}</div><div class="r-edge"></div></div>
    <div class="glass l">Cancel</div>
    <div class="r-navt">Start this project?</div>
    ${o.noCoordinator ? '' : `<div class="glass r" data-k="chat">${RI.bubble}Chat</div>`}
    <div class="r-bar" data-k="bar"><div class="r-go">Start the project</div>
      <div class="r-cap">${rBarCaption(o)}</div></div>
    <div class="sbar"></div>
  </div>`;
}

const R_SHEET_TOP = 58, R_SCREEN = 852, R_NAV = 124, R_BAR = 118;

/* 滚到某一节：anchor 落在屏幕 y；anchor 为空 = 顶部。再画滚动条和标注。可重复调用。 */
function rLayout(ph, anchor, y, marks = []) {
  const sc = ph.querySelector('.r-sc');
  sc.style.transform = 'none';
  ph.querySelectorAll('.mkbox').forEach((m) => m.remove());
  const pr = ph.getBoundingClientRect();
  let scroll = 0;
  if (anchor) {
    const a = ph.querySelector(`[data-k="${anchor}"]`).getBoundingClientRect();
    scroll = y >= 0 ? Math.round(a.top - pr.top - y) : Math.round(a.bottom - pr.top + y);
    scroll = Math.max(0, scroll);
  }
  sc.style.transform = `translateY(${-scroll}px)`;
  const visible = R_SCREEN - R_NAV - R_BAR, content = sc.offsetHeight - 72 - 170 + 24;
  const track = R_SCREEN - R_SHEET_TOP - R_BAR - 70;
  const h = Math.max(30, track * Math.min(1, visible / content));
  const bar = ph.querySelector('.sbar');
  bar.style.height = `${h}px`;
  bar.style.top = `${R_NAV - 4 + (content > visible ? (scroll / (content - visible)) * (track - h) : 0)}px`;
  ph.dataset.content = String(content);
  for (const [sel, n, opt = {}] of marks) {
    const el = ph.querySelector(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const pad = opt.pad ?? 3;
    const fixed = opt.fixed;
    const top = fixed ? r.top - pr.top - pad : Math.max(r.top - pr.top - pad, R_NAV - 6);
    const bottom = fixed ? r.bottom - pr.top + pad : Math.min(r.bottom - pr.top + pad, R_SCREEN - R_BAR - 4);
    if (bottom - top < 12) continue;
    const box = document.createElement('div');
    box.className = 'mkbox';
    box.style.left = `${Math.max(r.left - pr.left - pad, 4)}px`;
    box.style.width = `${Math.min(r.width + pad * 2, 385 - Math.max(r.left - pr.left - pad, 4))}px`;
    box.style.top = `${top}px`;
    box.style.height = `${bottom - top}px`;
    box.innerHTML = `<span class="badge" style="${opt.badge ?? ''}">${n}</span>`;
    ph.appendChild(box);
  }
}

/* 整页缩略（原理图板的结构对比）：返回内容高度（pt），按 data-k 标出每一节。 */
function rThumb(host, o, scale) {
  host.innerHTML = `<div class="inner" style="transform:scale(${scale})"><div class="r-sc" style="position:static;padding:16px 16px 20px">${rPage(o)}</div>
    <div class="r-bar" style="position:static"><div class="r-go">Start the project</div><div class="r-cap">${rBarCaption(o)}</div></div></div>`;
  const inner = host.querySelector('.inner');
  host.style.width = `${393 * scale}px`;
  host.style.height = `${inner.offsetHeight * scale}px`;
  return inner.offsetHeight;
}
