# P7.1 运行最终构建、完整测试与浏览器回归

服务于 [P7.1 运行最终构建、完整测试与浏览器回归](orbit-task:34Za39TCy7xMbhT6VYEyv)，项目验收条目 key `5wbhutjez7Qv5GCTNLb0P7`：**P7：完整迁移通过最终构建、行为与视觉回归，并有实测收益和可回退交付记录。** 本任务负责的子范围（任务验收原文）：在同一候选提交上，Web 构建、完整测试和 P0 固化的浏览器回归命令均以退出码 0 完成，报告与差异证据可复核。

本任务主要产出执行结果，不改生产源码。三项命令都在**同一个交付提交**上执行：

| | |
| --- | --- |
| 交付提交 | `09d94a12f4bb969d69edf75c208d8ab0f9777423`（tree `74bc29723385e663cbe65c6e85dff6d701e0a40d`） |
| 父 1 | `c04e7923827dff28c8087f6bac209e6455acab90`，项目 tip（P6 交付与证据） |
| 父 2 | `0f07cf72e011274ebf509eb79e6eaf18dd06f693`，本轮开始时的 `origin/main` |
| 工作区 | `/root/.orbit/worktrees/8c4849bc-8104-5198-b7bc-a9b80b8ffeb7`，三项命令前后 `git status --porcelain` 都是 0 行 |
| 本目录所在提交 | 只加本目录的证据文件；`src/web`、`package-lock.json`、`scripts` 的 tree 与交付提交逐字节相同（`git rev-parse <commit>:<path>`） |

任务第 4 条照写：本任务的自动化通过不代替 [P7.2 复核视觉保真、实测收益与回退交付](orbit-task:34Za39UxopXFSlSSCGBZG) 的人工视觉/实测证据审查。

## 三项命令与退出码

按任务声明的顺序、在同一工作树执行；每一步单独取退出码（不串联，前一步红了后面的仍然执行），各自放进一个 `MemoryMax=6G` 的 cgroup（作业指导 2026-10-09）。原始命令输出在 `/mnt/data/tmp/34Za39TCy7xMbhT6VYEyv/run1/`。

| 步骤 | 命令 | 退出码 | 用时 | 结果 |
| --- | --- | --- | ---: | --- |
| 1 | `npm run build -w @orbit/web` | **0** | 2.14 s | `tsc -b && vite build`；原有大 chunk 提示保留 |
| 2 | `npm run test -w @orbit/web` | **0** | 196.6 s | Vitest `--maxWorkers=2`：**402 个文件、5,247 个用例全部通过**，无跳过 |
| 3 | `npm run test:ui-migration -w @orbit/web` | **0** | 169.4 s | P0 浏览器回归：**101 通过、11 跳过、0 意外失败、0 flaky、0 重试** |

明细见 [checks/commands.json](checks/commands.json)（提交、命令、退出码、用时）、[checks/context.txt](checks/context.txt)（主机与工具链）。

第 3 步的 `pretest:ui-migration` 会重建 shared 和 Web，所以它跑在**自己的**构建产物上。两次 `src/web/dist` 的逐文件 SHA-256 清单（25 个文件）逐字节相同，见 [checks/dist-hashes.txt](checks/dist-hashes.txt)：第 3 步没有用别的树，也没有改动第 1 步的产物。

**在最终提交上又跑了一遍。** 证据提交 `e065ef2f1` 之后，同样三条命令按同样顺序再跑一次（这一步也用来核对本轮结论不依赖某一次运行）：构建 0（2.25 s）、Vitest 0（213.0 s，仍是 402 个文件、5,247 个用例）、`test:ui-migration` 0（186.2 s，**101 通过、11 跳过、0 意外失败、0 flaky、0 重试**，期望层仍是 44/165/43，252/252 张截图被断言，无缺失/多余/重复），`dist` 在两步之间仍逐字节相同（[checks/run2-commands.json](checks/run2-commands.json)）。两次运行的 `git rev-parse <commit>:src/web` 都是 `31aaca562bae53cc29b959399c9468b25fdf81e9`——证据提交只加 `docs/`，被测的 Web 输入没有变。

## 环境

