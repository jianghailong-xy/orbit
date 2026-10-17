# 登记 WebKit 滚动锁修复的 P0 已接受差异：9 张 WebKit 截图

本目录服务于任务 [P0 登记（第 6 批）：WebKit 滚动锁修复的 9 张截图](orbit-task:34cfhmpygHQdZxRznyVH9)，对应项目验收条目 key `1BvO6hYrlFnU60JqxQPUHt`：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。**

[WebKit 对话框滚动锁](orbit-task:34cBi0yt6bFcSmbJFgDPj)（下称该批）给 `src/web/src/lib/toast.tsx` 的读屏 live region 加了 `position: fixed`，文档不再多出 1px。Linux WebKit 截图右侧 8px 的文档滚动条列和 (0,0) 那一点随之消失，桌面主区按 1280 排版：居中内容右移 4px，靠右内容和通知列右移 8px。标准 P0 因此有 9 张截图越过比较器。协调者 CONFIRM 了该批第 1 版证据，判定说明把这 9 张接受为该批的迁移差异，由本任务登记。

本任务按 [p0-drift README](../p0-drift/README.md)「已接受的迁移差异（`accepted/`）」第 1–5 条，以 [p4.1-accepted](../p4.1-accepted/README.md) 为先例，把它们登记进已接受层。没有改动以下内容：
- P0.2 原图、main 漂移参考层；
- 比较容差、预期失败名单（known-failures）；
- P0 场景、固定数据与断言。

## 结论

- **登记 9 条**（提交 `821e2d501`，父提交为项目 tip `b2568f28d`）：webkit-light-desktop、webkit-dark-desktop、webkit-dark-phone 各三张，即 `settings-saved`、`profile-validation`、`notification-error`。每条都有：
  - **判定引用**：该批第 1 版证据的 CONFIRM。任务 `34cBi0yt6bFcSmbJFgDPj`，`evidenceRevision` 1，`evidenceDigest` `fdb19816d1e31af2dc3463fe3e359c68b7ba86084f284f24009f8b92dc468e7c`，文档 [webkit-scroll-lock/README.md](../webkit-scroll-lock/README.md)。Orbit 判定记录为 `fRJrSzK3CevsTPV4xEki6`，见「引用的判定」。
  - **差异说明**：取自该批证据「P0 的影响」的逐张说明和判定说明，按截图分 5 段，全文见「逐张登记表」。
  - **同提交原件和 SHA-256**：
    - before `15b7b5609`，即该批的起点（该批第一个提交 `78cae80d9` 的父提交）；
    - after `b2568f28d`，即该批落地项目线的合并，也是本任务开工时的项目 tip。它的第二父 `b3e33e31d` 是协调者 CONFIRM 的证据提交，代码在分支头 `d49a8749b`。
    - 两次运行的环境记录都与 P0.2 逐字节相同。
  - **写入方式**：用 [register-accepted.cjs](../p0-drift/tools/register-accepted.cjs) 写入（调用见 [tools/register.sh](tools/register.sh)），没有手改哈希。
  - **webkit-dark-phone/profile-validation**：登记工具把原有的 P4.1 接受条目移入 `previous`，内容与 `b2568f28d` 上那条逐字段相同。新条目的 `replaces` 仍是第 2 批 A6 的 main 漂移参考。
- **before 复现当前期望**：
  - 9 张 before 原件与当前期望逐字节相同。当前期望里，7 张是 main 漂移参考，webkit-dark-phone 的 notification-error 是 P0.2 原图，profile-validation 是 P4.1 的接受图。
  - before 全部 252 张在 P0 比较器下都与登记前的期望相符，0 张不符。
- **after 就是登记的期望图**：9 张 after 原件就是 `accepted/screenshots/` 里的期望图，哈希相同。它们还与以下两处逐字节相同：
  - 该批证据 [shots/p0](../webkit-scroll-lock/shots/p0) 里分支头 `d49a8749b` 的 after；
  - 本任务开工回归（`b2568f28d`，登记前）失败时的 actual。
- **逐张对上了该批证据**：
  - before → after 的不同像素数（6753–66395）与该批 [compare/p0-changed-webkit.json](../webkit-scroll-lock/compare/p0-changed-webkit.json) 相同；
  - 逐像素归类（文档滚动条 / 右移 4px / 右移 8px / 其它）与该批 [shots/p0/classes.json](../webkit-scroll-lock/shots/p0/classes.json) 相同；
  - before 原件与该批的 before 逐字节相同。

  **没有对不上的截图。**
- **完整性**：
  - 252 张截图里，after 原件在 P0 比较器下与登记前期望不符的，正好是这 9 张。
  - before → after 有 224 张逐字节相同，16 张是 Chromium 噪声，12 张是该批的 WebKit 变化：登记的 9 张，加上低于阈值的 WebKit 明色手机 3 张。WebKit 共 126 张，其余 114 张逐字节相同。
- **开工时的回归**：登记前在 `b2568f28d` 上跑，92 通过、11 跳过、9 失败。
  - 9 个失败正是这 9 张，差异像素数与该批证据的标准 P0 相同。
  - 112 个测试的状态与该批分支头 `d49a8749b` 上的标准 P0 逐个相同。从该批起点到它落地，项目线还落地了子菜单几何修正、吸收了三次 main，没有带来别的失败。
- **当前 tip 上两轮完整 P0 回归全部通过**：在 `821e2d501`（项目 tip `b2568f28d` 加登记，没有已跟踪的改动）上连续跑两轮。
  - 每轮 112 个测试：101 通过、11 跳过、0 失败、0 flaky，两轮逐个状态相同，也与该批参照 `15b7b5609` 上的标准 P0 逐个相同。
  - 期望组装为 `87 P0.2 originals, 143 main drift references, 22 accepted migration differences`。
  - 11 个跳过都是已记录的处置：7 个非参考项目的性能采样，4 个手机项目的桌面断点巡检。
- **负对照**：在登记提交上加 1px 改动，两组回归都以失败结束：
  - **胶囊**：设置页“Setting saved”胶囊再右移 1px。settings 8/8 失败在 `settings-saved`：新登记的 3 张对照已接受层失败（明色桌面 264、暗色桌面 231、暗色手机 234 像素），其余 5 张对照 main 漂移参考失败；其余 93 通过、11 跳过。
  - **错误卡片**：会话页错误卡片再右移 1px。session 8/8 失败在 `notification-error`：新登记的 3 张对照已接受层失败（1275、1332、1363 像素），其余 5 张对照 main 漂移参考或 P0.2 原图失败；其余 93 通过、11 跳过。
