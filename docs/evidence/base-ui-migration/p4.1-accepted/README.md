# 登记 P4.1 已接受的 P0 迁移差异：WebKit 手机 profile-validation 两张

本目录服务于任务 [P0 登记（第 4 批）：P4.1 资料页通知胶囊 WebKit 手机两张](orbit-task:34broSTp4jLwdjkmu37Vi)，对应项目验收条目 key `hnPVsE0kmorHXurrs4Qdp`：**P4：全部非会话业务界面完成迁移，既有页面操作和响应式呈现保持一致。**

[P4.1](orbit-task:34Za39Do3N6tkmIMP0GBP) 把资料页切到 Orbit 组件以后，标准 P0 在 WebKit 明、暗手机的 `profile-validation` 上失败：“Name saved”通知胶囊比当前期望右移 4px。协调者 CONFIRM 了 P4.1 第 1 版证据，判定说明把这两张接受为该批的迁移差异，由本任务登记。本任务按 [p0-drift README](../p0-drift/README.md)「已接受的迁移差异（`accepted/`）」第 1–4 条，以 [p3.2-accepted](../p3.2-accepted/README.md) 为先例，把它们登记进已接受层。没有改动以下内容：
- P0.2 原图、main 漂移参考层；
- 比较容差、预期失败名单（known-failures）；
- P0 场景、固定数据与断言。

## 结论

- **登记 2 条**（提交 `563074503`，父提交为项目 tip `3aa26fb97`）：webkit-light-phone 和 webkit-dark-phone 的 `profile-validation`。每条都有：
  - **判定引用**：P4.1 第 1 版证据的 CONFIRM。任务 `34Za39Do3N6tkmIMP0GBP`，`evidenceRevision` 1，`evidenceDigest` `9477611a4499f613621b9dcc7e7c99a7dce050f1caca7ffa22fd95ca60467d57`，文档 [p4.1/README.md](../p4.1/README.md)。Orbit 判定记录为 `6sLVdUrgEbiS5PlOAN8QoZ`，见「引用的判定」。
  - **差异说明**：取自 P4.1 证据和判定说明：胶囊右移 4px；根因是 AntD 表单项的一次同步布局读取，与 Linux WebKit 手机模拟的 8px 滚动条相互作用。全文见「逐张登记表」。
  - **同提交原件和 SHA-256**：before `a84bc61e7`，即 P4.1 的起点（P4.1 第一个交付提交 `0bb647a81` 的父提交）；after `3aa26fb97`，即已落地的 P4.1 交付，也是本任务开工时的项目 tip。两次运行的环境记录都与 P0.2 逐字节相同。
  - **写入方式**：用 [register-accepted.cjs](../p0-drift/tools/register-accepted.cjs) 写入（调用见 [tools/register.sh](tools/register.sh)），没有手改哈希。
- **before 复现当前期望**：
  - 两张 before 原件与被替换的期望逐字节相同。被替换的是第 2 批 A6 的 main 漂移参考（第 7 条例外，`d233a6cd0` 加 B1 修复）。
  - before 全部 252 张在 P0 比较器下都与登记前的期望相符，0 张不符。
- **after 就是登记的期望图**：两张 after 原件就是 `accepted/screenshots/` 里的期望图，哈希相同。它们还与以下两处截图逐字节相同：
  - P4.1 证据中交付 `b0b59fa39` 的截图；
  - P4.1 标准 P0 失败时的 actual。
- **逐张对上了 P4.1 证据**：
  - before → after 的差异像素数和最大级数（明 4861 / 224，暗 4239 / 167），与 P4.1 第 1 版证据 [compare/f-p0-compare.json](../p4.1/compare/f-p0-compare.json) 相同；
  - 差异全在顶部“Name saved”胶囊及其阴影内：明色 x 104–281、y 42–121，暗色 x 100–280、y 44–119。

  **没有对不上的截图，缺口为空。**
- **完整性**：
  - 252 张截图里，after 原件在 P0 比较器下与登记前期望不符的，正好是这 2 张。
  - before → after 有 232 张逐字节相同，18 张是 Chromium 噪声，2 张就是登记的两张。WebKit 共 126 张，除这 2 张外的 124 张逐字节相同。
- **开工时的回归**：登记前在 `3aa26fb97` 上跑，99 通过、11 跳过、2 失败。
  - 2 个失败正是这两张，378 / 341 像素，与 P4.1 证据中的标准 P0 相同。
  - P4.1 落地前项目线吸收了两次 main，没有带来其他失败。
