# 登记 P5.3 已接受的 P0 迁移差异：会话页附件两张截图（8 条）

本目录服务于任务 [P5.3 的 6 张 P0 迁移差异登记进已接受层](orbit-task:34dTUdzY6mgNk4CGh7ZHl)，对应项目验收条目 key `5wbhutjez7Qv5GCTNLb0P7`：**P7：完整迁移通过最终构建、行为与视觉回归，并有实测收益和可回退交付记录。**

[P5.3](orbit-task:34Za39Ov1yysHZaYL6wgJ) 把会话工作区换成 Orbit 组件以后，标准 P0 在会话页有 6 个失败：两个明色桌面停在 `session-attachment-staged`，四个手机停在 `session-attachment-menu`。协调者 CONFIRM 了 P5.3 第 1 版证据，判定说明把这两类接受为该批的迁移差异，并要求登记时按比较器确认手机上过了附件菜单之后的 `session-attachment-staged`。本任务按 [p0-drift README](../p0-drift/README.md)「已接受的迁移差异（`accepted/`）」第 1–4 条，以 [p4.1-accepted](../p4.1-accepted/README.md)、[p3.2-accepted](../p3.2-accepted/README.md) 为先例登记。没有改动 P0.2 原图、main 漂移参考层、比较容差、known-failures、P0 场景、固定数据与断言，也没有改动产品代码。

## 结论

- **比较器确认：需要条目的是 8 张，不是 6 张。** 在 P5.3 的同提交原件上（before = 参照 `8f94ddda9`，after = 交付 `b72da6eda`），252 张里 after 对登记前期望不符 P0 比较器的正好 8 张：标准 P0 的 6 张，加上明色两个手机环境的 `session-attachment-staged`。手机上这张排在 `session-attachment-menu` 之后，标准 P0 的用例停在前一张，所以 P5.3 的 6 个失败里没有它。暗色 4 个环境的 `session-attachment-staged` 与 WebKit 桌面 2 张 `session-attachment-menu` 的差异低于比较器阈值，登记工具不收，见「未登记的截图」。
- **登记 8 条**（提交 `0cede69fb`，只改 `p0-drift/accepted/` 的 17 个文件与 `p0-drift/README.md` 的已登记清单）：
  - `session-attachment-staged`：chromium-light-desktop、webkit-light-desktop、chromium-light-phone、webkit-light-phone；
  - `session-attachment-menu`：chromium-light-phone、chromium-dark-phone、webkit-light-phone、webkit-dark-phone。

  每条都有：
  - **判定引用**：P5.3 第 1 版证据的 CONFIRM。任务 `34Za39Ov1yysHZaYL6wgJ`，`evidenceRevision` 1，`evidenceDigest` `6f0931ccd70e1d4f7d2b0920a9245931732498837a3cc9780c64b8cd928c01c2`，文档 [p5.3/README.md](../p5.3/README.md)。Orbit 判定记录 `61sATHPY66znwxRZorvP8d`，见「引用的判定」。
  - **差异说明**：取自 P5.3 证据和判定说明，三段（明色桌面的 staged、明色手机的 staged、手机的菜单），全文在 registry 的 `difference`，摘要见「逐张登记表」。
  - **同提交原件与 SHA-256**：before `8f94ddda9`，即 P5.3 的同提交参照（交付 `b72da6eda` 只撤回业务切换 `c868a02c2`）；after `b72da6eda`，即 P5.3 的交付，经 `a167c2ff0` 落地项目线。两次运行的环境记录都与 P0.2 逐字节相同。
  - **写入方式**：用 [register-accepted.cjs](../p0-drift/tools/register-accepted.cjs) 写入（调用见 [tools/register.sh](tools/register.sh)），没有手改哈希。没有 `previous`：这 8 张以前没有已接受登记。
- **原件就是 P5.3 比较过的那两张**：8 张 before 与 P5.3 正式轮 f1 的参照截图、8 张 after 与它的交付截图逐字节相同；before → after 的像素数和最大级数与 P5.3 第 1 版证据 [compare/p0-summary.json](../p5.3/compare/p0-summary.json) 逐张相同。
- **before 复现当前期望**：8 张 before 与被替换的 main 漂移参考逐字节相同；全部 252 张 before 对登记前期望都通过比较器。
- **差异的位置与 P5.3 的说明一致**：
  - staged：输入框卡片里面 0 个像素不同（Chromium 手机 7 个像素、单通道差 ≤2），差异全在卡片 1px 边框一圈（单通道差 53）和外面的阴影；
  - 菜单：超过 2 级的差异只在 5 个菜单标签（14px → 17px）和 Shell 一行的终端图标（上移约 1px）。
