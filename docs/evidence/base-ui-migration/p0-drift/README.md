# P0 基线漂移归因、main 漂移参考层与「已接受的迁移差异」层

本目录服务于任务 [P0 基线漂移归因与参考维护（不改 P0.2 原图）](orbit-task:34b8BRQ7HHDwl44Qp0MoC)，对应项目验收条目 key `5wbhutjez7Qv5GCTNLb0P7`：**P7：完整迁移通过最终构建、行为与视觉回归，并有实测收益和可回退交付记录。** 本任务只负责其中一个前提：让 P0 浏览器回归在项目 tip 上重新可用。具体包括四件事：
- 归因 P0.2 以来的截图漂移；
- 建立 main 漂移参考层；
- 建立「已接受的迁移差异」层；
- 修复 `getByText` 的偶发冲突。

## 执行经过

- **第一个执行会话** `70hiFlnPP5nYu503fVc4UT`（2026-10-06 09:03–13:06 UTC）完成了归因、B1 诊断、main 漂移参考层、定位修复和第一轮验证，提交证据前因 Claude 会话额度用尽停止。它留下 3 个提交（`c1cc446b0`、`503f4d5c2`、`edb3259af`）和 90 个未跟踪的证据文件。
- **本会话** `hTIcKRPmUAbdGiGO4QLeI` 按协调者交接接手：
  - 本分支快进到 `edb3259af`；
  - 90 个文件与原工作树、协调者备份 `untracked.tgz` 逐字节一致，核对后提交为 `88ba56756`；
  - 接手时独立复核了参考层登记和归因，见「接手复核」。
- **协调者的两项决定**（2026-10-06 21:37–21:39 UTC，已写入任务评论和新的验收标准）：
  - B1 不在本任务修，也不登记为任何一类参考，另建修复任务 [P2.3 回归修复：成功提示胶囊的合成层与手机宽度（B1）](orbit-task:34bQk0jlytjFYyi4OgLMK)。该任务依赖本任务，用 main 漂移参考对照 settings-saved。
  - 参考维护增加第二类「已接受的迁移差异」。本任务只建机制、写规则，不登记条目；P3.2 的差异由 P3.2/P3.3 落地后按本规则登记。
- **起点**：项目分支 tip `da13423d3e80e00a487ed91327c31d6788cc7a7a`，两个会话期间都没有变动。
- 由 Claude Opus 5.5 执行。没有推送 main 或项目分支，没有部署或发布。

## 接手复核

本会话没有重做归因。逐项复核了上一会话的结果：

| 复核内容 | 结果 | 依据 |
| --- | --- | --- |
| 参考层 121 条登记（[verify-inherited.py](tools/verify-inherited.py)） | 0 个问题：<br>• 每条只替换一张 P0.2 截图，`p0Baseline` 与 P0.2 记录一致；<br>• 参考图哈希与登记一致，参考目录没有未登记文件；<br>• `generatedFrom.commit` 是最后一个 main 提交，生成运行的提交、截图哈希、环境哈希都与 runs.json 一致；<br>• 5 个 main 提交（`4088d37e6`、`93d3ec580`、`918034e72`、`f5bdd7fd3`、`e64d0c72a`）都在 `origin/main` 上，都不是本项目的晋升合并；<br>• 生成树都不含 B1 的 `57f792135`；<br>• 登记集合正好等于 A1–A5 归因组的并集（121 张） | [inherited-registry-check.txt](attribution/inherited-registry-check.txt) |
| 归因核对（[attribution.py](tools/attribution.py)） | 用已记录的运行重新生成，与 [attribution.json](attribution/attribution.json) 逐字节相同。六组检查全部通过，每组的每张截图都至少被一步检查覆盖 | [attribution-recheck.txt](attribution/attribution-recheck.txt) |
| A4 的 main 合并 `4088d37e6` | 它的第二父线上只有一个提交改了 Web 或 shared，就是 `82c7e92ff` feat(routing): gate model hint instructions on owner's smart model selection；合并的 Web 净差异就是该提交的 9 个文件 | `git log 4088d37e6^1..4088d37e6^2 -- src/web src/shared` |
| 只改测试或文档的提交 | 事后逐个构建：项目线自 P0.2 以来 38 个 first-parent 提交中，23 个的生产 dist 与前驱逐文件相同；dist 有变化的 15 个，每个都有完整矩阵运行，或 dist 与某个已跑提交相同（`81f15bef1` 与 tip 相同） | [dist-check.txt](attribution/dist-check.txt) |
| 逐张归因（[per-screenshot.cjs](tools/per-screenshot.cjs)） | 用 tip 运行 `tip-a` 的 252 张截图重新计算，与上一会话汇总一致：113 张字节相同、139 张不同；123 张不通过 P0 比较器，16 张低于阈值；没有未归因的差异 | [per-screenshot.md](attribution/per-screenshot.md)、[per-screenshot.json](attribution/per-screenshot.json) |

## 结论

- **差异**：tip 的 252 张 P0 截图中，**127 张与 P0.2 有确定的差异**（123 张不通过 P0 比较器，4 张差异低于阈值）。另有 12 张字节不同，属于 Chromium 渲染噪声：在 P0.2 自己的提交上重跑也会出现，见「Chromium 渲染噪声」。P3.1 记录的「137 张不同」是按 SHA-256 统计的，含有噪声。
- **归因**：127 张全部归因到具体提交。逐张的提交见 [per-screenshot.md](attribution/per-screenshot.md)。
  - **a 类（main 产品改动）121 张**：
    - main `918034e72` 和 `f5bdd7fd3`：会话列表行，28 张；
    - main `93d3ec580`：项目页，28 张；
    - main `4088d37e6` 合入的 `82c7e92ff`：任务面板与设置，64 张；
    - main `e64d0c72a`：961px 暗色 Wiki，1 张，差异低于阈值。
  - **b 类（迁移改动）10 张，只有 B1 一项**：P2.3 的 `57f792135` 改变了成功提示胶囊。涉及 profile-validation 6 张，以及 Chromium 的 settings-saved 4 张。这 4 张同时也有 a 类改动，两者在图上的区域不重叠，见「b 类」。
  - P1.1、P1.2、P2.1、P2.3 的其余提交、Select 快键修复和 P3.1 的全部提交，都没有改变任何 P0 截图。P2.2 交付合入后的全部变化都由 main 提交解释，P2.2 的组件提交本身在受检场景中没有改变截图。
