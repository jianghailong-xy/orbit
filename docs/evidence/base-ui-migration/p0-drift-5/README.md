# P0 漂移登记（第 5 批）：Wiki 分享请求与设置页下一句建议

本目录服务于任务 [P0 漂移登记（第 5 批）：Wiki 分享请求与设置页下一句建议](orbit-task:34cFgyWHIYDslABFPloEM)，对应项目验收条目 key `5wbhutjez7Qv5GCTNLb0P7`：**P7：完整迁移通过最终构建、行为与视觉回归，并有实测收益和可回退交付记录。**

按 [p0-drift README](../p0-drift/README.md)「维护规则」main 漂移参考第 3 条，这是协调者另建的「P0 漂移登记」任务。起因是「浮层第一帧位置」（[34broktJh4EJXI1eiF7Jm](orbit-task:34broktJh4EJXI1eiF7Jm)）2026-10-08 报告的 20 个 P0 失败。规则、两个登记层和维护清单都在 p0-drift 目录；本目录是这一批的失败清单、固定数据的取值依据、逐张归因、登记清单、验证和原始记录。

## 结论

| 项目 | 结果 |
| --- | --- |
| 开工时的失败 | 开工时的新基础是 origin/main `4d77d69b7`，项目 tip `1d3cd4c70` 已在其中。在它上面跑 P0 原命令（作业 `bgj_5a0d26529fa9`）：112 个测试，81 通过、11 个已记录的跳过、**20 失败**，与起因报告的数目一致。20 个都停在截图比较：wiki-home ×8、breakpoint-959-wiki ×4（桌面）、settings.png ×8。12 个 Wiki 用例的 `unhandled` 都只有 `GET /api/wiki/spaces/<id>/share`，但截图比较在前，用例结束时的固定数据校验没有执行到。交证据前 origin/main 两次前进，本批先后 rebase 到 `93ab20b8c`、`075b7a6c8`：不带本批提交的 `93ab20b8c` 上同一命令（作业 `bgj_d16d78d399e4`）是同一组 20 个失败，像素数逐个相同；`075b7a6c8` 的完整矩阵与 `93ab20b8c` 0 张变化。 |
| 完整失败面 | 用 update 模式把 252 张截全，再对照当前期望（88 张 P0.2 原图、150 张 main 漂移参考、14 张已接受差异）：**44 张**不通过 P0 比较器，即 Wiki 28 张（wiki-home ×8、wiki-new-entry ×8、wiki-contents ×4、breakpoint-959-wiki 与 breakpoint-961-wiki 各 ×4）和设置页 16 张（settings、settings-saved 各 ×8）。另有 11 张低于阈值，都是 P3.2 已记录的差异，与本批无关。`93ab20b8c`、`075b7a6c8` 上的完整失败面与此相同，三者的 252 张两两之间都是 0 张变化。 |
| 固定数据维护 | `48ebd321c`（两次 rebase 前依次为 `82247962c`、`2c4702656`，`fixtures.mjs` 逐字节相同）：只在 `fixtures.mjs` 加一条精确路由 `GET /api/wiki/spaces/<id>/share` → `{ link: null, counts: { documents: 0, footnotes: 0 } }`，引用新增该请求的 main **`2ba6765d9`**。取值是服务端对没人分享过的空间的回答，`counts` 与已有的 `/docs` 固定数据一致；依据写进 p0-drift README（`6e197ab9b`）。补了这条响应，新基础上 12 个用例的 `unhandled` 都变成空的，截图 0 张变化。 |
| 归因 | 44 张全部归因到单个 main 提交，每张都有项目线、main first-parent 线和单提交的同环境证明，0 张归因不到 main：<br>• **A10** main `2ba6765d9`（Wiki 页头加 Share 按钮）：Wiki 28 张。项目线 `f991d2421` → `1d3cd4c70`（吸收 main，第二父就是 `2ba6765d9`）；main 线 X^1 `7cc52e0cf` 与当前期望 28 张逐字节相同 → X 28 张都变；X 与项目 tip、新基础相同。<br>• **A11** main `def134095`（设置页加 Suggested replies 一行）：设置页 16 张。项目 tip `1d3cd4c70`（经 `3e25635e5` 原样晋升进 main）不变 → 新基础变；main 线 X^1 `ebf5e6441` 不变 → X 16 张都变；新基础与 X 逐字节相同。 |
| 登记 | 2 个登记提交，各只改 `p0-drift/reference/` 和 p0-drift README 的清单：`6a73b0cce`（A10，替换 Wiki 28 条）、`3a36ab949`（A11，替换设置页 16 条）。都按第 6 条在原条目的 `mainCommits` 末尾追加，`generatedFrom` 改为 X，参考图在 X 的树上用补了固定响应的 P0 测试生成，环境等于 P0.2。参考层仍是 164 条，期望组装仍是 88 / 150 / 14。设置页的 WebKit 6 张另把第 2 批记录过、低于阈值的 A6 `d233a6cd0` 滚动条写进 `mainCommits`（见「登记清单」）。 |
| 迁移代码 | 两棵生成树都含已晋升的迁移代码（设置页含 P4.1 的迁移），但前驱树对照当前期望都通过比较器：Wiki 28 张逐字节相同，设置页只差 A6 的滚动条和 Chromium 噪声。所以迁移代码没有改变这些截图，登记的只有 main 改动；没有把迁移改动登记为漂移。 |
| 已接受层 | 已接受层 14 条替换的截图（task-share-dialog ×8、task-action-menu ×4、profile-validation ×2）都不在这 44 张里，`replaces` 仍然匹配，没有失效条目，不需要重登。 |
| 两轮完整 P0 | 在最终的树 `3a36ab949`（origin/main `075b7a6c8` 加本批 4 个提交）上连续两轮 P0 原命令（作业 `bgj_f89a9296c100`）：每轮 112 个测试，**101 通过、11 个已记录的跳过、0 失败、0 flaky**，退出码 0，两轮逐项一致；本批登记的 44 张全部通过，没有 `unhandled`，没有页面异常。第一次 rebase 后，在 `6fb78dd11`（`93ab20b8c` 加同样 4 个提交）上也跑过两轮（作业 `bgj_92f11b7e81b6`），结果相同：每轮 101 通过、11 个已记录的跳过、0 失败、0 flaky，两轮逐项一致。 |
| 负对照 | 同一个 1 像素补丁（Wiki 页头 Share 按钮左边距、设置页第一张卡片下边距）在最终树 `3a36ab949` 上以临时提交运行 P0 原命令：**20 个失败，全是新登记的截图**（breakpoint-959-wiki ×4、wiki-home ×8、settings ×8，136–4116 像素），其余与正式回归相同。update 模式下 44 张新登记的截图有 40 张检出这 1 像素，另 4 张（手机 wiki-contents）补丁改不到可见区域、逐字节相同，没有别的截图失败。第一次 rebase 后的树上同样的负对照结果相同。 |
| 合并检查 | 在最终的树上（`c87fe3bde`，`src/` 与 `3a36ab949` 相同）运行 `npm run build -w @orbit/web && npm run test -w @orbit/web`（作业 `bgj_3d568672eea1`），退出码 0：构建成功，保留原有的大 chunk 提示；Vitest **368 个文件、4753 个用例全部通过**。 |
| 跟上 main | 开工时快进到 origin/main `4d77d69b7`；交证据前 origin/main 两次前进，本批先后 rebase 到 `93ab20b8c`、`075b7a6c8`，两次都先查完整矩阵（0 张变化、没有新的未建模请求），最终的两轮、负对照和合并检查都在 `3a36ab949`（`075b7a6c8` 加本批 4 个提交）上。`audit-antd.mjs --check-owners` 在新基础上有 14 个没有归属的使用点（项目 tip 上已有 12 个），本批是漂移登记、没有迁移范围，已报告协调者（见「跟上 main 与 audit」）。 |
| 不变的部分 | P0.2 的 252 张原图、原断言、known-failures、截图比较选项和容差、已接受层、产品代码，以及 `fixtures.mjs` 已有的路由，都没有改（核对命令见「不变的部分」）。 |

## 执行经过