按 P0.2 的固定环境执行（[P0.2 README](../p0.2/README.md)）：Debian GNU/Linux 13.7、Node `v26.10.0`、npm `11.19.1`、Playwright **1.63.0** 锁定的 Chromium revision 1243（153.0.8010.12）与 WebKit revision 2359。`environment.mjs` 每次读到的 OS、浏览器清单、56 个字体文件及 SHA-256 与本轮写出的 `environment.json` 与 P0.2 记录**逐字节相同**，SHA-256 `fe69e82445e35a3196501a240c567b71b4039e40e434832ae9fd77f348f9cbdf`（见 [checks/environment.txt](checks/environment.txt)）。没有覆盖环境记录，也没有换字体或浏览器。

主机 24 核 15 GB；本轮负载 9–17（其他会话一直在用）。重步骤串行，起跑前看过 `free -m`（可用内存 6.1–6.5 GB）。

## P0 浏览器回归（第 3 步）

期望截图仍是三层：**44 张 P0.2 原件 + 165 张 main 漂移参考 + 43 张已接受的迁移差异**，由 `expected-screenshots.mjs` 在每次运行开始时组装并逐张校验哈希（[P0 drift README](../p0-drift/README.md)）。没有传任何截图更新参数（`updateSnapshots: 'none'`、`maxDiffPixels: 0`），没有改阈值、没有改断言、没有排除用例、没有写新的预期失败。

252 张 P0 截图**全部被断言过**：`harness.mjs` 只在 `toHaveScreenshot` 通过之后才记录该场景的附件，报告里正好 252 条 capture，与期望集合一一对应，无缺失、无多余、无重复（[checks/p0-analysis.json](checks/p0-analysis.json) 的 `screenshotsAsserted`；判据见 `expected-screenshots/sources.json` 与各 `computed-styles-and-timings` 附件）。逐用例的状态、跳过原因、重试次数在 [checks/p0-analysis.json](checks/p0-analysis.json)，去掉附件正文的原始报告在 [checks/p0-report.summary.json](checks/p0-report.summary.json)。

| 结果 | 数 | 说明 |
| --- | ---: | --- |
| 普通通过 | 101 | 见下表的场景覆盖 |
| 有意跳过 | 11 | 4 个手机环境不跑桌面指针断点巡检；7 个非参考环境不重复采样性能。都是用例自己的设定，与 P0.2 记录一致 |
| 意外失败 / flaky / 重试 | 0 / 0 / 0 | `retries: 0`；报告里没有任何 `retry > 0` |

两项 P0.2 的既存焦点缺陷（`P0.2-FOCUS-1/2`：分享弹窗 Escape/Done 后焦点没有回到触发按钮）在本提交上是**普通通过**：P3.2 把分享弹窗迁到 Orbit Dialog 后缺陷消失，16 个预期失败标记已经在当时按规则退还，断言与观测都保留（[known-failures.browser.mjs](../../../../src/web/ui-migration/known-failures.browser.mjs)）。本轮这 16 个用例全部以普通用例通过。

### 全部批次代表场景的覆盖

P0 场景集就是项目 P0 定义的代表范围；组件批次另有自己的样例入口。本轮两处都跑了：

| 批次 | 代表场景 | 覆盖入口 | 本轮结果 |
| --- | --- | --- | --- |
| P0/P0.2 | 任务详情与分享、项目列表与图、会话输入与附件菜单、通知、Wiki、设置与账号、600/640/960px 断点两侧 | `npm run test:ui-migration`（pages / states / breakpoints / feedback-production / known-failures / performance） | 101 通过（P0 三层期望，252 张截图） |
| P1 | 基础控件、主题、reset 与根容器 | `test:ui-foundation`（48）、`test:ui-controls`（32） | 48/48、32/32 |
| P2 | 弹层、选择、反馈 | `test:ui-overlays`（120）、`test:ui-choices`（760）、`test:ui-toasts`（264） | 120/120、757/760、264/264 |
| P3 | 会话输入与评论框（Orbit Textarea） | `test:ui-composer`（121 + 23 跳过） | 121 通过、23 按用例设定跳过 |

补充入口的结果、失败分类与复跑见下一节；它们的退出码与逐套尾部记录在 [checks/fixture-suites.txt](checks/fixture-suites.txt)。

