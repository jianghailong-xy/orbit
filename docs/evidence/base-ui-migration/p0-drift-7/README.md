# P0 漂移登记（第 7 批）：Infrastructure 侧栏、回合脚注与输入框渐隐，以及 P4.2 用例的导航

本目录服务于任务 [P0 漂移登记（第 7 批）：桌面侧栏合并为 Infrastructure，并维护 P4.2 用例的导航](orbit-task:34cswWfvNasFTq8kDM0Q4)，对应项目验收条目 key `5wbhutjez7Qv5GCTNLb0P7`：**P7：完整迁移通过最终构建、行为与视觉回归，并有实测收益和可回退交付记录。**

按 [p0-drift README](../p0-drift/README.md)「维护规则」main 漂移参考第 3 条，这是协调者另建的「P0 漂移登记」任务。起因是 [P4.3b](orbit-task:34blYpxEcHMAf4oafuC2W) 最终轮报告的 36 个标准 P0 失败（桌面侧栏），以及 5 个 P4.2 同提交用例在每个环境的失败。规则和两个登记层都在 p0-drift 目录；本目录是这一批的失败清单、逐张归因、登记清单（含已接受层的处理）、P4.2 用例的维护、固定数据维护、验证和精简后的原始记录。

## 结论

| 项目 | 结果 |
| --- | --- |
| 开工时的失败 | 新基础 `17980cb7c`（项目 tip，已含 origin/main `87351bf9a`）上 P0 原命令（作业 `bgj_ce1dd4547f7d`）：112 个测试，61 通过、11 个已记录的跳过、**40 失败**。36 个是起因报告的桌面侧栏（9 个用例 × 4 个桌面项目），另 4 个是手机的 session：新基础比 P4.3b 的起点多吸收了 main `87351bf9a`，会话页另有两处 main 改动。 |
| 完整失败面 | update 模式截全 252 张，对照当前期望：**132 张**不通过比较器（桌面侧栏 76、侧栏加会话页 28、会话页 28）；另 11 张低于阈值，都是 P3.2、WebKit 滚动锁已记录的差异，与本批无关。 |
| 归因 | 132 张全部逐张归因到单个 main 提交，每层都有同环境运行，**0 张归因不到 main**：<br>• **A12** main `cbe6a6635`（Merge refs/heads/project/34aithLozDanSv6nq0IAi into refs/heads/main），合入 `33e0e2e09`（feat(web): Runners and Providers become one Infrastructure page）：104 张桌面截图。项目线 X^1 `fce12bc2a` 252 张对照当前期望全部通过 → X 104 张变；合并内部 `db69d833b` → `33e0e2e09` 同样 104 张变，侧栏一列与 `cbe6a6635` 相同。<br>• **A13** main `3960c19c2`（feat(web): copy · time under each finished turn's reply）：会话页 56 张（8 个项目各 6 张，桌面 959/961px 断点各 4 张）。X^1 `d976df772` 不变 → X 56 张变 → 区间终点相同。<br>• **A14** main `9d3751ec2`（style(clients): fade the conversation into the composer instead of a rule above it）：同样 56 张，低于阈值（147–3075 像素，单通道差 ≤20），随会话页参考图一并登记。<br>区间里的迁移提交没有改变这些截图：P4.3a 0 张变化；P4.3b 只让 WebKit 全屏依赖图 2 张差 1 级（低于阈值，它自己的证据记录过）。 |
| 登记 | 一个登记提交 `416b29c22`，只改 `p0-drift/reference/`、`p0-drift/accepted/` 和 p0-drift README 的清单。main 漂移层 206 条（替换 74、新登记 42）：A12 的 64 张在 `cbe6a6635` 上生成，会话页 52 张在 `9d3751ec2` 上生成；Chromium 桌面的 profile-validation 2 条的 B1 修复已在 X 的树里，按第 4 条直接生成、不再带 `migrationFix`。期望组装由 `87 / 143 / 22` 变为 **`44 P0.2 originals, 183 main drift references, 25 accepted migration differences`**。 |
| 已接受层 | 按已接受层第 6 条第二种情况（X 的树已含该页面的迁移代码）：**不更新 main 漂移层**，before 取 X 的 first-parent 前驱树（`fce12bc2a`、`d976df772`），after 取 X 的树（`cbe6a6635`、`3960c19c2`），**引用原判定**（P3.2 第 2 版、WebKit 滚动锁第 1 版），旧条目移入 `previous`：重登 12 条（A12）和 3 条（A13，其中 2 条叠在本批 A12 那一条上）。另有 3 张此前没有条目、但带着已 CONFIRM 的低于阈值迁移差异的截图（深色桌面 task-action-menu 2 张、WebKit 明色手机 notification-error 1 张），按同样做法首次登记，没有放进 main 漂移层（见「缺口与边界」）。 |
| 迁移代码 | 两棵生成树都含已晋升的迁移代码，前驱树对照当前期望都通过比较器，不同之处只有噪声和已记录的低于阈值差异，所以登记的只有 main 改动；没有把迁移改动登记为漂移。 |
| 跟上 main 与固定数据 | 最终轮之前 origin/main 前进到 `896226a23`（含项目 tip），本批 rebase 上去（补丁不变）。它的 252 张与新基础 0 张变化，但会话页多发 `GET /api/auth/capabilities`（main `94025579b`，经 `59034ad63` 进入 main）。按「场景与固定数据维护」补一条固定响应 `f9fd37def`：服务端默认回答 `{ managedRunners: { enabled: false, contractVersion: 1 } }`；同一棵树上补前补后截图 0 张变化。逐层下钻到 `94025579b` 的同环境运行都有。协调者已接受这条路由。 |
| P4.2 用例 | 单独提交 `200a9fc7c`（rebase 前 `7b769416a`），只改 `p42.browser.mjs` 和 `p42-fixtures.mjs`：5 个用例按 main `33e0e2e09` 的新地址和标题维护导航与定位，没有删用例。原用例在新基础上 140 通过、40 失败（正是这 5 个用例 × 8 个环境）、4 跳过；维护后在最终的树上 **180 通过、0 失败**、4 跳过（作业 `bgj_89b05bbb913c`）。「runners › the list」读取中一步的转圈断言在 main 上不能成立（Machines 一节读取时不画加载指示），改为断言这一节在请求被扣住时的状态，见「缺口与边界」。 |
| 两轮完整 P0 | 最终的树 `f9fd37def` 上连续两轮 P0 原命令（作业 `bgj_965cd1a0bc13`）：每轮 112 个测试，**101 通过、11 个已记录的跳过、0 失败、0 flaky**，退出码 0，两轮逐项一致；没有 `unhandled`，没有页面异常。 |
| 负对照 | 侧栏 Infrastructure 一行和回合脚注各右移 1 像素（临时提交，不交付）：P0 原命令 **40 个失败，全部停在本批登记的截图上**；update 模式下本批登记的 132 张里 128 张检出（另 4 张是全屏依赖图，对话框盖住了那一行），其余 120 张没有一张失败。 |
| 合并检查 | `npm run build -w @orbit/web && npm run test -w @orbit/web`（作业 `bgj_9ebe701cd09f`，在 `b767ba002` 上）退出码 0：构建成功；Vitest **380 个文件、4961 个用例全部通过**。 |
| 最新 main | 交证据前 origin/main 又前进到 `ec881f633`：干跑无冲突，只改到 `index.css` 的启动卡片规则；临时合并树上标准 P0 101 通过、11 跳过、0 失败（作业 `bgj_848ab608e246`）。 |
| 不变的部分 | P0.2 原图、原断言、known-failures、比较选项与容差、场景、产品代码和 shared 都没有改；`fixtures.mjs` 只多一条路由（核对命令见「不变的部分」）。 |

## 执行经过

- **会话**：`3kPDITDRmp2IziG0GAd9zc`，2026-10-09 14:50 UTC 起，由 Claude Opus 5.5 执行。开工读了作业指导「P0 期望截图分三层」「跟上 main」「共享主机磁盘」「证据体积」，p0-drift README 的维护规则（main 漂移第 3、4、6、7 条，已接受层第 5、6 条，场景与固定数据维护），第 5 批先例和 P4.3b 的基础漂移一节。
- **起点**：项目分支 `refs/heads/project/34ZZeq0e3IR65GVm2kAs7` 的 tip 是 `17980cb7c`（Merge refs/heads/main into refs/heads/orbit/p4-3b-25a292：P4.3b 已落地，并已合并 origin/main `87351bf9a`）。那时 origin/main 就是 `87351bf9a`，已在项目 tip 里，跟上 main 没有可带进来的内容，本批分支从 `17980cb7c` 开始。P4.3b（34blYpxEcHMAf4oafuC2W）状态 DONE。
- **磁盘与内存**：根分区开工时只剩约 4.5 GB（低于作业指导的 6 GB），所以检出、依赖、构建树、TMPDIR 和全部运行原件都放在 `/mnt/data/tmp/34cswWfvNasFTq8kDM0Q4/`。每个浏览器运行和构建都包在 6G 的 cgroup 里（`systemd-run --scope -p MemoryMax=6G`，`oom_score_adj 500`）；主机负载常在 15–34、可用内存 2–7 GB，最多同时跑两条浏览器队列。合并检查见「验证」。
- **引擎回收**：15:30 UTC 左右会话引擎被回收（`drain_cap`），当时在跑的后台作业被停掉。已跑完的运行都留着（`meta.json` 有退出码），被停掉的两次运行和 P4.2 原用例运行从头重跑；[run.sh](tools/run.sh) 与 [lane.sh](tools/lane.sh) 可续跑。
- **main 前进**：登记完成后（15:56 UTC）发现 origin/main 已在 15:51 UTC 前进到 `896226a23`，其中 `776212132` 把项目 tip `17980cb7c` 晋升进了 main。按「跟上 main」，项目 tip 已在 origin/main 里，就把本批的两个提交 rebase 到 `896226a23`（补丁不变），在它上面补了一条固定响应，最终检查都在 rebase 之后的树上做。在此之前、`1efd68838`（`17980cb7c` 加本批两个提交）上跑过的两轮正式 P0 留作过程记录（见「验证」）。
- **会话额度**：16:37 UTC 会话被 Claude 会话额度停掉，19:05 UTC 由协调者原位复活。停下时最终两轮和负对照已跑完，维护后的 P4.2 运行被停掉，复活后重跑；合并检查和最新 main 合并树上的 P0 在复活后跑。
- **一次作废的作业**：第一次启动 rebase 前的两轮（`bgj_848f51b3126d`）时手打了一个错误的完整提交号，作业在检出时就退出（`unable to read tree`），没有运行任何测试；随即用 `git rev-parse` 得到的提交号重跑（`bgj_d328c5df3fcb`）。
- 没有推送 main 或项目分支，没有部署或发布。