- **起点**：项目分支 `refs/heads/project/34ZZeq0e3IR65GVm2kAs7` 的 tip 是 `1d3cd4c70`（Merge refs/heads/main into refs/heads/orbit/p2-2-popconfirm-dialog-antd-018e48），已经全部在 origin/main 里（`git merge-base --is-ancestor` 成立），所以按作业指导「跟上 main」直接放到 origin/main 上：开工时是 `4d77d69b7`，本批分支从它快进开始。
- **交证据前再跟上**：登记完成后，origin/main 先前进到 `93ab20b8c`（两次合入项目 34bZ3i4AvgJaaoaw5E9tH 的 OpenCode 与 Providers 改动），之后又前进到 `075b7a6c8`（合入项目 34bmzOkov3xN2yLPrnsCk 的 Wiki 服务端执行改动）。本批 4 个提交两次 rebase 上去，都没有冲突；`fixtures.mjs`、P0 测试目录（`src/web/ui-migration` 树 `a4e6fa71…`）、p0-drift 目录和锁文件在 main 这两段都没有改动。每次 rebase 后先在新基础上跑完整矩阵确认没有新的漂移（见「新基础 `93ab20b8c` 与 `075b7a6c8`」），最终检查都在 `3a36ab949` 上做（见「验证」）。
- **磁盘**：开工时根分区只剩 5.5 GB，低于作业指导的 6 GB。按「共享主机磁盘」，浏览器运行、构建、依赖和运行原件都放在 `/mnt/data/tmp/34cFgyWHIYDslABFPloEM/`：两个 `git worktree`（一个跑正式运行和负对照，一个跑不带本批提交的 `93ab20b8c`），各自按锁文件隔离安装依赖；还有精简构建树、运行器和全部运行原件。唯一的例外是最终的合并检查，见下一条和「合并检查」。
- **负载与合并检查的位置**：本机 24 核、15 GB 内存，有其他会话占用，1 分钟负载在 18–45 之间，可用内存常在 4 GB 左右，交换区用得很满。`/mnt/data` 是机械盘，Vitest 的工作进程在那里每个测试文件都要从盘上读一两百 MB 依赖，多在等磁盘：第一次 rebase 后在 `6fb78dd11` 上的合并检查跑了 17 分钟没结束，那时 origin/main 已再次前进，那棵树不再是最终的树，所以停掉；最终的树 `3a36ab949` 在 `/mnt/data` 上又跑了 15 分钟，同样停掉。最后按作业指导允许的「依赖叠加」，在会话工作树里用 `bash scripts/worktree-overlay.sh` 隔离安装依赖（主工作区的 node_modules 与锁文件不符），根分区从 7037 MB 降到 6139 MB，仍在 6 GB 以上，合并检查在 NVMe 上运行；跑完后删掉了这份依赖（见「合并检查」）。
- 由 Claude Opus 5.5 执行。没有推送 main 或项目分支，没有部署或发布。

## 环境与方法

- **依赖**：在 `/mnt/data` 的 worktree 里按锁文件隔离安装：`npm ci --offline --ignore-scripts --include=dev --include=optional`，与 `scripts/worktree-overlay.sh` 的隔离安装同一命令（[setup-base.sh](tools/setup-base.sh)）。本批涉及的所有提交 `package-lock.json` 都相同（blob `f03a6e32…`）。`@orbit/shared` 解析到该树自己的 `src/shared`。
- **环境**：每次浏览器运行都由 P0 的 `environment.mjs` 与 [P0.2 environment.json](../p0.2/environment.json) 逐字段比较并通过：Debian 13.7、Node v26.10.0、Playwright 1.63.0（Chromium 1243 / WebKit 2359）和字体文件哈希。每次运行写出的 environment.json 都与 P0.2 记录逐字节相同，SHA-256 `fe69e824…`（[attribution/environments/](attribution/environments/runs.sha256)）。
- **精简构建树**：归因用的候选提交沿用第 2、3 批的做法（[prepare-tree.sh](tools/prepare-tree.sh)）：`git archive` 取出 Web 构建会读的文件，依赖共用上面那份安装，`@orbit/shared` 链接到这棵树自己的 `src/shared`，再按 `pretest:ui-migration` 构建。核对：这样构建的 `4d77d69b7`，产物 23 个文件与 worktree 里 P0 原命令 pretest 构建的逐字节相同（[dists/base.sha256](attribution/dists/base.sha256)、[dists/wt-base-pretest.sha256](attribution/dists/wt-base-pretest.sha256)）。
- **运行器**：P0 测试从运行器目录运行，被测树只提供生产构建和 `npm run preview`（[p0d5.config.mjs](tools/p0d5.config.mjs)，与第 3 批的 p0d3.config.mjs 相同）。两个运行器（[make-runner.sh](tools/make-runner.sh)）：
  - `orig`：`4d77d69b7` 的 P0 测试，就是没有新固定响应的原测试；本批涉及的所有提交 P0 测试目录都相同（`a4e6fa71…`）；
  - `fix`：`82247962c` 的 P0 测试，与 `orig` 只差那一条固定响应（`fixtures.mjs` blob `31708943…`，与 rebase 后的 `48ebd321c` 相同）。