- **B1 没有修，也没有登记为任何一类参考**，由修复任务 [34bQk0jlytjFYyi4OgLMK](orbit-task:34bQk0jlytjFYyi4OgLMK) 处理。
- **main 漂移参考层**（`reference/`）：只登记了 121 张 a 类截图。每张都在其最后一个 main 提交的树上生成，带来源提交、环境和 SHA-256。
- **已接受的迁移差异层**（`accepted/`）：机制、校验和登记规则已建好，与 main 漂移层分开存放、分开统计。每条必须引用协调者的 CONFIRM 判定，并带差异说明、同提交 before/after 原件和 SHA-256，缺任何一项整次运行失败。按协调者要求，本次没有登记任何条目。
- **不变的部分**：P0 回归默认对照 P0.2，只有登记过的截图才改为对照登记层。P0.2 的 252 张原图、原断言和 known-failures 标记都没有改。
- **`getByText` 偶发冲突已修复**：定位限定在可见的 Notifications 区内，断言的文字、精确匹配和可见性要求都没变。重复运行结果见「getByText 与读屏副本冲突」。

## 提交

| 提交 | 会话 | 内容 |
| --- | --- | --- |
| `c1cc446b0` | 第一个 | test：P0 设置、账号场景的保存提示改在 Notifications 区内定位（`page-scenarios.mjs`，2 处） |
| `503f4d5c2` | 第一个 | test：P0 回归改读 globalSetup 组装的期望截图。来源是 P0.2 原图，已登记的截图换成参考层；新增 `expected-screenshots.mjs`，配置改 3 行 |
| `edb3259af` | 第一个 | test：登记 121 张 main 漂移参考（`reference/`） |
| `88ba56756` | 本会话 | docs：第一个会话的 90 个证据文件，原样提交 |
| `99ec58928` | 本会话 | test：「已接受的迁移差异」层：`expected-screenshots.mjs` 增加该层的校验和计数，新增空的 `accepted/registry.json`、登记工具 `register-accepted.cjs` 和规则校验对照 `validator-checks.mjs` |
| 证据提交（两个） | 本会话 | 本目录其余文件和本 README；最后一个提交只加入合并检查记录 |

- **没动的 P0 文件**：除 `page-scenarios.mjs` 的 2 处定位外，P0 原测试文件都没有改：harness、fixtures、session-fixtures、session-scenarios、pages/states/breakpoints/known-failures/performance 测试、environment.mjs、collect-evidence.mjs。
- **回退**：各提交可以单独回退。回退 `99ec58928` 后回到只有 main 漂移层的状态；再回退 `503f4d5c2`，模板重新指向 P0.2 原图目录。

## 环境与方法

- **依赖与环境**：
  - 本树用 `bash scripts/worktree-overlay.sh` 按锁文件隔离安装。
  - 每个候选提交和临时树都在 `/var/tmp` 的独立工作树里准备依赖，再按 `pretest:ui-migration` 构建 shared 和 Web。
  - 所有浏览器运行都先由 P0 的 `environment.mjs` 与 [P0.2 environment.json](../p0.2/environment.json) 逐字段比较并通过：Debian 13.7、Node v26.10.0、npm 11.19.1、Playwright 1.63.0、Chromium 1243 / WebKit 2359、56 个字体文件及其 SHA-256。每次运行写出的 `environment.json` 都与 P0.2 记录逐字节相同（SHA-256 `fe69e824…`）。
  - 主机为 24 核、15 GB 内存，其他会话一直在占用，负载约 11–62。
- **P0 原测试**：
  - 归因运行器只用 P0.2 交付 `3e1d1ca08` 的 P0 文件，它们与 tip 同名文件逐字节相同；配置在 tip 上多了 testIgnore。
  - [drift.config.mjs](tools/drift.config.mjs) 在 P0 配置上只改三处：截图写入空的临时目录（`--update-snapshots=all`），输出改到运行目录，预览服务器在被测树的 `src/web` 里启动（仍是 P0 原命令 `npm run preview`）。
- **同源**：分享弹窗会显示 `location.origin`。临时树的运行都放进独立网络命名空间（`unshare -n`），因此都保持 P0 的 `http://127.0.0.1:4173`，几个运行可以并行而不用改端口。
- **截图对比**：逐张解码 PNG，分别记录两样东西：
  - 逐像素差异：像素数、单通道最大差、范围；
  - Playwright 比较器的结果：P0 选项 `maxDiffPixels: 0`、默认 threshold，这就是 P0 回归实际做出的判定。
- **候选提交**：项目分支从 P0.2 父提交 `f4d47e853` 到 tip 的 first-parent 历史共 38 个提交（P0.2 在项目线上的回放是 `6bbf3ecc3`）。
  - 19 个改动了 Web 构建输入（`src/web/src` 中的非测试/文档文件、index.html、shared 源码、锁文件等）。这 19 个都构建并比较了生产 dist，其中 16 个跑了完整 P0 截图矩阵。另外 3 个的 dist 与已跑提交逐文件相同，没有重跑：`3dd6e9b51` 与 `c500817e2` 相同，`81f15bef1`、`e207a13eb` 与 tip 相同。
  - `6bbf3ecc3` 与 `d66517339`、`31aa07c91` 与 `c500817e2` 的 dist 也相同，因并行都跑了，可作噪声对照。
  - 其余 19 个提交（含 tip 本身，tip 另跑了完整矩阵）只改了测试、文档或证据。事后也逐个构建，dist 都与 first-parent 前驱逐文件相同（[dist-check.txt](attribution/dist-check.txt)），因此不会改变任何截图。
- **二分**：
  - 某张截图在一个合并提交上变化时，沿该合并第二父提交的 first-parent 线继续向下找。必要时再下一层（main 内部的 `Merge origin/main into main`、P2.2 交付线），直到落在单个提交上。
  - 按场景分组二分，只跑受影响的场景，例如 `pages.browser.mjs -g 'session$'`。大区间用 [bisect-drift.py](tools/bisect-drift.py) 递归切分，两端渲染相同的区间不再拆分。
  - 每个结论都再在被归因提交和它的 first-parent 前驱上各跑一次完整 P0 矩阵，覆盖同组的断点截图。
  - [attribution.py](tools/attribution.py) 用已记录的运行逐条核对：前驱与区间起点相同；被归因提交改变了组内全部截图；区间终点与被归因提交相同。
- **运行记录**：共 83 次运行。每次的提交、命令、各次尝试、环境哈希和每张截图的 SHA-256 都在 [runs.json](attribution/runs.json)。

## Chromium 渲染噪声

在 P0.2 自己的提交 `3e1d1ca08` 上，同一环境重跑两次：
- WebKit 两次都与 P0.2 原图逐字节相同。
- Chromium 第一次有 21 张、第二次有 22 张与原图不同，两次之间也有 18 张不同。每张 1–89 像素，单通道最大差 4，全部通过 P0 比较器（[noise.json](attribution/noise.json)）。