- **开工时的回归**：登记前在项目 tip `a167c2ff0` 上 95 通过、11 跳过、6 失败，6 个失败与 Playwright 差异像素数都与 P5.3 证据的标准 P0 相同。
- **登记后两轮完整 P0 回归全部通过**：在登记提交 `0cede69fb` 上（工作树干净）连续跑两轮，每轮 112 个测试：101 通过、11 跳过、0 失败、0 flaky，两轮逐个状态相同。6 个原来的失败消失，手机上的 `session-attachment-staged` 也照常比较并通过；11 个跳过都是已记录的处置。
- **负对照**：在登记提交上加 1px 改动，两组回归都以失败结束，新登记的 8 条都被其中一组覆盖：
  - **菜单**：手机附件菜单的图标右移 1px。4 个手机的 session 用例都停在 `session-attachment-menu`，对照的正是新登记的已接受期望（134–210 像素），差异只在菜单的图标一列；其余 97 通过、11 跳过。
  - **文件 chip**：输入框里文件 chip 的文件名右移 1px。8 个 session 用例都停在 `session-attachment-staged`：新登记的 4 张对照已接受期望失败（221–231 像素），差异只在文件名一行；暗色 4 张对照 main 漂移参考失败。其余 93 通过、11 跳过。手机上用例先通过了新登记的菜单截图才走到这一张。
- **期望组装计数与清单一致**：两轮都输出 `44 P0.2 originals, 165 main drift references, 43 accepted migration differences`，`sources.json` 的三层计数相同；已接受层 43 条 = P3.2 判定 23 + WebKit 滚动锁判定 11 + P4.1 判定 1 + P5.3 判定 8，p0-drift README 清单新增的 P5.3 一行为 8 条（[checks/counts.txt](checks/counts.txt)）。
- **不变项**：登记提交只改 `p0-drift/accepted/` 的 17 个文件（registry 与 16 张原件）和 `p0-drift/README.md`（已登记清单加 P5.3 一行和一段说明）。从开工时的项目 tip `a167c2ff0` 到 HEAD，P0.2 原图与环境记录、main 漂移参考层、`src/web/ui-migration`（场景、断言、固定数据、`maxDiffPixels: 0` 与默认 threshold、known-failures、期望组装）、`src/web/package.json` 都没有变；本任务的提交没有改 `src/` 的任何文件；已接受层其余 35 条与 `a167c2ff0` 逐字段相同。
- **合并检查**：`npm run build -w @orbit/web && npm run test -w @orbit/web` 在登记提交上通过，退出码 0：Web 构建通过；Vitest **399 个测试文件、5163 个用例全部通过**。登记提交的生产构建 25 个文件与 after（`b72da6eda`）的构建逐字节相同。

## 执行经过

- **本会话** `4de9G8ZzGeuSxO8htJBRRQ`，2026-10-10 11:48 UTC 起，由 Claude Opus 5.5 执行（provider claude、model claude-opus-5-5）。
- **开工核对**：项目分支 tip `a167c2ff0`（Merge orbit/p5-3-e07a4f）含 P5.3 的交付 `b72da6eda` 与证据 `928b9c162`，`p5.3/` 证据目录可用；当时的 origin/main `6fa5196e5` 已在 tip 里。
- **跟上 main**：登记前 origin/main 前进到 `e83d71958`，其中 `9274d5242` 把项目 tip `a167c2ff0` 晋升进 main，所以按作业指导直接 rebase 到 origin/main（本分支还没有自己的提交，是快进）。main 在 tip 之外只改了 23 个 apiserver 文件、`src/web/src/copyLanguage.test.ts`（单测）与一份文档，没有 Web 产品代码、shared、锁文件、P0 测试或证据层的改动。跟上之后 `audit-antd.mjs --check-owners`：0 未归属、0 待定（KEEP 1、P6 42），与 P5.3 交付时相同。
- **交证据前 main 又前进**（到 `a209ed434`）：按作业指导先用 `git merge-tree` 对最新 origin/main 干跑，无冲突；main 自 `e83d71958` 起改的是 apiserver 21 个、runner-go 1 个、contracts 1 个、docs 2 个、`runner-release.json`、`src/shared/src` 的 Wiki 文档构建金样与其 spec（只被 apiserver、runner-go 与契约测试读，Web 不读）、`src/web/src/copyLanguage.test.ts`（单测），没有改本任务的文件，也没有改 ui/ 公共组件、index.css、Toast/弹层与 P0 测试。所以不再跟一次，只记下干跑结果和改动清单（[checks/main-dry-run.txt](checks/main-dry-run.txt)），由落地的合并检查兜底。
- **顺序**：开工回归（`a167c2ff0`）→ 同提交原件（after、before）→ 对照、区域与判定记录 → 跟上 main → 登记 `0cede69fb` 与独立复核 → 两轮回归、两组负对照 → 合并检查 → 本目录 → 对最新 main 干跑。
- **资源**：重运行都在 6G 的 systemd scope 里（`oom_score_adj` 500）、串行、起跑前等可用内存 ≥3.5 GB；临时树与原件在 `/mnt/data/tmp/34dTUdzY6mgNk4CGh7ZHl/`。期间主机负载约 11–37。
- 没有推送 main 或项目分支，没有部署或发布。

## 引用的判定

| 版本 | 证据 id | evidenceDigest | 提交时间（UTC） | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `4YaPO25KrZzGyHllghOKYg` | `6f0931ccd70e1d4f7d2b0920a9245931732498837a3cc9780c64b8cd928c01c2` | 2026-10-10 11:42:51 | **CONFIRM**，判定记录 `61sATHPY66znwxRZorvP8d`，2026-10-10 11:44:02 UTC，协调者会话 `34b245G3NiwgVVUj2JFJw` |