- **运行方式**：完整矩阵就是 pages、states、breakpoints 三个文件，共 80 个测试、252 张截图。截图写入空的临时目录（`--update-snapshots=all`），每张都能截到，再逐张比较；固定数据校验、定位和页面异常照常判定。每次运行都放在独立网络命名空间里（`unshare -n`），保持 P0 的 `http://127.0.0.1:4173`（[run.sh](tools/run.sh)）。
- **请求记录**：harness 在每个测试结束时（失败也写）把 `requests`、`unhandled`、`captures`、`pageErrors` 写进 evidence.json。每次运行按测试摘成 `evidence-digest.json`（[evidence-digest.py](tools/evidence-digest.py)，只去掉计算样式和计时），[fixture-chain.py](tools/fixture-chain.py) 再汇总成 [attribution/fixture-chain.json](attribution/fixture-chain.json)。
- **比较与噪声**（[compare.cjs](tools/compare.cjs)，与第 2、3 批相同）：逐像素差异，加上 P0 比较器在 `maxDiffPixels: 0`、默认 threshold 下的结论。按 p0-drift README「Chromium 渲染噪声」判定「变化」：比较器不通过，或 WebKit 有任一像素不同，或 Chromium 单通道差超过 4 或超过 200 像素。其余记为噪声。每组比较的汇总在 [compare/summary.json](compare/summary.json)。
- **正式运行**：P0 原命令 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web` 在 `/mnt/data` 的 worktree 里运行，放在独立网络命名空间里（[round.sh](tools/round.sh) 调用 [netns-regression.sh](tools/netns-regression.sh)）。
- **记录**：每次运行的树提交、运行器提交、参数、起止时间、退出码、环境核对、每张截图的 SHA-256、evidence 摘要、命令输出和去掉附件正文的 Playwright 报告 `report.summary.json`，都在 [attribution/runs/](attribution/runs/)；正式运行在 [checks/](checks/)。

## 失败清单

### 开工时：`4d77d69b7`

在 `4d77d69b7` 上运行 P0 原命令（作业 `bgj_5a0d26529fa9`，[checks/base-start](checks/base-start/summary.json)）：共 112 个测试，81 通过、11 个已记录的跳过、**20 失败**、0 flaky，退出码 1。期望组装输出 `P0 expected screenshots: 88 P0.2 originals, 150 main drift references, 14 accepted migration differences.`，环境记录与 P0.2 逐字节相同。

| 用例 | 项目 | 停在 | 期望来源 | Playwright 报告的差异像素 |
| --- | --- | --- | --- | --- |
| 断点巡检 | 4 个桌面项目 | breakpoint-959-wiki.png | main 漂移参考（第 2 批 A7、A8） | C-dark 864、C-light 926、W-dark 858、W-light 932 |
| wiki | 8 个项目 | wiki-home.png | main 漂移参考（第 2 批 A7–A9） | C-dark-desktop 695、C-dark-phone 313、C-light-desktop 749、C-light-phone 323、W-dark-desktop 686、W-dark-phone 316、W-light-desktop 751、W-light-phone 324 |
| settings | 8 个项目 | settings.png | main 漂移参考（第 1 批 A4） | C-dark-desktop 14811、C-dark-phone 5431、C-light-desktop 14015、C-light-phone 5182、W-dark-desktop 14813、W-dark-phone 5389、W-light-desktop 14130、W-light-phone 5153 |

- **都停在截图比较**：12 个 Wiki 用例（wiki 8 个、断点巡检 4 个）的 evidence.json 里 `captures` 都停在 Wiki 截图之前，`unhandled` 都只有 `GET /api/wiki/spaces/2zwQZ2hd93IvLb59t6pDl/share`（[evidence-digest.json](checks/base-start/evidence-digest.json)）。harness 在场景跑完后才做固定数据校验，截图先失败，所以校验没有执行到。起因报告说这 12 个「停在固定数据校验」；本批在同一基础上看到的是截图在先、请求在 `unhandled` 里。update 模式下截图都写得出来，这 12 个才停在固定数据校验（见「归因」）。
- **被挡住的截图**：断点巡检的 959-session、961-wiki、961-session（各 4 张），wiki 的 wiki-contents（手机 4 张）和 wiki-new-entry（8 张），settings 的 settings-saved（8 张）。它们在完整失败面里一并处理。
- **其余 81 个通过**：pages 40（task、share、projects、profile、session 各 8）、states 16、断点 0、P2.3 生产通知 8、P0.2-FOCUS-1/2 16、性能 1。**11 个跳过**：7 个非参考项目的性能采样、4 个手机项目的桌面断点巡检，与前几批相同。
- 差异图样例：[wiki-home chromium-light-desktop](checks/base-start/failures/pages.browser.mjs-wiki-chromium-light-desktop/wiki-home-diff.png)、[settings chromium-light-desktop](checks/base-start/failures/pages.browser.mjs-settings-chromium-light-desktop/settings-diff.png)。

### 完整失败面

失败的用例在第一处就停下。为了看到全部截图，用 update 模式在新基础上截全 252 张（[full-fix-base](attribution/runs/full-fix-base/meta.json)，补了固定响应的测试；不补时只差固定数据校验，截图相同，见「固定数据维护」），再对照当前期望（开工时组装的 252 张）逐张比较（[compare/expected__full-fix-base.json](compare/expected__full-fix-base.json)）：

| 结果 | 截图 | 张数 |
| --- | --- | ---: |
| 不通过 P0 比较器 | Wiki：wiki-home ×8、wiki-new-entry ×8、wiki-contents ×4（手机）、breakpoint-959-wiki ×4、breakpoint-961-wiki ×4（桌面） | 28 |
| 不通过 P0 比较器 | 设置页：settings ×8、settings-saved ×8 | 16 |
| 通过，低于阈值 | P3.2 已记录的 11 张：深色 task-action-menu 4 张，webkit-dark-phone 的 task-detail、task-action-hover、task-action-focus，WebKit 桌面的 breakpoint-599/601-dialog 4 张（见 [p3.2-accepted](../p3.2-accepted/README.md)） | 11 |
| 通过 | 逐字节相同 174 张，Chromium 噪声 23 张（≤110 像素，单通道差 ≤2） | 197 |

44 张就是本批要处置的全部截图。P3.2 的 11 张在本批涉及的每棵树上都一样（项目线 `f991d2421`、X^1 `7cc52e0cf` 对照当前期望同样是这 11 张，像素数逐个相同），与本批无关，不登记。

### 新基础 `93ab20b8c` 与 `075b7a6c8`

交证据前 origin/main 先前进到 `93ab20b8c`，本批 rebase 上去。在不带本批提交的 `93ab20b8c` 上重做了开工时的检查：
- **P0 原命令**（第二个 worktree，作业 `bgj_d16d78d399e4`，[checks/base2-start](checks/base2-start/summary.json)）：112 个测试，81 通过、11 个已记录的跳过、**20 失败**，与 `4d77d69b7` 上是同一组失败，Playwright 报告的差异像素数逐个相同；12 个 Wiki 用例的 `unhandled` 同样只有分享请求，没有页面异常。期望组装和环境记录同上。
- **完整失败面**（update 模式，[full-orig-base2](attribution/runs/full-orig-base2/meta.json)、[full-fix-base2](attribution/runs/full-fix-base2/meta.json)）：orig 运行器 64 通过、12 失败（只有这条请求），fix 运行器 76 通过、0 失败。对照当前期望，同样是那 44 张不通过比较器、P3.2 的 11 张低于阈值。与 `4d77d69b7` 的 252 张相比 **0 张变化**：237 张逐字节相同，15 张 Chromium 噪声（≤29 像素，单通道差 ≤2），WebKit 全部逐字节相同（[compare/full-fix-base__full-fix-base2.json](compare/full-fix-base__full-fix-base2.json)）。
- 所以 `4d77d69b7`..`93ab20b8c` 这一段 main 没有带来新的漂移，也没有新的未建模请求；归因和登记不受影响。

之后 origin/main 又前进到 `075b7a6c8`（合入项目 34bmzOkov3xN2yLPrnsCk：Wiki 服务端执行，`WikiPage.tsx` 改了 1 行，新增 `/wiki/system-model`、`/wiki/spaces/:id/jobs` 两个查询，分别给 Wiki 设置页和 Activity 用），本批再 rebase 上去：
- **完整矩阵**（update 模式，[full-orig-base3](attribution/runs/full-orig-base3/meta.json)、[full-fix-base3](attribution/runs/full-fix-base3/meta.json)）：orig 运行器 64 通过、12 失败（与 `93ab20b8c` 相同，`unhandled` 只有分享请求，没有页面异常）； fix 运行器 76 通过、0 失败，没有 `unhandled`：P0 的 Wiki 页面不读这两个新查询。与 `93ab20b8c` 的 252 张相比 **0 张变化**：237 张逐字节相同，15 张 Chromium 噪声（≤29 像素，单通道差 ≤4），WebKit 全部逐字节相同（[compare/full-fix-base2__full-fix-base3.json](compare/full-fix-base2__full-fix-base3.json)）。对照当前期望同样是那 44 张不通过比较器（[compare/expected__full-fix-base3.json](compare/expected__full-fix-base3.json)）。
- 所以 `93ab20b8c`..`075b7a6c8` 这一段 main 同样没有带来新的漂移或未建模请求。最终的正式检查都在 `3a36ab949`（`075b7a6c8` 加本批 4 个提交）上。

## 固定数据维护

**问题**：main `2ba6765d9` 让每个 Wiki 页面的页头读 `GET /api/wiki/spaces/<id>/share`。P0 固定数据没有这条路由，按 P0.2 的设计，没有建模的请求返回 501，并让用例在固定数据校验处失败。

**改动**：只有 `48ebd321c` 一处（两次 rebase 前依次为 `82247962c`、`2c4702656`），单独提交，只改 [fixtures.mjs](../../../../src/web/ui-migration/fixtures.mjs)：

```diff
     if (method === 'GET' && path === `/api/wiki/spaces/${space.id}/docs`) return json({ spaceId: space.id, plan: null, docs: { total: 0, written: 0 }, categories: [] });