dist 逐文件相同的两个提交之间也是这样，例如 `d66517339` 与 `6bbf3ecc3`，`c500817e2` 与 `31aa07c91`。所以 SHA-256 不同不代表页面改了。

**判定规则（只用于归因）**：截图满足任一项就算「变化」：
- P0 比较器不通过；
- WebKit 有任一像素不同；
- Chromium 单通道差超过 4，或超过 200 像素。

其余记为噪声。噪声只出现在 Chromium，位置和数量每次运行都不同，不会形成跨运行稳定的差异。P0 回归本身仍是原来的 `maxDiffPixels: 0` 和默认 threshold。

## tip 与 P0.2 的差异

tip 运行 `tip-a`（P0.2 原测试）共 252 张：113 张逐字节相同，139 张字节不同。字节不同的 139 张里，123 张不通过 P0 比较器，16 张低于阈值。

按归因汇总如下（C=Chromium，W=WebKit）。逐张的像素、单通道差、比较器结果、归因提交和当前对照层见 [per-screenshot.md](attribution/per-screenshot.md)。

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
| A4 | a | 任务面板与设置 64 张 | `8ef6b60d1` 合入 P2.2 交付 `orbit/p2-2-2e616a` | P2.2 线：P2.2 自身 4 个提交不变，`9ccb09e86` 不变 → `38947755e`（吸收 main `6cdca5a03`）改变 → `8a29e3493` 相同；main first-parent（43 个候选递归二分）：`14e64870f` 不变 → `4088d37e6` 改变 → `6cdca5a03` 相同 | main **`4088d37e6`**（Merge project/34Z2CCqHygFxrbqBlPljx into main），合入的唯一 Web 提交是 **`82c7e92ff`** feat(routing): gate model hint instructions on owner's smart model selection | 未开启 smart model selection（固定数据为关闭）时，任务面板不再显示 Suggested 行，下方内容上移（分享弹窗遮罩后同样可见）；设置页新增 Smart model selection 开关 |
| A5 | a | breakpoint-961-wiki C-dark-desktop 1 张 | `8ef6b60d1` | P2.2 线：`9ccb09e86` → `38947755e` 改变；main first-parent（递归二分）：`5bc8c9d63` 不变 → `e64d0c72a` 改变 → `6cdca5a03` 相同 | main **`e64d0c72a`** feat(web): let the desktop Wiki home fill the main region | 目录当前项「Home」的图标、文字和底色合成差 1 个色阶（210 像素，单通道差 ≤1，低于阈值） |
| B1 | b | profile-validation 6 张、settings-saved C 4 张 | **`57f792135`** fix(web): preserve notification motion and hover across modal changes（P2.3） | 项目线：`e361ee373` 不变（与 `57f792135` 之间只有测试/文档提交）→ `57f792135` 改变 → `6d2156683` 相同 | 迁移提交 `57f792135` | 见下节 |

A1–A5 的 main 提交都在 `origin/main` 上，都不是本项目的晋升合并。会话组的两个提交中，`918034e72` 是 `f5bdd7fd3` 的祖先。

每个归因的同环境证据：
- 代表截图的前后对照和差异图：[attribution/images](attribution/images/)（[索引](attribution/images/index.json)）；
- 全部截图的 SHA-256：[runs.json](attribution/runs.json)；
- 二分过程：[changepoints-project-line.json](attribution/changepoints-project-line.json)、[changepoints-p2.2-line.json](attribution/changepoints-p2.2-line.json)、[任务/设置二分](attribution/bisect-main-6cdca5a03-task-settings.json)、[Wiki 二分](attribution/bisect-main-6cdca5a03-wiki961.json)；
- 每步核对：[attribution.json](attribution/attribution.json)，输入为 [changes.json](attribution/changes.json)。

## b 类：迁移造成的差异（本任务不修，也不登记）

**B1：P2.3 `57f792135` 之后，设置、账号页成功提示胶囊（「Setting saved」「Name saved」）的绘制与 P0.2 不同。** 修复由 [P2.3 回归修复：成功提示胶囊的合成层与手机宽度（B1）](orbit-task:34bQk0jlytjFYyi4OgLMK) 负责。

**像素**（同环境的 `e361ee373` → `57f792135`）：

| 截图 | 项目 | 像素 | P0 比较器 |
| --- | --- | --- | --- |
| profile-validation | C-dark-desktop / C-light-desktop / C-light-phone / C-dark-phone | 508 / 495 / 316 / 313，单通道差 88 / 113 / 60 / 48 | 前 3 个失败，C-dark-phone 低于阈值 |
| profile-validation | W-light-phone / W-dark-phone | 4863 / 3994，单通道差 224 / 167 | 失败 |
| settings-saved | C-light-desktop / C-light-phone / C-dark-phone / C-dark-desktop | 97 / 1418 / 1309 / 97 | 前 3 个失败，C-dark-desktop 低于阈值 |

WebKit 桌面的两张截图，以及 WebKit 的 settings-saved，都没有变化。

**差异区域**（[B1-regions.json](b-class/B1-regions.json)，相邻 6 像素内的差异像素合为一块）：变化只在提示胶囊及其阴影处。胶囊在桌面约为 x 1119–1264、y 16–52，在手机约为 x 123–263、y 56–92。阴影为 `0 8px 22px`，向外约 30 像素。
- Chromium 桌面：差异集中在胶囊文字处（x 1165–1247、y 28–39，约 490 像素）；
- Chromium 手机：差异在文字和右端阴影处；
- WebKit 手机：胶囊和阴影整体右移 4 像素，形成两块约 141×78 和 57×78 的差异。

另有个别 3–7 像素的小块不在胶囊处，是 Chromium 噪声水平。

**计算样式与几何**：截图时刻取值，记录 `e361ee373`、`57f792135` 和 tip 三棵树、8 个项目、两个场景，全部数据在 [B1-success-pill.json](b-class/B1-success-pill.json) 的 `computedStyles`：

| | `e361ee373`（P2.3 返工前） | `57f792135` 及 tip `da13423d3` |
| --- | --- | --- |
| 胶囊 `will-change` | `auto` | `transform`（新的合成层） |
| 宿主 | `body` 下的普通流 | `div.toast-layer[popover=manual]`，处于 top layer |
| 通知区内联样式 | 无 | 桌面 `left: calc(…)`；手机 `width: calc(390px - 32px - env(…))` |
| Chromium 胶囊和文字矩形 | 如桌面 settings-saved 卡片 x=1118.969、宽 145.031 | 完全相同：差异只来自合成层重新栅格化 |
| WebKit 手机 profile 页通知区宽 | 350px（CSS 算出），卡片 x=123.141 | 358px（内联宽度），卡片 x=127.141（右移 4px） |
| WebKit 手机 settings 页通知区宽 | 358px | 358px（不变，所以 settings-saved 不变） |