- **不变项**：
  - 登记提交只改 `p0-drift/accepted/` 的 19 个文件（registry 与 18 张原件），以及 p0-drift README：在已登记清单加了一行和一段说明。
  - 从 `b2568f28d` 到登记提交，以下内容都没有变：P0.2 原图与环境记录、main 漂移参考层、`src/`（含 `src/web/ui-migration` 的场景、断言、固定数据、比较器设置、known-failures 和期望组装）、锁文件、已接受层其余 13 条。
- **合并检查**：`npm run build -w @orbit/web && npm run test -w @orbit/web` 通过，退出码 0。Web 构建（`tsc -b && vite build`）通过；Vitest 370 个测试文件、4801 个用例全部通过。
- **跟上 main**：开工时 origin/main `953e6b588` 与项目 tip 的树相同，没有可带进来的内容。最终轮开始后 origin/main 前进到 `f339640df`（协调者问题的记录）：与它干跑合并没有冲突，不碰本次登记、P0 场景、`ui/` 公共组件、通知与弹层。在合并树上（临时提交 `5376c49da`，不交付）跑标准 P0：101 通过、11 跳过、0 失败，逐个状态与两轮回归相同；`audit-antd.mjs --check-owners` 在登记提交和合并树上都是 0 未归属、0 待定。所以没有再 rebase。

## 执行经过

- **本会话** `31P1BbVT5VzV2gLz5toMVy`，2026-10-09 02:30 UTC 起，由 Claude Opus 5.5 执行。
- **开工**：
  - 读了任务、作业指导中「P0 期望截图分三层」「证据体积」「共享主机磁盘」「跟上 main」各段，p0-drift README 已接受层第 1–6 条，p4.1-accepted 先例和该批证据。
  - `task_get` 确认该批已落地：`integration.state` 为 `ON_UPSTREAM`；落地作业 `WNBVehF5XAQJLN8ISHe1C` 于 02:08 UTC 以 `LANDED` 结束，目标是 `refs/heads/project/34ZZeq0e3IR65GVm2kAs7`。项目分支 tip 为 `b2568f28d`，就是该批的落地合并。
  - origin/main `953e6b588`（Merge refs/heads/project/… into refs/heads/main）已含项目 tip，两者的树相同（`git diff` 为空）。跟上 main 没有可带进来的内容，所以按任务说明从项目 tip 开工，登记提交的父提交是项目 tip。之后 main 的前进见「跟上 main」。
- **磁盘**：开工时 `df -BM /` 剩 24736 MB，高于作业指导的 6 GB 线。
  - 重的产物都在 `/mnt/data/tmp/34cfhmpygHQdZxRznyVH9/`：before 工作树及其依赖、全部运行原件、对照与日志。
  - 根分区只有会话工作树和它的依赖叠加（隔离的 `npm ci`；overlay 前后根分区少了约 1.8 GB）。运行期间根分区剩余一直在 22 GB 以上（各脚本在每步前后记录 `df -BM /`），没有低于 6 GB 的时候。
- **顺序**：
  1. 准备依赖（`scripts/worktree-overlay.sh`）与 before 工作树；
  2. 开工回归，然后 after 原件（会话工作树）；before 原件同时在 /mnt/data 的树上跑；
  3. 对照与独立复核；
  4. 登记提交 `821e2d501`；
  5. 两轮回归（会话工作树），两组负对照同时在临时树上跑；
  6. 与最新 origin/main 干跑合并，并在合并树上跑 P0；合并检查；本目录。
- 没有推送 main 或项目分支，没有部署或发布。

## 引用的判定

| 版本 | 证据 id | evidenceDigest | 提交时间（UTC） | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `6yAK0M0DaEF7hC5Rp9n1rU` | `fdb19816d1e31af2dc3463fe3e359c68b7ba86084f284f24009f8b92dc468e7c` | 2026-10-09 01:50 | **CONFIRM**，判定记录 `fRJrSzK3CevsTPV4xEki6`，2026-10-09 01:54:05 UTC，协调者会话 `34b245G3NiwgVVUj2JFJw` |

判定说明中关于这 9 张的一条（逐字）：

> 3）P0 的 9 张变化按设计接受：webkit-light-desktop 和 webkit-dark-desktop 各 3 张（settings-saved、profile-validation、notification-error），webkit-dark-phone 3 张（settings-saved、profile-validation、notification-error，其中 profile-validation 原有 P4.1 的接受条目）。两件事解释全部 12 张：文档滚动条那一列 8px 和 (0,0) 一点消失；桌面主区按 1280 排版，居中内容右移 4px，靠右内容和通知列右移 8px。像素归类与此一致，红色只在交界处的抗锯齿边缘。低于阈值的 3 张 WebKit 明色手机截图不登记。按 p0-drift README「已接受的迁移差异」第 2、3 条，落地后由协调者另建的登记任务按同提交原件重登（before 15b7b5609，after 取本批落地后的项目线提交），P4.1 那条旧条目移入 previous。

- **为什么引用第 1 版**：该批只有这一版证据。它的 gaps 第 1 条和 README「P0 的影响：12 张 WebKit 截图，9 张需要重登」逐张列出了这 9 张截图、差异说明和同提交对照。
- **来源**：
  - 证据版本和摘要取自本会话调用的 `task_evidence_list(34cBi0yt6bFcSmbJFgDPj)`。
  - 判定记录和判定说明逐字取自协调者 `task_evidence_decide` 调用的服务端响应，存为 [decision/webkit-scroll-lock-decision.json](decision/webkit-scroll-lock-decision.json)。该调用在协调者会话的记录里，tool_use `toolu_019ZsYo35BPmabogWGXJwip3`，记录文件路径写在该 JSON 里。
  - 查找和抽取工具是 [tools/find-decision.py](tools/find-decision.py) 和 [tools/extract-decision.py](tools/extract-decision.py)。抽取时核对了判定的 `evidenceId`、`evidenceDigest` 与证据列表一致，`decision` 为 `CONFIRM`。

  判定是否真实存在，由协调者在 Orbit 中按判定记录 id 复核（规则第 4 条）。