## 环境与方法

- **依赖**：`/mnt/data` 上的两个 worktree（`wt/base`、`wt/reg`）各自按锁文件隔离安装：`npm ci --offline --ignore-scripts --include=dev --include=optional`（[setup-base.sh](tools/setup-base.sh)）。本批涉及的所有提交 `package-lock.json` 都相同（blob `f03a6e32…`）。
- **环境**：每次浏览器运行都由 P0 的 `environment.mjs` 与 [P0.2 environment.json](../p0.2/environment.json) 逐字段比较并通过，写出的 environment.json 都与 P0.2 记录逐字节相同（SHA-256 `fe69e824…`，各运行的哈希在 [attribution/runs/](attribution/runs/) 的 `environment.sha256`）。
- **精简构建树**（[prepare-tree.sh](tools/prepare-tree.sh)，第 2、3、5 批的做法）：`git archive` 取出 Web 构建会读的文件，依赖共用上面那份安装，`@orbit/shared` 链接到这棵树自己的 `src/shared`，按 `pretest:ui-migration` 构建并记下产物每个文件的 SHA-256（[attribution/dists/](attribution/dists/)）。核对：新基础 `17980cb7c` 这样构建的产物，22 个文件与 worktree 里 P0 原命令 pretest 构建的逐字节相同。
- **运行器**（[make-runner.sh](tools/make-runner.sh)）：P0 测试从运行器目录运行，被测树只提供生产构建和 `npm run preview`（[p0d7.config.mjs](tools/p0d7.config.mjs)，与第 5 批的 p0d5.config.mjs 相同）。
  - `tip`：新基础 `17980cb7c` 的 P0 测试，也就是本批开工时的 P0 原测试（含第 2 批的场景维护、第 3、5 批的固定数据维护和 P4.1、P4.3b 维护的定位器）。归因用的完整矩阵都用它。
  - `old`：`db69d833b`（10-07 的 main）自己的 P0 测试（[make-runner-old.sh](tools/make-runner-old.sh)），只用于下钻时该树上的 settings、profile 两个用例：`tip` 的这两个场景等 P4.1 的 `.orbit-card`，P4.1 之前的树上没有。
  - `fix`：`f9fd37def` 的 P0 测试，与 `tip` 只差新补的一条固定响应（`GET /api/auth/capabilities`）。