**诊断**（只在临时树里做，不交付）：
- E1：只去掉 `.toast` 的 `will-change: transform`。Chromium 的 profile-validation 回到 P0.2 噪声水平（5–45 像素，差 ≤1），Chromium 的 settings-saved 对照参考层通过 P0 比较器；WebKit 手机仍不同。
- E2：在 E1 基础上，内联宽度/left 只在模态接管通知时使用（即 `57f792135` 之前的条件，[补丁](b-class/exp-e2-no-width-override.diff)）。全部 16 张都通过 P0 比较器：profile-validation 对照 P0.2，settings-saved 对照参考层。

在只打了 E2 补丁的临时树上跑完整 P0 回归，结果为 0 失败，见「验证」。E2 只是诊断，不是建议实现：修复时还需要满足 P2.3 自己的模态/抽屉通知用例，去掉 `will-change` 也可能影响 P2.3 当初要修的 top layer 圆角抗锯齿。

**settings-saved 上 main 改动与 B1 的区分**（[B1-regions.json](b-class/B1-regions.json) 的 `settingsSaved_separation`）：
- 参考层里登记的 settings-saved 是 A4 的 main 改动（设置页新增 Smart model selection 开关，下方各行下移）。它在 `4088d37e6` 的树上生成，那时还没有 P2.3 晋升（`90e749e72`），所以胶囊仍是旧样式。
- 8 个项目上，P0.2 原图 → 参考图的差异都在设置卡片各行（桌面 y 249–874、手机 y 484–809）；参考图 → tip 的差异只在胶囊处（桌面 y 31–42、手机 y 40–124），WebKit 为 0 像素。两块区域不重叠。
- 所以参考层只登记了 main 部分。B1 是叠在它上面的迁移差异，在 tip 上继续被检出：Chromium 3 张失败，C-dark-desktop 低于阈值。B1 修复后，这 4 张应与参考图一致。

**出处与判断**：
- P2.3 [第2版说明](../p2.3/revision-2/README.md) 写明了两项改动的意图，都是与原图一致：加合成层是为了「修正顶层绘制导致 Chromium 圆角边缘的抗锯齿差异」，持久测量节点是为了保持手机宽度。
- 当时的对照只覆盖了错误卡片、夹具场景和 8 个生产通知组合，没有重跑 P0 设置/账号页。P2.3 三版证据都写明「完整 P0 矩阵未重跑」，协调者据以判定的证据没有覆盖 P0 页面上的这项差异。
- 所以这是**无意的保真偏差**，不是有意的保真修正，不能登记为 main 漂移，也不符合「已接受的迁移差异」的条件。

## main 漂移参考层

**位置**：[reference/registry.json](reference/registry.json) 和 `reference/screenshots/{project}/{name}.png`，共 121 张。

| 组 | 截图 | 张数 | mainCommits | 生成树（generatedFrom） |
| --- | --- | ---: | --- | --- |
| 会话列表行 | session-idle、session-streaming、session-composer-focus、session-attachment-menu、session-attachment-staged、notification-error、breakpoint-961-session（4 个桌面项目） | 28 | `918034e7…`、`f5bdd7fd…` | `f5bdd7fd3`（运行 full2-f5bdd7fd3） |
| 项目页 | project-overview、project-graph（8 项目），project-graph-fullscreen、breakpoint-639/641-graph（桌面） | 28 | `93d3ec58…` | `93d3ec580`（full2-93d3ec580） |
| 任务面板与设置 | task-detail、task-action-hover/focus/menu、task-share-dialog、settings、settings-saved（8 项目），breakpoint-599/601-dialog（桌面） | 64 | `4088d37e…` | `4088d37e6`（full2-4088d37e6） |
| Wiki 961px 暗色 | breakpoint-961-wiki（chromium-dark-desktop） | 1 | `e64d0c72…` | `e64d0c72a`（m5-e64d0c72a） |

**每条登记的字段**：

| 字段 | 内容 |
| --- | --- |
| `screenshot` | 截图名 |
| `sha256` | 参考图哈希 |
| `p0Baseline` | 被替换的 P0.2 原图哈希 |
| `mainCommits` | 完整提交号，按时间先后 |
| `generatedFrom.commit` | 等于最后一个 main 提交 |
| `generatedFrom.environment` | 生成运行的 environment.json 哈希，等于 P0.2 记录 `fe69e824…` |
| `generatedFrom.run` | 生成运行的标签 |
| `projectLine` | 吸收它的项目线提交 |
| `group`、`change` | 所属组和归因编号 |

**生成方式**：
- 参考图来自在该 main 提交的树上用 P0 原测试和固定数据跑出的截图（[make-reference.py](tools/make-reference.py)），没有任何加工。
- 这些 main 树都在 P2.3 晋升（`90e749e72`）之前，不含 B1。
- 会话组的生成树 `f5bdd7fd3` 含 P1.1/P1.2 的晋升，项目页的 `93d3ec580` 含 P2.1 的晋升。这些晋升提交本身经过同样的运行，确认没有改变对应截图。

**未登记**：B1 独有的 profile-validation 6 张，以及其余 125 张，仍然对照 P0.2。

## 「已接受的迁移差异」层

迁移批次可能按设计改变 P0 截图，且这项改变已被协调者在该批证据里判定接受。例如 P3.2 让 task 场景有 8 个用例按设计不同：More 菜单和分享对话框的焦点约定，以及 WebKit 下 Share… 图标约 30 像素的行高精度差。这类差异不是 main 漂移，不能进参考层；也不是缺陷，不该靠人逐条解释。这一层专门收它们。

- **位置**：与 main 漂移层分开，三处：
  - [accepted/registry.json](accepted/registry.json)，本次为空；
  - `accepted/screenshots/{project}/{name}.png`：接受后的期望图，即同提交对照的 after 原件；
  - `accepted/before/{project}/{name}.png`：同提交对照的 before 原件。
- **组装顺序**：P0 回归先取 P0.2 原图，再用 main 漂移层替换登记的截图，最后用这一层替换登记的截图。同一张截图可以先有 main 漂移参考，再叠一条已接受的迁移差异。
- **分开统计**：运行输出一行分别报三类数量，如 `P0 expected screenshots: 131 P0.2 originals, 121 main drift references, 0 accepted migration differences.`。`.ui-migration-results/expected-screenshots/sources.json` 逐张写出来源层；已接受的截图还带 `replaces` 和 `decision`。
- **每条登记的字段**：