## 提交

| 提交 | 内容 |
| --- | --- |
| `821e2d501` | test：用 register-accepted.cjs 登记 9 条，写 `accepted/registry.json` 和 18 张原件（before、after 各 9 张，其中 webkit-dark-phone/profile-validation 的两张替换了 P4.1 的原件），在 p0-drift README 的已登记清单加一行和一段说明。只改 `p0-drift/accepted/` 和该 README，父提交 `b2568f28d` |
| 之后的证据提交 | docs：只改本目录 |

**回退**：回退 `821e2d501` 即撤销登记。9 张截图回到对照 main 漂移参考、P0.2 原图和 P4.1 的接受条目，P0 在 WebKit 明暗桌面和暗色手机的 settings、profile、session 用例上重新失败，即开工回归的 9 个失败。P4.1 的两张原件在 git 历史里（`b2568f28d`）。

## 开工时的 P0 回归

[checks/tip-start](checks/tip-start/summary.json)：在 `b2568f28d` 上运行，工作树没有已跟踪的改动，02:35–02:39 UTC。
- 环境记录与 P0.2 逐字节相同。
- 期望组装为 `88 P0.2 originals, 150 main drift references, 14 accepted migration differences`。

结果：112 个测试，92 通过、11 跳过、**9 失败**：

| 项目 | 停在 | 期望来自 | Playwright 差异像素 |
| --- | --- | --- | ---: |
| webkit-light-desktop | settings-saved | main 漂移参考 | 14799 |
| webkit-light-desktop | profile-validation | main 漂移参考 | 9314 |
| webkit-light-desktop | notification-error | main 漂移参考 | 3131 |
| webkit-dark-desktop | settings-saved | main 漂移参考 | 20709 |
| webkit-dark-desktop | profile-validation | main 漂移参考 | 15662 |
| webkit-dark-desktop | notification-error | main 漂移参考 | 10149 |
| webkit-dark-phone | settings-saved | main 漂移参考 | 6726 |
| webkit-dark-phone | profile-validation | 已接受层（P4.1） | 6728 |
| webkit-dark-phone | notification-error | P0.2 原图 | 6599 |

- 差异像素数与该批 README「逐张说明」表中「P0 比较器」一列相同。
- [failures.sha256](checks/tip-start/failures.sha256) 记录了失败附件的哈希，只提交了差异图。expected 即登记前的当前期望，actual 即本次登记的期望图（after 原件），逐张核对见 [checks/tip-start-vs-originals.txt](checks/tip-start-vs-originals.txt)。
- 112 个测试的状态与该批分支头 `d49a8749b` 上的标准 P0（[p0-standard.report.summary.json](../webkit-scroll-lock/runs/p0-standard.report.summary.json)）逐个相同，见 [checks/statuses-tip-start.json](checks/statuses-tip-start.json)。

## 同提交原件

**方法**：用 [p3.2-accepted/tools/same-commit-originals.sh](../p3.2-accepted/tools/same-commit-originals.sh)，即 p0-drift 同名工具的参数化版本。具体做法：
- 用被测提交自己的 P0 测试、场景和固定数据，经 [drift.config.mjs](../p0-drift/tools/drift.config.mjs) 以 `--update-snapshots=all` 把 252 张矩阵截图写入临时目录；
- 构建与 `pretest:ui-migration` 相同，在独立网络命名空间里运行。

**两棵树**：

| 树 | 做法 |
| --- | --- |
| before | `15b7b5609` 的完整工作树，在 `/mnt/data/tmp/34cfhmpygHQdZxRznyVH9/trees/before-15b7b5609`。证据已瘦身，完整检出约 1 GB，不占根分区（[tools/prepare-before.sh](tools/prepare-before.sh)） |
| after | 本工作树，`b2568f28d`，没有已跟踪的改动 |

两棵树都用 `bash scripts/worktree-overlay.sh` 准备依赖。锁文件在 `15b7b5609` 与 `b2568f28d` 上相同（`f03a6e323a33`）。驱动脚本见 [tools/originals.sh](tools/originals.sh)。

| 运行 | 提交 | 截图 | 环境 | 结果 |
| --- | --- | ---: | --- | --- |
| [before](originals/before-15b7b5609/meta.json) | `15b7b5609`：该批的起点 | 252 | 等于 P0.2 | 76 通过、4 跳过，02:37–02:42 UTC |
| [after](originals/after-b2568f28d/meta.json) | `b2568f28d`：该批的落地合并 | 252 | 等于 P0.2 | 76 通过、4 跳过，02:39–02:43 UTC |

- before 与开工回归、after 同时运行，分别在两棵树、两个网络命名空间里。
- 每次运行的提交、环境哈希、全部截图的 SHA-256（`snapshots.sha256`）、构建产物哈希、输出和报告摘要都在 [originals/](originals/)。
- 登记前的期望组装来源是 [originals/expected-pre.sources.json](originals/expected-pre.sources.json)，与开工回归的 sources.json 逐字节相同。

**after 为什么取 `b2568f28d`**：判定说明写明 after 取「本批落地后的项目线提交」。该批在 `15b7b5609` 上交付了 `78cae80d9`（用例）、`9f2f7e9a0`（修法）和 `d49a8749b`（合并 origin/main `f1837de8e`，只有 apiserver 与 runner 的改动），证据提交是 `b3e33e31d`。项目线以合并 `b2568f28d` 接入 `b3e33e31d`，第一父是 `70e3aa652`。
- 该批的 3 个文件在 `b2568f28d` 的树里与分支头 `d49a8749b` 相同（`git diff` 为空）。
- 从 `15b7b5609` 到 `b2568f28d`，项目线还落地了子菜单几何修正（`1f889cc61`、`561bffd75`、`748632d6b`），并吸收了三次 main（`12fdef2f7`、`797bf06d1`、`70e3aa652`）。src/web 与 src/shared 里该批以外改了 13 个文件：
  - start card：`ProjectDependencyGraph`、`StartPlanGraph`、`StartProjectCard`、`lib/projectStart.ts`，以及 `index.css` 的 `.start-card` 规则；
  - 子菜单：`ui/Menu.tsx`、`ui/Floating.ts`、`ui/Floating.css`、`ChoicesFixture.tsx` 和两个 choices 用例。