判定说明中关于这两类截图的一条（逐字）：

> 1) 标准 P0 的 6 个失败 = 本批迁移差异，接受：session-attachment-staged（2 个明色桌面）是已验收焦点约定「关闭后焦点回到发起按钮」的可见结果（焦点回到 + 落在输入框 :focus-within 内；输入框内部逐像素相同，只有轮廓与阴影；暗色在阈值内）；session-attachment-menu（4 个手机）是 P2.2 任务指定的 17px 附件变体。两者都需要按已接受层登记（CONFIRM + 落地之后）——我会另立登记任务，并让它按比较器重新确认哪些截图需要条目（手机上过附件菜单后还有 session-attachment-staged）。

- **为什么引用第 1 版**：P5.3 只有这一版证据。它的 README「合并检查与 P0」逐张列出了 P0 页面矩阵里这两类截图（staged 8 个环境、菜单 4 个手机环境）、差异说明和同提交对照，gaps 第 3 条写明了标准 P0 的 6 个失败。
- **判定记录 id**：任务描述里一处写作 `61sATHPYY66znwxRZorvP8d`，服务端响应是 `61sATHPY66znwxRZorvP8d`，本目录与 registry 的说明都用后者；registry 的 `decision` 字段按规则只记任务、版本、摘要与文档。
- **来源**：证据版本和摘要取自 `orbit task evidence-list 34Za39Ov1yysHZaYL6wgJ --json`；判定记录和说明逐字取自协调者 `task_evidence_decide` 调用的服务端响应，存为 [decision/p5.3-decision.json](decision/p5.3-decision.json)（调用 `call_00_M1GCIfSHB3jxYjkOp0gs2174`，记录文件路径写在 JSON 里；工具 [find-decision.py](tools/find-decision.py)、[extract-decision.py](tools/extract-decision.py)）。判定是否真实存在，由协调者在 Orbit 中按判定记录 id 复核（规则第 4 条）。

## 提交

| 提交 | 内容 |
| --- | --- |
| `0cede69fb` | test：用 register-accepted.cjs 登记 8 条，写 `accepted/registry.json` 和 16 张原件（before、after 各 8 张），在 p0-drift README 的已登记清单加 P5.3 一行和一段说明。只改 `p0-drift/accepted/` 和该 README，父提交是跟上之后的 origin/main `e83d71958` |
| 之后的证据提交 | docs：只改本目录 |

**回退**：回退 `0cede69fb` 即撤销登记，这 8 张回到对照 main 漂移参考，标准 P0 在会话页重新有 6 个失败。

## 开工时的 P0 回归

[checks/tip-start](checks/tip-start/summary.json)：在 `a167c2ff0` 上（工作树干净），11:56–11:59 UTC。环境记录与 P0.2 逐字节相同，期望组装为 `44 P0.2 originals, 173 main drift references, 35 accepted migration differences`。112 个测试：95 通过、11 跳过、**6 失败**，都在会话场景、都对照 main 漂移参考：

| 项目 | 停在 | Playwright 差异像素 | P5.3 标准 P0 |
| --- | --- | ---: | ---: |
| chromium-light-desktop | session-attachment-staged | 1382 | 1382 |
| webkit-light-desktop | session-attachment-staged | 1388 | 1388 |
| chromium-light-phone | session-attachment-menu | 1045 | 1045 |
| chromium-dark-phone | session-attachment-menu | 925 | 925 |
| webkit-light-phone | session-attachment-menu | 958 | 958 |
| webkit-dark-phone | session-attachment-menu | 834 | 834 |

P5.3 一列取自 [p5.3/checks/p0-standard-compare.txt](../p5.3/checks/p0-standard-compare.txt)。失败附件只提交差异图，expected/actual 的哈希在 [failures.sha256](checks/tip-start/failures.sha256)。

## 同提交原件

**方法**：[p3.2-accepted/tools/same-commit-originals.sh](../p3.2-accepted/tools/same-commit-originals.sh)：用被测提交自己的 P0 测试、场景和固定数据，经 [drift.config.mjs](../p0-drift/tools/drift.config.mjs) 以 `--update-snapshots=all` 把 252 张矩阵截图写入临时目录；构建与 `pretest:ui-migration` 相同，在独立网络命名空间里运行。驱动脚本 [tools/originals.sh](tools/originals.sh)。

**两棵树**（[tools/make-trees.sh](tools/make-trees.sh)，`/mnt/data` 上的稀疏工作树，同 P5.3 的 make-trees.sh：根目录文件、`src/web`、`src/shared` 与 P0 期望组装要读的证据；依赖用本工作树的安装，三个提交的锁文件都是 `f03a6e323`）：