+    // main 2ba6765d9 (docs(mocks): add wiki share mock for share-links, which also adds WikiShareButton to the
+    // Wiki head) made every Wiki page read GET /wiki/spaces/:id/share. The server's answer for a space nobody
+    // has shared (ShareLinksService.current): no link, and wikiShareCounts over the /docs directory above —
+    // no written documents, so no footnotes.
+    if (method === 'GET' && path === `/api/wiki/spaces/${space.id}/share`) return json({ link: null, counts: { documents: 0, footnotes: 0 } });
```

- **只补这一条**：方法和路径完全相同才命中；已有的固定数据、断言、截图比对、容差和期望图都没改；其余没有建模的请求照旧返回 501 并使校验失败。
- **引用的 main 提交**：`2ba6765d9` docs(mocks): add wiki share mock for share-links。标题只提设计稿，提交里同时有 Wiki 分享的服务端（`share-links` 的 WIKI 根、`public-wiki.ts`、迁移 `0403_share_link_wiki_space`）、iOS 和 Web 实现；Web 新增 `components/WikiShareButton.tsx`，并在 `pages/WikiPage.tsx` 的页头（`WikiFrame` 的 `.wk-actions`）挂上它，按钮挂载时就经 `api.ts` 的 `getShareLink('WIKI', spaceId)` 读这条路由。
- **取值依据**（也写在 p0-drift README「固定数据维护」的清单里，`6e197ab9b`）：
  - **服务端的默认回答**：`GET /wiki/spaces/:id/share` 由 `ShareLinksService.current(ownerId, 'WIKI', spaceId)`（`src/apiserver/src/share-links/share-links.service.ts`）回答 `{ link, counts }`。`link` 是空间还没结束的链接，只在所有者打开分享（Share 对话框发 `PUT /wiki/spaces/:id/share`，`put()` 调用的 `insert()` 是唯一新建链接的地方）后才有，所以没人分享过的空间是 `link: null`。`counts` 由 `wikiShareCounts`（`share-links/public-wiki.ts`）算：写好的文档数，和这些文档写好的段落里可以公开的脚注数。
  - **与已有固定数据一致**：`wikiShareCounts` 读的目录就是 `GET /api/wiki/spaces/<id>/docs` 回答的 `WikiDocs.directory`。已有固定数据是 `{ plan: null, docs: { total: 0, written: 0 }, categories: [] }`：没有确认的计划，也就没有写好的文档，所以服务端回答 `documents: 0, footnotes: 0`（没有写好的段落时直接 `footnotes: 0`）。已有的项目分享固定数据 `GET /api/projects/<id>/share` 也是没分享的状态 `{ link: null, counts: … }`；P0 账号唯一的分享链接是任务那条（`SHARE_TOKEN`），没有 Wiki 链接。
  - **页面因此显示什么**：`WikiShareButton` 在没有链接或链接已结束时画 Share 按钮（手机只有图标），有打开的链接时画「Shared · Live」胶囊；`counts` 只在 Share 对话框里显示，P0 场景不打开它。真实产品里，没分享过的空间页头显示 Share，P0 页面也是。取一个打开的链接，页头就成了 Shared · Live，不是 P0 账号的空间该有的状态。补固定响应之前请求得到 501、查询没有数据，按钮同样是 Share，所以固定响应不改变截图。
- **同环境证明**（[attribution/fixture-chain.json](attribution/fixture-chain.json)，每次运行都是完整矩阵 80 个测试）：

| 树 | 运行器 | 结果 | 读这条路由的测试 | `unhandled` |
| --- | --- | --- | --- | --- |
| X^1 `7cc52e0cf`（main first-parent） | orig | 76 通过、4 跳过、0 失败 | 0 | 空 |
| X `2ba6765d9` | orig | 64 通过、**12 失败**（wiki ×8、断点巡检 ×4，都停在用例结束后的固定数据校验）、4 跳过 | 12，各 2 次（wiki：1 次加上 React Query `retry: 1` 对 501 的一次重试；断点巡检：959、961 各打开一次 Wiki） | 12 个测试都只有这一条 |
| X `2ba6765d9` | fix | 76 通过、0 失败 | 12（wiki 每个 1 次，断点巡检每个 2 次：959 和 961 各一次） | 空 |
| 项目线 `f991d2421`（吸收 main 之前） | orig | 76 通过、0 失败 | 0 | 空 |
| 项目 tip `1d3cd4c70` | orig / fix | 同 X：12 失败，只有这一条 / 76 通过 | 12 | 只有这一条 / 空 |
| 新基础 `4d77d69b7` | orig / fix | 同 X：12 失败，只有这一条 / 76 通过 | 12 | 只有这一条 / 空 |
| 设置页的 X^1 `ebf5e6441`、X `def134095` | fix | 76 通过、0 失败 | 12 | 空 |
| 新基础 `93ab20b8c`、`075b7a6c8`（两次 rebase 后） | orig / fix | 同 X：12 失败，只有这一条 / 76 通过 | 12 | 只有这一条 / 空 |

  所有运行的 `pageErrors` 都为空。12 个失败的用例在 update 模式下都截到了全部截图（`captures`），失败只在固定数据校验。

- **补固定响应不改变截图**：同一棵树上 orig 与 fix 两个运行器逐张比较，0 张变化，WebKit 126 张全部逐字节相同：`2ba6765d9` 上 240 张逐字节相同、12 张 Chromium 噪声（≤35 像素）；项目 tip 上 235 张、17 张（≤50 像素）；新基础 `4d77d69b7` 上 246 张、6 张（≤15 像素）；rebase 后的新基础 `93ab20b8c` 上 232 张、20 张（≤29 像素），`075b7a6c8` 上 233 张、19 张（≤29 像素）。所以截图的变化都来自 main 的产品改动，按下一节归因。

## 归因

按 main 漂移参考第 4 条 (a)–(f)，44 张截图逐张归因到单个 main 提交。逐张的表在 [attribution/per-screenshot.md](attribution/per-screenshot.md)，全部数据（每组比较的类别、像素、git 事实）在 [attribution/attribution.json](attribution/attribution.json)，由 [attribution.py](tools/attribution.py) 从记录的运行算出：44 张都满足每一步，**0 张归因不到 main**。每张另核对了两次 rebase 后的新基础：`93ab20b8c`、`075b7a6c8` 上与前一个基础相比都没有变化，对照登记后的期望都通过比较器（`rebasedBase` 字段）。

### Wiki 28 张：main `2ba6765d9`（A10）

**变化**：`2ba6765d9` 在 Wiki 页头（`WikiFrame` 的 `.wk-actions`）加了 Share 按钮：在 New entry 前面，手机上只有图标。`.wk-actions` 靠右排列，所以 Contents、Activity、Settings 都左移一个按钮的宽度。截图差异都在页头按钮这一行：桌面 wiki-home、wiki-new-entry 在 x 813–1122、y 24–55，breakpoint-961-wiki 在 x 494–803、y 24–55；959px 时按钮排在第二行，breakpoint-959-wiki 在 x 411–817、y 64–95（chromium-dark-desktop 另有两处 3 像素的噪声点）；手机在 x 112–324、y 64–95。wiki-contents（手机）的目录抽屉盖住页面大半，只有抽屉右边露出的页头按钮边缘（x 320–324，54–55 像素）变化。wiki-new-entry 的对话框遮罩下，页头同样变化。

| 层级 | 前驱（不变） | 改变的提交 | 区间终点 |
| --- | --- | --- | --- |
| (a) 项目线 first-parent | `f991d2421`（P2.2 第二批窗口任务线，吸收 main 之前）：对照当前期望 28 张 27 张逐字节相同、1 张噪声 | `1d3cd4c70` Merge refs/heads/main into refs/heads/orbit/p2-2-popconfirm-dialog-antd-018e48，第二父 `2ba6765d9`：28 张都变，都不通过比较器，其余 224 张没有变化 | 项目 tip 就是 `1d3cd4c70` |
| (b) main first-parent（`1d3cd4c70` 的第二父线，merge-base `c7efa24cb` 之后：`7e4655bc2`、`bc99a8d39`、`7cc52e0cf`、`2ba6765d9`） | X^1 `7cc52e0cf`：对照当前期望 28 张**逐字节相同**；252 张都通过比较器 | **X `2ba6765d9`**：28 张都变，都不通过比较器（wiki-contents 54–55 像素，其余 2301–6781 像素；单通道差 89–224），其余 209 张逐字节相同、15 张噪声 | 区间终点就是 X（`1d3cd4c70` 的第二父）。X 与 `1d3cd4c70` 的 252 张 0 张变化，WebKit 全部逐字节相同 |

- **(c) X 在 main 上，不是晋升合并**：`2ba6765d9` 是 origin/main first-parent 线上的单个非合并提交，不是 `Merge refs/heads/project/34ZZeq0e3IR65GVm2kAs7 into refs/heads/main`。变化来自产品代码：新增的 `components/WikiShareButton.tsx` 和 `pages/WikiPage.tsx` 页头里挂上它的那一行。按钮本身用的是 AntD `Button`，不是迁移组件。
- **(d) X 的树里没有影响该页面的迁移改动**：X^1 `7cc52e0cf` 含本项目到当时为止晋升进 main 的全部迁移代码（P1–P4.1、P2/P3 补强等），它的 Wiki 28 张与当前期望（第 2 批在 `2f9cc095f`、`a884fda36` 上生成的参考）逐字节相同；项目线 `f991d2421` 另含 P2.2 第二批窗口任务的迁移提交，28 张同样不变（27 张相同、1 张噪声）。所以没有迁移提交改变过这些截图。X 与 X^1 之间只有 `2ba6765d9` 本身。
- **新基础**：从 X 到新基础 `4d77d69b7`，Wiki 28 张 26 张逐字节相同、2 张 Chromium 噪声（6、7 像素）；到 rebase 后的新基础 `93ab20b8c`、`075b7a6c8`，又都是 0 张变化。之后 main 的提交（含本项目 tip 的晋升 `3e25635e5`）都没有再改变这些截图。
- **(e) 参考图**：用 X 的树、补了固定响应的 P0 测试（运行器 `fix`）、P0.2 环境生成（[full-fix-2ba6765d9](attribution/runs/full-fix-2ba6765d9/meta.json)）。按「场景与固定数据维护」第 5 条，它与 P0 原测试只差这一条响应；同一棵树上 orig 与 fix 的 Wiki 28 张 26 张逐字节相同、2 张噪声。
- **(f)** 登记后在项目 tip（本批的树）上跑两轮完整 P0，见「验证」。
- 对照图：[页头裁切（chromium-light-desktop）](attribution/images/A10--chromium-light-desktop--wiki-home--crop.png)、[整页（chromium-light-desktop）](attribution/images/A10--chromium-light-desktop--wiki-home.png)、[手机（webkit-dark-phone）](attribution/images/A10--webkit-dark-phone--wiki-home.png)、[wiki-contents 抽屉边缘](attribution/images/A10--chromium-light-phone--wiki-contents--crop.png)。左为 X^1，右为 X（[index.json](attribution/images/index.json) 记着两次运行和原图哈希）。

### 设置页 16 张：main `def134095`（A11）

**变化**：`def134095` 在设置页第一张卡片 Session defaults 里、Smart model selection 下面加了一行 Suggested replies 开关。P0 账号的偏好里没有 `promptSuggestions`，按「没有就是开」显示为打开。下面各行和卡片随之下移（chromium-light-desktop 上 Let sessions orchestrate 的开关从 y 464 移到 544，下移 80 像素），所以 settings 和 settings-saved（点的仍是第一个开关 Smart model selection）都变。

| 层级 | 前驱（不变） | 改变的提交 | 区间终点 |
| --- | --- | --- | --- |
| (a) 项目线 | 项目 tip `1d3cd4c70`：对照当前期望 16 张都通过比较器（8 张逐字节相同、2 张噪声、WebKit 6 张只差 A6 的滚动条，见下）。它由 `3e25635e5` 原样晋升进 main：两者 `src/web` 树相同，生产构建逐文件相同 | 开工时的新基础 `4d77d69b7`（本批分支开工时所在的 main，项目 tip 是它的祖先）：16 张都变，都不通过比较器，其余 236 张没有变化 | — |
| (b) main first-parent（`3e25635e5` 之后的 13 个提交） | X^1 `ebf5e6441`：对照当前期望 16 张都通过比较器，与项目 tip 的情况相同 | **X `def134095`**：16 张都变（14782–94783 像素，单通道差 212–224） | 区间终点 `4d77d69b7`：16 张与 X **逐字节相同**，252 张 0 张变化 |

- `3e25635e5` 到 `4d77d69b7` 的 first-parent 提交里，改了 `src/web` 的只有 `3e25635e5`（晋升，`src/web` 与项目 tip 相同）、`c9ed8836c`（Runners 卡片）、`8cfd718c9`（管理员停用账号 X1）、`def134095` 和 `bcc89c7af`（Providers 折叠头）。前两项在 X^1 之前，X^1 的设置页不变；`bcc89c7af` 在 X 之后，区间终点与 X 逐字节相同。
- **(c)**：`def134095` 是 origin/main first-parent 线上的单个非合并提交，不是本项目的晋升合并。变化来自产品代码：`pages/SettingsPage.tsx` 新增的那个 `Field`（另有会话输入框的下一句建议、`lib/promptSuggestion.ts` 等）。
- **(d) 前驱树和后继树**：设置页在 main 里已经是 P4.1 迁移后的样子（Orbit `Card`、`Select`、`Switch`、`Segmented`）。前驱 X^1 `ebf5e6441` 和后继 X `def134095` 都含 P4.1 的晋升和 B1 修复，两者在设置页上只差 `def134095` 新加的那一行（新行用的 `Field`、`Switch` 是页面已有的组件）。迁移没有改变这些截图：P4.1 的同提交对照里设置页 16 张 14 张逐字节相同、2 张噪声（[p4.1-accepted](../p4.1-accepted/README.md)）；X^1 对照当前期望（第 1 批 A4 在 `4088d37e6` 上生成的参考，那时还没有 P2.3、P4.1）16 张都通过比较器。设置页的截图在已接受层没有条目，所以按第 4 条 (d) 和第 6 条更新 main 漂移层；新参考图与原参考图相比只多了 `def134095` 的一行和 A6 的滚动条，没有迁移改动。
- **WebKit 6 张的 A6 滚动条**：WebKit 的 settings 4 张和桌面 settings-saved 2 张，在项目 tip、X^1、`f991d2421`、`7cc52e0cf` 上对照当前期望都差同样的 428–780 像素（单通道差 ≤35），全在右侧 8 像素宽的滚动条里（桌面 x 1264 或 1272，手机 x 382），比较器通过。第 2 批已经同环境归因到 main `d233a6cd0`（给设置页加了 Access tokens 卡片，页面变高，滑块变短），当时低于阈值、没有登记（[p0-drift-2](../p0-drift-2/README.md)「失败清单」与[逐张表](../p0-drift-2/attribution/per-screenshot.md)）。新参考图在含 `d233a6cd0` 的树上生成，带着这个滚动条，所以这 6 条的 `mainCommits` 写成 `4088d37e6`、`d233a6cd0`、`def134095`，`change` 加上 A6，`projectLine` 加上它进入项目线的 `dd1d197ef`。
- **(e) 参考图**：用 X 的树、运行器 `fix`、P0.2 环境生成（[full-fix-def134095](attribution/runs/full-fix-def134095/meta.json)）。设置页不读 Wiki 分享路由，orig 与 fix 在新基础上设置页 16 张逐字节相同。
- 对照图：[新行裁切（chromium-light-desktop）](attribution/images/A11--chromium-light-desktop--settings--crop.png)、[整页（chromium-light-desktop）](attribution/images/A11--chromium-light-desktop--settings.png)、[手机 settings-saved（webkit-dark-phone）](attribution/images/A11--webkit-dark-phone--settings-saved.png)。左为 X^1，右为 X。
- **一次加载图标帧**：X^1 `ebf5e6441` 那次运行的 chromium-light-desktop/projects-loading 截到了不同的加载图标帧（62 像素，单通道差 20，比较器通过），在其余运行里与当前期望逐字节相同。这张不在本批范围（项目页），与第 3 批记录过的加载图标帧现象相同，不影响归因。

## 登记清单

两个登记提交，各自只改 `p0-drift/reference/registry.json`、`p0-drift/reference/screenshots/` 和 [p0-drift README](../p0-drift/README.md)「main 漂移参考层」的清单段落，可单独回退。工具是 [make-reference.py](tools/make-reference.py)（与第 2 批的同名工具相同，只多两条：已有条目保留原来的 `group`；不重登带 `migrationFix` 的条目），输入是 [spec-a10.json](tools/spec-a10.json)、[spec-a11.json](tools/spec-a11.json)。

| 提交 | 内容 | 条目 |
| --- | --- | ---: |
| `6a73b0cce` | Wiki：wiki-home ×8、wiki-new-entry ×8、wiki-contents ×4（手机）、breakpoint-959-wiki ×4、breakpoint-961-wiki ×4（桌面）。`mainCommits` 末尾加 `2ba6765d9`，`projectLine` 加 `1d3cd4c70`，`change` 加 A10，`generatedFrom` 改为 `2ba6765d9`（运行 full-fix-2ba6765d9）。README 清单里 4 个 Wiki 组的行随之更新，「生成方式」加一条第 5 批的说明 | 替换 28 |
| `3a36ab949` | 设置页：settings ×8、settings-saved ×8。`mainCommits` 末尾加 `def134095`，`projectLine` 加 `4d77d69b7`，`change` 加 A11，`generatedFrom` 改为 `def134095`（运行 full-fix-def134095）。WebKit 的 settings 4 张和桌面 settings-saved 2 张另加 A6：`mainCommits` 为 `4088d37e6`、`d233a6cd0`、`def134095`，`projectLine` 加 `dd1d197ef`。README 清单把「任务面板与设置」一行拆成任务面板（48 条，不变）和设置页（16 条） | 替换 16 |

- **都是第 6 条的替换**：44 张在登记前都已经是 main 漂移参考（第 1 批 A4，第 2 批 A7–A9），没有新登记 P0.2 截图。参考层仍是 164 条，期望组装仍是 `88 P0.2 originals, 150 main drift references, 14 accepted migration differences`。旧参考图留在 git 历史里。
- **其余 120 条逐字段不变**：每个登记提交前后，用 registry 逐条比较（[make-reference.py](tools/make-reference.py) 之后的核对）：A10 只改了 28 条 Wiki 条目，A11 只改了 16 条设置页条目；变的只有 `sha256`、`mainCommits`、`projectLine`、`change`、`generatedFrom` 五个字段，旧的提交号都留在列表前面，`group`、`p0Baseline` 不变。
- **`projectLine` 的取法**：Wiki 的 `2ba6765d9` 经项目线 `1d3cd4c70` 吸收，记 `1d3cd4c70`。设置页的 `def134095` 在项目 tip 晋升进 main（`3e25635e5`）之后才进 main，项目线还没有吸收它的提交；本批分支放在 main 上，落地时项目线经本批吸收它，所以记本批开工时的新基础 `4d77d69b7`（第一棵同时含项目 tip 和 `def134095`、本批完整测过的树）。本批后来先后 rebase 到 `93ab20b8c`、`075b7a6c8`，这两段 main 都没有改变任何 P0 截图（见「新基础 `93ab20b8c` 与 `075b7a6c8`」）。
- **校验**：两轮正式回归的 globalSetup 都按 `expected-screenshots.mjs` 校验通过：每条的 `p0Baseline` 是它替换的 P0.2 原图，`generatedFrom.commit` 等于最后一个 main 提交，环境哈希等于 P0.2，参考图哈希与登记一致，参考目录没有未登记的文件。
- 登记之后，新基础的 252 张（update 模式）对照新的期望全部通过比较器，低于阈值的只有 P3.2 的 11 张，设置页 WebKit 那 6 张也变成逐字节相同：`93ab20b8c` 上 222 张逐字节相同、19 张噪声（[full-fix-base2](attribution/runs/full-fix-base2/meta.json)，[对照](compare/expected-registered__full-fix-base2.json)）；`075b7a6c8` 上 229 张、12 张（[full-fix-base3](attribution/runs/full-fix-base3/meta.json)，[对照](compare/expected-registered__full-fix-base3.json)）。

## 已接受层

已接受层 14 条（P3.2 的 task-share-dialog ×8、task-action-menu ×4，P4.1 的 webkit 手机 profile-validation ×2）替换的期望都不在这 44 张里。本批没有改它们替换的 main 漂移参考，所以每条的 `replaces` 仍与组装出的期望一致，两轮正式回归的 globalSetup 都校验通过。没有失效的条目，不需要按「已接受的迁移差异」第 6 条重登，`accepted/` 一个文件都没改。

## 验证

### 两轮完整 P0：`3a36ab949`

- **树**：`3a36ab949`，即 origin/main `075b7a6c8` 加本批 4 个提交：`48ebd321c`（固定响应）、`6e197ab9b`（README 取值依据）、`6a73b0cce`（A10）、`3a36ab949`（A11）。之后只有两个提交：`c87fe3bde` 只把 p0-drift README 里固定响应提交的哈希改成本分支上的 `48ebd321c`（3 行文字），最后一个提交只在本目录增加证据文件。两者都不改 `src/`、`reference/`、`accepted/`，核对：`git diff --stat 3a36ab949 HEAD -- src docs/evidence/base-ui-migration/p0-drift/reference docs/evidence/base-ui-migration/p0-drift/accepted` 输出为空。
- **命令**：P0 原命令 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web`，在 `/mnt/data` 的 worktree 里，放在独立网络命名空间里，紧接着跑两轮（[final-rounds.sh](tools/final-rounds.sh)，作业 `bgj_f89a9296c100`）。

