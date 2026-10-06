# P0 基线漂移归因与 main 漂移参考层

本目录服务于 [P0 基线漂移归因与参考维护（不改 P0.2 原图）](orbit-task:34b8BRQ7HHDwl44Qp0MoC)。项目验收条目 key `5wbhutjez7Qv5GCTNLb0P7`，原文：**P7：完整迁移通过最终构建、行为与视觉回归，并有实测收益和可回退交付记录。** 本任务只承担其中一个前提：让 P0 浏览器回归在项目 tip 上重新可用。具体包括归因 P0.2 以来的截图漂移、建立 main 漂移参考层、修复 `getByText` 的偶发冲突。

开工读取了 task_get（无历史评论）、project_get 的目标、8 项验收和作业指导（含「P0 已验收交接」「P0.2 基线漂移」两段）、[P0.2 README](../p0.2/README.md)，以及 [P3.1 README](../p3.1/README.md)「真实页面：同提交对照」一节和它的 p0-regression、reference-manifest、p0-reference.config.mjs。起点是项目分支 tip `da13423d3e80e00a487ed91327c31d6788cc7a7a`，工作期间没有变动。本轮由 Claude Opus 5.5 执行。没有推送 main 或项目分支，没有部署或发布。

## 结论

- tip 的 252 张 P0 截图中，有 **127 张与 P0.2 有确定的差异**，其中 123 张不通过 P0 比较器，4 张差异低于阈值。另有 12 张字节不同，属于 Chromium 渲染噪声：在 P0.2 自己的提交上重跑也会出现，见「Chromium 渲染噪声」。P3.1 记录的「137 张不同」是按 SHA-256 统计的，含有噪声。
- 127 张全部归因到具体提交：
  - **a 类（main 产品改动）121 张**：main `918034e72` 和 `f5bdd7fd3`（会话列表行，28 张）、`93d3ec580`（项目页，28 张）、`4088d37e6` 合入的 `82c7e92ff`（任务面板与设置，64 张）、`e64d0c72a`（961px 暗色 Wiki，1 张，差异低于阈值）。
  - **b 类（迁移改动）10 张**：P2.3 的 `57f792135` 改变了成功提示胶囊，涉及 profile-validation 6 张，以及 Chromium 的 settings-saved 4 张。这 4 张同时也有 a 类改动。
  - P1.1、P1.2、P2.1、P2.3 的其余提交、Select 快键修复和 P3.1 的全部提交，都没有改变任何 P0 截图。P2.2 交付合入后的全部变化都由 main 提交解释，P2.2 的组件提交本身在受检场景中没有改变截图。
