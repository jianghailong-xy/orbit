// Writes docs/mocks/attached-context-note/: board.html (marks placed from shots/boxes.json), the frames it
// uses (shots/), and prototype.patch. render.mjs then shoots each #part-N into its own PNG.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const KIT = '/var/tmp/attach-note-mock';
const WT = '/root/.orbit/worktrees/01a17c4a-2917-730f-b47a-4da0f9b5cd27';
const DIR = `${WT}/docs/mocks/attached-context-note`;
mkdirSync(`${DIR}/shots`, { recursive: true });
copyFileSync(`${KIT}/prototype.patch`, `${DIR}/prototype.patch`);
const B = JSON.parse(readFileSync(`${KIT}/shots/boxes.json`, 'utf8'));

const patchLines = readFileSync(`${KIT}/prototype.patch`, 'utf8').split('\n');
const ADDED = patchLines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
const REMOVED = patchLines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
const pct = (v, of) => `${((v / of) * 100).toFixed(2)}%`;
/** A part of the line, hung from the line's own bottom so its pins sit level. */
const onLine = (b, part) => ({ x: part.x, w: part.w, y: b.head.y, h: b.head.h });
const union = (...r) => {
  const x = Math.min(...r.map((b) => b.x)), y = Math.min(...r.map((b) => b.y));
  return { x, y, w: Math.max(...r.map((b) => b.x + b.w)) - x, h: Math.max(...r.map((b) => b.y + b.h)) - y };
};

/** A real frame, copied in, with dashed numbered marks over named boxes. */
function fig(name, marks = []) {
  copyFileSync(`${KIT}/shots/${name}.png`, `${DIR}/shots/${name}.png`);
  const b = B[name];
  const c = b.clip;
  const m = marks.map(([key, n, { pad = 4, cls = '', at = '', pin = false } = {}]) => {
    const r = typeof key === 'string' ? b[key] : key(b);
    if (!r) throw new Error(`${name}: no box ${key}`);
    // A pin hangs under what it names instead of boxing it, for a line too thin to draw a box over.
    if (pin) return `<span class="b-pin ${cls}" style="left:${pct(r.x + r.w / 2, c.width)};top:${pct(r.y + r.h + 1, c.height)}"><span class="m-n">${n}</span></span>`;
    const style = `left:${pct(r.x - pad, c.width)};top:${pct(r.y - pad, c.height)};width:${pct(r.w + 2 * pad, c.width)};height:${pct(r.h + 2 * pad, c.height)}`;
    return `<span class="b-mk ${cls} ${at}" style="${style}"><span class="m-n">${n}</span></span>`;
  }).join('');
  return `<div class="b-fig"><img class="b-shot" src="shots/${name}.png" alt="">${m}</div>`;
}
const px = (name, key) => Math.round(B[name][key].h);
const wpx = (name, key) => Math.round(B[name][key].w);
const ui = (s) => `<span class="ui">${s}</span>`;
const good = { cls: 'good' };

const H_TODAY = px('today-jobs-folded', 'bubble'), H_A = px('a-jobs-folded', 'bubble');
const NOTE_TODAY = px('today-jobs-folded', 'note');
const CARD_TODAY = px('today-card-folded', 'note'), CARD_A = px('a-card-folded', 'note');
const B_WORDS = wpx('b-multi-folded', 'bubble'), B_CHIP = wpx('b-multi-folded', 'note');