| 轮次 | 结果 | 记录 |
| --- | --- | --- |
| 第 1 轮（09:30:25–09:36:26 UTC） | 112 个测试：101 通过、11 个已记录的跳过、**0 失败**、0 flaky，退出码 0 | [checks/final3-round-1](checks/final3-round-1/summary.json)（含 `report.summary.json`、`command-output.txt`、`sources.json`、`evidence-digest.json`） |
| 第 2 轮（同一作业，紧接其后，09:36:38–09:41:48 UTC） | 同上，112 个测试逐个状态相同 | [checks/final3-round-2](checks/final3-round-2/summary.json)、[两轮对照](checks/final3-round-compare.json) |

- 两轮的期望组装都输出 `P0 expected screenshots: 88 P0.2 originals, 150 main drift references, 14 accepted migration differences.`，globalSetup 对两个登记层的校验都通过；环境记录与 P0.2 逐字节相同（`fe69e824…`）；运行时 worktree 干净（`command-output.txt` 第一行）。
- **101 个通过**：pages 56（task、share、projects、wiki、settings、profile、session 各 8）、states 16、断点巡检 4（桌面）、P2.3 生产通知 8、P0.2-FOCUS-1/2 16（P3.2 修好后作为普通测试）、性能 1。
- **本批登记的 44 张都通过**：wiki 8 个用例截到 wiki-home、wiki-new-entry（手机另有 wiki-contents），断点巡检 4 个用例截到 959/961 两张 Wiki 图，settings 8 个用例截到 settings、settings-saved。`sources.json` 里这 44 张都来自 main 漂移参考层，`mainCommits` 的最后一个是 `2ba6765d9` 或 `def134095`。
- **固定数据**：两轮都没有 `unhandled`，没有页面异常。8 个 wiki 用例各读 1 次 `GET /api/wiki/spaces/<id>/share`，4 个断点巡检用例各读 2 次（959、961 各一次），都由新路由回答（[evidence-digest.json](checks/final3-round-1/evidence-digest.json)）。
- **结果只含已记录的处置**：11 个跳过就是 7 个非参考项目的性能采样和 4 个手机项目的桌面断点巡检；没有预期失败；其余截图对照 P0.2 原图、main 漂移参考或已接受层，全部通过。