| 树 | 提交 | 说明 |
| --- | --- | --- |
| before | `8f94ddda9069bc2301fefc87f276570b04f4c774`，树 `8c0120ba6` | P5.3 的同提交参照：父提交是交付 `b72da6eda`，改动正是撤回业务切换 `c868a02c2`（两者 `git patch-id` 相同；在 `b72da6eda` 上反向应用 `c868a02c2` 重建出的树也是 `8c0120ba6`）。P5.3 的本地提交，没有推送，仍在共享对象库里；需要时可按上面的办法重建同一棵树 |
| after | `b72da6eda7656645c343e97bc73111c1499fab32` | P5.3 的交付。项目线的 `a167c2ff0` 以它所在的 `928b9c162` 为第二父提交合入；`a167c2ff0` 与它相比只多了 `p5.3/` 证据目录，代码相同 |

| 运行 | 截图 | 环境 | 结果 |
| --- | ---: | --- | --- |
| [after-b72da6eda](originals/after-b72da6eda/meta.json) | 252 | 等于 P0.2 | 76 通过、4 跳过，11:59–12:02 UTC |
| [before-8f94ddda9](originals/before-8f94ddda9/meta.json) | 252 | 等于 P0.2 | 76 通过、4 跳过，12:02–12:06 UTC |

每次运行的提交、环境哈希、全部截图的 SHA-256、构建产物哈希、输出和报告摘要都在 [originals/](originals/)；登记前的期望来源是 [originals/expected-pre.sources.json](originals/expected-pre.sources.json)。P5.3 正式轮 f1 的两组截图（同样两个提交）的哈希是 [p53-f1-p0-ref-shots.sha256](originals/p53-f1-p0-ref-shots.sha256)、[p53-f1-p0-del-shots.sha256](originals/p53-f1-p0-del-shots.sha256)。

**对照**（[compare/](compare/)，[compare.cjs](../p3.2-accepted/tools/compare.cjs)，第一个目录是期望一侧）：

| 对照 | 逐字节相同 | Chromium 噪声 | 超出噪声但比较器通过 | P0 比较器不符 |
| --- | ---: | ---: | ---: | ---: |
| [登记前期望 → before](compare/exp-vs-before.json) | 227 | 16 | 9 | **0** |
| [登记前期望 → after](compare/exp-vs-after.json) | 205 | 24 | 15 | **8**：本次登记的 8 张 |
| [before → after](compare/before-vs-after.json) | 218 | 20 | 6 | **8**：本次登记的 8 张 |
| [P5.3 f1 参照 → before](compare/p53ref-vs-before.json) | 234 | 18 | 0 | 0 |
| [P5.3 f1 交付 → after](compare/p53del-vs-after.json) | 242 | 10 | 0 | 0 |

- 登记前期望 → before 的 9 张都是已记录、低于阈值的差异，与 P5.3 无关：P4.4 的 wiki-new-entry 6 张、P4.3b 的 WebKit 桌面 project-graph-fullscreen 2 张（9、17 个像素）、WebKit 滚动锁的 webkit-light-phone profile-validation（滚动条一列）。
- before → after 的 6 张见「未登记的截图」。
- 登记的 8 张在 P5.3 f1 的两组截图里都逐字节相同；两组对照里的噪声都在别的页面（Chromium，≤50 像素，≤4 级）。

## 逐张登记表

registry：[../p0-drift/accepted/registry.json](../p0-drift/accepted/registry.json)。before 原件在 `../p0-drift/accepted/before/{项目}/{名}.png`，after 原件即登记的期望图，在 `../p0-drift/accepted/screenshots/{项目}/{名}.png`。8 条共用：`replaces.layer` 为 `p0-drift`（被替换的都是在 `d2e295917` 上生成的 main 漂移参考：桌面为会话列表行组，手机为会话页组）；`sameCommit.before.commit` `8f94ddda9069bc2301fefc87f276570b04f4c774`；`sameCommit.after.commit` `b72da6eda7656645c343e97bc73111c1499fab32`；`sameCommit.environment` `fe69e82445e35a3196501a240c567b71b4039e40e434832ae9fd77f348f9cbdf`（P0.2 的 environment.json）。

| 截图 | 被替换的期望 = before 原件 | after 原件 = 登记的期望 | before → after 像素 / 最大级 | P5.3 p0-summary | 开工回归的 Playwright 像素 |
| --- | --- | --- | ---: | ---: | ---: |
| chromium-light-desktop/session-attachment-staged | `c2f3d0221ac4` | `ca80aa6a26c6` | 24835 / 53 | 24835 / 53 | 1382 |
| webkit-light-desktop/session-attachment-staged | `a8e989479b45` | `7643c68292e5` | 26633 / 53 | 26633 / 53 | 1388 |
| chromium-light-phone/session-attachment-staged | `4c6318acfc58` | `e6e76e867ee1` | 15311 / 53 | 15311 / 53 | 未比较（停在菜单） |
| webkit-light-phone/session-attachment-staged | `1b1a0558e45e` | `7eb1c3812658` | 16075 / 53 | 16075 / 53 | 未比较（停在菜单） |
| chromium-light-phone/session-attachment-menu | `9e4aec458ec8` | `5cfed3f46f49` | 2073 / 224 | 2073 / 224 | 1045 |
| chromium-dark-phone/session-attachment-menu | `7151d8a82ed1` | `0921253df97e` | 2071 / 158 | 2071 / 158 | 925 |
| webkit-light-phone/session-attachment-menu | `d7aa2fe37f0a` | `9022ef0fb13c` | 2035 / 224 | 2035 / 224 | 958 |
| webkit-dark-phone/session-attachment-menu | `dfea9b238307` | `db9c6e93c467` | 2039 / 158 | 2039 / 158 | 834 |