## 补充入口（六个组件样例）的结果与分类

六个配置的原样入口（命令未改、断言未改、样例未改）。第一轮被引擎回收在第四套中间杀掉，前三个已完成；重跑脚本接力，`choices` 整跑一遍，然后 `toasts`、`composer`（[checks/fixture-suites.txt](checks/fixture-suites.txt) 注明哪一轮跑的是哪一套）。

| 配置 | 结果 | 退出码 |
| --- | --- | ---: |
| foundation | 48 通过 | 0 |
| controls | 32 通过 | 0 |
| overlays | 120 通过 | 0 |
| choices | 757 通过、**3 失败** | 1 |
| toasts | 264 通过 | 0 |
| composer | 121 通过、23 跳过 | 0 |

三条 `choices` 失败逐条分类（原始报文见 [checks/choices-failures.json](checks/choices-failures.json)）：

1. **两条是已记录的既存红，不是本轮的回归**：`choices.browser.mjs` 的「multiple labels search, toggle, collapse, remove and clear without losing the remaining values」在 `webkit-light-phone` 与 `webkit-dark-phone`，afterEach 页面错误检查报 `ResizeObserver loop completed with undelivered notifications.`。这是 P6 的补偿控制发现、协调者 2026-10-10 判定为「P6 之前就有、因样例位置暴露」的既存问题（修复任务 [34dcr9bZPPrl6TDzvXowg](orbit-task:34dcr9bZPPrl6TDzvXowg)，当前 OPEN）。报错文字与 P6 记录的逐字相同；用例、样例与断言都没有改。
2. **一条是环境抖动，不是组件回归**：`choices-first-option.browser.mjs` 的「opened by Space with no value…」在 `chromium-dark-phone`，15 秒超时读不到 `getByTestId('theme')`——页面 fixture 根本没挂载。该用例保留的 trace 里 4 个模块请求 `status = -1`（`react.js`、`react-dom_client.js`、`react_jsx-runtime`、`ChoicesFixture.tsx`，都在 `127.0.0.1:4177`），控制台 4 条 `Failed to load resource: net::ERR_NETWORK_CHANGED`（[checks/choices-first-option-network.json](checks/choices-first-option-network.json)）。这是本主机上已记录的签名：其他会话起停容器导致宿主网络接口变动，Chromium 中断在途请求。同提交、同用例、同项目**连续重跑 3 次全部通过（各 12/12）**（[checks/choices-first-option-rerun.txt](checks/choices-first-option-rerun.txt)）。没有为实现这一点改测试或加重试。

## 交接给本任务的两项观察

- **P2.1 交接的 8 张桌面截图**（session-idle 与 breakpoint-961-session 菜单的微小像素差异，chromium/webkit × light/dark 桌面）：在本提交上重新执行，期望层是登记过的 main 漂移参考（`session-idle`/`breakpoint-961-session` 的 8 个桌面项目都在 `p0-drift` 层，`git` 记录见 `sources.json` 的 `mainCommits`），全部通过 P0 比较器。截图后的操作步骤按场景照常执行（`pages.browser.mjs` 的 session 场景与 `breakpoints.browser.mjs`），没有继承为预期失败，也没有声称旧图仍然全绿。
- **P2.2 r2 交接的 submenu-left 动效观察器**（原记录：一次 webkit-light-phone 根菜单入场 `records.length > 0` 采集等待超时；同源码随即 5/5 通过）：本轮在交付提交上跑了 `choices` 全套，`submenu left edge zoom stays in view` 与 `submenu keeps its place through the normal entrance motion`、`submenu is drawn where it settles from its first frame` 在 **8 个项目共 24 个用例里全部通过**（`choices-motion.browser.mjs` 整套 192 个用例全部通过）。不只是没超时：webkit-light-phone 的 `motion` 附件里这一用例采到了完整记录——入场 `orbit-zoom-in` 200 ms / 15 个采样、`endState: finished`，退场 `orbit-zoom-out` 14 个采样、`endState: idle`（[checks/submenu-motion-records.json](checks/submenu-motion-records.json)，同一文件也带 webkit-dark-phone 与 chromium-light-phone 的对照）。所以本轮**不存在**「实际无动效」或「漏采集」两种可能中的任何一种，也没有用重试、跳过或改写基线去掩盖它。