const html = `<!doctype html>
<!-- Design board, 2026-10-27: the note Orbit attaches to a message ("Orbit context"), from a card back to one line.
     Every picture is a real page: this branch's src/web (main 6880a6fc4) built with vite and drawn by Chromium at
     1280 wide (390 for the phone frames), 2x, fed by src/web/ui-migration's fixtures plus a sample conversation
     (sample tables and titles, nothing of the owner's). "Today" is the branch as it is; A is the same page built from
     a copy with prototype.patch applied; B is A with the line moved out of the bubble. Dashed outlines and numbers
     are drawn on top. Kit: /var/tmp/attach-note-mock (scripts/data.mjs, capture.mjs, make-board.mjs, render.mjs). -->
<html lang="zh">
<head>
<meta charset="utf-8">
<title>消息上的 Orbit 附加上下文：从一张卡改回一行</title>
<link rel="stylesheet" href="../../../src/web/src/index.css">
<link rel="stylesheet" href="../project-progress/mock.css">
<style>
  .m-sheet { width: 1440px; }
  .m-sheet + .m-sheet { padding-top: 0; }
  .b-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 30px; align-items: start; }
  .b-cols3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; align-items: start; }
  .b-phones { display: grid; grid-template-columns: repeat(3, 300px) minmax(0, 1fr); gap: 24px; align-items: start; }
  .b-fig { position: relative; }
  .b-shot { display: block; width: 100%; border-radius: 10px; background: #fff;
            box-shadow: 0 0 0 1px rgba(15, 23, 42, .09), 0 1px 3px rgba(15, 23, 42, .06); }
  .b-mk { position: absolute; border: 1.5px dashed var(--warning-solid); border-radius: 7px; pointer-events: none; }
  .b-mk > .m-n { position: absolute; top: -11px; right: -11px; margin: 0; box-shadow: 0 0 0 2px #fff; }
  .b-mk.left > .m-n { right: auto; left: -11px; }
  .b-mk.good { border-color: #16833a; }
  .b-mk.good > .m-n { background: #16833a; }
  .b-pin { position: absolute; display: flex; flex-direction: column; align-items: center; transform: translateX(-50%);
           pointer-events: none; }
  .b-pin::before { content: ''; width: 1.5px; height: 12px; background: var(--warning-solid); }
  .b-pin > .m-n { margin: 0; box-shadow: 0 0 0 2px #fff; }
  .b-pin.good::before, .b-pin.good > .m-n { background: #16833a; }
  .b-h { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; font-size: 14px; font-weight: 600; color: var(--text-1); }
  .b-h .m-k.rec { background: #e8f7ee; color: #16833a; }
  .b-cap { margin: 10px 2px 0; font-size: 12.5px; line-height: 1.8; color: var(--text-2); }
  .b-cap b { color: var(--text-1); }
  .ui { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 12px; padding: 0 5px;
        border-radius: 4px; background: #f0f2f5; color: var(--text-1); white-space: nowrap; }
  .b-list { margin: 14px 0 0; padding: 12px 16px; list-style: none; background: #f5f6f8; border-radius: 8px;
            font-size: 12.5px; line-height: 1.8; color: #3f4652; }
  .b-list li { display: flex; gap: 8px; }
  .b-list li + li { margin-top: 6px; }
  .b-list b { color: var(--text-1); }
  .b-list .m-n.good { background: #16833a; }
  .b-list .dot { flex: none; width: 18px; text-align: center; color: var(--text-3); }
  .b-list code, .b-cap code, .b-files code, .b-ask code { font-size: 11.5px; }
  .b-stat { display: flex; gap: 26px; margin: 16px 0 0; padding: 12px 16px; border-radius: 8px; background: #fff;
            border: 1px solid #dde0e6; font-size: 12.5px; color: var(--text-2); }
  .b-stat b { color: var(--text-1); font-size: 15px; }
  .b-stat .to { color: #16833a; }
  .b-ask { margin-top: 18px; padding: 14px 18px; border-radius: 8px; background: #fff8e6; border: 1px solid #f5d79e;
           font-size: 13px; line-height: 1.85; color: #5c4210; }
  .b-ask b { color: #3d2b08; }
  .b-ask .rec { color: #16833a; font-weight: 700; }
  .b-ask .alt { color: #8a6a2c; font-weight: 700; }
  .b-ask ul { margin: 6px 0 0; padding-left: 20px; }
  .b-files { margin: 0; padding: 14px 18px; list-style: none; background: #f5f6f8; border-radius: 8px;
             font-size: 12.5px; line-height: 1.8; color: #3f4652; counter-reset: step; }
  .b-files > li { position: relative; padding-left: 30px; }
  .b-files > li + li { margin-top: 12px; }
  .b-files > li::before { counter-increment: step; content: counter(step); position: absolute; left: 0; top: 2px;
                          width: 20px; height: 20px; border-radius: 5px; background: var(--text-1); color: #fff;
                          font: 700 12px/20px -apple-system, "Inter", sans-serif; text-align: center; }
  .b-files b { color: var(--text-1); }
  .b-files ul { margin: 4px 0 0; padding-left: 18px; }
  .b-aside { margin-top: 16px; padding: 10px 14px; border-radius: 8px; border: 1px dashed #c9ced6;
             font-size: 12.5px; line-height: 1.8; color: var(--text-2); }
</style>
</head>
<body class="m">

<section class="m-sheet" id="part-1">
  <h1 class="m-h1 zh">消息上的「Orbit context」：从一张卡改回一行</h1>
  <p class="m-sub zh" style="line-height:1.85">就是你截图里那一条。同一份示例数据，<b>左右都是真实页面</b>：左边是现在的 Web（main 6880a6fc4），右边只改了 ${ui('ControlPlaneNote')} 这一个组件和它的样式（同目录的 <code>prototype.patch</code>）。说明写中文；界面上的字是上线文案，英文。</p>
  <div class="m-stage">
    <div class="m-stage-l zh"><span class="m-k">后台任务</span>Orbit 在你的消息后面附上了三个后台任务的状态：1 个在跑、1 个跑完、1 个失败</div>
    <div class="b-cols">
      <div>
        <div class="b-h zh"><span class="m-k">现在</span>一行问题，配一张 ${NOTE_TODAY}px 高的卡</div>
        ${fig('today-jobs-folded', [['head', 1], ['summary', 2], ['para', 3], ['action', 4]])}
        <ul class="b-list zh">
          <li><span class="m-n">1</span><span>这一行只写了类型（${ui('Attached · background jobs')}）。代码其实一直在算整句 ${ui('⊕ Orbit attached: background jobs · 1 running, 1 ended, 1 failed')}，10-05 的样式用 <code>font-size: 0</code> 把它藏了，换成 CSS 里写死的两行字。所以<b>有没有失败、值不值得点开，看不出来</b>；读屏读到的还是被藏的那句，看到的和读到的不一样。</span></li>
          <li><span class="m-n">2</span><span>${ui('Orbit context')}、${ui('Attached')} 又各说一遍。</span></li>
          <li><span class="m-n">3</span><span>每一条都是这句话，没说这一条里是什么。</span></li>
          <li><span class="m-n">4</span><span>第二个入口，和点 1 一样都是展开。</span></li>
          <li><span class="dot">·</span><span>气泡被撑到 ${H_TODAY}px 高、撑满最大宽度，<b>你自己那句话成了气泡里最小的东西</b>。蓝气泡套蓝卡，卡里再套白按钮，三层框。</span></li>
        </ul>
      </div>
      <div>
        <div class="b-h zh"><span class="m-k rec">建议 A</span>气泡底部一行</div>
        ${fig('a-jobs-folded', [[(b) => onLine(b, union(b.by, b.kind)), 5, { ...good, pin: true }], [(b) => onLine(b, b.facts), 6, { ...good, pin: true }], [(b) => onLine(b, b.chevron), 7, { ...good, pin: true }]])}
        <ul class="b-list zh">
          <li><span class="m-n good">5</span><span>谁加的、加了什么：${ui('⊕ Orbit attached: background jobs')}。就是 1 里被藏起来的那句，原字原样放出来。</span></li>
          <li><span class="m-n good">6</span><span>现在怎么样：失败红、在跑蓝、成功绿，用的是现有的颜色变量。<b>不点开就知道该不该点。</b></span></li>
          <li><span class="m-n good">7</span><span>只有一个入口：整行可点，${ui('›')} 转成 ${ui('⌄')}，再点收起。悬停提示 ${ui('Added by Orbit on delivery: the agent read it with this message.')}</span></li>
          <li><span class="dot">·</span><span>上面一条细线，分开你的话和 Orbit 加的。气泡回到贴着字的宽度。</span></li>
        </ul>
        <div class="b-stat zh"><span>气泡高度 <b>${H_TODAY}</b> → <b class="to">${H_A}px</b></span><span>这条注 <b>${NOTE_TODAY}</b> → <b class="to">${px('a-jobs-folded', 'note')}px</b></span><span>任务卡里的注 <b>${CARD_TODAY}</b> → <b class="to">${CARD_A}px</b></span></div>
      </div>
    </div>
  </div>
</section>

<section class="m-sheet" id="part-2">
  <div class="m-stage">
    <div class="m-stage-l zh"><span class="m-k">整页</span>同一个窗口（1280×900）、同一段对话：三条消息，每条都带了东西</div>
    <div class="b-cols">
      <div>
        <div class="b-h zh"><span class="m-k">现在</span></div>
        ${fig('today-page')}
        <p class="b-cap zh">两条消息就占满一屏，第二张卡压在输入框底下。</p>
      </div>
      <div>
        <div class="b-h zh"><span class="m-k rec">建议 A</span></div>
        ${fig('a-page')}
        <p class="b-cap zh">三条消息、三段回复都在一屏里。哪条带了什么、哪条有失败，扫一眼就知道。</p>
      </div>
    </div>
  </div>
</section>

<section class="m-sheet" id="part-3">
  <div class="m-stage">
    <div class="m-stage-l zh"><span class="m-k state">展开</span>点开之后</div>
    <div class="b-cols">
      <div>
        <div class="b-h zh"><span class="m-k">现在</span>点 ${ui('View full context')}</div>
        ${fig('today-jobs-open', [['head', 1]])}
        <p class="b-cap zh"><b>1</b> 标题行变成一条白带，下面的行贴着卡边。展开后的内容（还在跑 / 你不在时结束了 / 原文）本身没问题，这次不动。</p>
      </div>
      <div>
        <div class="b-h zh"><span class="m-k rec">建议 A</span>点那一行</div>
        ${fig('a-jobs-open', [['head', 2, good], ['panel', 3, good]])}
        <p class="b-cap zh">就地展开，还在这个气泡里。<b>2</b> 那一行留在上面，摘要还在，箭头朝下，再点收起。<b>3</b> 下面是现有的行，一行一个任务，命令原文在 ${ui('The block, verbatim')} 里。</p>
      </div>
    </div>
  </div>
</section>

<section class="m-sheet" id="part-4">
  <div class="m-stage">
    <div class="m-stage-l zh"><span class="m-k">别处</span>同一个组件也画在任务卡、唤醒行、别的会话发来的消息里：到处都是这一行</div>
    <div class="b-cols3">
      <div>
        <div class="b-h zh"><span class="m-k">现在</span>任务开始卡</div>
        ${fig('today-card-folded', [['note', 1]])}
        <p class="b-cap zh"><b>1</b> 卡底带的 Wiki 笔记：卡里又是一张 ${CARD_TODAY}px 的卡。</p>
      </div>
      <div>
        <div class="b-h zh"><span class="m-k rec">建议 A</span>任务开始卡</div>
        ${fig('a-card-folded', [['head', 2, { ...good, pin: true }]])}
        <p class="b-cap zh"><b>2</b> 卡底一行，和上面的 ${ui('Task … · 50m ago')} 一个分量。卡片有自己的分隔线，这里不再画细线。</p>
      </div>
      <div>
        <div class="b-h zh"><span class="m-k rec">建议 A</span>展开</div>
        ${fig('a-card-open')}
        <p class="b-cap zh">三条 Wiki 笔记，标题可点（现有的行）。</p>
      </div>
    </div>
    <div class="b-cols" style="margin-top:26px">
      <div>
        <div class="b-h zh"><span class="m-k rec">建议 A</span>引用了两个任务</div>
        ${fig('a-tasks-folded')}
        <p class="b-cap zh">数字还是现在摘要里的字（${ui('1 DONE, 1 IN_PROGRESS')}），只上色：完成绿、进行中蓝、失败红。</p>
        <div class="b-h zh" style="margin-top:18px"><span class="m-k rec">建议 A</span>一次带了两块</div>
        ${fig('a-multi-folded')}
        <p class="b-cap zh">${ui('继续')} 带了后台任务和项目协调说明：类型都列出来，数字跟在后面（说的是后台任务，沿用现在的写法）。</p>
      </div>
      <div>
        <div class="b-h zh"><span class="m-k rec">建议 A</span>两个任务，展开</div>
        ${fig('a-tasks-open')}
        <p class="b-cap zh">现有的任务行，标题可点。</p>
      </div>
    </div>
  </div>
</section>

<section class="m-sheet" id="part-5">
  <div class="m-stage">
    <div class="m-stage-l zh"><span class="m-k">深色 · 手机宽度</span></div>
    <div class="b-cols">
      <div>${fig('a-jobs-folded-dark')}<p class="b-cap zh">深色：全是现有颜色变量，没加新颜色。</p></div>
      <div>${fig('a-jobs-open-dark')}</div>
    </div>
    <div class="b-phones" style="margin-top:26px">
      <div><div class="b-h zh"><span class="m-k">现在</span>390 宽</div>${fig('today-phone-jobs-folded')}</div>
      <div><div class="b-h zh"><span class="m-k rec">建议 A</span>390 宽</div>${fig('a-phone-jobs-folded')}</div>
      <div><div class="b-h zh"><span class="m-k rec">建议 A</span>展开</div>${fig('a-phone-jobs-open')}</div>
      <p class="b-cap zh" style="margin-top:34px">手机宽度：放不下就换行，不截断。气泡最多占屏宽 80%，现在这张卡一出现就把它撑满。</p>
    </div>
  </div>
</section>

<section class="m-sheet" id="part-6">
  <div class="m-stage">
    <div class="m-stage-l zh"><span class="m-k state">待定 · 要你拍板</span>这一行放在气泡里（A），还是挪到气泡下面（B）？</div>
    <div class="b-cols3">
      <div>
        <div class="b-h zh"><span class="m-k">B</span>气泡下面一颗胶囊</div>
        ${fig('b-jobs-folded', [['note', 1]])}
        <p class="b-cap zh"><b>1</b> 气泡里只剩你打的字，Orbit 加的在气泡外面。</p>
      </div>
      <div>
        <div class="b-h zh"><span class="m-k">B</span>短消息</div>
        ${fig('b-multi-folded', [['bubble', 2, { at: 'left' }], ['note', 3]])}
        <p class="b-cap zh"><b>2</b> ${ui('继续')}：气泡 ${B_WORDS}px 宽；<b>3</b> 胶囊 ${B_CHIP}px 宽。附加的东西看着比消息本身还重。</p>
      </div>
      <div>
        <div class="b-h zh"><span class="m-k">B</span>展开</div>
        ${fig('b-jobs-open', [['note', 4]])}
        <p class="b-cap zh"><b>4</b> 展开后是气泡下面的第二张卡：一条消息变成两个东西。</p>
      </div>
    </div>
    <div class="b-ask zh">
      <span class="rec">A · 气泡里一行（推荐）</span>：一条消息还是一个东西；同一行在气泡、任务卡、唤醒行、别的会话发来的消息里长得一样；iOS 的气泡里本来就有这条分隔线（${ui('UserBubbleView')}），10-05 之前 Web 和 iOS 都是一行。<br>
      <span class="alt">B · 气泡下面一颗胶囊</span>：归属最清楚，气泡里全是你打的字。代价是上面 2–4；而且任务卡、唤醒行里没有气泡，B 在那里只能退回 A 的样子，两种写法并存。<br>
      <b>推荐 A。</b>选 B 的话，改动多一处（${ui('UserBubble')} 把这一行挪出气泡，另加胶囊样式），三端都要跟着挪。
    </div>
  </div>
</section>

<section class="m-sheet" id="part-7">
  <div class="m-stage">
    <div class="m-stage-l zh"><span class="m-k">落地（按代价排）</span>Web 和 iOS/macOS 是 10-05 同一个提交（<code>0d23b89fc</code>，给任务通知卡做设计时顺手）从一行改成卡的，Android 10-09 照着做了同一张卡：建议三端一起改成这一行</div>
    <ol class="b-files zh">
      <li><b>Web</b>（最小，这台机器上能验）
        <ul>
          <li><code>Transcript.tsx</code> 的 <code>ControlPlaneNote</code>：删掉 overview 那一块；现有那句话按段上色、加 ${ui('›')}；按钮的 <code>aria-label</code> 就是那句话（不带箭头图标的名字）。</li>
          <li><code>index.css</code> 的 <code>.chat-injected*</code>：删掉 overview / summary / action 三组和 <code>font-size: 0</code> 那套。<code>prototype.patch</code> 就是截图用的改动：2 个文件，+${ADDED} / −${REMOVED}。</li>
          <li>测试：相关的 12 个文件跑了一遍（235 条），<b>3 条要跟着改</b>，都钉着卡片：10-05 加的那条（${ui('Orbit context')} / ${ui('View full context')}）、<code>SessionReplyCard.test.tsx:158</code>、<code>Transcript.test.tsx</code> 里按按钮整段 innerHTML 匹配的那条。<code>indexCss</code>（每个选择器只出现一次）通过。</li>
          <li>OrbitKit 有三个 Swift 测试读 web 源码，钉着 ${ui('`⊕ Orbit attached: ${kind}`')}、${ui('` · ${summarizeBackgroundJobs(jobs)}`')} 这几行。patch 原样留着它们（拼成 <code>aria-label</code>），我逐条核对过都还在；Swift 测试没在这台机器上跑。</li>
        </ul>
      </li>
      <li><b>iOS / macOS</b>（同一份 SwiftUI：<code>AttachedNoteView.swift</code> 的 <code>AttachedNoteEntry</code>）
        <ul>
          <li>改成一行 Button：⊕ + 字 + 上色的数字 + ›；删掉 ${ui('Orbit context')} / ${ui('Attached to this message')} / ${ui('View full context')} 那一块和外面的底色框。气泡里的分隔线本来就在。</li>
          <li>这台 Linux 编不了 SwiftUI：靠 macOS CI，再在你手机上看一眼。</li>
        </ul>
      </li>
      <li><b>Android</b>（<code>AttachedNote.kt</code> 的 <code>AttachedNoteCard</code>）
        <ul>
          <li>同上；<code>AttachedNoteTest.kt</code> 和 <code>TranscriptDeviceTest.kt:186</code> 里找 ${ui('Attached to this message')} 的断言改掉。</li>
        </ul>
      </li>
    </ol>
    <div class="b-aside zh"><b>顺带看到，不在这次范围：</b>气泡里的 <code>#</code> 任务胶囊带着下划线（「引用了两个任务」那两张图）。<code>.chat-user a</code> 的优先级（0,1,1）压过了 <code>.md-reference</code>（0,1,0），可样式注释里写的是它不带下划线。</div>
  </div>
</section>

</body>
</html>
`;
writeFileSync(`${DIR}/board.html`, html);
console.log('wrote', `${DIR}/board.html`);
