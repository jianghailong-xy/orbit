# P2.3 回归修复 B1：成功提示胶囊的合成层与手机宽度

> **证据瘦身（2026-10-07）**：完整原件见提交 `7732f14f82d4e6b4406d7d164c4b672f63aa0f56`（瘦身前最后一个含完整文件的提交）。取回单个文件用 `git show 7732f14f82d4e6b4406d7d164c4b672f63aa0f56:docs/evidence/base-ui-migration/p2.3-b1/<路径> > <文件>`，整个目录用 `git archive 7732f14f82d4e6b4406d7d164c4b672f63aa0f56 docs/evidence/base-ui-migration/p2.3-b1 | tar -x -C <空目录>`。
>
> 本目录在瘦身中：21 份 Playwright 报告换成同目录的 `report.summary.json`，都只删附件正文；384 个逐用例 JSON（含打包的 attachments.tar.gz）换成所在目录的 `attachments.summary.json`（文件名、字节数、SHA-256 和顶层标量字段）；删除 192 张与本任务目录里保留副本逐字节相同的重复截图。下文链接若指向这些文件，按上面的命令从该提交取回；读取它们的脚本要在取回的目录里运行。
>
> 目录里的 SHA256SUMS 类清单（`*.sha256`、`artifact-index*.json`、`manifest.json`、各运行 `summary.json` 里的附件哈希等）保留原文件，核验的是提交 `7732f14f8` 里的文件。做法、保留理由和逐文件删除清单见 [evidence-slimming](../evidence-slimming/README.md)。

本目录服务于任务 [P2.3 回归修复：成功提示胶囊的合成层与手机宽度（B1）](orbit-task:34bQk0jlytjFYyi4OgLMK)，对应项目验收条目 key `1BvO6hYrlFnU60JqxQPUHt`：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。**

B1 由 [P0 基线漂移归因与参考维护](orbit-task:34b8BRQ7HHDwl44Qp0MoC) 发现，见 [p0-drift/README.md](../p0-drift/README.md)「b 类」：P2.3 的 `57f792135` 改变了设置页、资料页成功提示胶囊（「Setting saved」「Name saved」）的绘制。本任务复现并确认根因、修复，再按协调者调整后的验收口径验证。

## 结论

| 项目 | 结果 |
| --- | --- |
| 根因（Chromium） | `57f792135` 给每张通知卡片 `.toast` 加了 `will-change: transform`，每张卡片单独成为合成层。胶囊的 x 是小数（如 1118.969），它自己的层从小数位置开始，文字按另一种子像素相位栅格化。原来卡片画在通知列 `section.toast-viewport` 的合成层里，那一层从整数像素开始。 |
| 根因（WebKit 手机） | `57f792135` 把通知列的内联宽度 `calc(${viewportWidth}px - 32px - env(…))` 改成始终生效，`viewportWidth` 来自挂载时排版的常驻测量节点（390px）。index.css 全局的 8px `::-webkit-scrollbar` 让 WebKit 手机给页面溢出后新排版的固定定位元素按 382px 排，而先排版的元素保持 390px。资料页通知列 CSS 算出 350px，被内联宽度钉成 358px，胶囊右移 4px。 |
| 修复 `86db4c886` | ① 合成提示从 `.toast` 移到 `.toast-viewport`：整列一个合成层，层边界与原来的通知列层相同。② 手机通知列在被弹层接管前不加内联宽度；接管后保持它在 body 中最后的宽度（ResizeObserver 记录），直到通知清空。切层时不读布局、不多提交一次；桌面不变。 |
| P0 截图（B1 部分） | 漂移验证树 + 修复：settings-saved 8/8 与 main 漂移参考一致，profile-validation 8/8 与 P0.2 一致。真实 tip + 修复：settings-saved 8/8 一致；profile-validation 在真实 tip 上被 `profile.png` 挡住，比较不到，它的通知框与 B1 前逐像素相同。没有改 P0 截图、断言、场景、等待条件或参考层登记，也没有登记为已接受的迁移差异。 |
| 完整 P0：漂移验证树 + 修复 | 连续两轮，每轮 112 个测试：85 通过、16 个已记录的焦点预期失败、11 个已记录的跳过，**0 失败**、0 flaky，两轮逐项一致。 |
| 完整 P0：真实 tip + 修复 | 连续两轮，B1 的 3 个 settings-saved 失败消失。剩下 20 个失败两轮逐项一致，逐张归因到 3 个 main 提交：`d233a6cd0`、`2f9cc095f`、`6c4e0ac0e`。 |
| P2.3 已验收的行为 | toasts 完整矩阵 272/272，0 flaky；生产通知入口 8/8。重新执行 P2.3 第 3 版的审计，全部通过：<br>• 24 组弹层内通知的几何、样式、像素与原实现相同；<br>• 160 张弹层动画中点截图零差异；<br>• 8 组生产通知区与 P0.2 零差异；<br>• 2451 帧卡片零移动；<br>• 原生计时、静止悬停全部符合。<br>断言未改。 |
| 合并检查 | `npm run build -w @orbit/web && npm run test -w @orbit/web` 通过：Vitest 340 个文件、4326 个用例。 |
| 缺口 | 项目分支吸收的 main 改动造成的 20 个 P0 失败未登记，由补登任务处理；真实 tip 上 profile-validation 比较不到。见「缺口」。 |