完整哈希在 registry 和 [checks/registration-check.json](checks/registration-check.json)。

**差异说明**（registry 的 `difference`，三段，全文见 [tools/register.sh](tools/register.sh)）：

- **明色桌面的 staged（2 条）**：P0 session 场景从 + 菜单选 File 放进一个文件后截图。Orbit 菜单关闭后把焦点还给发起的 +（已验收的焦点约定，P2.1「逐层返回焦点」），+ 在输入框卡片里，卡片因 `:focus-within` 画出聚焦时较深的边框与阴影（`.composer-box:focus-within`）；被替换的 AntD Dropdown 把焦点丢到 body。卡片里面逐像素相同，差异只在 1px 边框一圈和外面的阴影。暗色桌面同样的差异在比较器阈值内，不登记。
- **明色手机的 staged（2 条）**：同上；另写明手机上这张排在菜单之后、P5.3 的标准 P0 没有比较到它，本登记按判定说明在同提交原件上用比较器确认，暗色手机在阈值内不登记。
- **手机的菜单（4 条）**：手机上 + 菜单是 P2.2 的 `attachment` 变体（`ui/Floating.css`）。5 个菜单项的标签在 after 中是 P2.2 任务指定的 17px，被替换的 AntD 菜单实际画的是 14px（P5.3 记录的计算样式：font-size 14px → 17px，line-height 22px → 26.71px）；Shell 一行的终端图标上移约 1px（P5.3 记录的纵向取整带来的图标小数位移）。菜单的盒、分隔线和其余图标相同。

每段都写明出处：p5.3/README.md「合并检查与 P0」的对应一条（菜单另加「对照结果」中「手机附件菜单的字号」一行与「未消除的差异」第 5 条，staged 另加「未消除的差异」第 1 条），以及 compare/p0-summary.json 中与本条 before → after 相同的像素数与最大级数。

**差异区域**（本任务在原件上量的，[regions/](regions/)）：

- staged（[regions/staged-card.json](regions/staged-card.json)，[card-split.py](tools/card-split.py)）：卡片的边框盒取自截图上边框颜色变化的行与列，桌面 x 621–1259、y 736–883，手机 x 14–375、y 680–827，圆角 24px。

  | 截图 | 卡片里面 | 边框一圈 | 卡片外（阴影） |
  | --- | --- | --- | --- |
  | chromium-light-desktop | 0 | 1502 像素，≤53 级 | 23333 像素，≤52 级 |
  | webkit-light-desktop | 0 | 1510，≤53 | 25123，≤53 |
  | chromium-light-phone | 7 像素，≤2 级 | 948，≤53 | 14356，≤52 |
  | webkit-light-phone | 0 | 956，≤53 | 15119，≤53 |

  全部差异在桌面 x 592–1279、y 719–899，手机 x 0–389、y 663–843 内。卡片外单通道差超过 10 的像素都紧贴边框外沿（边框的抗锯齿），离开边框 1 像素以外的阴影处单通道差 ≤8。
- 菜单（[regions/before-vs-after.json](regions/before-vs-after.json)，[regions.py](../p3.2-accepted/tools/regions.py)）：超过 2 级的像素聚成 6 块：5 个标签（File、Image、Shell、Skill、Command，x 81–158、y 565–755）和 Shell 的图标（x 39–55、y 657–674）；明色单通道差至多 224、暗色 158。≤2 级的像素在这些字形边缘，WebKit 另有菜单四个圆角处 21（明色）、29（暗色）个。
- 裁图：[regions/crops](regions/crops/)，每张依次为 before、after、差异放大 4 倍（菜单只画前 4 块）；[regions/zoom](regions/zoom/) 是放大的整个菜单（明色 Chromium 手机）、Shell 图标和卡片左上角，同样是 before、after、差异。

## 未登记的截图

- **低于阈值的同类差异，6 张**：before → after 超出噪声、但 P0 比较器判为相符，登记工具不收，仍对照 main 漂移参考通过：
  - 暗色 4 个环境的 `session-attachment-staged`：同样的边框与阴影差，单通道差 ≤40（chromium-dark-desktop 16261 像素、webkit-dark-desktop 11457、chromium-dark-phone 9782、webkit-dark-phone 7856），卡片里面 0 个像素不同（Chromium 手机 7 个、≤1 级）。这与判定说明「暗色在阈值内」一致。
  - WebKit 桌面 2 张 `session-attachment-menu`：6、10 个像素，单通道差 1，P5.3 记录的 WebKit 行高小数（22px 对 22.000019px）。
- **Chromium 噪声，20 张**：before → after 都在 p0-drift 的噪声范围（单通道差 ≤4、≤200 像素）内，都通过比较器，逐张见 [compare/before-vs-after.json](compare/before-vs-after.json)。
- 其余 218 张 before 与 after 逐字节相同。

## 验证

### 两轮完整 P0 回归（登记后）

