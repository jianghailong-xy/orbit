# P2/P3 补强：Select 窗口确定性回归、拖放用例常驻、Menu Tab 约定与证据勘误

本目录服务于任务 [P2/P3 补强：Select 窗口确定性回归、拖放用例常驻、Menu Tab 约定与证据勘误](orbit-task:34blRfxvNoD5uIuXNTiEJ)，对应项目验收条目 key `1BvO6hYrlFnU60JqxQPUHt`：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。**

本任务处理 [P3.3 试点检查](orbit-task:34Za39Br6OaoCg0nc1ipA) 报告的四个缺口：G3、G5、G6、G7。它们不阻塞 P4.1，但要在 P4.2 之前处理。执行者为 Claude Opus 5.5。没有推送 main 或项目分支。

## 结论

| 缺口 | 交付 | 结果 | 记录 |
| --- | --- | --- | --- |
| G3：Select 打开窗口修复（`632b7950e`）没有常驻的确定性回归 | `77583b327`：新增 [`Select.test.tsx`](../../../../src/web/src/components/ui/Select.test.tsx)，13 个序列，每个序列跑参照与窗口两遍，共 26 例 | 在撤回 `632b7950e` 的临时分支上：**11 例失败**，退出码 1。恢复修复后：**26/26**，退出码 0 | [runs/select-test-fix-reverted](runs/select-test-fix-reverted/)、[runs/select-test-fix-restored](runs/select-test-fix-restored/)、[revert-632b7950e.patch](revert-632b7950e.patch) |
| G7：附件拖放探针不在测试入口里 | `8447b59a5`：P3.3 的探针并入 [`pilot.browser.mjs`](../../../../src/web/ui-migration/pilot.browser.mjs)，作为常驻用例 | 断言是探针断言的超集，见 [drop-probe-to-case.diff](drop-probe-to-case.diff)。试点入口八环境：**81 通过、7 跳过、0 失败**，退出码 0。拖放用例 8/8；7 个跳过是性能采样，按设计只在 chromium-light-desktop 运行 | [runs/pilot-entry-1](runs/pilot-entry-1/) |
| G5：Menu 的 Tab 语义没有写进约定 | `89dc743e5`：[component-contracts.md](../component-contracts.md)「Menu 打开后的焦点与 Tab」，ui README 的 Menu 条目指向它 | 写明了约定、适用范围、各批对照怎么处理和测试依据。`Menu.tsx` 未改 | 本文「G5」 |
| G6：三处证据小错 | `d6a764624`：新建 [errata.md](../errata.md) | 三处都与 P3.3 的说法相符，逐条写了核对依据和更正后的表述。原证据文件未改 | 本文「G6」 |
| 合并检查 | `npm run build -w @orbit/web && npm run test -w @orbit/web`，在 `d6a764624` 上 | 退出码 0：构建通过，Vitest 345 个文件、4405 个用例全部通过 | [runs/merge-check](runs/merge-check/) |

## 基线与提交

- **起点**：项目分支 tip `7732f14f82d4e6b4406d7d164c4b672f63aa0f56`。任务分支 `orbit/p2-p3-select-menu-tab-3336b7` 从这里开出，开工时工作区干净。
- **依赖**：用 `bash scripts/worktree-overlay.sh` 准备。主工作区的安装与锁文件不兼容，脚本因此按本树锁文件做了隔离的 `npm ci`（作业 `bgj_9a16204deff4`，退出码 0）。环境为 Node v26.10.0、npm 11.19.1。
- **浏览器环境**：按 [P0.2](../p0.2/README.md) 准备，Playwright 1.63.0、Chromium 1243、WebKit 2359。每次浏览器运行的 globalSetup 都把实际环境与 P0.2 的 `environment.json` 逐字段比较。
- **磁盘**：开工时根分区剩 22 GB，不足作业指导要求的 30 GB。本会话在 `/var/tmp` 没有旧目录可清理。本任务没有新建工作树，撤回检查在本工作树的临时分支上完成，所以占用很小。

| 提交 | 内容 |
| --- | --- |
| `77583b327` | test(web)：Select 打开窗口的确定性单测（G3） |
| `8447b59a5` | test(web)：拖放探针并入试点用例（G7） |
| `89dc743e5` | docs(web)：Menu 焦点与 Tab 约定（G5） |
| `d6a764624` | docs(web)：证据勘误（G6）。合并检查与试点入口都在这个提交上运行 |
| `cc915a0ac` | docs(web)：G5 约定中「不在范围内」一句的措辞（只改 `component-contracts.md` 一行） |
| 本目录所在提交 | docs(web)：本证据目录（只新增 `p2-p3-hardening/`） |