- 这些改动没有改变 P0 截图：
  - before → after 除了该批的 12 张 WebKit 变化，只有 16 张 Chromium 噪声；
  - 12 张 WebKit 的 after 原件与该批分支头 `d49a8749b`（不含这些改动）的 after 逐字节相同。

对照（[compare/](compare/)，[compare.cjs](../p3.2-accepted/tools/compare.cjs)，第一个目录是期望一侧，[tools/compare-all.sh](tools/compare-all.sh)）：

| 对照 | 逐字节相同 | Chromium 噪声 | 超出噪声但比较器通过 | P0 比较器不符 |
| --- | ---: | ---: | ---: | ---: |
| [登记前期望 → before](compare/exp-vs-before.json) | 215 | 26（≤110 像素，≤4 级） | 11 | **0** |
| [登记前期望 → after](compare/exp-vs-after.json) | 209 | 20（≤104 像素，≤2 级） | 14 | **9**：本次登记的 9 张 |
| [before → after](compare/before-vs-after.json) | 224 | 16（≤23 像素，≤4 级） | 3 | **9**：本次登记的 9 张 |

- 前两行的 11 张是同一组截图，before 与 after 逐字节相同，与该批无关，见「未登记的截图」。
- 第二行的 14 张是这 11 张加 WebKit 明色手机 3 张；第三行的 3 张就是 WebKit 明色手机那 3 张。

## 逐张登记表

registry：[../p0-drift/accepted/registry.json](../p0-drift/accepted/registry.json)。原件：
- before 在 `../p0-drift/accepted/before/{项目}/{截图}.png`；
- after 即登记的期望图，在 `../p0-drift/accepted/screenshots/{项目}/{截图}.png`。
- 每张的 before、after 和逐像素归类图在该批证据 [shots/p0/](../webkit-scroll-lock/shots/p0)，与这里的原件逐字节相同，本目录不再重复提交。

9 条共用以下值：
- `sameCommit.before.commit` 为 `15b7b56093139c7b502e6618e9700ef78c9cccba`；
- `sameCommit.after.commit` 为 `b2568f28d8bb87d12eec762d1f810562503ed2d9`；
- `sameCommit.environment` 为 `fe69e82445e35a3196501a240c567b71b4039e40e434832ae9fd77f348f9cbdf`，即 P0.2 的 environment.json。

| 截图 | 当前期望 = before 原件 | after 原件 = 登记的期望 | before → after 不同像素 | 归类：滚动条 / 右移 4px / 右移 8px / 其它 | `replaces` |
| --- | --- | --- | ---: | --- | --- |
| webkit-light-desktop/settings-saved | main 漂移参考 `7fb81b5733dd` | `3f7a0158db8f` | 63266 | 7201 / 49622 / 6439 / 4 | p0-drift，设置页组（生成于 `def134095`） |
| webkit-dark-desktop/settings-saved | main 漂移参考 `9f4cbab3da76` | `4bc4460111b9` | 66395 | 7201 / 53609 / 5583 / 2 | 同上 |
| webkit-light-desktop/profile-validation | main 漂移参考 `93218ccee8fd` | `9f1ee22bac54` | 47775 | 7201 / 32906 / 7665 / 3 | p0-drift，第 2 批 A6（`d233a6cd0`） |
| webkit-dark-desktop/profile-validation | main 漂移参考 `52a0f5eb9e5e` | `8d686d6d4ca7` | 51674 | 7201 / 37657 / 6813 / 3 | 同上 |
| webkit-light-desktop/notification-error | main 漂移参考 `f71ec3a6eb40` | `b0dafa152e08` | 29906 | 7201 / 5193 / 17259 / 253 | p0-drift，会话列表行组（生成于 `f5bdd7fd3`） |
| webkit-dark-desktop/notification-error | main 漂移参考 `d12982adfe17` | `aa47ee44b7ff` | 27115 | 7201 / 5023 / 14565 / 326 | 同上 |
| webkit-dark-phone/settings-saved | main 漂移参考 `ce46c1231e9b` | `40656db95780` | 6753 | 6753 / 0 / 0 / 0 | p0-drift，设置页组（生成于 `def134095`） |
| webkit-dark-phone/profile-validation | 已接受层，P4.1 `53f9152dc1de` | `0f3a4108c15f` | 6753 | 6753 / 0 / 0 / 0 | p0-drift，第 2 批 A6（`ce6c213d39f3`，第 7 条例外），与 P4.1 条目相同 |
| webkit-dark-phone/notification-error | P0.2 原图 `f5d6ab570e4a` | `05b985e2a109` | 6753 | 6753 / 0 / 0 / 0 | p0.2 |

- 完整哈希在 registry 和 [checks/registration-check.json](checks/registration-check.json)。
- 归类按该批 [tools/p0-shots.py](../webkit-scroll-lock/tools/p0-shots.py) 的规则，由 [tools/verify-registration.cjs](tools/verify-registration.cjs) 重算：每个不同的像素，在右侧 8px 列或 (0,0) 的归为文档滚动条，等于 before 右移 4px 或 8px 的归为右移，都不是的归为其它。
- 归为其它的像素，复核也记下了位置：
  - settings-saved：明 4、暗 2 个，在 x 831–833、y 195–198，与 before 右移 4px 后各通道只差 1 级；
  - profile-validation：明暗各 3 个，在 x 584、y 159–172，与 before 右移 4px 后最多差 8 级（明）、7 级（暗）；
  - notification-error：明 253、暗 326 个，都在 x 873–1243、y 23–871 的范围内。该批记为错误卡片右移后露出的标题文字与卡片阴影边，本任务没有逐个再归因。

**差异说明**：5 段共用开头一段（修法与两件事）和末尾的出处，中间一句说本组截图。原文在 [tools/register.sh](tools/register.sh)，写入 registry 的 `difference`。

开头（9 条相同）：