- **b 类没有修**，按任务要求交给协调者另建修复任务。逐项证据和诊断见「b 类」一节：Chromium 的差异来自 `.toast { will-change: transform }`；WebKit 手机的差异来自通知区始终使用测量出的内联宽度。
- 新增 **main 漂移参考层**：只登记了 121 张 a 类截图，每张都在其最后一个 main 提交的树上生成，并记录来源提交、环境和 SHA-256。P0 回归默认对照 P0.2，只有登记的截图改为对照参考层。P0.2 的 252 张原图、原断言和 known-failures 标记都没有改。
- `getByText` 偶发冲突已修复：定位改为限定在可见的 Notifications 区内，断言的文字、精确匹配和可见性要求都没变。修复后同一场景连续 400 次执行 0 失败。⟦ORIGINAL400⟧归因运行全部使用原定位，690 次执行中失败 71 次。
- **验证**：
  - tip 上的 P0 回归连续两轮，结果完全相同：93 通过（69 个 P0 正常通过、P2.3 新增的 8 个 feedback-production 通过、16 个已知焦点预期失败）、11 个跳过、**8 个失败**。8 个失败两轮相同，都是 b 类 B1 的截图，所以**本任务验收要求的「连续两轮全部通过」没有达到**，见「边界」。
  - 负对照：在设置页做 1px 改动后，8 个项目全部在已登记的 settings.png 上失败。
  - 诊断：在只中和了 B1 的临时树上，完整回归全绿，结果只含已记录的处置。
  - 项目合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web` 通过：Vitest 323 个文件、4065 个用例。

## 提交

| 提交 | 内容 |
| --- | --- |
| `c1cc446b0` | test：P0 设置、账号场景的保存提示改在 Notifications 区内定位（`page-scenarios.mjs`，2 处） |
| `503f4d5c2` | test：P0 回归改读 globalSetup 组装的期望截图。来源是 P0.2 原图，已登记的截图换成参考层；新增 `expected-screenshots.mjs`，配置改 3 行；registry 初始为空 |
| `edb3259af` | test：登记 121 张 main 漂移参考（`reference/`） |
| 证据提交 | 只新增本目录其余文件 |

除 `page-scenarios.mjs` 的 2 处定位外，P0 原测试文件没有改动：harness、fixtures、session-fixtures、session-scenarios、pages/states/breakpoints/known-failures/performance 测试、environment.mjs、collect-evidence.mjs。三个提交可以单独回退。回退 `503f4d5c2` 后，模板重新指向 P0.2 原图目录。

## 环境与方法

- **依赖与环境**：本树用 `bash scripts/worktree-overlay.sh` 按锁文件隔离安装。主工作区的安装与锁文件不兼容，脚本因此执行了独立 `npm ci`。每个候选提交都在 `/var/tmp` 的独立工作树里用 tip 版的同一脚本准备依赖，再按 `pretest:ui-migration` 构建 shared 和 Web。所有浏览器运行都先由 P0 的 `environment.mjs` 与 [P0.2 environment.json](../p0.2/environment.json) 逐字段比较并通过：Debian 13.7、Node v26.10.0、npm 11.19.1、Playwright 1.63.0、Chromium 1243 / WebKit 2359、56 个字体文件及其 SHA-256。每次运行写出的 `environment.json` 都与 P0.2 记录逐字节相同（SHA-256 `fe69e824…`），见 [runs.json](attribution/runs.json) 的 `environmentSha256`。主机为 24 核、15 GB 内存，期间其他会话一直在占用，负载约 13–62。runner 两次在引擎回收时清理了本会话的后台任务（drain_cap），被打断的运行都换新标签完整重跑过。
- **P0 原测试**：归因运行器只用 P0.2 交付 `3e1d1ca08` 的 P0 文件（与 tip 同名文件逐字节相同；配置在 tip 上多了 testIgnore）。[drift.config.mjs](tools/drift.config.mjs) 在 P0 配置上只做三处改动：截图写入空的临时目录（`--update-snapshots=all`），输出改到运行目录，预览服务器在被测树的 `src/web` 里启动（仍是 P0 原命令 `npm run preview`）。
- **同源**：分享弹窗会显示 `location.origin`。每次运行都放进独立网络命名空间（`unshare -n`），因此都保持 P0 的 `http://127.0.0.1:4173`，几个运行可以并行而不用改端口。
- **截图对比**：逐张解码 PNG，分别记录逐像素差异（像素数、单通道最大差、范围）和 Playwright 比较器的结果（P0 选项：`maxDiffPixels: 0`，默认 threshold），后者就是 P0 回归实际做出的判定。
- **候选提交**：项目分支从 P0.2 父提交 `f4d47e853` 到 tip 的 first-parent 历史共 38 个提交（P0.2 在项目线上的回放是 `6bbf3ecc3`）。其中 19 个改动了 Web 构建输入（`src/web/src` 中的非测试/文档文件、index.html、shared 源码、锁文件等）。这 19 个都构建并比较了生产 dist，其中 16 个跑了完整 P0 截图矩阵；另外 3 个的 dist 与已跑提交逐文件相同，没有重跑：`3dd6e9b51` 与 `c500817e2` 相同，`81f15bef1`、`e207a13eb` 与 tip 相同。`6bbf3ecc3` 与 `d66517339`、`31aa07c91` 与 `c500817e2` 的 dist 也相同，因并行都跑了，可作噪声对照。另外 19 个提交（含 tip 本身，tip 另跑了完整矩阵）只改了测试、文档或证据，⟦DIST_CHECK⟧
- **二分**：某张截图在一个合并提交上变化时，沿该合并第二父提交的 first-parent 线继续向下找，必要时再下一层（main 内部的 `Merge origin/main into main`、P2.2 交付线），直到落在单个提交上。按场景分组二分，只跑受影响的场景，例如 `pages.browser.mjs -g 'session$'`。大区间用 [bisect-drift.py](tools/bisect-drift.py) 递归切分，两端渲染相同的区间不再拆分。每个结论都再在被归因提交和它的 first-parent 前驱上各跑一次完整 P0 矩阵，覆盖同组的断点截图。[attribution.py](tools/attribution.py) 用已记录的运行重新核对每一条结论：前驱与区间起点相同，被归因提交改变了组内全部截图，区间终点与被归因提交相同。结果在 [attribution.json](attribution/attribution.json)，六条全部通过。