#### 第一次 rebase 后的两轮：`6fb78dd11`

`6fb78dd11` 是 origin/main `93ab20b8c` 加同样 4 个提交（当时的哈希 `2c4702656`、`4bcf9ff62`、`537d46ddc`、`6fb78dd11`，内容与上面逐字节相同）。两轮在作业 `bgj_92f11b7e81b6` 里：

| 轮次 | 结果 | 记录 |
| --- | --- | --- |
| 第 1 轮（09:00:57–09:07:35 UTC） | 112 个测试：101 通过、11 个已记录的跳过、**0 失败**、0 flaky，退出码 0 | [checks/final-round-1](checks/final-round-1/summary.json)（含 `report.summary.json`、`command-output.txt`、`sources.json`、`evidence-digest.json`） |
| 第 2 轮（同一作业，紧接其后，09:07:50–09:13:15 UTC） | 同上，112 个测试逐个状态相同 | [checks/final-round-2](checks/final-round-2/summary.json)、[两轮对照](checks/final-round-compare.json) |

- 两轮的期望组装都输出 `P0 expected screenshots: 88 P0.2 originals, 150 main drift references, 14 accepted migration differences.`，globalSetup 对两个登记层的校验都通过；环境记录与 P0.2 逐字节相同（`fe69e824…`）；运行时 worktree 干净。
- **101 个通过**：pages 56（task、share、projects、wiki、settings、profile、session 各 8）、states 16、断点巡检 4（桌面）、P2.3 生产通知 8、P0.2-FOCUS-1/2 16（P3.2 修好后作为普通测试）、性能 1。
- **本批登记的 44 张都通过**：wiki 8 个用例截到 wiki-home、wiki-new-entry（手机另有 wiki-contents），断点巡检 4 个用例截到 959/961 两张 Wiki 图，settings 8 个用例截到 settings、settings-saved，全部对照新登记的参考通过（逐用例来源见各轮的 `sources.json`）。
- **固定数据**：两轮都没有 `unhandled`，没有页面异常。8 个 wiki 用例各读 1 次 `GET /api/wiki/spaces/<id>/share`，4 个断点巡检用例各读 2 次（959、961 各一次），都由新路由回答（[evidence-digest.json](checks/final-round-1/evidence-digest.json)）。
- **结果只含已记录的处置**：11 个跳过就是 7 个非参考项目的性能采样和 4 个手机项目的桌面断点巡检；没有预期失败；其余截图对照 P0.2 原图、main 漂移参考或已接受层，全部通过。

