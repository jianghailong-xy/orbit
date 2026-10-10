# WebKit 经典滚动条下任务页工具栏的高度

服务于 [WebKit 经典滚动条下任务页工具栏高度：批量栏出现后 .tasks-toolbar 停在 34px](orbit-task:34coPBqt8gi229cVNds0E)，项目 [Orbit Web 组件迁移](orbit-project:34ZZeq0e3IR65GVm2kAs7) 的验收条目 key `hnPVsE0kmorHXurrs4Qdp`：**P4：全部非会话业务界面完成迁移，既有页面操作和响应式呈现保持一致。** 起因是 [P4.3a](orbit-task:34Za39GvWRQ08ZmKOpFNe) 记下的差异（[p4.3a README「未消除的差异」](../p4.3a/README.md#未消除的差异)与[「重复运行」](../p4.3a/README.md#重复运行)）。

**交付**：两个提交接在项目 tip `d580e572d` 上（P4.4 已落地，见[跟上 origin/main](#跟上-originmain)），之后是本目录的证据提交。最终检查先在 origin/main `9c86b3dfe` 上的同样两个提交（`0b45f9849`、`423aa3fdb`）上跑完；项目线随后前进，rebase 之后受影响的检查又在新的两棵树上跑了一遍（[第二次跟上之后](#第二次跟上之后项目-tip-d580e572d)）。

| 提交 | 内容 |
| --- | --- |
| `0783959ca` fix(web)（与 `0b45f9849` 相同） | `TaskListView.tsx`：工具栏以批量栏的高度（含批量栏自己的滚动条）为最小高度；单测 `TaskListView.toolbarHeight.test.tsx` |
| `1243db2bb` test(web)（`423aa3fdb` 加上 P4.4 的 testIgnore 项） | 常驻几何用例 `ui-migration/tasks-toolbar.browser.mjs` 与它的配置 `tasks-toolbar.config.mjs`；标准 P0 的配置不收它（`playwright.config.mjs` 的 testIgnore 多一项） |

## 结论

- **现象**：任务打开、列表区变窄时，批量栏放不下按钮，带上它自己 8px 的横向滚动条（42px）。WebKit 里装它的 `.tasks-toolbar` 停在没有滚动条时的 34px，列表上移 8px，列标题行顶到批量栏的滚动条下沿。反方向也有：批量栏失去滚动条（关掉任务、窗口变宽）时，工具栏停在 42px，列表下移 8px。
- **出现率**（[现象与复现](#现象与复现)）：项目 tip 与 P4.3a 落地前的项目线 `bb007810b`（任务页还是 AntD）上都常见。P4.3a 自己的几何探针各跑 4 轮，WebKit 明暗桌面 tip **52/64**、`bb007810b` **41/64** 停在 34px（第一次运行 59/64 对 58/64）。关掉任务、窗口拉宽再窄回这几步，两棵树上都是 8/8；任务打开时点击复选框，tip 16/16、`bb007810b` 11/16。
- **原因**（[原因](#原因)）：WebKit 等页面列的 flex 布局整个排完，才决定 `overflow: auto` 的批量栏要不要滚动条，决定之后只把批量栏自己重排一遍；装它的工具栏留在没有滚动条时算出的高度，要等以后某次布局碰巧再排到工具栏才改过来。独立的最小页面能稳定复现，与 Orbit 或 AntD 控件无关。
  - P4.3a 看到交付更常出现（参照 2/12、交付 8/12）。本任务里两棵树都是多数停住，比例随轮次在变：几何探针第一次 59 对 58、重跑 52 对 41，观察探针第一次 8/16 对 15/16、重跑 15/16 对 10/16。重跑时 tip 一侧更多，第一次持平或相反，合计 111/128 对 99/128，差别远小于 P4.3a 的 8/12 对 2/12，也小于同一棵树两轮之间的波动。停不停住取决于之后是否碰巧又有一次布局排到工具栏（见[为什么 P4.3a 的计数显示迁移后更常出现](#为什么-p43a-的计数显示迁移后更常出现)）。
- **修正**（[修正](#修正)）：工具栏以批量栏的实际高度为最小高度。在可能让滚动条出现或消失的 React 提交里（批量栏出现、选中数变化、打开或关掉任务、切换视图），布局效果读一次批量栏的高度，WebKit 在首帧绘制之前就定下滚动条；只有周围空间变化时（窗口、任务面板拖宽），由批量栏的 ResizeObserver 在下一帧跟上。
  - 不改 CSS 规则：试过的纯 CSS 做法要么照样停在 34px，要么改变不溢出时的样子（见[没有采用的做法](#没有采用的做法)）。
- **与 P4.3a 之前的 AntD 页面一致**：修正后 WebKit 里每次都是不停住的排法，几何逐项相同（工具栏 143.8+42，列标题 194.8，列表顶边 193.8）。这是 AntD 页面在 P4.3a 参照树上多数运行（12 次中 10 次）、在本任务的 `bb007810b` 上少数运行（两次共 128 次中 29 次）排出的样子；按键截图里列表这一列与 P4.3a 留下的那张逐字节相同（[对比](#与-p43a-之前的-antd-页面对比)）。工具栏的高度本来就应由它装的批量栏决定，批量栏的边框盒含它的滚动条。不溢出时（没有打开任务）仍是 34px；Chromium（无头模式的滚动条不占位置）一直是 34px，都与修正前相同。
- **常驻用例与统计**（[常驻用例与单测](#常驻用例与单测)）：
  - `tasks-toolbar.browser.mjs` 在修正前（基础 `9c86b3dfe`）每一轮都失败。重跑的两轮里 WebKit 48 个用例失败 35 个：关掉任务、窗口窄回 1280px 都是 16/16 不对，拉宽到 1920px 14/16，任务打开时按 Space 或点击复选框 3/16、4/16。第一次运行的两轮是 48 个全部失败，每步 16/16。修正后五轮 240 个全部通过，每步 0/40，第一次运行的五轮也一样；项目 tip 上的交付又跑 2 轮，96 个全部通过（修正前的项目 tip 1 轮失败 23 个）。
  - P4.3a 的几何探针：修正前在基础上 10/32 停在 34px（第一次运行 30/32，项目 tip 上 15/16），修正后 64 次 0 次（第一次运行也是 0/64，项目 tip 上 0/32）。
  - 单测在修正前 2 个失败、修正后 2 个通过。
- **回归**（[回归](#回归)）：
  - P4.3a 的同提交用例：交付三次都是 112 通过（`9c86b3dfe` 上两次、项目 tip 上一次）；基础重跑时 2 个按键用例失败在已有的 ResizeObserver 页面错误上。640 张截图里只有 WebKit 明暗桌面的按键截图按设计变化：基础停住时，交付的列表下移 8px；基础被救回的那次，两边逐字节相同。其余截图是逐字节相同、抗锯齿级，或已记录的加载点静止帧。trace 语义 0 处不同。
  - 标准 P0：在 `9c86b3dfe` 上两边都是 101 通过、11 跳过（两次运行），没有 P0 截图按设计变化。
  - 合并检查：构建通过，Vitest 在最终交付 `1243db2bb` 上 387 个文件、5040 个测试全部通过（在 `9c86b3dfe` 上的交付是 381 个、5000 个）。
  - 项目 tip 上的标准 P0 两边都是 93 通过、8 失败：8 张 `settings` 截图是 main 的会话摘要开关（`83671b995`）带来的漂移，基础与交付相同，已报告协调者。
  - OrbitKit 的 `TaskListCopyParityTests` 通过。AntD 清单有一个与本任务无关、来自 main 的未归属点，已报告协调者。

## 现象与复现

在 WebKit 明暗桌面（1280×900）用 P4.3a 的固定数据：试点任务打开，列表区剩约 290px，批量栏的按钮放不下。所有树、TMPDIR 和运行原件都在 `/mnt/data/tmp/34coPBqt8gi229cVNds0E/`；每次运行在独立网络命名空间、限 6G 内存的 scope 里（[scripts/scoped.sh](scripts/scoped.sh)），环境检查（`environment.mjs`，Playwright 1.63.0、WebKit 26.6、Chromium 153）通过。主机负载在 20–80 之间（其它会话），每份日志开头记了负载与内存。

### 两棵树的出现率（P4.3a 的几何探针）

用 P4.3a 留下的探针 [p43a-keys-geom-probe.browser.mjs](../p4.3a/scripts/probe/p43a-keys-geom-probe.browser.mjs)（逐字节相同，[scripts/geom.sh](scripts/geom.sh) 把它拷进树里跑）：P4.3a 按键用例的步骤到截图为止（试点任务打开，另一行的复选框有焦点，按 Space），每个环境 8 次，读工具栏、批量栏和列表的几何。项目 tip `25fc0c840`（项目线 `baad1a557` 合并当时的 origin/main）与 P4.3a 落地前的项目线 `bb007810b`（项目分支在 P4.3a 落地前的位置，任务页是 AntD；它没有 P4.3a 的固定数据与配置，运行时拷进去）交替各跑 4 轮（[scripts/stats.sh](scripts/stats.sh)，日志在 [repro/](repro)，表在 [repro/geom-tip-pre.txt](repro/geom-tip-pre.txt)；三轮因 webServer 启动超时或被外部杀掉重跑过，见[证据的重跑](#证据的重跑)）：

| 树 | WebKit 明色桌面 | WebKit 暗色桌面 | 合计（重跑） | 第一次运行 |
| --- | --- | --- | --- | --- |
| 项目 tip `25fc0c840`（Orbit 控件） | 27/32 | 25/32 | **52/64** 停在 34px | 59/64 |
| P4.3a 之前 `bb007810b`（AntD 控件） | 17/32 | 24/32 | **41/64** 停在 34px | 58/64 |

两种结果的几何每次都一样：停住时工具栏 143.8+34、批量栏 42（offsetHeight，clientHeight 32）、列标题 186.8、列表顶边 185.8；正常时工具栏 143.8+42、列标题 194.8、列表顶边 193.8。批量栏总是 42px、总在溢出，`scrollTop` 都是 0。差别只在工具栏。

### 观察探针：两种结果之前，页面做的事相同

[scripts/probe/p43a-toolbar-probe.browser.mjs](scripts/probe/p43a-toolbar-probe.browser.mjs) 走同样的步骤，但不强制布局地记下按键前后的一切：工具栏、页头、列表与批量栏的 ResizeObserver 边框尺寸，整个页面的 DOM 变动（按区域分），以及每一帧。重跑（[repro/probe-table.txt](repro/probe-table.txt)）tip 16 次中 15 次停住、`bb007810b` 16 次中 10 次；第一次运行是 8 次与 15 次，那一轮 AntD 一侧更多。逐条看（[repro/probe-timeline-ok-and-34.txt](repro/probe-timeline-ok-and-34.txt)，tip 上正常的一次与停住的一次）：

- 批量栏插入（一次 React 提交）到第一帧之间，两次的 DOM 变动一模一样，工具栏区域里批量栏插入之后再也没有变动。
- 第一帧的第一次尺寸观察里工具栏就已经是最终值（42 或 34），之后不再变。

所以停不停住，不是控件之后又改了什么，而是 WebKit 的那几次布局里，工具栏有没有在批量栏的滚动条定下来之后再被排一次。

### 其它的出现方式

[scripts/probe/p43a-toolbar-flows-probe.browser.mjs](scripts/probe/p43a-toolbar-flows-probe.browser.mjs)，每种明暗各 4 次（[repro/flows-table.txt](repro/flows-table.txt)）。工具栏与批量栏不一样高的次数：

| 步骤 | 项目 tip `25fc0c840` | `bb007810b`（AntD） | 交付 `423aa3fdb` |
| --- | --- | --- | --- |
| 任务打开时点击一行的复选框（两种做法的第一步合计） | 16/16（工具栏 34，批量栏 42） | 11/16 | 0/16 |
| 接着关掉任务（列表变宽，批量栏失去滚动条） | 8/8（工具栏 42，批量栏 34） | 8/8 | 0/8 |
| 任务打开、已勾选，窗口拉宽到 1920px | 8/8（42 对 34） | 8/8 | 0/8 |
| 再窄回 1280px | 8/8（34 对 42） | 8/8 | 0/8 |
| 先勾选（不溢出），再打开任务 | 0/8 | 0/8 | 0/8 |

两帧后读一次、600ms 后再读一次，停住的都没有自己改过来。点击复选框比 Space 更稳定地停住。先勾选再打开任务这一路在两棵未修正的树上都对；为什么这一路不停住，没有查。

WebKit 手机（390×844）也一样：P4.3a 的探针在 tip 上 16/16 停住，交付上 0/16（[repro/geom-phone.txt](repro/geom-phone.txt)，第一次运行相同）。手机上任务打开时任务面板盖住整个列表，这时停住是看不见的。

## 原因

### WebKit 的机制：最小页面

[scripts/exp/min2.mjs](scripts/exp/min2.mjs) 是一个独立的页面：侧栏 | 主列 | 页面列（`flex-direction: column`）里放页头（标题、工具栏）和可滚动的列表，与应用相同的 8px `::-webkit-scrollbar`。主列窄（420px，批量栏溢出）或宽（1000px），把工具栏的内容换成批量栏，两帧后读、600ms 后再读。每种结构 3 次（[exp/min2-webkit.txt](exp/min2-webkit.txt)，Chromium 在 [exp/min2-chromium.txt](exp/min2-chromium.txt)）：

| 结构（窄主列） | 工具栏 / 批量栏 |
| --- | --- |
| 与应用相同：flex 外壳、flex 列的页面列、flex 工具栏 | **34 / 42**（600ms 后不变） |
| 页面列不是 flex（外壳 flex 或 block） | 42 / 42 |
| 只有页面列是 flex 列（外壳 block） | **34 / 42** |
| 页面列换成 grid（`auto minmax(0, 1fr)`） | **34 / 42** |
| 工具栏换成 block、换成 grid；页头换成 flex 列、grid；页头 `contain: layout` | **34 / 42** |
| 工具栏自己滚动（批量栏不滚） | 42 / 34，工具栏的滚动条落到页头外 |

- 原因在 flex（或 grid）的页面列：页头是它的项目。页面列一排完、页头的高度已经算出，WebKit 才决定批量栏的滚动条，然后只重排批量栏。
- 不设自定义滚动条时，Linux WebKit 的默认滚动条不占位置，就没有这 8px（[scripts/exp/scrollbar-room.mjs](scripts/exp/scrollbar-room.mjs)，[exp/scrollbar-room.txt](exp/scrollbar-room.txt)）。应用的 `::-webkit-scrollbar { height: 8px }` 让 WebKit 用占位置的经典滚动条。按 P4.3a 的说明，macOS Safari 设成“始终显示滚动条”时也是这样，本任务没有在 macOS 上看过。
- Playwright 的无头 Chromium 不画滚动条，自定义的也不画，批量栏一直是 34px，工具栏也是 34px。

WebKit 源码（main，2026-10）里对应的是：

- flex 和 grid 容器排版时开一个“稍后更新滚动信息”的事务（`RenderBlock::beginUpdateScrollInfoAfterLayoutTransaction`，`RenderFlexibleBox::layoutBlock`、`RenderGrid` 里都有）。事务进行中，任何溢出裁剪的块排完时都不当场决定滚动条，而是记下来（`RenderBlock::updateScrollInfoAfterLayout`），等最外层的 flex/grid 排完再统一处理（`endAndCommitUpdateScrollInfoAfterLayoutTransaction`）。
- 这时滚动条一变，只重排那个块自己（`RelayoutScopeForScrollbarChange` → `relayoutRenderBlockForScrollbarChange`：`setNeedsLayout(MarkOnlyThis)` 后 `layoutBlock`），对 flex 父容器只清掉它缓存的项目尺寸（`invalidateBlockAxisSizeForFlexItem`），不让它重排。
- WebKit 2026 年开始补这一类问题：子树里有滚动条变化时，让按内容定尺寸的祖先重排（[bug 310940](https://bugs.webkit.org/show_bug.cgi?id=310940)，提交 `9cc37e9a285b`；[bug 290452](https://bugs.webkit.org/show_bug.cgi?id=290452)，`83e73fd66b2d`）。后一个提交写明 flex 项目和 grid 项目暂不处理，留待后续。本页的页头正是 flex 项目，与上表里“只有页面列是 flex 列”时停住一致。
- 本环境的 WebKit 26.6 看来已有前一个修正：bug 310940 自己的用例（`width: max-content` 的框，子元素出现竖向滚动条）在 8px 滚动条下得 18px（[exp/scrollbar-room.txt](exp/scrollbar-room.txt)）。

源码是对着 WebKit main 读的。Playwright 的 WebKit 26.6 对应哪个提交没有核对，上面的机制以最小页面的实测为准。

### 为什么 P4.3a 的计数显示迁移后更常出现

P4.3a 第 5 轮的树上参照 12 次中 2 次、交付 12 次中 8 次停住（[p4.3a README](../p4.3a/README.md#重复运行)）。本任务在同样的固定数据、浏览器和视口下：

- P4.3a 的几何探针，tip 与 `bb007810b` 各 64 次：第一次 59 对 58，重跑 52 对 41。
- 观察探针，各 16 次：第一次 8 对 15，重跑 15 对 10。
- 修正前的基础 `9c86b3dfe`（tip 加上 main 后来的提交），各 32 次：第一次 30，重跑 10。

两棵树都是多数停住，比例随轮次和主机的状况在变。合计 111/128 对 99/128，重跑时 tip 一侧更多、第一次持平或相反，交付一侧没有稳定地更多：

- 停住是 WebKit 的确定行为，没有任何控件的最小页面每次都停住。
- “正常”的那些次，是之后又有一次布局碰巧排到了工具栏。观察探针看到两种结果之前的 DOM 变动相同，所以这次布局取决于运行时的时机，不取决于批量栏里是哪种控件。
- P4.3a 的重复运行是在主机负载 16–42 时跑的（[p4.3a/repeat-r5](../p4.3a/repeat-r5) 各日志开头），本任务在 20–80。P4.3a 的 2/12 对 8/12 是否只是时机的波动，本任务没有确立。能确立的是：两种控件都常停住，各轮之间的波动（同一棵树 30/32 与 10/32）大于两棵树之间的差。具体是哪一次布局救回了工具栏，也没有查清（见[未确立的部分](#未确立的部分)）。

## 修正

### 做法

`TaskListView.tsx`（提交 `0783959ca`，与 `9c86b3dfe` 上的 `0b45f9849` 相同）给工具栏和批量栏各加一个 ref，加一个布局效果：

- **规则**：工具栏的 `min-height` 等于批量栏的边框盒高度（`getBoundingClientRect().height`，含它自己的滚动条）。批量栏消失时去掉。工具栏在选中模式下只装批量栏，所以正确时这个最小高度不改变任何东西；WebKit 停住时它把工具栏撑到批量栏的高度，滚动条消失时把它收回去。
- **何时**：
  - 依赖 `selectedRows.length`、`selectedTaskId`、`view`，也就是批量栏出现或消失、选中数变化、打开或关掉任务、切换视图的那次提交。布局效果在提交里同步运行，读高度会强制一次布局，WebKit 在这次布局里定下滚动条，再写 `min-height`，于是首帧绘制前就对了。观察探针在修正后的树上看到，工具栏的第一次尺寸观察就是 42（[repro/probe-table.txt](repro/probe-table.txt) 的 fix 部分）。
  - 只有周围空间变了（窗口宽度、拖动任务面板的宽度、侧栏收起），React 不提交。批量栏的 ResizeObserver（边框盒）发现它变了高，在下一帧（`requestAnimationFrame`）跟上。
- **为什么不在回调里直接改**：页面自己的 ResizeObserver 量列表区（`.tasks-body`），它比批量栏浅。在同一轮观察里先告诉了它列表区的尺寸，再改工具栏，列表区又变，浏览器就报 “ResizeObserver loop completed with undelivered notifications”。Playwright 把它记为页面错误，ui-migration 的用例会因此失败。最小页面上实测：在回调里直接改每次报 1 个错误，推到下一帧 0 个（[exp/min2-webkit.txt](exp/min2-webkit.txt) 的 `js-ro-sync+body-ro` 与 `js-ro-raf+body-ro`）。代价是这种情况下有一帧还是旧高度。

### 没有采用的做法

最小页面上逐一试过（[exp/min2-webkit.txt](exp/min2-webkit.txt)，窄 / 宽两种主列）：

| 做法 | 结果 |
| --- | --- |
| 预留滚动条的位置：选中模式下工具栏 `min-height: 42px` | 溢出时对；不溢出时工具栏 42、批量栏 34，比 AntD 页面高 8px，Chromium 也一样 |
| 批量栏 `overflow-x: scroll`（滚动条一直在） | 溢出时对；不溢出时批量栏下面多一条 8px 的空滚动槽 |
| 工具栏固定 34px | 永远是现在的停住样子，列表比 AntD 页面高 8px |
| 隐藏批量栏的滚动条 | 不再变高，但经典滚动条的用户看不到能横向滚动 |
| 换成包含滚动条的布局：页面列或工具栏改成 grid、block，页头改成 flex 列或 grid，`contain: layout`，让工具栏或内层元素去滚动 | 照样停住（34/42），或者把问题移到上一层 |

要在 WebKit 里与 AntD 页面一致，工具栏必须在 WebKit 决定滚动条之后再排一次，这只有脚本能保证。改动只读批量栏的高度、写工具栏的 `min-height`，不改 `.tasks-toolbar`、`.tasks-bulkbar` 的 CSS 规则，也不改页面结构。

### 与 P4.3a 之前的 AntD 页面对比

| 状态（WebKit 暗色桌面） | 工具栏 | 批量栏 | 列标题 | 列表顶边 |
| --- | --- | --- | --- | --- |
| AntD 页面不停住的那几次（`bb007810b` 两次共 128 次中 29 次；P4.3a 参照树 12 次中 10 次） | 143.8+42 | 42 | 194.8 | 193.8 |
| 修正前停住（本任务两棵树的多数） | 143.8+34 | 42 | 186.8 | 185.8 |
| **修正后（每次）** | 143.8+42 | 42 | 194.8 | 193.8 |

WebKit 明色桌面相同。不溢出时（没有打开任务）三者都是 34/34。Chromium 里批量栏不画滚动条，修正前后都是 34/34。P4.3a 留下的两张按键截图（[3c40a8644a4f](../p4.3a/repeat-r5/variants/webkit-dark-desktop.p43a-tasks-keys-space.3c40a8644a4f.png) 是正常的一种，参照与交付都出现过，逐字节相同；[c3aecffd938c](../p4.3a/repeat-r5/variants/webkit-dark-desktop.p43a-tasks-keys-space.c3aecffd938c.png) 是停住的一种）对应前两行。修正后的按键截图里，列表这一列（批量栏、间隙、列标题与各行，x 296–600、y 130–545）三次运行都与 `3c40a8644a4f` 的同一区域逐字节相同。修正前的基础停住的两次（第一次运行、项目 tip 上）与 `c3aecffd938c` 逐字节相同，被救回的那次（重跑）与 `3c40a8644a4f` 相同（[shots/keys-space-list-column.png](shots/keys-space-list-column.png)，见[P4.3a 的同提交用例](#p43a-的同提交用例)）。

## 常驻用例与单测

### `ui-migration/tasks-toolbar.browser.mjs`

用 P0 的生产构建、固定数据和环境；配置 [tasks-toolbar.config.mjs](../../../../src/web/ui-migration/tasks-toolbar.config.mjs) 只跑四个桌面环境（WebKit、Chromium × 明、暗），不截图。三个用例，每个用例在 `TASKS_TOOLBAR_RUNS`（默认 4）个新页面里各跑一次：

1. 任务打开，另一行的复选框有焦点时按 Space（P4.3a 的按键路径）；
2. 任务打开时点击一行的复选框，再关掉任务；
3. 没有打开任务时点击一行的复选框，再打开任务，把窗口拉宽到 1920px，再窄回来。

每一步两帧后读几何：

- 硬性检查：批量栏是否溢出、它自己的滚动条有多高（WebKit 溢出时 8px，否则 0）。这一步到了它要测的状态，否则用例失败。
- 两个软检查（`expect.soft`，一次运行报出所有不对的步骤）：工具栏与批量栏一样高；列表从批量栏下沿再往下一个工具栏的外边距开始。

运行：`npx playwright test --config ui-migration/tasks-toolbar.config.mjs`（在 `src/web` 下，先 `vite build`）。

修正前后各跑多轮（[scripts/final.sh](scripts/final.sh) `stats`，基础 `9c86b3dfe`、交付 `423aa3fdb` 交替；基础树没有这个用例，运行时拷进去；表在 [runs/resident-table.txt](runs/resident-table.txt)，报告在 `runs/resident-*.report.summary.json`）：

| 步骤（WebKit 明、暗合计） | 修正前，2 轮（重跑） | 修正前，第一次运行 | 修正后，5 轮（重跑与第一次相同） |
| --- | --- | --- | --- |
| Space，任务打开 | 3/16 不对（工具栏 34，批量栏 42） | 16/16 | 0/40 |
| 点击复选框，任务打开 | 4/16 不对（34 对 42） | 16/16 | 0/40 |
| 关掉任务 | 16/16 不对（42 对 34） | 16/16 | 0/40 |
| 窗口拉宽到 1920px | 14/16 不对（42 对 34） | 16/16 | 0/40 |
| 窗口窄回 1280px | 16/16 不对（34 对 42） | 16/16 | 0/40 |
| 勾选，没有打开任务 | 0/16 | 0/16 | 0/40 |
| 再打开任务 | 0/16 | 0/16 | 0/40 |
| **用例** | WebKit 48 个失败 35 个，Chromium 48 个通过 | WebKit 48 个全部失败 | **240 个全部通过** |

修正前每个失败的用例报出的都是这两个软检查（[runs/resident-table.txt](runs/resident-table.txt) 末尾），硬性检查都通过，说明每一步都到了它要测的状态。按 Space 与点击复选框这两步在重跑时多数被救回，与几何探针的波动一致；关掉任务、改窗口宽度这几步每轮都停住，修正前的每一轮都至少失败 17 个用例。

### P4.3a 的几何探针，修正后

同一个探针在基础 `9c86b3dfe` 上 2 轮 10/32 停住（第一次运行 30/32）、交付 `423aa3fdb` 上 4 轮 **0/64**（第一次运行也是 0/64；[runs/geom-final.txt](runs/geom-final.txt)）。

### 单测 `TaskListView.toolbarHeight.test.tsx`

jsdom 不排版，单测把批量栏的高度设成任务打开时 42、否则 34，查的是机制：

- 勾选（Cmd 点击一行）后工具栏的 `min-height` 是 34px；打开任务后在同一次提交里变成 42px，不用跑任何一帧；关掉任务回到 34px；Clear 之后没有 `min-height`。
- 批量栏的 ResizeObserver 报告变高时，回调里不改，下一帧改成 42px。

红绿（`small.sh`）：基础 `9c86b3dfe` 拷进这个单测，**2 个失败**，都是工具栏没有 `min-height`（[runs/unit-red-base.txt](runs/unit-red-base.txt)）；交付上 **2 个通过**（[runs/unit-green-fix.txt](runs/unit-green-fix.txt)），合并检查里也通过。

## 回归

最终检查先跑在第一次跟上 main 之后的两棵树上：基础 `9c86b3dfe`（origin/main，项目线已在其中）与交付 `423aa3fdb`（基础加本任务两个提交），完整检出都在 /mnt/data（[scripts/final.sh](scripts/final.sh)，每一步的日志开头记 argv、树、HEAD、未提交路径、负载、内存与根分区余量，结尾记退出码；日志在 [runs/](runs)）。项目线之后前进，rebase 到项目 tip 之后受影响的检查又跑了一遍，见本节最后的[第二次跟上之后](#第二次跟上之后项目-tip-d580e572d)。

### P4.3a 的同提交用例

P4.3a 的 14 个用例 × 8 个环境（[p43a.browser.mjs](../../../../src/web/ui-migration/p43a.browser.mjs)，写出截图），先在基础、再在交付上跑（`final.sh p43a`，[runs/p43a-base.txt](runs/p43a-base.txt)、[runs/p43a-fix.txt](runs/p43a-fix.txt)），用 P4.3a 自己的比较工具对比（[scripts/compare.sh](scripts/compare.sh)：`p3.2/compare_runs.py`、`p4.1/summarize.py`、`p4.2/scripts/beyond-clusters.py`、`p4.3a/trace-semantics.py`；结果在 [compare/](compare)）。

- **用例**：交付 **112 通过**（两次运行都是）。基础这次 110 通过、2 失败（第一次 112 通过）。失败的两个都是按键用例（WebKit 明色桌面、暗色手机），截图与每一步都完成了，失败在用例结束后的页面错误检查：“ResizeObserver loop completed with undelivered notifications”。P4.3a 把这个错误记为两棵树都有的已有问题；本任务里它只出现在未修正的树上（见[未确立的部分](#未确立的部分)）。
- **截图** 640 张：重跑 603 张逐字节相同、37 张抗锯齿级（每通道差 ≤2）、0 张超出。第一次运行是 586、44、10。
  - 第一次超出的 10 张里，2 张是 WebKit 明、暗桌面的 `p43a-tasks-keys-space`，**按设计变化**：基础的工具栏停在 34px，交付是 42px。差别只在列表这一列（x 312–582、y 186–541）：交付的列标题与各行和基础的逐字节相同、整体下移 8px，空出的 8px 是页面底色（工具栏与列表之间的间隙）；截图其余部分（批量栏、页头、任务面板、侧栏）逐字节相同。
  - 重跑时基础的这两张碰巧是被救回的 42px 样子，与交付逐字节相同，所以没有超出。
  - 两次运行里，交付暗色桌面按键截图的列表这一列都与 P4.3a 第 5 轮的 42px 那张（`3c40a8644a4f`）逐字节相同，见 [shots/keys-space-list-column.png](shots/keys-space-list-column.png)（P4.3a 的两张与交付的明、暗两张），整张截图在 [shots/](shots)。
  - 第一次另外 8 张超出是 Chromium 的加载点静止帧（每张一个 16px 见方的区域，33–37 个像素，最多 21 级），P4.3a 已记录的一类：转圈图标截在不同的相位。Chromium 里批量栏不画滚动条，本修正在那里不改变任何高度。
- **计算样式**：两次运行的 640 次截图都没有差异。
- **trace**：112 个用例、944 步，语义字段（地址、请求、通知、菜单、选择、分节与行的顺序、勾选、提示与字段值）**0 处不同**，两次运行都是。焦点 8 步不同（第一次 7 步），两边分别读到 `body` 和按钮，是 P4.3a 已记录的观察时机一类。

### 标准 P0

`npx playwright test --config ui-migration/playwright.config.mjs`（`final.sh p0`，[runs/p0-standard.txt](runs/p0-standard.txt)、[runs/p0-standard-base.txt](runs/p0-standard-base.txt)）：交付与基础都是 **101 通过、11 跳过**（跳过的与 P4.3a 记录的相同：7 个环境里的性能基线记录、4 个手机环境里的断点两侧）。252 张期望截图在两棵树上来自同样的层：44 张 P0.2 原图、183 张 main 漂移参考、25 张已接受的迁移差异（`runs/*.expected-sources.json`）。P0 的场景里没有批量栏，**没有 P0 截图按设计变化**，不需要登记。新加的 `tasks-toolbar.browser.mjs` 不在标准 P0 里（`playwright.config.mjs` 的 testIgnore），所以 P0 的用例数不变。

### 合并检查

`npm run build -w @orbit/web && npm run test -w @orbit/web`，在会话工作树上跑：交付 `423aa3fdb`，只多本目录未提交的证据，盘是根分区的 SSD。Orbit 后台作业 `bgj_1f6f4dafc3ec`，精简日志 [runs/merge.txt](runs/merge.txt)。

- `tsc -b` 与 vite 构建通过；Vitest **381 个文件、5000 个测试全部通过**，含新单测。
- 之前先在 /mnt/data 的交付检出上跑过一次：构建通过，Vitest 跑到第 38 个文件时被停掉，这 38 个都通过（[runs/merge-hdd-killed.txt](runs/merge-hdd-killed.txt)）。那块盘是机械盘，其它会话同时在跑重的测试，每个文件光导入模块就要一分多钟。按作业指导的磁盘规则，根分区这时剩 38 GB（不低于 6 GB），于是装好依赖（`scripts/worktree-overlay.sh`）改在会话工作树上跑完。
- 网页单测不读本目录：读 `src/web` 以外文件的只有文案语言守卫（`copyLanguage.test.ts`，只扫 `src/` 下的产品源码），另有几个用例只在注释里提到证据目录。所以之后的证据提交不改变这次的结果。

### 清单与 OrbitKit

- **AntD 清单**：`node src/web/scripts/audit-antd.mjs --check-owners` 在交付上退出 1，有 2 个未归属的使用点（[runs/audit-check-owners.txt](runs/audit-check-owners.txt)）：`src/web/src/App.managedRunner.test.tsx` 与 `src/web/src/components/WorkspaceView.managedRunner.test.tsx`。两个都是 main 的 managed-runner 测试文件（`94025579b`、`d0db4e889`，10-09），在开工时的项目 tip `25fc0c840` 和基础 `9c86b3dfe` 上是同样的 2 个（[runs/audit-check-owners-tip.json](runs/audit-check-owners-tip.json)、[runs/audit-check-owners-base.json](runs/audit-check-owners-base.json)），inventory-delta 里没有它们的记录。本任务不新增 AntD 使用点，也不在范围内迁移或登记它们，已在任务评论里报告协调者（2026-10-10 00:15Z）。
- **OrbitKit**：`TaskListCopyParityTests` 逐字读 `TaskListView.tsx`，锚在文案上。本任务只给两个 `div` 加了 `ref`、加了一个布局效果，没有改文案和文案周围的标记。在 swift:6.1（限 4G 内存，`git archive` 的副本）里跑 `swift test --filter TaskListCopyParityTests`：6 个测试 0 失败（[runs/swift-tasklist.txt](runs/swift-tasklist.txt)；第一次运行编译时有 555 条已有的警告，重跑沿用了构建目录，没有重新编译）。

### 第二次跟上之后（项目 tip `d580e572d`）

基础 = 项目 tip `d580e572d`，交付 = `1243db2bb`。[scripts/recheck3.sh](scripts/recheck3.sh)（作业 `bgj_7dcaafb35378`）跑了这些，日志在 [runs3/](runs3)，P4.3a 的比较在 [compare3/](compare3)；合并检查是作业 `bgj_8a5ff6ab8f3e`（[runs3/merge.txt](runs3/merge.txt)）：

| 检查 | 基础 `d580e572d` | 交付 `1243db2bb` |
| --- | --- | --- |
| 合并检查（会话工作树） | — | 构建通过；Vitest **387 个文件、5040 个测试全部通过** |
| 标准 P0 | 93 通过、8 失败、11 跳过 | 93 通过、8 失败、11 跳过，失败的与基础相同 |
| P4.3a 用例 | 112 通过 | **112 通过** |
| P4.3a 截图对比 | 595 张逐字节相同、41 张抗锯齿级、4 张超出 | 同左 |
| 常驻用例 | 1 轮：WebKit 24 个失败 23 个，只有一次按 Space 的被救回 | **2 轮 96 个全部通过**，每步 0/16 |
| P4.3a 几何探针 | 1 轮 15/16 停在 34px | **2 轮 0/32** |
| AntD 清单 | 1 个未归属 | 同左，本任务不新增使用点 |
| OrbitKit `TaskListCopyParityTests` | — | 6 个测试 0 失败 |

- **P0 的 8 个失败**：`settings` 截图，八个环境都是，基础与交付相同。截图里 Session defaults 多了一行 “Session recaps” 开关（[shots/p0-settings-drift-project-tip.chromium-light-desktop.png](shots/p0-settings-drift-project-tip.chromium-light-desktop.png)，左为期望、右为实际）。它来自 main 的 `83671b995`（会话列表显示服务端写的摘要，0418），随项目线合并 main（`cb35d126a`）进来。这是 main 的漂移，与本任务无关；按 [p0-drift README](../p0-drift/README.md) 的规则没有登记，已报告协调者（任务评论，2026-10-10 03:29Z）。在 `9c86b3dfe` 上两边都是 101 通过。
- **P4.3a 截图超出的 4 张**：2 张是 Chromium 的加载点静止帧；另 2 张是 WebKit 明、暗桌面的 `p43a-tasks-keys-space`，这次基础停在 34px、交付 42px，区域（x 312–583、y 184–543）和像素数与第一次运行的那两张相同，**按设计变化**。trace 语义 0 处不同，焦点 4 步。
- **AntD 清单**：在项目 tip 上，P4.4 的记录 `2026-10-09c` 已经覆盖了先前的两个 managed-runner 测试文件。现在未归属的是 main 会话摘要的测试 `src/web/src/components/WorkspaceView.recapRow.test.tsx`（`2255a5313`、`83671b995`），基础与交付相同（[runs3/audit-check-owners.txt](runs3/audit-check-owners.txt)、[runs3/audit-check-owners-base.json](runs3/audit-check-owners-base.json)），已报告协调者。

## 跟上 origin/main

| 时间（UTC） | 基础 | 说明 |
| --- | --- | --- |
| 10-09 19:39 | 项目 tip `baad1a557` 合并 origin/main `8698b0a20` → `25fc0c840` | 开工时 P4.3b 已落地（integration.state ON_UPSTREAM），项目 tip 含 P4.3a、P4.3b，但不在 origin/main 里，按规则在项目 tip 上合并 origin/main（main 只多了 apiserver 的 0418 迁移）。复现与统计跑在这棵树上（“项目 tip”） |
| 10-09 21:07 | origin/main `9c86b3dfe` | main 把项目线并了进去（`e5404b73b`），项目 tip 已在 origin/main 里，按规则直接 rebase：两个提交无冲突地接到 `9c86b3dfe` 上。main 这期间改到的 Web 文件是协调者的证据卡片（`DecisionRail`、`EvidenceDecisionCard` 与单测）、`Transcript`、`WorkspaceView` 与单测、`lib/quotaWindow.ts`，index.css 只加了 `.evidence-queued*`、`.approval-card` 的规则，都不碰任务页、工具栏的规则和 ui-migration 用例。最终检查都在 rebase 之后的树上 |
| 10-10 02:54 | 项目 tip `d580e572d` | 交证据前干跑时发现 P4.4 已落到项目线（`d580e572d`），项目 tip 不在 origin/main 里，而且它在 `ui-migration/playwright.config.mjs` 的 testIgnore 同一行加了 `p44*`，与本任务冲突。按规则先 rebase 到项目 tip：冲突在 testIgnore 那一行，两项都保留（`1243db2bb`）；修正提交 `0783959ca` 与 `0b45f9849` 内容相同（`git range-diff`）。再合并 origin/main `57324e33a` 时，只有 `src/web/src/components/WikiSettingsPage.tsx` 冲突，P4.4 与 main 都改了它，不是本任务的文件。git 的 rerere 还套用了来历不明的旧解法。本任务不替别人解这个冲突，合并放弃；项目 tip 自己与 main 合并就有这个冲突（`git merge-tree` 不含本任务的提交也冲突），已报告协调者（任务评论，2026-10-10 03:04Z）。受影响的检查在新的两棵树上重跑，见[第二次跟上之后](#第二次跟上之后项目-tip-d580e572d) |

最后一次干跑（2026-10-10 03:50Z，origin/main `9498167b9`，项目 tip `d580e572d`）：

- 交付 `1243db2bb` 对项目 tip 是快进（项目 tip 是它的祖先）。
- 对 origin/main，`git merge-tree` 只报 `WikiSettingsPage.tsx` 冲突，是从项目线带来的。本任务在 `9c86b3dfe` 上的两个提交 `423aa3fdb` 对 origin/main 干跑无冲突（树 `18319f775`）。
- `9c86b3dfe` 之后 main 改到的 Web 文件：Infrastructure、Provider 连接、Runner 详情、设置页、会话摘要与已回答问题卡片（`Transcript`、`WorkspaceView`），index.css 只有这些组件自己的规则（`.provider-*`、`.prov-*`、`.tdp-pin-*`、`.scope-menu-value`、`.rd-engine-*`、`.session-preview-label`、已回答问题卡片），以及删掉的 `.batch-graph-node`。都不碰 `TaskListView.tsx`、`.tasks-*` 规则、`components/ui/` 或 ui-migration 用例，所以不再跟。

## 未确立的部分

- 只在 Linux 上的 Playwright WebKit（26.6）里实测；没有在 macOS Safari（“始终显示滚动条”）上看过。Safari 也用 WebKit，机制相同的可能性大，但没有直接证据。
- 修正前“正常”的那些次，是哪一次布局把工具栏排对的，没有查清。观察探针只能说明页面在两种结果之前做的事相同。P4.3a 看到的 2/12 对 8/12 本任务没有复现成稳定的差别：两次运行的几何探针是 59 对 58、52 对 41，同一棵树在两轮之间也能从 30/32 变到 10/32。
- 修正后的“下一帧跟上”（窗口、拖动面板宽度、收起侧栏）里有一帧是旧高度。用例在两帧后读，看不到那一帧。
- “ResizeObserver loop completed with undelivered notifications” 页面错误在本任务的运行里只出现在未修正的树上：第一次运行 5 次，重跑 8 次（几何探针 6 次，P4.3a 基础 2 次；tip、`bb007810b`、基础树）。修正后的树上一次也没有，包括 P4.3a 用例三遍、常驻用例 576 个与几何探针 160 次。第二次跟上之后的运行里两棵树都没有出现。重跑的几何探针（16 次运行、256 次读数）里出错的 6 次都是停住的那几次（停住 119 次、正常 137 次），像是与停住有关，但次数太少，没有确立。P4.3a 把它记为两棵树都有的已有问题。
- 手机只用 P4.3a 的探针量过（修正前 16/16、交付上 0/16）；常驻用例只跑桌面，因为手机上任务面板盖住列表，用例 2、3 的点击做不了。
- WebKit 的机制是对着 WebKit main 的源码读的，没有核对 Playwright 的 WebKit 26.6 对应的提交（见[原因](#原因)）。
- 交付没有合并最新的 origin/main：项目 tip 与 main 在 `WikiSettingsPage.tsx` 冲突（P4.4 与 main 都改了它），本任务不替它解（见[跟上 origin/main](#跟上-originmain)）。本任务的提交在 `9c86b3dfe` 上对最新 main 干跑无冲突，项目线跟上 main 时由它的合并检查兜底。
- 最终交付上的标准 P0 是 93 通过、8 失败，8 张 `settings` 截图是 main 的会话摘要开关带来、还没有登记的漂移，与基础相同（见[第二次跟上之后](#第二次跟上之后项目-tip-d580e572d)）。在没有这个漂移的 `9c86b3dfe` 上，两边都是 101 通过。

## 证据的重跑

第一次收集证据时（2026-10-10 00:52Z），[scripts/collect.sh](scripts/collect.sh) 的旧版本按自己所在的位置推算目标目录。它是从 /mnt/data 的副本运行的，于是把 /mnt/data 上的 `runs/`、`exp/`、`compare/`、`shots/` 当成本目录清空了，日志、报告和截图都没了。树、构建、脚本和探针都还在，每个后台作业自己的输出也还在（大多只有摘要，合并检查的是全文）。现在的 collect.sh 写死了本目录的路径，不对就拒绝运行。

所有测量用同样的脚本、树和提交重跑了一遍（[scripts/rerun.sh](scripts/rerun.sh)，可续跑的队列，Orbit 后台作业 `bgj_a3d1d93a6576`）。[runs/](runs)、[repro/](repro)、[exp/](exp)、[compare/](compare) 里的数字、日志、报告和截图都来自重跑。合并检查没有重跑，它的全文在作业 `bgj_1f6f4dafc3ec` 上，[runs/merge.txt](runs/merge.txt) 是从那里精简的。[runs3/](runs3) 与 [compare3/](compare3) 是第二次跟上之后新跑的，不是重跑。第一次运行的摘要（作业输出）如下，与重跑对照：

| 测量 | 第一次（作业） | 重跑 |
| --- | --- | --- |
| 最小页面（WebKit、Chromium） | 前台运行，结论同上表 | 相同（[exp/](exp)）；`js-ro-raf` 这次两帧后已经对了，最终都对 |
| P4.3a 几何探针，tip / `bb007810b`，各 4 轮 | 59/64、58/64（`bgj_bebea4e68369`） | 52/64、41/64 |
| 观察探针，tip / `bb007810b` / 修正后 | 8/16、15/16（`bgj_379ad20ef1da`）；修正后的第一次构建 0/16（`bgj_e496bd6ce4a6`） | 15/16、10/16；交付 0/16 |
| 其它出现方式：tip / `bb007810b` / 修正后 | tip 8/8，修正后 0/8（`bgj_e496bd6ce4a6`）；`bb007810b` 7/8–8/8（`bgj_104ace33e400`） | tip 8/8–16/16，`bb007810b` 11/16 与 8/8，交付 0 |
| WebKit 手机，tip / 修正后 | 16/16、0/16（`bgj_f71ab15f7cfb`） | 相同 |
| 常驻用例，基础 2 轮 / 交付 5 轮 | WebKit 48 个全部失败 / 240 个通过（`bgj_1b9557908136`） | 35/48 失败 / 240 个通过 |
| P4.3a 几何探针，基础 2 轮 / 交付 4 轮 | 30/32、0/64（同上） | 10/32、0/64 |
| P4.3a 用例，基础 / 交付 | 112、112 通过（`bgj_3bdbc84d9835`）；截图 586/44/10（`bgj_0795a9b32768`） | 110 通过 2 失败（已有的页面错误）、112 通过；603/37/0 |
| 标准 P0，交付 / 基础 | 101 通过、11 跳过（`bgj_ce4b14f77867`） | 相同 |
| AntD 清单 | 2 个未归属（`bgj_f9b708e3fb44`） | 相同 |
| 单测红绿、OrbitKit | 2 失败 / 2 通过，6 个 0 失败（`bgj_104ace33e400`） | 相同 |
| 合并检查 | 381 个文件、5000 个测试通过（`bgj_1f6f4dafc3ec`） | 没有重跑 |

重跑中有 8 步没跑到测试，[scripts/retry.sh](scripts/retry.sh)（作业 `bgj_5ee25ad54ba5`）把它们挪到 [runs-failed/](runs-failed) 后重跑了：6 步是 Playwright 的 webServer 30 秒内没有起来（主机负载 45–77 时，/mnt/data 机械盘上冷启动的 vite preview），2 步是被外部的 SIGTERM 杀掉（exit 143，不是本任务的进程发的）。这些不是测试结果；重跑之后每一步都跑到了测试。

## 证据体积

本目录 9.2 MB、140 个文件，在每个任务 30 MB 的上限以内：

- 没有 `trace.zip`。Playwright 的报告都是去掉附件正文的 `*.report.summary.json`（[p0-drift-3/tools/report-summary.py](../p0-drift-3/tools/report-summary.py)），最大的是 P4.3a 用例的四份，各约 0.65 MB。
- 截图只收正文引用的 4 张：列表这一列的对照图、交付的两张按键截图、P0 `settings` 漂移的左右对照。
- 日志去掉了终端颜色码；合并检查与 OrbitKit 的日志是精简过的，全文留在 Orbit 的作业上。
- 完整的原始运行（四棵树、全部截图、带附件正文的报告与 trace）留在 `/mnt/data/tmp/34coPBqt8gi229cVNds0E/`，证据判定后清理。

## 复现

```bash
T=/mnt/data/tmp/34coPBqt8gi229cVNds0E   # 树、TMPDIR 和运行原件；脚本在本目录 scripts/，运行时放在 $T/scripts
# 树：tip = 25fc0c840，pre = bb007810b（P4.3a 落地前的项目线），base = 9c86b3dfe，fix = 交付；各自 bash scripts/worktree-overlay.sh 后 vite build
git worktree add --detach $T/base 9c86b3dfe && (cd $T/base && bash scripts/worktree-overlay.sh && cd src/web && npx vite build)
# 复现与两棵树的出现率（P4.3a 的几何探针，交替 4 轮）、观察探针、其它出现方式、手机：
$T/scripts/stats.sh 1 4
PROBE_RUNS=8 $T/scripts/probe.sh tip tip-1; $T/scripts/probe.sh pre pre-1; $T/scripts/flows.sh tip tip-1
$T/scripts/geom.sh tip tip-phone webkit-light-phone webkit-dark-phone
python3 -I $T/scripts/geom-table.py $T/runs/geom-{tip,pre}-r{1,2,3,4}/run.txt
# 最小页面（在任一棵树的 src/web 下，脚本拷进去跑）：node min2.mjs webkit; node min2.mjs chromium; node scrollbar-room.mjs
# 最终检查（rebase 之后的基础与交付）：
$T/scripts/final.sh stats; $T/scripts/final.sh p43a; $T/scripts/compare.sh; $T/scripts/final.sh p0; $T/scripts/final.sh audit
(cd $T/fix && npm run build -w @orbit/web && npm run test -w @orbit/web)
$T/scripts/small.sh   # 单测红绿、OrbitKit 的 TaskListCopyParityTests、scrollbar-room
# 第二次跟上之后（base = 项目 tip d580e572d，fix = 1243db2bb；日志在 runs3/，比较在 compare3/）：
$T/scripts/recheck3.sh   # final3.sh 的 p0、p43a、stats、audit，compare3.sh，OrbitKit；没跑到测试的步骤最多重试三次
(cd <会话工作树> && npm run build -w @orbit/web && npm run test -w @orbit/web)
# 证据丢失后的重跑：$T/scripts/rerun.sh 与 $T/scripts/retry.sh（见“证据的重跑”）
python3 -I $T/scripts/resident-table.py $T/runs/resident-*-r*-out/report.json
# 常驻用例单独运行（在 src/web 下，先 vite build）：
npx playwright test --config ui-migration/tasks-toolbar.config.mjs            # TASKS_TOOLBAR_RUNS=n 改次数
# 本目录的副本由 scripts/collect.sh 从 $T 复制（报告去掉附件正文）。
```