| 字段 | 内容 | 校验（`expected-screenshots.mjs`，每次运行） |
| --- | --- | --- |
| `screenshot` | P0 截图名 | 必须是 252 张之一，同一张只能登记一次 |
| `replaces` | 被替换的当前期望：`layer`（`p0.2` 或 `p0-drift`）和 `sha256` | 必须等于前两层组装出的期望；该期望之后若变化（例如 main 漂移参考被更新），条目随即失效，运行失败，直到重新登记 |
| `decision` | `taskId`、`evidenceRevision`、`evidenceDigest`、`verdict`、`document` | `verdict` 必须是 `CONFIRM`，任务 id、正整数版本号、64 位十六进制摘要缺一不可，`document`（批次证据文档，相对本证据根目录）必须存在 |
| `difference` | 差异说明，与批次证据一致 | 不能为空 |
| `sameCommit` | `before` / `after` 的完整提交号和原件 SHA-256，`environment` | 两个提交号都是 40 位；环境哈希等于 P0.2 environment.json；`after.sha256` 等于登记的期望图且不同于 `before.sha256`；两张原件文件的哈希与登记一致 |
| `sha256` | 期望图（即 after 原件）哈希 | 文件哈希一致 |
| `previous` | 同一截图早先的接受记录（由登记工具写入） | 不参与校验，保留判定链 |

`accepted/screenshots` 和 `accepted/before` 里出现未登记的 PNG 时，整次运行失败。

- **登记工具** [register-accepted.cjs](tools/register-accepted.cjs)：在要写登记的工作树里运行，参数为判定引用、before/after 两次运行的截图目录与环境记录、差异说明和截图清单。工具会做三项检查，任一不满足就拒绝登记：
  - 两次运行都在 P0.2 环境中；
  - before 原件在 P0 比较器下复现回归当前的期望，证明批次起点没有别的差异；
  - after 原件与 before 不一致。

  检查通过后复制两张原件、写入条目，同一截图的旧条目移入 `previous`。

## 维护规则

### 共同规则

1. **P0.2 不动**：P0.2 原图、原断言、known-failures 标记永不修改。不放宽 `maxDiffPixels` 或 threshold；不在 known-failures 里登记漂移或迁移差异。不用 `--update-snapshots` 写任何一层：运行时只写 `.ui-migration-results/expected-screenshots/` 副本，P0.2 原图和两层登记都不会被写。
2. **一条登记管一张截图**：每条登记只替换一张截图的期望。登记以独立提交只改对应层的 `registry.json` 和图片，并更新本 README 的清单段落，可单独回退。
3. **自动校验**：校验在每次 P0 运行的 globalSetup 中执行，任何一项不符，整次运行在测试开始前失败。
4. **噪声不进判定**：归因用的噪声规则只用于分析，不用于回归判定。经确认的有意设计变更走「已接受的迁移差异」，不进 main 漂移层。

### main 漂移参考（`reference/`）

1. **只收什么**：截图相对 P0.2 的全部差异都归因到 main 的产品提交，这些提交经吸收或晋升进入项目线。
2. **何时登记**：两种情况要处理：
   - 项目分支吸收 main 之后（`Merge refs/heads/main into refs/heads/project/…`，或经交付分支吸收）；
   - 某批运行 P0 回归时，出现与本批改动无关的截图失败。

   要在下一批用 P0 做前后对照之前完成，最晚在 P7.1 之前。每张失败截图要么登记为 main 漂移，要么作为迁移缺陷修复。
3. **由谁登记**：
   - 发现者记录失败和起点提交，交给项目协调者。
   - 协调者另建「P0 漂移登记」任务（类似本任务）。该任务的执行会话完成归因和登记，以独立提交只改 `reference/`，并更新本目录文档。
   - 协调者按 EVIDENCE_JUDGMENT 独立判定后再落地。
   - 迁移任务的会话不能在自己的交付里登记自己页面的漂移，以免自证。
4. **凭什么证据**，缺一不可：
   - (a) 沿项目分支 first-parent 历史，定位到使该截图变化的项目线提交。
   - (b) 该提交是吸收 main 的合并时，沿其第二父的 first-parent 线下钻到单个 main 提交 X。要有同环境运行证明：X 的 first-parent 前驱不变、X 改变、区间终点与 X 相同。
   - (c) X 在 `origin/main` 上，不是本项目的晋升合并（`Merge refs/heads/project/34ZZeq0e3IR65GVm2kAs7 into refs/heads/main`），变化来自产品代码而不是迁移代码。
   - (d) X 的树里没有影响该页面的迁移改动：项目线扫描表明，在 X 被吸收之前，没有迁移提交改变过该截图；若有，看是否已晋升进 main：
     - X 的树含该晋升迁移代码，且这项改动没有被接受：该截图不能登记，先修迁移差异；
     - X 的树含该晋升迁移代码，且这项改动已登记为已接受的迁移差异：不更新 main 漂移层，按下节第 6 条第二种情况重登那条已接受的登记。
   - (e) 参考图用 X 的树（有多个 main 提交时用最后一个）、P0 原测试和固定数据，在 P0.2 环境中生成。环境记录哈希等于 P0.2 environment.json，并按上表字段写入 registry。
   - (f) 登记后在当时的项目 tip 上跑 P0 回归，证明该截图与参考层一致。
5. **迁移改动永远不能登记为漂移**：以下改动对页面造成的任何变化，都只能修复或走「已接受的迁移差异」，不能登记为漂移：
   - P1–P7 各任务的提交；
   - 晋升合并带回的迁移代码；
   - 迁移组件、主题、foundation CSS、通知、弹层。

   同一截图同时有 main 改动和迁移改动时，只登记 main 部分，参考图在不含该迁移改动的 main 树上生成。迁移部分继续失败，直到修复或被接受，如本次 Chromium 的 settings-saved。
6. **main 再次改动已登记的页面**：
   - 按同一流程处理：在 `mainCommits` 末尾追加新提交，`generatedFrom` 改为新提交，参考图以单独提交替换，旧图保留在 git 历史里。
   - 若该截图在 `accepted/` 里也有登记，那条登记的 `replaces` 随之不再匹配，运行失败，直到按下节第 6 条第一种情况重新登记。

### 已接受的迁移差异（`accepted/`）

1. **只收什么**：两个条件都满足：
   - 某个迁移批次按设计改变了 P0 截图；
   - 协调者对该批证据作出了 CONFIRM 判定，而且这一版证据逐张列出了这些截图、差异说明和同提交对照。

   以下几种一律不收：
   - 没有判定引用的差异；
   - 只有 SEND_BACK 或尚未判定的证据；
   - 判定没有覆盖的差异，例如 B1：P2.3 的 CONFIRM 证据没有覆盖 P0 页面上的这项差异；
   - 未落地的批次；
   - main 漂移、噪声和缺陷。