### 负对照

两组都用同一个补丁（[nc-1px.diff](tools/nc-1px.diff)），在本批的树上以临时提交运行（[negative-control.sh](tools/negative-control.sh)），临时提交只留在本地分支 `p0d5/negative-control-1px*`，不交付：
- Wiki 页头的 Share 按钮加 `style={{ marginLeft: 1 }}`（A10 新登记的内容）：`.wk-actions` 靠右排列，Share 左边的 Contents、Activity、Settings 左移 1 像素；
- 设置页第一张卡片 Session defaults 的 `marginBottom: 16 → 17`（A11 新登记的那张卡片）：下面的卡片下移 1 像素。

每组先跑 P0 原命令，再用同一棵树跑 update 模式完整矩阵，对照两次登记之后的期望逐张比较（[nc-analysis.py](tools/nc-analysis.py)），看 44 张新登记的截图里哪些能检出这 1 像素。

| 对照 | 树 | P0 原命令 | update 模式：对照登记后的期望 | 记录 |
| --- | --- | --- | --- | --- |
| 最终树 | `3a36ab949` 加补丁（临时提交 `9f60e4e38`） | 112 个测试：81 通过、11 跳过、**20 失败**，退出码 1（作业 `bgj_e7915b0085ed`）。失败的正是新登记的截图：breakpoint-959-wiki ×4（405–472 像素）、wiki-home ×8（136–401 像素），都对照 A10 的新参考；settings ×8（335–4116 像素），对照 A11 的新参考。没有 `unhandled`，没有页面异常，其余测试与正式回归相同 | 44 张里 **40 张不通过比较器**（breakpoint-959/961-wiki 各 ×4、wiki-home、wiki-new-entry、settings、settings-saved 各 ×8，1102–23629 像素），其余 212 张都通过，没有别的截图失败。没检出的是手机 wiki-contents 4 张，与登记的参考逐字节相同（见下一行的说明）。补丁树与不加补丁的 `075b7a6c8` 相比，变化的正好是这 40 张 | [checks/negative-control-1px-final](checks/negative-control-1px-final/summary.json)、[分析](checks/negative-control-1px-final/analysis.json) |
| 第一次 rebase 后的树 | `6fb78dd11` 加补丁（临时提交 `31e31d733`） | 112 个测试：81 通过、11 跳过、**20 失败**，退出码 1。失败的正是新登记的截图：breakpoint-959-wiki ×4（405–472 像素）、wiki-home ×8（136–401 像素）、settings ×8（335–4116 像素），期望来源都是 main 漂移参考（本批登记的那一版）。没有 `unhandled`，没有页面异常，其余测试与正式回归相同 | 44 张里 **40 张不通过比较器**（breakpoint-959/961-wiki 各 ×4、wiki-home、wiki-new-entry、settings、settings-saved 各 ×8，1102–23629 像素），其余 212 张（含 P3.2 的 11 张）都通过。没检出的 4 张是手机 wiki-contents：抽屉盖住了左移的那几个按钮，露在抽屉右边的 Share 和 New entry 不动，这 4 张与不加补丁时逐字节相同或只有噪声（18 像素）。补丁树与不加补丁的 `93ab20b8c` 相比，变化的正好是这 40 张 | [checks/negative-control-1px](checks/negative-control-1px/summary.json)、[分析](checks/negative-control-1px/analysis.json) |

- 差异图样例（最终树）：[wiki-home chromium-light-desktop](checks/negative-control-1px-final/failures/pages.browser.mjs-wiki-chromium-light-desktop/wiki-home-diff.png)、[settings chromium-light-desktop](checks/negative-control-1px-final/failures/pages.browser.mjs-settings-chromium-light-desktop/settings-diff.png)。
- 结论：新登记截图上超出登记内容的 1 像素改动，在 P0 原命令里照样失败；没有改到可见区域的截图（手机 wiki-contents）不受补丁影响，所以照常通过，也没有别的截图失败。

### 合并检查