## 执行经过

- **起点**：项目分支 tip `77233e226b4e8a96d38517a4a68329052d5f04d6`，已包含漂移任务的参考层。
- **开工时的完整 P0**：在未改动的 tip 上跑了一轮（[checks/p0-tip-unmodified](checks/p0-tip-unmodified/summary.json)），结果是 23 个失败，不是任务描述里的 8 个。
  - 漂移任务落地时，平台先把 main 合入项目分支（`dd1d197ef`，带入 155 个 main 提交，其中 71 个不是合并提交），再把漂移任务的 7 个提交 rebase 上去。漂移任务的两轮最终运行在 `da13423d3` 的基础上做，没有见过这些 main 改动。
  - 当即向协调者报告。协调者 2026-10-06 23:23 UTC 回复「按计划继续」，同时调整了本任务验收：
    - 全绿由「漂移任务验证过的树 + 本修复」证明；
    - 真实 tip + 修复上，B1 的用例不再失败（被前置截图挡住的如实说明），其余失败逐张归因到具体 main 提交、两轮一致、列为缺口；
    - 不改 P0 截图、断言、场景、等待条件或参考层登记，wiki 场景的 `.wk-card` 定位失败也不动。
  - 补登和 wiki 场景维护由 [P0 漂移登记（第 2 批）](orbit-task:34bTKzXFSRGjnDevEBJlh) 负责，它依赖本任务。
- **第 1 版实现 `83d17f1ca`**：B1 截图的修复效果与终版相同，但在 WebKit 上拖慢了切层，详见「第 1 版为什么被取代」。改为终版 `86db4c886`，交付分支只含终版。第 1 版保留在本地分支 `b1-fix-v1` 和 `b1-verify-drift-tree-v1`，它的运行记录都标注 v1。
- **会话回收**：执行中会话被回收过一次。运行器停掉了两个后台任务：第 1 版在漂移验证树上的第 2 轮完整 P0（停在 111/112，未留报告），以及归因运行的后半段。归因随后续跑完成；第 1 版已被取代，没有补跑。
- 本机为多会话共享，执行期间 1 分钟负载在 8–84 之间（24 核，常驻 vLLM）。处理方式见「toasts 完整矩阵」。
- 由 Claude Opus 5.5 执行。没有推送 main 或项目分支，没有部署或发布。

## 提交与树

| 名称 | 提交 | 构成 |
| --- | --- | --- |
| 交付分支 `orbit/p2-3-b1-8be26d` | 修复 `86db4c8862d18cfbecd678301690f12f3ff5dade`；证据提交见 `git log` | 项目 tip `77233e226` + 修复 + 本目录 |
| 漂移验证树（只用于验证，不交付） | `43e1d0f44e9e981e191f488a7d64556ae0de4123`，本地分支 `b1-verify-drift-tree` | 漂移任务自己的分支 `orbit/p0-p0-2-8cf913` 的 tip `7f901366e`（= `da13423d3` + 漂移任务 7 个提交 `c1cc446b0`…`7f901366e`），加 cherry-pick 的同一修复 |
| tip + 修复的 P0 运行用树 | `/var/tmp/p23b1/trees/fixab`，`86db4c886` 的干净检出 | 与交付分支的修复提交相同。交付工作树当时正在跑 toasts 矩阵，所以另开检出 |

两棵树只差项目分支吸收的 main，核对命令和输出见 [checks/trees.txt](checks/trees.txt)：
- `git diff da13423d3 dd1d197ef` 与 `git diff 7f901366e 77233e226` 逐字节相同，505 个文件；
- 修复补丁在两棵树上相同，去掉 hunk 行号后逐字节一致。行号不同，是因为 main 在 `index.css` 前部加了行；
- 漂移分支与项目 tip 在 `src/web/ui-migration/` 和 `docs/evidence/base-ui-migration/` 下没有差别，参考层和测试完全一样。

## 环境与方法