- **当前 tip 上两轮完整 P0 回归全部通过**：在 `563074503`（项目 tip `3aa26fb97` 加登记，工作树干净）上连续跑两轮。
  - 每轮 112 个测试：101 通过、11 跳过、0 失败、0 flaky，两轮逐个状态相同。
  - 期望组装为 `88 P0.2 originals, 150 main drift references, 14 accepted migration differences`。
  - 11 个跳过都是已记录的处置：7 个非参考项目的性能采样，4 个手机项目的桌面断点巡检。
- **负对照**：在登记提交上加 1px 改动，两组回归都以失败结束：
  - **胶囊**：资料页“Name saved”胶囊再右移 1px。profile 8/8 失败在 `profile-validation`：
    - 新登记的两张对照已接受层失败，明色 254 像素、暗色 207 像素；
    - 其余 6 张对照 main 漂移参考失败；
    - 其余 93 通过、11 跳过。
  - **错误文字**：资料页字段错误文字右移 1px。同样 8/8 失败，已接受层的两张为明色 1102、暗色 939 像素。
- **不变项**：
  - 登记提交只改 `p0-drift/accepted/` 的 5 个文件（registry 与 4 张原件），以及 p0-drift README：在已登记清单加了 P4.1 一行和一句说明。
  - 从 `3aa26fb97` 到 HEAD，以下内容都没有变：P0.2 原图与环境记录、main 漂移参考层、`src/web/ui-migration`（场景、断言、固定数据、比较器设置、known-failures）、已接受层其余 12 条。
- **合并检查**：`npm run build -w @orbit/web && npm run test -w @orbit/web` 通过，退出码 0。Web 构建通过；Vitest 350 个测试文件、4445 个用例全部通过。

## 执行经过

- **本会话** `4pN68mzdlLeVZQ2vLGJ44g`，2026-10-07 16:07 起，由 Claude Opus 5.5 执行。
- **开工**：
  - 读了任务、作业指导中「P0 期望截图分三层」与「证据体积」两段、p0-drift README 已接受层第 1–4 条、p3.2-accepted 先例和 P4.1 证据。
  - 项目分支 tip 为 `3aa26fb97`，含 P4.1 的 4 个落地提交。
- **磁盘**：开工时 `df -h /` 只剩 11–14 GB，低于作业指导的 30 GB。
  - 本会话在 /var/tmp 没有可清的目录，16:10 报告了协调者。
  - 协调者回复：用稀疏工作树、只留结论需要的原件；剩余低于 5 GB 时暂停浏览器运行。
  - 运行期间剩余空间在 11–16 GB 之间，没有暂停过。
- **顺序**：
  1. 准备依赖与固定环境；
  2. 开工回归；
  3. 同提交原件；
  4. 对照与独立复核；
  5. 登记提交 `563074503`；
  6. 两轮回归与两组负对照；
  7. 合并检查与本目录。
- 没有推送 main 或项目分支，没有部署或发布。

## 引用的判定

| 版本 | 证据 id | evidenceDigest | 提交时间（UTC） | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `2HlXDdKQS1Ze5LcD2cETLY` | `9477611a4499f613621b9dcc7e7c99a7dce050f1caca7ffa22fd95ca60467d57` | 2026-10-07 15:56 | **CONFIRM**，判定记录 `6sLVdUrgEbiS5PlOAN8QoZ`，2026-10-07 16:00:53 UTC，协调者会话 `34b245G3NiwgVVUj2JFJw` |

判定说明中关于这两张的一条（逐字）：

> 1) P0 的 WebKit 明暗手机 profile-validation 两张接受为本批的迁移差异。根因和隔离都写清了：AntD 表单项的一次同步布局读取，与 Linux WebKit 手机模拟的 8px 滚动条相互作用。Orbit 的结果与 Chromium 手机、设置页 "Setting saved" 的位置一致；真机 iOS 用的是覆盖式滚动条，不受影响。不为测试环境复刻那次布局读取。另建登记任务，在本批落地后登记进已接受层（before 取 a84bc61e7），并引用本判定。