- **运行方式**（[run.sh](tools/run.sh)）：完整矩阵是 pages、states、breakpoints 三个文件，80 个测试、252 张截图，截图写入空的临时目录（`--update-snapshots=all`），每张都能截到，再逐张比较；固定数据校验、定位和页面异常照常判定。每次运行在独立网络命名空间里（`unshare -n`），保持 P0 的 `http://127.0.0.1:4173`。每次运行和检查都包在 `systemd-run --scope -p MemoryMax=6G`、`oom_score_adj 500` 里（[cg.sh](tools/cg.sh)，作业指导 2026-10-09 的内存规则），Playwright 用 P0 配置的 1 个 worker。
- **比较与噪声**（[compare.cjs](tools/compare.cjs)，与第 2、3、5 批相同）：逐像素差异，加上 P0 比较器在 `maxDiffPixels: 0`、默认 threshold 下的结论。按 p0-drift README「Chromium 渲染噪声」判定「变化」：比较器不通过，或 WebKit 有任一像素不同，或 Chromium 单通道差超过 4 或超过 200 像素；其余记为噪声。每组比较在 [compare/](compare/)，一行汇总由 [pairs.sh](tools/pairs.sh) 和 [compare-summary.py](tools/compare-summary.py) 给出。
- **正式运行**：P0 原命令 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web`，在 `/mnt/data` 的 worktree 里、独立网络命名空间里运行（[round.sh](tools/round.sh) 调用 [netns-regression.sh](tools/netns-regression.sh)，两轮由 [final-rounds.sh](tools/final-rounds.sh) 连着跑）。

## 失败清单

### 开工时：新基础 `17980cb7c`

在新基础 `17980cb7c` 的 `/mnt/data` 检出上运行 P0 原命令（作业 `bgj_ce1dd4547f7d`，[checks/base-start](checks/base-start/summary.json)）：112 个测试，61 通过、11 个已记录的跳过、**40 失败**、0 flaky，退出码 1。期望组装输出 `P0 expected screenshots: 87 P0.2 originals, 143 main drift references, 22 accepted migration differences.`，环境记录与 P0.2 逐字节相同，没有 `unhandled`，没有页面异常。

| 用例 | 项目 | 停在 | 期望来源 | Playwright 报告的差异像素 |
| --- | --- | --- | --- | --- |
| task | 4 个桌面项目 | task-detail.png | main 漂移参考（第 1 批 A4） | C-light 2281、C-dark 2131、W-light 2245、W-dark 2055 |
| projects | 4 个桌面项目 | projects-list.png | P0.2 原图 | 同上 |
| wiki | 4 个桌面项目 | wiki-home.png | main 漂移参考（第 2 批、第 5 批） | 同上 |
| settings | 4 个桌面项目 | settings.png | main 漂移参考（第 1、5 批） | 同上 |
| profile | 4 个桌面项目 | profile.png | main 漂移参考（第 2 批 A6） | 同上 |
| controlled loading › projects loading and release | 4 个桌面项目 | projects-loading.png | P0.2 原图 | 同上 |
| controlled error › projects error and retry | 4 个桌面项目 | projects-error.png | P0.2 原图 | 同上 |
| session | 4 个桌面项目 | session-idle.png | main 漂移参考（第 1 批 A1、A2） | C-light 2417、C-dark 2246、W-light 2383、W-dark 2167 |
| session | 4 个手机项目 | session-idle.png | P0.2 原图 | C 116、W 110 |
| 断点巡检 | 4 个桌面项目 | breakpoint-959-session.png | P0.2 原图 | C 116、W 110 |

- **与起因报告的对照**：起因报告的 36 个是 9 个用例 × 4 个桌面项目，手机都通过。新基础多吸收了 main `87351bf9a`（P4.3b 的起点和交付都不含它），会话页因此还有 A13、A14（见「归因」），于是手机的 session 4 个也失败；断点巡检先停在 959px 的会话截图（A13），没有走到起因报告里那张 961px 的 Wiki。差异像素数在相同的截图上与 P4.3b 的报告一致（它记的是逐像素差异，这里是 Playwright 报告的数目）。
- **被挡住的截图**：每个用例在第一处失败就停下，后面的截图（task 的 hover/focus/menu/share、projects 的 overview/graph/fullscreen、wiki 的 new-entry、settings-saved、profile-validation、会话页其余 5 张、断点的 961px 会话与 Wiki 等）在完整失败面里一并处理。
- 差异图样例：[settings（chromium-light-desktop）](checks/base-start/failures/pages.browser.mjs-settings-chromium-light-desktop/settings-diff.png)、[session-idle（chromium-light-phone）](checks/base-start/failures/pages.browser.mjs-session-chromium-light-phone/session-idle-diff.png)。
- **其余 61 个通过**：pages 的 share ×8 与手机的 task、projects、wiki、settings、profile 各 4，states 的其余 8，P2.3 生产通知 8，P0.2-FOCUS-1/2 16，性能 1。**11 个跳过**：7 个非参考项目的性能采样、4 个手机项目的桌面断点巡检，与前几批相同。

### 完整失败面

用 update 模式在新基础上截全 252 张（[full-base](attribution/runs/full-base/meta.json)，76 通过、4 跳过、0 失败，没有 `unhandled`），再对照开工时组装的期望逐张比较（[compare/expected__full-base.json](compare/expected__full-base.json)）：

| 结果 | 截图 | 张数 |
| --- | --- | ---: |
| 不通过 P0 比较器：A12 侧栏 | 桌面 4 个项目的 task-detail、task-action-hover/focus/menu、task-share-dialog、projects-list、projects-search-empty、project-overview、project-graph、project-graph-fullscreen、projects-loading、projects-error、wiki-home、wiki-new-entry、settings、settings-saved、profile、profile-validation、breakpoint-961-wiki（19 种 × 4） | 76 |
| 不通过 P0 比较器：A12 侧栏 + A13 回合脚注 | 桌面 4 个项目的 session-idle、session-streaming、session-composer-focus、session-attachment-menu、session-attachment-staged、notification-error、breakpoint-961-session（7 种 × 4） | 28 |
| 不通过 P0 比较器：A13 回合脚注 | 手机 4 个项目的会话页 6 种（24），桌面 4 个项目的 breakpoint-959-session（4） | 28 |
| 通过，低于阈值：不属本批 | P3.2 已记录的 9 张（深色手机 task-action-menu 2 张，webkit-dark-phone 的 task-detail、task-action-hover、task-action-focus，WebKit 桌面的 breakpoint-599/601-dialog 4 张）；WebKit 滚动锁一批已记录的 2 张（webkit-light-phone 的 settings-saved、profile-validation） | 11 |
| 通过 | 逐字节相同 99 张，Chromium 噪声 10 张 | 109 |

**132 张就是本批要处置的全部截图**（另有 A14 落在同样 56 张会话截图上，低于阈值）。11 张低于阈值的在登记前后、本批涉及的每棵树上都一样，与本批无关，不登记（逐张见 [attribution/per-screenshot.md](attribution/per-screenshot.md) 的末几行）。深色桌面的 task-action-menu 2 张也带着 P3.2 的同一项低于阈值差异，但它们的侧栏变了，在 132 张里。

## 归因

按 main 漂移参考第 4 条 (a)–(f)，132 张截图逐张归因到单个 main 提交：逐张的表在 [attribution/per-screenshot.md](attribution/per-screenshot.md)，全部数据（每组比较的类别、像素、git 事实）在 [attribution/attribution.json](attribution/attribution.json)，由 [attribution.py](tools/attribution.py) 从记录的运行算出。**132 张都满足每一步，0 张归因不到 main。** 三处改动（A12–A14）都来自 main 的产品提交；区间里的迁移提交（P4.3a、P4.3b）没有改变这些截图（P4.3b 只让 WebKit 全屏依赖图差 1 级，见下）。

**项目线上发生了什么**：项目分支 first-parent 历史里，P4.3a 曾 rebase 到 main `19c760ae4`，所以 main 当时的 first-parent 提交（`fce12bc2a`、`cbe6a6635`、`a6e01fbc5`、`19c760ae4`）就在项目线上；之后是 P4.3a 的提交、`abc0a4cfa`（吸收 main `d98183765`）、P4.3b 的提交、`e21fad172`（吸收 main `4085437ff`），最后 `17980cb7c` 吸收 main `87351bf9a`。两次吸收 main 的合并 `abc0a4cfa`、`e21fad172` 都不改 Web 的构建输入（`src/web`、`src/shared`、锁文件与 `package.json` 在合并前后相同）。

### A12 Infrastructure 侧栏：main `cbe6a6635`（合入 `33e0e2e09`），104 张

**变化**：`33e0e2e09`（feat(web): Runners and Providers become one Infrastructure page）把桌面侧栏的 Runners、Providers 两行合成一行 Infrastructure，其下的 Workspaces、Projects 两段上移一行。差异都在侧栏一列：多数截图是 x 16–262、y 172–391（约 6200 像素）；会话页和项目页的选中行也随之上移，是 x 8–270（约 22500 像素）；全屏依赖图的遮罩下露出侧栏左边 16 像素宽的一条（x 8–23）。手机和 ≤960px 的断点截图不画侧栏，不变。

| 层级 | 前驱（不变） | 改变的提交 | 区间终点 |
| --- | --- | --- | --- |
| (a) 项目线 first-parent | `fce12bc2a`（Merge refs/heads/project/34ZZn8fmemArxvl2CsCFp into main）：对照当前期望 252 张都通过比较器：219 张逐字节相同，19 张噪声，其余 14 张只有已记录的低于阈值差异（P3.2 的 11 张、WebKit 滚动锁的 3 张） | `cbe6a6635`（Merge refs/heads/project/34aithLozDanSv6nq0IAi into refs/heads/main）：104 张都变，都不通过比较器，其余 148 张没有变化 | `ffae02edf`（`17980cb7c` 的第一父）：与 `cbe6a6635` 相比 0 张比较器失败，只有 P4.3b 让 WebKit 桌面 project-graph-fullscreen 2 张差 9、17 个像素（单通道差 1），见下 |
| (b) 合并内部：`cbe6a6635` 第二父 `6baf92736` 的 first-parent 线（merge base `6c9cebd4d`；最早的是 `33e0e2e09`，它的父提交 `db69d833b` 是这条线从 main 分出的地方） | `db69d833b` | **`33e0e2e09`**：同样 104 张都变，都不通过比较器（88 张用 `tip` 运行器，settings、profile 的 16 张用 `old` 运行器） | 线的终点 `6baf92736` 与 `cbe6a6635` 的 Web 构建输入相同、产物逐文件相同；侧栏一列（x < 272）`33e0e2e09` 与 `cbe6a6635` 104 张中 98 张逐像素相同，另 6 张只差 (0,0) 一个像素，就是 `cbe6a6635` 的树里已有、`33e0e2e09` 里还没有的 WebKit 滚动锁那一点 |

- **(c) X 在 main 上，不是本项目的晋升合并**：`cbe6a6635` 是项目 34aithLozDanSv6nq0IAi（Runners 与 Providers 合并为 Infrastructure）的合并，在 origin/main 里，不是 `Merge refs/heads/project/34ZZeq0e3IR65GVm2kAs7 into refs/heads/main`。它在项目线的 first-parent 上；origin/main 现在的 first-parent 链经 `f849377e3`（一个会话分支快进到 main）绕过它，但它是 origin/main 的祖先。变化来自产品代码：`33e0e2e09` 改的是 `TasksSidePanel.tsx`、`InfrastructurePage.tsx`、`RunnerEngines.tsx`、`App.tsx` 等，不是迁移组件。它的提交说明写明了侧栏的这一处：“The sidebar has one Infrastructure row”。
- **为什么 X 记 `cbe6a6635`**：参考图要在 X 的树上生成，而 X 的树必须同时含有当前期望里已登记的 main 改动（A10 Wiki 分享按钮、A11 Suggested replies、B1 修复与 WebKit 滚动锁修复等，都是 10-08、10-09 的 main）。`33e0e2e09`（10-07）的树没有这些，在它上面生成的参考图会丢掉它们。所以按第 1 批 A4 的先例（main 合并 `4088d37e6`，合入的 Web 提交 `82c7e92ff`），X 取 main 合并 `cbe6a6635`；`mainCommits` 把 `33e0e2e09` 写在 `cbe6a6635` 前面，`generatedFrom` 是最后一个 `cbe6a6635`。
- **(d) X 的树里没有影响这些截图的迁移改动**：`cbe6a6635` 的前驱 `fce12bc2a` 含本项目到当时为止晋升进 main 的迁移代码（P1–P4.2、B1 修复、WebKit 滚动锁修复等），它对照当前期望 252 张都通过比较器，不同之处只有噪声和已记录的低于阈值差异（上表）。所以迁移代码没有改变这 104 张。已接受层里有登记的 12 张和带着已接受、低于阈值迁移差异的 2 张，按已接受层第 6 条第二种情况处理，不更新 main 漂移层，见「登记清单」。
- **区间里的其它提交**：从 `cbe6a6635` 到 `ffae02edf`：`cbe6a6635` → `abc0a4cfa`（`a6e01fbc5`、`19c760ae4` 只改 shared 的托管 runner 与 Wiki 合同；P4.3a 的提交；`abc0a4cfa` 吸收 `d98183765`，不改 Web）0 张变化，WebKit 126 张逐字节相同；`abc0a4cfa` → `ffae02edf`（P4.3b 的提交，`e21fad172` 吸收 `4085437ff`，不改 Web）只有 WebKit 桌面 project-graph-fullscreen 2 张差 9、17 个像素（单通道差 1，比较器通过）。这是 P4.3b 自己的同提交对照记录过的「2 张最多差 1 级」，是迁移差异，低于阈值，不登记，也不影响本批登记（这 2 张的参考图在 `cbe6a6635` 上生成，新基础对照它只差这 1 级）。另外 `4085437ff`（`e21fad172` 吸收的 main）与 `cbe6a6635` 的产物逐文件相同。
- **(e) 参考图**：用 `cbe6a6635` 的树、`tip` 运行器、P0.2 环境生成（[full-cbe6a6635](attribution/runs/full-cbe6a6635/meta.json)）。
- 对照图（左 X^1，右 X）：[侧栏裁切（chromium-light-desktop settings）](attribution/images/A12--chromium-light-desktop--settings--crop.png)、[整页](attribution/images/A12--chromium-light-desktop--settings.png)、[会话页侧栏，选中行上移（webkit-dark-desktop）](attribution/images/A12--webkit-dark-desktop--session-idle--crop.png)、[合并内部 `db69d833b` → `33e0e2e09`（task-detail）](attribution/images/A12-drill--chromium-light-desktop--task-detail--crop.png)。

### A13 回合脚注：main `3960c19c2`，56 张

**变化**：`3960c19c2`（feat(web): copy · time under each finished turn's reply）在每个结束的回合下面画一行复制键和结束时间（P0 固定时间 12:00 PM），取代原来 12px 的空白分隔；回合高了 18px 加上下边距，下面的内容随之下移。会话页的 6 张截图（session-idle、session-streaming、session-composer-focus、session-attachment-menu、session-attachment-staged、notification-error）在 8 个项目都变，断点巡检的 959px、961px 会话截图在 4 个桌面项目都变，共 56 张。差异都在消息列：桌面 x ≥ 621，手机 x 14–376。

| 层级 | 前驱（不变） | 改变的提交 | 区间终点 |
| --- | --- | --- | --- |
| (a) 项目线 | `ffae02edf`：与 `cbe6a6635` 只差上面 P4.3b 的 2 张 | `17980cb7c`（Merge refs/heads/main into refs/heads/orbit/p4-3b-25a292，第二父 `87351bf9a`）：56 张都变，都不通过比较器，其余 196 张没有变化 | 项目 tip 就是 `17980cb7c` |
| (b) main first-parent（`17980cb7c` 的第二父线，merge base `4085437ff` 之后 28 个提交；改 Web 构建输入的 11 个逐个构建，产物相同的不重跑） | `4085437ff`（产物与 `cbe6a6635` 相同）→ `bab3256a7` → `489021bfa` → `a74ecb43b` → X^1 `d976df772`（产物与 `a74ecb43b` 相同）：每一步 0 张变化，WebKit 全部逐字节相同 | **X `3960c19c2`**：56 张都变，都不通过比较器 | `3960c19c2` → `0a887da2c`（第二次合入 Infrastructure 项目）→ `51c5c8eeb`：0 张变化；之后 `9d3751ec2` 的变化见 A14；`9d3751ec2` → `87351bf9a`：0 张变化 |

- **(c)**：`3960c19c2` 是 origin/main first-parent 上的单个非合并提交，不是本项目的晋升合并；改的是 `Transcript.tsx` 和 `index.css`（另有两个单测），是产品代码。
- **(d)**：`3960c19c2` 的树含已晋升的迁移代码（含 P4.3a，`a74ecb43b` 合入）。前驱 `d976df772` 与 `cbe6a6635` 相比 0 张变化，也就是迁移代码在这一段没有改变任何截图。已接受层的 3 张 notification-error 和带着已接受、低于阈值迁移差异的 1 张，按已接受层第 6 条第二种情况处理。
- 对照图：[回合脚注裁切（chromium-light-phone session-idle）](attribution/images/A13--chromium-light-phone--session-idle--crop.png)、[整页（webkit-dark-phone session-streaming）](attribution/images/A13--webkit-dark-phone--session-streaming.png)。

### A14 输入框上方的分隔线改为渐隐：main `9d3751ec2`，56 张，低于阈值

**变化**：`9d3751ec2`（style(clients): fade the conversation into the composer instead of a rule above it）只改 `index.css`：去掉输入框上方那条 1px 分隔线（手机 y 732 一整行），消息区底部改为渐隐；用户气泡的文字随之重新栅格化。同样是 A13 的 56 张，每张 147–3075 个像素、单通道差 ≤20，**都通过 P0 比较器**。

| 层级 | 前驱（不变） | 改变的提交 | 区间终点 |
| --- | --- | --- | --- |
| main first-parent | X^1 `51c5c8eeb`（产物与 `0a887da2c` 相同）：与 `3960c19c2` 相比 0 张变化 | **X `9d3751ec2`**：56 张都变（比较器通过） | `87351bf9a`：与 X 相比 0 张变化（`c8a431304`、`384b7f86a`、`35e6fe726` 的产物与 X 相同，`435729f1b` 的与 `87351bf9a` 相同） |

- **为什么也登记**：它不让任何用例失败，但它是 main 的产品改动，确定、可复现（WebKit 每次都变，Chromium 超过 200 像素）。会话页的参考图要因为 A13 重新生成，在含 A14 的 `9d3751ec2` 上生成，参考图就与当前 main 完全一致；第 1 批登记过低于阈值的 A5，第 5 批把同样低于阈值的 A6 写进了 `mainCommits`，做法相同。已接受层的 4 张 notification-error 不能这样做：登记工具只收比较器检出的差异，它们停在 A13 那一条，新基础对照它们只差 A14 这部分（比较器通过）。
- 对照图：[分隔线裁切（chromium-dark-phone session-idle）](attribution/images/A14--chromium-dark-phone--session-idle--crop.png)。

### 新基础与 main 的其余部分

- `87351bf9a` → `17980cb7c`：只有 P4.3b 的 2 张 WebKit 全屏依赖图（1 级）；
- `17980cb7c` → origin/main `896226a23`（交证据前 main 的位置，见「跟上 main」）：252 张 0 张变化，WebKit 全部逐字节相同；只多了一条未建模的请求，见「固定数据维护」。

## 登记清单

一个登记提交 `416b29c22`（rebase 前是 `1efd68838`，补丁相同），只改 `p0-drift/reference/`、`p0-drift/accepted/` 和 [p0-drift README](../p0-drift/README.md) 两个登记层的清单段落（151 个文件；README 22 行增、10 行删），可单独回退。登记后期望组装为 **`44 P0.2 originals, 183 main drift references, 25 accepted migration differences`**（登记前 `87 / 143 / 22`）。

### main 漂移参考层：206 条（替换 74、新登记 42）

工具是 [make-reference.py](tools/make-reference.py)（第 5 批的同名工具，只多一条：第 7 条例外的条目，修复提交已在新的生成树里时，例外不再适用，直接在 X 的树上生成，新条目不带 `migrationFix`），输入是 [spec-a12.json](tools/spec-a12.json)、[spec-a13-a14.json](tools/spec-a13-a14.json)。

| 归因 | 截图 | 张数 | `mainCommits` 追加 | 生成树（运行） | `projectLine` 追加 |
| --- | --- | ---: | --- | --- | --- |
| A12 | 桌面 4 个项目的 task-detail、task-action-hover、task-action-focus、project-overview、project-graph、project-graph-fullscreen、wiki-home、wiki-new-entry、breakpoint-961-wiki、settings、profile（44，替换）；projects-list、projects-search-empty、projects-loading、projects-error（16，新登记）；Chromium 桌面的 settings-saved、profile-validation（4，替换） | 64 | `33e0e2e09`、`cbe6a6635` | `cbe6a6635`（full-cbe6a6635） | `cbe6a6635` |
| A12、A13、A14 | 桌面 4 个项目的 session-idle、session-streaming、session-composer-focus、session-attachment-menu、session-attachment-staged、breakpoint-961-session，Chromium 桌面的 notification-error（26，替换） | 26 | `33e0e2e09`、`cbe6a6635`、`3960c19c2`、`9d3751ec2` | `9d3751ec2`（full-9d3751ec2） | `cbe6a6635`、`17980cb7c` |
| A13、A14 | 手机 4 个项目的 session-idle、session-streaming、session-composer-focus、session-attachment-menu、session-attachment-staged，Chromium 手机的 notification-error，桌面 4 个项目的 breakpoint-959-session（26，新登记） | 26 | `3960c19c2`、`9d3751ec2` | `9d3751ec2`（full-9d3751ec2） | `17980cb7c` |

- **替换的 74 条**：每条只改 `sha256`、`mainCommits`、`generatedFrom`、`projectLine`、`change` 五个字段，旧的提交号都留在列表前面，`group`、`p0Baseline` 不变；Chromium 桌面的 profile-validation 2 条另去掉了 `migrationFix`（下一条）。其余 90 条逐字段不变（工具运行后用 registry 逐条核对）。
- **Chromium 桌面的 profile-validation**：第 2 批按第 7 条例外，在 `d233a6cd0` 加 B1 修复 `3ec9cf83d` 的树上生成。新的 X `cbe6a6635` 的树已含 `3ec9cf83d`（经晋升进入 main），含 X 的 main 树不再带着 B1，例外的前提不成立，所以按第 4 条直接在 X 的树上生成，新条目不带 `migrationFix`；旧条目在 git 历史里。前驱 `fce12bc2a` 的这 2 张对照原参考图（第 7 条例外生成的）只有 Chromium 噪声（82、104 像素，单通道差 2），迁移代码（B1 与它的修复）没有改变它们。手机的 4 条第 7 条例外不受本批影响，没有动。
- **`projectLine` 的取法**：A12 经项目线 first-parent 上的 `cbe6a6635` 进入项目线，记 `cbe6a6635`。A13、A14 经项目 tip `17980cb7c`（吸收 main `87351bf9a`）进入项目线，记 `17980cb7c`。本批后来 rebase 到 origin/main `896226a23`，它已含 `17980cb7c`（由 `776212132` 晋升）。
- **低于阈值的 A14**：会话页的参考图在 `9d3751ec2` 上生成，所以带着 A14；没有为 A14 单独生成任何一张参考图。
- **不在本层更新的截图**：已接受层承接的 16 张（下一节）在 main 漂移层保持原样。

### 已接受层：第 6 条第二种情况，18 次登记、25 条

X 的树（`cbe6a6635`、`3960c19c2`）都已含这些页面的已接受迁移代码（P3.2 的晋升，WebKit 滚动锁修复 `9f2f7e9a0`），所以按第 6 条第二种情况：**不更新 main 漂移层**，同提交对照的 before 取 X 的 first-parent 前驱树，after 取 X 的树，差异说明写明这是叠在已接受差异上的 main 改动，并指向本目录的归因证据。**每条都引用原判定**（从 registry 里带着它的条目读出，不手抄摘要），登记工具把旧条目移入 `previous`。命令在 [register-accepted7.sh](tools/register-accepted7.sh)（调用 [register-accepted.cjs](../p0-drift/tools/register-accepted.cjs)），差异说明全文在 [accepted/registry.json](../p0-drift/accepted/registry.json)。

| 步 | 截图 | 条数 | 原判定 | before → after | 被替换的期望（`replaces`，不变） |
| --- | --- | ---: | --- | --- | --- |
| A12 | task-share-dialog（桌面 4 个项目）、task-action-menu（浅色桌面 2 个） | 6 | P3.2（[34Za39ACSBoCkYKc80Md8](orbit-task:34Za39ACSBoCkYKc80Md8)）第 2 版，`evidenceDigest` `302ca1f5…09bc`，CONFIRM，[p3.2/README.md](../p3.2/README.md) | `fce12bc2a` → `cbe6a6635` | 第 1 批 A4 的 main 漂移参考 |
| A12 | settings-saved、profile-validation、notification-error（WebKit 桌面 2 个项目） | 6 | WebKit 滚动锁（[34cBi0yt6bFcSmbJFgDPj](orbit-task:34cBi0yt6bFcSmbJFgDPj)）第 1 版，`evidenceDigest` `fdb19816…8e7c`，CONFIRM（判定记录 `fRJrSzK3CevsTPV4xEki6`），[webkit-scroll-lock/README.md](../webkit-scroll-lock/README.md) | `fce12bc2a` → `cbe6a6635` | 设置页组、第 2 批 A6、会话组的 main 漂移参考 |
| A12，首次登记 | task-action-menu（深色桌面 2 个项目） | 2 | P3.2 第 2 版（同上） | `fce12bc2a` → `cbe6a6635` | 第 1 批 A4 的 main 漂移参考 |
| A13 | notification-error（WebKit 桌面 2 个项目，叠在本批 A12 那一条上；webkit-dark-phone） | 3 | WebKit 滚动锁第 1 版（同上） | `d976df772` → `3960c19c2` | 会话组的 main 漂移参考；webkit-dark-phone 为 P0.2 原图 |
| A13，首次登记 | notification-error（webkit-light-phone） | 1 | WebKit 滚动锁第 1 版（同上） | `d976df772` → `3960c19c2` | P0.2 原图 |

- **登记工具的三项检查都通过**：两次运行都在 P0.2 环境；before 原件在 P0 比较器下复现当前期望（12 条重登的 before 与当前已接受期望逐字节相同；A13 一步的 before 复现 A12 一步或滚动锁一批的 after）；after 与 before 不一致。
- **首次登记的 3 条**：深色桌面的 task-action-menu 2 张和 WebKit 明色手机的 notification-error 此前没有已接受条目。它们的当前期望（main 漂移参考或 P0.2 原图）上带着一项已由协调者 CONFIRM、但低于比较器阈值、登记工具不收的迁移差异：P3.2 的深色菜单（p3.2-accepted 逐张列出，Chromium 466、WebKit 489 个像素，单通道差 45），WebKit 滚动锁一批的文档滚动条那一列（webkit-scroll-lock-accepted「未登记的截图」，判定写明「低于阈值的 3 张 WebKit 明色手机截图不登记」）。含 X 的每一棵 main 树都带着这些迁移像素：在 X 的树上重新生成 main 漂移参考，就会把迁移像素放进 main 漂移层，违反「迁移改动永远不能登记为漂移」。所以这 3 张按第 6 条第二种情况的做法叠加登记，引用同一判定，main 漂移层不动。这是对第 6 条的延伸（第 6 条写的是已有登记的截图），见「缺口与边界」。
- **`previous`**：12 条重登的旧条目（P3.2 的 after `2925958ae`、滚动锁一批的 after `b2568f28d`）移入 `previous`；WebKit 桌面的 notification-error 两条经两步，`previous` 依次是滚动锁一批的条目和本批 A12 的条目；webkit-dark-phone 的 notification-error 的 `previous` 是滚动锁一批的条目。
- **A14 没有进已接受层**：A14 对这 4 张 notification-error 的变化低于阈值（396–1206 像素，单通道差 ≤20），登记工具不收（after 与 before 在比较器下一致），它们停在 A13 那一条；新基础对照它们只差 A14，比较器通过。
- **没有受影响的其它已接受条目**：手机的 task-share-dialog、task-action-menu（P3.2）、webkit-light-phone 的 profile-validation（P4.1）、webkit-dark-phone 的 settings-saved、profile-validation（滚动锁）都不在 132 张里，`replaces` 仍然匹配，没有动。

### 登记后的核对

在登记提交的树上用 P0 的 globalSetup 组装期望：校验全部通过，输出 `P0 expected screenshots: 44 P0.2 originals, 183 main drift references, 25 accepted migration differences.`。新基础 `17980cb7c` 的 252 张（update 模式）对照登记后的期望：**0 张比较器失败**，219 张逐字节相同、16 张噪声，其余 17 张低于阈值，都是已记录的：P3.2 的 9 张、WebKit 滚动锁的 2 张（webkit-light-phone 的 settings-saved、profile-validation）、A14 落在已接受层的 4 张 notification-error、P4.3b 的 2 张 WebKit 全屏依赖图（[compare/registered__base.json](compare/registered__base.json)）。origin/main `896226a23` 的 252 张对照登记后的期望，结果相同（[compare/registered__896226a23.json](compare/registered__896226a23.json)）。

## 固定数据维护：`GET /api/auth/capabilities`

**问题**：origin/main 在本批工作期间前进到 `896226a23`。它的 252 张截图与新基础 `17980cb7c` 0 张变化，但会话页多发一个请求 `GET /api/auth/capabilities`：P0 固定数据没有这条路由，按 P0.2 的设计返回 501，会话用例 8 个、断点巡检 4 个（959、961px 各打开一次会话）停在用例结束时的固定数据校验，`unhandled` 只有这一条（每个用例 2 次：React Query 对 501 的 `retry: 1`）。

**改动**：只有 `f9fd37def` 一处，单独提交，只改 [fixtures.mjs](../../../../src/web/ui-migration/fixtures.mjs)（5 行新增）：

```diff
     if (method === 'GET' && path === '/api/auth/methods') return json({ password: true, google: false, googleSignup: false });