- **环境**：与 P0.2 记录逐字段一致。每次运行由 `environment.mjs` 校验 Debian 13.7、Node 26.10.0、Playwright 1.63.0（Chromium 1243 / WebKit 2359）和 `fc-list` 字体文件哈希；DPR 1，en-US / UTC。
- **网络命名空间**：本机同时有其它会话在跑浏览器回归。所有浏览器运行都用 `unshare -n` 放进独立网络命名空间，固定端口 4173 / 14377 只属于本次运行，做法与漂移任务相同。包装脚本是 [tools/netns-npm.sh](tools/netns-npm.sh)、[tools/netns-regression.sh](tools/netns-regression.sh)，里面的 npm 命令不变。
- **CPU 优先级**：正式运行用 `nice -n -10`（toasts 矩阵 `-15`）提高优先级，对照实验用 `nice -n 10`。只影响调度，命令和断言不变。
- **同条件对照**（[tools/run-diag.sh](tools/run-diag.sh) + [tools/b1-state.diag.mjs](tools/b1-state.diag.mjs)）：
  - 用项目 tip 上不变的 P0 harness、固定数据和 settings / profile / session 场景，对不同提交的生产构建截图，截图写成 actual（`--update-snapshots=all`）；
  - 三个通知场景截图后立刻记录：通知宿主；通知列的内联样式、几何和去掉内联样式后的宽度；新建的固定定位探针和常驻测量节点的宽度；卡片的 `will-change` 和位置；
  - Chromium 另记录 CDP `LayerTree` 的合成层（所属节点、尺寸、`compositingReasons`）。层树从场景第一次截图起开始记录，取截图时刻的最新一棵；
  - 每轮的 `states.json`、截图哈希和报告在 [root-cause/runs/](root-cause/runs/)。
- **截图比较**（[tools/compare.cjs](tools/compare.cjs)、[tools/regions.cjs](tools/regions.cjs)、[tools/toast-compare.cjs](tools/toast-compare.cjs)）：逐像素比较全部 RGBA，并给出 Playwright 比较器在 P0 设置（`maxDiffPixels: 0`、默认 threshold）下的结论。「通知框」指卡片和通知列矩形外扩 34px，涵盖 `0 8px 22px` 的阴影。

## 根因

完整记录在 [root-cause/table.md](root-cause/table.md)：6 棵树 × 8 个项目 × 3 个通知场景。6 棵树是 B1 前的 `e361ee373`、B1 的 `57f792135`、项目 tip、tip + 修复、漂移验证树 `7f901366e`、漂移验证树 + 修复。通知框像素差在 `root-cause/toast-box-*.json`。[root-cause/crops/](root-cause/crops/) 里是 16 张放大对照图，每张从左到右依次为 P0 期望、B1 前、B1、漂移验证树 + 修复、tip + 修复。下面取 light 主题的代表值，dark 相同。

### Chromium：每张卡片自己的合成层

| | `e361ee373`（B1 前） | `57f792135` 与 tip | 修复后 |
| --- | --- | --- | --- |
| 卡片 `will-change` | `auto` | `transform` | `auto` |
| 画卡片的合成层 | `section.toast-viewport`，原因 `Overlap`：桌面胶囊 393×102、手机胶囊 358×102、桌面错误卡片 426×212 | 每张卡片 `div.toast` 自成一层，原因 `WillChangeTransform`：胶囊 212×102 / 202×102、错误卡片 426×212 | `section.toast-viewport`，原因 `WillChangeTransform`，尺寸与 B1 前逐个相同 |
| 卡片位置 | 胶囊 x = 1118.969（设置）、1128.281（资料）、122.484 / 127.141（手机）；错误卡片 x = 904 / 16 | 相同 | 相同 |

- **差在哪里**：几何和计算样式逐项相同，只差栅格化。
- **B1 之前**：固定定位的通知列画在合成的根滚动内容层之上，单独成为一层。卡片画在这层里，层原点是通知列的整数像素位置。
- **B1 之后**：胶囊自成一层，从小数 x 开始，文字换了子像素相位。错误卡片 x 是整数，层边界与原来的通知列层相同，所以像素不变。
- **像素**（通知框，`e361ee373` → `57f792135`）：settings-saved 97 / 1300 / 1418 px，profile-validation 490 / 495 / 307 / 318 px，单通道差最大 113；notification-error 8 张都是 0，WebKit 不变。从 `57f792135` 到 tip，每个 settings-saved 通知框都是 0 px，B1 在 tip 上原样存在。

### WebKit 手机：常驻测量节点的宽度被内联钉住

| | `e361ee373` | `57f792135` 与 tip | 修复后 |
| --- | --- | --- | --- |
| 通知列内联样式 | 无（只在 `portal && viewportWidth` 时加） | `width: calc(390px - 32px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px))`，条件改为 `viewportWidth` | 无（未被弹层接管） |
| 资料页列宽 / 胶囊 x | 350（CSS）/ 123.141 | 358（内联；去掉内联后 350）/ 127.141 | 350（CSS）/ 123.141 |
| 设置页列宽 / 胶囊 x | 358（CSS）/ 122.484 | 358（内联；去掉内联后 350）/ 122.484 | 358（CSS）/ 122.484 |
| 新建固定定位探针 / 常驻测量节点 | 382 / — | 382 / 390 | 382 / 390 |