> WebKit 对话框滚动锁一批给 lib/toast.tsx 的读屏 live region 加了 position: fixed。它挂在 body 末尾，原先按 absolute 的静态位置排在视口下缘之外，第一次出通知后文档比视口高 1px，Linux WebKit 因全站 8px 的 ::-webkit-scrollbar 给文档画出滚动条；修复后文档始终一个视口高。P0 的 settings-saved、profile-validation、notification-error 都在出通知后截图，after 相对 before 只有两件事：（1）文档滚动条消失：before 右侧 8px 是没有绘制的透明列（RGBA 0,0,0,0），(0,0) 多一个灰点（明色 217,217,217，暗色 74,74,77），after 两者都没有，右侧 8px 是页面本身；（2）桌面主区按 1280 排而不是 1272：居中内容右移 4px，靠右内容和通知列（ToastViewport 按视口宽度定位）右移 8px，左侧导航不变；手机布局视口始终是 390，内容和通知都不动。

各组：

| 截图 | 本组一句 |
| --- | --- |
| WebKit 明暗桌面 settings-saved | 本截图：文档滚动条消失；设置卡片列右移 4px；“Setting saved”胶囊随通知列右移 8px，与 Chromium 桌面的位置一致；归为其它的几个像素（明 4、暗 2 个）在右移内容的边缘，与 before 右移 4px 后各通道只差 1 级，是抗锯齿。 |
| WebKit 明暗桌面 profile-validation | 本截图：文档滚动条消失；资料卡片列右移 4px；“Name saved”胶囊随通知列右移 8px，与 Chromium 桌面的位置一致；归为其它的 3 个像素（明暗都在 x 584）在右移内容的边缘，与 before 右移 4px 后各通道差 8 级以内，是抗锯齿。 |
| WebKit 明暗桌面 notification-error | 本截图：文档滚动条消失；会话页消息列与输入框宽 8px，错误卡片、靠右的用户气泡和输入框右侧的模型与发送键右移 8px；归为其它的像素（明 253、暗 326 个）是错误卡片右移后露出的标题文字与卡片阴影边。 |
| webkit-dark-phone 的 notification-error、settings-saved | 本截图：只有文档滚动条消失，右侧 8px 由透明变为页面（含 .app-view 自己的滚动条），(0,0) 一点；内容与通知都不动。明色手机的同一张变化相同，按 P0 比较器低于阈值（透明列按白色比较），不登记。 |
| webkit-dark-phone 的 profile-validation | 本截图：只有文档滚动条消失，右侧 8px 由透明变为页面（含 .app-view 自己的滚动条），(0,0) 一点；P4.1 接受的“Name saved”胶囊位置（x 127，按 390 宽排版）、文字与卡片都不变。被替换的当前期望是 P4.1 的接受条目（before 与它逐字节相同），该条目移入 previous。明色手机的同一张变化相同，按 P0 比较器低于阈值，不登记，仍是 P4.1 的接受条目。 |

末尾（9 条相同）：

> 出处：webkit-scroll-lock/README.md「P0 的影响：12 张 WebKit 截图，9 张需要重登」逐张说明表中该截图一行；协调者对该批第 1 版证据的 CONFIRM（判定记录 fRJrSzK3CevsTPV4xEki6）把这 9 张接受为该批的迁移差异。该批 compare/p0-changed-webkit.json 的不同像素数与 shots/p0/classes.json 的逐像素归类（灰 = 文档滚动条，蓝 = 右移 4px，绿 = 右移 8px，红 = 其它），与本条 before → after 相同。

说明中的机制、透明列与灰点的颜色、主区宽度和元素的移动都出自该批证据，本任务没有重新测量。本任务核对了以下几点：
- before → after 的像素数和归类与该批相同；
- 原件与该批的 before、after 逐字节相同；
- 归为其它的像素位置和与右移图的差（上面的列表）。

## 未登记的截图

- **低于阈值的 WebKit 明色手机 3 张**：`settings-saved`、`profile-validation`、`notification-error`。before → after 各 6753 个像素，全在文档滚动条列和 (0,0)，与暗色手机相同；P0 比较器把明色下的透明列按白色比较，判为相符。登记工具不收（after 必须在比较器下与 before 不同），它们仍对照当前期望通过，其中 profile-validation 仍是 P4.1 的接受条目。
- **低于阈值的既有差异，11 张**：登记前期望对照 before 和 after 都有这 11 张，before 与 after 逐字节相同，比较器都判为相符，与该批无关。就是 P3.2 已记录的 11 张：深色 task-action-menu 4 张（466–655 像素）；webkit-dark-phone 的 task-detail、task-action-hover、task-action-focus（66 像素，1 级）；WebKit 桌面的 breakpoint-599/601-dialog 4 张（8–11 像素，1 级）。见 [p3.2-accepted](../p3.2-accepted/README.md)「未登记的截图」。
- **Chromium 噪声**：before → after 有 16 张，都在 p0-drift 的噪声范围（单通道差 ≤4、≤200 像素）内，都通过比较器：3–23 像素，最多差 4 级。逐张见 [compare/before-vs-after.json](compare/before-vs-after.json)。
- **WebKit 的其余截图**：before → after 逐字节相同，除了上面 12 张没有任何变化。

## 验证

### 两轮完整 P0 回归（当前 tip）

