# 登记 P3.2 已接受的 P0 迁移差异

本目录服务于任务 [登记 P3.2 已接受的 P0 迁移差异](orbit-task:34bSHg8V2p0zaRMKy7tUQ)，对应项目验收条目 key `3ojnKuvd3dQLuwsFV8g7Ll`：**P3：任务详情与分享试点及会话输入代表场景达到既有外观和操作要求，并形成成本对照。**

[P3.2](orbit-task:34Za39ACSBoCkYKc80Md8) 按设计改变了一部分 P0 task 场景截图，协调者已 CONFIRM 这些差异。本任务按 [p0-drift README](../p0-drift/README.md)「已接受的迁移差异」的规则，把它们登记进已接受层，让 P0 浏览器回归在项目 tip 上全部通过。没有改动以下内容：
- P0.2 原图、main 漂移参考层；
- 比较容差、预期失败名单；
- P0 场景与断言。

## 结论

- **登记 12 条**（提交 `b25626673`）：task-share-dialog 在全部 8 个项目各 1 条，task-action-menu 在 4 个浅色项目各 1 条。每条都有：
  - **判定引用**：P3.2 第 2 版证据的 CONFIRM 判定。任务 `34Za39ACSBoCkYKc80Md8`，`evidenceRevision` 2，`evidenceDigest` `302ca1f5051c1f3fd04abf89c1dff51c86cfbdcb9326fc3f7abf70e9ee9809bc`，文档 [p3.2/README.md](../p3.2/README.md)。Orbit 判定记录为 `2K8fF73HxxWRPnthmP77Pz`，见「引用的判定」。
  - **差异说明**：取自 P3.2 证据。分享对话框是焦点约定；More 菜单是焦点约定，WebKit 另有 Share… 图标的行高精度差。
  - **同提交原件和 SHA-256**：before `fffcdb532`（P3.2 落地前的项目 tip），after `2925958ae`，都在 P0.2 环境中生成。
- **逐张对上了 P3.2 证据**：
  - 12 张的 before → after 差异像素数和最大级数，与 P3.2 第 2 版证据 [r2c-p0-task-compare.json](../p3.2/r2c-p0-task-compare.json)（AntD 参照对交付）逐张相同；
  - 裁图里的差异位置与说明一致。

  **没有对不上的截图，缺口为空。**
- **完整性**：task 场景共 40 张截图。after 原件在 P0 比较器下与当时期望不符的，正好是这 12 张。其余 28 张：
  - 18 张 before 与 after 逐字节相同；
  - 7 张有 P3.2 的变化，但低于比较器阈值：深色 task-action-menu 4 张，webkit-dark-phone 的 task-detail、task-action-hover、task-action-focus；
  - 3 张在 Chromium 噪声范围内：chromium-dark-phone 的同三张，68 像素、2 级。

  登记工具不收比较器下没有差异的截图。未登记的 28 张仍对照 main 漂移参考，照常通过，逐张见「未登记的截图」。
- **当前 tip 上两轮完整 P0 回归全部通过**：
  - 在 `5ba7bb2b9`（项目 tip `fc58e5713` 加登记）上连续跑两轮。每轮 112 个测试：101 通过、11 跳过、0 失败、0 flaky，两轮逐个状态相同。
  - task 场景 8/8 通过。
  - 期望组装为 `88 P0.2 originals, 152 main drift references, 12 accepted migration differences`。
  - B1 修复 `3ec9cf83d` 已在 tip 上，按要求两轮必须全部通过，结果也是全部通过。
- **没有新吸收的 main 造成的失败**（第 2 批漂移登记之后）：
  - 开工时在 `2925958ae` 上的回归只有这 8 个 task 用例失败。
  - 此后项目线只合入了 `fc58e5713`，即 P2 Menu 按键窗口修正，不是吸收 main。
  - 在 `fc58e5713` 上补拍了全矩阵对照，与 after 原件相比：
    - 登记的 12 张全部逐字节相同；
    - 其余 240 张中，216 张逐字节相同，23 张是 Chromium 噪声，1 张是 after 原件那次运行的偶发（见「其他截图」）。