命令是 P0 原命令 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web`，经 [netns-regression.sh](../p0-drift-2/tools/netns-regression.sh) 放在独立网络命名空间里，外面套 6G 的 scope。在本工作树 `0cede69fb` 上连续运行，该提交即跟上之后的 origin/main `e83d71958` 加登记，工作树干净。驱动脚本是 [tools/final-and-controls.sh](tools/final-and-controls.sh)。

| 轮次 | 结果 | 记录 |
| --- | --- | --- |
| 第 1 轮（12:11–12:15 UTC） | 112 个测试：101 通过、11 跳过、0 失败、0 flaky，退出码 0 | [summary](checks/final-round-1/summary.json)、[报告摘要](checks/final-round-1/report.summary.json)、[输出](checks/final-round-1/command-output.txt)、[sources](checks/final-round-1/sources.json) |
| 第 2 轮（紧接其后，12:15–12:18 UTC） | 与第 1 轮逐个状态相同，退出码 0 | [checks/final-round-2](checks/final-round-2/summary.json) |

- 两轮都先通过了 globalSetup 对 P0.2 原图、两层登记和环境的校验，期望组装为 `44 P0.2 originals, 165 main drift references, 43 accepted migration differences`（登记前是 44、173、35）。
- 两轮的 sources.json 逐字节相同：登记的 8 张来自 `accepted` 层，`replaces` 为对应的 main 漂移参考，`decision` 为 P5.3 第 1 版；暗色 4 张 staged、桌面 4 张菜单仍来自 main 漂移参考。
- 环境记录与 P0.2 逐字节相同（[environment-check](checks/final-round-1/environment-check.txt)）。
- 结果只含已记录的处置：101 个通过；11 个跳过是 7 个非参考项目的性能采样和 4 个手机项目的桌面断点巡检，同 P0.2 记录。没有失败、flaky 或预期失败。

### 登记复核

[verify-registration.cjs](tools/verify-registration.cjs) 不经登记工具，独立复核 8 条登记，结果在 [checks/registration-check.json](checks/registration-check.json)，问题数为 0。它由 p4.1-accepted 的同名工具改写，逐条检查：

- **判定字段**：等于引用的第 1 版 CONFIRM，文档存在，差异说明非空，没有 `previous`；
- **replaces**：是该截图的 main 漂移参考，参考文件哈希与 registry 一致；登记前的期望组装（`sources.json`）也取自它；
- **提交**：before 的父提交是 after；before 的树等于在 after 上撤回 `c868a02c2` 重建的树，before → after 与 `c868a02c2` 的 `git patch-id` 相同；`c868a02c2` 在 after 的 first-parent 线上；after 是项目线 `a167c2ff0` 的第二父提交 `928b9c162` 的父提交；`a167c2ff0` 在项目分支的 first-parent 线上，并经 main 的晋升合并 `9274d5242` 包含在 HEAD 里；`a167c2ff0` 与 after 的代码相同；
- **环境**：两次运行都与 P0.2 相同，各 252 张；
- **原件**：`accepted/` 里的 before/after 与运行目录的截图、registry 记录的哈希逐字节相同，也与 P5.3 f1 的参照、交付截图逐字节相同；
- **比较器**：before 在 P0 比较器下复现被替换的期望（且逐字节相同），after 与 before 不符；
- **P5.3 数据**：before → after 的像素数与最大级数等于 P5.3 第 1 版 `compare/p0-summary.json` 的记录；
- **已接受层其余 35 条**：与 `a167c2ff0` 上逐字段相同；
- **完整性**：全部 252 张中，after 对登记前期望不符的恰是登记的 8 张；before 对登记前期望 0 张不符。

### 负对照

所有负对照都在临时树上做：
- 在 `/mnt/data` 上建登记提交 `0cede69fb` 的稀疏工作树（同 before/after 树，另含 `p5.3/README.md`），依赖同本工作树；
- 把补丁追加到 `src/web/src/index.css`，以临时提交固定，不交付、不推送；
- 跑同一条 P0 原命令。驱动脚本同上。

| 对照 | 改动 | 被测截图当时的期望 | 结果 | 记录 |
| --- | --- | --- | --- | --- |
| 菜单 | `@media (max-width: 600px) { .orbit-menu[data-variant='attachment'] .orbit-menu-icon { position: relative; left: 1px } }`，手机附件菜单的 5 个图标右移 1px（[patch](negative-control/menu/patch.diff)，临时提交 `07e2c7334`） | 4 个手机的 session-attachment-menu 都是本次登记的已接受期望 | **4 个手机的 session 用例失败在 session-attachment-menu**：明色 210、暗色 134/135 像素。其余 97 通过、11 跳过。退出码 1 | [summary](negative-control/menu/summary.json)、[差异图](negative-control/menu/failures/) |
| 文件 chip | `.composer-file-name { position: relative; left: 1px }`，输入框里暂存文件的文件名右移 1px（[patch](negative-control/chip/patch.diff)，临时提交 `ff617dd91`） | 明色桌面、明色手机 4 张为已接受层（本次登记），暗色 4 张为 main 漂移参考 | **8 个 session 用例失败在 session-attachment-staged**：已接受层 221（Chromium）、231（WebKit）像素；main 漂移参考 213–218 像素。其余 93 通过、11 跳过。退出码 1 | [summary](negative-control/chip/summary.json)、[差异图](negative-control/chip/failures/) |

- 两组里对照已接受层失败的 8 张，Playwright 的 expected 就是本次登记的期望图（哈希见各自的 `failures.sha256` 与 [regions/negative-controls.json](regions/negative-controls.json)）。
- 拿 actual 与登记的期望图对照（[regions/negative-controls.json](regions/negative-controls.json)），差异正是补丁改动的地方：
  - 菜单：4 张的全部差异都在 x 38–57、y 564–756 内，即 5 个图标那一列（720–721 像素）；
  - 文件 chip：已接受层 4 张超过 2 级的差异只在文件名一行，桌面 x 673–761、y 758–767，手机 x 66–154、y 702–711（546–567 像素）；此外只有 Chromium 手机上 1 个单通道差 1 的像素（x 39、y 700），是噪声。
- 菜单一组改动的是本次接受的差异所在的菜单，文件 chip 一组改动的是 staged 截图上与接受的轮廓无关的部分：两组都说明登记后的期望图仍逐像素守着页面，1px 的偏差会被检出。
- 暗色 4 张 staged 对照 main 漂移参考失败时，差异包括低于阈值的输入框轮廓与文件名的 1px，合在一起超过了阈值；这 4 张不是本次登记的条目。

### 合并检查

项目合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web`：
- **运行位置**：本工作树 `0cede69fb`（登记提交，没有已跟踪文件的改动；本目录当时在整理，未跟踪，构建和测试都不读它），驱动脚本 [tools/merge-check.sh](tools/merge-check.sh)，同样在 6G 的 scope 里，12:26–12:29 UTC。
- **结果**：退出码 0。
  - `tsc -b && vite build` 通过（4584 个模块），保留原有的大 chunk 提示；
  - Vitest（`--maxWorkers=2`）**399 个测试文件、5163 个用例全部通过**，用时 210 秒。与 P5.3 交付时的合并检查数目相同。