命令是 P0 原命令 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web`，经 [netns-regression.sh](../p0-drift-2/tools/netns-regression.sh) 放在独立网络命名空间里。在本工作树 `821e2d501` 上连续运行，该提交即项目 tip `b2568f28d` 加登记，没有已跟踪的改动。驱动脚本是 [tools/final-and-controls.sh](tools/final-and-controls.sh) 的 `final`，作业 `bgj_17238e489d8b`。

| 轮次 | 结果 | 记录 |
| --- | --- | --- |
| 第 1 轮（02:46–02:51 UTC） | 112 个测试：101 通过、11 跳过、0 失败、0 flaky，退出码 0 | [summary](checks/final-round-1/summary.json)、[报告摘要](checks/final-round-1/report.summary.json)、[输出](checks/final-round-1/command-output.txt)、[sources](checks/final-round-1/sources.json) |
| 第 2 轮（紧接其后，02:51–03:00 UTC） | 与第 1 轮逐个状态相同，退出码 0 | [checks/final-round-2](checks/final-round-2/summary.json) |

- 两轮都先通过了 globalSetup 对 P0.2 原图、两层登记和环境的校验。期望组装为 `87 P0.2 originals, 143 main drift references, 22 accepted migration differences`。与开工时相比，P0.2 原图少 1 张（webkit-dark-phone 的 notification-error），main 漂移参考少 7 张，已接受层多 8 张（登记 9 条，其中 1 条替换了 P4.1 的条目）。
- 两轮的 sources.json 逐字节相同。其中登记的 9 张来自 `accepted` 层，`decision` 为该批第 1 版；webkit-light-phone 的 profile-validation 仍是 P4.1 的条目。
- 环境记录与 P0.2 逐字节相同（[environment-check](checks/final-round-1/environment-check.txt)）。
- 结果只含已记录的处置：101 个通过，11 个跳过（7 个非参考项目的性能采样，4 个手机项目的桌面断点巡检，同 P0.2 记录）。没有失败、flaky 或预期失败。
- 每个测试的状态与该批参照 `15b7b5609` 上的标准 P0（[p0-standard-reference.report.summary.json](../webkit-scroll-lock/runs/p0-standard-reference.report.summary.json)，101 通过、11 跳过）逐个相同，见 [checks/statuses-final.json](checks/statuses-final.json)。

### 登记复核

[tools/verify-registration.cjs](tools/verify-registration.cjs) 不经登记工具，独立复核 9 条登记，结果在 [checks/registration-check.json](checks/registration-check.json)，问题数为 0。它由 p4.1-accepted 的同名工具改写，逐条检查：
- **判定字段**：等于引用的第 1 版 CONFIRM，文档存在，差异说明非空；
- **replaces**：是该截图在已接受层下面的那一层（main 漂移参考或 P0.2 原图），文件哈希与 registry 一致；
- **previous**：webkit-dark-phone/profile-validation 的 `previous` 正是 `b2568f28d` 上 P4.1 那条的 `sha256`、`decision`、`difference`、`sameCommit`，两条的 `replaces` 相同；其余 8 张在 `b2568f28d` 上没有已接受条目，也没有 `previous`；
- **提交**：
  - before 是该批第一个提交 `78cae80d9` 的父提交；`9f2f7e9a0`、`d49a8749b`、`b3e33e31d` 依次在它之上；
  - after 是以 `b3e33e31d` 为第二父的落地合并，提交说明为 `Merge refs/heads/orbit/webkit-1px-f604a9 into refs/heads/project/34ZZeq0e3IR65GVm2kAs7`；
  - 该批改的正好是 3 个文件，在 after 的树里与分支头相同；
  - before、after 都在当前 HEAD 的 first-parent 线上；
- **环境**：两次运行都与 P0.2 相同；
- **原件**：`accepted/` 里的 before/after 与运行目录的截图、registry 记录的哈希逐字节相同，也与该批证据 `shots/p0` 的 before、after 和 `compare/p0-changed-webkit.json` 记录的哈希逐字节相同；
- **比较器**：before 在 P0 比较器下复现当前期望（对 webkit-dark-phone/profile-validation 是 P4.1 的接受图），after 与 before 不符；
- **该批数据**：before → after 的像素数等于该批 `compare/p0-changed-webkit.json` 的记录，逐像素归类等于 `shots/p0/classes.json`；
- **已接受层其余条目**：与 `b2568f28d` 上的 13 条逐字段相同；
- **完整性**：
  - 全部 252 张中，after 对登记前期望不符的恰是登记的 9 张；
  - before 对登记前期望 0 张不符。

### 负对照

所有负对照都在临时树上做（[tools/final-and-controls.sh](tools/final-and-controls.sh) 的 `controls`）：
- 把 before 工作树（/mnt/data）指向登记提交 `821e2d501`，按 worktree-overlay.sh 重新准备；
- 把补丁追加到 `src/web/src/index.css`，以临时提交固定，不交付、不推送；
- 跑同一条 P0 原命令，期望组装与两轮回归相同（`87 / 143 / 22`）。

两个补丁都只在一个页面上生效，各自只影响一种截图（8 个项目都有这张，其中 3 张是本次登记的）：
- **胶囊**：`body:has([aria-label="Smart model selection"]) .toast--pill { position: relative; left: 1px }`。这个开关只在设置页上（`SettingsPage.tsx`），胶囊在 `settings` 截图之后才出现，所以只影响 `settings-saved`。
- **错误卡片**：`body:has(.composer-box) .toast--attention { position: relative; left: 1px }`。输入框只在会话页（`WorkspaceView.tsx`），错误卡片在发送失败后才出现，所以只影响 `notification-error`。

| 对照 | 改动 | 被测截图当时的期望 | 结果 | 记录 |
| --- | --- | --- | --- | --- |
| 胶囊 | 设置页“Setting saved”胶囊再右移 1px（[patch](negative-control/pill/patch.diff)，临时提交 `b79956472`） | WebKit 明暗桌面和暗色手机 3 张为已接受层（本次登记），其余 5 张为 main 漂移参考 | **settings 8/8 失败在 settings-saved**：已接受层明色桌面 264、暗色桌面 231、暗色手机 234 像素；main 漂移参考 222–291 像素。其余 93 通过、11 跳过。退出码 1 | [summary](negative-control/pill/summary.json)、[差异图](negative-control/pill/failures/)、[裁图](regions/nc-pill-crops/) |
| 错误卡片 | 会话页错误卡片再右移 1px（[patch](negative-control/error-card/patch.diff)，临时提交 `93df50977`） | WebKit 明暗桌面和暗色手机 3 张为已接受层（本次登记），Chromium 桌面 2 张为 main 漂移参考，其余 3 张手机为 P0.2 原图 | **session 8/8 失败在 notification-error**：已接受层明色桌面 1275、暗色桌面 1332、暗色手机 1363 像素；main 漂移参考 1267、1625 像素，P0.2 原图 1267–1657 像素。其余 93 通过、11 跳过。退出码 1 | [summary](negative-control/error-card/summary.json)、[差异图](negative-control/error-card/failures/)、[裁图](regions/nc-error-card-crops/) |

- 两组对照里，新登记的 3 张失败时的 expected 就是本次登记的期望图（与 `p0-drift/accepted/screenshots/` 逐字节相同，见 [tools/nc-regions.sh](tools/nc-regions.sh) 的输出和各自的 `failures.sha256`），所以失败是对照已接受层的失败。
- 拿 actual 与登记的期望图对照（[regions/nc-pill.json](regions/nc-pill.json)、[regions/nc-error-card.json](regions/nc-error-card.json)，[regions.py](../p3.2-accepted/tools/regions.py)），差异正是补丁改动的地方：
  - 胶囊对照只在胶囊及其阴影上：桌面全部差异在 x 1100–1279、y 2–81 内，手机在 x 105–285、y 44–123 内；超过 2 级的聚类是文字（约 92×14）、图标与左端（30×35）、右端（16×35）。
  - 错误卡片对照只在错误卡片及其阴影上：桌面全部差异在 x 882–1279、y 2–191 内，手机在 x 0–389、y 45–244 内（手机的卡片与通知列同宽）；超过 2 级的聚类是标题“Couldn't send the message”（183×14）、错误详情的几行文字、“Copy error”按钮和卡片左右两条边。
- 第 1 组改动的正是本次接受的差异之一（胶囊随通知列的位置）：胶囊位置的 1px 偏差会被检出，没有被登记放过。第 2 组改动的是本次接受差异里移动最多的错误卡片（桌面右移 8px）：在它上面再多 1px 同样会被检出。两组都说明登记后的期望图仍逐像素守着这些页面。

### 合并检查

项目合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web`（[tools/merge-check.sh](tools/merge-check.sh)）：
- **运行位置**：本工作树 `821e2d501`，代码与之后的证据提交相同。运行时本目录正在整理，未跟踪，构建和测试都不读它。作业 `bgj_d89b1450d3fd`，2026-10-09 03:00 UTC 开始，与错误卡片负对照、合并树上的 P0 同时运行。
- **结果**：退出码 0，03:00–03:07 UTC。
  - `tsc -b && vite build` 通过，保留原有的大 chunk 提示；
  - Vitest（`--maxWorkers=2`）**370 个测试文件、4801 个用例全部通过**，用时 420 秒。