- **负对照**：在已登记截图上再加 1px 改动，三组回归都以失败结束：
  - More 菜单上边距加 1px：task-action-menu 8/8 失败，其中 4 张对照已接受层，4 张对照 main 漂移参考；
  - 分享对话框 Access 文字右移 1px，只在 Close 获得焦点时生效：task-share-dialog 8/8 失败，全部对照已接受层；
  - 分享对话框 Close 焦点环外移 1px：浅色 4 张失败；深色 4 张通过。深色焦点环的这次位移只有 364 像素、36 级，P0 比较器（`maxDiffPixels: 0`、默认 threshold）看不到，与 P3.2 深色 More 按钮焦点环的差异低于阈值是同一原因。详见「负对照」。
- **合并检查**：`npm run build -w @orbit/web && npm run test -w @orbit/web` 在 `2f382e17c`（全部代码加本目录其余证据）上通过，退出码 0。Web 构建通过；Vitest 341 个测试文件、4353 个用例全部通过。

## 执行经过

- **第一个执行会话** `7IIIZcAIxI7nb7wR89bC7`（2026-10-07 06:51–07:11 UTC）：
  - 核对基线：项目 tip `2925958ae` 含 P3.2 的落地合并 `066d3dd30`、漂移机制（已接受层 `b45c20063`）、第 2 批漂移登记（`2925958ae` 本身）和 B1 修复 `3ec9cf83d`；
  - 在 tip 上跑开工回归：[checks/tip-start](checks/tip-start/summary.json)；
  - 生成同提交原件：before `fffcdb532`、after `2925958ae`、对照 `066d3dd30`，见 [originals/](originals/)；
  - 做对照和逐张列表：[compare/](compare/)、[listing.md](listing.md)；
  - 登记 12 条，提交 `b25626673`。

  之后撞上 Claude 周额度停止，没有跑验证，也没有写证据。49 个证据文件没有提交，协调者只读存为 `refs/wip/p3.2-accepted-20261007T1022Z`（`80d61a2f8`）。
- **本会话** `21dqAAdZx8gyKlTjQTu6Te` 按协调者交接接手：
  - 项目 tip 已前进到 `fc58e5713`，合入了 P2 Menu 按键跟进，无法快进。合并为 `8ba1913d4`，没有冲突。
  - 从 `80d61a2f8` 取回 49 个文件，确认与原工作树逐字节相同后提交为 `5ba7bb2b9`。已采的原件没有重采。
  - 新做的部分：
    - 独立复核登记（[verify-registration.cjs](tools/verify-registration.cjs)）；
    - 在 tip 上补拍全矩阵对照；
    - 两轮 P0 回归、三组负对照、合并检查；
    - 本 README。
- 由 Claude Opus 5.5 执行。没有推送 main 或项目分支，没有部署或发布。

## 引用的判定

| 版本 | 证据 id | evidenceDigest | 提交时间（UTC） | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `5ot53Jc3WTTzIbOcCOyc8` | `bc1cab9f058dfaf30185c088ef35abb690fb862316c5bc2d3ef95de54a3653fe` | 2026-10-06 21:03 | CONFIRM。协调者 21:36 曾提交 SEND_BACK，被服务端以 `EVIDENCE_JUDGMENT_ALREADY_DECIDED` 拒绝：revision 1 was already decided CONFIRM |
| 2 | `1N9eeTbvv56v8XU0wF0ZAb` | `302ca1f5051c1f3fd04abf89c1dff51c86cfbdcb9326fc3f7abf70e9ee9809bc` | 2026-10-07 01:14 | **CONFIRM**，判定记录 `2K8fF73HxxWRPnthmP77Pz`，2026-10-07 01:16:01 UTC，协调者会话 `34b245G3NiwgVVUj2JFJw` |

- **为什么引用第 2 版**：
  - 它是最新一版；
  - 判定说明写明：「本 CONFIRM 同样覆盖这些差异，登记任务 34bSHg8V2p0zaRMKy7tUQ 可以引用第 1 版或本版判定」；
  - 第 2 版证据的 r2c 行逐张列出了 task 场景的差异（[p3.2/README.md](../p3.2/README.md)「第 2 轮」最终基点表，[r2c-p0-task-compare.json](../p3.2/r2c-p0-task-compare.json)）。
- **来源**：
  - 证据版本和摘要取自 `task_evidence_list(34Za39ACSBoCkYKc80Md8)`；
  - 判定记录和判定说明，逐字取自服务端对协调者 `task_evidence_decide` 调用的响应，存为 [decision/p3.2-decisions.json](decision/p3.2-decisions.json)。

  判定是否真实存在，由协调者在 Orbit 中按判定记录 id 复核。