在会话工作树里运行项目的合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web`（[merge-check-root.sh](tools/merge-check-root.sh) 调用 [merge-check.sh](tools/merge-check.sh)，作业 `bgj_3d568672eea1`），退出码 0：
- **树**：`c87fe3bde`，它的 `src/` 与最终的树 `3a36ab949` 相同（之间只差 p0-drift README 的 3 行文字）；运行时唯一未跟踪的路径是本目录（`status: 1 changes`）。
- **依赖**：`bash scripts/worktree-overlay.sh`，按锁文件隔离安装（主工作区的 node_modules 与锁文件不符），`@orbit/shared` 解析到这棵树自己的 `src/shared/dist`（[overlay.txt](checks/merge-check/overlay.txt)）。
- **结果**：`tsc -b && vite build` 成功，保留原有的大 chunk 提示；Vitest **368 个文件、4753 个用例全部通过**，用时 333 秒。
- **磁盘**：根分区在安装依赖前 7037 MB、安装后 6139 MB，跑完时 3896 MB（同时有其他会话在写根分区；本批这次只写了约 7 MB 的构建产物）。跑完后删掉了这份依赖和构建产物，根分区回到约 5.1 GB（[disk.txt](checks/merge-check/disk.txt)）。之后没有再在根分区上构建或跑浏览器。
- [过滤后的输出](checks/merge-check/output-filtered.txt)保留了构建和 Vitest 的结果、汇总行；完整输出在 `output-full.txt.gz`。
- 第一次 rebase 后的树 `6fb78dd11`、以及 `/mnt/data` 上的最终树，各启动过一次合并检查，都因 `/mnt/data` 太慢停掉，没有结果（见「执行经过」）。

## 跟上 main 与 audit

- **开工时**：项目 tip `1d3cd4c70` 在 origin/main 里，本批分支快进到 origin/main `4d77d69b7`。
- **交证据前**：origin/main 两次前进。先到 `93ab20b8c`（`d3ef58c75`、`93ab20b8c` 两次合入项目 34bZ3i4AvgJaaoaw5E9tH：OpenCode 引擎行、Providers、落地状态等，`src/web` 有 21 个文件变化），再到 `075b7a6c8`（合入项目 34bmzOkov3xN2yLPrnsCk：Wiki 服务端执行）。锁文件都不变。本批 4 个提交两次 rebase 上去，都没有冲突。两段 main 都没有改 P0 测试目录、`fixtures.mjs` 和 p0-drift 目录；update 模式完整矩阵里，`4d77d69b7`、`93ab20b8c`、`075b7a6c8` 的 252 张两两之间 0 张变化（见「新基础 `93ab20b8c` 与 `075b7a6c8`」）。提交证据前（10:02 UTC）再 fetch 一次，origin/main 仍是 `075b7a6c8`。
- **audit**：在新基础上运行 `node src/web/scripts/audit-antd.mjs --check-owners`，退出码 1，14 个使用点没有归属；同一命令在项目 tip `1d3cd4c70` 上是 12 个（[checks/audit/](checks/audit/)）。
  - 项目 tip 上已有的 12 个：`DeepSeekBalance.tsx`、`WikiShareButton.tsx`、`SharedWikiPage.tsx`（后两个来自 main `2ba6765d9`），测试文件 `ProjectDoneConversation.test.tsx`、`RunnerEngines.accountFold.test.tsx`、`StartProjectCard.test.tsx`、`WikiReviewPage.decided.test.tsx`、`WorkspaceView.neverStarted.test.tsx`、`SharedWikiPage.test.tsx`，以及 `index.css` 的 3 行（文字不变，只因 `def134095` 在前面加了 CSS，行号后移）。
  - 新基础上新增的 2 个：`WorkspaceView.promptSuggestion.test.tsx`（main `def134095`）、`AdminUsersPage.disable.test.tsx`（main `fce7a19cf`）。
  - 本批是漂移登记，没有迁移范围，所以全部报告协调者（2026-10-08 经 `project_send`），不在本批迁移。
  - rebase 后在 `93ab20b8c`、`075b7a6c8` 上重跑：仍是这 14 个，没有新增；`index.css` 那 3 行因 main 又加了 4 行 CSS 再次后移（6699/6700/10701），`075b7a6c8` 与 `93ab20b8c` 完全相同。

## 不变的部分

本批在 `075b7a6c8` 之上有 6 个线性提交：固定响应 `48ebd321c`、README 取值依据 `6e197ab9b`、两个登记提交 `6a73b0cce`、`3a36ab949`、README 里固定响应提交号的更正 `c87fe3bde`，最后一个提交只在本目录增加证据文件。

核对办法：在本分支上 `git diff --stat 075b7a6c8 HEAD -- docs/evidence/base-ui-migration/p0.2 docs/evidence/base-ui-migration/p0-drift/accepted src/web/src src/shared src/web/ui-migration/{known-failures,pages,states,breakpoints}.browser.mjs src/web/ui-migration/{page-scenarios,session-scenarios,session-fixtures,harness,playwright.config,expected-screenshots,environment}.mjs` 输出为空。也就是说：
- P0.2 的 252 张原图、原断言、known-failures、截图比较选项（`maxDiffPixels: 0`、默认 threshold）和容差都没改；
- 已接受层（14 条）没改；
- 产品代码和 shared 没改；`fixtures.mjs` 只多了一条路由和 4 行注释，已有的路由一条没动（`git diff 075b7a6c8 HEAD -- src/web/ui-migration/fixtures.mjs` 只有 5 行新增）。
- 改了的只有：`fixtures.mjs`（1 处新增）、`p0-drift/README.md`（固定数据清单、参考层清单和生成方式）、`p0-drift/reference/`（44 条替换）和本目录。

## 证据体积

按作业指导「证据体积」：
- **Playwright 报告**：不提交 report.json 和 trace.zip，每次运行改交同目录的 `report.summary.json`（[report-summary.py](tools/report-summary.py)）：只删附件正文，用例标题、项目、状态、耗时、重试、错误信息和附件路径都保留。正式运行每次删掉 32 个附件正文（P2.3 生产通知用例的 16 个观测和 P0.2-FOCUS 用例的 16 个焦点观测），归因运行没有附件正文。
- **逐用例 JSON 和截图**：evidence.json 每次运行摘成一份 `evidence-digest.json`；截图只提交本 README 引用的：开工时的 2 张差异图、最终树负对照的 2 张差异图，以及 7 张 X^1/X 对照图。每次运行的截图哈希在各运行的 `snapshots.sha256`，逐张比较结果在 [compare/](compare/)。
- **体积**：本目录约 15.5 MB、259 个文件（含本 README）；两个登记提交替换的 44 张参考图共 2.3 MB；合计约 18 MB，不到 30 MB。比例最大的是 [attribution/runs/](attribution/runs/)（16 次运行的报告摘要、evidence 摘要和截图哈希）和 [compare/](compare/)（逐张比较）。
- **完整原始运行**：截图、报告原文、trace 和全部 evidence.json 留在 `/mnt/data/tmp/34cFgyWHIYDslABFPloEM/`（`runs/`、`checks/`），到证据判定后再清理。

## 缺口与边界

- **起因报告的失败位置**：起因报告说 12 个 Wiki 用例「停在固定数据校验」。本批在开工时的新基础上，它们都停在第一张 Wiki 截图，请求在 `unhandled` 里但校验没有执行到；在 update 模式下截图写得出来，才停在固定数据校验。两种说法指同一个原因，处置相同。
- **`projectLine` 的设置页条目**：项目线还没有吸收 `def134095` 的提交，记的是本批开工时的新基础 `4d77d69b7`（见「登记清单」）。本批落地后，项目线实际吸收它的提交由落地方式决定。
- **固定响应只覆盖默认状态**：P0 的 Wiki 空间没有分享链接，页头画 Share 按钮。打开的链接（Shared · Live 胶囊）、Share wiki 对话框和公开的 Wiki 页面（`SharedWikiPage`）不在 P0 覆盖范围内，由 `2ba6765d9` 自己的 `WikiShareButton.test.tsx`、`SharedWikiPage.test.tsx` 等单测覆盖。P4.4 迁移 Wiki 时如需 P0 覆盖这些状态，要另加场景和固定数据，不属于本批。
- **设置页 WebKit 6 条带 A6**：这 6 条把第 2 批记录过但没有登记的 `d233a6cd0` 滚动条写进了 `mainCommits`。依据是第 2 批的同环境归因加本批的测量（差异只在右侧 8 像素滚动条里、像素数与第 2 批相同），本批没有重做 `d233a6cd0` 本身的 X^1/X 运行。
- **精简构建树**：候选提交用 `git archive` 取出的精简树加共享依赖构建。用 `4d77d69b7` 核对过产物与 worktree 里正常构建逐字节相同，但没有对每个候选提交都和完整工作树比较。
- **只跑三层的提交**：main 线只在 X^1、X 和区间终点上跑了完整矩阵，没有逐个跑区间里的其他提交；它们是否改了 `src/web`、`src/shared` 由 git 树比较列出（见「归因」）。规则第 4 条 (b) 要求的三处都有同环境运行。
- **负对照没有专门检验 wiki-contents 的 4 张**：补丁移动的是 Share 左边的按钮，手机目录抽屉正好挡住它们，所以这 4 张在两组负对照里都不变、照常通过。这 4 张新登记的参考同样按 P0 比较器（`maxDiffPixels: 0`）严格对照，只是本批没有另做一个落在抽屉可见区域里的 1 像素对照。
- **合并检查不在 `/mnt/data` 上**：最终的合并检查在会话工作树里、用 `worktree-overlay.sh` 的隔离依赖跑（原因见「执行经过」），与前几批的做法相同；正式运行和负对照仍在 `/mnt/data` 的 worktree 里。
- **其余边界同 P0.2**：Linux 固定环境、合成 REST/SSE、非真机 iOS。
- **临时路径**：`tools/` 里的脚本写着 `/mnt/data/tmp/34cFgyWHIYDslABFPloEM` 和本工作树的路径，复跑时需要按环境调整。

## 复跑

```sh
bash scripts/worktree-overlay.sh
NO_COLOR=1 npm run test:ui-migration -w @orbit/web
npm run build -w @orbit/web && npm run test -w @orbit/web
```

归因复算（脚本在 [tools/](tools/)）：
- 构建：`prepare-tree.sh <提交> [标签]`；运行器：`make-runner.sh <提交> <名字> <同 shared 的已构建树>`；
- 单次运行：`run.sh <树> <运行器> <标签> [playwright 参数]`，多次：`queue.sh <并行数> <树:运行器:标签>...`；
- 截图对照：`node compare.cjs <目录A> <目录B> <out.json>`，汇总 `compare-summary.py`；逐张归因 `attribution.py <工作树> <out.json> <out.md>`；请求链 `fixture-chain.py <out.json> <运行标签>...`；
- 登记：`make-reference.py <工作树> <spec.json>`；正式两轮 `final-rounds.sh <提交> <前缀>`；负对照 `negative-control.sh <提交> <补丁> <名字>`；合并检查 `merge-check.sh <树> <输出>`。