共 83 次运行，每次的提交、命令、各次尝试、环境哈希和每张截图的 SHA-256 都在 [runs.json](attribution/runs.json)。

## Chromium 渲染噪声

在 P0.2 自己的提交 `3e1d1ca08` 上，同一环境重跑两次：
- WebKit 两次都与 P0.2 原图逐字节相同。
- Chromium 第一次有 21 张、第二次有 22 张与原图不同，两次之间也有 18 张不同。每张 1–89 像素，单通道最大差 4，全部通过 P0 比较器（[noise.json](attribution/noise.json)）。

dist 逐文件相同的两个提交之间也是这样，例如 `d66517339` 与 `6bbf3ecc3`，`c500817e2` 与 `31aa07c91`。所以 SHA-256 不同不代表页面改了。

本次判定截图「变化」的条件是满足任一项：P0 比较器不通过；WebKit 任一像素不同；Chromium 单通道差超过 4 或超过 200 像素。其余记为噪声。噪声只出现在 Chromium，位置和数量每次运行都不同，不会形成跨运行稳定的差异。这条规则只用于归因，P0 回归本身仍是原来的 `maxDiffPixels: 0` 和默认 threshold。

## tip 与 P0.2 的差异

tip 运行（`tip-a`，P0.2 原测试）共 252 张：113 张逐字节相同，139 张字节不同。字节不同的 139 张里，123 张不通过 P0 比较器，16 张低于阈值。按归因汇总（C=Chromium，W=WebKit）：

| 归因 | 截图 | 比较器失败 | 低于阈值 |
| --- | --- | ---: | ---: |
| A1+A2 | session-idle / session-streaming / session-composer-focus / session-attachment-menu / session-attachment-staged / notification-error / breakpoint-961-session，各 4 个桌面项目 | 28 | 0 |
| A3 | project-overview ×8、project-graph ×8、breakpoint-639-graph ×4、breakpoint-641-graph ×4、project-graph-fullscreen ×4（C 失败，W 低于阈值） | 26 | 2 |
| A4 | task-detail、task-action-hover/focus/menu、task-share-dialog、settings 各 ×8，breakpoint-599/601-dialog 各 ×4，settings-saved W ×4 | 60 | 0 |
| A4+B1 | settings-saved C ×4 | 4 | 0 |
| A5 | breakpoint-961-wiki C-dark-desktop | 0 | 1 |
| B1 | profile-validation C-dark-desktop、C-light-desktop、C-light-phone、W-dark-phone、W-light-phone（失败）；C-dark-phone（低于阈值） | 5 | 1 |
| 噪声 | Chromium：wiki-home ×3、wiki-new-entry ×4、wiki-contents ×2、breakpoint-959/961-wiki ×2、breakpoint-641-projects ×1 | 0 | 12 |

确定差异合计 127 张：28 + 28 + 64 + 1 + 6。

## 归因表

