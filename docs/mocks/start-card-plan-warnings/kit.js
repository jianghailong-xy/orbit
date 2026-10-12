/* 2026-10-07 · Start 卡片：Plan 里的黄字 · 图板共用脚本
   数据是截图里的真实项目「Wiki 服务端执行与 System model」（34bmzOkov3xN2yLPrnsCk）：
   7 条标准、12 个任务；协调者 12:59 发起启动请求，服务端回了 6 条 START_CRITERION_CODELESS_UNDECLARED
   （标准 1、2、3、4、5、7——标准 6 的 P10 已声明 codeless）。seal 和"多久以前"是示意。 */

const D = {
  project: 'Wiki 服务端执行与 System model',
  criteria: [
    'wiki-worker 作为 compose 服务运行（Node.js，与 apiserver 同一镜像、不同入口），System model 的地址和 key 只出现在 wiki-worker 的环境里。模型状态由 wiki_model_status 提供给读接口。',
    '所有 wiki 模型请求都经持久化队列 wiki_model_request 执行。多个调度器同时领取时，同时在途的请求数不超过 ORBIT_WIKI_MODEL_CONCURRENCY。',
    'runner 通过 wiki-repo-op/v1 在心跳中领取并执行 snapshot、read、diff、anchors 四种仓库操作，不创建会话、不计入 runnerActiveTurns。',
    '核实、文章、导入、plan 起草/修订、文档构建、维护六条流水线，在 ORBIT_WIKI_EXECUTOR 为 server（或 canary 名单内的账号）时都由 wiki-worker 完成。',
    'Web 和 macOS/iOS 的 wiki 设置在服务端执行时不再提供 provider 选择，改为显示 System model 的模型名和状态；Activity 显示每次运行的进度。',
    '本部署切换到 ORBIT_WIKI_EXECUTOR=server：System model 已配置，wiki-worker 在运行。切换后 wiki 不再创建维护任务和会话。',
    '删除维护会话机制（claim 拒绝、干净启动、wiki-maintenance-run/v1、隐藏列表里任务的这种用法）和 runner 侧的模型代码。',
  ],
  // 现在：P1a / P1b 没被认作编号，标题截到 23 个字符拼进来（StartProject.planTaskLabel）
  orderToday: 'P1a · wiki-worker 服务骨架与… starts now · P1b · wiki_job 作业表与模型请求… after P1a · wiki-worker 服务骨架与… · P2, P3 after P1b · wiki_job 作业表与模型请求… · P4, P5, P6, P7 after P1b · wiki_job 作业表与模型请求… and P2 · P9 after P1b · wiki_job 作业表与模型请求… and P3 · P8 after P2, P3, P6 and P7 · P10 after P4, P5, P8 and P9 · P11 after P10',
  orderFixed: 'P1a starts now · P1b after P1a · P2, P3 after P1b · P4, P5, P6, P7 after P1b and P2 · P9 after P1b and P3 · P8 after P2, P3, P6 and P7 · P10 after P4, P5, P8 and P9 · P11 after P10',
  flagged: [1, 2, 3, 4, 5, 7],
  why: '计划已写好：7 条验收标准都有任务对应，12 个任务的依赖已经连好。建议先在项目分支上合并、跑合并检查，再由你确认进 main，因为 main 会部署到生产。并发 3，让 P3–P7 可以并行。',
  note: '这些任务都会提交代码；真正不写代码的只有 P10，已经声明过了。',
  branch: 'project/34bmzOkov3xN2yLPrnsCk',
  mergeCheck: 'bash scripts/worktree-overlay.sh && (cd src/apiserver && rm -rf build && npm test) && (cd src/shared && npx vitest run) && (cd src/web && npx vitest run --maxWorkers=2) && (cd src/runner-go && go test ./...) && npm run test:compose-topology',
};

// 服务端原句（project-start-request.ts），iOS / Web 原样画成橙色
const serverWarning = (n) => `criterion ${n} is served only by work that looks like it produces no code (OWNER_CONFIRMED, or EVIDENCE_JUDGMENT with no acceptance command) and none of it declares codeless: work with no commit to land can hold the criterion off LANDED, and the project off done`;

// 方案的英文界面文案（与 lib/projectStart.ts 共用，见规格图）
const W = {
  title: "Orbit can't tell if 11 tasks write code",
  sub: "Fine if they do — if not, done can stall",
  why: "They're settled on evidence, not by a command, so Orbit can't see whether they'll commit. One that ends with no commit can keep its criterion from landing — and the project from done — until it's marked “No code to land”.",
  criteria: '1–5 and 7',
  tasks: 'P1a, P1b, P2, P3, P4, P5, P6, P7, P8, P9 and P11',
  next: "Nothing to do if they all write code. If some won't, ask the coordinator to mark them.",
};