+    // main 94025579b (feat(managed-runner): shared status display, server-derived state fixture and web status UI;
+    // into main with 59034ad63) made the session page read GET /auth/capabilities. The server's default answer:
+    // managed runners stay off until ORBIT_MANAGED_RUNNERS_ENABLED=true (AuthController.capabilities), so the
+    // page shows no managed-runner UI and reads no managed-runner status.
+    if (method === 'GET' && path === '/api/auth/capabilities') return json({ managedRunners: { enabled: false, contractVersion: 1 } });
```

- **只补这一条**：方法和路径完全相同才命中；已有的固定数据、断言、截图比对、容差都没改；其余没有建模的请求照旧返回 501 并使校验失败。
- **引用的 main 提交**：`94025579b`（feat(managed-runner): shared status display, server-derived state fixture and web status UI），在 `lib/managedRunner.ts` 加了 `serverCapabilitiesQuery`，会话页的 `useManagedRunner` 用它。`git log -S'auth/capabilities' -- src/web src/shared` 在 `87351bf9a..896226a23` 里只有这一个提交。
- **取值依据**（也写进 p0-drift README「固定数据维护」的清单）：服务端 `AuthController.capabilities()` 回答 `{ managedRunners: { enabled, contractVersion } }`，`enabled` 是 `ORBIT_MANAGED_RUNNERS_ENABLED`，缺省、空或 `false` 都是关；合同版本是 1。P0 账号唯一的 runner 是普通注册的机器，固定数据没有 `/api/managed-runner`。客户端只在 `enabled === true` 且合同版本相同时才读托管状态、画托管 runner 的界面（`managedRunnersOffered`），所以取关，会话页与 `94025579b` 之前相同；补之前的 501 也不会画托管界面，补固定响应不改变截图。
- **同环境证明**：请求经四层合并进入 main，按第 4 条 (a)(b) 的办法逐层下钻，每一层都有两边的完整矩阵（原测试，运行器 `tip`）：

| 层级 | 前驱（不发这个请求） | 改变的提交（12 个用例停在固定数据校验，`unhandled` 只有这一条） |
| --- | --- | --- |
| main first-parent（本批 rebase 到的 origin/main 的线） | `87351bf9a`：76 通过、0 失败，`unhandled` 空 | `59034ad63` Merge refs/heads/project/34ZteKCnYMpKY46f63Leb into refs/heads/main：64 通过、12 失败，24 次 |
| C7 项目线（`59034ad63` 第二父 `caf813f5c` 的 first-parent 线，merge base `87351bf9a`） | `031b135cb`（C7 吸收 main `87351bf9a`，产物与 `87351bf9a` 相同）：76 通过，`unhandled` 空 | `caf813f5c`：Web 构建输入与 `59034ad63` 相同，结果同上 |
| `caf813f5c` 第二父 `835353981`（merge base `d7f93ef55`） | `d7f93ef55`：76 通过，`unhandled` 空 | `835353981`：64 通过、12 失败，24 次 |
| `835353981` 第二父 `d09ed62b2` 的 first-parent 线（最早的是 `a0bdb0051`） | `657af4ab8`（`a0bdb0051` 的第一父）：76 通过，`unhandled` 空 | `a0bdb0051`：64 通过、12 失败，24 次 |
| `a0bdb0051` 第二父 `cfbeff3f6` 的 first-parent 线（merge base `657af4ab8`） | X^1 `657af4ab8`（同上） | **X `94025579b`**：64 通过、12 失败，25 次 |

  12 个用例是会话 8 个和断点巡检 4 个，每个 2 次（React Query 对 501 的 `retry: 1`；`94025579b` 上有一个用例 3 次）。所有运行的 `pageErrors` 都为空。

- **补了固定响应之后**：`896226a23` 上用 `fix` 运行器（原测试加这条路由）：76 通过、0 失败，`unhandled` 空。同一棵树上原测试与 `fix` 相比截图 **0 张变化**：236 张逐字节相同，16 张 Chromium 噪声（≤42 像素，单通道差 ≤4），WebKit 126 张全部逐字节相同（[compare/896226a23__fix-896226a23.json](compare/896226a23__fix-896226a23.json)）。对照登记后的期望 0 张比较器失败，只有已记录的 17 张低于阈值差异（[compare/registered__fix-896226a23.json](compare/registered__fix-896226a23.json)）。最终的两轮里，24 次读取都由这条路由回答，没有 `unhandled`。
- **截图不变的原因**：补之前请求得到 501，查询出错，`managedRunnersOffered` 为假；补之后 `enabled: false`，同样为假。两种情况会话页都不画托管 runner 的界面，也不读 `/managed-runner`。

## P4.2 用例的维护

**问题**：P4.3b 在起点树（项目 tip `abc0a4cfa` 合并 origin/main `4085437ff`，不含 P4.3b）上看到 5 个 P4.2 同提交用例在八个环境都失败。本批在新基础 `17980cb7c` 上用原用例重跑（检查 `p42-base-original`），结果相同：只有这 5 个用例在每个环境失败，其余用例都通过（数目见「验证」）。原因都是 main 的 Infrastructure 页：
- main `33e0e2e09`（feat(web): Runners and Providers become one Infrastructure page）把 Runners 列表和 API keys 并进 `/infrastructure`：`/runners`、`/providers` 都重定向过去（`/providers` 落在 `#keys`），保存一把 key 后去 `/infrastructure#keys`，离开或删除账号池后去 `/infrastructure#pools`；keys 一节的标题是 “API keys”；机器卡片的 ⋯ 是 “More actions for <名字>”，改名对话框叫 “Rename machine”；机器为空时这一节显示自己的邀请（“Already pay for Claude, Codex or Kimi?” 和 Register a machine）。
- main `8e0d14276`（refactor(web): delete the old Runners and Providers pages）删掉了 RunnersPage、ProvidersPage，连同 “Runners”“Your API keys” 标题、`.runner-card` 列表、Register Runner 按钮和 “No runners yet” 那行字。