与起点相比，交付只改了 5 个文件，共 +333/−1：
- `Select.test.tsx`（新增）；
- `pilot.browser.mjs`（+42）；
- `component-contracts.md`（+39）；
- ui `README.md`（1 行）；
- `errata.md`（新增）。

`Select.tsx`、`Menu.tsx` 和任何生产代码都没有改；已有用例、断言、P0 截图都没有改；`p2.3-b1/`、`p2-select-keys/` 两个被勘误的目录也没有改（`git diff 7732f14f8 HEAD` 对这些路径为空）。

## G3：Select 打开窗口的确定性单测

### 做法

仿照 Menu 窗口修复的 [`Menu.test.tsx`](../../../../src/web/src/components/ui/Menu.test.tsx)：
- **压住动画帧**：测试把 `requestAnimationFrame` 换成队列。Base UI 要到下一帧才把焦点移进打开的列表，所以帧不运行时，打开键之后的每个键都落在触发器上。这就是快速连按时的窗口（[p2-select-keys](../p2-select-keys/README.md)「根因」）。
- **参照**：同一组键，每个键后都让帧运行，即焦点已在列表里。
- **固定数据**：分享对话框的 Expires 选项（Never、1 day、7 days），外加一个禁用的 30 days（与 choices fixture 相同）。Base UI 的 Select 不传禁用索引，所以方向键能到达禁用项，但 ⏎ 选不了它，列表保持打开。p2-keyboard-window README 第 332 行已记录这一行为。
- **每个窗口用例先断言三件事**：列表已打开；第一个高亮是打开键决定的那一项；焦点仍在触发器上。按完键后再断言：
  - 选中的值（`onValueChange` 的调用）与参照相同；
  - 让帧运行之后，值仍然不变；
  - 结束状态相同：列表关闭，或仍打开并停在同一项上。

| 序列 | 起点 | 打开后高亮 | 参照选中 | 结束状态 | 覆盖的窗口按键 |
| --- | --- | --- | --- | --- | --- |
| ↓ ↓ ⏎ | 1 day | 1 day | 7 | 关闭 | ↓ 从当前项走一步，而不是跳到第一项 |
| ↓ ↑ ⏎ | 1 day | 1 day | never | 关闭 | ↑ 走一步，而不是跳到最后一项 |
| ↓ ↑ ↑ ⏎ | 1 day | 1 day | never | 关闭 | ↑ 在顶端不循环 |
| ↓ ↓ ↓ ⏎ | 1 day | 1 day | — | 停在 30 days | ↓ 到达禁用项，⏎ 选不了它 |
| ↓ ⏎ | 1 day | 1 day | — | 关闭 | ⏎ 选当前值，列表只关闭 |
| ↑ ↑ ⏎ | 1 day | 1 day | never | 关闭 | ↑ 打开后再按 ↑ |
| ↑ ↓ ⏎ | 1 day | 1 day | 7 | 关闭 | ↑ 打开后按 ↓ |
| ⏎ ↓ ⏎ | 1 day | 1 day | 7 | 关闭 | ⏎ 打开后按 ↓ |
| ⏎ ↑ ⏎ | 1 day | 1 day | never | 关闭 | ⏎ 打开后按 ↑ |
| ⏎ ⏎ | 1 day | 1 day | — | 关闭 | ⏎ 打开后按 ⏎ |
| ↓ ⏎ | 无值 | Never | never | 关闭 | 落在触发器上的 ⏎ 选高亮项，而不是只关闭列表 |
| ↑ ⏎ | 无值 | 7 days | 7 | 关闭 | 同上；↑ 打开时跳过禁用的 30 days |
| ⏎ ⏎ | 无值 | Never | never | 关闭 | 同上 |

有修复时，窗口里第一个 ↓、↑ 或 ⏎ 会被交给列表，焦点随之移入列表，之后的键落在列表里。所以每个窗口用例里，恰好是打开键后的第一个键落在触发器上。
- ↓ 和 ↑ 由从 1 day 起的 8 个序列覆盖：窗口键是 ↓ 的 4 个，是 ↑ 的 4 个。从 1 day 起，走一步和跳到两端的结果不同。
- 打开键后紧跟的 ⏎ 由最后 3 个序列覆盖：起点无值，打开后的高亮不是当前值，所以「选中高亮项」与「只关闭列表」的结果不同。
- 从 1 day 起的 `↓ ⏎`、`⏎ ⏎` 也让 ⏎ 落在触发器上，但两种结果碰巧相同（都是值不变、列表关闭），区分不了有没有修复。保留它们，是为了确认有修复时行为与参照一致。