2. **由谁、何时登记**：
   - 由批次任务在该批落地到项目分支之后登记：在批次的后续提交里，或协调者为它另建的登记任务里。
   - 要在下一批用 P0 做前后对照之前完成，最晚在 P7.1 之前。
   - 登记是独立提交，只改 `accepted/` 和本 README 清单。
3. **凭什么证据**，缺一不可：
   - (a) 协调者对批次证据的 CONFIRM 判定：任务 id、证据版本号与 `evidenceDigest`（`task_evidence_list` 返回的那一版），以及批次证据文档的路径。
   - (b) 同提交对照：
     - 在批次起点和交付提交上，用 P0 原测试和固定数据各跑一次（P3.1 的方法，[same-commit-originals.sh](tools/same-commit-originals.sh)），截图写入临时目录；
     - 两次运行的环境记录都等于 P0.2；
     - before 原件在 P0 比较器下复现当前期望；
     - after 原件就是登记的期望图。
   - (c) 差异说明，与批次证据中协调者看到的内容一致。
   - (d) 用 [register-accepted.cjs](tools/register-accepted.cjs) 写入，不手改哈希。
   - (e) 登记后在当时的项目 tip 上跑 P0 回归，证明登记的截图与接受后的期望一致，其余结果不变。
4. **协调者复核**：
   - 在 `task_evidence_list` 中核对版本号和摘要，确认该版判定为 CONFIRM，且证据列出了这些截图；
   - 核对 after 提交已落地在项目线上，before 是该批起点；
   - 核对登记提交只改了 `accepted/` 与 README 清单；
   - 看 (e) 的回归报告。
5. **后续批次再改同一截图**：用新批次的同提交对照和 CONFIRM 判定重新登记。before 应复现现有的接受后期望，旧条目移入 `previous`。
6. **main 又改了已有已接受登记的页面**：由「P0 漂移登记」任务处理。新的期望图同时包含 main 改动和已接受的迁移差异，分两种情况：
   - **X 的树不含该页面的迁移代码**（迁移尚未晋升进 main）：
     - 先按 main 漂移规则，在 X 的树上更新 main 漂移参考。这时已接受条目的 `replaces` 不再匹配，运行失败。
     - 再重做同提交对照：before 用 X 的树，复现新的 main 漂移参考；after 用吸收 X 的项目线提交，同时含 X 和已接受的迁移改动。
   - **X 的树已含该页面的已接受迁移代码**（迁移已晋升进 main）：
     - 不更新 main 漂移层。
     - 同提交对照的 before 用 X 的 first-parent 前驱树，它要复现当前已接受的期望；after 用 X 的树。差异说明写明这是叠在已接受差异上的 main 改动 X，并附 X 的归因证据（main 漂移规则 (a)–(c)）。

   两种情况的共同要求：登记任务提交证据，协调者 CONFIRM 后按第 3 条重登，引用这次的判定，旧判定移入 `previous`。不能只改哈希或只换图。

## getByText 与读屏副本冲突

**原因**：
- `lib/toast.tsx` 的 `announce()` 会在提示出现 50ms 后，把同样的文字写进 body 下的读屏 live region（`div.sr-only[aria-live]`）。
- P0 的 `getByText('Setting saved' / 'Name saved', {exact:true})` 在这之后被轮询到时，会匹配到两个元素，触发严格模式失败。
- 这在 P0.2 时已经存在，主机负载越高越容易出现。

**确定性诊断**：[announce-duplicate.browser.mjs](flake/announce-duplicate.browser.mjs) 先等 live region 写入，再分别检查两种定位。在 P0.2 `3e1d1ca08` 和 tip `da13423d3` 的 8 个项目上都复现了（[记录](flake/announce-duplicate-diagnostic.json)）：
- 原定位匹配 `div.sr-only` 和 `.toast-head` 两个元素，`toBeVisible` 报严格模式违例；
- 新定位只匹配 Notifications 区内的 `.toast-head`，判定可见。

**修复**（`c1cc446b0`）：两处都改为 `page.getByRole('region', { name: 'Notifications', exact: true }).getByText(…, { exact: true })`。
- 仍要求同样的文字、精确匹配并可见，只是范围从全页收紧到可见的通知区。
- 没有删减断言，没有加重试，也没有延长超时。
- session 场景本来就是这样定位错误通知的。

**重复运行**：settings、profile 两个场景 × 8 个项目 × `--repeat-each=25`，每次 400 次执行。截图写入临时目录（`--update-snapshots=all`），所以只有定位、固定数据和页面异常会导致失败。两次运行都用 [same-commit-originals.sh](tools/same-commit-originals.sh)，在 `99ec58928` 的生产构建上同时跑，只差定位：
- 修复后的定位，在 `99ec58928` 上：**400/400 通过，0 失败**，0 flaky；
- 原定位，在 `99ec58928` 上回退 `c1cc446b0` 的临时提交 `f4ab002a4` 上：339 通过、**61 失败**，全部是读屏副本造成的严格模式违例（`getByText(…) resolved to 2 elements`）：WebKit 46 次、Chromium 15 次；settings 42 次、profile 19 次，没有其他失败。

汇总见 [stability-final.json](flake/stability-final.json)，由 [stability-summary.py](tools/stability-summary.py) 生成。

第一个会话的结果（[stability.json](flake/stability.json)、[统计](flake/attribution-runs-flake-stats.json)）：
- 修复后 400/400 通过；
- 原定位的对照被 runner 清理中断在约 303 次，期间 9 次严格模式失败；
- 归因运行全部使用原定位，690 次执行中有 71 次同类失败（10.3%），没有其他失败。

本会话的两轮正式回归、负对照和中和运行都带着修复后的定位，没有出现任何定位失败。

## 负对照