- **记录**：[checks/merge-check.txt](checks/merge-check.txt) 是 [filter-merge-check.py](../p3.2-accepted/tools/filter-merge-check.py) 过滤后的输出，保留完整构建输出、每个测试文件的结果行和汇总行，去掉了用例运行中打印的控制台告警；完整输出 2770 行留在 `/mnt/data/tmp/34dTUdzY6mgNk4CGh7ZHl/merge-check.log`，行数和 SHA-256 见 [checks/merge-check.json](checks/merge-check.json)。
- **构建产物**：合并检查后本工作树 `src/web/dist` 的 25 个文件哈希（[checks/dist-0cede69fb.sha256](checks/dist-0cede69fb.sha256)）与 after 树 `b72da6eda` 的构建（[originals/after-b72da6eda/dist.sha256](originals/after-b72da6eda/dist.sha256)）逐字节相同：跟上 main 带进来的改动不进入 Web 构建，登记的期望图就是当前树画出来的页面。

### 不变项

[tools/scope-check.sh](tools/scope-check.sh) 的输出在 [checks/scope-check.txt](checks/scope-check.txt)：
- **登记提交** `0cede69fb`：只改 `p0-drift/accepted/` 下 17 个文件（registry 与 8 张 before、8 张 after）和 `p0-drift/README.md`；README 只在已登记清单加了 P5.3 一行和一段说明。
- **跟上 main**：登记提交的父提交是 origin/main `e83d71958`，它经晋升合并 `9274d5242` 包含开工时的项目 tip `a167c2ff0`。main 在 tip 之外改了 25 个文件：`src/apiserver` 23 个、`docs` 1 个、`src/web/src/copyLanguage.test.ts`（单测）1 个；`src/shared`、锁文件、证据目录都没有改。
- **受保护的路径**：从 `a167c2ff0` 到 HEAD，以下 `git diff --stat` 为空：`p0.2/`（原图、环境记录、baseline-run）、`p0-drift/reference/`（main 漂移参考层）、`src/web/ui-migration/`（场景、断言、固定数据、比较器设置、known-failures、期望组装）、`src/web/package.json`；known-failures、playwright.config.mjs（`maxDiffPixels: 0`）、expected-screenshots.mjs 的 blob 不变。
- **产品代码**：从登记提交的父提交到 HEAD，`src/` 为空，本任务没有改任何代码。
- **已接受层其余 35 条**：与 `a167c2ff0` 逐字段相同。
- **登记之后的提交**：只改本目录。

## 边界