- **为什么引用第 1 版**：P4.1 只有这一版证据。它的 gaps 第 1 条和 README「WebKit 手机 profile-validation：根因与隔离」逐张列出了这两张截图、差异说明和同提交对照。
- **来源**：
  - 证据版本和摘要取自 `task_evidence_list(34Za39Do3N6tkmIMP0GBP)`。
  - 判定记录和判定说明逐字取自协调者 `task_evidence_decide` 调用的服务端响应，存为 [decision/p4.1-decision.json](decision/p4.1-decision.json)。该调用在协调者会话的记录里，tool_use `toolu_01LLkAQshWwbYDMWiNGufZhY`，记录文件路径写在该 JSON 里。查找和抽取工具是 [tools/find-decision.py](tools/find-decision.py) 和 [tools/extract-decision.py](tools/extract-decision.py)。

  判定是否真实存在，由协调者在 Orbit 中按判定记录 id 复核（规则第 4 条）。

## 提交

| 提交 | 内容 |
| --- | --- |
| `563074503` | test：用 register-accepted.cjs 登记 2 条，写 `accepted/registry.json` 和 4 张原件（before、after 各 2 张），在 p0-drift README 的已登记清单加一行和一句说明。只改 `p0-drift/accepted/` 和该 README，父提交 `3aa26fb97` |
| 之后的证据提交 | docs：只改本目录 |

**回退**：回退 `563074503` 即撤销登记。两张截图回到对照 main 漂移参考，P0 在 WebKit 明、暗手机的 profile 用例上重新失败。

## 开工时的 P0 回归

[checks/tip-start](checks/tip-start/summary.json)：在 `3aa26fb97` 上运行，工作树干净，16:15–16:20 UTC。
- 环境记录与 P0.2 逐字节相同。
- 期望组装为 `88 P0.2 originals, 152 main drift references, 12 accepted migration differences`。

结果：112 个测试，99 通过、11 跳过、**2 失败**：

| 项目 | 停在 | 期望来自 | Playwright 差异像素 |
| --- | --- | --- | ---: |
| webkit-light-phone | profile-validation | main 漂移参考 | 378 |
| webkit-dark-phone | profile-validation | main 漂移参考 | 341 |

- [failures.sha256](checks/tip-start/failures.sha256) 记录了失败附件的哈希，只提交了差异图：
  - expected 即被替换的 main 漂移参考（`bfa643b8bbc5`、`ce6c213d39f3`）；
  - actual 即本次登记的期望图（`0fc4f654253d`、`53f9152dc1de`），与 P4.1 证据 [shots/p0-standard](../p4.1/shots/p0-standard) 的 actual 逐字节相同。
- 112 个测试的状态与 P4.1 证据的标准 P0（[f-p0-standard-2](../p4.1/runs/f-p0-standard-2.report.summary.json)）逐个相同。P4.1 落地前吸收的 main（`bf38698b1`、`9f62ddcc6`）没有带来别的失败。

## 同提交原件

**方法**：用 [p3.2-accepted/tools/same-commit-originals.sh](../p3.2-accepted/tools/same-commit-originals.sh)，即 p0-drift 同名工具的参数化版本。p0-drift 那份写死了一个已删除的工作树路径。具体做法：
- 用被测提交自己的 P0 测试、场景和固定数据，经 [drift.config.mjs](../p0-drift/tools/drift.config.mjs) 以 `--update-snapshots=all` 把 252 张矩阵截图写入临时目录；
- 构建与 `pretest:ui-migration` 相同，在独立网络命名空间里运行。

**两棵树**：

| 树 | 做法 |
| --- | --- |
| before | `a84bc61e7` 的稀疏工作树，只检出根目录文件、`src/`、`scripts/`，以及 P0 期望组装要读的 `p0.2/`、`p0-drift/`、`p0-drift-2/isolation/`、`p2.3-b1/README.md`、`p3.2/README.md`。`a84bc61e7` 的证据目录未瘦身，约 1.9 GB，完整检出会占满磁盘 |
| after | 本工作树，`3aa26fb97`，干净 |

两棵树都用 `bash scripts/worktree-overlay.sh` 准备依赖。锁文件在 `a84bc61e7`、`3aa26fb97`、`62641903e` 上相同（`f03a6e323a33`）。驱动脚本见 [tools/originals.sh](tools/originals.sh)。