## 跟 main

本轮开始前已按作业指导跟上（交付提交的两个父：项目 tip 与 `origin/main`）。跑的过程中 main 又前进（`0f07cf72e → 220da3f72 → 7c58911e7 → 96852b785 → 756855121`）：`96852b785` 是 main 对**本项目自己的线**的晋升，项目 tip `c04e79238` 现在已经是 `origin/main` 的祖先。对今天的 `origin/main` 干跑合并：`git merge-tree --write-tree HEAD origin/main` 退出 0、无冲突，合并会改动 110 个文件，**全部是 main 自己的新工作**（macOS 客户端、wiki、另一个项目的证据、版本号 0.1.229→0.1.230）；`src/web`、`package-lock.json`、`scripts` 的 tree 与交付提交相同，`src/shared` 只有 `wikiMaintain.ts` 一处注释和 `wikiContract.spec.ts` 的 17 行。没有改到本批的文件，也没有改锁文件，所以按规则不再跟一次，其余由落地的合并检查兜底。清单与命令见 [checks/main-dryrun.txt](checks/main-dryrun.txt)。

## 本轮没有确立的部分

- **不代替 P7.2**：截图相等、计算样式和操作记录都由自动化给出；人工视觉复核、同条件体积/性能对照、公共组件维护约定、逐批回退说明仍由 [P7.2](orbit-task:34Za39UxopXFSlSSCGBZG) 负责。
- **没有真机证据**：本轮是 Linux 上的 Chromium/WebKit，不是真机 iOS/Android；软键盘、IME、触摸、系统字体与安全区域仍需真机（P7.2，且按协调者 2026-10-10 的决定放在部署之后对着真实安装包执行）。
- **既存红仍在**：`choices` 的两条 MultiSelect WebKit 手机红是记录的既存问题，本任务不改用例、不修组件（修复在 [34dcr9bZPPrl6TDzvXowg](orbit-task:34dcr9bZPPrl6TDzvXowg)）；本任务的三项验收命令不含这些样例入口，但如实列在这里，供 P7.2 与最终判定阅读。
- **P0 只按登记过的期望判定**：`reference/` 与 `accepted/` 两层里的每一张都由其登记条目校验（哈希、`generatedFrom`、`decision`）；本轮没有新增任何登记，也没有改动 P0.2 原图。

## 复现

```sh
# 交付提交
git checkout 09d94a12f4bb969d69edf75c208d8ab0f9777423
bash scripts/worktree-overlay.sh                      # 本树的 node_modules、shared dist、Prisma client
# P0.2 的固定环境（字体、浏览器版本）见 ../p0.2/README.md；三项命令：每步单独取退出码
NO_COLOR=1 npm run build -w @orbit/web
NO_COLOR=1 npm run test -w @orbit/web
NO_COLOR=1 npm run test:ui-migration -w @orbit/web    # pretest 重建 shared 与 Web，用本地 preview :4173
# 六个组件样例（补充入口）
NO_COLOR=1 npm run test:ui-foundation -w @orbit/web
NO_COLOR=1 npm run test:ui-controls   -w @orbit/web
NO_COLOR=1 npm run test:ui-overlays   -w @orbit/web
NO_COLOR=1 npm run test:ui-choices    -w @orbit/web   # 757 通过、3 失败；见本文件「补充入口」一节
NO_COLOR=1 npm run test:ui-toasts     -w @orbit/web
NO_COLOR=1 npm run test:ui-composer   -w @orbit/web
```

每步都放进内存上限的 cgroup 里跑（`systemd-run --scope -p MemoryMax=6G`），重步骤串行。完整原始运行（含 Playwright 的 trace 包与带附件正文的报告）留在 `/mnt/data/tmp/34Za39TCy7xMbhT6VYEyv/`，到证据判定为止。

## 体积

本目录约 268 KB，全部是文本：本 README、`checks/` 下 14 个文件（其中最大的 `p0-report.summary.json` 151 KB，附件正文已按体积约定删除）、以及交付提交三项命令的退出码与逐场景状态。没有 trace 包，没有带附件正文的原始报告，没有截图副本（截图与被引用的证据都在各自批次目录里）。