- **before 是本地提交**：`8f94ddda9` 是 P5.3 会话在 `/mnt/data` 上做的参照提交，没有推送；它仍在本机共享对象库里，协调者可以直接 `git show`。对象被回收以后，按「同提交原件」里的办法在 `b72da6eda` 上撤回 `c868a02c2` 可重建同一棵树（`8c0120ba6`），registration-check.json 记录了这项核对。
- **after 的提交**：after 取 P5.3 的交付 `b72da6eda`，与 P5.3 证据里的交付相同；落地项目线的是合并 `a167c2ff0`，它与 `b72da6eda` 只差证据目录，登记后的两轮回归就在含它的树上运行。
- **判定引用**：registry 只能离线校验判定的格式和文档是否存在；判定是否真实存在，要由协调者在 Orbit 中核对（规则第 4 条）。本目录保存了证据版本和判定响应的原文。
- **差异说明的机制**：焦点交还、`:focus-within`、P2.2 的 17px 与 AntD 实际画出的 14px 都来自 P5.3 证据和判定；本任务只核对了像素数据、差异的位置和 P5.3 记录的计算样式。
- **低于阈值的差异**：P0 比较器（`maxDiffPixels: 0`、默认 threshold）看不到的差异没有也不能登记，已在「未登记的截图」列出。
- **临时目录**：tools/ 里的脚本写着 `/mnt/data/tmp/34dTUdzY6mgNk4CGh7ZHl` 和本工作树的路径。完整运行原件留在那里，按作业指导在证据判定后清理；verify-registration.cjs 的完整性部分要读那里的 504 张原件和 P5.3 f1 的截图副本。
- **其余边界同 P0.2**：Linux 固定环境、合成 REST/SSE、非真机 iOS。

## 复跑

```sh
bash scripts/worktree-overlay.sh
NO_COLOR=1 npm run test:ui-migration -w @orbit/web            # 应全部通过：101 通过、11 跳过
bash docs/evidence/base-ui-migration/p5.3-p0-registration/tools/scope-check.sh 0cede69fb
npm run build -w @orbit/web && npm run test -w @orbit/web
```

工具（[tools/](tools/)）：
- **树与原件**：`make-trees.sh`、`originals.sh`（开工回归与两次同提交原件，调用 netns-regression.sh 与 p3.2-accepted 的 same-commit-originals.sh），`lib.sh`（内存门槛、根分区下限与 6G scope）；
- **判定**：`find-decision.py`、`extract-decision.py`；
- **登记**：`register.sh`，即这次的 `register-accepted.cjs` 调用；
- **复核**：`verify-registration.cjs <运行目录> <P5.3 f1 截图目录> <输出>`、`card-split.py`、`counts-check.py`、`scope-check.sh <登记提交>`；
- **回归与负对照**：`final-and-controls.sh`，补丁 `negative-control-menu.css`、`negative-control-chip.css`；
- **合并检查与跟上 main**：`merge-check.sh`、`main-dry-run.sh <跟上时的基础>`；
- **归档**：`collect.sh`，按「证据体积」约定从运行目录取出本目录引用的文件。

对照和裁图沿用 p3.2-accepted 的 [compare.cjs](../p3.2-accepted/tools/compare.cjs) 和 [regions.py](../p3.2-accepted/tools/regions.py)。

## 文件

| 路径 | 内容 |
| --- | --- |
| [decision/p5.3-decision.json](decision/p5.3-decision.json) | 引用的判定：P5.3 证据版本、摘要，协调者判定调用及服务端响应原文 |
| [checks/tip-start/](checks/tip-start/) | 开工回归（`a167c2ff0`，登记前），含 6 个失败的差异图和附件哈希 |
| [checks/final-round-1/](checks/final-round-1/)、[final-round-2/](checks/final-round-2/) | 登记后的两轮回归 |
| [checks/registration-check.json](checks/registration-check.json) | 登记复核与 252 张的完整性 |
| [checks/counts.txt](checks/counts.txt) | 期望组装计数与两层登记、README 清单的对照 |
| [checks/scope-check.txt](checks/scope-check.txt) | 登记提交的范围与受保护路径 |
| [checks/audit-check-owners.json](checks/audit-check-owners.json) | 跟上 main 之后的 `audit-antd.mjs --check-owners` |
| [checks/main-dry-run.txt](checks/main-dry-run.txt) | 交证据前对最新 origin/main 的 `git merge-tree` 干跑与 main 的改动清单 |
| [checks/merge-check.txt](checks/merge-check.txt)、[merge-check.json](checks/merge-check.json)、[dist-0cede69fb.sha256](checks/dist-0cede69fb.sha256) | 合并检查与登记提交的构建产物哈希 |
| [originals/](originals/) | 同提交原件：提交、环境、全部截图哈希、构建产物哈希、输出、报告摘要；登记前的期望来源；P5.3 f1 两组截图的哈希 |
| [compare/](compare/) | compare.cjs 的逐张对照 |
| [regions/](regions/) | before → after 的差异区域、卡片拆分、负对照的差异位置与裁图 |
| [negative-control/](negative-control/) | 两组负对照：补丁、输出、summary、报告摘要、差异图、附件哈希 |
| [tools/](tools/) | 上述脚本 |

报告按「证据体积」约定只交 report.summary.json（去掉附件正文），没有提交 trace.zip。截图只提交上表引用的差异图和裁图；登记的 16 张原件在 `p0-drift/accepted/`，不重复提交。本目录约 5.2 MB（上限 30 MB）：检查记录 1.7 MB（含开工回归的 6 张差异图），负对照 1.8 MB（12 张差异图与报告摘要），原件记录 0.9 MB（日志、报告摘要与哈希），对照 0.5 MB，区域与裁图 0.3 MB，脚本与判定 0.1 MB。