| 运行 | 提交 | 截图 | 环境 | 结果 |
| --- | --- | ---: | --- | --- |
| [before](originals/before-a84bc61e7/meta.json) | `a84bc61e7`：P4.1 的起点 | 252 | 等于 P0.2 | 76 通过、4 跳过，16:26–16:30 UTC |
| [after](originals/after-3aa26fb97/meta.json) | `3aa26fb97`：已落地的 P4.1 交付 | 252 | 等于 P0.2 | 76 通过、4 跳过，16:20–16:26 UTC |

每次运行的提交、环境哈希、全部截图的 SHA-256（`snapshots.sha256`）、构建产物哈希、输出和报告摘要都在 [originals/](originals/)。登记前的期望组装来源（`sources.json`）是 [originals/expected-pre.sources.json](originals/expected-pre.sources.json)，其中 252 张文件哈希都与记录一致。

**after 为什么取 `3aa26fb97`**：P4.1 在 `a84bc61e7` 上交付了 `0bb647a81`、`7d81822b1`、`b0b59fa39`、`62641903e`。落地前，项目线吸收了 main 两次（`bf38698b1`、`9f62ddcc6`）并完成证据瘦身，所以 P4.1 以 rebase 落地为 `3c1d969db`、`b9d154547`、`c4a280571`、`3aa26fb97`。
- 落地的 4 个提交与交付的 4 个逐个 `git patch-id` 相同，在登记复核中检查。
- 两张 after 原件与 P4.1 证据中交付 `b0b59fa39` 的截图逐字节相同。所以吸收的 main 没有改动这两张，before → after 的差异全部来自 P4.1。
- 同理，两张 before 原件与 P4.1 证据中 AntD 参照 `b5a39dd48` 的截图逐字节相同。

对照（[compare/](compare/)，[compare.cjs](../p3.2-accepted/tools/compare.cjs)，第一个目录是期望一侧）：

| 对照 | 逐字节相同 | Chromium 噪声 | 超出噪声但比较器通过 | P0 比较器不符 |
| --- | ---: | ---: | ---: | ---: |
| [登记前期望 → before](compare/exp-vs-before.json) | 221 | 14（≤118 像素，≤4 级） | 17 | **0** |
| [登记前期望 → after](compare/exp-vs-after.json) | 214 | 19（≤110 像素，≤2 级） | 17 | **2**：本次登记的两张 |
| [before → after](compare/before-vs-after.json) | 232 | 18（≤97 像素，≤4 级） | 0 | **2**：本次登记的两张 |

两个「17」是同一组截图，before 与 after 逐字节相同，与 P4.1 无关，见「未登记的截图」。

## 逐张登记表

registry：[../p0-drift/accepted/registry.json](../p0-drift/accepted/registry.json)。原件：
- before 在 `../p0-drift/accepted/before/{项目}/profile-validation.png`；
- after 即登记的期望图，在 `../p0-drift/accepted/screenshots/{项目}/profile-validation.png`。

两条共用以下值：
- `replaces.layer` 为 `p0-drift`。被替换的是第 2 批 A6 的 main 漂移参考：`mainCommits` 为 `d233a6cd0`，按第 7 条例外在 `d233a6cd0` 加 B1 修复 `3ec9cf83d` 的树（`dcb5fd1bd`）上生成；
- `sameCommit.before.commit` 为 `a84bc61e7913b1ecae26c0a5a74d4c4887454e99`；
- `sameCommit.after.commit` 为 `3aa26fb97644f24551dc9c70149021f7f7f9453f`；
- `sameCommit.environment` 为 `fe69e82445e35a3196501a240c567b71b4039e40e434832ae9fd77f348f9cbdf`，即 P0.2 的 environment.json。

| 截图 | 被替换的期望 = before 原件 | after 原件 = 登记的期望 | before → after 差异像素 / 最大级 | P4.1 第 1 版 f-p0-compare | Playwright 差异像素 |
| --- | --- | --- | ---: | ---: | ---: |
| webkit-light-phone/profile-validation | `bfa643b8bbc5` | `0fc4f654253d` | 4861 / 224 | 4861 / 224 | 378 |
| webkit-dark-phone/profile-validation | `ce6c213d39f3` | `53f9152dc1de` | 4239 / 167 | 4239 / 167 | 341 |

完整哈希在 registry 和 [checks/registration-check.json](checks/registration-check.json)。

**差异说明**（两条相同，写入 registry 的 `difference`）：