### 撤回修复：失败；恢复：通过

- **临时分支**：`tmp/p2p3-hardening-revert-632b7950e` 从 `77583b327` 开出，提交 `61472ff07f807d85c6061d457599347eee5338d8` 只撤回 `632b7950e`（项目线上的副本是 `31aa07c91`）。
  - `git revert` 会在 Positioner 一行冲突，因为之后的 `6e3e4f464` 改过相邻行。所以撤回用 [tools/revert-632b7950e.py](tools/revert-632b7950e.py) 写出：只去掉修复加的三处（popup ref、触发器 `onKeyDown`、`ref={popup}`）。
  - 改动见 [revert-632b7950e.patch](revert-632b7950e.patch)（+2/−16）。[revert-632b7950e.check.txt](revert-632b7950e.check.txt) 逐行比对过：这些改动行恰好是 `632b7950e` 改动行的反向。
  - 运行记录之后，临时分支已删除。它不在交付里。
- **撤回后**（作业 `bgj_48736e0d6f1f`，[meta](runs/select-test-fix-reverted/meta.txt)，HEAD `61472ff07`）：退出码 1，**11 失败、15 通过**。
  - 13 个参照用例全部通过，它们不依赖修复。
  - 失败的是 13 个窗口用例中的 11 个，全部是上表「能区分」的序列。失败信息与 P2 根因一致：
    - 窗口里的 ↓/↑ 让高亮跳到第一项或最后一项，例如 `↓↓⏎` 选了 never 而不是 7；
    - 窗口里的 ⏎ 只关闭列表，什么也没选，例如无值时 `↓⏎` 选中为空；
    - `↓↓↓⏎` 的列表被关闭，而参照停在 30 days。
  - 逐例结果在 [vitest.json](runs/select-test-fix-reverted/vitest.json)。
- **恢复后**（作业 `bgj_cd0b92a5046b`，HEAD `77583b327`）：退出码 0，**26/26**。

**顺序无关**：作业 `bgj_905ccb830e64`（[runs/select-test-shuffled](runs/select-test-shuffled/)，HEAD `cc915a0ac`，`Select.test.tsx` 与 `77583b327` 相同），退出码 0。
- 用 `--sequence.shuffle` 以 seed 1–5 各跑一次，每次都是 26/26；
- 与 `Menu.test.tsx` 一起运行，44/44。

完整 Vitest 也包含这两个文件，见「合并检查」。

## G7：拖放用例常驻

- **来源**：P3.3 的一次性探针 `p33/tools/pilot-p33-drop.browser.mjs`，SHA-256 `e72f9991…fa76d`，与 P3.3 `SHA256SUMS` 中的记录相同。
- **位置**：放在 `pilot.browser.mjs` 的 `task detail pilot` 组里，紧跟在失败上传用例之后。用例名为「files dropped on Add file are each uploaded」。
- **与探针的差别**：只有两行，见 [drop-probe-to-case.diff](drop-probe-to-case.diff)，其余逐字相同。
  1. 用例名去掉了「P3.3 probe:」前缀。
  2. 探针对 `queries` 的断言是拿观察值和它自己比，等于没有断言。现在改为点名试点任务：`` [`?taskId=${PILOT_IDS.task}`] ``。P3.3 的两树运行（`drop-ref-1`、`drop-tip-1`）中，八个环境发出的都是这个值。
- **断言**（不弱于探针）：
  - 前置：缩略图已加载；
  - 恰好 2 个上传请求；
  - 等待 300ms 后：页面地址不变；上传请求仍是 2 个；multipart 中的文件名为 `dropped.png`、`dropped.txt`；查询串为试点任务。
  - 每个环境另附一条 trace，供以后的同提交对照使用。
- **运行**：试点入口即 `pilot.config.mjs` 的全部用例（`pilot*.browser.mjs`），作业 `bgj_c26833d0254f`，[meta](runs/pilot-entry-1/meta.txt)。
  - 在 `d6a764624` 上，用合并检查刚构建的生产包，12:19–12:23 UTC。
  - 放在独立网络命名空间里（[tools/netns.sh](tools/netns.sh)），`nice -n -10`。
  - 与 P3.2、P3.3 的试点运行相同，带 `--update-snapshots=all`：试点的 `capture` 把截图写进 `P32_SNAPSHOTS` 指定的目录，同提交对照时再拿两树的截图比较；单树运行本身不比较截图。
  - globalSetup 记录的 [environment.json](runs/pilot-entry-1/environment.json) 与 [P0.2 的记录](../p0.2/environment.json)逐字节相同。