## 提交

| 提交 | 内容 |
| --- | --- |
| `b25626673` | test：用 [register-accepted.cjs](../p0-drift/tools/register-accepted.cjs) 登记 12 条，写 `accepted/registry.json` 和 24 张原件，更新 p0-drift README 的已登记清单和复跑注释。只改 `p0-drift/accepted/` 和该 README，父提交 `2925958ae` |
| `8ba1913d4` | 合并：把 `b25626673` 合到项目 tip `fc58e5713` 上，没有冲突 |
| `5ba7bb2b9` | docs：取回上一会话的 49 个证据文件 |
| 之后的证据提交 | docs：只改本目录 |

**回退**：回退登记提交（本分支上是 `b25626673`）即撤销登记，task 场景回到对照第 1 批 A4 的 main 漂移参考。在本分支上，也可以对合并 `8ba1913d4` 用 `git revert -m 1`。

## 开工时的 P0 回归

[checks/tip-start](checks/tip-start/summary.json)：上一会话在 `2925958ae` 上运行，干净树，环境记录与 P0.2 逐字节相同，期望组装为 `88 P0.2 originals, 164 main drift references, 0 accepted migration differences`。

结果：93 通过、11 跳过、**8 失败**。8 个失败全是 task 用例，每个项目各一，都失败在截图比较上：

| 项目 | 停在 | 期望来自 | Playwright 差异像素 |
| --- | --- | --- | ---: |
| chromium-light-desktop / chromium-light-phone | task-action-menu | main 漂移参考 | 326 / 422 |
| webkit-light-desktop / webkit-light-phone | task-action-menu | main 漂移参考 | 330 / 426 |
| chromium-dark-desktop / chromium-dark-phone | task-share-dialog | main 漂移参考 | 722 / 722 |
| webkit-dark-desktop / webkit-dark-phone | task-share-dialog | main 漂移参考 | 706 / 706 |

- 严格比较停在第一张不同的截图上。浅色项目的 task-action-menu 先失败，所以没有比到 task-share-dialog。
- 深色项目的 task-action-menu 低于阈值、通过，所以停在 task-share-dialog。
- 完整的逐张差异要靠下节的同提交原件：12 张不同，正好是 8 张 task-share-dialog 加 4 张浅色 task-action-menu。

其余 104 个测试没有 task 以外的失败：
- 93 个通过，其中包括原 16 个焦点用例（P3.2 撤掉预期失败标记后直接通过）和 8 个 P2.3 生产通知用例；
- 11 个按环境跳过。

## 同提交原件

方法：[same-commit-originals.sh](tools/same-commit-originals.sh)，即 p0-drift 的同名工具改成参数化路径：
- 用被测提交自己的 P0 测试和场景，经 [drift.config.mjs](../p0-drift/tools/drift.config.mjs)、`--update-snapshots=all` 把 252 张矩阵截图写入临时目录；
- 构建与 `pretest:ui-migration` 相同，在独立网络命名空间里运行；
- 树由 [prepare-tree.sh](tools/prepare-tree.sh) 按 `scripts/worktree-overlay.sh` 准备，锁文件在几个提交上相同（`f03a6e323a33`）。

每次运行的提交、环境、截图哈希、输出和报告见 [originals/](originals/)。

| 运行 | 提交 | 截图 | 环境 | 结果 |
| --- | --- | ---: | --- | --- |
| [before](originals/before-fffcdb532/meta.json) | `fffcdb532`：P3.2 落地合并 `066d3dd30` 的第一父，即 P3.2 落地前的项目 tip，不含本批 | 232 | 等于 P0.2 | wiki 8 个用例在等 `.wk-card` 时超时（见下） |
| [after](originals/after-2925958ae/meta.json) | `2925958ae`：登记开工时的项目 tip | 252 | 等于 P0.2 | 76 通过、4 跳过 |
| [对照](originals/p32-066d3dd30/meta.json) | `066d3dd30`：P3.2 刚落地，还没吸收 main `fc12b3063` 和第 2 批 | 232 | 等于 P0.2 | 与 before 相同，wiki 8 个超时 |
| [补拍 profile](originals/after-2925958ae-profile-rerun/meta.json) | `2925958ae`，只跑 webkit-dark-phone 的 profile | 2 | 等于 P0.2 | 通过，与当时的期望逐字节相同 |
| [tip 对照](originals/tip-fc58e5713/meta.json)（本会话） | `fc58e5713`：当前项目 tip | 252 | 等于 P0.2 | 76 通过、4 跳过 |