> P4.1 把资料页的表单换成 Orbit 字段组件和原生表单。P0 profile 场景保存名字后截取 profile-validation：顶部“Name saved”通知胶囊在 after 中比 before 右移 4px（通知列宽 358 对 350，胶囊 x 127.14 对 123.14），差异只在胶囊及其阴影的区域。根因：lib/toast 第一次提示时往 body 末尾加读屏 live region，资料页文档从 844px 变成 845px；Linux WebKit 手机模拟里，全局 8px ::-webkit-scrollbar 让溢出之后才排版的固定定位元素按 382 宽排，之前排好的保持 390（P2.3-B1 复现过的现象）。before 的 AntD 表单在 live region 与通知列插入之间读了 4 个 .ant-form-item 的 offsetParent，这次同步布局先看到了溢出，通知列按 382 排；Orbit 的 Field 不读布局，通知列按溢出前的 390 排，与 Chromium 手机、与设置页“Setting saved”的位置一致。由测试注入一次布局读取后，after 与 P0 期望（即 before）逐像素一致。真机 iOS 用覆盖式滚动条，不受影响。协调者判定接受为本批的迁移差异，不为测试环境复刻那次布局读取。出处：p4.1/README.md「P0 页面矩阵（同提交）」profile-validation 行与「WebKit 手机 profile-validation：根因与隔离」；P4.1 第 1 版证据 compare/f-p0-compare.json 中该截图的像素数与最大级数，与本条 before → after 相同。

说明中的数字和机制都出自 P4.1 证据，本任务没有重新测量。
- 通知列宽、胶囊 x 来自 P4.1 的探针，见 [toast-root-cause/](../p4.1/toast-root-cause)；
- 注入一次读取后的逐像素一致来自 P4.1 的 [isolation/](../p4.1/isolation)。

本任务核对了以下几点：
- before → after 的像素数、最大级数与 P4.1 一致；
- 两张原件与 P4.1 的参照、交付截图逐字节相同；
- 差异的位置在胶囊上。

**裁图**：[regions/crops](regions/crops/)。每张依次为 before、after、差异放大 4 倍，数据在 [regions/before-vs-after.json](regions/before-vs-after.json)。

| 截图 | 全部差异的外框 | 超过 2 级的像素 | 超过 2 级的聚类 |
| --- | --- | ---: | --- |
| webkit-light-phone | x 104–281，y 42–121 | 1820 | 胶囊主体与图标 131×44（1342 像素），胶囊右端 29×44（478） |
| webkit-dark-phone | x 100–280，y 44–119 | 1317 | 胶囊主体与图标 124×43（1104），胶囊右端 20×36（213） |

## 未登记的截图

- **低于阈值的既有差异，17 张**：登记前期望对照 before 和 after 都有这 17 张，before 与 after 逐字节相同，比较器都判为相符，与 P4.1 无关：
  - P3.2 已记录的 11 张：深色 task-action-menu 4 张；webkit-dark-phone 的 task-detail、task-action-hover、task-action-focus；WebKit 桌面的 breakpoint-599/601-dialog 4 张。见 [p3.2-accepted](../p3.2-accepted/README.md)「未登记的截图」。
  - 第 2 批已记录的 6 张：WebKit 的 settings 4 张和 settings-saved 桌面 2 张，428–780 像素，≤35 级。原因是 `d233a6cd0` 让设置页变高，WebKit 8px 滚动条的滑块变短。见 [p0-drift-2](../p0-drift-2/README.md)「低于阈值」。
- **Chromium 噪声**：before → after 有 18 张，都在 p0-drift 的噪声范围（单通道差 ≤4、≤200 像素）内，都通过比较器。其中：
  - Chromium 的 profile-validation 4 张：28–97 像素，≤2 级。P4.1 记为抗锯齿级，交付对参照 86–110 像素。
  - 其余 14 张：3–35 像素。

  逐张见 [compare/before-vs-after.json](compare/before-vs-after.json)。
- **WebKit 的其余截图**：before → after 逐字节相同，除了登记的两张没有任何变化。
- **设置页**（`settings`、`settings-saved`，16 张）：14 张 before 与 after 逐字节相同，只有 Chromium 手机的 settings-saved 2 张是噪声（6、20 像素，1 级）。这与 P4.1 证据「settings 场景的截图 8 个环境都与参照逐字节或抗锯齿级相同」一致。

## 验证

### 两轮完整 P0 回归（当前 tip）