const ICON = {
  play: '<svg class="f" width="11" height="12" viewBox="0 0 11 12"><path d="M1.5 1.2v9.6c0 .6.6.9 1.1.6l7.6-4.8c.5-.3.5-.9 0-1.2L2.6.6C2.1.3 1.5.6 1.5 1.2z"/></svg>',
  tri: (cls) => `<svg class="f ic ${cls}" width="16" height="15" viewBox="0 0 16 15"><path d="M6.6 1.1c.6-1.1 2.2-1.1 2.8 0l6.1 11.2c.6 1.1-.2 2.4-1.4 2.4H1.9C.7 14.7-.1 13.4.5 12.3z"/><rect x="7.15" y="4.4" width="1.7" height="5.6" rx=".85" fill="#2B2B2E"/><circle cx="8" cy="12" r="1" fill="#2B2B2E"/></svg>`,
  info: '<svg class="i ic calm" width="16" height="16" viewBox="0 0 16 16" stroke-width="1.4"><circle cx="8" cy="8" r="6.8"/><path d="M8 7.2v4.2"/><circle cx="8" cy="4.8" r=".55" fill="currentColor"/></svg>',
  down: '<svg class="i chev" width="12" height="12" viewBox="0 0 12 12" stroke-width="1.8"><path d="M2.5 4.3 6 7.8l3.5-3.5"/></svg>',
  up: '<svg class="i chev" width="12" height="12" viewBox="0 0 12 12" stroke-width="1.8"><path d="M2.5 7.7 6 4.2l3.5 3.5"/></svg>',
  updown: '<svg class="i" width="9" height="13" viewBox="0 0 9 13" stroke-width="1.6"><path d="M1.5 4.5 4.5 1.5l3 3M1.5 8.5l3 3 3-3"/></svg>',
  check: '<svg class="f" width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="7"/><path d="M4 7.2 6.1 9.2 10.1 4.9" fill="none" stroke="#1A242E" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  focus: '<svg class="f" width="15" height="17" viewBox="0 0 15 17"><rect x="0" y="0" width="15" height="17" rx="3"/><circle cx="7.5" cy="6.2" r="2.4" fill="#000"/><path d="M3.2 13.2c.6-2.2 2.3-3.2 4.3-3.2s3.7 1 4.3 3.2z" fill="#000"/></svg>',
};

/* 一种提醒一行。v：'collapsed' | 'expanded' | 'note' */
function warnRow(v) {
  if (v === 'note') {
    return `<div class="pr wr" data-mk-note>
      <div class="wh">${ICON.info}
        <div class="wtx"><b>${W.title}</b><span class="quote">Coordinator: “${D.note}”</span></div>
        ${ICON.down}</div></div>`;
  }
  const open = v === 'expanded';
  return `<div class="pr wr" data-mk-warn>
    <div class="wh">${ICON.tri('amber')}
      <div class="wtx"><b>${W.title}</b><span>${W.sub}</span></div>
      ${open ? ICON.up : ICON.down}</div>
    ${open ? `<div class="wd" data-mk-detail>
      <p>${W.why}</p>
      <dl class="facts"><dt>Criteria</dt><dd>${W.criteria}</dd><dt>Tasks</dt><dd>${W.tasks}</dd></dl>
      <p>${W.next}</p></div>` : ''}
  </div>`;
}