- **wiki 超时**：main 的 Wiki 首页重构去掉了 wiki 场景等待的 `.wk-card`。第 2 批的场景维护 `d2479173b` 在 `fffcdb532`、`066d3dd30` 之后，所以这两次没有 wiki 截图。task 场景 40 张都齐全。
- **before 复现当时的期望**：12 张登记截图的 before 原件，与被替换的 main 漂移参考逐字节相同。
- **对照的用途**：`066d3dd30` 上的 40 张 task 截图与 after 逐字节相同。所以 before → after 的 task 差异全部来自 P3.2 的落地，后面吸收的 main `fc12b3063` 和第 2 批没有再改动这些截图（[compare/before-vs-p32.json](compare/before-vs-p32.json)、[compare/p32-vs-after.json](compare/p32-vs-after.json)）。

## 逐张登记表

registry：[../p0-drift/accepted/registry.json](../p0-drift/accepted/registry.json)。原件：
- before 在 `../p0-drift/accepted/before/{项目}/{名}.png`；
- after 即登记的期望图，在 `../p0-drift/accepted/screenshots/{项目}/{名}.png`。

表中哈希是前 12 位，完整值在 registry 和 [checks/registration-check.json](checks/registration-check.json)。所有条目共用以下值：
- `replaces.layer` 为 `p0-drift`，即第 1 批 A4 组的 main 漂移参考，`mainCommits` 为 `4088d37e6`；
- `sameCommit.before.commit` 为 `fffcdb532ef380d7b43ee87cbbd4e3316c5c24b8`；
- `sameCommit.after.commit` 为 `2925958aed739d386ac4c79d3bd766ac7e221999`；
- `sameCommit.environment` 为 `fe69e82445e35a3196501a240c567b71b4039e40e434832ae9fd77f348f9cbdf`，即 P0.2 的 environment.json。

| 截图 | 被替换的期望 = before 原件 | after 原件 = 登记的期望 | before → after 差异像素 / 最大级 | P3.2 第 2 版 r2c 对照 | Playwright 差异像素 | 对到的 P3.2 说明 |
| --- | --- | --- | ---: | ---: | ---: | --- |
| chromium-dark-desktop/task-share-dialog | `31621a609fbd` | `2dbf515d7317` | 1618 / 186 | 1618 / 186 | 722 | S |
| chromium-dark-phone/task-share-dialog | `6d1ce3bffeb8` | `c017cc3caa5f` | 21183 / 186 | 21183 / 186 | 722 | S |
| chromium-light-desktop/task-share-dialog | `4e17a8be1742` | `1a695d12ea38` | 1228 / 239 | 1228 / 239 | 1071 | S |
| chromium-light-phone/task-share-dialog | `0febd9470f9f` | `cef516ca7e93` | 31309 / 239 | 31309 / 239 | 1071 | S |
| webkit-dark-desktop/task-share-dialog | `16239de70c56` | `1ac55c143850` | 1260 / 138 | 1260 / 138 | 706 | S |
| webkit-dark-phone/task-share-dialog | `aadbd69e2cc9` | `aca1f92577e8` | 1257 / 138 | 1257 / 138 | 706 | S |
| webkit-light-desktop/task-share-dialog | `f5e3fec75e23` | `4634e7383d14` | 1254 / 163 | 1254 / 163 | 1077 | S |
| webkit-light-phone/task-share-dialog | `eb49983c732f` | `292b5453d228` | 1254 / 163 | 1254 / 163 | 1077 | S |
| chromium-light-desktop/task-action-menu | `a96c90d797da` | `82e929f91db5` | 466 / 82 | 466 / 82 | 326 | M |
| chromium-light-phone/task-action-menu | `0c3321ffc316` | `e56a4013d7ca` | 557 / 82 | 557 / 82 | 422 | M |
| webkit-light-desktop/task-action-menu | `36b9d7ee7bff` | `8379a8c00aba` | 489 / 82 | 489 / 82 | 330 | M + W |
| webkit-light-phone/task-action-menu | `2d9968586cec` | `b76ada09c938` | 586 / 82 | 586 / 82 | 426 | M + W |

「Playwright 差异像素」是 P0 比较器对照被替换的期望时报告的像素数，取自 tip 对照截图（[compare/exp-vs-tip.json](compare/exp-vs-tip.json)）。开工回归比到的 8 张，报告的也是这个数；浅色 task-share-dialog 在开工回归里没有比到。