**改动**：单独一个提交 `7b769416a`（test(web): P4.2 cases follow main's Infrastructure page (33e0e2e09)），只改 [p42.browser.mjs](../../../../src/web/ui-migration/p42.browser.mjs) 和 [p42-fixtures.mjs](../../../../src/web/ui-migration/p42-fixtures.mjs)。没有删用例，用例名、步骤、截图名、trace 的步骤名都不变；每处注释写明依据的 main 提交。

| 用例 | 原来等的 | 现在等的 | 依据 | 断言要证明的行为 |
| --- | --- | --- | --- | --- |
| providers › keys | 打开 `/providers`，等标题 “Your API keys” | 打开 `/infrastructure#keys`（`/providers` 重定向到的地址），等这一节的标题 “API keys” | `33e0e2e09`；旧标题随 `8e0d14276` 删掉 | 不变：keys 表的读取中、表格、删除问句与 Provider deleted、没有 key 时的 No keys yet。其余定位（`.provider-keys`、行、删除按钮、OK）在新页面上原样命中 |
| connecting a provider › a vendor | Save anyway 之后 `waitForURL('**/providers')` | `waitForURL('**/infrastructure#keys')` | `33e0e2e09`（ProviderConnectPage 保存后 `navigate('/infrastructure#keys')`） | 不变：探测失败、Save anyway 之后回到 key 列表，并通知 Provider created。等的地址比原来更具体（带 `#keys`） |
| connecting a provider › editing | Save 之后 `waitForURL('**/providers')` | `waitForURL('**/infrastructure#keys')` | 同上 | 不变：显示已存的 key、关掉开关、Save 之后回到 key 列表并通知 Provider updated |
| a pool on its own page › a pool somebody added the reader to | Leave 之后 `waitForURL('**/providers')` | `waitForURL('**/infrastructure#pools')` | `33e0e2e09`（ProviderPoolPage 离开后 `navigate('/infrastructure#pools')`） | 不变：离开问句、Leave 之后回到账号池并通知 You left Team keys |
| runners › the list | 打开 `/runners`，等标题 “Runners”；卡片 `.runner-card`/`.runner-name`；⋯ 是 `.runner-kebab`；对话框 “Rename runner”；列表截图量 Register Runner；空列表等 “No runners yet — register a machine to get started.” | 打开 `/infrastructure`（`/runners` 重定向到的地址），等这一节的标题 “Machines”；卡片 `.re-runner-card`/`.re-runner`；⋯ 是 “More actions for <名字>”；对话框 “Rename machine”；列表截图量页头的 Add（它的菜单注册机器）；空列表先等页头下的概览（页面在每个列表都读完后才画它），再等这一节的邀请 “Already pay for Claude, Codex or Kimi?”，截图量 Register a machine | `33e0e2e09`；旧页面随 `8e0d14276` 删掉 | 菜单（Rename、Rotate token、Delete）、改名、轮换 token 的问句与新 token、删除问句、删除后卡片消失、空列表：都不变。**读取中这一步变了**：原来断言 Spin/Orbit Spinner 可见；main 的 Machines 一节在列表读取期间不画任何加载指示，列表回来之前就显示空列表的邀请。这一步现在断言：列表请求被扣住时，这一节已画出、没有机器卡片、邀请可见，并截这一节。原来的转圈断言在 main 上无法成立，见「缺口与边界」 |