/* 整张卡。v：'today' | 'collapsed' | 'expanded' | 'note' */
function card(v) {
  const today = v === 'today';
  return `<div class="cd">
    <div class="hd">${ICON.play}<span>Start this project?</span></div>
    <div class="meta">${D.project} · asked by the coordinator · 56m ago · seal 7c1e9a42</div>
    <div class="sh">Done when · 7 criteria</div>
    ${D.criteria.map((t, i) => `<div class="cr"><i>${i + 1}</i><p>${t}</p></div>`).join('')}
    <div class="rl">Read all 7 in full</div>
    <div class="sh" data-anchor>Plan · 12 tasks</div>
    <div class="pn" data-plan>
      <div class="pr stack">
        <div class="ord" data-mk-order>${today ? D.orderToday : D.orderFixed}</div>
        <div class="vt">View tasks ›</div>
        ${today ? `<div class="stack" data-mk-warns>${D.flagged.map((n) => `<div class="wt">⚠\uFE0E ${serverWarning(n)}</div>`).join('')}</div>` : ''}
      </div>
      ${today ? '' : `<div class="dv"></div>${warnRow(v)}`}
    </div>
    <div class="sh" data-howhead>How it runs <span>suggested by the coordinator</span></div>
    <div class="pn">
      <div class="pr"><div class="h">Tasks land on<span class="v">A project branch ${ICON.updown}</span></div>
        <div class="mono">${D.branch}</div></div>
      <div class="dv"></div>
      <div class="pr"><div class="h">Automatic<span class="sw"></span></div>
        <div class="s">The coordinator runs it for you: it decides when each task is done, handles conflicts and failed checks, and merges the branch into main once the merge check passes — with a receipt you can revert. The criteria and anything irreversible stay yours.</div></div>
      <div class="dv"></div>
      <div class="pr"><div class="h">At most<span class="q">3 tasks at a time</span><span class="stp"><span>−</span><span>+</span></span></div></div>
      <div class="dv"></div>
      <div class="pr"><div class="h">Merge check</div><div class="cmd">${D.mergeCheck}</div>
        <div class="s">Runs on the combined tree before anything lands — on the project branch and again before main.</div></div>
    </div>
    <div class="coq">Coordinator: “${D.why}”</div>
    <div class="ck">${ICON.check}<span>Orbit checked the plan: every criterion has a task serving it · every task has a runner · repository jianghailong-xy/orbit</span></div>
    <div class="ex">Orbit derives done from these 7 criteria and nothing else. If they change later, it asks you to confirm the new version — the project keeps running.</div>
    <div class="go" data-start>Start the project</div>
  </div>`;
}

function phone(v) {
  return `<div class="phone" data-v="${v}">
    <div class="status"><span class="l">9:55 ${ICON.focus}</span>
      <span class="r"><span class="bars"><i style="height:4px"></i><i style="height:6.5px"></i><i style="height:9px"></i><i style="height:11.5px"></i></span>
      <span style="font-size:15px">5G</span><span class="batt"><b>48</b><i></i></span></span></div>
    <div class="sheet"><div class="sc">${card(v)}</div></div>
    <div class="cancel">Cancel</div>
    <div class="sbar"></div>
  </div>`;
}

const SHEET_TOP = 58, SCREEN = 852, ANCHOR_Y = 212;

/* 把每部手机滚到同一处：PLAN 小标题落在屏幕 y=212（截图里的位置），再画滚动条和标注。可重复调用。 */
function layoutPhone(ph, marks) {
  const sc = ph.querySelector('.sc');
  sc.style.transform = 'none';
  ph.querySelectorAll('.mkbox').forEach((m) => m.remove());
  const pr = ph.getBoundingClientRect();
  const head = ph.querySelector('[data-anchor]').getBoundingClientRect();
  const scroll = Math.round(head.top - pr.top - ANCHOR_Y);
  sc.style.transform = `translateY(${-scroll}px)`;
  const visible = SCREEN - SHEET_TOP, content = sc.offsetHeight + 34;
  const h = Math.max(36, visible * visible / content);
  const bar = ph.querySelector('.sbar');
  bar.style.height = `${h - 12}px`;
  bar.style.top = `${SHEET_TOP + 6 + (scroll / (content - visible)) * (visible - h)}px`;
  ph.dataset.content = String(content);
  for (const [sel, n, opts = {}] of marks) {
    const el = ph.querySelector(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const pad = opts.pad ?? 4;
    const top = Math.max(r.top - pr.top - pad, SHEET_TOP + 8);
    const bottom = Math.min(r.bottom - pr.top + pad, SCREEN - 8);
    const box = document.createElement('div');
    box.className = 'mkbox';
    box.style.left = `${r.left - pr.left - pad}px`;
    box.style.width = `${r.width + pad * 2}px`;
    box.style.top = `${top}px`;
    box.style.height = `${bottom - top}px`;
    box.innerHTML = `<span class="badge" style="${opts.badge ?? ''}">${n}</span>`;
    ph.appendChild(box);
  }
}

/* 整张卡的缩略（规格图的长度对比）：返回内容高度（pt）。 */
function thumb(host, v, scale) {
  host.innerHTML = `<div class="inner" style="transform:scale(${scale})"><div style="padding:16px">${card(v)}</div></div>`;
  const inner = host.querySelector('.inner');
  const h = inner.offsetHeight;
  host.style.width = `${393 * scale}px`;
  host.style.height = `${h * scale}px`;
  return h;
}