- **声明**：`ToastViewport` 给窄屏通知列的内联 `width`。`viewportWidth` 来自 `57f792135` 引入的常驻测量节点：body 下一个 `position:fixed; inset:0` 的 div，挂载时测量，由 ResizeObserver 跟踪。同一提交把内联几何的条件从「弹层接管时」改成「始终」。
- **382 和 390 的来历**：index.css 第 203 行全局的 `::-webkit-scrollbar { width: 8px }` 让 WebKit 使用真实的 8px 根滚动条，而 P0 页面都比视口高 1px。最小复现见 [root-cause/webkit-fixed-probe/](root-cause/webkit-fixed-probe/)：空白页，同一个 Playwright WebKit 26.6 / Chromium 153，P0 的手机与桌面上下文，有无这条规则各测一次（`result.json` 无规则，`result-scrollbar.json` 有规则）。
  - **WebKit 手机，有规则且多出 1px**：`clientWidth` 仍是 390。之后新排版的固定定位元素按 382 排，全宽 382、左右 16px 的列宽 350。先排版的固定定位元素保持 390 / 358，直到它自己的样式变化才变成 350。
  - **WebKit 桌面**：前后一致，`clientWidth` 和所有固定定位元素都是 1272 / 1240。
  - **Chromium**：无头模式没有滚动条，始终是 390 / 1280。
  - **无此规则时**：WebKit 手机也一致，都是 390。
- **在 Orbit 里**：
  - 常驻测量节点挂载时页面还没溢出，排出 390 后再不重排。它的盒子没变，ResizeObserver 不触发，所以内联宽度一直是 358。
  - 资料页的通知列在页面溢出后排版，CSS 给 350；设置页的通知列保持先前的 358。P0.2 原图里两页宽度不同，原因就在这里。
  - 内联宽度把资料页钉成 358，胶囊居中位置右移 4px。
- **为什么只有 WebKit 手机**：窄屏通知列靠左右 16px 撑开，宽度取决于固定定位视口。桌面通知列固定 360 宽，只有 `left` 跟视口走；WebKit 桌面上测量节点和 CSS 都是 1272，`left` = 896 不变。Chromium 两边都是 390 / 1280。只有 WebKit 手机上，测量节点（390）与通知列自己的排版（382）会不一致。
- **像素**：WebKit 手机 profile-validation 的通知框差 3994 / 4863 px，整块胶囊和阴影右移 4px。settings-saved 两边都是 358，像素不变。

## 修复（`86db4c886`）

[diff](checks/fix.diff)，3 个文件：

1. **`index.css`**：`will-change: transform` 从 `.toast` 移到 `.toast-viewport`。
   - 整列一个合成层，原点是通知列的整数像素位置，边界与 B1 前的通知列层相同（见上表）。
   - 胶囊和卡片都按原来的方式栅格化，在弹层的顶层里也一样。P2.3 当初加 `will-change` 要保留的就是这一点。
   - 通知列里没有定位的后代，这条声明不改变布局。
2. **`ToastViewport.tsx`**：
   - 手机通知列在被弹层接管前不加内联宽度，按原 CSS 排版。
   - 第一次被弹层接管时（渲染中判定），保持它在 body 中最后的宽度，直到通知清空。这个宽度由通知列上的 ResizeObserver 记录，只在 body 中、未接管时记录；如果先在弹层内出现，或视口宽度已变，就按 P2.3 的测量节点公式。
   - 切层时不读布局，也不多提交一次。
   - 桌面通知列的 `left` 照旧始终按测量节点；宿主移动、动画延续、悬停逻辑都没有改。
3. **`components/ui/README.md`**：更新对应的使用说明。

### 取舍与对照实验

