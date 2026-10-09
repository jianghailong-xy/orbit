# P4.3b 依赖图与业务决策卡片

服务于 [P4.3b 迁移依赖图与业务决策卡片](orbit-task:34blYpxEcHMAf4oafuC2W)，项目验收条目 key `hnPVsE0kmorHXurrs4Qdp`：**P4：全部非会话业务界面完成迁移，既有页面操作和响应式呈现保持一致。** 本任务承担其中的子范围：任务与项目的依赖图（图视图、节点与边、图工具栏、展开与操作）和业务决策卡片。

本批是 P4.3 按 P3.3 建议拆出的后半，与 [P4.3a 迁移任务与项目的列表、详情页和工具栏](orbit-task:34Za39GvWRQ08ZmKOpFNe) 并行。两边都要用的公共组件由 P4.3a 写成独立提交。P4.3a 已先落地，这些提交现在在本批的基础里（见[与 P4.3a 的分工](#与-p43a-的分工)）。

**交接**：上一个执行会话 `7GbiELOLsZD3g8slnoVxzQ` 在 2026-10-08 19:15Z 撞上周额度停下。本会话从 22:55Z 接手：取回它的分支 `orbit/p4-3b-09e7a7`（HEAD `7050ef420`）和未提交的证据草稿（快照 `refs/wip/p4.3b-weekly-limit-20261008T2255Z`），跟上 main，再在新基础上重做全部最终检查。上一会话停下时正在查的问题（P4.2 引擎页的「More actions」悬停变了），查明是本批引起的层叠回归，见[首屏样式表](#首屏样式表)。

**基础与交付**：本批 12 个提交接在项目 tip `abc0a4cfa`（P4.3a 已落地）上，再合并 origin/main `4085437ff`，得到 `e21fad172`；交付 `2fefd4747` 在它之上只加一个改测试的提交（main 的一个单测在宽屏上早读计划，最终轮的合并检查查出，见[第 14 条](#14-workspaceview-里启动卡片的单测在宽屏上早读计划)）。之后的提交只加本目录的证据。

**为什么在 P4.3a 之后又跟了一次**：本批在 `a8df7eac6`（origin/main `945098b11`）上的最终轮已整轮跑完，全部通过。但 P4.3a 改了同一批公共文件：与它的分支头干跑合并，5 个文件冲突，另有 23 个文件两边都改。照原来的顺序，本批跑完时 P4.3a 已落地，还得再合一次、再跑一整轮。协调者因此定下 P4.3a 先落地：本批暂停，在临时树里试合 P4.3a 的分支头，把冲突解法写成脚本并核对；P4.3a 落地后，按作业指导（项目 tip 不在 origin/main 时，先 rebase 到项目 tip，再合并 origin/main）跟上，重放解法，整轮只跑一次。之前 main 前进到 `f8fdf50f0` 时，本批已经跟过一次：那次 main 给本批的 `CoordinatorQuestionCard.tsx` 加了已结束问题的记录，干跑合并冲突。经过见[P4.3a 之后跟上](#p43a-之后跟上2026-10-09)与[main 改了本批的 CoordinatorQuestionCard](#main-改了本批的-coordinatorquestioncardf8fdf50f0)。

同提交对照与浏览器上的最终检查都在 `e21fad172` 的三棵树上；合并检查与相关单测在交付 `2fefd4747` 上（它只多一个 vitest 文件，浏览器运行不读它）：
- 参照：交付只撤回业务切换 `4bd2f2f4a`（本地提交 `40f79c5ab`，没有推送）；
- 起点：项目 tip `abc0a4cfa` 合并 origin/main `4085437ff`，不含本批（本地提交 `5034a3e9f`）。

## 结论

- **本批 AntD 使用点**：30 个全部关闭——17 个生产文件不再导入 antd，2 个测试改读 Orbit 类名与角色，index.css 的 11 行 `.ant-*` 规则改写到 Orbit 类名。跟上 main 后复扫，`--check-owners` 为 0 未归属、0 待定，本批 0 个点；关闭记录见 [inventory-closure.json](inventory-closure.json)。本批新增的样式表单测期望里写着 antd reset 的名字，协调者判给 P6，记录在 [2026-10-09.json](../inventory-delta/2026-10-09.json)。
- **依赖图与业务决策卡片的操作和状态含义**：请求、请求体、通知与 alert 在两树逐步相同（P4.3b 用例 76 个、464 步；决策卡片页 68 个、176 步）。打开的层与地址只在三处不同，都对应已有决定或交协调者判：任务图全屏、启动卡片的计划图全屏（手机）里按 Escape 只关一层，对应 P2 的嵌套弹层规则；键盘关闭全屏后，焦点回到按钮时显示提示，是 P2.1、P2.2 两条约定叠加的结果，没有找到专门的判定。见[逐步语义](#p43b-用例与决策卡片页逐步语义)。
- **呈现**：P4.3b 用例 320 张截图：195 张逐字节相同、79 张抗锯齿级、46 张超出；决策卡片页 124 张：95、19、10。超出的逐类写明原因和对应的已有决定（焦点环、提示边距、加载点、栅格化、WebKit 滚动锁）；两类是参照一侧的问题，交付与页面上的图一致：手机上计划图里链接的下划线，桌面上计划图连线的测量偏移。`d91a0dd48` 的新状态（宽窗口下 720px 上限、只在截断时出现的 More 与 Read all、计划画成任务图或分层列出）两树记下的几何逐项相同；会话里启动卡片的 24 张截图 23 张逐字节相同、1 张抗锯齿级。`3ff232299` 的已结束问题记录与详情 16 张两树逐字节相同。启动对话框的第一张截图取在计划图决定读法之前，两树各自取到图或分层，见[P4.3b 用例：截图](#p43b-用例截图)。
- **本批引起、已修正的回归**：
  - 首屏样式表的先后随拆包变化（P4.2 引擎页的悬停等），见[首屏样式表](#首屏样式表)；
  - 弹层取回焦点时滚动（Chromium 手机上完成对话框跳动），见[公共组件](#公共组件)；
  - OrbitKit 的文案一致性测试读本批改过的标记，swift 套件 16 处失败，见[第 13 条](#13-orbitkit-的文案一致性测试读本批改过的标记)；
  - main 的一个 WorkspaceView 单测在宽屏上早读启动卡片的计划，换成 Orbit 组件后会抢在图的应答之前（合并检查 1 个失败），见[第 14 条](#14-workspaceview-里启动卡片的单测在宽屏上早读计划)。
  - 另外修正了用例自身的取样时刻（第 11、12 条），第 11 条改前改后的对照见[取样对照](#取样对照)。
- **既存的图布局缺陷**：639px 底部超出 31px、641px 第一个标记落在缩放工具栏下、1280px 标记停在条带底边以内 1px，与 P0.2 的记录逐项相同，两树相同。本批没有修这三处，也没有带来新的几何差异，见[既存的图布局缺陷](#既存的图布局缺陷)。
- **回归**：P4.1 用例、组件矩阵（overlays 与 overlays-app-frame、controls、choices）、合并检查（`2fefd4747`）、相关单测与 OrbitKit 的 swift 套件全部通过。标准 P0 的 36 个失败与 P4.2 的 5 个用例（每个环境各一次）在起点与交付上相同，是 main 的 Infrastructure 页带来的基础漂移，不是本批的回归，见[标准 P0 的基础漂移](#标准-p0-的基础漂移)与[起点对照](#起点对照p41-与-p42-用例)。P4.1、P4.2 截图的超出是已归类的栅格化；trace 的差异是取样时刻，两个方向都有。swift 套件在改锚之前有 16 处失败（第 13 条），改锚之后 0 失败（`e21fad172` 上 3550 个）。
- **交给协调者判的**：
  1. 全屏图对话框 Close 的悬停底色：参照 6%（明）/12%（暗），交付是 Orbit 控件共用的 4%/8%，没有找到已有决定（[截图](#p43b-用例截图) `p43b-graph-full`）；
  2. 键盘关闭全屏后焦点回到全屏按钮、按钮的提示随之显示：P2.1 与 P2.2 两条约定叠加的结果，没有找到专门的判定（[逐步语义](#p43b-用例与决策卡片页逐步语义)）。
  
  另外已告知协调者：P4.3a 的分支有同类的 OrbitKit 文案一致性问题（第 13 条），P4.3a 落地时 swift 已是 0 失败；main 的 Infrastructure 页使标准 P0 与 P4.2 用例在起点上就失败，两者都已告知协调者（标准 P0 由协调者另建「P0 漂移登记（第 7 批）」）。

## 范围

开工时（项目 tip `44a569d8b`）按复扫规则运行 `audit-antd.mjs` 与 `--check-owners`：0 未归属、0 待定，P4.3b 负责 31 个使用点（[start-check-owners](checks/start-check-owners.json)、[逐点列表](checks/start-p43b-points.jsonl)）。之后协调者把其中 index.css 10699 行的共用注释判给 P4.3a（记录 `2026-10-08b.json`，由 P4.3a 提交），本批剩 30 个点：

- **生产文件 17 个**（都导入 antd）：
  - 依赖图：`TaskDependencyGraph`、`ProjectDependencyGraph`、`ProjectTasksGraph`；
  - 决策卡片：`AcceptanceConfirmationCard`、`ConfirmationReviewTurnCards`、`CoordinatorQuestionCard`、`CriteriaChangeCard`、`CriteriaDecisionCard`、`DecisionRail`、`EvidenceDecisionCard`、`OwnerConfirmationCard`、`OwnerConfirmationReopen`、`OwnerConfirmationReview`、`ProjectCrossingsCard`、`ProjectPromotionCard`、`ProjectSettlementCard`、`StartProjectCard`；
  - 其中 `ProjectCrossingsCard` 与下面的 `StartProjectCard.test.tsx` 是 main 带来、由协调者在 `2026-10-07c.json` 判给本批的点。
- **测试 2 个**：`ProjectTasksGraph.test.tsx`（从 index.css 读 `.pdg-section-title.ant-typography` 规则，注释提到 antd）、`StartProjectCard.test.tsx`（读选择器 `.ant-select-content` 的 title，注释提到 antd 的 autoSize）。
- **index.css 11 行**：`.project-done-not-yet .ant-input`、`.project-done-dialog .ant-modal-content`、`.pdg-section-title.ant-typography`，以及全屏图 `.tdg-modal` 的 8 条 `.ant-modal*` 规则（桌面 2 条、手机 6 条）。

每次跟上 main 后都复扫过，main 没有带来新的本批使用点。最后一次跟上后，`--check-owners` 报出 1 个未归属点，是本批自己新增的测试 `firstPageStylesheet.test.ts`（期望里写着 `antd/dist/reset.css`，见[首屏样式表](#首屏样式表)）。协调者 2026-10-09 判给 P6，本批写了记录 [2026-10-09.json](../inventory-delta/2026-10-09.json)（生成脚本 `build-record-09.py`，按最终基础从它的父提交 `74517607b` 的审计重新生成，`verify-record.mjs` 通过）。P4.3a 落地后它的记录 `2026-10-09b.json` 排在本记录之后，生成脚本因此改成核对「其余记录（前后都算）只剩这个测试文件未归属」，见[P4.3a 之后跟上](#p43a-之后跟上2026-10-09)。之后 `--check-owners` 为 0 未归属、0 待定，本批 0 个点。

为完成切换还改了下面这些文件，每处都有直接原因：

| 文件 | 归属 | 改动与原因 |
| --- | --- | --- |
| `ui-migration/page-scenarios.mjs` | P0 场景中归属本批的定位器 | `project-graph-fullscreen` 截图的 `surface` 从 `.ant-modal-container` 改为 `page.getByRole('dialog')`（Orbit 对话框本身就是表面）。与 P4.1 改 settings/profile 截图点相同：场景步骤和断言不变 |
| `ui-migration/playwright.config.mjs` | 标准 P0 配置 | P0 矩阵忽略 `p43b*.browser.mjs` |
| `components/ui/Alert.tsx`、`Alert.css`、`foundation.css` | 公共组件 | `type="info"`，见[公共组件](#公共组件) |
| `components/ui/Overlay.css`、`Overlay.tsx`、`ui/README.md`、`__fixtures__/OverlaysFixture.tsx`、`ui-migration/overlays.browser.mjs` | 公共组件与其矩阵 | 对话框的 Close 在内容之上；弹层取回焦点不滚动，见[公共组件](#公共组件) |
| `vite.config.ts`、`src/main.tsx`、`src/firstPageStylesheet.test.ts`、`ui-migration/p43b-cards.tsx` | 构建配置与入口 | 首屏只有一份样式表、按导入顺序，见[首屏样式表](#首屏样式表) |

## 与 P4.3a 的分工

协调者 2026-10-08 转告了两边的安排：

1. P4.3a 在 `components/ui/` 新增或扩展 Empty、Skeleton、`Typography.css`、`List.css`、Alert 的 action、Card 的 extra 与 small、Badge 的 purple、Input 的 allowClear。本批用到其中的，沿用同样的文件名和 API；本批需要而单子上没有的，自己加，起名不撞。
2. index.css 10699–10700 由 P4.3a 关闭，本批不动，关闭记录里也不写。
3. 开工和交证据前做清单复扫，`--check-owners` 为 0/0。

P4.3a 把公共组件写成独立提交，本分支原先把它们带在自己的提交之下，与 P4.3a 分支上的原提交逐个核对过 patch-id（`git patch-id --stable`），都相同，所以谁后落地，合并时都是相同的补丁。P4.3a 已在 2026-10-09 07:57Z 落地（项目 tip `abc0a4cfa`），这些提交现在在本批的基础里，本分支不再单独带着它们（见[P4.3a 之后跟上](#p43a-之后跟上2026-10-09)）：

| P4.3a 落地的提交 | 内容 | 本批用到的 |
| --- | --- | --- |
| `9809e6b20` | Empty、Skeleton、typography 与 list 样式、Card 的 extra/small、Alert 的 action、Badge purple、Input 清除 | Empty（项目图为空）、Skeleton（跨项目卡片读取中）、`Typography.css`（决策条、项目图标题、跨项目卡片）、Card extra/small（跨项目卡片）、Alert action（项目图读取失败的 Retry） |
| `33f6a7c33` | 清单记录 `2026-10-08b.json` | 本批的点数由 31 变 30 |
| `365dc1297` | Button iconPlacement、Input warning、option title、Checkbox 的 change 事件、ConfirmDialog 宽度 | 不用 |
| `76282079a` | typography 的文字保持自己的字体和 14px | 决策条与跨项目卡片的文字在 12px 父元素里仍是 14px，与参照相同 |

P4.3a 还转告了一类层叠问题：AntD 的样式插在 head 最前，Orbit 组件样式在 index.css 之后，所以页面规则与组件规则同权重时，迁移前页面赢、迁移后组件赢。本批在同提交截图里已经抓到并改了这类规则（见[开发中发现并修正的问题](#开发中发现并修正的问题)第 5 条），另用 P4.3a 的静态检查脚本（[ties-from-p43a.py](scripts/ties-from-p43a.py)，复制自 P4.3a 的临时目录）在交付 `e21fad172` 上扫了本批 17 个文件，结果在 [checks/ties.txt](checks/ties.txt)。与 `a8df7eac6` 上的结果相比，除行号外只多出两条，都不是 `TIE?`：P4.3a 给项目页运行设置里的合并检查框写的 `.project-run-settings-grid .start-card-mono.orbit-text-control`（`(0,3,0)`，字体与 961px 以上的字号）。脚本按类名把它算到本批启动卡片的 `<Textarea start-card-mono>` 上，但启动卡片不在 `.project-run-settings-grid` 里（`ProjectRunSettings` 只从 `StartProjectCard` 导入一个常量），这条规则碰不到它。脚本标出的 10 处 `TIE?` 与之前相同，逐一看过，都不是真冲突：

- 3 处卡片的错误提示（`.coordinator-question-error`、`.criteria-decision-error`、`.project-promotion-error`）：本批的规则已带组件类，`(0,2,0)` 高于组件根的 `(0,1,0)`。标成 `TIE?`，是因为脚本把子元素上的 `(0,2,0)` 规则（如 `.orbit-alert-with-description .orbit-alert-title`）也算了进来。
- 4 处全屏图的视口留白（两张图，桌面与手机）：`.orbit-dialog-viewport:has(> .tdg-modal)` 是 `(0,2,0)`，高于 Overlay.css 的 `.orbit-dialog-viewport { padding: 100px 0 0 }`。与它同权重的是抽屉的 header/body/footer 规则，作用于别的元素。
- 2 处手机全屏的 `.tdg-modal.orbit-overlay`：同权重的只有 `.orbit-overlay[hidden] { display: none }`，它只在关闭时生效，本来就该赢；其余列出的规则作用于遮罩和视口。
- 1 处 `.start-card-mono` 的 `(0,1,0)` 字体规则：同一条规则里已加了 `.start-card-mono.orbit-textarea`（`(0,2,0)`）。

两边之后各自又改了同一批公共文件：与 P4.3a 的分支头干跑合并，有 5 个文件冲突（`Alert.tsx`、`Overlay.css`、`ui/README.md`、`ui-migration/playwright.config.mjs`、`inventory-delta/README.md`），都是两边各自的增量；另有 23 个文件两边都改但能自动合并。按约定由后落地的一方合并。协调者定下 P4.3a 先落地，本批在它落地后跟上并合并，每处冲突怎么合、合并后核对了什么，见[P4.3a 之后跟上](#p43a-之后跟上2026-10-09)。

另外，协调者提醒的 WebKit 滚动锁分支 `orbit/webkit-1px-f604a9` 也改了 `OverlaysFixture.tsx`，并新增 `overlays-app-frame.browser.mjs`。按协调者的安排，后落地的一方合并两边的 fixture 用例，并在合并后的树上把 overlays 和 overlays-app-frame 两套都重跑一遍。它先落地了（`b2568f28d` 把它合进项目线，随 main `f8fdf50f0` 进到本批），本批是后落地的一方：rebase 到 `f8fdf50f0` 时 `OverlaysFixture.tsx` 自动合并，两边的用例都在；最终轮在交付上把两套都跑了（`overlays.config.mjs` 的 `overlays*.browser.mjs`），结果见[结果](#结果)。

## 跟上 origin/main

- **开工**（上一会话）：项目 tip `44a569d8b`，它已在 origin/main 里；之后两次 rebase 到 origin/main（`721e48275`、`404c5ffce`），再 rebase 到 `047f91076`，并在 `3c03532b9` 上跑完第一轮正式对照（`round-047f91076`，见[过程记录](#过程记录)）。停下前把分支接到 P4.3a 已 rebase 到项目 tip `a2e58b0ce` 的共用提交上（`7050ef420`）。
- **接手**：`7050ef420` 快进到本会话的分支，rebase 到 origin/main `870e33a1f`（项目 tip `a2e58b0ce` 在 main 里）。唯一的冲突在 `CoordinatorQuestionCard.tsx` 的 import 段：main `19247ec50` 把问题文字改成 Markdown 渲染。合并后去掉 antd 的 import，保留 main 的 Markdown import，其余改动互不重叠。复扫：0 未归属、0 待定，本批 0 个点。
- 在这个基础上做出[首屏样式表](#首屏样式表)的修正，跑了一轮正式对照（`round-d1a3f6f7b`），对照中又查出[弹层取回焦点时的滚动](#开发中发现并修正的问题)，并发现用例取样的问题（[第 11 条](#开发中发现并修正的问题)）。
- **交证据前**：origin/main 从 `f6f385d2e` 起 Web 的 tsc 坏了，修复 `74fc42d4f` 先落到了项目线（tip `15b7b5609`，不在 main 里）。按协调者的规则先 rebase 到项目 tip，再合并 origin/main `f1837de8e`：rebase 无冲突，合并只带进 apiserver 与 runner-go 的 8 个文件，src/web 不变。复扫与归属记录见[范围](#范围)。在这个基础上（`52a8d7b36`）的最终轮跑到一半时被协调者叫停。
- **最终轮之后**：main 前进到 `a5c99e27f`，带来改了本批三个文件的 `d91a0dd48`。项目 tip 已在 main 里，直接 rebase 到 origin/main（`945098b11`），交付 `a8df7eac6`，见[最终轮之后又跟了一次 main](#最终轮之后又跟了一次-main2026-10-09)。在它上面的最终轮整轮跑完，全部通过（`round-a8df7eac6`）。
- **`a8df7eac6` 的最终轮之后**：main 前进到 `f8fdf50f0`，其中 `3ff232299` 改了本批的 `CoordinatorQuestionCard.tsx`，干跑冲突。项目 tip 仍在 main 里，直接 rebase 到 origin/main `f8fdf50f0`，补了用例，交付 `9ed85463a`，见[main 改了本批的 CoordinatorQuestionCard](#main-改了本批的-coordinatorquestioncardf8fdf50f0)。在它上面的最终轮刚开始重建三棵树，会话额度停掉了后台任务（还没有运行结果）；协调者随即叫停这一轮，定下 P4.3a 先落地。
- **P4.3a 落地之后**：项目 tip `abc0a4cfa` 不在 origin/main 里，按作业指导先 rebase 到项目 tip，再合并 origin/main `4085437ff`，交付 `e21fad172`，见[P4.3a 之后跟上](#p43a-之后跟上2026-10-09)。最终轮在它上面整轮跑一次；中途两次被停（08:30Z runner 停机、08:45Z 周额度），队列从中断处接着跑，见[过程记录](#过程记录)。

### 最终轮之后又跟了一次 main（2026-10-09）

**为什么**：在 `52a8d7b36` 上的最终轮跑到第三步时，main 在 00:39Z 前进到 `a5c99e27f`。其中 `d91a0dd48`（启动卡片：会话里 720px 上限、只在截断时画展开按钮、计划画成任务图）改了本批的 `ProjectDependencyGraph.tsx`、`StartProjectCard.tsx` 和 `index.css`，还新增了用到依赖图的 `StartPlanGraph.tsx`。协调者对 `52a8d7b36` 与 origin/main 干跑合并，三处冲突，落地时的 MAIN_SYNC 必然失败，于是叫停那一轮。那一轮已跑完的两步（P4.3b 用例两树）只作为过程记录（`round-52a8d7b36-partial`），不作为证据。

**怎么跟的**：项目 tip `15b7b5609` 已在 main 里，按规则直接 rebase 到 origin/main（rebase 当时已到 `a9af35f33`，随后又 rebase 到只加设计图的 `945098b11`）。两处修正仍放在业务切换之前。三处冲突都在业务切换提交里：

- **`ProjectDependencyGraph.tsx`**：保留 main 的新结构——`fullScreenOnly` 时不画条带，条带把 `embedded` 传给画布，全屏关闭时调用 `onClose`，全屏宽度按 `narrow` 而不是 `vertical` 判断，`fullScreenOnly` 时不显示超出读取上限的提示——组件用本批的 Orbit `Tooltip`（`content=`）和 `Dialog`（`onClose`）。main 版本里这个文件用的 antd 组件（Alert、Button、Empty、Modal、Popover、Spin、Tooltip）全部由本批的 Orbit 组件替代，与此前相同。
- **`StartProjectCard.tsx`**：两边在同一处各加了声明，两者都保留：main 的 `levels`（分层计划，供图放不下时使用），本批的 `lines`（线路菜单的两项）。main 新加的 `useClampHides`、懒加载的 `StartPlanGraph`/`StartTaskGraph`、「Task graph」链接、项目页启动对话框在路由变化时关闭，都原样保留，放在本批的 Orbit Switch、Select、Textarea、NumberInput、Spinner、Alert、Dialog/Drawer 之上。main 版本里这个文件用的 antd 组件（Alert、Input、InputNumber、Modal、Select、Spin、Switch）全部由本批替代。
- **`index.css`**：冲突在「Start this project?」一节，`.start-card-sheet .settlement-card-head { display: none }` 之后。两边在同一位置各插了规则：
  - main：`.start-card { max-width: 720px }`、`.start-card-graph { margin: 2px 0 6px }`、`.start-card-graph-link { margin-left: 14px }`，以及注释里补上的设计图出处；
  - 本批：`.start-card-dialog.orbit-overlay { line-height: 1.5714285714285714 }`、`.start-card-dialog > .orbit-overlay-header { margin-bottom: 0 }`、`.start-card-dialog .orbit-overlay-title:empty { display: none }`（替代被删除的启动对话框 `.ant-modal*` 覆盖）。
  - 合并：两组完整保留，本批的对话框外壳规则在前，main 的卡片宽度与计划图规则在后；main 的注释照 main。两组作用于不同的元素（对话框弹层、标题行、标题，对卡片、计划图、链接），任何一组的属性都不落在另一组的元素上，所以两组的先后不改变任何计算值。
- `StartPlanGraph.tsx` 本身不用 antd，它渲染的 `ProjectDependencyGraph` 是本批迁移后的版本；合并后的树上 `tsc -b` 通过，`StartProjectCard.test`、`ProjectDependencyGraph.test`（含 main 新加的用例）通过。
- 跟上之后复扫：不算记录 `2026-10-09.json` 时，`--check-owners` 只报本批自己的新测试 `firstPageStylesheet.test.ts`，也就是协调者判给 P6 的那一点；main 没有带来新的本批使用点（`d91a0dd48` 改的两个组件文件，本批已去掉 antd；`StartPlanGraph.tsx` 不用 antd）。记录按新基础从 `e0c495e68` 的审计重新生成，`verify-record.mjs` 通过；算上记录，0 未归属、0 待定（之后每次跟上都按新的父提交重新生成，最后一次是 `74517607b`）。

**补的用例**（交付里是 `99ddbe1d7`，当时是 `e0c495e68`），覆盖 `d91a0dd48` 的新状态，两树同一份：
- 决策卡片页新增「会话里的启动卡片」：一个等待启动的项目，带一条进行中的请求、在手机上才超过三行的协调者理由、一条在各宽度都超过两行的标准、五个任务分三层的计划（A；B、C、D；E）。记录卡片宽度与可用宽度、画了哪些展开按钮、计划取哪种读法，并把计划移进视口再截一张；手机上打开 More，再把计划的图全屏打开、按 Escape。
- 项目页的启动对话框：三个任务连成一条链（计划画成图）；一个任务之后六个并列（分层列出，「Task graph」全屏，再按 Escape）。两种都把计划移进视口截图，并记录画了哪些展开按钮。
- 每次读取都等 `StartPlanGraph` 加载并量过卡片之后再做。在那之前分层列表先占位：试跑时桌面的第一次读取就落在这一刻，把能画成图的计划记成了分层。
- Escape 关掉哪一层只记录、不断言：参照上全屏图是 AntD 弹窗，手机上压在它下面的启动面板或复核面板是 Orbit 的，两者各自响应 Escape，结果见[差异逐项](#差异逐项)。

**重跑的检查**：在 `a8df7eac6` 上重建三棵树（参照 `87d102f64`，起点 `945098b11`），正式链整条重跑：
- P4.3b 用例与决策卡片页，两树；
- P0 矩阵（参照、0 像素严格比较、交付），标准 P0（交付与起点）；
- P3.2 试点，两树；
- 合并检查（本任务工作树，NVMe）与相关单测；
- overlays 与 controls 矩阵，P4.1 与 P4.2 的起点对照；
- 比较与分类、探针、2026-10-09 补充的检查（体积、顺序静态检查、懒加载样式、会话导出、两个负对照）、清单复扫。

另外，这一轮先在交付上跑 OrbitKit 的 swift 套件（`swift:6.1` 容器，即 main 上 ci.yml「Swift core」的跑法）。它的文案一致性测试逐字读取 Web 源文件，其中 14 个是本批改过的（`StartProjectCard.tsx`、`ProjectDependencyGraph.tsx`、`index.css` 与各决策卡片）。
- 第一次在 `222017b25` 上 16 处失败，于是停下那一轮（正式链刚开始第一步）。
- 在业务切换里改锚（[第 13 条](#13-orbitkit-的文案一致性测试读本批改过的标记)），交付成为 `a8df7eac6`，整轮从头重跑。
- swift 套件在 `a8df7eac6` 上 3475 个用例 0 失败（5 个是 Linux 上总是跳过的 PerfBaselineTests），main `945098b11` 上同样 0 失败。

这一轮整轮跑完、全部通过（`round-a8df7eac6`）。之后交付又跟了两次（下面两节），最终检查以 `e21fad172` 的一轮为准，这一轮只作过程记录。

### main 改了本批的 CoordinatorQuestionCard（`f8fdf50f0`）

**为什么**：`a8df7eac6` 上的最终轮跑完时，origin/main 已前进到 `f8fdf50f0`。其中 `3ff232299`、`02c669222` 给本批迁移的 `CoordinatorQuestionCard.tsx` 加了「已结束问题的记录」：会话里，问题回答或撤回之后画成一份记录，打开详情能重放问题和每个选项。`a8df7eac6` 与它干跑合并，在这个文件的 import 段冲突，落地时的 MAIN_SYNC 必然失败，于是又跟了一次。同时进来的还有 WebKit 滚动锁修复（`Floating`、`Menu`、`OverlaysFixture.tsx` 都变了）。

**怎么跟的**：rebase 到 `f8fdf50f0`，冲突只在 import 段。保留本批的 Orbit `Alert`、`Textarea`，加上 main 新用的图标（`CheckCircleFilled`、`ClockCircleOutlined`、`QuestionCircleFilled`、`RightOutlined`、`RollbackOutlined`）。main 版本里这个文件的 antd 导入（`Alert`、`Input`）正是本批已替换的那两个；main 的新代码不用 antd 组件，记录用的是 `ReviewCard`、span 与图标。跟上之后（`9ed85463a`）tsc 通过，相关单测 68 个文件、1131 个测试通过（含 main 新加的 `CoordinatorQuestionRecord.test.tsx`），`--check-owners` 0/0。在它上面的最终轮刚开始重建三棵树，会话额度停掉了后台任务，协调者随即叫停这一轮（P4.3a 先落地，见下一节），所以这次跟上的结果都在 `e21fad172` 的最终轮里。

**补的用例**（`74517607b`）：决策卡片页新增「已结束的协调者问题」，两份记录：一份已回答（选了推荐项，附说明，已送达），一份由协调者撤回（附原因）；然后打开已回答那份的详情。两树同一份用例。这个用例没有单独试跑（写好的试跑脚本赶上会话额度停下，没有跑），第一次跑就是最终轮的决策卡片页两树。两树各 8 个环境通过；记录与详情的 16 张截图两树逐字节相同。记录卡片与详情是 main 新写的部分，只用 ReviewCard、span 与图标，不用本批替换的组件。trace 两树 8 个环境逐步相同。

### P4.3a 之后跟上（2026-10-09）

**为什么**：本批在 `a8df7eac6`（origin/main `945098b11`）上的最终轮已整轮跑完，全部通过，结果留作过程记录（`round-a8df7eac6`）。但 P4.3a 与本批改了同一批公共文件：与 P4.3a 的分支头干跑合并，5 个文件冲突；另有 23 个文件两边都改但能自动合并，包括 index.css、foundation.css，Alert、Card、Badge、Button、Input、Select、ConfirmDialog 这些公共组件，以及 ControlsFixture、controls 矩阵和 ProjectDoneCopyParityTests.swift。照原来的顺序，本批的最终轮跑完时 P4.3a 已经落地，本批得再合一次、再跑一整轮。协调者因此定下：P4.3a 先落地；本批暂停最终轮，在临时树里试合 P4.3a 的分支头，把冲突解法写成脚本；P4.3a 落地后按作业指导跟上（项目 tip 不在 origin/main 时，先 rebase 到项目 tip，再合并 origin/main），重放解法，整轮只跑一次。

**等待期间的试合**（都在 /mnt/data 的临时工作树里）：P4.3a 的分支头先后是 `de2426d9c`、`d9e720533`（它 rebase 到了 main `76d41066d`）、`e0d9fdf21`（它交证据时的头，含记录 `2026-10-09b.json` 与证据提交）。每个头都试合了一遍，冲突都是同样的 5 个文件，都由 [resolve-p43a.py](scripts/resolve-p43a.py) 解掉；不用 rerere、只用脚本，得到的 tree 逐字节相同。脚本按内容识别冲突块，不管哪一边是 ours，所以 merge 与 rebase 都能用：

| 文件 | 两边各自的改动 | 合并 |
| --- | --- | --- |
| `ui/Alert.tsx` | 本批：`type="info"` 的图标 `InfoCircleFilled`；P4.3a：同一行没有 info | 取本批的这一行。接口两边相同：`title`、`description`、`action`、`className`、`style`，都没有 `message`；`type` 合并后是 error/warning/info，P4.3a 只用 error/warning。tsc 通过，也就是没有调用点给 Orbit Alert 传 `message` |
| `ui/Overlay.css` | 本批：Close 层级的注释（`z-index: 10` 规则本身自动合并）；P4.3a：对话框页脚换行（`flex-wrap`、`gap: 0 8px`） | P4.3a 的页脚规则连同注释在前，本批 Close 的注释在后 |
| `ui/README.md` | Alert 那一行：本批多了 `type="info"` | 本批的行就是 P4.3a 的行加上 info，取本批的 |
| `ui-migration/playwright.config.mjs` | P0 矩阵的 `testIgnore`：本批加 `p43b*`，P4.3a 加 `p43a*` | 并集：两边共有的项照原顺序，各自的项排序后接在后面（`p43a*`、`p43b*`）。两边都没改 projects（八个环境）和其它入口；P4.3a 的 `p43a.config.mjs` 与本批的 `p43b.config.mjs`、`p43b-cards.config.mjs` 各自起服务 |
| `inventory-delta/README.md` | 记录表：两边都有 `2026-10-08b` 两行；本批加 `2026-10-09` 两行，P4.3a 加 `2026-10-09b` 两行 | 按记录名排序（08b、09、09b），每份记录的行在它的生成脚本那一行之前；哪边在前都得到同一个顺序 |

试合的树上，tsc 通过；相关单测 85 个文件通过（本批的 68 个、P4.3a 改过的 27 个与 ui 公共组件的测试，去重）；`--check-owners` 0 未归属、0 待定；三份记录 verify-record 都通过；OrbitKit swift 3502 个 0 失败（两批都改了 `ProjectDoneCopyParityTests.swift`，自动合并后通过）。index.css 两边新增的选择器没有重合（本批 65 个，P4.3a 51 个）；foundation.css 的合并结果与本批相同（P4.3a 的共用变量两边一样）。另外模拟了一遍跟上的流程（把 P4.3a 的落地模拟成 `--no-ff` 合到项目 tip，再 rebase、再合并 main），结果与「直接试合再合 main」的 tree 逐字节相同；在结果上撤回业务切换没有冲突。

**跟上**：P4.3a 07:57Z 落地，项目 tip `abc0a4cfa`（含 `e0d9fdf21`），尚未晋升进 main。
- 本分支底下原来带着 P4.3a 的 4 个共用提交（与 P4.3a 落地的提交 patch-id 相同）。rebase 从它们之上开始（`--onto abc0a4cfa 38754a416`），否则 git 会把它们再重放一遍：补丁已在项目 tip 里，但不在 upstream 参数里。脚本是 [follow-p43a.sh](scripts/follow-p43a.sh)。
- 本批 12 个提交 rebase 到 `abc0a4cfa`，停了 3 次：`Overlay.css`（公共组件提交）、`playwright.config.mjs`（用例提交）、`inventory-delta/README.md`（记录提交），都由 rerere 按试合时的解法重放。
- 再合并 origin/main：动手时已到 `4085437ff`（比协调者通知时的 `62b7009ca` 多了 OrbitKit 的 Swift 改动），无冲突。交付 `e21fad172`。

**跟上之后的核对**：
- tree 与试合的预计（试合树依次合并项目 tip 与 origin/main）逐字节相同，只差下一条的 3 个记录文件。
- 记录 `2026-10-09.json` 的名字不变，按新的父提交 `74517607b` 的审计重新生成。`build-record-09.py` 原先断言「排在前面的记录只剩这个测试文件未归属」；P4.3a 的 `2026-10-09b.json` 排在它后面，管着 main 带来的 3 个 Infrastructure 测试文件，排在前面的记录也会留下这 3 个。所以改成：拿掉本记录时，其余记录（前后都算）只剩这个文件未归属；记录表里这一行同步改写。
- `--check-owners` 0 未归属、0 待定（P6 42 个点，含 09b 的 3 个）。
- verify-record：`2026-10-08b` 读在前 5 份之后，`2026-10-09` 在前 6 份之后，`2026-10-09b` 在前 7 份之后，都通过；8 份记录合计 0 未归属、0 待定。两份生成脚本在交付上都能逐字节重新生成各自的记录。
- tsc 通过；相关单测 85 个文件、1498 个测试全部通过。

**这一轮重跑的检查**：整轮只跑一次，在 `e21fad172` 的三棵树与本任务的工作树上（参照 `40f79c5ab` 重建，起点 `5034a3e9f`）。中途被停三次（runner 的 OOM 停机、周额度、加内存规则），都停在第一步，队列从中断处接着跑（[过程记录](#过程记录)）：
- OrbitKit swift 套件：3550 个，0 失败；
- P4.3b 用例、决策卡片页：两树各 76、68 通过；
- P0 页面矩阵：参照、0 像素严格比较、交付各 101 通过；标准 P0：交付与起点各 36 个失败，两树相同，是 main 的基础漂移（[标准 P0 的基础漂移](#标准-p0-的基础漂移)）；
- P3.2 试点：两树各 81 通过；
- 合并检查：在 `e21fad172` 上 1 个失败，修正后在 `2fefd4747` 上 375 个文件、4891 个测试全部通过（[第 14 条](#14-workspaceview-里启动卡片的单测在宽屏上早读计划)）；相关单测 86 个文件、1517 个测试通过；
- overlays 与 overlays-app-frame 176、controls 32、choices 680，全部通过；
- P4.1 起点对照：两树各 96 通过；P4.2：两树都是 140 通过、同 5 个用例在八个环境失败（main 的 Infrastructure 页）；
- 比较与分类、探针、补充检查、清单复扫：见[结果](#结果)，`--check-owners` 0/0。

**交证据前再看 main**：按协调者收紧后的规则判断。最终轮之后 main 前进了两次，每次都只做干跑：
- `a74ecb43b`（含项目 tip `abc0a4cfa`）：与 `e21fad172` 干跑无冲突，带进 38 个文件，没有本批的文件与公共层（[checks/main-a74ecb43b-dry-run.txt](checks/main-a74ecb43b-dry-run.txt)）。
- `c71302304`（交证据前）：与交付 `2fefd4747` 干跑无冲突，main 有 60 个提交不在交付里，带进 404 个文件（[checks/main-c71302304-dry-run.txt](checks/main-c71302304-dry-run.txt)）。与本批 13 个提交共有的文件只有 `index.css`：main 改的是会话页的渐隐、输入框的触屏建议、回合脚注与机器卡片，本批改的是另外几段，没有共同的规则。没有 `ui/` 公共组件，也没有 Web 的 Toast 与弹层文件。main 新带来的 Web 单测里，提到本批组件的只有 `ProjectsPage.status.test.tsx` 原有的对 `ProjectDependencyGraph` 的 mock；本批的产品文件没有中文，main 新加的 `copyLanguage.test.ts` 管不到它们。
- 这属于第三种情况：既没有冲突，也没有改到本批的文件或依赖的公共层，只在证据里写明干跑结果与 main 的改动清单，由落地时的合并检查兜底。

## 提交

本批 12 个提交接在项目 tip `abc0a4cfa` 上（P4.3a 已落地，它的共用提交在基础里，见[与 P4.3a 的分工](#与-p43a-的分工)），再合并 origin/main，最后是一个只改测试的提交：

| 提交 | 内容 |
| --- | --- |
| `e0d63a1fc` | **feat：公共组件。**<br>Alert `type="info"`；对话框的 Close 在内容之上。README 写明两者。 |
| `4eba07d96` | **test：同提交对照用例。**<br>`p43b.browser.mjs`、决策卡片页 `p43b-cards.*`、固定数据、共用步骤与配置；P0 矩阵忽略 `p43b*.browser.mjs`。 |
| `3e5ee3120` | **fix：首屏只有一份样式表，按导入顺序。**<br>`vite.config.ts` 把首屏静态导入的 CSS 合成一个文件；`main.tsx` 先导入 Overlay、ReviewCard、highlight.js 主题；新单测 `firstPageStylesheet.test.ts`；卡片页照 main.tsx 的顺序导入。见[首屏样式表](#首屏样式表)。 |
| `c89cbb74d` | **fix：弹层取回焦点不滚动。**<br>`Overlay.tsx`；overlays 矩阵新增一个用例与它的固定数据；README。见[公共组件](#公共组件)。 |
| `4bd2f2f4a` | **feat：业务切换。**<br>17 个生产文件不再导入 antd（main `d91a0dd48` 对其中两个文件的改动，rebase 时移植到 Orbit 组件上；main `3ff232299` 给 `CoordinatorQuestionCard.tsx` 加的记录不用 antd 组件，rebase 时只合了 import）；index.css 去掉本批的 `.ant-*` 覆盖，改写到 Orbit 类名；两个单测改读共享类名与 combobox；P0 场景里全屏图的 `surface` 定位器；OrbitKit 的三个文案一致性测试把同样的句子锚到新标记上（[第 13 条](#13-orbitkit-的文案一致性测试读本批改过的标记)）。 |
| `846dd9c80` | **test**：从全屏图打开任务前先“Fit whole project in view”。画布重新打开时以上次展开的标记为中心，WebKit 桌面上任务的链接会落在画布外，两棵树都是这样。 |
| `81a6c5da8` | **test**：`fill()` 等字段停止移动再点击，见[开发中发现并修正的问题](#开发中发现并修正的问题)第 7 条。 |
| `9e00be043` | **test**：两张图的拖动（平移），以及任务图节点打开任务。 |
| `f9e1ebeef` | **test**：`settled()` 也等完被替换浮层的 rc-motion 类和 Base UI 的过渡标记，见第 11 条。 |
| `99ddbe1d7` | **test**：`d91a0dd48` 的新状态：会话里的启动卡片（720px 上限、只在截断时出现的 More 与 Read all、计划画成图或分层列出），项目页启动对话框的计划与全屏任务图，见[最终轮之后又跟了一次 main](#最终轮之后又跟了一次-main2026-10-09)。 |
| `74517607b` | **test**：`3ff232299` 的新状态：决策卡片页上两份已结束的协调者问题（一份已回答、一份由协调者撤回），以及已回答那份的详情，见[main 改了本批的 CoordinatorQuestionCard](#main-改了本批的-coordinatorquestioncardf8fdf50f0)。 |
| `144f6edd3` | **docs**：清单记录 `2026-10-09.json`（`firstPageStylesheet.test.ts` 归 P6）。 |
| `e21fad172` | 合并 origin/main `4085437ff`，无冲突，见[P4.3a 之后跟上](#p43a-之后跟上2026-10-09)。 |
| `2fefd4747` | **test**：main 的 `WorkspaceView.acceptanceConfirmationCard.test.tsx` 里，宽屏的启动卡片用例等计划的分层出现再读，断言不变，见[第 14 条](#14-workspaceview-里启动卡片的单测在宽屏上早读计划)。 |

之后的提交只增加本目录的证据。

- 撤回 `4bd2f2f4a` 就恢复本批的 AntD 界面，同提交参照树正是这样得到的。
- 两处修正放在业务切换之前，参照树也带着它们。单独看时：
  - `3e5ee3120` 之前的树里，首屏样式顺序与起点逐份相同，见[首屏样式表](#首屏样式表)；
  - `c89cbb74d` 只在弹层里有焦点的控件被移除时起作用。
- `e0d63a1fc` 单独存在时，没有业务页面用 `type="info"`；Close 的层级只在内容伸到它下面时才起作用，也就是没有标题行的对话框。全站只有本批的项目完成与启动项目两个对话框是这样（`title={null}`）。

## 公共组件

本批新增或修改的：

| 组件 | 改动 | 原因 |
| --- | --- | --- |
| `Alert`（`e0d63a1fc`） | `type="info"`：背景、边框与图标按 AntD 设计变量在两个主题下的计算值（明 `#f0f7ff` / `#adceff` / `#3370ff`，暗 `#14192c` / `#1d305b` / `#2e62dc`），图标 `InfoCircleFilled`。只有边框是新变量 `--orbit-alert-info-border`，背景与图标复用取值相同的 `--orbit-badge-info-bg`、`--orbit-control-primary` | 启动对话框在请求已不成立、或读不到确认时的说明（被替换的是 `Alert type="info"`） |
| 对话框的 Close（`Overlay.css`，`e0d63a1fc`） | `z-index: 10`，在弹层自己的内容之上 | 被替换的关闭键在弹层基准层级 +10。没有标题行的对话框，内容从顶上开始；其中定位过的内容（如 `position: relative` 的 alert）会盖住按钮 |
| 弹层取回焦点（`Overlay.tsx`，`c89cbb74d`） | 弹层容器取得焦点一律带 `preventScroll`，与 Overlay 自己的首次聚焦（`initialFocus`）相同；焦点去哪里不变 | 弹层里有焦点的控件消失时（卡片换掉自己的内容，如完成问句的 Not yet），Base UI 的 `restoreFocus: "popup"` 用不带参数的 `focus()` 把焦点交回弹层。Chromium 会把高于屏幕的对话框滚到弹层顶部：手机上完成对话框跳了约 100px，被替换的弹窗不动。WebKit 不报告这种移除，焦点留在 body，两树相同 |

`c89cbb74d` 的直接证据：
- overlays 矩阵新增用例「a dialog taller than the screen keeps its scroll when the control with focus gives way」：长对话框顶部的 Not yet 让位后，对话框视口的滚动位置不变。
- 负对照：只把 `Overlay.tsx` 换回修正前，Chromium 四个环境失败（`0 → 100`，手机 `0 → 108`），WebKit 四个环境照常通过；加上修正，八个环境都通过（[extra/overlays-gives-way-*.txt](extra/)）。
- 完成对话框的探针 [probe-done-scroll2](probes/)：Chromium 手机上按 Not yet 后，滚动位置在交付上从 108 变为 7，与参照相同；焦点仍交回弹层。

用到的 P4.3a 公共组件见[与 P4.3a 的分工](#与-p43a-的分工)。其余都是 P2/P3 已有的组件：Dialog、Drawer、Popover、Popconfirm、Tooltip、Select（`renderOption`、`matchTriggerWidth`）、Switch、NumberInput、Textarea（`autoSize`）、Button、Badge、Spinner。

## 首屏样式表

### 问题

页面规则（index.css）和 Orbit 组件规则同权重时，谁赢由样式表的先后决定。ui/README 的约定是「组件样式在 index.css 之后加载」：开发模式按导入顺序注入，确实如此；生产构建的顺序却来自 rolldown 的拆包。

- 入口与懒加载 chunk 共用的模块，会被拆进一个共用 chunk。依赖图（`TaskDependencyGraph`、`ProjectDependencyGraph`）和会话导出（`sessionExport`）都是懒加载的，后者静态引入 Transcript。
- Vite 先链接入口所依赖 chunk 的 CSS，最后才是入口自己的 CSS（index.css 在里面）。
- 起点上，这样的共用 chunk 只有 Transcript，它的 CSS 是 `Overlay.css`、`ReviewCard.css`、highlight.js 的 `github.css`。这三份排在 index.css 之前，其余组件样式都在 index.css 之后。
- 业务切换之后：
  - 懒加载的依赖图用上了 Orbit 的 Button、Dialog、Popover、Tooltip、Popconfirm、Alert、Spinner、Empty；
  - Transcript 一路引入的决策卡片用上了 Select、Switch、Textarea、NumberInput 和 typography。
  - 这些组件随之被拆进共用 chunk（`Floating`、`Spinner`、`Transcript`），样式全部排到了 index.css 之前，同权重的页面规则反过来赢。
- 第一轮正式对照（`round-047f91076`）看到的现象：P4.2 引擎页「More actions」的悬停与按下（`.re-action.re-more` 盖过 `.orbit-button-text:hover`），以及试点里的若干截图。P4.3a 的分支没有这个问题：它的懒加载面板用到的组件本来就在入口里。

### 修正（`3e5ee3120`）

- `vite.config.ts`：`build.rolldownOptions.output.codeSplitting.groups = [{ name: 'app', test: /\.css$/, tags: ['$initial'] }]`。首屏静态导入的全部 CSS 进同一个文件，顺序就是模块第一次被导入的顺序，与开发模式相同；只有懒加载 chunk 才用到的 CSS（React Flow，以及交付里的 `Empty.css`）仍随那个 chunk 加载。
- `main.tsx`：先导入 `ui/Overlay.css`、`ReviewCard.css`、`highlight.js/styles/github.css`，再导入 reset、index.css、foundation.css。这三份正是起点生产构建里排在 index.css 之前的那三份。
- 结果：起点与交付在「页面样式与组件样式谁先谁后」这一层逐份相同。这个顺序从此不再随拆包变化，P4.3a、P4.4、P5 之后再给懒加载模块加组件也不会改变它。
- `ui-migration/p43b-cards.tsx`（开发服务器上的卡片页）照 main.tsx 的顺序导入，与应用的生产顺序一致。
- ui/README「主题和样式」写明这个顺序；`Overlay.css` 是「组件样式在 index.css 之后」的例外。

### 核对

协调者 2026-10-09 要求补的四项，都在最终轮的提交上做（`e21fad172` 与它的起点、参照；交付 `2fefd4747` 只多一个 vitest 文件，构建与这几项都不读它；[extras.sh](scripts/extras.sh)，在 /mnt/data 的临时树里构建，正式树不动）。

**1. 首屏资源与体积**（[extra/bundle-compare.txt](extra/bundle-compare.txt)，逐个资源与 gzip 见 [bundle-compare.json](extra/bundle-compare.json)）。首屏 = 入口 HTML 链接与预加载的 JS、CSS：

| 构建 | 首屏 CSS 文件 | JS 字节 / gzip | CSS 字节 / gzip |
| --- | --- | --- | --- |
| 起点 `5034a3e9f` | 2（`Transcript-*.css` 6496 B，`index-*.css` 474666 B） | 3476868 / 1061158 | 481162 / 79404 |
| 起点只加样式表修正 `3e5ee3120`（本地提交 `a09e21db9`） | 1（`app-*.css`） | 3476911 / 1061190 | 481161 / 78878 |
| 参照 `40f79c5ab` | 1 | 3477011 / 1061233 | 481411 / 78916 |
| 交付 `e21fad172` | 1 | 3478394 / 1062179 | 482050 / 79005 |

- 起点 → 只加修正：CSS 少 1 个文件，内容相同（少 1 字节），gzip 少 526（一份文件压缩得更好）；JS 多 43 字节（gzip 32）：入口（+19）的预加载表换了文件名（`Transcript-*.css` 变成 `app-*.css`），入口与 Transcript 块（+24）各留下一处 Vite 去掉纯 CSS 块后的 `/* empty css */` 注释。
- 只加修正 → 参照：JS gzip +43，CSS gzip +38。来自参照与交付都带的本批公共组件改动：Alert info、Close 层级、弹层焦点（`Overlay.tsx` +125 字节，`Alert.tsx` +80，`Overlay.css` +205，`Alert.css` +185，`foundation.css` +76）。P4.3a 的公共组件改动这一轮已在起点里，所以这一段比上一轮小得多。
- 参照 → 交付（本批的业务切换）：JS gzip +946，CSS gzip +89。主要是 `ProjectCrossingsCard.tsx`（+1337 字节）、`OwnerConfirmationReopen.tsx`（+377）、首屏里 `ui/Overlay.tsx` 的部分（+277），以及 `index.css`（+2038，本批改写到 Orbit 类名的规则）。这一轮 Skeleton、Typography 等 P4.3a 的组件两树都已在首屏，所以比上一轮小。AntD 本身仍在首屏（P6 才移除），所以这一批只增不减。
- 两边首屏 JS 的分块不同：rolldown 把入口与懒加载块共用的模块拆成共用块，起点是 `taskDependencyGraph`、`projectDependencyGraph`、`popover` 几块，交付是 `Floating`、`projectDependencyGraph`。总量见上表。

**2. 先后相反的 14 对样式表**（[extra/component-order-ties.txt](extra/component-order-ties.txt)）。

- 页面样式与组件样式的先后，起点与交付逐份相同：起点排在 index.css 之前的只有 Overlay、ReviewCard、github 三份，交付按 `main.tsx` 把这三份放在 reset 与 index.css 之前，其余组件样式都在 index.css 之后（`firstPageStylesheet.test.ts` 钉住）。
- 两边都链接、但先后相反的，是 14 对**组件样式表之间**的先后：Badge、Floating、Avatar、Select、Segmented、ChoiceControls、Card、Skeleton 与 NumberInput 等（单子见上面的文件；上一轮是 19 对，P4.3a 的组件进了起点，先后关系跟着变了）。
- 静态检查 [order-ties2.py](scripts/order-ties2.py)：一对规则只有同时满足三条，先后才可能改变计算值——同权重（`!important` 只与 `!important` 比）、设了重叠的属性（简写与逻辑方向展开）、两条规则的主体可能是同一个元素（共享类名，或 `src/web/src` 的 JSX 里有元素同时带两边的类，或主体不带类名）。
- 结果：这 9 份样式表之间 9424 对规则，2685 对同权重，满足全部三条的 1 对：`.orbit-menu-icon > *` 对 `.orbit-number-input-field` 的 `min-width`（上一轮的 4 对之一）。前者主体不带类名，所以列出来逐条读：`.orbit-menu-icon` 只在 `Menu.tsx` 里包住菜单项的图标（`<span className="orbit-menu-icon" aria-hidden>{item.icon}</span>`），它的子元素是图标，不会是数字框的输入区。**结论：14 对的先后不改变任何元素的计算值。**

**3. 懒加载的样式完好**（[probe-lazy-styles](probes/)，四个环境：Chromium 明色桌面、暗色手机，WebKit 明色手机、暗色桌面）。

- 项目图、项目图为空、任务图三种状态，在参照与交付上读出各自加载了哪些样式表，以及画布、节点、边、工具栏、空状态等元素的计算样式。
- 12 个状态中 9 个逐项相同；2 个（WebKit 项目图为空）只差行高 `22px` 对 `22.000019px`，是全站 CSS 压缩带来的数值精度，与 P3.2、P4.2 相同，截图不受影响；1 个（WebKit 明色手机的任务图）连线的外框那一次是参照 86×32、交付 85×32，两树各重跑三次都是 86×32，是运行间起伏（[probes/lazy-rerun/](probes/lazy-rerun/)）。
- 交付上 WebKit 暗色桌面那一次还报了一个应用未处理的错误（探针的测量已全部做完、记下，之后的「没有未处理错误」检查失败）。它的错误上下文随后被下一个探针清空的输出目录带走了，所以不知道是什么错误；把这个环境在交付上重跑 13 次、参照上 5 次，都没有再出现。
- 两树加载的样式表相同：首屏的 `app.css` 与懒加载块的 `TaskDependencyGraph.css`（React Flow）。上一轮交付的项目图多加载一份 `ProjectDependencyGraph.css`（Orbit `Empty` 的样式）；这一轮 P4.3a 的 `Empty` 已在起点的首屏里，两树都随首屏带上。
- 会话导出（`sessionExport`，懒加载，导出的文件自带内联样式）：两树导出同一段会话（含退回卡），正文在明暗两种主题下逐字节相同，内联样式相同；把导出的文件在八个环境里截图，八张都逐字节相同（[extra/export/compare.json](extra/export/compare.json)）。请求卡 `ReviewRequestedCard` 在导出里两树都抛错（[业务决策卡片](#业务决策卡片)）。

**4. `firstPageStylesheet.test.ts` 的两个负对照**（[extra/stylesheet-test-negatives.txt](extra/stylesheet-test-negatives.txt)）：

- 交付原样：通过。
- 对照 A，`vite.config.ts` 去掉 `codeSplitting.groups` 那一行：失败，`AssertionError: expected [ Array(4) ] to have a length of 1 but got 4`（首屏链接回到 4 份样式表）。
- 对照 B，`main.tsx` 去掉先导入的 Overlay、ReviewCard、github 三行：失败，`AssertionError: expected [ 'antd/dist/reset.css', …(5) ] to deeply equal [ 'components/ui/Overlay.css', …(5) ]`（首屏样式表的头一份变成 reset）。

**另外**：`c89cbb74d` 的负对照。只把 `Overlay.tsx` 换回修正前，overlays 新用例在 Chromium 四个环境失败（`Expected: 0`，`Received: 100`/`108`），WebKit 四个环境通过；加上修正，八个环境都通过（[extra/overlays-gives-way-without-fix.txt](extra/overlays-gives-way-without-fix.txt)、[-with-fix.txt](extra/overlays-gives-way-with-fix.txt)）。

## 业务切换

| 文件 | 原 AntD | 现在 |
| --- | --- | --- |
| `TaskDependencyGraph` | Modal、Popconfirm、Tooltip | 全屏图 Dialog（关闭即卸载，同原 `destroyOnClose`）；移除前置的 Popconfirm，触发器仍是原按钮，移除进行中时禁用；全屏按钮的 Tooltip |
| `ProjectDependencyGraph` | Alert、Button、Empty、Modal、Popover、Spin、Tooltip | 全屏图 Dialog；motif 的任务样例 Popover（点开，下方）；读取中 Spinner；读取失败 Alert（error，带 Retry 按钮）；没有任务时 Empty；超出一次读取上限时 Alert（warning）；全屏按钮的 Tooltip。main `d91a0dd48` 加的启动卡片用法（卡片里竖排的嵌入图 `embedded`，只开全屏的 `fullScreenOnly` 与它的 `onClose`）用同一套组件 |
| `ProjectTasksGraph` | `Typography.Title level={4}` | `<h4 class="orbit-typography pdg-section-title">` |
| `DecisionRail` | `Typography.Text`（含 `type="warning"`） | `orbit-typography`、`orbit-typography-warning` |
| `ProjectCrossingsCard` | Alert、Button、Card、Skeleton、Space、Tag、Typography | Card（small，extra 写待答数）、Skeleton、Alert、Button、Badge；文字用 `orbit-typography`；可复制的 id 是 code 加复制按钮（提示 Copy，复制后 3 秒内是对勾与 Copied，同被替换的 copyable）；按钮行用与 Space 相同的行内弹性布局与 8px 间距 |
| `StartProjectCard` | Alert、Input.TextArea、InputNumber、Modal、Select、Spin、Switch | Switch、Select（两条线路各带说明与分支名）、Textarea、NumberInput、Spinner、Alert（info/error）；宽屏是没有标题行的 Dialog，手机仍是底部 Drawer。main `d91a0dd48` 的 720px 上限、只在截断时画的 More 与 Read all、懒加载的计划图（`StartPlanGraph`，画的是上一行迁移后的依赖图）原样保留 |
| `ProjectSettlementCard` | Alert、Input.TextArea、Modal | Alert、Textarea；完成对话框是没有标题行的 Dialog，打开过就保持挂载（同原 `destroyOnClose={false}`：Not yet 下写了一半的说明，对话框回来时还在） |
| `OwnerConfirmationReopen` | Alert、Button、Modal、Typography | 与任务面板自己的 Reopen 问句相同（P3.2）：Dialog 带 Back/Reopen 页脚，段落用 `tdp-reopen-paragraph`，拒绝原因是 Alert |
| `CoordinatorQuestionCard`、`OwnerConfirmationReview` | Input.TextArea（及 Alert） | Textarea（`autoSize` 2–8 行，最多 2000 字）、Alert |
| `ConfirmationReviewTurnCards` | Button | Button |
| `AcceptanceConfirmationCard`、`CriteriaChangeCard`、`CriteriaDecisionCard`、`EvidenceDecisionCard`、`OwnerConfirmationCard`、`ProjectPromotionCard` | Alert | Alert（`message` 改为 `title`） |

查询、按键、请求体与路由都不变。React Flow、dagre、布局与视图规划的代码没有动。

index.css：

- 去掉本批的 11 行 `.ant-*` 规则，改写到 Orbit 类名。全屏图原来改写 AntD 弹窗的内部类，现在改写 Dialog 自己的：桌面距顶 24px（对话框默认 100px）、宽度不设上限；手机铺满视口，顶部安全区内留 12px，标题给 Close 让出 40px。
- 卡片在 Orbit 控件上的边距与字体规则，带上控件的类名（组件样式在 index.css 之后加载，同权重时组件赢）。
- 图里的链接（标记、框的标题、motif 的样例）写明不加下划线。原来是 AntD 根节点的链接规则替它们做的，而全屏图与 motif 浮层渲染在 AntD 根节点之外。
- 完成对话框的 `.project-done-dialog .ant-modal-content { padding: 0 }` 在 antd 6 下从未生效（面板是 `.ant-modal-container`），去掉而不是照搬：对话框保持它一直画着的内边距。

## 依赖图

- **展开**：motif 点开列出它的几个任务，失败的在前，每个都能打开；运行块展开为它的各步；已完成块展开为它的任务；全屏按钮打开同一张图。全屏里的 motif 浮层，Escape 一次只关一层。
- **拖动**：图上的东西都不能拖（`nodesDraggable={false}`），拖动只平移画布。项目图在页面和全屏里都能平移。任务图在任务面板里是竖排的窄图，把拖动留给页面（`canPan`），全屏可以平移。
- **导航**：从项目图全屏的任务链接打开任务，任务面板盖在项目页上，全屏让开；任务图全屏里点节点，打开那个任务。
- **操作**：移除直接前置先问一句，Cancel 保留，Remove 发出 DELETE；全屏按钮在桌面悬停时有提示（手机没有悬停）。
- **读取状态**：读取中、失败（带 Retry，重试后出图）、没有任务、超出一次读取的上限（提示任务列表里有全部任务）。

以上每一步都在两棵树的八个环境里走过（[P4.3b 用例](#p43b-用例与决策卡片页逐步语义)），trace 逐步比较。

## 业务决策卡片

项目页上的：跨项目卡片（读取中、列表、回答被拒、请求拒绝前先问、读取失败）、协调者的问题（用自己的话回答，被拒）、合并进 main（被拒）、完成问句（Not yet 带说明被拒、记为完成被拒、关闭后重新打开是全新的）、所有者自己的启动（设置、线路菜单、合并检查、被拒，读取中与读不到；计划画成任务图，或分层列出并全屏打开任务图）。

会话对话里画的（WorkspaceView 是 P5 的页面，卡片本身属本批）：放在一个专用页面 `ui-migration/p43b-cards.html` 上，用真实的带数据组件和 main.tsx 给应用的那套 Provider，经固定 REST 数据读写。证据判定（被拒，然后已过期）、所有者确认（复核的问题用自己的话回答，被拒）、标准判定（被拒）、决策条里等读者处理的行、两张复核回合卡（从请求打开运行会话）、回执上的 Reopen task（问、被拒、Back）、请求已不成立时的启动对话框，以及会话里的启动卡片（宽窗口下 720px 上限、只在截断时出现的 More 与 Read all、计划画成任务图或分层列出、手机上全屏打开计划图再按 Escape）。

每张卡片按下的请求、请求体、出现的 alert 与通知，两棵树逐步比较（[trace](#p43b-用例与决策卡片页逐步语义)）。

会话导出（`sessionExport`，懒加载）只在导出的文件里画会话回合，本批的卡片里只有两张复核回合卡会出现在导出中：
- 退回卡 `SentBackByReviewerCard` 没有用到本批迁移的组件。导出的文件在两棵树上逐字节相同的正文与样式下截图，八个环境都逐字节相同（见[首屏样式表 · 核对](#核对)）。
- 请求卡 `ReviewRequestedCard` 在导出的静态渲染里调用 `useNavigate()`，没有 Router，导出直接抛错；参照树上（按钮还是 AntD）一样抛错，是迁移前就有的缺陷。已另建任务 [会话导出遇到复核请求回合时失败](orbit-task:34ccjgcldZWdgdrAAm3uV)，不在本批修。

## 单测

- 本批改了两个单测，断言不变：
  - `ProjectTasksGraph.test`：标题规则从 `.pdg-section-title.ant-typography` 改读 `.pdg-section-title.orbit-typography`；
  - `StartProjectCard.test`：线路选择器的显示值从 `.ant-select-content` 的 title 改读 `role=combobox` 的文字；不可编辑时开关的禁用改读 `aria-disabled`（Orbit Switch 不是 button）。
- 新增 `firstPageStylesheet.test.ts`：在内存里做一次生产构建（`write: false`），由插件读出每个 chunk 的 CSS 模块，核对首屏只链接一份样式表、前六份依次是 Overlay、ReviewCard、github、reset、index.css、foundation，懒加载与入口共用的组件样式都在 index.css 之后，React Flow 的样式仍随懒加载 chunk。负对照见[首屏样式表 · 核对](#核对)。
- 相关单测 85 个文件，列表在 [checks/related-tests.txt](checks/related-tests.txt)：
  - 本批的 68 个：依赖图、各决策卡片、决策条、任务面板、项目页与 WorkspaceView 中渲染这些卡片的用例，含协调者要求 P4.3b 改 ProjectPromotionCard 时要跑的 `ProjectBlockers.test`，加上新的样式表单测。main 改过本批文件的单测都在其中：`d91a0dd48` 的 `ProjectDependencyGraph.test`、`StartProjectCard.test`，`3ff232299` 新加的 `CoordinatorQuestionRecord.test`；
  - 跟上 P4.3a 后加上 P4.3a 改过的 26 个单测（其中 14 个不在上面）与 `components/ui/` 的公共组件单测（再多 3 个）：两批的公共组件改动在这里相遇。
- OrbitKit 的 swift 套件（它的文案一致性测试读本批改过的 Web 源文件）在交付上跑，见[第 13 条](#13-orbitkit-的文案一致性测试读本批改过的标记)。

结果（[runs/c-merge.txt](runs/c-merge.txt)、[runs/u-related.txt](runs/u-related.txt)）：
- 合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web`，在本任务工作树（交付 `2fefd4747`，根分区 NVMe）：构建通过，375 个测试文件、4891 个测试全部通过。之前在 `e21fad172` 上是 1 个失败（[第 14 条](#14-workspaceview-里启动卡片的单测在宽屏上早读计划)）。
- 相关单测（`2fefd4747`）：86 个文件、1517 个测试全部通过。
- OrbitKit swift 套件：交付 `e21fad172` 3550 个用例 0 失败，5 个跳过（Linux 上总是跳过的 PerfBaselineTests），[swift/](swift/)。两批都改过的 `ProjectDoneCopyParityTests.swift` 在其中。

## 对照方法

沿用 P3.1/P3.2/P4.1/P4.2 的同提交对照。

- **三棵树**（都在 `/mnt/data/tmp/34blYpxEcHMAf4oafuC2W/`，[make-trees.sh](scripts/make-trees.sh)）：
  - 参照树：交付 `e21fad172` 只撤回业务切换 `4bd2f2f4a`（本地提交 `40f79c5ab`，没有推送），在独立的稀疏工作树里。本批界面是 AntD，公共组件、两处修正、P4.3b 用例和其它一切都与交付相同。
  - 起点树：项目 tip `abc0a4cfa`（含 P4.3a）合并 origin/main `4085437ff`（本地提交 `5034a3e9f`，不含本批），用来检查公共组件改动与两处修正对已迁移页面的影响（P4.1、P4.2 用例，标准 P0）。
  - 交付树：交付自己的完整检出。合并检查与相关单测按协调者的安排在本任务的工作树里跑（根分区 NVMe）。
- **磁盘**：树、TMPDIR 与全部运行产物都在 /mnt/data；每一步开始前按 `df -BM` 看根分区，低于 2 GB 就停下。
- **内存**（协调者 2026-10-09 的规则：08:30Z 那次 runner 停机，是内核 OOM 杀掉了 runner 服务里的一个 chrome，主机只有 14 GB）：步骤一个接一个跑，浏览器套件之间、浏览器套件与 vitest 之间都不并行；Playwright 一律 1 个 worker（各配置都沿用 P0 基线的 `workers: 1`）；每个重步骤开始前等到 MemAvailable 至少 3 GB（[memgate.sh](scripts/memgate.sh)），每步日志记下开始与结束时的可用内存；协调者随后（约 11:00Z）又要求每个重步骤放进独立的 systemd scope（`MemoryMax=6G`、`oom_score_adj` 500），这样内存不够时被杀的是测试、不是 runner（runner 的单元是 `OOMPolicy=stop`）：从合并检查的重跑起每一步都这样跑（[memgate.sh](scripts/memgate.sh) 的 `scoped`），每步日志开头记下进程所在的 cgroup（`run-*.scope`）。在那之前跑完的 P4.3b 用例、决策卡片页、P0 矩阵、试点与组件矩阵，是在 runner 的单元里、按上面的规则跑的。合并检查第一次（`e21fad172`）跑时误加了 `VITEST_MAX_WORKERS=4`：web 的 test 脚本本来就是 `--maxWorkers=2`，环境变量反而把它提到 4；重跑（`2fefd4747`）按原样。
- **构建与环境**：
  - 三棵树各自 `npm run build`（`tsc -b && vite build`），再 `vite preview`；决策卡片页用开发服务器（它是 ui-migration 下的独立入口）。
  - Playwright 与 P0 相同的浏览器、字体与 `environment.mjs` 校验；DPR 1、en-US/UTC、固定时间与固定 REST 数据；reducedMotion=reduce。
  - 八个环境 = Chromium/WebKit × 明/暗 × 桌面 1280×900 / 手机 390×844。
  - 每次运行在独立网络命名空间里，固定端口互不干扰；正式运行一次只跑一个。
- **脚本**：最终轮由 [final-chain.sh](scripts/final-chain.sh) 一次跑完：先在交付上跑 OrbitKit 的 swift 套件、同时建三棵树，再跑正式运行（[formal.sh](scripts/formal.sh)），然后是比较与分类（[analyze.sh](scripts/analyze.sh)）、探针（[probes.sh](scripts/probes.sh)）、协调者 2026-10-09 要求补的检查（[extras.sh](scripts/extras.sh)）和清单（[final-audit.sh](scripts/final-audit.sh)）。整条链每一段都能从中断处接着跑（runner 重启或额度停会停掉后台任务）：swift 与三棵树记下已完成的提交就跳过，正式运行按步骤（日志末尾有退出码就跳过，没有就清空这一步的产物从头跑），比较按运行日志是否变过，探针按每个探针与树，补充检查按每一部分。本目录只收引用的副本（[collect.sh](scripts/collect.sh)），原始运行留在 /mnt/data。

对照内容：

- **P4.3b 用例**（[p43b.browser.mjs](../../../../src/web/ui-migration/p43b.browser.mjs)，生产构建）：10 个用例 × 8 个环境，覆盖 P0 矩阵走不到的本批状态。
  - 定位器是角色、可访问名称、标签和页面自己的类名，同一份文件驱动两棵树。对话框、选择器、数字框、开关、卡片的外框用两边的类名并列（如 `.ant-modal-container, .orbit-overlay`），只用于样式取值。
  - 每一步记录 trace：地址、焦点、打开的对话框与浮层（按文字）、alert、通知区文字、该步发出的请求；图的步骤另记几何（条带、每个标记、缩放工具栏、超出条带底边的距离、被工具栏盖住的标记）和拖动前后的视图变换。
- **决策卡片页**（[p43b-cards.browser.mjs](../../../../src/web/ui-migration/p43b-cards.browser.mjs)，开发服务器）：8 个用例 × 8 个环境，记录同样的 trace。
- **P0 页面矩阵**：用 P3.2 的 [p32-reference.config.mjs](../p3.2/p32-reference.config.mjs)。参照树写出截图；交付树先按 `maxDiffPixels: 0` 对参照截图比较一次，再写出自己的截图供逐张分类。另外在交付树和起点树上各跑一次标准 P0 回归（对照 P0.2 原图和漂移层、已接受层）。
- **P3.2 试点**（任务详情，含任务依赖图与它的全屏），在参照与交付上各跑一次。
- **起点对照**：P4.1、P4.2 用例在起点与交付上各跑一次。
- **组件矩阵**：overlays 与 overlays-app-frame（`overlays*.browser.mjs`：Dialog 的 Close、新的「控件让位」用例，以及先落地的 WebKit 滚动锁修复的 app-frame 用例）、controls（Alert 与 P4.3a 的公共组件）、choices（P2.2 的选择器；P4.3a 也跑它，两批的公共组件改动在这里相遇）。
- **分类**：逐字节相同 / 抗锯齿级（每个差异像素每通道 ≤2）/ 超出。超出的逐张说明，并用 [beyond-clusters.py](scripts/beyond-clusters.py) 把 >2 级的像素聚成区域。各脚本的分工：
  - [p3.2/compare_runs.py](../p3.2/compare_runs.py) 比较截图、计算样式与 trace；
  - [p4.1/summarize.py](../p4.1/summarize.py) 分类；
  - [trace-semantics.py](scripts/trace-semantics.py) 逐步比较 trace 的语义字段（地址、请求、通知、alert、对话框与浮层的文字、拖动是否平移），焦点另行计数；
  - [graph-geometry.py](scripts/graph-geometry.py) 读出 639/641/1280px 的图几何，与 P0.2 的记录并列。

## 开发中发现并修正的问题

除第 13 条（OrbitKit 的 swift 套件）外，都在同提交对照（试跑或正式轮次）里发现，修正随提交 rebase 到了现在的基础上。1–8 由上一会话发现，9–13 由本会话发现。

### 1. 对话框里的行高

- **现象**：完成、启动两个对话框和全屏图里，12–13px 的文字行距比参照大。
- **原因**：被替换的弹窗行高是无单位的 1.5714，里面别的字号的文字按自己的字号成比例；Orbit Dialog 的外壳是 22px（P3.2 起的约定，外壳保持 22px，迁移的对话框自己选择）。没有自己行高的小字号文字继承了 22px。
- **修正**：这三个对话框按 P3.2 Reopen 问句的做法，在业务类上写回 `line-height: 1.5714285714285714`（`.project-done-dialog`、`.start-card-dialog`、`.tdg-modal`）。回执上的 Reopen task 直接沿用 P3.2 的 `.tdp-reopen-dialog`。

### 2. 没有标题行的对话框：Close 被盖住

- **现象**：启动对话框在请求已不成立或读不到时，只有一条 Alert（info 或 error），Close 被它盖住。
- **原因**：完成、启动两个对话框没有自己的标题（卡片头就是标题），内容从顶上开始；Alert 是 `position: relative`，后画，盖在 Close 上。被替换的关闭键在弹层基准层级 +10。
- **修正**：公共 `Overlay.css` 的 Close 加 `z-index: 10`（`e0d63a1fc`）。有标题行的对话框，内容不会伸到 Close 下面，所以不受影响（P4.1、P4.2 用例与 P3.2 试点、overlays 矩阵都在对照里）。

### 3. 图里的链接出现下划线

- **现象**：全屏图里任务标记的标题、motif 浮层里的样例有下划线，页面上的图没有。
- **原因**：AntD 在自己的根节点下注入 `:where(.css-…) a { text-decoration: none }`。页面上的图在 AntD 根节点里，所以没有下划线；Orbit 的对话框与浮层渲染在 AntD 根节点之外。
- **修正**：`.pdg-task-main`、`.pdg-group-header`、`.pdg-fold-sample` 自己写明 `text-decoration: none`。
- 最终基础上，手机上启动面板里的计划图（main `d91a0dd48` 新加，面板是 Orbit 的 Drawer）也是这样：参照有下划线，交付没有，见[P4.3b 用例：截图](#p43b-用例截图)。

### 4. 手机上的合并检查输入框

- **现象**：手机上启动卡片的合并检查输入框是 12px 等宽字，参照是 16px 等宽字。
- **原因**：手机上全站把可聚焦的输入框抬到 16px（iOS 聚焦小于 16px 的输入框会放大整页）。参照里 `textarea.ant-input`（`(0,1,1)`）高于 `.start-card-mono`（`(0,1,0)`），所以是 16px；迁移后为了赢过组件样式，等宽规则带上了组件类，变成 `(0,2,0)`，反过来盖过了 16px。
- **修正**：`@media (max-width: 960px)` 下 `.start-card-mono.orbit-textarea` 保持 16px，仍是等宽字。

### 5. 同权重的页面规则在迁移后输给组件

- **现象**：卡片里错误提示的边距、协调者问题输入框的边距、启动卡片合并检查框的等宽字体与字号与参照不同。
- **原因**：AntD 的样式插在 head 最前，Orbit 组件样式在 index.css 之后；同权重时，迁移前页面规则赢，迁移后组件规则赢。
- **修正**：这些规则带上组件类（`.settlement-card-error.orbit-alert`、`.coordinator-question-free.orbit-textarea` 等，见[业务切换](#业务切换)）。P4.3a 的静态检查没有再找到别的（见[与 P4.3a 的分工](#与-p43a-的分工)）。

### 6. Typography 文字的字体与字号

- **现象**：决策条与跨项目卡片里，在 12px 父元素中的文字比参照小。
- **原因**：被替换的 Typography 根节点自己设了字体和 14px，不继承父元素。
- **修正**：P4.3a 的共用提交在 `Typography.css` 里补上（P4.3a 落地的 `76282079a`，现在在本批的基础里）。P4.3a 先告知了这个修正，本批在它之前没有改 `Typography.css`。

### 7. 用例的时序：重试点击时的滚动

- **现象**：WebKit 明色桌面上，`p43b-start-settings` 的参照截图里，启动对话框滚到了底，交付没有。逐步探针复现不出，换一次运行又会出现。
- **机制**（[probe-start-scroll3](probes/probe-start-scroll3-ref.txt)，带 Playwright 自己的动作日志；[probe-check-motion](probes/probe-check-motion-ref.txt)）：
  1. 被替换的文本框不理会减少动态效果，出现时 `min-height` 从 32px 过渡到 29px，历时约 0.3 秒。Orbit 文本框在减少动态效果下没有过渡。
  2. Playwright 点击正在移动的元素时会重试，从第二次起依次把目标滚到底边、中间、顶边（`scrollIntoView` 的 end/center/start）再点。
  3. 参照这一侧，合并检查输入框的点击重试了几次，就看最后一次是哪种对齐：恰好是“顶边”时，对话框滚到最底。
- **修正**：用例的 `fill()` 先等字段停止移动（页面上没有进行中的动画）再点击（`81a6c5da8`）。这是取样时刻的问题，产品里没有这种滚动。

### 8. 用例：拖动的起点与时机

- 刚打开的全屏图，参照的弹窗还在放大动画里（不理会减少动态效果），画布等尺寸稳定后才放置视图。拖动若早于此，视图随后又被放回原处。用例改为等动画结束、视图连续十帧不动后再拖（`9e00be043`）。
- WebKit 手机上，`elementFromPoint` 认为是画布的一点，按下时落在左上角的计数面板上。用例改为找四周 24px 都是画布的点，并在按下前确认鼠标下的正是画布。

### 9. 首屏样式表的顺序随拆包变化

- **现象**：第一轮正式对照（`round-047f91076`）的起点对照里，P4.2 引擎页「More actions」的悬停与按下不再变色，试点也有若干截图不同。
- **原因与修正**：见[首屏样式表](#首屏样式表)（`3e5ee3120`）。

### 10. 弹层取回焦点时滚动

- **现象**：Chromium 手机上，完成问句按 Not yet 后，完成对话框跳到视口顶部，比参照高约 100px（`p43b-done-not-yet`、`-refused` 两张，`round-d1a3f6f7b`）。
- **机制**（[probe-done-scroll2](probes/)，记录每次 `focus()` 与滚动）：Not yet 被换成说明框，有焦点的按钮被移除。Chromium 报告这次移除，Base UI 的 `restoreFocus: "popup"` 随即用不带参数的 `focus()` 聚焦弹层，对话框视口的 `scrollTop` 从 7 跳到 108。参照的弹窗不取回焦点，焦点落到 body，停在 7。WebKit 不报告这种移除，两树都停在 7。
- **修正**：弹层容器取得焦点一律不滚动（`c89cbb74d`，见[公共组件](#公共组件)），焦点照旧交回弹层。

### 11. 用例取样落在被替换浮层的准备阶段

- **现象**：`round-d1a3f6f7b` 的 P4.3b 用例逐步比较里，有些步骤参照一侧没有记到刚打开的浮层，交付一侧记到了：motif 的样例、移除前置的问句、悬停提示、重新打开的完成对话框。截图里两边都有这些浮层。
- **机制**：
  - rc-motion 打开浮层时，先进入准备阶段：动画处于 paused、透明度为 0，类名带 `-appear`/`-enter`；
  - 旧的 `settled()` 只等 running 的动画，于是在这一刻就放行；
  - `observe()` 把透明度为 0 的元素算作不可见；
  - 截图前的 `capture()` 另外会等透明度到 1，所以截图不受影响。
- **修正**：`settled()` 也等到页面上没有 rc-motion 的 `-appear`/`-enter`/`-leave` 类、没有 Base UI 的 `data-starting-style`/`data-ending-style`（`f9e1ebeef`）。改前改后的取样对照见[结果 · 取样对照](#取样对照)。

### 12. 用例取样早于启动卡片决定计划的读法

- **现象**：为 `d91a0dd48` 补的用例试跑时，桌面上会话里的启动卡片记成了「分层列出」，截图里也是分层，用例末尾却又断言图已画出并且通过。
- **机制**：计划图在懒加载的 `StartPlanGraph` 里。它加载并量过卡片宽度之前，分层列表先占位，加载后才决定画图还是继续分层。第一次读取恰好落在占位的这一刻。
- **修正**：读取前先等到二者之一：`StartPlanGraph` 的外框里出现分层列表，或者画出了图的节点（`99ddbe1d7`）。这是取样时刻的问题，两树相同，产品里的结果不变。

### 13. OrbitKit 的文案一致性测试读本批改过的标记

- **现象**：最终轮在交付 `222017b25` 上跑 OrbitKit 的 swift 套件（`swift:6.1` 容器，即 main 上 ci.yml「Swift core」的跑法），5 个用例 16 处失败：`ProjectCrossingsCardCopyParityTests` 的三个用例、`CriteriaChangeCardCopyParityTests.testTheMarksAndTheOrderOfTheRowsAreTheWebs`、`ProjectDoneCopyParityTests.testTheWordsTheCopyObjectSpellsInlineAreThisClients`。同样的命令在 main `945098b11` 上 3475 个用例 0 失败（[swift/](swift/)）。
- **原因**：这些测试逐字读取 Web 源文件，把每句文案锚在周围的标记上，如 `<Typography.Text type="secondary">{MOVE_TASK_SUBJECT_LABEL}: </Typography.Text>`、`message="Crossings could not be loaded"`。业务切换不改文案，但标记换成了跨项目卡片自己的 `Text`/`Code` 与 Alert 的 `title`。Web 的合并检查不跑 swift 套件，所以看不到。
- **修正**：在业务切换提交里，把同样的句子锚到新标记上（`<Text muted>{…}: </Text>`、`<Code>{…}</Code>`、`title="…"` 等），文案逐字不变（`4bd2f2f4a`）。之后 swift 套件在交付上 0 失败：`a8df7eac6` 上 3475 个用例，跟上 P4.3a 与 main 之后的 `e21fad172` 上 3550 个。P4.3a 的分支上有同类情形（它改的 `TaskAttributionCard`、`ProjectRunSettings`、`ProjectReadyToRun` 正是另外三个 CopyParity 测试锚的文件），已告知协调者。

### 14. WorkspaceView 里启动卡片的单测在宽屏上早读计划

- **现象**：最终轮在 `e21fad172` 上的合并检查有 1 个失败：main 的 `WorkspaceView.acceptanceConfirmationCard.test.tsx` 里「starts the project with the settings on the card and leaves its record (narrow: false)」，期望计划分两层（`1Athe sealNow`、`2Bthe card`），读到的是空列表。同一个用例的手机版通过。这个文件单独跑，交付上 10 次红 4 次，起点上 10 次 0 次（[repeat-acceptance/](runs/reruns/repeat-acceptance/)）。
- **原因**：启动卡片自己读项目的依赖图，应答在卡片画出之后才到。宽屏上这个用例在卡片出现时就读计划，中间不等别的。探针（只在 /mnt/data 的临时副本里）8 次里有 3 次看到：读的那一刻图的请求已经发出，计划里只有「View tasks ›」链接，分层列表 21 ms 后出现，内容正确。业务切换没有动这条数据路径（`StartProjectCard.tsx` 改动的 65 行里没有查询、分层、Suspense 或懒加载），换成 Orbit 组件后卡片画得更早，于是赶在应答之前。产品里看到的都一样：图一到，计划就画出来。
- **修正**：在 `e21fad172` 之上加一个只改测试的提交 `2fefd4747`：断言不变，改为等它成立（用例自己的 `waitForUi`，8 s 窗口），与这个用例的其它读取相同。之后这个文件在交付上 20 次全过（[repeat-acceptance-fixed/](runs/reruns/repeat-acceptance-fixed/)），它也加进了相关单测（86 个文件）。合并检查与相关单测在 `2fefd4747` 上重跑，结果见[结果](#结果)。浏览器上的对照仍在 `e21fad172` 的三棵树上：`2fefd4747` 只改这一个 vitest 文件，浏览器运行不读它。

## 结果

全部在 `e21fad172` 上跑（参照 `40f79c5ab`，起点 `5034a3e9f`），运行日志见 [runs/](runs/)，比较见 [compare/](compare/)。

| 运行 | 树 | 结果 | 日志 |
| --- | --- | --- | --- |
| OrbitKit swift 套件（`swift:6.1`） | 交付 `e21fad172` | 3550 个，0 失败，5 个跳过（Linux 上总是跳过的 PerfBaselineTests）。改锚之前的 `222017b25`：16 处失败 | [swift/](swift/) |
| P4.3b 用例 | 参照、交付 | 各 76 通过（639/641/1280px 的几何用例在四个手机环境跳过） | [runs/f-p43b-ref.txt](runs/f-p43b-ref.txt)、[f-p43b-del.txt](runs/f-p43b-del.txt) |
| 决策卡片页 | 参照、交付 | 各 68 通过（决策条的用例在四个手机环境跳过：手机上没有那一行），含已结束的协调者问题 8 个 | [runs/f-cards-ref.txt](runs/f-cards-ref.txt)、[f-cards-del.txt](runs/f-cards-del.txt) |
| P0 页面矩阵 | 参照写截图；交付按 0 像素对参照比较；交付写截图 | 各 101 通过 | [runs/f-p0-ref.txt](runs/f-p0-ref.txt)、[f-p0-strict.txt](runs/f-p0-strict.txt)、[f-p0-del.txt](runs/f-p0-del.txt) |
| 标准 P0 回归 | 交付、起点 | 各 65 通过、36 失败：两树相同，main 的侧栏改动，见[标准 P0 的基础漂移](#标准-p0-的基础漂移) | [runs/f-p0-standard.txt](runs/f-p0-standard.txt)、[f-p0-standard-start.txt](runs/f-p0-standard-start.txt) |
| P3.2 试点 | 参照、交付 | 各 81 通过（另 7 个是只在一个环境记录的性能用例） | [runs/pilot-ref.txt](runs/pilot-ref.txt)、[pilot-del.txt](runs/pilot-del.txt) |
| 合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web` | 本任务工作树（交付 `2fefd4747`，NVMe） | 构建通过；375 个测试文件、4891 个测试全部通过。之前在 `e21fad172` 上 1 个失败，见[第 14 条](#14-workspaceview-里启动卡片的单测在宽屏上早读计划) | [runs/c-merge.txt](runs/c-merge.txt)、[reruns/](runs/reruns/) |
| 相关单测 | 本任务工作树（`2fefd4747`） | 86 个文件、1517 个测试全部通过 | [runs/u-related.txt](runs/u-related.txt) |
| overlays 与 overlays-app-frame 矩阵 | 交付 | 176 通过（含新的「控件让位」用例与 WebKit 滚动锁修复的 app-frame 用例） | [runs/c-overlays.txt](runs/c-overlays.txt) |
| controls 矩阵 | 交付 | 32 通过 | [runs/c-controls.txt](runs/c-controls.txt) |
| choices 矩阵 | 交付 | 680 通过 | [runs/c-choices.txt](runs/c-choices.txt) |
| P4.1 用例 | 起点、交付 | 各 96 通过 | [runs/f-p41-start.txt](runs/f-p41-start.txt)、[f-p41-del.txt](runs/f-p41-del.txt) |
| P4.2 用例 | 起点、交付 | 各 140 通过、40 失败、4 跳过：两树相同，5 个用例在每个环境失败，都是 main 的 Infrastructure 页（见[起点对照](#起点对照p41-与-p42-用例)） | [runs/f-p42-start.txt](runs/f-p42-start.txt)、[f-p42-del.txt](runs/f-p42-del.txt) |
| 探针 | 参照、交付 | 9 个探针两树都跑完 | [probes/](probes/) |
| 清单复扫 | 交付、参照 | `--check-owners` 0 未归属、0 待定，本批 0 个点（交付 `2fefd4747`）；关闭记录：antd 生产文件 59 → 42，读 `.ant-*` 选择器与类名的测试各少 2 个 | [checks/](checks/)、[inventory-closure.json](inventory-closure.json) |

比较（截图逐张分类、计算样式、trace）：

| 比较 | 截图：相同 / 抗锯齿级 / 超出 | trace |
| --- | --- | --- |
| P4.3b 用例，参照对交付 | 195 / 79 / 46 | 76 个用例中 28 个逐步相同；不同的逐项见下 |
| 决策卡片页，参照对交付 | 95 / 19 / 10 | 68 个中 41 个逐步相同（已结束的协调者问题 8 个全部相同） |
| P0 矩阵，参照对交付 | 239 / 11 / 2 | 不记 trace |
| P3.2 试点，参照对交付 | 212 / 34 / 10 | 72 个中 68 个相同 |
| P4.1 用例，起点对交付 | 260 / 11 / 1 | 96 个中 85 个相同 |
| P4.2 用例，起点对交付 | 529 / 19 / 0 | 两树都跑完的 140 个中 138 个相同 |

## 差异逐项

### P4.3b 用例与决策卡片页：逐步语义

[compare/f-p43b-trace-semantics.json](compare/f-p43b-trace-semantics.json)（P4.3b 用例 76 个、464 步）与 [compare/f-cards-trace-semantics.json](compare/f-cards-trace-semantics.json)（决策卡片页 60 个、152 步）：两树逐步比较地址、通知、alert、打开的层（按文字）、写请求与图的测量。请求、请求体、通知与 alert 逐步全部相同。剩下的差异，P4.3b 用例 20 步、决策卡片页 4 步，都属于下面三条：

| 差异 | 参照（AntD） | 交付（Orbit） | 步数 | 对应的已有决定 |
| --- | --- | --- | --- | --- |
| 任务图全屏里按 Escape | 全屏与下面的任务面板一起关闭，地址回到 `/tasks`，焦点落到 body | 只关全屏，任务面板留着（地址仍是 `/tasks/<id>`），焦点回到全屏按钮 | 8（八个环境） | P2 的嵌套弹层规则：Esc 只关闭当前层，父层保持打开（[P2.1 证据](../p2.1/README.md)「只关闭当前层」；overlays 矩阵「nested dialog and imperative confirmation close only the top layer」）。旧行为与 P0.2 记录的旧缺陷 `P0.2-FOCUS-1` 同类：分享弹窗按 Escape 连同底层任务面板一起关闭，焦点回到 BODY（`ui-migration/known-failures.browser.mjs`） |
| 启动卡片的计划图全屏里按 Escape（手机，`d91a0dd48` 的新状态） | 项目页：全屏与下面的启动面板一起关闭，焦点回到页面的 Start 按钮。会话里：下面的复核面板关闭，全屏留着，焦点仍在全屏的 Close | 只关全屏，启动面板或复核面板留着，焦点回到「Task graph」 | 4 + 4（四个手机环境，两个页面） | 同上，P2 的嵌套弹层规则。参照这样，是因为 main 现在的启动卡片里全屏图还是 AntD 弹窗，而手机上它下面的面板已经是 Orbit 的（项目页的 Drawer、会话里的复核 Dialog），两套各自响应 Escape。桌面上项目页的启动对话框也是 AntD 弹窗，与全屏图同在 AntD 的一个 Escape 栈里，两树都只关全屏 |
| 两张图的全屏按 Escape 关闭后 | 焦点落到 body（任务图），或回到按钮但不显示提示（项目图） | 焦点回到全屏按钮，按钮的提示「Open full-screen graph」随之显示 | 16（两张图 × 八个环境；任务图的 8 步与第一行是同一步） | 由两条已验收的约定叠加而成：P2.1 关闭后把焦点还给触发器（「逐层返回焦点」）；P2.2 的 Tooltip 在获得焦点时显示（[component-contracts](../component-contracts.md) Tooltip 行「hover/focus」；P2.2「Tooltip 的 focus/hover/Esc」）。**这两条叠加起来的结果——键盘关闭全屏后，焦点回到按钮时显示提示——没有找到专门的判定，交协调者判。** |

读取（GET）差 6 步，都是项目依赖图的读取次数，方向各半：参照多 3 次，交付多 3 次。依赖图每 30 秒轮询一次（`refetchInterval: 30_000`）；启动卡片读计划时也读它，而数据默认立即过期，新的读者一挂上就重读。所以哪一侧的步骤用时长、哪一侧先打开启动卡片，就可能多读一次。

焦点的差异按约定计入 presentation（P4.3b 用例 133 步、25 类，[分类](compare/focus-classes-f-p43b.txt)；决策卡片页 33 步、12 类，[分类](compare/focus-classes-f-cards.txt)）：

| 情形 | 参照 | 交付 | 依据 |
| --- | --- | --- | --- |
| 对话框打开（两张全屏图、完成问句、启动卡片与它的各状态、启动卡片的全屏任务图、回执上的 Reopen task） | 旧弹窗的 Close | 对话框容器 | P2.1：默认聚焦弹层容器，避免手机打开时弹出软键盘（ui/README「Dialog」） |
| 浮层打开（motif 的样例、移除前置的问句） | 留在触发按钮 | 浮层 | P2.2 Popover 与 Popconfirm：打开时聚焦浮层（ui/README「Popconfirm」） |
| 关闭或取消之后（全屏、移除问句的 Cancel、完成问句、桌面上启动卡片的全屏任务图） | body | 回到触发按钮 | P2.1：关闭后返回先前焦点（ui/README「Dialog」：默认返回先前焦点）。手机上启动卡片的全屏任务图关闭后，参照的焦点在页面的 Start 按钮或全屏自己的 Close 上，那是上面 Escape 那一行的结果 |
| 选择器打开（启动卡片的线路） | combobox | 选项 | P2.2 Select 的焦点行为；同类差异在 P3.2 试点证据中已说明并随 P3.2 验收。Menu 的焦点判定（[component-contracts](../component-contracts.md)，2026-10-07）只覆盖 Menu，Select 没有单独判定 |
| 请求被拒之后（回答、Not yet、记为完成、合并、启动；卡片页的确认、批准） | 参照落到 body、交付留在按钮：15 步；反过来：7 步 | 同左 | 按下的按钮在请求期间处于加载或禁用状态。Orbit Button 加载时保留焦点（P2 Button 约定「loading 阻止再次激活，保留焦点并暴露 aria-busy」，ui/README「Button」），所以交付更常留在按钮上；反方向的 7 步说明，焦点何时被读取仍有影响。两种结果在两树都出现 |

`filed`（同一层被记在 dialogs 还是 popups 下）也计入 presentation：Base UI 的模态对话框不带 aria-modal，而是把对话框外的内容标成 aria-hidden，所以同一个对话框在一棵树记作 dialogs，在另一棵树记作 popups（`trace-semantics.py` 已把两者合在一起比较文字）。

### P4.3b 用例：截图

320 张：195 张逐字节相同，79 张抗锯齿级，46 张超出（[compare/f-p43b-summary.json](compare/f-p43b-summary.json)，区域见 [f-p43b-beyond-clusters.txt](compare/f-p43b-beyond-clusters.txt)，截图在 [shots/f-p43b-beyond/](shots/f-p43b-beyond/)）。为了让本目录不超过 30 MB，每个截图名在第一个环境放参照与交付两张完整截图，其余环境放差异区域的左右对照裁切（`*.crop-reference-delivery.png`，左参照、右交付，四周各留 48px）；完整截图都在 /mnt/data 的运行目录里。决策卡片页同样（[shots/f-cards-beyond/](shots/f-cards-beyond/)），P0 矩阵、试点与 P4.1 的超出都是小块，只放裁切。交付的各个状态放 Chromium 明色桌面一个环境（[shots/delivery/](shots/delivery/)）。逐类：

| 截图 | 环境 | 区域与幅度 | 原因 | 对应的已有决定 |
| --- | --- | --- | --- | --- |
| `p43b-task-remove` | 八个环境 | 移除按钮一块（约 30×30），>2 级 148–347 个像素 | 用例先用 `focus()` 聚焦移除按钮再点击（窄画布上首次聚焦会让画布把节点居中，这是两树相同的既存行为，见[既存的图布局缺陷](#既存的图布局缺陷)）。参照的焦点留在触发按钮上，焦点环可见；Orbit Popconfirm 打开时把焦点移进浮层，按钮上没有焦点环 | P2.2 Popconfirm：打开时聚焦浮层（ui/README「Popconfirm」）。问句本身、按钮与请求两树相同 |
| `p43b-graph-tooltip`、`p43b-task-graph-tooltip` | 四个桌面环境 | 视口右上角的提示框 | 两边都在按钮下方。全屏按钮贴近视口右缘，提示要滑回视口：旧提示贴到右缘，Orbit 提示留 8px。见 [probe-tooltip-side](probes/) | 协调者 2026-10-08 在 P4.2 判定接受：「Tooltip 贴视口边缘的 8px 边距：接受为迁移差异」（[P4.2 证据 · 协调者对差异的判定](../p4.2/README.md#协调者对差异的判定)第 2 条） |
| `p43b-start-plan-graph`（手机）、`p43b-start-settings`、`p43b-start-refused` | 四个手机环境 | 计划图里每个任务的标题与状态下各一条约 130px 宽的横线，最多 224 级 | 参照有下划线，交付没有。手机上启动面板是 Orbit 的 Drawer（两树都是），渲染在 AntD 根节点之外，AntD 根节点的 `a { text-decoration: none }` 够不到；main `d91a0dd48` 起计划画成任务图，图里的任务是链接，于是参照带下划线。交付的 `.pdg-task-main` 自己写明不加下划线（[第 3 条](#3-图里的链接出现下划线)），与页面上的图一致 | 没有专门的判定；与本批第 3 条全屏图里的链接同一机制同一修正。桌面上启动对话框在 AntD 根节点里，两树都没有下划线 |
| `p43b-start-plan-graph`（桌面） | 四个桌面环境 | 节点之间两段连线，各约 10×28，Chromium 最多 4–13 级，WebKit 98–115 级 | 节点位置两树相同（中心 640/636px），只有连线不同：参照的连线比节点中心偏左 0.19–1.73px（这一轮探针里路径 x 为 99.81、99.54、98.27，应为 100），交付正好在 100。参照的启动对话框是 AntD 弹窗，打开时从 0.2 倍放大（不理会减少动态效果），React Flow 在放大途中量了连接点；关掉动画再打开，参照的连线也回到 100（[probe-plan-edges](probes/)） | 没有已有决定。这是参照一侧测量时刻造成的偏移，交付的连线在节点正中 |
| `p43b-graph-full` | 四个桌面环境 | 右上角 Close 一块，>2 级 1000–1017 个像素，最多 5（明）/9（暗）级 | 打开全屏后指针停在原来全屏按钮的位置，正好落在对话框的 Close 上，截到的是 Close 的悬停态。静止时两树相同；悬停的背景，参照 `rgba(0,0,0,0.06)`（明）/`rgba(255,255,255,0.12)`（暗），交付 `0.04`/`0.08`，颜色与位置相同（[probe-close-hover](probes/)）。交付用的是 Orbit 控件共用的悬停底色 `--orbit-control-hover-bg` | **没有找到已有决定，交协调者判。** |
| `p43b-start-loading`、`p43b-graph-loading` | Chromium 明暗桌面（4 张） | 加载点一块（16×16），62–65 个像素，最多 18–21 级 | 截图断言把无限动画停在初始帧，两种转圈的初始帧略有不同 | P4.2 证据把「加载点的静止帧（最多 21 级）」归为边缘栅格化，随 P4.2 验收 |
| `p43b-graph-settled-open` | Chromium 明色桌面 | 38 个像素，最多 6 级 | 标记圆角的栅格化 | 同上，边缘栅格化 |
| `p43b-task-graph` | WebKit 明色桌面、明色手机 | 34、69 个像素，最多 3 级 | 刚超过抗锯齿级阈值一级的边缘 | 同上 |
| `p43b-start-line-menu` | Chromium 明色桌面 | 20473 个像素，最多 3 级 | 刚超过抗锯齿级阈值（每通道 ≤2）一级 | 同上 |
| `p43b-start` | Chromium 明色桌面；WebKit 暗色手机 | 桌面：计划一块，48111 个像素；手机：右缘 8px 滚动条的滑块，892 个像素、最多 15 级 | 取样时刻，不是呈现差异。这张是启动对话框打开后的第一张，取在懒加载的计划图决定读法之前：计划可能还是占位的分层列表，也可能已画成图。两树都会取到两种：Chromium 暗色桌面两树都是分层，WebKit 两个桌面两树都是图，Chromium 明色桌面这次参照是图、交付是分层。手机上计划在视口以下，读法不同，对话框的滚动高度就不同，滑块随之变化。计划的两种读法另有等它决定之后的截图（`p43b-start-plan-levels` 八个环境都相同或抗锯齿级，`p43b-start-plan-graph` 见上两行），读法本身两树一致。计算样式里这张截图的卡片高度另有 3 处不同（Chromium 明暗桌面 1106 对 855px、Chromium 暗色手机 1153 对 902px），差的正是计划两种读法的高度，样式在截图之后一刻读出，同一原因 | 没有专门的判定。`a8df7eac6` 一轮这 8 张两树碰巧取到同一种读法；要让它稳定，需要在这一张之前也等计划决定（同第 12 条），本批没有再改用例 |

`d91a0dd48` 新状态的截图里，项目页的「计划分层列出」「全屏任务图」各 6 张相同、2 张抗锯齿级；「计划画成图」8 张都在上表。依赖图的几何另有一节：[既存的图布局缺陷](#既存的图布局缺陷)。

### 决策卡片页：截图

124 张：95 张逐字节相同，19 张抗锯齿级，10 张超出（[compare/f-cards-summary.json](compare/f-cards-summary.json)、[f-cards-beyond-clusters.txt](compare/f-cards-beyond-clusters.txt)）：

| 截图 | 环境 | 区域与幅度 | 原因 | 对应的已有决定 |
| --- | --- | --- | --- | --- |
| `p43b-card-reopen`、`p43b-card-reopen-refused`、`p43b-card-start-gone` | WebKit 明暗桌面（6 张） | 视口右缘 8px 宽的整列（交付这一列是黑色，参照与页面同色），另有少量边缘像素 | WebKit 桌面上对话框打开时的滚动锁，与 P4.2 的「8px 滚动条列」相同 | **对话框滚动锁**：已知差异。WebKit 滚动锁修复（`9f2f7e9a0`，随 `f8fdf50f0` 进入两树）去掉的是应用框架里通知读屏区域的 1px 溢出：应用页面在框架里滚动，文档不再画出滚动条（overlays-app-frame 用例 176 个中的那一部分通过）。决策卡片页是本批的独立页面，本身比视口高、由文档滚动，WebKit 照样画出 8px 滚动条，所以这 6 张仍在 |
| `p43b-card-owner-refused`、`p43b-card-owner-typed`、`p43b-card-reopen`、`p43b-card-start-gone` | Chromium（4 张） | 2–47 个像素，最多 4 级 | 边缘栅格化 | 同 P4.2 |

已结束的协调者问题（`3ff232299`）：两份记录与已回答那份的详情，八个环境 16 张都逐字节相同。

会话里的启动卡片（`d91a0dd48` 的新状态）：卡片本身 8 张、计划移进视口 8 张、手机上全屏的任务图 4 张都逐字节相同；打开 More 的 4 张，3 张相同、1 张抗锯齿级。记下的几何两树逐项相同：桌面卡片宽 720px（可用 788px），没有 More，有「Read all 3 in full」，计划画成图；手机卡片宽 342px，有 More（打开后是 Less），有「Read all 3 in full」，计划分三层列出，带「Task graph ⤢」。

### 既存的图布局缺陷

作业指导要求对照 P0.2 的原截图和 graphGeometry 记录，把既存缺陷与迁移差异分开说明。[graph-geometry.py](scripts/graph-geometry.py) 并列三组数据（[compare/graph-geometry.json](compare/graph-geometry.json)）：

- P0.2 自己的记录：四个桌面环境的 `breakpoint-639/641-graph` 与 1280px 的 `project-graph`；
- 本批 P0 矩阵在参照与交付上的同一组截图（P0.2 的场景，今天的固定数据）；
- P4.3b 的几何用例：条带、每个标记、缩放工具栏、超出条带底边的距离、被工具栏盖住的标记。

| 来源 | 639px：标记超出条带底边 | 641px：缩放工具栏下的标记 | 1280px：最低标记与条带底边 |
| --- | --- | --- | --- |
| P0.2 的记录（四个桌面环境） | 31px | 最低标记在底边以内 3.65px（Chromium）/4.08px（WebKit），第一个标记横向落在工具栏的位置 | 底边以内 1px |
| P0 矩阵，参照与交付 | 31px | 同上，逐项相同 | 底边以内 1px |
| P4.3b 几何用例，参照与交付 | 31px | 第一个标记「Inventory existing components」（x 49，y 531.85–590.55）落在工具栏（x 32–62，y 492.2–578.2）下 | 0（标记停在底边以内） |

四个桌面环境里，参照与交付的这三组数逐项相同（`referenceEqualsDelivery`）。

这三处是本批之前就有的缺陷。本批没有修它们，也不因为截图相等就声称修复；迁移也没有给图带来新的几何差异。

另一处既存行为：任务图在窄画布上，第一次聚焦节点里的按钮会让画布把这个节点居中（`ensureFocusedNodeVisible`）。所以同时完成聚焦的那次按下，在别处松开，什么也打不开。两树相同（[probe-remove](probes/)），用例因此先聚焦再点击。

### P0 页面矩阵与标准 P0

- 交付按 `maxDiffPixels: 0` 对参照截图比较（Playwright 默认的每像素阈值），101 个全部通过。
- 两次各自写出的截图逐张比较：252 张，239 张逐字节相同，11 张抗锯齿级，2 张超出（`breakpoint-639-projects` Chromium 暗色桌面、`projects-search-empty` Chromium 暗色手机，都是项目列表左侧同一处 7、13 个像素、最多 4 级；上一轮是同一处的另两张），边缘栅格化（[compare/f-p0-beyond-clusters.txt](compare/f-p0-beyond-clusters.txt)）。
- 计算样式只有 `project-graph-fullscreen` 一处不同（8 张）。它的 `dialog` 区域用 `getByRole('dialog')` 取：参照取到的是 AntD 弹窗透明、无圆角的外层，面板在 `.ant-modal-container`；交付的对话框本身就是面板。按面板比（`surface` 区域：参照 `.ant-modal-container`，交付对话框本身），背景、圆角、阴影都相同，只差 WebKit 的行高精度。这 8 张截图 6 张逐字节相同，2 张最多差 1 级。
- 标准 P0（对照 P0.2 原图与漂移层、已接受层）：交付与起点各 65 通过、36 失败，失败的截图两树逐字节相同，全是 main 带来的同一处侧栏改动，见[标准 P0 的基础漂移](#标准-p0-的基础漂移)。

### P3.2 试点（任务详情，含任务依赖图与它的全屏）

截图 256 张：212 张逐字节相同，34 张抗锯齿级，10 张超出（[compare/pilot-beyond-clusters.txt](compare/pilot-beyond-clusters.txt)），都在 WebKit 桌面，都是任务依赖图连线的栅格化，每张只差一小块：

- `pilot-dependencies`、`pilot-dependency-view-hover`（WebKit 明暗桌面，4 张）：一段连线，45 个像素、最多 46 级（暗）与 85 个像素、最多 8 级（明）。只看这一块，交付与上一轮（`a8df7eac6`）的参照、交付都逐字节相同，动的是这一轮的参照。
- `pilot-share-*`（WebKit 暗色桌面，6 张）：分享弹窗遮罩下连线拐角的 2×2 一点，3 个像素、最多 6 级。这一块参照与上一轮两树逐字节相同，动的是这一轮的交付。
- 上一轮的 3 张（`pilot-delete-confirm` 两张、`pilot-detail`）这一轮都在阈值内。所以这些是运行之间的栅格化起伏，两树各有一次，不是渲染差异。

trace：72 个用例中 68 个逐步相同。另外 4 个（5 步）是取样时刻，与上一轮同类：选择器选完之后焦点有没有回到触发器（3 步），「model pick Sonnet」时一侧记到了还在关闭的选项列表，分享弹窗关掉公开链接后的焦点。试点页面上的这些控件两树相同（P3.2 迁移的），试点用例也没有第 11 条那样的等待。

### 起点对照：P4.1 与 P4.2 用例

起点（`5034a3e9f`，项目 tip `abc0a4cfa` 合并 origin/main `4085437ff`）对交付。两者之间只有本批的提交：公共组件、两处修正与业务切换（P4.1、P4.2 的页面不用本批迁移的组件）；P4.3a 的公共组件改动已在起点里。

- **P4.1**：272 张，260 张逐字节相同，11 张抗锯齿级，1 张超出（[compare/f-p41-beyond-clusters.txt](compare/f-p41-beyond-clusters.txt)）：`p41-profile-photo` 一张，头像照片圆边的缩放取样，P4.1 证据已归为边缘栅格化的运行间差异（上一轮是同类 4 张与加载点 1 张）。
  - trace：96 个中 85 个逐步相同。另外 11 个是取样时刻，与上一轮的 9 个同类：按钮在请求期间禁用后，焦点有没有落到 body；按 Escape 后一侧还记到了正在关闭的对话框。两类都是两个方向都有（这一轮还在关闭的对话框记在起点一侧）。P4.1 的用例同样没有第 11 条的等待。
- **P4.2**：两树都是 140 个通过、40 个失败、4 个跳过，失败的是同 5 个用例在八个环境各一次：providers 的 keys 表格、connecting a provider 的 vendor 与 editing、runners 的列表、a pool somebody added the reader to。它们等待 `/providers` 地址或「Runners」「Your API keys」标题，而 main 的 Infrastructure 页（`33e0e2e09`，随 `d98183765` 进到起点）把这两页合成了 `/infrastructure#keys`、`#pools`，标题也没有了。两树失败的用例与环境逐个相同，起点不含本批，所以这是基础漂移，已告知协调者。
  - 跑完的用例：548 张截图，529 张逐字节相同，19 张抗锯齿级，0 张超出（上一轮的 7 张超出，4 张是这 5 个用例里的加载点，另 3 张——`p42-connect-dialect-open` 两张、`p42-account-pause-custom`——这一轮在阈值内）。
  - trace：跑完的 140 个中 138 个相同。另外 2 个是「adding a user」里创建成功那一步，交付一侧还记到了正在关闭的「Add user」对话框（Chromium 暗色手机、明色桌面），同上面的取样时刻。

P4.2 引擎页的「More actions」（菜单打开的 `p42-engine-menu`、移除问句的 `p42-engine-remove`）在八个环境里起点与交付逐字节相同。首屏样式表修正之前（第一轮正式对照 `round-047f91076`），这里是本批的层叠回归（`.re-action.re-more` 盖过 `.orbit-button-text:hover`），见[首屏样式表](#首屏样式表)。

### 组件矩阵

在交付上全部通过：overlays 与 overlays-app-frame 176 个（`overlays*.browser.mjs`，含本批新增的「控件让位」用例与先落地的 WebKit 滚动锁修复的 app-frame 用例：后落地的一方在合并后的树上两套都跑），controls 32 个，choices 680 个（P2.2 的选择器，P4.3a 也跑它）。「控件让位」：长对话框顶部的控件让位后，滚动位置不变（[公共组件](#公共组件)）；它的负对照（只把 `Overlay.tsx` 换回修正前）这一轮仍是 Chromium 四个环境失败（`0 → 100`/`108`）、WebKit 四个环境通过（[extra/overlays-gives-way-*.txt](extra/)）。

### 标准 P0 的基础漂移

标准 P0 回归在交付与起点上结果相同：各 65 个通过、36 个失败（另 11 个跳过）。36 个失败是同 9 个用例在桌面四个环境里各一次，手机环境全部通过。9 个用例：task、projects、wiki、settings、profile、session、projects 的读取中与读取失败，以及 961px 断点的 wiki。

- **不是本批带来的**：失败的 36 张实际截图，交付与起点逐字节相同，而起点不含本批。同提交的 P0 矩阵（交付按 0 像素对参照比较）101 个全部通过。
- **差异全在桌面侧栏**：Runners 与 Providers 两项合成了一项 Infrastructure。差异框：30 张是 x 16–262、y 172–391；会话页的 4 张是 8–270，因为选中的工作区一行也跟着上移；Chromium 961px 断点的 wiki 2 张更大（16–499、24–391），是窄桌面的布局。
- **来源**：Infrastructure 项目线的 `33e0e2e09`，随 `d98183765`（2026-10-09 07:48Z 合进 main）进到起点。P4.3a 在 main `76d41066d` 上的标准 P0 是 101 个通过，那时这条线还没进 main。main 之后没有为它登记漂移，最近一次登记是 `e8ad36c0a`（WebKit 滚动锁）。
- **处理**：本批不登记。协调者另建「P0 漂移登记（第 7 批）」。失败清单（每张的像素数、差异框，以及起点是否逐字节相同）与裁切图（左期望、右实际）在 [checks/p0-standard-base-drift/](checks/p0-standard-base-drift/)。

### 取样对照

第 11 条的修正（`f9e1ebeef`）改的是用例取样的时刻。同一用例、同一环境、同一步对照（[compare/settle-compare.json](compare/settle-compare.json)，[settle-compare.py](scripts/settle-compare.py)）：
- 修正之前那一轮（`round-d1a3f6f7b`），P4.3b 用例两树「打开的层」不同的有 31 步；
- 本轮这 31 步中，15 步两树一致：motif 打开（4 步，全屏里 3 步）、移除问句（4）、全屏按钮的悬停提示（3）、完成问句重新打开（1）；
- 另外 16 步仍不同，全是「Escape closed the full screen」（两张图各 8 个环境），即[逐步语义](#p43b-用例与决策卡片页逐步语义)里的有意差异；
- 决策卡片页修正前就没有这类步骤。

## 未消除的差异

- **有意的差异，对应已有决定**：
  - Escape 只关一层：任务图全屏（8 步）、启动卡片的计划图全屏（手机，8 步），P2 的嵌套弹层规则；
  - 焦点的位置（对话框、浮层打开时，关闭之后，选择器打开时），P2.1、P2.2 的约定与 P3.2 的先例；
  - 移除问句打开时按钮上没有焦点环（8 张），P2.2 Popconfirm。
- **已接受的迁移差异**：Tooltip 贴视口边缘的 8px 边距（8 张），协调者 2026-10-08 在 P4.2 判定接受。
- **已知差异**：WebKit 桌面对话框的滚动锁（决策卡片页 6 张）。WebKit 滚动锁修复已落地、在两树里，它管的是应用框架里的滚动；决策卡片页由文档滚动，这 6 张照旧，见[决策卡片页：截图](#决策卡片页截图)。
- **交协调者判**：全屏 Close 的悬停底色（4 张）；键盘关闭全屏后焦点回到按钮时显示提示（16 步）。见[结论](#结论)。
- **参照一侧的问题，交付与页面上的图一致**：手机上计划图里链接的下划线（12 张），桌面上计划图连线的测量偏移（4 张）。见[P4.3b 用例：截图](#p43b-用例截图)。
- **其余超出**：边缘栅格化与加载点的静止帧（P4.3b 用例 8 张、决策卡片页 4 张、P0 矩阵 2 张、试点 10 张、P4.1 1 张）。试点的 10 张都是任务依赖图连线的一小块，参照、交付各有一次运行间起伏，每一张都与上一轮两树之一逐块相同。
- **取样时刻**：启动对话框的第一张截图 `p43b-start`（Chromium 明色桌面、WebKit 暗色手机 2 张，及其卡片高度 3 处），取在懒加载的计划图决定读法之前，两树都会取到图或分层；等它决定之后的计划截图两树一致。见[P4.3b 用例：截图](#p43b-用例截图)。
- **基础漂移，不是本批**：标准 P0 的 36 个失败与 P4.2 的 5 个用例（40 次），起点与交付相同，来自 main 的 Infrastructure 页。见[标准 P0 的基础漂移](#标准-p0-的基础漂移)、[起点对照](#起点对照p41-与-p42-用例)。
- **行高的数值精度**：`22px` 对 `22.000019px` 一类，P4.3b 用例的计算样式里 104 处、懒加载样式 2 个状态，来自全站 CSS 压缩，与 P3.2、P4.2 相同，截图不受影响。

## 未确立的部分

- 只在 Linux 上的 Playwright Chromium/WebKit 模拟中比较，没有真机，也没有用读屏软件实测。
- 同提交截图对照只在减少动态效果下做。对话框、浮层与提示的默认动效沿用 P2 公共组件已验证的取值，本批没有逐帧对照。
- 后端是固定 REST 数据，不连真实服务。
- 会话页（WorkspaceView）是 P5 的页面：会话里画的决策卡片在专用的卡片页上对照（真实的带数据组件与应用的 Provider），不是在真的会话页里。
- OrbitKit 的 swift 套件只在 Linux 容器里跑（main 上 ci.yml「Swift core」的跑法）。macOS 与 iOS 的应用层测试（client.yml 在 push 上跳过）没有跑；本批也没有改它们读的文件。
- P4.3a 的同提交用例（`p43a.browser.mjs`）本批没有跑。本批的公共组件改动对 P4.3a 页面的影响，只由标准 P0（含任务与项目的列表和详情）、controls、choices 与 overlays 矩阵覆盖。
- 会话导出遇到复核请求回合时抛错，是迁移前就有的缺陷，参照树上同样抛错。已另建任务 [会话导出遇到复核请求回合时失败](orbit-task:34ccjgcldZWdgdrAAm3uV)，不在本批修，也不在本项目里。
- 依赖图的三处既存布局缺陷（639/641/1280px）本批没有修，见[既存的图布局缺陷](#既存的图布局缺陷)。
- P4.2 的 5 个用例与标准 P0 的 36 个截图比较在起点上就失败（main 的 Infrastructure 页），这部分没有起点对交付的对照；它们的失败与失败截图两树相同。标准 P0 的漂移由协调者另行登记。
- 启动对话框的第一张截图取在计划图决定读法之前，这一张的计划部分不是稳定的对照；要稳定需要用例在这之前也等计划决定（同第 12 条），本批没有再改用例、重跑。
- 懒加载样式探针在交付上 WebKit 暗色桌面有一次报了应用未处理的错误，错误的内容没有留下（之后 18 次重跑两树都没有出现），不知道是什么错误。
- OrbitKit swift 套件跑在 `e21fad172` 上；`2fefd4747` 只改一个 vitest 文件，swift 套件不读它，没有重跑。

## 过程记录

原始运行都留在 `/mnt/data/tmp/34blYpxEcHMAf4oafuC2W/`，本目录不复制。

- **`round-047f91076`**（上一会话，交付 `3c03532b9`，参照 `0b557671d`）：第一轮正式对照。P4.3b 用例两树各 68 通过，决策卡片页各 52 通过，合并检查 4785 个测试通过；P4.3b 截图 188 张相同、75 张抗锯齿级、33 张超出。这一轮的起点对照里出现了首屏样式表的层叠回归（P4.2 截图 13 张超出、试点 15 张），见[第 9 条](#9-首屏样式表的顺序随拆包变化)。
- **`round-7050ef420-partial`**：上一会话撞上周额度时只跑完第一步。
- **`round-d1a3f6f7b`**（本会话，origin/main `870e33a1f`，交付 `d1a3f6f7b`，参照 `310cf5f5a`）：带着首屏样式表的修正跑完一轮。查出弹层取回焦点时的滚动（[第 10 条](#10-弹层取回焦点时滚动)）和用例的取样时刻（[第 11 条](#11-用例取样落在被替换浮层的准备阶段)）；第 11 条改前改后的对照以这一轮为「改前」。
- **`round-52a8d7b36-partial`**（项目 tip `15b7b5609` 合并 origin/main `f1837de8e`）：跑到第三步时，main 带来 `d91a0dd48`，协调者叫停。已跑完的 P4.3b 用例两树（各 68 通过）只作过程记录。
- **`round-222017b25-stopped-runs`**（最终基础上的第一次）：swift 套件 16 处失败（[第 13 条](#13-orbitkit-的文案一致性测试读本批改过的标记)），正式链刚开始第一步时停下，改锚后在 `a8df7eac6` 上从头重跑。
- **补的用例的试跑**（`try/trialC-*`、`trialD-*`）：第一次，用例的第二段沿用现成的折叠读法，启动卡片对折叠的计划既不画图也不分层，用例找不到计划而失败，改用专门的计划数据（三个任务一条链；一个任务之后六个并列）；第二次查出参照上 Escape 关掉的是下面的复核面板，于是改为记录、不断言；第三次查出读取早于计划图决定读法（[第 12 条](#12-用例取样早于启动卡片决定计划的读法)），并把计划移进视口截图。之后两树都在八个环境通过。
- **`round-a8df7eac6`**（origin/main `945098b11`，交付 `a8df7eac6`，参照 `87d102f64`）：整轮跑完，全部通过，协调者 2026-10-09 要的补充检查也在其中。之后 main 改了本批的 `CoordinatorQuestionCard`，P4.3a 又要先落地，交付跟了两次，这一轮只作过程记录。
- **`9ed85463a` 上的最终轮**（origin/main `f8fdf50f0`）：刚开始重建三棵树，会话额度停掉了后台任务，协调者随即叫停（P4.3a 先落地），没有运行结果。
- **与 P4.3a 的试合**（`trial-p43a`、`trial-p43a-sim`）：P4.3a 的三个分支头各试合一次，并模拟了一遍跟上的流程，见[P4.3a 之后跟上](#p43a-之后跟上2026-10-09)。
- **`round-e21fad172-interrupted`**：本轮被停下的三次，都停在第一步（参照树上的 P4.3b 用例）。日志与两处超时的错误上下文在 [runs/interrupted/](runs/interrupted/)：
  - 08:19Z 起：08:30Z runner 停机。协调者查明，是内核 OOM 杀掉了 runner 服务里的一个 chrome，runner 的 systemd 单元是 `OOMPolicy=stop`。停机前负载 50–99，28 个用例通过，2 个超时，都在 chromium-dark-desktop：coordinator question（截图时等字体加载，15 s 超时）与启动对话框（点线路菜单的选项，整例 90 s 超时）。
  - 08:40Z 起：08:45Z 撞上周额度，后台任务被停。27 个用例通过，其中包括上面的 coordinator question。
  - 09:07Z 起：两分钟后由本会话停下，加上协调者的内存规则（见[对照方法](#对照方法)）再重启。
  - 正式的一步 09:11Z 从头跑：76 个通过（4 个照例跳过），上面两例都过，coordinator question 用了 2.4 s，启动对话框 12.7 s（`a8df7eac6` 那一轮是 3.1 s、11.5 s）。那两次 90 s 超时出在 OOM 停机之前的高负载下，不是用例或交付的问题。
- **`round-e21fad172-reruns`**：合并检查在 `e21fad172` 上 1 个失败（[第 14 条](#14-workspaceview-里启动卡片的单测在宽屏上早读计划)），这个文件单独在两树上的重复运行，以及修正后的 20 次；修正 `2fefd4747` 之后合并检查与相关单测重跑。日志在 [runs/reruns/](runs/reruns/)。

## 复现

```bash
# 最终轮：三棵树（都在 /mnt/data），交付上的 OrbitKit swift 套件，然后一次跑完正式对照、比较、探针、补充检查与清单复扫
scripts/final-chain.sh e21fad172 4bd2f2f4a 5034a3e9f   # 参照 40f79c5ab = 交付撤回 4bd2f2f4a；起点 5034a3e9f = abc0a4cfa 合并 4085437ff
# 其中各步（formal.sh 可续跑：日志以 exit= 结尾的步骤跳过）：
scripts/make-trees.sh e21fad172 4bd2f2f4a 5034a3e9f
scripts/formal.sh        # 日志在 /mnt/data/tmp/34blYpxEcHMAf4oafuC2W/runs/<name>.txt
scripts/analyze.sh       # 截图、计算样式与 trace 的比较和分类，写到 compare/
scripts/probes.sh        # 探针
scripts/extras.sh        # 协调者 2026-10-09 要求补的检查，写到 extra/
scripts/final-audit.sh   # 两棵树的清单复扫与关闭记录
# P4.3b 用例与决策卡片页单独运行（在要比较的树的 src/web 下）：
P43B_SNAPSHOTS=<dir> P43B_OUTPUT=<dir> npx playwright test --config ui-migration/p43b.config.mjs --update-snapshots=all
P43B_SNAPSHOTS=<dir> P43B_OUTPUT=<dir> npx playwright test --config ui-migration/p43b-cards.config.mjs --update-snapshots=all
# OrbitKit swift 套件（仓库根目录；main 上 ci.yml「Swift core」的跑法）：
docker run --rm -v "$PWD":/repo -w /repo/src/macos/OrbitKit swift:6.1 swift test
# 清单（从仓库根目录，在 e21fad172 或其后只加了证据的提交上）：
node src/web/scripts/audit-antd.mjs --check-owners
python3 -I docs/evidence/base-ui-migration/inventory-delta/build-record-09.py docs/evidence/base-ui-migration/p4.3b/checks/record-09-audit.json \
  | cmp - docs/evidence/base-ui-migration/inventory-delta/2026-10-09.json
node docs/evidence/base-ui-migration/inventory-delta/verify-record.mjs docs/evidence/base-ui-migration/p4.3b/checks/record-09-audit.json 2026-10-09.json
# 本目录的副本由 scripts/collect.sh 从 /mnt/data 复制（报告去掉附件正文）。
```