命令是 P0 原命令 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web`，经 [netns-regression.sh](../p0-drift-2/tools/netns-regression.sh) 放在独立网络命名空间里。在本工作树 `563074503` 上连续运行，该提交即项目 tip `3aa26fb97` 加登记，工作树干净。驱动脚本是 [tools/final-and-controls.sh](tools/final-and-controls.sh)，作业 `bgj_49dfd8be4492`。

| 轮次 | 结果 | 记录 |
| --- | --- | --- |
| 第 1 轮（16:33–16:39 UTC） | 112 个测试：101 通过、11 跳过、0 失败、0 flaky，退出码 0 | [summary](checks/final-round-1/summary.json)、[报告摘要](checks/final-round-1/report.summary.json)、[输出](checks/final-round-1/command-output.txt)、[sources](checks/final-round-1/sources.json) |
| 第 2 轮（紧接其后，16:39–16:43 UTC） | 与第 1 轮逐个状态相同，退出码 0 | [checks/final-round-2](checks/final-round-2/summary.json) |

- 两轮都先通过了 globalSetup 对 P0.2 原图、两层登记和环境的校验。期望组装为 `88 P0.2 originals, 150 main drift references, 14 accepted migration differences`。
- 两轮的 sources.json 逐字节相同。其中 WebKit 明、暗手机的 profile-validation 来自 `accepted` 层，`replaces` 为对应的 main 漂移参考，`decision` 为 P4.1 第 1 版。
- 环境记录与 P0.2 逐字节相同（[environment-check](checks/final-round-1/environment-check.txt)）。
- 结果只含已记录的处置：101 个通过，11 个跳过（7 个非参考项目的性能采样，4 个手机项目的桌面断点巡检，同 P0.2 记录）。没有失败、flaky 或预期失败。

### 登记复核

[tools/verify-registration.cjs](tools/verify-registration.cjs) 不经登记工具，独立复核两条登记，结果在 [checks/registration-check.json](checks/registration-check.json)，问题数为 0。它由 p3.2-accepted 的同名工具改写，逐条检查：
- **判定字段**：等于引用的第 1 版 CONFIRM，文档存在，差异说明非空，没有 `previous`；
- **replaces**：是该截图的 main 漂移参考，参考文件哈希与 registry 一致；登记前的期望组装也取自它；
- **提交**：
  - before 是 P4.1 第一个交付提交 `0bb647a81` 的父提交；
  - 落地的 4 个提交与交付的 4 个 `git patch-id` 逐个相同，在项目线上连续；
  - after 是最后一个落地提交；
  - before、after 都在当前 HEAD 的 first-parent 线上；
- **环境**：两次运行都与 P0.2 相同；
- **原件**：`accepted/` 里的 before/after 与运行目录的截图、registry 记录的哈希逐字节相同，也与 P4.1 证据的参照、交付截图（`f-p0-compare.json` 的 `sha256Ref`/`sha256Del` 与 `shots/p0-beyond`）逐字节相同；
- **比较器**：before 在 P0 比较器下复现被替换的期望，after 与 before 不符；
- **P4.1 数据**：before → after 的像素数与最大级数等于 P4.1 第 1 版 `f-p0-compare.json` 的记录；
- **已接受层其余条目**：与 `3aa26fb97` 上的 12 条逐字段相同；
- **完整性**：
  - 全部 252 张中，after 对登记前期望不符的恰是登记的两张；
  - before 对登记前期望 0 张不符。

### 负对照

所有负对照都在临时树上做：
- 把上面的稀疏工作树移到 `/var/tmp/p41acc/trees/nc`，指向登记提交 `563074503`，补检出 `p4.1/README.md`，按 worktree-overlay.sh 重新准备；
- 把补丁追加到 `src/web/src/index.css`，以临时提交固定，不交付、不推送；
- 跑同一条 P0 原命令。驱动脚本同上。

两个补丁都用 `body:has(input[autocomplete="name"])` 限定在资料页，只影响 `profile-validation`：
- 胶囊在 `profile` 截图之后才出现；
- 字段错误在点 Change password 之后才出现。

| 对照 | 改动 | 被测截图当时的期望 | 结果 | 记录 |
| --- | --- | --- | --- | --- |
| 胶囊 | `.toast--pill { position: relative; left: 1px }`，资料页“Name saved”胶囊再右移 1px（[patch](negative-control/pill/patch.diff)，临时提交 `99f2c7e00`） | WebKit 明、暗手机 2 张为已接受层（本次登记），其余 6 张为 main 漂移参考 | **profile 8/8 失败在 profile-validation**：已接受层明 254、暗 207 像素；main 漂移参考 208–276 像素。其余 93 通过、11 跳过。退出码 1 | [summary](negative-control/pill/summary.json)、[差异图](negative-control/pill/failures/)、[裁图](regions/nc-pill-crops/) |
| 错误文字 | `.orbit-field-error { position: relative; left: 1px }`，资料页 Change password 三条字段错误右移 1px（[patch](negative-control/field-error/patch.diff)，临时提交 `517b94523`） | 同上 | **profile 8/8 失败在 profile-validation**：已接受层明 1102、暗 939 像素；main 漂移参考 906–1102 像素。其余 93 通过、11 跳过。退出码 1 | [summary](negative-control/field-error/summary.json)、[差异图](negative-control/field-error/failures/)、[裁图](regions/nc-field-error-crops/) |

- 两组对照里，WebKit 手机两张失败时的 expected 就是本次登记的期望图（`0fc4f654253d`、`53f9152dc1de`，见各自的 `failures.sha256`），所以失败是对照已接受层的失败。
- 拿 actual 与登记的期望图对照（[regions/nc-pill.json](regions/nc-pill.json)、[regions/nc-field-error.json](regions/nc-field-error.json)），差异正是补丁改动的地方：
  - 胶囊对照只在胶囊及其阴影上：明色全部差异在 x 108–282、y 42–121 内；超过 2 级的聚类是文字 81×11、图标与左端 30×36、右端约 16×35，都在 y 56–91；
  - 错误文字对照只在三行错误文字上：全部差异在 x 41–216、y 480–665 内，三行分别从 y 480、566、652 开始，宽 138–175、高 14。
- 第 1 组改动的正是本次接受的差异（胶囊位置）：胶囊位置的 1px 偏差会被检出，没有被登记放过。第 2 组说明登记后的期望图仍逐像素守着页面的其他部分。

### 合并检查

项目合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web`：
- **运行位置**：本工作树 `563074503`，代码与之后的证据提交相同。运行时本目录正在整理，未跟踪，构建和测试都不读它。作业 `bgj_468a376bf402`，2026-10-07 16:54 UTC 开始。
- **结果**：退出码 0，16:54–16:58 UTC。
  - `tsc -b && vite build` 通过，保留原有的大 chunk 提示；
  - Vitest（`--maxWorkers=2`）**350 个测试文件、4445 个用例全部通过**，用时 272 秒。