| 方案 | 结果 | 证据 |
| --- | --- | --- |
| 不加合成提示（E1）。「`will-change` 只在动画进行时生效」的稳态就是这样 | P0 胶囊回到 P0.2，但 Chromium 卡片在顶层的栅格化偏离原实现：<br>• 弹层内静态卡片 12/12 不同（70–132 px，单通道差 2–3）；<br>• 弹层动画中点 80/80 不同；<br>• 生产通知区 4/4 与 P0.2 不同（73–129 px）；<br>• 静止悬停截图 4/4 不同。<br>这与 P2.3 第 2 版加合成提示之前测到的差异相同（[pixel-audit-diagnostic.json](../p2.3/revision-2/pixel-audit-diagnostic.json)）。WebKit 不受影响 | [controls/expE1-audit.json](controls/expE1-audit.json)、[production-region-vs-p02.json](controls/production-region-vs-p02.json)、[patch](controls/expE1.diff) |
| 合成提示只在动画进行时加 | 在 v2、tip、E1 三种树上，入场动画进行时，动画中的 `div.toast-slot` 都会自成一层（原因 `ActiveTransformAnimation`、`ActiveOpacityAnimation`），所以动画期间加提示没有作用；动画结束后的稳态等于 E1。P0 截图和 P2.3 审计都在稳态取样 | [controls/motion-layers/summary.json](controls/motion-layers/summary.json) |
| 合成提示放在每张卡片上（tip 现状） | B1 本身 | 「根因」 |
| 合成提示放在通知列上（本修复） | 胶囊与 P0 一致，卡片与原实现逐像素一致（见「P2.3 已验收的行为」） | — |
| 只在弹层接管期间加内联宽度、不保持（E2，即 `57f792135` 之前的条件） | WebKit 手机 3 个 P2.3 用例失败：弹层关闭后通知列从 350 变成 358，「关闭后回到原点」和「卡片逐帧固定」（Drawer、Bottom drawer 的 close-0 阶段）都不成立 | [controls/expE2-toasts-webkit-phones](controls/expE2-toasts-webkit-phones/)、[patch](controls/expE2.diff) |
| 只移动合成提示、保留内联宽度（expA） | WebKit 手机宽度仍是 358，B1 的 WebKit 部分不消失 | [root-cause/runs/diag-expA](root-cause/runs/diag-expA/)、[patch](controls/expA.diff) |

### 第 1 版为什么被取代

第 1 版 `83d17f1ca`（[diff](checks/fix-v1.diff)）对 B1 截图的效果与终版相同（`root-cause/runs/diag-fix`、`diag-verify-after`），在漂移验证树上的完整 P0 也是 0 失败（[checks/p0-drift-tree-v1-round-1](checks/p0-drift-tree-v1-round-1/summary.json)）。

但第 1 版在切层时，先在 cleanup 里读一次 `getBoundingClientRect()`，再多提交一次固定几何。WebKit 上这让通知第一次出现在弹层里的帧变晚，P2.3 的「入场动效跨弹层保留进度」用例更容易失败：
- 同时运行的对照中，第一次出现在弹层内的时间中位数为（tip / v1）：深色桌面 113.5 / 121 ms，深色手机 120.5 / 153.5 ms，浅色桌面 134 / 156 ms（[checks/ab-transfer-v1/entrance-timing.json](checks/ab-transfer-v1/entrance-timing.json)）；
- 第 2 轮正式矩阵中，该用例在 4 个 WebKit 项目全部失败（[checks/toasts-v1-round-2](checks/toasts-v1-round-2/frame-analysis.txt)）。

入场动效只有 180ms，tip 上这一帧本来就在约 115–125ms，余量很小。终版去掉了这两步。WebKit 四个项目各重复 8 次的对照里，第一次出现在弹层内的时间中位数为（tip / 终版）：115.5 / 119.5、121.5 / 126.0、111.0 / 113.5、112.0 / 111.5 ms；终版 32/32 通过，tip 31/32（[checks/ab-entrance-v2/entrance-timing.json](checks/ab-entrance-v2/entrance-timing.json)）。

## 验证

### 修复前后同条件对照（诊断运行）

| 对照 | settings-saved（期望：main 漂移参考） | profile-validation（期望：P0.2） | notification-error |
| --- | --- | --- | --- |
| 漂移验证树 `7f901366e` → + 修复 `43e1d0f44`（`diag-verify-before` → `diag-verify-after-v2`） | 3 张比较器失败（另 1 张 97 px 低于阈值）→ 8/8 通过 | 5 张失败（另 1 张低于阈值）→ 8/8 通过 | 不变 |
| 项目 tip `77233e226` → + 修复 `86db4c886`（`diag-tip` → `diag-fix-v2`） | 3 张失败 → 8/8 通过 | 页面有新的 main 漂移，整图不能对照 P0.2；通知框见下行 | 不变 |
| 通知框：B1 前 `e361ee373` → 修复后 | 8/8 为 0 px | 列宽和胶囊位置回到 B1 前（WebKit 手机 350 / 123.141）。漂移验证树上 8 张里只剩两张 Chromium 手机各 8 px（单通道差 1）的噪声 | 8/8 为 0 px |

- 修复前后通知框内的改变量，恰好是 B1 引入时的反向：WebKit 手机 3994 / 4863 px，Chromium settings-saved 97 / 1300 / 1418 px，等等（`root-cause/toast-box-verify-before-to-after-v2.json`、`toast-box-tip-to-fix-v2.json`）。
- 漂移验证树 + 修复的诊断运行里，80 张截图（settings、settings-saved、profile、profile-validation、5 张 session）全部通过 P0 比较器：75 张与期望逐字节相同，5 张差 3–28 px、单通道差 1，属于 Chromium 噪声（[vs-p0-expectations.json](root-cause/runs/diag-verify-after-v2/vs-p0-expectations.json)）。

### P2.3 已验收的行为

#### toasts 完整矩阵与机器负载