| 编号 | 类别 | 截图 | 项目线提交 | 下钻路径 | 归因提交 | 差异内容 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | a | 会话 28 张（桌面） | `ed108d8c8` 吸收 main `e8cc771b0` | main first-parent：`293e12a85` 不变 → `918034e72` 改变 → `e8cc771b0` 与之相同 | main **`918034e72`** fix(web): reveal session menu on hover and focus | 选中会话行的 ⋯ 按钮不再常显，只在悬停/聚焦时出现（12 像素） |
| A2 | a | 同上 28 张 | `e5a470fe6` 吸收 main `72246fe2a` | main first-parent：`2c97b6b63` 不变 → `e3988ad7b`（Merge origin/main into main）改变；再沿其第二父 `d0eedc65c` 的 first-parent 线：`6e5ba7544`（P1.2 晋升，不变）→ `f5bdd7fd3` 改变 → `d0eedc65c` 与之相同 | main **`f5bdd7fd3`** fix(web): float session menu over full-width text | 行标题改为占满整行宽度、菜单浮在其上，标题截断位置后移，「just now」右移（约 620 像素） |
| A3 | a | 项目页 28 张 | `42e7e01f4` 吸收 main `ec2326294` | main first-parent：`06400e8ea`（P2.1 晋升，不变）→ `93d3ec580` 改变 → `ec2326294` 与之相同 | main **`93d3ec580`** fix: clarify landing activity and manual-start readiness | Work overview 去掉「Dispatch needs attention」卡和 Ready 格高亮，Coordinator 卡与「How it runs」上移，依赖图区随之移动 |
| A4 | a | 任务面板与设置 64 张 | `8ef6b60d1` 合入 P2.2 交付 `orbit/p2-2-2e616a` | P2.2 线：P2.2 自身 4 个提交不变，`9ccb09e86` 不变 → `38947755e`（吸收 main `6cdca5a03`）改变 → `8a29e3493` 相同；main first-parent（43 个候选递归二分）：`14e64870f` 不变 → `4088d37e6` 改变 → `6cdca5a03` 相同 | main **`4088d37e6`**（Merge project/34Z2CCqHygFxrbqBlPljx into main），合入的唯一 Web 提交是 `82c7e92ff` feat(routing): gate model hint instructions on owner's smart model selection | 未开启 smart model selection（固定数据为关闭）时，任务面板不再显示 Suggested 行，下方内容上移（分享弹窗遮罩后同样可见）；设置页新增 Smart model selection 开关 |
| A5 | a | breakpoint-961-wiki C-dark-desktop 1 张 | `8ef6b60d1` | P2.2 线：`9ccb09e86` → `38947755e` 改变；main first-parent（递归二分）：`5bc8c9d63` 不变 → `e64d0c72a` 改变 → `6cdca5a03` 相同 | main **`e64d0c72a`** feat(web): let the desktop Wiki home fill the main region | 目录当前项「Home」的图标、文字和底色合成差 1 个色阶（210 像素，单通道差 ≤1，低于阈值） |
| B1 | b | profile-validation 6 张、settings-saved C 4 张 | **`57f792135`** fix(web): preserve notification motion and hover across modal changes（P2.3） | 项目线：`e361ee373` 不变（与 `57f792135` 之间只有测试/文档提交）→ `57f792135` 改变 → `6d2156683` 相同 | 迁移提交 `57f792135` | 见下节 |

A1–A5 的 main 提交都在 `origin/main` 上，且都不是本项目的晋升合并。会话组的两个提交满足 `918034e72` 是 `f5bdd7fd3` 的祖先。每个归因的同环境截图：
- 代表截图的前后对照和差异图在 [attribution/images](attribution/images/)（[索引](attribution/images/index.json)）；
- 全部截图的 SHA-256 在 [runs.json](attribution/runs.json)；
- 二分过程在 [changepoints-project-line.json](attribution/changepoints-project-line.json)、[changepoints-p2.2-line.json](attribution/changepoints-p2.2-line.json)、[任务/设置二分](attribution/bisect-main-6cdca5a03-task-settings.json)、[Wiki 二分](attribution/bisect-main-6cdca5a03-wiki961.json)；
- 每步核对见 [attribution.json](attribution/attribution.json)，输入为 [changes.json](attribution/changes.json)。

## b 类：迁移造成的差异（本任务不修，交协调者另建修复任务）

**B1：P2.3 `57f792135` 之后，设置、账号页成功提示胶囊（「Setting saved」「Name saved」）的绘制与 P0.2 不同。**

| 截图 | 项目 | 像素（`e361ee373`→`57f792135`） | P0 比较器 |
| --- | --- | --- | --- |
| profile-validation | C-dark-desktop / C-light-desktop / C-light-phone / C-dark-phone | 508 / 495 / 316 / 313，单通道差 88 / 113 / 60 / 48 | 前 3 个失败，C-dark-phone 低于阈值 |
| profile-validation | W-light-phone / W-dark-phone | 4863 / 3994，单通道差 224 / 167 | 失败 |
| settings-saved | C-light-desktop / C-light-phone / C-dark-phone / C-dark-desktop | 97 / 1418 / 1309 / 97 | 前 3 个失败，C-dark-desktop 低于阈值 |