验收要求两类登记都能证明：未登记的改动会失败；已登记的截图上超出登记内容的新改动也会失败。
- 全部在临时树上做。临时树是本分支 `99ec58928` 的独立工作树，改动以临时提交固定，不交付。
- 跑的都是 P0 原命令 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web`，用 [netns-regression.sh](tools/netns-regression.sh) 放在独立网络命名空间里。
- 所有运行都带着未修的 B1，所以结果里都有 B1 的失败，下表单独列出。

| 对照 | 改动 | 被测截图当时的期望 | 结果 | 记录 |
| --- | --- | --- | --- | --- |
| **main 漂移层：已登记截图上超出登记内容的改动** | 设置页第一张卡片 `marginBottom: 16 → 17`（[patch](negative-control/main-drift-1px/patch.diff)）；settings.png 8 张都登记了 A4 的 main 漂移参考 | main 漂移参考 | settings.png **8/8 失败**，1548–4281 像素。没有补丁时，同一批截图在两轮正式回归中全部通过。另有 B1 的 profile-validation 5 个失败；settings-saved 不再单独计数，因为 settings 用例停在第一张截图。合计 72 通过、16 预期失败、11 跳过、13 失败 | [main-drift-1px](negative-control/main-drift-1px/summary.json) |
| **P0.2 层/main 漂移层之外：未登记的改动** | 分享页头 `padding: 12px 20px → 13px 20px 12px`（C3，[patch](negative-control/accepted/patches/c3-unregistered-share-1px.diff)）；这些截图在两层都没有登记 | P0.2 原图 | 4 个桌面项目的 task-public-share 和 breakpoint-601-share **全部失败**（5326–6090 像素）。手机项目和 599px 不受影响：≤600px 时 index.css 的 `padding: 10px 14px` 覆盖该规则，截图不变，照常通过 | 与下一行同一次运行 |
| **已接受层：已登记截图上超出登记内容的改动** | 在已登记的 C1 上再把 `outline-offset: -2px → -3px`（C2，[patch](negative-control/accepted/patches/c2-beyond-registered-1px.diff)） | 已接受的期望（8 张） | project-graph-fullscreen **8/8 失败**（2279–7644 像素）。本行与上一行合计 61 通过、16 预期失败、11 跳过、24 失败（8 + 8 + B1 8） | [run-beyond-and-unregistered](negative-control/accepted/run-beyond-and-unregistered/summary.json) |
| **已接受层：同一改动未登记时** | 全屏依赖图画布加 2px 描边（C1，`.tdg-modal .tdg-full-canvas`，[patch](negative-control/accepted/patches/c1-accepted-fullscreen-outline.diff)），不登记 | 4 张桌面为 main 漂移参考，4 张手机为 P0.2 | project-graph-fullscreen **8/8 失败**，其余只有 B1 的 8 个；合计 69 通过、16 预期失败、11 跳过、16 失败 | [run-unregistered](negative-control/accepted/run-unregistered/summary.json) |
| 已接受层：登记后（正对照） | 同一 C1，用 [register-accepted.cjs](tools/register-accepted.cjs) 按规则登记 8 条（[临时 registry](negative-control/accepted/scratch-registry.json)）；判定引用是临时替身 [DECISION-STAND-IN.md](negative-control/accepted/DECISION-STAND-IN.md)，不是 Orbit 判定 | 已接受的期望（4 条叠在 main 漂移参考上，4 条替换 P0.2） | 运行输出 `127 P0.2 originals, 117 main drift references, 8 accepted migration differences`；8 张全部通过，其余与正式回归相同：77 通过、16 预期失败、11 跳过，失败只有 B1 的 8 个 | [run-registered](negative-control/accepted/run-registered/summary.json) |
| 两层的登记规则 | 在临时副本里逐条破坏登记，共 22 种：缺判定、非 CONFIRM、缺版本号或摘要、版本号为 0、缺任务 id、证据文档不存在、缺差异说明、`replaces` 指向错误的层或过期的期望、提交号不完整、环境不符、期望图不是 after 原件、before 与 after 相同、登记后改了期望图或 before 原件、同一截图登记两次、不是 P0 截图、两层目录里有未登记文件、main 漂移参考图被改 | — | **22/22 在 globalSetup 被拒**，报出被违反的那一条；合法的对照组装成功，有 2 条已接受登记（各叠在一层上） | [validator-checks.json](negative-control/validator-checks.json) |
| B1 本身 | 真实的迁移差异，没有登记在任何一层 | profile-validation 为 P0.2；settings-saved 为 main 漂移参考 | 两轮正式回归里，profile-validation 5 张对照 P0.2 失败（未登记的改动）；settings-saved 3 张对照 main 漂移参考失败（已登记截图上超出登记内容的改动） | [final-round-1](checks/final-round-1/summary.json)、[final-round-2](checks/final-round-2/summary.json) |

已接受层用到的同提交原件：
- before 在 `99ec58928` 上生成，after 在 C1 的临时提交 `4103f361f` 上生成，都只跑 projects 场景（[originals](negative-control/accepted/originals/)），两次的环境记录都等于 P0.2。
- before → after 只有 project-graph-fullscreen 8 张不通过比较器；另有 2 张各 4–6 像素的 Chromium 噪声通过比较器。
- C1 第一次写在 `.tdg-canvas, .tdg-full-canvas` 的共用规则里，连带改变了页内依赖图。为了让改动只落在一张截图上，改为 `.tdg-modal .tdg-full-canvas` 后重新生成原件。

临时树的提交见 [trees.json](negative-control/accepted/trees.json)。

## 验证

本会话在本分支 `99ec58928` 上运行（之后的提交只增加证据文件，见「边界」）：

| 检查 | 结果 | 记录 |
| --- | --- | --- |
| P0 回归第 1 轮 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web` | 共 112 个测试：77 通过（69 个 P0 正常、8 个 P2.3 feedback-production）、16 个已知焦点预期失败、11 跳过、**8 失败**、0 flaky。退出码 1 | [summary](checks/final-round-1/summary.json)、[report](checks/final-round-1/report.json)、[输出](checks/final-round-1/command-output.txt)、[sources](checks/final-round-1/sources.json)、[失败截图](checks/final-round-1/failures/) |
| P0 回归第 2 轮（同一命令，紧接其后） | 与第 1 轮完全相同：112 个测试逐个状态一致；8 个失败是同一组，Playwright 报告的差异像素数逐个相同。退出码 1 | [checks/final-round-2](checks/final-round-2/summary.json)、[两轮对照](checks/final-rounds-compare.json) |
| 只中和 B1 的临时树：`99ec58928` + E2 补丁（[patch](b-class/neutralized-final/patch.diff)，临时提交 `bbe3b275e`，不进交付分支） | 完整回归 101 通过（85 正常 + 16 预期失败）、11 跳过、**0 失败**、0 flaky，退出码 0 | [b-class/neutralized-final](b-class/neutralized-final/summary.json) |
| 负对照 | 见上节 | negative-control/ |
| getByText 稳定性 | settings/profile × 8 项目 × 25 次：修复后的定位 400/400 通过；原定位在同一构建上 61/400 失败，全部是读屏副本的严格模式违例 | [flake/stability-final.json](flake/stability-final.json) |
| 项目合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web` | 通过，退出码 0：`tsc -b && vite build` 成功（保留原有大 chunk 提示）；Vitest **323 个文件、4065 个用例全部通过**，用时 297 秒。运行于 `c2557f75d`，即包含全部代码和本目录其余证据的提交；[过滤后的输出](checks/merge-check-final.txt)保留完整构建输出和 Vitest 的结果、汇总行，去掉了用例运行中打印的控制台告警，完整输出由 Orbit 按任务行保存 | [checks/merge-check-final.json](checks/merge-check-final.json) |

**两轮的 8 个失败**全部发生在截图断言上，没有定位失败，都是 B1。差异像素数取自 Playwright 报告，两轮相同：
- settings-saved.png 对照 main 漂移参考：C-light-desktop 10、C-light-phone 135、C-dark-phone 95；
- profile-validation.png 对照 P0.2：C-light-desktop 83、C-light-phone 22、C-dark-desktop 18、W-light-phone 376、W-dark-phone 339。

**其余结果都是已记录的处置**：
- 其他截图与 P0.2 原图或 main 漂移参考一致；
- 原 16 个已知焦点预期失败都按预期失败，没有出现 unexpected pass；
- 原 11 个跳过：7 个非参考项目的性能采样、4 个手机项目的桌面断点巡检；
- P2.3 新增的 8 个 feedback-production 通过。

两轮都先通过了 P0.2 原图哈希、两层登记和环境的校验，运行输出为 `P0 expected screenshots: 131 P0.2 originals, 121 main drift references, 0 accepted migration differences.`；环境记录与 P0.2 逐字节相同。

第一个会话在 `edb3259af`（没有已接受层）上做过同样的检查，结果一致，保留在 [checks/tip-regression-1](checks/tip-regression-1/summary.json)、[tip-regression-2](checks/tip-regression-2/summary.json)、[negative-control/run](negative-control/run/summary.json)、[b-class/demo-b1-neutralized](b-class/demo-b1-neutralized/summary.json) 和 [checks/merge-check.json](checks/merge-check.json)：两轮各 8 个相同的失败，负对照 8/8 失败，中和后 0 失败，合并检查通过（Vitest 323 个文件、4065 个用例）。

## 边界

- **B1**：B1 修复前，P0 回归不会全绿。按协调者的决定，本任务的验收是「失败只限 B1 的 8 个用例、两轮一致、中和后 0 失败」；全绿由修复任务 [34bQk0jlytjFYyi4OgLMK](orbit-task:34bQk0jlytjFYyi4OgLMK) 在含参考层和修复的 tip 上确认。B1 修复后，Chromium 的 settings-saved 4 张应与 main 漂移参考一致，profile-validation 6 张应与 P0.2 一致；这需要修复任务实际重跑，本证据不能代替。
- **运行时的提交**：正式回归、中和、负对照都在 `99ec58928` 上运行；之后的提交只在本目录增加证据文件，不改 `src/`、`reference/` 和 `accepted/`。核对办法：`git diff --stat 99ec58928..HEAD -- src docs/evidence/base-ui-migration/p0-drift/reference docs/evidence/base-ui-migration/p0-drift/accepted` 输出为空。合并检查在 `c2557f75d`（全部代码和本目录其余证据；之后只加入合并检查记录） 上运行。
- **已接受层的判定引用**：校验检查判定引用的形式和批次文档是否存在，不能离线查询 Orbit，所以判定是否真实存在由协调者复核时核对（规则第 4 条）。负对照里的登记用的是临时替身判定，只在临时树中存在。
- **噪声包络**：归因判定依赖实测的噪声包络（Chromium 单通道差 ≤4 且 ≤200 像素）。A5 的差异（210 像素、单通道差 1）超过了像素数上限。在 8 次独立运行中（main 上 2 次、P2.2 线 2 次、项目线 4 次），这块区域的位置和每个像素值都完全相同，因此判为确定差异。
- **只跑受影响场景的部分**：main 线和 P2.2 线只跑了受影响的场景，完整矩阵只在被归因提交和它的前驱上跑。P2.2 自身提交只检查了任务、设置和 Chromium 暗色桌面断点场景；它们对其余截图的净影响，已由项目线 `8ef6b60d1` 的完整矩阵覆盖，变化全部由 A4/A5 解释。
- **E1/E2 只是诊断**：没有验证 P2.3 自己的模态、抽屉通知用例。
- **负载**：
  - 主机在本会话期间负载约 11–42，有其他会话的 vLLM 进程占用。
  - 1px 负对照第一次运行时有 4 个回归并行，多出一个与改动无关的失败：WebKit 明亮桌面断点用例在项目页等 `.pdg-task-title` 出现 3 个时超时（15 秒内为 0 个）。该运行的 trace 有 240 个请求，全部成功，没有控制台错误；页面快照里依赖图的 3 个节点已经渲染，是负载下渲染慢于等待时限。
  - 降低并行后重跑，只有预期的 13 个失败。两次都保留在 [main-drift-1px](negative-control/main-drift-1px/)。
- **临时路径**：`tools/` 里的脚本多数写着 `/var/tmp/p0drift`、`/var/tmp/p0drift-s2` 等临时路径和当时的工作树路径，复跑时需要按环境调整。
- **其余边界同 P0.2**：Linux 固定环境、合成 REST/SSE、非真机 iOS。

## 复跑

```sh
bash scripts/worktree-overlay.sh
NO_COLOR=1 npm run test:ui-migration -w @orbit/web     # 现在：失败只有 B1 的 8 个
npm run build -w @orbit/web && npm run test -w @orbit/web
node docs/evidence/base-ui-migration/p0-drift/tools/validator-checks.mjs "$PWD" /tmp/p0-validator-checks
```

工具都在 [tools/](tools/)：
- 接手复核：`verify-inherited.py`（登记）、`attribution.py`（归因）、`per-screenshot.cjs <tip 截图目录> <json> <md>`（逐张表）；
- 归因：`prepare-tree.sh`、`run-matrix.py`、`bisect-run.sh`、`bisect-drift.py`、`changepoints.cjs`、`pairdiff.cjs`、`dist-check.sh`；
- 参考层：`make-reference.py`（main 漂移）、`same-commit-originals.sh` + `register-accepted.cjs`（已接受的迁移差异）；
- 临时树与对照：`scratch-worktree.sh <名> <提交> [补丁…]`、`netns-regression.sh <树> <输出>`、`summarize-report.py`、`regions.cjs`、`b1-regions.py`。

单次排查可以用 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web -- pages.browser.mjs --project=chromium-light-desktop`。`.ui-migration-results/expected-screenshots/sources.json` 会列出每张期望图来自哪一层。