命令不变：`NO_COLOR=1 npm run test:ui-toasts -w @orbit/web`，34 个用例 × 8 个项目共 272 个，原断言未改。每一轮都保留。

| 轮次 | 树 | 结果 | 同期负载（1 分钟） | 记录 |
| --- | --- | --- | --- | --- |
| 基线 | 项目 tip `77233e226`（未改） | 272/272 | 30–60 | [checks/toasts-tip-unmodified](checks/toasts-tip-unmodified/summary.json) |
| v1 第 1 轮 | `83d17f1ca` | 264 通过、8 失败 | 8–78（后半段 50–78） | [checks/toasts-v1-round-1](checks/toasts-v1-round-1/) |
| v1 第 2 轮（`nice -10`） | `83d17f1ca` | 263 通过、9 失败 | 33–55 | [checks/toasts-v1-round-2](checks/toasts-v1-round-2/) |
| **终版第 1 轮（`nice -15`）** | `86db4c886` | **272/272，0 flaky，退出码 0** | 27–39 | [checks/toasts-v2-round-1](checks/toasts-v2-round-1/)（原始报告 `report.json.gz`、全部附件、帧分析） |

- **v1 两轮的失败**：都是依赖帧率或原生计时的用例，帧分析见各轮的 `frame-analysis.txt`。其中「入场动效跨弹层」在第 2 轮四个 WebKit 项目全部失败，这是 v1 自身的切层开销，见上节。其余失败在未改动的 tip 上同样出现。
- **同时运行的 tip 对照**：tip 和修复在同一时刻、各自独立的网络命名空间里运行同一组对计时敏感的用例 —— 卡片固定 ×3、入场跨弹层、退场跨弹层 ×2，8 个项目。
  - v1 对照：tip 163 通过、8 失败，v1 168 通过、7 失败，失败的是同一组用例（[checks/ab-transfer-v1](checks/ab-transfer-v1/tally.json)）。tip 的失败包括手机错误卡片因用例过慢、超过 6 秒而折叠成胶囊。
  - 终版对照：tip 93 / 3，终版 94 / 2（[checks/ab-transfer-v2](checks/ab-transfer-v2/tally.json)）。
  - WebKit 桌面 Bottom drawer 卡片固定各 10 次：tip 20/20，v1 20/20（[checks/ab-replay-v1](checks/ab-replay-v1/tally.json)）。
- **两个只在负载下出现过的现象**，都不能归到修复：
  - 一次入场动效重播：v1 第 1 轮，WebKit 深色桌面 Bottom drawer，发生在第 568ms 的采样空档之后。上面的 10 次对照没有复现。
  - WebKit 选择高亮残留：「copyable diagnostics」截图里，清除选择后高亮仍在。未改动的 tip 也出现过（webkit-dark-phone），终版正式轮只在 webkit-light-phone 出现一次；该截图没有断言（`tools/highlight.py`）。

#### 生产通知入口

`NO_COLOR=1 npm run test:ui-migration -w @orbit/web -- feedback-production.browser.mjs`：终版 8/8（[checks/production-v2](checks/production-v2/)），v1 8/8（[checks/production-v1](checks/production-v1/)）。

#### P2.3 第 3 版审计的重新执行

[tools/audit-p23.py](tools/audit-p23.py) 用 P2.3 第 3 版 `audit.py` 的同一组参考和同一种比较方式：全部 RGBA，无容差。只是逐项记录结果，不在第一处断言失败时停下。终版正式轮的结果见 [p23-audit/v2-round-1.json](p23-audit/v2-round-1.json)：

| 审计项 | 结果 |
| --- | --- |
| 弹层内已有通知（Dialog / Drawer / Bottom drawer × 8 个项目）的几何与计算样式，打开弹层前后都与原实现（任务起点）相同；`with-overlay` 截图像素相同 | 24/24、24/24 |
| P2.3 第 2 版保存的原实现动画中点截图（160 张）与本轮同名截图 | 160/160 零差异 |
| 生产通知区（含 12px 阴影区域）与 P0.2 的 `notification-error.png`；整页与任务起点 | 8/8、8/8 零差异 |
| 卡片逐帧固定（24 组） | 2451 帧，0 帧移动 |
| 原生计时下切层后通知消失 | 8/8 |
| 静止悬停：保持、mouseover、无 mousemove、移开后消失；布局进出；清空后替换；静止到达截图与原实现 | 8/8、8/8、8/8、8/8 零差异 |

本轮全部 320 张 PNG 附件又与未改 tip 的基线逐张对照（[same-commit-vs-tip.json](checks/toasts-v2-round-1/same-commit-vs-tip.json)），292 张相同，28 张不同：
- **18 张**含胶囊或「+1 more」按钮：短通知、旧 AntApp 确认、混合堆叠、手机折叠。它们的 x 是小数，现在和原实现一样在通知列的层里栅格化；WebKit 手机上通知列宽回到原 CSS。
- **8 张**的差异全在通知列以外：弹层按钮的悬停或聚焦状态、背景遮罩，例如手机确认框的 Save 按钮。
- **2 张**是上面说的 WebKit 选择高亮残留，tip 和终版各一张。