WebKit 桌面的两张截图，以及 WebKit 的 settings-saved，都没有变化。

计算样式与几何（[B1-success-pill.json](b-class/B1-success-pill.json) 的 `computedStyles`，记录 `e361ee373`、`57f792135` 和 tip 三棵树、8 个项目、两个场景，在截图时刻取值）：
- 胶囊从 body 下移到 `div.toast-layer[popover=manual]`，处于 top layer，并新增 `will-change: transform`。三棵树中 `57f792135` 与 tip 一致。
- Chromium 下胶囊和文字的矩形完全不变（如桌面 settings-saved 卡片 x=1118.969、宽 145.031），差异只来自合成层重新栅格化。
- WebKit 手机的 profile 页上，通知区从 CSS 算出的 350px 宽变为内联 `width: calc(390px - 32px - …)` 的 358px，胶囊 x 从 123.141 移到 127.141（右移 4px）。WebKit 手机的 settings 页前后都是 358px，所以不变。

诊断（只在临时树里做，不交付）：
- E1：只去掉 `.toast` 的 `will-change: transform`。Chromium 的 profile-validation 回到 P0.2 噪声水平（5–45 像素，差 ≤1），Chromium 的 settings-saved 对照参考层通过 P0 比较器；WebKit 手机仍不同。
- E2：E1 加上内联宽度/left 只在模态接管通知时使用（即 `57f792135` 之前的条件）。全部 16 张都通过 P0 比较器：profile-validation 对照 P0.2，settings-saved 对照参考层（[补丁](b-class/exp-e2-no-width-override.diff)）。在该临时树上跑完整 P0 回归，0 失败，见「验证」。

出处与判断：P2.3 [第2版说明](../p2.3/revision-2/README.md) 写明，加合成层是为了「修正顶层绘制导致 Chromium 圆角边缘的抗锯齿差异」，持久测量节点是为了保持手机宽度，两者的意图都是与原图一致。当时的对照覆盖了错误卡片和夹具场景，没有重跑 P0 设置/账号页（原文：「本次未重跑完整P0矩阵」）。所以这是**无意的保真偏差**，不是有意的保真修正，不能登记为漂移。修复时需要同时满足 P2.3 自己的模态/抽屉通知用例。E2 只是诊断，不是建议实现。

## main 漂移参考层

- **位置**：[reference/registry.json](reference/registry.json) 和 `reference/screenshots/{project}/{name}.png`，共 121 张。

| 组 | 截图 | 张数 | mainCommits | 生成树（generatedFrom） |
| --- | --- | ---: | --- | --- |
| 会话列表行 | session-idle、session-streaming、session-composer-focus、session-attachment-menu、session-attachment-staged、notification-error、breakpoint-961-session（4 个桌面项目） | 28 | `918034e7…`、`f5bdd7fd…` | `f5bdd7fd3`（运行 full2-f5bdd7fd3） |
| 项目页 | project-overview、project-graph（8 项目），project-graph-fullscreen、breakpoint-639/641-graph（桌面） | 28 | `93d3ec58…` | `93d3ec580`（full2-93d3ec580） |
| 任务面板与设置 | task-detail、task-action-hover/focus/menu、task-share-dialog、settings、settings-saved（8 项目），breakpoint-599/601-dialog（桌面） | 64 | `4088d37e…` | `4088d37e6`（full2-4088d37e6） |
| Wiki 961px 暗色 | breakpoint-961-wiki（chromium-dark-desktop） | 1 | `e64d0c72…` | `e64d0c72a`（m5-e64d0c72a） |