- **记录**：
  - [checks/merge-check.txt](checks/merge-check.txt) 是 [filter-merge-check.py](../p3.2-accepted/tools/filter-merge-check.py) 过滤后的输出。它保留完整构建输出、每个测试文件的结果行和汇总行，去掉了用例运行中打印的控制台告警；
  - 完整输出写在本机 `/mnt/data/tmp/34cfhmpygHQdZxRznyVH9/logs/merge-check.log`，按任务要求在交证据前随临时目录删除。它的行数和 SHA-256 见 [checks/merge-check.json](checks/merge-check.json)（[tools/merge-check-record.py](tools/merge-check-record.py)）。

### 不变项

[tools/scope-check.sh](tools/scope-check.sh) 的输出在 [checks/scope-check.txt](checks/scope-check.txt)（在登记提交上运行）：
- **登记提交**：只改 `p0-drift/accepted/` 下 19 个文件（registry 与 18 张原件）和 `p0-drift/README.md`。README 只在已登记清单加了一行和一段说明，没有改别的行。
- **受保护的路径**：从开工时的项目 tip `b2568f28d` 到登记提交，以下 `git diff --stat` 为空：
  - `p0.2/`（原图、环境记录、baseline-run）；
  - `p0-drift/reference/`（main 漂移参考层）；
  - `src/web/ui-migration/`（场景、断言、固定数据、`maxDiffPixels: 0` 与默认 threshold、known-failures、期望组装）；
  - 整个 `src/`、根 `package.json` 与 `package-lock.json`。
- **已接受层**：其他批次的 13 条与 `b2568f28d` 逐字段相同；webkit-dark-phone/profile-validation 的 `previous` 正是 `b2568f28d` 上 P4.1 的那条。条目数从 14 变成 22，其中 9 条属于该批。
- **登记之后的提交**：只改本目录。证据提交之后又跑了一次 scope-check，在本任务证据的引用里。

## 跟上 main

- **开工**：项目 tip `b2568f28d` 已在 origin/main 里（`git merge-base --is-ancestor` 成立）。当时的 origin/main `953e6b588` 就是把项目合并进 main 的提交，树与项目 tip 相同，跟上 main 没有可带进来的内容，所以按任务说明从项目 tip 开工。
- **最终轮之后**：两轮回归从 02:46 UTC 开始。之后 fetch 到 origin/main 前进到 `f339640df`，多 7 个提交（提交时间 02:32–02:38 UTC，开工时 fetch 还看不到）。按作业指导「跟上 main」最后一条，用 `git merge-tree` 对它干跑（[tools/main-dryrun.sh](tools/main-dryrun.sh)，输出 [checks/main-dryrun.txt](checks/main-dryrun.txt)）：
  - 与登记提交 `821e2d501` 合并没有冲突。
  - main 带来的是协调者问题的记录：apiserver 读回已结束的问题，macOS/iOS 与 Web 把答过或撤回的问题画成记录卡片；另有 runner 的账号槽测试与引擎安装、文档和证据。
  - Web 与 shared 下改了 `CoordinatorQuestionCard.tsx`（及测试）、新增 `CoordinatorQuestionRecord.test.tsx`、`WorkspaceView.tsx`（把已结束的协调者问题画进对话，只在协调项目的会话里）、`index.css`（只新增规则，没有改动已有规则；新增的每个选择器都带 `.answered-question-*` 类，不作用于已有元素）和 shared 的 `project-progress.ts`。
  - 不碰本次登记的文件（`p0-drift/`）、P0 场景与比较（`src/web/ui-migration/`）、`ui/` 公共组件、通知与弹层代码、设置页与资料页、锁文件。
  - WorkspaceView 是 notification-error 所在的会话页。为确认 main 这次改动不影响登记的截图，把合并树以临时提交 `5376c49da`（树 `c8fc262d5`，父提交为登记提交与 `f339640df`，不交付、不推送）检出到临时树，按 worktree-overlay.sh 准备后跑同一条 P0 原命令（[checks/main-merge](checks/main-merge/summary.json)，03:05–03:13 UTC，作业 `bgj_1d5d298f55d5`）：
    - 112 个测试：101 通过、11 跳过、0 失败，退出码 0；
    - 期望组装同样是 `87 / 143 / 22`，sources.json 与两轮回归逐字节相同，逐个状态也相同（[checks/statuses-final.json](checks/statuses-final.json)）；
    - 登记的 9 张在合并树上照样对照已接受层通过。
  - `audit-antd.mjs --check-owners` 在登记提交和合并树上都是 0 未归属、0 待定，归属计数相同（[checks/check-owners-821e2d501.json](checks/check-owners-821e2d501.json)、[check-owners-main-merge.json](checks/check-owners-main-merge.json)）。