- **记录**：
  - [checks/merge-check.txt](checks/merge-check.txt) 是 [filter-merge-check.py](../p3.2-accepted/tools/filter-merge-check.py) 过滤后的输出。它保留完整构建输出、每个测试文件的结果行和汇总行，去掉了用例运行中打印的控制台告警；
  - 完整输出 14426 行，写在本机 `/var/tmp/p41acc/merge-check.log`，按任务要求在交证据前随临时目录删除。它的行数和 SHA-256 见 [checks/merge-check.json](checks/merge-check.json)。作业本身只输出最后一行 `merge-check exit 0`。

### 不变项

[tools/scope-check.sh](tools/scope-check.sh) 的输出在 [checks/scope-check.txt](checks/scope-check.txt)：
- **登记提交**：只改 `p0-drift/accepted/` 下 5 个文件（registry 与 4 张原件）和 `p0-drift/README.md`。README 只在已登记清单加了 P4.1 一行和一句说明。
- **受保护的路径**：从开工时的项目 tip `3aa26fb97` 到 HEAD，以下 `git diff --stat` 为空：
  - `p0.2/`（原图、环境记录、baseline-run）；
  - `p0-drift/reference/`（main 漂移参考层）；
  - `src/web/ui-migration/`（场景、断言、固定数据、`maxDiffPixels: 0` 与默认 threshold、known-failures、期望组装）；
  - `src/web/package.json`。
- **已接受层其余 12 条**：与 `3aa26fb97` 逐字段相同。
- **登记之后的提交**：只改本目录。

## 边界