### 完整 P0：漂移验证树 + 修复（两轮）

命令不变：`NO_COLOR=1 npm run test:ui-migration -w @orbit/web`，在 `43e1d0f44` 上运行。

| 轮次 | 结果 | 记录 |
| --- | --- | --- |
| 第 1 轮 | 112 个测试：85 通过、16 个已记录的焦点预期失败（P0.2-FOCUS-1/2 × 8 个项目）、11 个已记录的跳过，**0 失败**、0 flaky，退出码 0 | [checks/p0-drift-tree-v2-round-1](checks/p0-drift-tree-v2-round-1/summary.json)（含 `report.json`、`command-output.txt`、`sources.json`、`environment.json`） |
| 第 2 轮（紧接其后） | 同上；112 个测试逐个状态相同 | [checks/p0-drift-tree-v2-round-2](checks/p0-drift-tree-v2-round-2/summary.json)、[两轮对照](checks/p0-drift-tree-v2-rounds-compare.json) |

两轮的期望图组装都输出 `P0 expected screenshots: 131 P0.2 originals, 121 main drift references, 0 accepted migration differences.`，环境与 P0.2 记录一致。结果只含已记录的处置：16 个焦点预期失败和 11 个跳过。

### 完整 P0：项目 tip + 修复（两轮）

| 轮次 | 结果 | 记录 |
| --- | --- | --- |
| 未改动的 tip（对照） | 62 通过、16 预期失败、11 跳过、**23 失败**：B1 的 settings-saved 3 个 + 新漂移 20 个 | [checks/p0-tip-unmodified](checks/p0-tip-unmodified/summary.json) |
| tip + 修复，第 1 轮 | 65 通过、16 预期失败、11 跳过、**20 失败**，B1 的 3 个消失；0 flaky | [checks/p0-tip-v2-round-1](checks/p0-tip-v2-round-1/summary.json) |
| tip + 修复，第 2 轮 | 同上；112 个测试逐个状态相同，20 个失败的差异像素数逐个相同 | [checks/p0-tip-v2-round-2](checks/p0-tip-v2-round-2/summary.json)、[两轮对照](checks/p0-tip-v2-rounds-compare.json) |

两轮共 40 条失败记录，全部逐张归因（[checks/new-drift-attribution.json](checks/new-drift-attribution.json)，未归因 0 条），见「缺口」。真实 tip 上 profile 用例停在 `profile.png`，后面的 `profile-validation.png` 比较不到。它的 B1 修复由上面两处证明：漂移验证树的两轮完整 P0，以及真实 tip 上的同条件诊断。

### 合并检查

`npm run build -w @orbit/web && npm run test -w @orbit/web`，在交付分支 `86db4c886` 上运行，退出码 0：
- `tsc -b && vite build` 成功，保留原有的大 chunk 提示；
- Vitest **340 个文件、4326 个用例全部通过**，用时 273 秒。

输出见 [checks/merge-check/](checks/merge-check/)：`output-filtered.txt` 去掉了用例运行中的控制台告警，`output-full.txt.gz` 是完整输出。

加入本目录后，又在证据提交 `bc6d7078f` 上原样跑了一次，结果相同：构建成功，Vitest 340 个文件、4326 个用例全部通过，用时 281 秒，退出码 0（[checks/merge-check-final/](checks/merge-check-final/)）。

## 缺口

### 项目分支吸收的 main 改动（新漂移，未处理）

真实 tip 上，除 B1 外的 20 个失败都来自 `dd1d197ef` 吸收的 main 改动。

同环境确认（[attribution/](attribution/)）：用项目 tip 上不变的 P0 测试和固定数据，跑 main first-parent 上引入改动的合并提交及其前一个提交。各轮的截图哈希和输出在 `attribution/runs/`，变化点的截图在 `attribution/images/`，汇总在 [attribution/attribution.json](attribution/attribution.json)。