- **每条登记的字段**：`screenshot`、`sha256`、`p0Baseline`（被替换的 P0.2 原图哈希）、`mainCommits`（完整提交号，按时间先后）、`generatedFrom.commit`（等于最后一个 main 提交）、`generatedFrom.environment`（生成运行的 environment.json 哈希，等于 P0.2 记录 `fe69e824…`）、`generatedFrom.run`、`projectLine`（吸收它的项目线提交）、`group`、`change`。
- **生成方式**：参考图来自在该 main 提交的树上用 P0 原测试和固定数据跑出的截图（[make-reference.py](tools/make-reference.py)），没有任何加工。这些 main 树都在 P2.3 晋升（`90e749e72`，10-06 15:23）之前，不含 B1。会话组的生成树 `f5bdd7fd3` 含 P1.1/P1.2 的晋升，项目页的 `93d3ec580` 含 P2.1 的晋升，但这些晋升提交本身经过同样的运行，确认没有改变对应截图。
- **混合情形**：Chromium 的 settings-saved 4 张只登记了 A4 部分。参考图来自 `4088d37e6` 的树，胶囊仍是旧样式，所以 tip 上 B1 继续被检出：3 张失败，C-dark-desktop 低于阈值。
- **未登记**：B1 独有的 profile-validation 6 张，以及其余 125 张，仍然对照 P0.2。
- **校验**：[expected-screenshots.mjs](../../../../src/web/ui-migration/expected-screenshots.mjs) 是 P0 配置的第二个 globalSetup，每次运行都会检查：
  - 252 张 P0.2 原图与 [baseline-run/summary.json](../p0.2/baseline-run/summary.json) 记录的哈希逐一相同；
  - 每条登记只替换一张已有的 P0.2 截图，且只替换一次；`p0Baseline` 等于被替换原图的哈希；`mainCommits` 是完整提交号；`generatedFrom` 指向最后一个 main 提交和 P0.2 环境；参考图与登记的哈希相同；
  - 参考目录里没有未登记的 PNG。

  任何一项不符，整次运行失败。通过后，原图和参考图被复制到 `src/web/.ui-migration-results/expected-screenshots/`（已在 gitignore 内），同时写出 `sources.json` 记录每张的来源层。P0 的 `snapshotPathTemplate` 指向这份副本，运行时（包括 `--update-snapshots`）只会写副本，不会写 P0.2 原图或参考层。
- **其他配置**：其他继承 P0 配置的 fixture 配置（controls、overlays、choices、toasts、composer、reviews）会一起执行这个校验和复制。它们本身不截图，只是多了这一步。P3.1 的 `p0-reference.config.mjs` 自己指定了 snapshotPathTemplate，同提交对照方法不受影响。

## 维护规则

1. **何时登记**：项目分支每次吸收 main（`Merge refs/heads/main into refs/heads/project/…`，或经交付分支吸收）之后，或者某批运行 P0 回归时出现与本批改动无关的截图失败时，都要处理。要在下一批用 P0 做前后对照之前完成，最晚在 P7.1 之前：每张失败截图要么登记为 main 漂移，要么作为迁移缺陷修复。
2. **由谁登记**：发现者记录失败和起点提交后，交给项目协调者。协调者另建「P0 漂移登记」任务（类似本任务），由该任务的执行会话完成归因和登记，以独立提交只改 `reference/`，并更新本目录文档；协调者按 EVIDENCE_JUDGMENT 独立判定后再落地。迁移任务的会话不能在自己的交付里登记自己页面的漂移，以免自证。
3. **凭什么证据**，缺一不可：
   - (a) 沿项目分支 first-parent 历史，定位到使该截图变化的项目线提交；
   - (b) 该提交是吸收 main 的合并时，沿其第二父的 first-parent 线下钻到单个 main 提交 X，并有同环境运行证明 X 的 first-parent 前驱不变、X 改变、区间终点与 X 相同；
   - (c) X 在 `origin/main` 上，不是本项目的晋升合并（`Merge refs/heads/project/34ZZeq0e3IR65GVm2kAs7 into refs/heads/main`），变化来自产品代码而非迁移代码；
   - (d) X 的树里没有影响该页面的迁移改动：项目线扫描表明，在 X 被吸收之前没有迁移提交改变过该截图；若 X 的树已含影响该页面的晋升迁移代码，该截图不能登记，要先修迁移差异；
   - (e) 参考图用 X 的树（若有多个 main 提交，用最后一个）、P0 原测试、固定数据，在 P0.2 环境中生成，环境记录哈希等于 P0.2 environment.json，并按上表字段写入 registry；
   - (f) 登记后在当时的项目 tip 上跑 P0 回归，证明该截图与参考层一致。