**`P42_PATHS`**：新增 `infrastructure`、`keys`、`pools` 三个地址（`33e0e2e09`）。原有的 `providers`、`runners` 等地址不变：其余通过的用例（engines、pools、New pool、DeepSeek 余额）照旧打开 `/providers`，经重定向落在同一页，本批不动它们。

## 验证

### 两轮完整 P0：最终的树 `f9fd37def`

- **树**：`f9fd37def`，即 origin/main `896226a23` 加本批 3 个提交：`200a9fc7c`（P4.2 用例）、`416b29c22`（登记）、`f9fd37def`（固定响应）。之后只有 `b767ba002`（p0-drift README 的固定数据清单）和最后的证据提交，都只改文档，不改 `src/`、`reference/`、`accepted/`。
- **命令**：P0 原命令 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web`，在 `/mnt/data` 的检出 `wt/reg` 里，独立网络命名空间，紧接着跑两轮（[final-rounds.sh](tools/final-rounds.sh)，作业 `bgj_965cd1a0bc13`）。

| 轮次 | 结果 | 记录 |
| --- | --- | --- |
| 第 1 轮（16:09:37–16:14:30 UTC） | 112 个测试：101 通过、11 个已记录的跳过、**0 失败**、0 flaky，退出码 0 | [checks/final7-1](checks/final7-1/summary.json)（含 `report.summary.json`、`command-output.txt`、`sources.json`、`evidence-digest.json`） |
| 第 2 轮（同一作业，紧接其后，16:14:37–16:22:15 UTC） | 同上，112 个测试逐个状态相同 | [checks/final7-2](checks/final7-2/summary.json)、[两轮对照](checks/final7-compare.json) |

- 两轮的期望组装都输出 `P0 expected screenshots: 44 P0.2 originals, 183 main drift references, 25 accepted migration differences.`，globalSetup 对两个登记层的校验都通过；环境记录与 P0.2 逐字节相同（`fe69e824…`）；运行时检出干净（`command-output.txt` 第一行）。
- **101 个通过**：pages 56（task、share、projects、wiki、settings、profile、session 各 8）、states 16、断点巡检 4（桌面）、P2.3 生产通知 8、P0.2-FOCUS-1/2 16、性能 1。**11 个跳过**：7 个非参考项目的性能采样、4 个手机项目的桌面断点巡检。没有预期失败。
- **本批登记的截图都通过**：132 张对照 main 漂移参考（116 张，本批的版本）或已接受层（16 张，本批的条目）；`sources.json` 逐张写着来源层和 `mainCommits`。
- **固定数据**：两轮都没有 `unhandled`，没有页面异常。`GET /api/auth/capabilities` 每轮读 24 次，都由新路由回答（[evidence-digest.json](checks/final7-1/evidence-digest.json)）。
- **rebase 之前的两轮**（过程记录）：在 `1efd68838`（`17980cb7c` 加本批前两个提交，没有固定响应）上也连续跑过两轮（作业 `bgj_d328c5df3fcb`）：每轮 112 个测试，101 通过、11 跳过、0 失败、0 flaky，两轮逐项一致，期望组装同为 44 / 183 / 25（[checks/final-1](checks/final-1/summary.json)、[final-2](checks/final-2/summary.json)、[对照](checks/final-compare.json)）。

### 负对照

同一个补丁（[nc-1px.diff](tools/nc-1px.diff)）在最终的树 `f9fd37def` 上以临时提交 `52c43aed9`（只留在本地分支 `p0d7/negative-control-1px`，不交付）运行（[negative-control.sh](tools/negative-control.sh)，作业 `bgj_05f214917eb5`）：
- 侧栏 Infrastructure 一行的文字 `marginLeft: 1`（A12 新登记的那一行）；
- 回合脚注 `.chat-turn-foot` 的左内边距 12px → 13px（A13 新登记的那一行）。

| 对照 | 结果 | 记录 |
| --- | --- | --- |
| P0 原命令 | 112 个测试：61 通过、11 跳过、**40 失败**，退出码 1。**40 个失败都停在本批登记的截图上**：task-detail、projects-list、wiki-home、settings、profile、projects-loading、projects-error（A12，各 4 个桌面项目）；session-idle（桌面 4 个是 A12+A13+A14，手机 4 个是 A13+A14）；breakpoint-959-session（A13+A14，4 个）。差异 97–339 像素。期望组装同为 44 / 183 / 25，没有 `unhandled` | [checks/negative-control-1px](checks/negative-control-1px/summary.json)、[分析](checks/negative-control-1px/analysis.json) |
| update 模式完整矩阵（`fix` 运行器），对照登记后的期望 | 本批登记的 132 张里 **128 张不通过比较器**（419–2614 像素），**其余 120 张没有一张失败**。没检出的 4 张是桌面的 project-graph-fullscreen：全屏对话框盖住了侧栏，只露出最左边 16 像素宽的一条，移动的那行字不在可见区域，与不加补丁时相同 | [runs/full-negative-control-1px](attribution/runs/full-negative-control-1px/meta.json)、[比较](compare/registered__full-negative-control-1px.json) |

- 结论：新登记截图上超出登记内容的 1 像素改动，P0 原命令照样失败；已接受层重登和首次登记的条目（task-share-dialog、task-action-menu、settings-saved、profile-validation、notification-error）也都在 128 张里。
- 差异图样例：[settings（chromium-light-desktop，侧栏那一行）](checks/negative-control-1px/failures/pages.browser.mjs-settings-chromium-light-desktop/settings-diff.png)、[session-idle（chromium-light-phone，回合脚注）](checks/negative-control-1px/failures/pages.browser.mjs-session-chromium-light-phone/session-idle-diff.png)。

### P4.2 用例

命令同 P4.2 README「复现」和 P4.3b 的 formal.sh：在被测检出的 `src/web` 下 `P42_SNAPSHOTS=<dir> P42_OUTPUT=<dir> npx playwright test --config ui-migration/p42.config.mjs --update-snapshots=all`（截图写入临时目录，供以后各批的起点对照比较；每一步和每条断言都要成立），独立网络命名空间（[p42-run.sh](tools/p42-run.sh)、[p42-final.sh](tools/p42-final.sh)）。

| 运行 | 树 | 结果 | 记录 |
| --- | --- | --- | --- |
| 原用例（维护之前） | 新基础 `17980cb7c`（`/mnt/data` 检出 `wt/base`，P0 原命令 pretest 的构建） | 140 通过、**40 失败**、4 跳过（作业 `bgj_b50167e81e42`）。失败的正是那 5 个用例，每个在 8 个环境各一次；其余 18 个用例全部通过 | [checks/p42-base-original](checks/p42-base-original/summary.txt) |
| 维护之后 | 最终的树 `f9fd37def`（`wt/base` 检出后按 pretest 重新构建，产物与 `896226a23` 的精简构建相同） | **180 通过、0 失败**、4 跳过（作业 `bgj_89b05bbb913c`）。维护的 5 个用例在 8 个环境都通过；跳过的 4 个是手机上的「页面自己的按钮：静止、悬停、按下」（触屏没有悬停），与 P4.2 证据相同 | [checks/p42-final](checks/p42-final/summary.txt) |

- 维护后的「runners › the list」在每个环境都走完了全部步骤：读取中、列表、菜单、改名、轮换 token、新 token、删除问句、删除、空列表，trace 里每一步的地址都是 `/infrastructure`。
- 最终的树上 P4.2 的页面不读 `GET /api/auth/capabilities`（托管 runner 的读取只在工作区控制台、空列表时的默认落地页和初始化页），所以 P4.2 的固定数据不需要补；运行里没有 `unhandled`（有就会在用例结束时失败）。

### 合并检查

在会话工作树里运行项目的合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web`（[merge-check-root.sh](tools/merge-check-root.sh) 调用 [merge-check.sh](tools/merge-check.sh)，包在 6G 的 cgroup 里，作业 `bgj_9ebe701cd09f`），退出码 0：
- **树**：`b767ba002`（最终的树 `f9fd37def` 加 p0-drift README 的固定数据清单，只改文档），运行时唯一未跟踪的路径是本目录（`status: 1 changes`）。Web 测试里只有 `RunnerEngines.antigravityGoogle.test.tsx` 读 `docs/evidence` 下的文件（antigravity-google-login 的夹具），与本批无关，所以证据提交不影响这个结果。
- **依赖**：`bash scripts/worktree-overlay.sh`，按锁文件隔离安装，`@orbit/shared` 解析到这棵树自己的 `src/shared/dist`（[overlay.txt](checks/merge-check-final/overlay.txt)）。
- **结果**：`tsc -b && vite build` 成功（4575 个模块，保留原有的大 chunk 提示）；Vitest **380 个文件、4961 个用例全部通过**，用时 306 秒（[过滤后的输出](checks/merge-check-final/output-filtered.txt)，完整输出 `output-full.txt.gz`）。
- **磁盘**：开工时根分区不到 6 GB，所以浏览器运行都放在 `/mnt/data`。运行合并检查时根分区回到 7792 MB，按作业指导允许的「依赖叠加」在会话工作树（NVMe）上跑：叠加后 6894 MB，跑完 4430 MB（同时有其他会话在写根分区）；跑完后删掉了这份依赖和构建产物，根分区回到 5328 MB（[disk.txt](checks/merge-check-final/disk.txt)）。