P3.2 证据里对应的说明（[p3.2/README.md](../p3.2/README.md)「P0 页面矩阵（同提交对照）」表和「未消除的差异」）：
- **S，分享对话框的焦点约定**：task-share-dialog 行，「未消除的差异」第 6 条。打开后按一次 Tab：
  - 旧对话框先聚焦 Close，Tab 到 Access；
  - Orbit Dialog 先聚焦对话框本身（P2.1 约定），Tab 到 Close。

  裁图里超过 2 级的差异只有两处焦点环：before 在 Access 按钮（Anyone with the link）上，约 168×30；after 在右上角 Close 上，40×40。Chromium 手机上另有大面积 ≤2 级的抗锯齿差异（21183/31309 像素中超过 2 级的只有 1611/1220）。
- **M，More 菜单的焦点约定**：task-action-menu 行，第 6 条。
  - 旧菜单打开后，焦点留在 More 按钮上，before 有焦点环；
  - Orbit Menu 把焦点移入菜单（P2.2 约定），after 没有。

  差异只在 More 按钮，桌面 40×40，手机 48×48。菜单本身没有差异。
- **W，WebKit 的行高精度**：「未消除的差异」第 5 条。
  - Lightning CSS 把行高 `1.5714285714285714` 写成 `1.57143`，WebKit 偶尔多出 1/64px；
  - 结果是 Share… 菜单项地球图标底行有 23 像素，最大 59 级（明色 10×8）。P3.2 记为「约 30 像素（≤59 级）」。

裁图：[regions/crops](regions/crops/)，每张依次为 before、after、差异放大 4 倍；数据在 [regions/before-vs-after.json](regions/before-vs-after.json)。

## 未登记的截图

逐张数据见 [listing.md](listing.md)（[listing.json](listing.json)）。列出的范围：
- task 场景全部 40 张；
- 打开分享对话框的 breakpoint-599/601-dialog 8 张；
- 其余在比较器下与当时期望不符、或 before → after 超出噪声的截图。

| 截图 | before → after | P0 比较器 | 归属 | 处置 |
| --- | --- | --- | --- | --- |
| task-action-menu：chromium-dark-desktop、chromium-dark-phone、webkit-dark-desktop、webkit-dark-phone | 466 / 627 / 489 / 655 像素，45 级 | 通过 | P3.2 的同一项焦点约定（M），WebKit 另有 W；深色焦点环与背景对比低 | 登记工具拒收（after 在比较器下与 before 相同，无可接受的差异）；仍对照 main 漂移参考并通过 |
| webkit-dark-phone：task-detail、task-action-hover、task-action-focus | 各 66 像素，1 级 | 通过 | P3.2 记录的抗锯齿级差异（P0 表 task-detail 等三行「2 抗锯齿级」之一） | 同上 |
| chromium-dark-phone：task-detail、task-action-hover、task-action-focus | 各 68 像素，2 级 | 通过 | 同上（另一个抗锯齿级环境）；在 Chromium 噪声范围内，但每次运行都相同，P3.2 的 r2c 也是 68 像素、2 级 | 同上 |
| breakpoint-599/601-dialog：webkit-dark-desktop、webkit-light-desktop | 11 / 8 像素，1 级 | 通过 | P3.2 落地带来的分享对话框抗锯齿级差异，从 `066d3dd30` 起出现 | 不是 task 场景；登记工具同样会拒收 |
| breakpoint-599/601-dialog：chromium-dark-desktop、chromium-light-desktop | 13–14 像素，1–2 级 | 通过 | 噪声：差异在 before 一侧（before 对当时期望也是 13–14 像素），after 与当时期望逐字节相同 | 无 |
| 其余 task 截图 18 张 | 逐字节相同 | — | — | — |

p0-drift README 的已登记清单写「P3.2 另有 11 张截图的变化低于 P0 比较器阈值」，指上表前两行的 7 张，加上 WebKit 桌面的 breakpoint dialog 4 张。chromium-dark-phone 的三张在噪声范围内，没有计入那 11 张，这里补充列出。

## 其他截图