4. **迁移改动永远不能登记为漂移**：P1–P7 各任务的提交，晋升合并带回的迁移代码，以及迁移组件、主题、foundation CSS、通知、弹层对页面造成的任何变化，都只能修复，不能登记。同一截图同时有 main 和迁移改动时，只登记 main 部分（参考图在不含该迁移改动的 main 树上生成），迁移部分继续失败直到修复，如本次 Chromium 的 settings-saved。
5. **main 再次改动已登记的页面**：按同一流程，在 `mainCommits` 末尾追加新提交，`generatedFrom` 改为新提交，参考图以单独提交替换，旧图保留在 git 历史里。
6. **禁止**：更新或重新生成 P0.2 原图；放宽 `maxDiffPixels` 或 threshold；在 known-failures 里登记漂移；用 `--update-snapshots` 生成参考图；把归因用的噪声规则用到回归判定上。经确认的有意设计变更，按 P0.2 README 的规则另行记录新期望和审核依据，不进参考层。

## getByText 与读屏副本冲突

- **原因**：`lib/toast.tsx` 的 `announce()` 会在提示出现 50ms 后，把同样的文字写进 body 下的读屏 live region（`div.sr-only[aria-live]`）。P0 的 `getByText('Setting saved' / 'Name saved', {exact:true})` 在这之后被轮询到时，会匹配到两个元素，触发严格模式失败。这在 P0.2 时已经存在，主机负载越高越容易出现。
- **确定性诊断**：[announce-duplicate.browser.mjs](flake/announce-duplicate.browser.mjs) 先等 live region 写入，再分别检查两种定位，在 P0.2 `3e1d1ca08` 和 tip `da13423d3` 的 8 个项目上都复现（[记录](flake/announce-duplicate-diagnostic.json)）。原定位匹配 `div.sr-only` 和 `.toast-head` 两个元素，`toBeVisible` 报严格模式违例；新定位只匹配 Notifications 区内的 `.toast-head`，判定可见。
- **修复**（`c1cc446b0`）：两处改为 `page.getByRole('region', { name: 'Notifications', exact: true }).getByText(…, { exact: true })`，仍要求同样的文字、精确匹配并可见，只是范围从全页收紧到可见的通知区。没有删减断言，也没有加重试或延长超时。session 场景本来就是这样定位错误通知的。
- **稳定性**（[stability.json](flake/stability.json)）：tip 构建上 settings、profile 两个场景 × 8 项目 × `--repeat-each=25`，截图写临时目录，只有定位、fixture 和页面异常会导致失败。修复后 **400/400 通过，0 失败，0 flaky**。同一命令用原定位跑到约 303 次时被 runner 清理中断，期间 9 次严格模式失败。归因运行全部使用原定位，共 690 次执行，71 次同类失败（10.3%），没有其他失败（[统计](flake/attribution-runs-flake-stats.json)）。下面三次带修复的完整回归中，也没有任何定位失败。

## 验证

| 检查 | 结果 | 记录 |
| --- | --- | --- |
| tip 回归第 1 轮 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web` | 112 个测试：93 通过（69 个 P0 正常、8 个 feedback-production、16 个已知焦点预期失败），11 个跳过，**8 个失败**，0 flaky。退出码 1 | [summary](checks/tip-regression-1/summary.json)、[report](checks/tip-regression-1/report.json)、[输出](checks/tip-regression-1/command-output.txt)、[sources](checks/tip-regression-1/sources.json) |
| tip 回归第 2 轮（同一命令，紧接其后） | 与第 1 轮完全相同，8 个失败是同一组。退出码 1 | [checks/tip-regression-2](checks/tip-regression-2/summary.json) |
| 负对照：设置页第一张卡片 `marginBottom: 16 → 17`（[补丁](negative-control/settings-1px.diff)） | settings 在 8/8 个项目都在 `settings.png` 处失败，期望图来自参考层，Playwright 报告 1548–4281 个像素不同；没有补丁时（上两轮）这 8 张全部通过。另外 5 个 profile 失败与 B1 相同。合计 88 通过（72 正常 + 16 预期失败），11 跳过，13 失败 | [negative-control/run](negative-control/run/summary.json) |
| 诊断：只中和 B1（E2 补丁）的临时树 | 101 通过（85 正常 + 16 预期失败），11 跳过，**0 失败**，0 flaky，退出码 0 | [b-class/demo-b1-neutralized](b-class/demo-b1-neutralized/summary.json) |
| 项目合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web` | 通过，退出码 0：`tsc -b && vite build` 成功（保留原有大 chunk 提示）；Vitest **323 个文件、4065 个用例全部通过**，用时 500 秒。运行时 HEAD 为 `edb3259af`，工作区只多本目录的未跟踪文档 | [merge-check.json](checks/merge-check.json)、[过滤后的输出](checks/merge-check.txt)（去掉了通过用例的 stderr 告警，完整输出由 Orbit 按任务行保存） |