### 在最新 main 的临时合并树上

交证据前 origin/main 又前进到 `ec881f633`（`896226a23` 之后 23 个提交）。`git merge-tree` 干跑没有冲突，main 没有改本批的文件；它改到的 Web 构建输入只有 `index.css` 去掉 `.start-card { max-width: 720px }`（`f573a1c8a`：项目启动卡片在会话里的宽度），另有两个测试文件（`ProjectDependencyGraph.test.tsx`、`p43b-cards.browser.mjs`）和 shared 的两个测试夹具。按「跟上 main」，main 只改到本批依赖的全局层（`index.css`）时不 rebase，在临时合并树上跑标准 P0：临时提交 `417f13e9c`（本批 tip `b767ba002` 与 `ec881f633` 的 `merge-tree` 加 `commit-tree`，只留在本地分支 `p0d7/maintree-ec881f633`，不交付）上运行 P0 原命令（作业 `bgj_848ab608e246`）：112 个测试，**101 通过、11 个已记录的跳过、0 失败**，退出码 0；期望组装同为 44 / 183 / 25，环境记录与 P0.2 相同，检出干净，没有 `unhandled`（[checks/maintree-ec881f633](checks/maintree-ec881f633/summary.json)）。P4.2 的页面、用例和公共组件都不在 main 这段改动里，由落地时的合并检查兜底。

## 跟上 main 与 audit

- **开工时**：项目 tip `17980cb7c` 已合并 origin/main `87351bf9a`，那时 origin/main 就是它，没有可带进来的内容；`audit-antd.mjs --check-owners` 在 `17980cb7c` 上 0 未归属、0 待定（[checks/audit/audit-17980cb7c.txt](checks/audit/audit-17980cb7c.txt)）。
- **最终轮之前跟上一次**：登记完成时 origin/main 已前进到 `896226a23`（`776212132` 晋升了项目 tip `17980cb7c`，`59034ad63` 合入 C7 的托管 runner，`251c3de8f` 合入 T3 的 provider-engine，`896226a23` 合入 Android）。`git merge-tree` 干跑没有冲突；项目 tip 已在 origin/main 里，按「跟上 main」把本批两个提交直接 rebase 到 `896226a23`（`git range-diff` 显示补丁相同）。`896226a23` 的完整矩阵与新基础 `17980cb7c` 0 张变化（WebKit 全部逐字节相同），只多了一条未建模的请求，补了一条固定响应（见「固定数据维护」）。最终的两轮、负对照、P4.2 用例和合并检查都在 rebase 之后的树上。
- **audit**：跟上之后在 `f9fd37def` 上运行 `node src/web/scripts/audit-antd.mjs --check-owners`，退出码 1：2 个未归属、0 待定（[checks/audit/audit-f9fd37def.txt](checks/audit/audit-f9fd37def.txt)），都是 main 托管 runner 工作（`94025579b`、`d0db4e889`，经 `59034ad63` 进入 main）带来的测试文件：`src/web/src/App.managedRunner.test.tsx`、`src/web/src/components/WorkspaceView.managedRunner.test.tsx`。本批是漂移登记，没有迁移范围，按作业指导报告协调者（2026-10-09 16:3x UTC，`project_send`）。**协调者答复：这两点已由 P4.4 先报上来并判定**——`App.managedRunner.test.tsx` 在 P4.4 的 App.tsx 范围内，P4.4 去掉 antd 的 App 包裹后使用点随之消失；`WorkspaceView.managedRunner.test.tsx` 归 P5.3，由 P4.4 写记录 2026-10-09c；本批与 P4.4 谁先落地都可以，P4.4 落地后清零。同一答复接受了 `GET /api/auth/capabilities` 的固定路由，要求证据写明取值依据、新增请求的 main 提交和截图不变（见「固定数据维护」）。
- **交证据前再看 main**：交证据前 origin/main 又前进到 `ec881f633`，干跑无冲突，只改到 `index.css` 的启动卡片规则；按规则在临时合并树上跑了标准 P0，0 失败，见「验证」的「在最新 main 的临时合并树上」。没有再 rebase。