- **结果**：退出码 0，88 个用例中 **81 通过、7 跳过、0 失败**，0 flaky。
  - `pilot.browser.mjs` 的 10 个用例，含新的拖放用例，在 8 个环境里都通过（80/80）；
  - `pilot-performance.browser.mjs` 只在 chromium-light-desktop 采样（1 通过），其余 7 个环境按设计跳过。
  - 逐用例记录见 [report.summary.json](runs/pilot-entry-1/report.summary.json)（附件正文已去掉）。
  - 拖放用例 8 个环境的 trace 见 [drop-case-traces.json](runs/pilot-entry-1/drop-case-traces.json)：每个环境都是 2 个上传请求、`dropped.png` 与 `dropped.txt`、`?taskId=2zwQZ2hd93IvLb59t6p5W`、页面地址不变，与 P3.3 两树的探针结果相同。

## G5：Menu 打开后的焦点与 Tab

- **写在哪里**：[component-contracts.md](../component-contracts.md) 新增「Menu 打开后的焦点与 Tab（协调者 2026-10-07 判定）」一节，紧接在 Dropdown → Menu 的替代表之后。ui [README](../../../../src/web/src/components/ui/README.md) 的 Menu 条目加了一句，指向那一节。
- **写了什么**：
  - 约定与判定理由；
  - 账号所有者可推翻；
  - 适用范围：根菜单，打开方式不限，Tab 指焦点进入菜单之后；
  - 不在范围内的情况：窗口内的 Tab（属 P2 跟进（第 2 批窗口））、子菜单里的 Tab、Shift+Tab；
  - 各批同提交对照怎么处理这类差异；
  - 测试依据。
- **测试依据如实写了缺口**：
  - 「打开后焦点在菜单内」有三处常驻检查：`Menu.test.tsx` 的参照用例、`choices.browser.mjs` 的菜单键盘用例、P0 的 `task-action-menu` 截图。其中 P0 截图只在浅色主题看得出这一变化。
  - 「Tab 离开并关闭」目前没有常驻用例断言，只有 p2-keyboard-window 探针的逐键记录（40/40）。
  - 按任务要求只改文档，没有为它加用例。
- **Menu 行为未改**：`git diff 7732f14f8 HEAD -- src/web/src/components/ui/Menu.tsx` 为空。

## G6：证据勘误

新建 [errata.md](../errata.md)，三条逐一核对，都与 P3.3 的说法相符。原文件未改。

| 编号 | 原文位置 | 核对依据 | 更正 |
| --- | --- | --- | --- |
| E1 | `p2.3-b1/README.md:134` | `checks/ab-entrance-v2/entrance-timing.json`：tip 的中位数为 119.5/126.0/113.5/111.5，终版为 115.5/121.5/111.0/112.0 | 原文把两组标签对调了。更正后，终版在三个项目上更早，结论不变。同段第 131 行的 v1 对照也核对过，无误 |
| E2 | `p2.3-b1/README.md:14` | `root-cause/toast-box-e361ee373-to-fix-v2.json`：8 张中只有 Chromium 桌面 2 张的通知框是 0 px。其余 6 张的差异与 `57f792135 → 77233e226` 在同一框内的差异同量，来自页面的 main 漂移；`table.md` 的几何 8/8 回到 B1 前 | 改为「几何恢复，框内 2/8 逐像素相同，其余差异来自 main 漂移」 |
| E3 | `p2-select-keys/summarize-select-keys.py:17` | `checks/after-repeat.json` 的命令是 `--repeat-each 6`；样本数为 240/240/238 | 改为 `--repeat-each 6: 240 samples per target`。生成的 `select-keys-summary.json:4304` 带着同一错误，一并记录 |

## 合并检查

- **命令**：`npm run build -w @orbit/web && npm run test -w @orbit/web`。
- **运行**：在 `d6a764624` 上，即全部交付改动、不含本目录（作业 `bgj_26db771a9c9d`，[meta](runs/merge-check/meta.txt)，[output](runs/merge-check/output.txt)），12:14–12:19 UTC。
- **结果**：退出码 0。
  - Web 构建（`tsc -b && vite build`）通过；
  - Vitest **345 个测试文件、4405 个用例全部通过**，其中包括新增的 `Select.test.tsx`（26 例）和 `Menu.test.tsx`（18 例）。