- **after 原件的提交**：after 取自 `3aa26fb97`，即已落地的 P4.1 交付，也是本任务开工和结束时的项目 tip，不是 P4.1 在 `a84bc61e7` 上的交付 `b0b59fa39`。两者的 P4.1 提交 patch 相同；两张截图在两处逐字节相同，见「同提交原件」。
- **判定引用**：registry 只能离线校验判定的格式和文档是否存在。判定是否真实存在，要由协调者在 Orbit 中核对（规则第 4 条）。本目录保存了证据版本和判定响应的原文。
- **根因与真机**：差异说明中的机制、通知列宽、胶囊 x 和真机 iOS 不受影响的判断都来自 P4.1 证据和判定，本任务只核对了像素数据和差异位置。
- **低于阈值的差异**：P0 比较器（`maxDiffPixels: 0`、默认 threshold）看不到的差异，没有也不能登记，已在「未登记的截图」列出。
- **临时目录**：tools/ 里的脚本写着 `/var/tmp/p41acc` 和本工作树的路径。按任务要求，交证据前删除了 `/var/tmp/p41acc`，包括两棵临时工作树和全部运行原件。
  - 证据里保存了每次运行的记录和全部截图哈希，登记的 4 张原件在 `p0-drift/accepted/`。
  - verify-registration.cjs 的完整性部分要读运行目录里的 504 张原件，复跑须先用 originals.sh 重新生成。WebKit 截图在这台主机上可逐字节复现：两张 before/after 与 P4.1 证据中更早那次运行的截图逐字节相同。
- **负载**：浏览器运行期间主机负载约 26–36，合并检查时约 16–22，有其他会话的浏览器与构建。所有回归都在第一次运行即得到上述结果，没有重跑。
- **其余边界同 P0.2**：Linux 固定环境、合成 REST/SSE、非真机 iOS。

## 复跑

```sh
bash scripts/worktree-overlay.sh
NO_COLOR=1 npm run test:ui-migration -w @orbit/web            # 应全部通过：101 通过、11 跳过
bash docs/evidence/base-ui-migration/p4.1-accepted/tools/scope-check.sh 563074503
npm run build -w @orbit/web && npm run test -w @orbit/web
```

工具（[tools/](tools/)）：
- **原件**：`originals.sh`，包括开工回归与两次同提交原件，依次调用 netns-regression.sh 和 p3.2-accepted 的 same-commit-originals.sh；
- **判定**：`find-decision.py`、`extract-decision.py`；
- **登记**：`register.sh`，即这次的 `register-accepted.cjs` 调用；
- **复核**：`verify-registration.cjs <运行目录> <输出>`、`scope-check.sh <登记提交>`；
- **回归与负对照**：`final-and-controls.sh`，补丁 `negative-control-pill.css`、`negative-control-field-error.css`；
- **归档**：`collect.sh`，按「证据体积」约定从运行目录取出本目录引用的文件。

对照和裁图沿用 p3.2-accepted 的 [compare.cjs](../p3.2-accepted/tools/compare.cjs) 和 [regions.py](../p3.2-accepted/tools/regions.py)。

## 文件

| 路径 | 内容 |
| --- | --- |
| [decision/p4.1-decision.json](decision/p4.1-decision.json) | 引用的判定：P4.1 证据版本、摘要，协调者判定调用及服务端响应原文 |
| [checks/tip-start/](checks/tip-start/) | 开工回归（`3aa26fb97`，登记前），含 2 个失败的差异图和附件哈希 |
| [checks/final-round-1/](checks/final-round-1/)、[final-round-2/](checks/final-round-2/) | 当前 tip 上的两轮回归 |
| [checks/registration-check.json](checks/registration-check.json) | 登记复核与 252 张的完整性 |
| [checks/scope-check.txt](checks/scope-check.txt) | 登记提交的范围与受保护路径 |
| [checks/merge-check.txt](checks/merge-check.txt)、[merge-check.json](checks/merge-check.json) | 合并检查 |
| [originals/](originals/) | 同提交原件：提交、环境、全部截图哈希、构建产物哈希、输出、报告摘要；登记前的期望来源 |
| [compare/](compare/) | compare.cjs 的逐张对照：登记前期望、before、after |
| [regions/](regions/) | before → after 与两组负对照的差异区域与裁图 |
| [negative-control/](negative-control/) | 两组负对照：补丁、输出、summary、报告摘要、差异图、附件哈希 |
| [tools/](tools/) | 上述脚本 |

报告按「证据体积」约定只交 report.summary.json（去掉附件正文），没有提交 trace.zip。截图只提交上表引用的差异图和裁图。本目录约 4.5 MB。