| 失败 | 张数 | 方式 | main 提交（及 main first-parent 上引入它的合并） | 同环境证据 |
| --- | --- | --- | --- | --- |
| profile（`profile.png`） | 8 | 截图，4626–13970 px | `d233a6cd0` feat(auth): add access token management and /pat/self introspection（合并 `86c6d2d4d`，其中唯一的 Web 提交） | `85b18b646` 上 8 张都与 P0.2 相同（0 px）；`86c6d2d4d` 上比较器报出的像素数与 tip 上 8 个失败逐个相同（如 9400、13970）。资料页新增「Also revoke all my access tokens」勾选项和说明 |
| wiki（等待 `.wk-card`） | 8 | 定位失败，没有截图 | `2f9cc095f` refactor(wiki): list topic articles on the Wiki home, drop status cards（合并 `be0f8c22a`，其中唯一的 Web 提交） | `51f0cdfee` 上 wiki 场景 8/8 通过；`be0f8c22a` 上 8/8 同样定位失败。该提交新增 `WikiHomeContent.test.tsx`，断言首页没有 `.wk-card` |
| breakpoint-959-wiki（桌面） | 4 | 截图，8787–9047 px | `6c4e0ac0e` feat(wiki): Activity page, the head's Activity badge…（合并 `dcfb5adf6`）与 `2f9cc095f`（合并 `be0f8c22a`） | WebKit 依次为：<br>• 到 `0982d8ed8` 为止与 P0.2 相同（0 px）；<br>• `dcfb5adf6` 改变（2274 / 6265 px，比较器已失败）；<br>• `51f0cdfee` 不变；<br>• `be0f8c22a` 再次改变，比较器像素数与 tip 相同（如 8787）；<br>• 此后到 `f86211ec3`（与项目 tip 构建产物相同）不变。<br>`a884fda36`（合并 `30cf89786`）没有改变它 |

另外两处在真实 tip 上**比较不到**，供补登任务参考：
- profile 之后的 `profile-validation.png`：在 `86c6d2d4d` 上与 P0.2 不同，来自 `d233a6cd0`；
- wiki 场景的 `wiki-home.png`、`wiki-new-entry.png`：在 `51f0cdfee` 上已与 P0.2 不同（8/8，204–233 / 128–186 px），来自 `6c4e0ac0e`；手机的 `wiki-contents.png` 当时未变。`2f9cc095f` 之后定位先失败，这些截图到不了比较这一步。

按协调者要求，这些都不在本任务处理：不登记、不改场景和等待条件。由 [P0 漂移登记（第 2 批）](orbit-task:34bTKzXFSRGjnDevEBJlh) 负责。

### 其它边界

- **模拟环境**：Linux 上的 Chromium / WebKit 手机模拟不等于真机 iOS Safari。WebKit 手机 382 / 390 的不一致来自全局 8px 自定义滚动条在 Linux WPE 模拟中的排版，真机 iOS 用覆盖式滚动条，可能不出现。修复不依赖这一点：没有弹层接管时，它就是原 CSS。
- **测量节点公式**：通知先在弹层内出现，或弹层接管后视口宽度变化时，手机通知列按测量节点公式计算，与 P2.3 相同；这两种情况没有原实现的直接对照。
- **动画重播**：只在极端负载下见过一次入场动效重播，没有复现，也没有确立机制。确定性复现尝试（阻塞主线程 400ms，两种方式）在 tip 和修复上都没有触发，记录在 `tools/toasts-race.diag.mjs`。
- **负载与优先级**：正式运行使用了 `nice`，未改动 tip 的基线没有。负载对计时用例的影响，用同时运行的 tip 对照来衡量。
- **不交付的部分**：漂移验证树的提交只在本地分支 `b1-verify-drift-tree`，第 1 版只在本地分支 `b1-fix-v1` / `b1-verify-drift-tree-v1`。

## 复跑

```sh
bash scripts/worktree-overlay.sh
# 修复后的 P0（在漂移验证树 = 7f901366e + 修复上全绿；在项目 tip 上剩新漂移的 20 个）
NO_COLOR=1 npm run test:ui-migration -w @orbit/web
NO_COLOR=1 npm run test:ui-toasts -w @orbit/web
NO_COLOR=1 npm run test:ui-migration -w @orbit/web -- feedback-production.browser.mjs
npm run build -w @orbit/web && npm run test -w @orbit/web
# P2.3 审计（采集用 tools/collect-run.py，参考在 ../p2.3/）
python3 docs/evidence/base-ui-migration/p2.3-b1/tools/audit-p23.py <toasts-collected> <production-collected> <out.json> [<tip-toasts-collected>]
# 根因诊断（需要 /var/tmp/p23b1 下的各树；用法见各脚本开头）
docs/evidence/base-ui-migration/p2.3-b1/tools/prepare-tree.sh <rev> <label>
docs/evidence/base-ui-migration/p2.3-b1/tools/run-diag.sh <label> <run> -g "(settings|profile|session)$"
node docs/evidence/base-ui-migration/p2.3-b1/root-cause/webkit-fixed-probe/probe.mjs
SCROLLBAR=1 node docs/evidence/base-ui-migration/p2.3-b1/root-cause/webkit-fixed-probe/probe-scrollbar.mjs
```

工具都在 [tools/](tools/)，每个脚本开头写有用法。它们引用 `/var/tmp/p23b1` 的临时树和运行目录，换机复跑时需要改路径。`summarize-report.py` 取自 `../p0-drift/tools/`。