- `d6a764624` 之后只有文档提交：`cc915a0ac` 改了 `component-contracts.md` 的一行，本目录所在的提交只新增 `p2-p3-hardening/` 下的文件。Web 构建和 Vitest 都不读这两处，唯一读 `docs/evidence` 的 Web 测试读的是 `antigravity-google-login/` 的固定数据。所以合并检查的结果对最终提交同样成立。

## 清单复扫（补充）

本任务没有改生产代码，仍按「清单复扫」的做法在交付 tip 上运行了 `node src/web/scripts/audit-antd.mjs`（作业 `bgj_b01de4a14989`，[runs/audit-antd](runs/audit-antd/)），并与 P3.3 在起点 `7732f14f8` 上的 JSON 报告逐文件比较：
- **新增文件**：只有 `Select.test.tsx`，它没有 antd 导入，也没有命中；
- **内容变化的文件**：只有 ui `README.md`；
- **计数**：只有 `scannedFiles` 与 `testFiles` 各加 1；antd、图标、选择器、ref 等各项计数全部不变。

## 证据体积

按协调者 2026-10-07 12:09Z 的通知「证据体积」：
- 不提交 trace.zip，也不提交带附件正文的 Playwright `report.json`。只提交 `report.summary.json`，由 [tools/summarize-report.py](tools/summarize-report.py) 生成，去掉了附件正文，其余原样保留。
- 不提交截图。拖放用例的 trace 正文单独摘出。
- Vitest 的 JSON 报告没有附件，原样提交。
- 完整原始运行留在 `/var/tmp/p2p3-hardening/`，证据判定后再清理。

本目录合计约 1.4 MB、26 个文件（含本 README），远低于 30 MB 的上限：
- 最大的是合并检查的完整输出，约 1.0 MB；
- 其次是试点的 `report.summary.json`，约 0.3 MB。

`/var/tmp/p2p3-hardening/` 中的原始运行约 89 MB，主要是试点截图与附件，另有清单复扫的完整 JSON。

## 缺口

- **Menu 约定的 Tab 一步没有常驻断言。** 约定里已写明：「打开后焦点在菜单内」由三处常驻检查覆盖；「Tab 离开并关闭」只有 p2-keyboard-window 探针的逐键记录（40/40）。G5 按任务要求只改文档，所以没有补用例。如果要固定这一步，可以在 choices 矩阵的菜单键盘用例里加一步 Tab，由协调者决定放在哪个任务。
- **Select 单测在 jsdom 里运行。** 它确定性地复现了「列表已打开、焦点还在触发器」的窗口。真实浏览器里的按键排队由 p2-select-keys 的 burst 探针证明，本任务没有重跑。窗口内的 Space、Home/End、字符检索不在 G3 范围内，归 P2 跟进（第 2 批窗口）。
- **拖放用例只在交付树上运行。** 它与 AntD 参照的同提交对照是 P3.3 的 `drop-ref-1` / `drop-tip-1`（八环境结果相同），本任务没有另建参照树。用例与探针一样，在按钮上派发合成的 DataTransfer 事件，不覆盖系统级的拖放（从文件管理器拖入）。
- **磁盘**：开工时剩 22 GB，已按作业指导报告协调者。本任务没有其它目录可清理，也没有新建工作树。

## 复现

从仓库根目录运行：

```sh
bash scripts/worktree-overlay.sh
# G3：交付树上通过；撤回修复后失败
(cd src/web && npx vitest run src/components/ui/Select.test.tsx)
python3 -I docs/evidence/base-ui-migration/p2-p3-hardening/tools/revert-632b7950e.py src/web/src/components/ui/Select.tsx
(cd src/web && npx vitest run src/components/ui/Select.test.tsx)   # 11 failed | 15 passed
git checkout -- src/web/src/components/ui/Select.tsx
# G7：试点入口，八环境（先构建；P32_* 指向新的空目录）
npm run build -w @orbit/web
bash docs/evidence/base-ui-migration/p2-p3-hardening/tools/netns.sh 'cd src/web && P32_SNAPSHOTS=/var/tmp/x/shots P32_OUTPUT=/var/tmp/x/pw P32_PORT=4291 npx playwright test -c ui-migration/pilot.config.mjs --update-snapshots=all'
# 合并检查
npm run build -w @orbit/web && npm run test -w @orbit/web
```

`tools/rec.sh <label> <command>` 记录每次正式运行：HEAD、分支、工作区状态、命令、起止时间、负载和退出码，写到 `runs/<label>/`。它与 `tools/netns.sh` 都改自 P3.3 的同名工具。