after 原件那次全矩阵运行（`2925958ae`）里，**webkit-dark-phone/profile-validation.png** 与当时的期望不符：8489 像素、167 级，Playwright 计 499 像素。
- **差异内容**：期望图里有 “Name saved” 成功提示胶囊，这次截图里没有。见 [regions/profile-one-off](regions/profile-one-off/webkit-dark-phone--profile-validation.png)：左为 tip 对照，中为 after 原件，右为差异。
- **为什么判为偶发**：
  - 它不是 P3.2 的差异，066d3dd30 → after 才出现；
  - 同一提交上只跑该场景重拍，与期望逐字节相同（[补拍](originals/after-2925958ae-profile-rerun/exp-vs-rerun.json)）；
  - 开工回归、tip 对照截图和本会话两轮回归里都正常；
  - 那次运行时主机负载约 41。

  它不在 task 场景，没有登记，也不影响任何条目。

## 验证

### 两轮完整 P0 回归（当前 tip）

命令是 P0 原命令 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web`，经 [netns-regression.sh](../p0-drift-2/tools/netns-regression.sh) 放在独立网络命名空间里，在本工作树 `5ba7bb2b9` 上连续运行。该提交即项目 tip `fc58e5713` 加登记，工作树干净。

| 轮次 | 结果 | 记录 |
| --- | --- | --- |
| 第 1 轮（10:28–10:32 UTC） | 112 个测试：101 通过、11 跳过、0 失败、0 flaky，退出码 0 | [summary](checks/final-round-1/summary.json)、[输出](checks/final-round-1/command-output.txt)、[report](checks/final-round-1/report.json.gz)、[sources](checks/final-round-1/sources.json) |
| 第 2 轮（紧接其后，10:32–10:35 UTC） | 与第 1 轮逐个状态相同，退出码 0 | [checks/final-round-2](checks/final-round-2/summary.json) |

- 两轮都先通过了 globalSetup 对 P0.2 原图、两层登记和环境的校验，期望组装为 `88 P0.2 originals, 152 main drift references, 12 accepted migration differences`。sources.json 两轮相同，12 张 `accepted` 正是登记的 12 张。
- 环境记录与 P0.2 逐字节相同（[environment-check](checks/final-round-1/environment-check.txt)）。
- 101 个通过是：
  - P0 的页面、状态、断点和性能用例 77 个（pages 56、states 16、breakpoints 4、performance 1），其中 task 8/8；
  - 原 16 个焦点用例，现在是普通测试；
  - 8 个 P2.3 生产通知用例。

  11 个跳过：7 个非参考项目的性能采样，4 个手机项目的桌面断点巡检。

### 登记复核

[verify-registration.cjs](tools/verify-registration.cjs) 不经登记工具，独立复核每条登记，结果在 [checks/registration-check.json](checks/registration-check.json)，问题数为 0。逐条检查：
- **判定字段**：等于引用的第 2 版 CONFIRM，文档存在；
- **replaces**：是该截图的 main 漂移参考，参考文件哈希与 registry 一致；
- **提交**：before 是 P3.2 落地合并的第一父，after 含 P3.2 的落地；两者都在当前 HEAD 的 first-parent 线上；
- **环境**：两次运行都与 P0.2 相同；
- **原件**：`accepted/` 里的 before/after 与运行目录的截图、registry 记录的哈希逐字节相同；
- **比较器**：before 在 P0 比较器下复现被替换的期望，after 与 before 不符；
- **P3.2 数据**：before → after 的像素数与最大级数等于 P3.2 第 2 版 r2c 的记录；
- **完整性**：40 张 task 截图中，after 对当时期望不符的，恰是登记的 12 张；
- **tip 对照**：12 张登记期望都与 `fc58e5713` 的截图相符，而且逐字节相同。

tip 对照截图与 after 原件的全矩阵对照，也在该文件的 `control` 字段：
- 228 张逐字节相同；
- 23 张是 Chromium 噪声，最多 87 像素、4 级，都通过比较器；
- 1 张是上节的 profile-validation 偶发。

`fc58e5713` 在 src 里只改了 Menu 的按键处理（`Menu.tsx`、`Menu.test.tsx`）。它的全矩阵截图与 after 原件相比，除 Chromium 噪声和上面的偶发外没有变化。另见 [compare/exp-vs-tip.json](compare/exp-vs-tip.json)：tip 截图对照登记前的期望，比较器下不符的正是这 12 张，Playwright 像素数与开工回归相同。

### 负对照

所有负对照都在临时树上做：
- 在 `5ba7bb2b9` 的独立工作树上，把补丁追加到 `src/web/src/index.css`，以临时提交固定，不交付；
- 跑同一条 P0 原命令；
- 驱动脚本是 [negative-control.sh](tools/negative-control.sh) 和 [negative-controls.sh](tools/negative-controls.sh)。
- 前两组第一次启动时，后台命令写错：`&` 把 `cd … && T=… && bash …` 整串放进了子 shell，第二组拿不到变量。这次作业 `bgj_151bd4059d49` 在开始后约 20 秒被终止，结果没有使用。随后改用 negative-controls.sh 重跑。

三个补丁都只在截图打开对应元素时起作用：
- More 菜单只在 task-action-menu 中打开；
- Close 按钮只在 task-share-dialog 中获得可见焦点；断点用例的分享对话框是点击打开、没有按 Tab。

| 对照 | 改动 | 被测截图当时的期望 | 结果 | 记录 |
| --- | --- | --- | --- | --- |
| More 菜单 | `.orbit-menu.tdp-more-menu { padding-top: 5px }`，原为 4px（[patch](negative-control/more-menu/patch.diff)，临时提交 `cd62f48ce`） | 浅色 4 张为已接受层，深色 4 张为 main 漂移参考 | **task-action-menu 8/8 失败**：已接受层 538–712 像素，main 漂移参考 420–582 像素。其余 93 通过、11 跳过。退出码 1 | [summary](negative-control/more-menu/summary.json)、[失败截图](negative-control/more-menu/failures/) |
| 分享对话框 Access 文字 | `.share-dialog:has(.orbit-overlay-close:focus-visible) .share-access-select { padding-left: 7px }`，原为 6px，只在 Close 获得焦点时生效（[patch](negative-control/share-access/patch.diff)，临时提交 `f1b365aa2`） | 8 张全是已接受层 | **task-share-dialog 8/8 失败**：浅色 410–426 像素，深色 327–338 像素。其余 93 通过、11 跳过。退出码 1 | [summary](negative-control/share-access/summary.json)、[失败截图](negative-control/share-access/failures/) |
| 分享对话框 Close 焦点环 | `.share-dialog .orbit-overlay-close:focus-visible { outline-offset: 2px }`，原为 1px（[patch](negative-control/share-close/patch.diff)，临时提交 `2a9195145`） | 8 张全是已接受层 | **浅色 4 张失败**（各 192 像素），**深色 4 张通过**。其余 97 通过、11 跳过。退出码 1 | [summary](negative-control/share-close/summary.json)、[失败截图](negative-control/share-close/failures/) |

**深色焦点环为什么通过**：
- 在同一临时提交上，只跑深色 4 个项目的 task 场景，并把截图写出来对照（[dark-capture](negative-control/share-close/dark-capture/accepted-vs-share-close.json)）。
- 4 张都有差异：364 像素、最大 36 级，全在 Close 按钮 42×42 的焦点环上（[裁图](negative-control/share-close/dark-capture/crops/)）。但 P0 比较器判为相符。
- 原因：深色焦点环颜色是 `#1d305b`，压在深色表面上，1px 位移的色差低于比较器的默认 threshold（0.2）。P3.2 深色 More 按钮焦点环的差异（45 级）也因此低于阈值。
- 这是 P0.2 既定比较器设置的检测下限，不是登记造成的漏检。同一批深色 task-share-dialog 登记，在 Access 文字对照里都会失败（见上表）。
- 按规则，本任务没有改 threshold。