- 所以没有再 rebase，最终检查都在 `821e2d501` 上；合并后的树由落地时的合并检查兜底。

## 边界

- **after 原件的提交**：after 取自 `b2568f28d`，即该批落地项目线的合并，也是本任务开工时的项目 tip，不是该批的分支头 `d49a8749b`。两者该批的 3 个文件相同；12 张 WebKit 截图在两处逐字节相同，见「同提交原件」。
- **判定引用**：registry 只能离线校验判定的格式和文档是否存在。判定是否真实存在，要由协调者在 Orbit 中核对（规则第 4 条）。本目录保存了证据版本和判定响应的原文。
- **差异说明的依据**：机制、透明列与灰点的颜色、主区宽度、元素的移动距离都来自该批证据和判定，本任务只核对了像素数据、归类和归为其它的像素位置。
- **低于阈值的差异**：P0 比较器（`maxDiffPixels: 0`、默认 threshold）看不到的差异，没有也不能登记，已在「未登记的截图」列出。
- **临时目录**：tools/ 里的脚本写着 `/mnt/data/tmp/34cfhmpygHQdZxRznyVH9` 和本工作树的路径。按任务要求，交证据前删除了这个目录，包括 before 工作树（已从 `git worktree list` 移除）和全部运行原件。
  - 证据里保存了每次运行的记录和全部截图哈希，登记的 18 张原件在 `p0-drift/accepted/`。
  - verify-registration.cjs 的完整性部分要读运行目录里的 504 张原件，复跑须先用 originals.sh 重新生成。WebKit 截图在这台主机上可逐字节复现：12 张 before/after 与该批证据里更早那次运行的截图逐字节相同。
- **负载**：浏览器运行期间主机 1 分钟负载在 15–68 之间，有其他会话的浏览器与构建。同提交原件、开工回归、两轮回归和负对照都在第一次运行即得到上述结果，没有重跑。
- **其余边界同 P0.2**：Linux 固定环境、合成 REST/SSE、非真机 iOS。

## 复跑

```sh
bash scripts/worktree-overlay.sh
NO_COLOR=1 npm run test:ui-migration -w @orbit/web            # 应全部通过：101 通过、11 跳过
bash docs/evidence/base-ui-migration/webkit-scroll-lock-accepted/tools/scope-check.sh 821e2d501
npm run build -w @orbit/web && npm run test -w @orbit/web
```

工具（[tools/](tools/)）：
- **原件**：`prepare-before.sh`（before 工作树）、`originals.sh`（开工回归与两次同提交原件，依次调用 netns-regression.sh 和 p3.2-accepted 的 same-commit-originals.sh）；
- **对照**：`compare-all.sh`（登记前期望与三组对照）、`tip-start-vs-originals.sh`、`compare-statuses.py`；
- **判定**：`find-decision.py`、`extract-decision.py`；
- **登记**：`register.sh`，即这次的 `register-accepted.cjs` 调用；
- **复核**：`verify-registration.cjs <运行目录> <输出>`、`scope-check.sh <登记提交>`；
- **回归与负对照**：`final-and-controls.sh final|controls`，补丁 `negative-control-pill.css`、`negative-control-error-card.css`，差异区域 `nc-regions.sh`；
- **跟上 main**：`main-dryrun.sh [run]`、`check-owners.sh <合并提交>`；
- **合并检查**：`merge-check.sh`、`merge-check-record.py`；
- **归档**：`collect.sh`，按「证据体积」约定从运行目录取出本目录引用的文件。

## 文件

| 路径 | 内容 |
| --- | --- |
| [decision/webkit-scroll-lock-decision.json](decision/webkit-scroll-lock-decision.json) | 引用的判定：该批证据版本、摘要，协调者判定调用及服务端响应原文 |
| [checks/tip-start/](checks/tip-start/) | 开工回归（`b2568f28d`，登记前），含 9 个失败的差异图和附件哈希 |
| [checks/tip-start-vs-originals.txt](checks/tip-start-vs-originals.txt)、[statuses-tip-start.json](checks/statuses-tip-start.json) | 开工回归的失败图与原件逐字节对照；与该批标准 P0 的逐个状态对照 |
| [checks/final-round-1/](checks/final-round-1/)、[final-round-2/](checks/final-round-2/)、[statuses-final.json](checks/statuses-final.json) | 当前 tip 上的两轮回归及其逐个状态对照 |
| [checks/registration-check.json](checks/registration-check.json) | 登记复核与 252 张的完整性 |
| [checks/scope-check.txt](checks/scope-check.txt) | 登记提交的范围与受保护路径 |
| [checks/merge-check.txt](checks/merge-check.txt)、[merge-check.json](checks/merge-check.json) | 合并检查 |
| [checks/main-dryrun.txt](checks/main-dryrun.txt)、[checks/main-merge/](checks/main-merge/) | 与最新 origin/main 的干跑合并，合并树上的 P0 |
| [checks/check-owners-821e2d501.json](checks/check-owners-821e2d501.json)、[check-owners-main-merge.json](checks/check-owners-main-merge.json) | `audit-antd.mjs --check-owners`：登记提交与合并树 |
| [originals/](originals/) | 同提交原件：提交、环境、全部截图哈希、构建产物哈希、输出、报告摘要；登记前的期望来源 |
| [compare/](compare/) | compare.cjs 的逐张对照：登记前期望、before、after |
| [regions/](regions/) | 两组负对照的差异区域与裁图 |
| [negative-control/](negative-control/) | 两组负对照：补丁、输出、summary、报告摘要、差异图、附件哈希 |
| [tools/](tools/) | 上述脚本 |

报告按「证据体积」约定只交 report.summary.json（去掉附件正文），没有提交 trace.zip。截图只提交上表引用的差异图和裁图：开工回归与两组负对照的差异图，两组负对照的裁图。登记的 18 张原件在 `p0-drift/accepted/`，每张的 before、after 与归类图已在该批证据 `shots/p0/`，没有重复提交。本目录约 5.6 MB。