## 不变的部分

本批在 origin/main `896226a23` 之上有 5 个线性提交：P4.2 用例 `200a9fc7c`、登记 `416b29c22`、固定响应 `f9fd37def`、p0-drift README 的固定数据清单 `b767ba002`，最后一个提交只在本目录增加证据文件。

核对办法：在本分支上 `git diff --stat 896226a23 HEAD -- docs/evidence/base-ui-migration/p0.2 src/web/src src/shared src/web/ui-migration/{known-failures,pages,states,breakpoints}.browser.mjs src/web/ui-migration/{page-scenarios,session-scenarios,session-fixtures,harness,playwright.config,expected-screenshots,environment}.mjs package-lock.json` 输出为空。也就是说：
- P0.2 的 252 张原图、原断言、known-failures、截图比较选项（`maxDiffPixels: 0`、默认 threshold）和容差都没改；场景、harness、期望组装和环境校验都没改；
- 产品代码和 shared 没改；`fixtures.mjs` 只多一条路由和 4 行注释（`git diff 896226a23 HEAD -- src/web/ui-migration/fixtures.mjs` 只有 5 行新增），已有路由一条没动；
- 改了的只有：`p42.browser.mjs`、`p42-fixtures.mjs`（P4.2 用例的导航与定位）、`fixtures.mjs`（1 条路由）、`p0-drift/README.md`（两个登记层的清单、固定数据清单）、`p0-drift/reference/`（74 条替换、42 条新登记）、`p0-drift/accepted/`（18 次登记，3 条新条目）和本目录。
- OrbitKit 的 *CopyParityTests 逐字读取 `src/web` 的产品源文件；本批没有改任何产品源文件，所以没有跑 swift 套件。

## 证据体积

按作业指导「证据体积」：
- **Playwright 报告**：不提交 `report.json` 和 `trace.zip`。正式运行、负对照、合并树上的 P0 和 P4.2 运行改交同目录的 `report.summary.json`（[report-summary.py](tools/report-summary.py)：只删附件正文，用例标题、项目、状态、耗时、重试、错误信息和附件路径都保留）。
- **归因运行**（28 次）只交 `meta.json`（树、运行器、参数、起止时间、退出码、统计、环境核对）、`snapshots.sha256`（每张截图的 SHA-256）、`evidence-digest.json`（每个用例截到的截图、请求、`unhandled`、页面异常）和环境记录的哈希；报告摘要只留 README 引用其失败的两次（`full-33e0e2e09`、`full-896226a23`）。
- **截图**只提交 README 引用的：开工时和负对照各 2 张差异图，7 张前驱/X 对照图。逐张比较结果在 [compare/](compare/)。
- **体积**：本目录约 14 MB、302 个文件（含本 README）；本批前 4 个提交新增的文件（主要是 116 张参考图、18 次登记的 before/after 原件和两个 registry）约 12.3 MB；合计约 26 MB，不到 30 MB。比例最大的是 [attribution/runs/](attribution/runs/)、[checks/](checks/) 和 [compare/](compare/)。
- **完整原始运行**：截图、报告原文、trace 和全部 evidence.json 留在 `/mnt/data/tmp/34cswWfvNasFTq8kDM0Q4/`（`runs/`、`checks/`、两个 worktree 和临时分支 `p0d7/*`），到证据判定后再清理。

## 缺口与边界

- **P4.2「runners › the list」读取中这一步**：原用例断言列表读取时 Spin/Orbit Spinner 可见。main `33e0e2e09` 把列表搬进 Infrastructure 页的 Machines 一节，这一节在列表读取期间不画任何加载指示，列表回来之前直接显示空列表的邀请（“Already pay for Claude, Codex or Kimi?”），这是 main 的产品行为，本批不改。所以这一步无法再证明「读取时有转圈」，改为断言：请求被扣住时这一节已画出、没有机器卡片、邀请可见，并截这一节。其余步骤要证明的行为都不变。这一步是否接受，或者 main 的 Machines 一节在读取期间应不应该有加载状态，由协调者判断。
- **已接受层的 3 条首次登记**：深色桌面的 task-action-menu 2 张、WebKit 明色手机的 notification-error 1 张，原来只对照 main 漂移参考或 P0.2 原图，带着一项已 CONFIRM 但低于阈值、没有登记的迁移差异。本批没有在 main 漂移层为它们生成参考图（会把迁移像素放进 main 漂移层），而是按已接受层第 6 条第二种情况的做法叠加登记，引用 P3.2、WebKit 滚动锁的原判定。第 6 条写的是「已有已接受登记的页面」，这 3 张此前没有条目，属于延伸适用，请协调者确认。
- **引用的是原判定**：按任务说明，重登的条目引用原判定（P3.2 第 2 版、WebKit 滚动锁第 1 版），旧条目在 `previous`。p0-drift README 已接受层第 6 条写的是「协调者 CONFIRM 后按第 3 条重登，引用这次的判定」；本批的判定在提交证据之后才有，所以这些条目没有引用本批的判定。协调者若要求引用本批判定，CONFIRM 之后可以用同一工具和同一组原件重登一次。
- **A14 在已接受层停在 A13**：A14 对已接受层 4 张 notification-error 的变化低于阈值，登记工具不收，这 4 张的期望不含 A14（比较器照常通过）。main 漂移层的会话页参考图含 A14。
- **P4.3b 的 1 级差异**：WebKit 桌面 project-graph-fullscreen 2 张，P4.3b 让它们差 9、17 个像素（单通道差 1），低于阈值，没有登记在任何一层（P4.3b 自己的证据已记录）。新基础对照本批在 `cbe6a6635` 上生成的参考图只差这 1 级。
- **下钻里的旧树**：`33e0e2e09`、`db69d833b` 是 10-07 的树，在 P4.1 进 main 之前。`tip` 运行器的 settings、profile 场景等 P4.1 的 `.orbit-card`，这两个用例在这两棵树上失败，只截到 220 张；这 16 张截图用这两棵树当时的 P0 测试（`old` 运行器）补跑。两个运行器只差定位器，截到的是同一页面状态。
- **只跑三层的提交**：main 区间里没有改 Web 构建输入的提交，产物与前一个提交相同，没有单独运行（第 1、5 批的做法）；改了构建输入的 11 个都构建了，产物不同的都跑了完整矩阵。
- **固定响应只覆盖默认状态**：P0 的服务端不开托管 runner，会话页不画托管 runner 的界面。托管 runner 的各种状态由 `94025579b` 自己的单测和 shared 的状态夹具覆盖，P0 不覆盖；P5 迁移会话页时如需 P0 覆盖，要另加场景和固定数据。
- **精简构建树**：候选提交用 `git archive` 取出的精简树加共享依赖构建，用 `17980cb7c` 核对过产物与 worktree 里正常构建逐字节相同，没有对每个候选提交都和完整工作树比较。
- **其余边界同 P0.2**：Linux 固定环境、合成 REST/SSE、非真机 iOS。

## 复跑

```sh
bash scripts/worktree-overlay.sh
NO_COLOR=1 npm run test:ui-migration -w @orbit/web
npm run build -w @orbit/web && npm run test -w @orbit/web
cd src/web && P42_SNAPSHOTS=<dir> P42_OUTPUT=<dir> npx playwright test --config ui-migration/p42.config.mjs --update-snapshots=all
```

归因复算（脚本在 [tools/](tools/)，写着 `/mnt/data/tmp/34cswWfvNasFTq8kDM0Q4` 和本工作树的路径，复跑时按环境调整）：
- 构建：`prepare-tree.sh <提交> [标签]`；运行器：`make-runner.sh <提交> <名字> <同 shared 的已构建树>`（`make-runner-old.sh` 用于没有两个登记层的旧树）；
- 运行：`lane.sh <树>...`（每棵树一次 update 模式完整矩阵，可续跑），单次 `run.sh <树> <运行器> <标签> [playwright 参数]`；
- 比较：`pairs.sh <a> <b> ...`；逐张归因 `attribution.py <工作树> <out.json> <out.md>`；下钻 `drill.sh`；侧栏列对照 `regions.py`；
- 登记：`make-reference.py <工作树> <spec.json>`（[spec-a12.json](tools/spec-a12.json)、[spec-a13-a14.json](tools/spec-a13-a14.json)），`register-accepted7.sh a12|a13`；
- 正式两轮 `final-rounds.sh <提交> <前缀> [checkout]`；负对照 `negative-control.sh <提交> <补丁> <名字> [checkout]` 与 `nc-analysis.py`；P4.2 用例 `p42-run.sh <checkout> <标签>`；合并检查 `merge-check.sh <树> <输出>`。