对后续批次的提示：深色主题下焦点环的细小变化，P0 回归看不到，要靠逐像素对照（compare.cjs）或计算样式。

### 合并检查

项目合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web`：
- **运行位置**：`2f382e17c`，即全部代码加本目录除合并检查记录外的证据，工作树干净；作业 `bgj_9d441eee3c8b`，2026-10-07 10:45 UTC 开始。
- **结果**：退出码 0。
  - `tsc -b && vite build` 通过，保留原有的大 chunk 提示；
  - Vitest（`--maxWorkers=2`）**341 个测试文件、4353 个用例全部通过**，用时 241 秒。
- **记录**：
  - [checks/merge-check.txt](checks/merge-check.txt) 是 [filter-merge-check.py](tools/filter-merge-check.py) 过滤后的输出，保留完整构建输出、每个测试文件的结果行和汇总行，去掉了用例运行中打印的控制台告警；
  - 完整输出 12972 行，留在本机，路径和 SHA-256 见 [checks/merge-check.json](checks/merge-check.json)；Orbit 也按作业保存了它的输出。
- **之后的提交**：`2f382e17c` 之后的提交只改本目录。核对方法：`git diff --stat 2f382e17c..HEAD -- . ':!docs/evidence/base-ui-migration/p3.2-accepted'` 输出为空。

## 边界

- **after 原件的提交**：after 原件取自 `2925958ae`，是登记开工时的项目 tip，不是现在的 tip `fc58e5713`。协调者交接时要求已采的原件不要重采。`fc58e5713` 在 `2925958ae` 之后只合入了 Menu 按键修正；在它上面，12 张登记截图与 after 原件逐字节相同，两轮回归全部通过。
- **判定引用**：registry 只能离线校验判定的格式和文档是否存在。判定是否真实存在，要由协调者在 Orbit 中核对（规则第 4 条）。本目录保存了证据列表和判定响应的原文。
- **低于阈值的差异**：P0 回归的比较器（`maxDiffPixels: 0`、默认 threshold）看不到的 P3.2 差异，没有也不能登记，已在「未登记的截图」逐张列出。负对照显示，深色焦点环的 1px 位移同样在这个阈值以下。
- **before 运行**：before 和对照运行没有 wiki 截图，原因见「同提交原件」。task 场景和断点截图不受影响。
- **噪声**：噪声判定沿用 p0-drift 的分析规则：Chromium 单通道差 ≤4 且 ≤200 像素。这条规则只用于归类，回归判定仍是 P0 比较器。
- **临时路径**：tools/ 里的脚本默认使用 `/var/tmp/p32acc`。提交证据前删除了临时工作树，运行原件仍保留在本机 `/var/tmp/p32acc/runs`、`/var/tmp/p32acc/nc`。证据里保存的是这些运行的记录和全部截图哈希；verify-registration.cjs 要读运行目录里的完整截图，只能在本机复跑。
- **其余边界同 P0.2**：Linux 固定环境、合成 REST/SSE、非真机 iOS。

## 复跑

```sh
bash scripts/worktree-overlay.sh
NO_COLOR=1 npm run test:ui-migration -w @orbit/web            # 应全部通过：101 通过、11 跳过
node docs/evidence/base-ui-migration/p3.2-accepted/tools/verify-registration.cjs /var/tmp/p32acc/runs /tmp/registration-check.json
npm run build -w @orbit/web && npm run test -w @orbit/web
```

工具（[tools/](tools/)）：
- **原件**：`prepare-tree.sh <标签> <提交>`、`same-commit-originals.sh <树> <输出> [playwright 参数]`；
- **对照与列表**：`compare.cjs`、`compare-all.sh`、`listing.py`、`regions.py`；
- **登记**：`register.sh`，即这次登记的三次 `register-accepted.cjs` 调用，按差异说明分组；
- **复核**：`verify-registration.cjs`；
- **回归归档**：`keep-run.sh`；
- **负对照**：`negative-control.sh`、`negative-controls.sh`，补丁 `negative-control-*.css`。

## 文件

| 路径 | 内容 |
| --- | --- |
| [decision/p3.2-decisions.json](decision/p3.2-decisions.json) | 引用的判定：P3.2 两版证据的 id、摘要，协调者两次判定调用及服务端响应原文 |
| [checks/tip-start/](checks/tip-start/) | 开工回归（`2925958ae`，登记前），含 8 个失败的截图附件 |
| [checks/final-round-1/](checks/final-round-1/)、[final-round-2/](checks/final-round-2/) | 当前 tip 上的两轮回归 |
| [checks/registration-check.json](checks/registration-check.json) | 登记复核与 tip 对照 |
| [checks/merge-check.txt](checks/merge-check.txt) | 合并检查输出 |
| [originals/](originals/) | 同提交原件与对照运行：提交、环境、全部截图哈希、输出、报告 |
| [compare/](compare/) | compare.cjs 的逐张对照：当时期望、before、after、`066d3dd30`、P3.2 的 r2c 截图、tip |
| [listing.md](listing.md)、[listing.json](listing.json) | 逐张列表 |
| [regions/](regions/) | before → after 的差异区域与裁图；profile-validation 偶发的裁图 |
| [negative-control/](negative-control/) | 三组负对照：补丁、临时提交、输出、summary、报告、失败截图；share-close 的深色截图对照 |
| [tools/](tools/) | 上述脚本 |