tip 两轮的 8 个失败都发生在截图断言上，没有定位失败：
- settings-saved.png，C-light-desktop、C-light-phone、C-dark-phone，对照参考层，分别为 10、135、95 像素；
- profile-validation.png，C-light-desktop、C-light-phone、C-dark-desktop、W-light-phone、W-dark-phone，对照 P0.2，分别为 83、22、18、376、339 像素。

除这 8 个外，结果只有已记录的处置：其余截图与 P0.2 或参考层一致，原 16 个已知焦点预期失败（未出现 unexpected pass），原 11 个跳过（7 个非参考项目的性能采样，4 个手机项目的桌面断点巡检），以及 P2.3 新增的 8 个 feedback-production 通过。两轮都通过了 P0.2 原图哈希和参考层哈希校验（运行输出中的「P0 expected screenshots: 131 P0.2 originals, 121 main drift references.」）。

## 边界

- **未达到的验收项**：tip 上 P0 回归两轮都不全绿，原因只有 B1 一项迁移差异。按任务要求本任务没有修复，也没有把它登记为漂移或写进 known-failures。B1 修复落地后，按「验证」中的诊断，回归应只剩已记录的处置；这需要修复任务在当时的 tip 上实际重跑确认，本证据不能代替。
- 归因判定依赖实测的噪声包络（Chromium 单通道差 ≤4 且 ≤200 像素）。A5 的差异（210 像素、单通道差 1）超过了像素数上限，并且在 8 次独立运行（main 上 2 次、P2.2 线 2 次、项目线 4 次）中，这块区域的位置和每个像素值都完全相同，因此判为确定差异。
- main 线和 P2.2 线只跑了受影响的场景；完整矩阵只在被归因提交和它的前驱上跑。P2.2 自身提交只检查了任务、设置和 Chromium 暗色桌面断点场景，它们对其余截图的净影响已由项目线 `8ef6b60d1` 的完整矩阵覆盖（变化全部由 A4/A5 解释）。
- 原定位的 400 次稳定性对照被 runner 清理中断在约 303 次，「修复前」的失败率以中断前的 9 次和归因运行中的 71/690 次为准。
- B1 的 E1/E2 只是诊断，没有验证 P2.3 自己的模态、抽屉通知用例。去掉 `will-change` 可能影响 P2.3 当初要修的 top layer 圆角抗锯齿。
- 其余边界同 P0.2：Linux 固定环境、合成 REST/SSE、非真机 iOS。

## 复跑

```sh
bash scripts/worktree-overlay.sh
NO_COLOR=1 npm run test:ui-migration -w @orbit/web
npm run build -w @orbit/web && npm run test -w @orbit/web
```

归因工具在 [tools/](tools/)，脚本中的 `/var/tmp/p0drift` 和本工作树路径需要按环境调整：
- `prepare-tree.sh <rev>`：独立工作树、overlay 依赖、构建，并记录 dist 哈希；
- `run-matrix.py <tree> <label> [场景选择]`：在网络命名空间中用 P0.2 原测试截图，遇到 getByText 偶发失败时单独重跑；
- `bisect-run.sh`、`bisect-drift.py`：按场景递归二分；
- `changepoints.cjs` / `pairdiff.cjs`：带噪声规则的变化判定；
- `attribution.py changes.json`：核对归因；
- `make-reference.py reference-spec.json`：生成参考层；
- `netns-regression.sh <tree> <out>`：在临时树上跑 P0 原命令（负对照与诊断）。

单次排查可以用 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web -- pages.browser.mjs --project=chromium-light-desktop`。`.ui-migration-results/expected-screenshots/sources.json` 会列出每张期望图来自哪一层。
