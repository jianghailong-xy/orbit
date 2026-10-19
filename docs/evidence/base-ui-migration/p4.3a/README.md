# P4.3a 任务与项目的列表、详情页和工具栏

服务于 [P4.3a 迁移任务与项目的列表、详情页和工具栏](orbit-task:34Za39GvWRQ08ZmKOpFNe)，项目验收条目 key `hnPVsE0kmorHXurrs4Qdp`：**P4：全部非会话业务界面完成迁移，既有页面操作和响应式呈现保持一致。** 本任务承担其子范围：任务与项目的列表、详情页和工具栏的操作与状态含义保持原语义，筛选、排序/拖放和导航正常；桌面与手机、明暗主题下的呈现与同提交参照一致或差异已解释；相关回归通过；本批 AntD 使用点关闭，并有审计记录。依赖图与业务决策卡片由 [P4.3b](orbit-task:34blYpxEcHMAf4oafuC2W) 负责。

本批 9 个提交接在 origin/main `19c760ae4` 上：8 个迁移提交（交付 `dac57bade`），和交证据前补的清单记录 `e59b20f11`（`2026-10-09b.json`）。最终轮（第 6 轮）的同提交对照与最终检查跑在 `76d41066d` 上的同一批提交（交付 `d9e720533`，8 个提交逐个 patch-id 相同）；之后 main 改了本批的 `ProjectsPage.tsx` 一行导航，按规则再跟到 `19c760ae4`，只重跑受影响的检查（见[跟上 origin/main](#跟上-originmain)）。这段时间 main 前进了几次（见[跟上 origin/main](#跟上-originmain)），包括 Web 构建修复 `74fc42d4f`（main 自 `f6f385d2e` 起 `tsc -b` 不过）、子菜单位置修复 `561bffd75` 与 WebKit 1px 修复 `9f2f7e9a0`（通知的读屏区域不再让文档高出 1px，[WebKit 对话框滚动锁](orbit-task:34cBi0yt6bFcSmbJFgDPj) 的修法），都随项目线并入了 main，都在基础里；按跟上规则（项目 tip 已在 origin/main 里，直接 rebase 到 origin/main）接上。

- **第 6 轮**（基础 `76d41066d`，交付 `d9e720533`）：同提交对照（P4.3a 用例、P0 页面矩阵）、标准 P0、合并检查、overlays、controls 与 choices 矩阵、OrbitKit 的 Swift 全量测试，以及重复运行与探针。第 5 轮开跑后 main 带来的 WebKit 1px 修复改到 Toast，属于本批依赖的全局层，按规则再跟一次、重跑。
- **第 5 轮**（基础 `5b794d643`，交付 `de2426d9c`，8 个提交与第 6 轮逐个 patch-id 相同）：choices 以外的完整一轮（choices 跑到 528/648、0 失败时运行器回收会话被停）。
- **第 4 轮**（基础 origin/main `3369ee1e0`，交付 `c02e83a5b`，本批 Web 内容与第 6 轮逐行相同）：完整的一轮，另含起点对照（P4.1、P4.2 用例与 P3.2 试点）。之后公共组件代码的变化只有 main 的子菜单位置修复（`.orbit-menu[data-nested]`、`useSubmenuPlacement`，生产页面都没有子菜单）与 Toast 读屏区域的定位；起点对照量的是本批的公共组件改动对已迁移页面的影响，它的两棵树带着同样的 main，所以第 5、6 轮没有重跑。
- 之前各轮作为过程记录，见[对照的轮次](#对照的轮次)。

## 结论

- **使用点**：本批负责的 83 个 AntD 使用点全部关闭（20 个生产文件、24 个测试文件、index.css 39 行），P4.3a 已无使用点；第 6 轮的交付上 `--check-owners` 0 未归属、0 待定。最终基础上 main 新带来 3 个范围外的未归属点（Infrastructure 与机器页的测试文件），协调者判定归 P6，本批补了记录 `2026-10-09b.json`，最终提交上 `--check-owners` 0 未归属、0 待定。三处归属变化记在新增的 `2026-10-08b.json`，`verify-record` 核对通过。
- **行为**：查询、变更、请求体、路由与拖放库都没有改，只替换控件、菜单、确认与状态展示。在 origin/main `76d41066d` 上与同提交参照（交付只撤回业务切换）对比，P4.3a 的 14 个用例在 8 个环境（Chromium/WebKit × 明/暗 × 桌面/手机）里共 944 步，地址、请求、通知、菜单、选择、分节与行的顺序、勾选、提示与字段值只有 2 步不同，都是参照的 AntD 菜单在观察那一刻还在动画里。筛选（页签、范围菜单、搜索与清除、标签）、排序（按列排序、项目分节）、导航（从项目列表打开项目再后退、任务页标题上的 ↑/↓）、选择与批量操作、确认与被拒、调度与验收编辑都在其中。
- **呈现**：640 张截图 397 张逐字节相同、189 张抗锯齿级、54 张超出。54 张逐张归类：已记录的组件约定（对话框初始焦点 8 张）、遮罩取整 4 张、依赖图载入的时机 3 张（P4.3b 的组件，两棵树代码相同）、按键截图 1 张、边缘栅格化 30 张。需要协调者决定的两处（见[未消除的差异](#未消除的差异)）：Select 打开时不高亮第一项（8 张）；WebKit 里批量栏出现后工具栏有时不重新排高，两棵树都会出现，交付更常出现（第 5 轮的树上 12 次中 8 次对参照 2 次）。
- **回归**：标准 P0 在交付与起点上都是 101 通过，P0 截图没有因本批改变；合并检查（构建与 Vitest 371 个文件、4847 个测试）、overlays 168、controls 32、choices 680 个通过；OrbitKit 的 Swift 全量 3502 个测试 0 失败（11 处锚改到新标记，文案不变）。代码审阅找到的两处键盘回归已修正，新增 6 个单测并做了红绿验证。
- 没消除的差异与没确立的部分分别见[未消除的差异](#未消除的差异)、[未确立的部分](#未确立的部分)。

## 范围

开工时按复扫规则运行 `audit-antd.mjs` 与 `--check-owners`。同提交参照树（交付只撤回业务切换）上，P4.3a 负责 83 个使用点，逐点列表见 [inventory-closure.json](inventory-closure.json) 的 `before.p43a`：

- 生产文件 20 个：
  - `components/` 下 16 个：`MentionDeliveryNotes`、`ProjectAcceptanceCard`、`ProjectBlockers`、`ProjectChainProgress`、`ProjectCoordinatorCard`、`ProjectGoalCard`、`ProjectPanoramaHeader`、`ProjectProgressStatus`、`ProjectReadyToRun`、`ProjectRunSettings`、`ProjectSections`、`ProjectShareControls`、`ProjectsToolbar`、`TaskAttributionCard`、`TaskDependencyList`、`TaskScheduleEditor`；
  - `pages/` 下 4 个：`ProjectsPage`、`TaskDetailPage`、`TaskListView`、`TaskRoute`。
- 测试 24 个（见[单测](#单测)）。
- index.css 39 行：本批页面的 `.ant-*` 覆盖样式，以及提到 AntD 的注释。

分界按协调者的判定（见[协调者的判定与转告](#协调者的判定与转告)）：

- `ProjectTaskGroupsList`（`ProjectsPage.tsx`）也被公开分享的项目页 `SharedProjectPage.tsx`（P4.4）使用。它改为由调用方渲染每一段的行（`renderRows(tasks)`）：项目页用原生 `.orbit-list` 行；`SharedProjectPage` 只改这一处调用，仍用它自己的 AntD `List`，留给 P4.4。同提交对照覆盖了公开分享的项目页（用例 “a shared project”）。
- index.css 10699–10700 两行注释由本批关闭（改写成描述剩下的 `.project-run-settings .project-run-lines` 规则）；19729 `.ant-popover .watch-row-list` 改归 P4.4，本批未关闭，原因见[清单记录](#清单记录)。
- `ProjectProgressStatus.tsx` 的 `ItemAsCard`（例外卡片：取消任务、标记已处理两个对话框）只画在协调者会话页（`WorkspaceView`）。能走到的状态都在同提交对照里覆盖（用例 “open items in the coordinator conversation”）；会话页由 P5.3 迁移，**P5.3 需要回归它**。

## 跟上 origin/main

本任务跑了两次：第 1 次运行在第 4 轮对照中途用完会话额度停下，第 2 次运行（本文）接着做完。

| 时间（UTC） | 基础 | 本批提交（业务切换 / 交付） | 说明 |
| --- | --- | --- | --- |
| 10-08 第 1–3 轮 | `721e48275`（当时的项目 tip） | 第 2 轮 `47d70e7d6`、第 3 轮 `1750eca22` 等 | 见[对照的轮次](#对照的轮次) |
| 10-08 19:07 | 项目 tip `a2e58b0ce`（origin/main `4181a90ec` 加浮层第一帧任务，当时还不在 main 里） | `9e668b191` / `f12984640` | 先 rebase 到项目 tip；只有 `ui/README.md` 要手工合并（两边各加了一段，都保留）。第 4 轮在 19:09 开跑，19:14 会话额度用完、运行被停，参照树只跑了 38 个用例 |
| 10-08 20:56（第 2 次运行） | origin/main `80dd4f134` | `5074df6ef` / `184ae3c5a` | 项目 tip `a2e58b0ce` 已并入 main（`80dd4f134` 的第二个父提交），按规则直接 rebase 到 origin/main。`80dd4f134` 的树与 `a2e58b0ce` 相同，7 个提交逐个的树也与第 1 次运行的 `f99c3099e`…`f12984640` 相同（`git rev-parse <提交>^{tree}` 逐个核对）。第 4 轮在这里重跑了 P4.3a 用例（第 4a 轮，见[对照的轮次](#对照的轮次)），随后[代码审阅](#代码审阅找到并修正的问题)找到两处键盘回归，链停下 |
| 10-08 21:33 | origin/main `3369ee1e0`（main 并入 wiki 项目：只改服务端、`src/shared/src/wiki.ts` 与 wiki 合同，`src/web` 没有改动） | `ad5e0c989` / `c02e83a5b` | 修正键盘回归（新增公共提交 `c8a044fa9`，业务切换与用例提交随之更新）后，按规则 rebase 到当时最新的 origin/main，无冲突；本批内容不变（新旧交付之差正是 main 的 21 个文件）。第 4 轮在这里从头跑完 |
| 10-08 23:58 | origin/main `e6238f318`（含 `f6f385d2e`：main 的 Web 构建自此 `tsc -b` 报 `RunnerEngines.tsx` 两处 `Quota.noLimit`） | `fb29065db` / `13a19e0e1` | 第 4 轮跑完后按规则 rebase，无冲突；本批内容与第 4 轮逐行相同。按协调者转告的例外（合并检查里只允许 main 自己的这两条 tsc 报错）开跑第 5 轮，13 分钟后协调者转告修复已落到项目线，停下 |
| 10-09 00:16 | 项目 tip `15b7b5609`（main `e6238f318` 加修复 `74fc42d4f`）合并 origin/main `f1837de8e` | `99aab33bb` / `687c8035b`（合并提交） | 按协调者 2026-10-09 的转告：先 rebase 到项目 tip，再合并 origin/main，都无冲突。第 5 轮在这里跑完了 P4.3a 两棵树与 P0 参照，运行器回收会话时被停；这时项目线已并入 main |
| 10-09 01:02 | origin/main `a5c99e27f`（项目线并入 main，另多 main 的启动卡片提交 `d91a0dd48`） | `84cf90e36` / `35227d130` | 项目 tip 已在 origin/main 里，按规则直接 rebase，无冲突；本批内容仍逐行相同。第 5 轮在这里跑完了 P4.3a 用例、P0、合并检查与 overlays；这时协调者转告要补 OrbitKit 的 Swift 对照（见[OrbitKit 的文案对照测试](#orbitkit-的文案对照测试)），main 也又前进，controls 跑到一半停下 |
| 10-09 02:08 | origin/main `5b794d643`（项目线再次并入 main，带子菜单位置修复 `561bffd75`：改到公共的 `Menu.tsx` 与 `Floating.ts`，只涉及子菜单，本批页面没有子菜单） | `5f310fb76` / `de2426d9c` | 按规则直接 rebase，无冲突；本批 Web 内容逐行相同，业务切换提交另带 OrbitKit 的 11 处 Swift 锚。第 5 轮在这里跑完（choices 除外，见上） |
| 10-09 04:41 | origin/main `76d41066d`（40 个新提交，含合并提交：项目线第三次并入 main，带 WebKit 1px 修复 `9f2f7e9a0` 与 overlays 的应用框架用例 `78cae80d9`；另有协调者问题卡片、会话页、分享会话页、后台通知行等 main 改动） | `a2040156c` / `d9e720533` | 先按规则对最新 origin/main 干跑 `git merge-tree`：无冲突，但 `9f2f7e9a0` 改到 `lib/toast.tsx`（本批依赖的全局层 Toast），所以再跟一次：项目 tip 已在 origin/main 里，直接 rebase，无冲突；8 个提交逐个 patch-id 与第 5 轮相同，与 main 共同改到的文件只有 index.css（各改各的规则）。第 6 轮在这里跑完 |
| 10-09 07:18 | origin/main `19c760ae4`（第 6 轮之后的 65 个新提交，含合并提交：Infrastructure 页与机器页、侧栏等；其中 `39f906344` 改了本批的 `ProjectsPage.tsx`：没有可用工作区、有多台机器时 New project 跳 `/infrastructure`，不再跳 `/runners`，并改了 `ProjectsPageToolbar.test.tsx` 的对应断言） | `2d2895d86` / `dac57bade` | main 改到本批自己的文件，按收紧后的规则再跟一次：项目 tip 已在 origin/main 里，直接 rebase，无冲突；8 个提交逐个 patch-id 不变。只重跑受影响的检查：`--check-owners`、合并检查（含 main 改过的 `ProjectsPageToolbar.test.tsx`）、OrbitKit 的 Swift 全量（其中 4 个 CopyParity 测试读 `ProjectsPage.tsx`）与 apiserver `npm test`。同提交对照与 P0 不受这处改动影响：两套用例都没有走到这条导航（P4.3a 用例只截 New project 按钮，不点它） |

- 每次接上新基础后都在交付上重跑 `audit-antd.mjs --check-owners`：P4.3a 已无使用点，main 这几次都没有带来本批的新使用点。到第 6 轮的 `d9e720533` 都是 0 未归属、0 待定（[checks/delivery-check-owners.json](checks/delivery-check-owners.json)）。跟上 `19c760ae4` 后，`dac57bade` 上 0 待定、3 个未归属，都是 main 新加的测试文件：`App.infrastructure.test.tsx`、`InfrastructurePage.overview.test.tsx`、`RunnerDetailPage.engines.test.tsx`。main 自己的 `19c760ae4` 上也是这 3 个（[checks/check-owners-main-19c760ae4.json](checks/check-owners-main-19c760ae4.json)），本批没有碰它们。它们属于 Infrastructure 与机器页，不在本批范围，报告协调者（2026-10-09 07:21Z）后，协调者判定归 P6，本批补了记录 `2026-10-09b.json`（提交 `e59b20f11`，见[清单记录](#清单记录)）。最终提交上 **0 未归属、0 待定**（[checks/final-check-owners.json](checks/final-check-owners.json)，七份记录）。
- main 在这段时间改到的 Web 文件都不属本批：协调者问题卡片与它的已答记录、启动卡片与项目依赖图（项目页上也画，P4.3b；`d91a0dd48` 起依赖图还用在启动卡片里）、Runner 引擎页（P4.2）、会话页与会话输入框的建议、后台通知与关注的唤醒行、分享会话页（会话工作区与 P4.4）、plan usage 文案、`lib/projectMerge.ts`、`lib/thinkingDraft.ts` 与 `api.ts`；index.css 的改动只在这些组件自己的规则。只有 `lib/toast.tsx` 的读屏区域定位（WebKit 1px 修复）属于本批依赖的全局层，这是第 6 轮的原因。两棵树同样带着这些改动，同提交对照不受影响。
- **第 6 轮开跑之后 main 又前进**，按协调者收紧后的规则（见[协调者的判定与转告](#协调者的判定与转告)第 6 条）先干跑：交付 `d9e720533` 对 origin/main `6c9cebd4d`（2026-10-09 06:12Z 取得）`git merge-tree --write-tree` 无冲突。main 的 11 个新提交改到的 Web 文件是 `ProjectPromotionCard`（晋升确认卡，P4.3b）、`ProjectMergeStrip`（没有 AntD 使用点）、`WorkspaceView` 与它的单测（会话页，P5.3：会话行与会话页头的 Rename…）、`src/web/Dockerfile`，以及 index.css 新加的 `.session-rename`、`.session-row.renaming` 规则；与本批共同改到的文件只有 index.css，各改各的规则。不碰本批文件，也不碰本批依赖的全局层（ui/ 公共组件、本批相关的 index.css 规则、Toast/弹层），所以当时不 rebase、不重跑。07:18Z 再取 origin/main 已到 `19c760ae4`，干跑仍无冲突，但 main 改到了本批的 `ProjectsPage.tsx`，于是按规则再跟一次（见上表最后一行）。
- 第 1 次运行的 `orbit/p4-3a-853459` 分支与它的工作树留给平台处理，本任务不删。

## 提交

| 提交 | 内容 |
| --- | --- |
| `9809e6b20` | **feat：公共组件（一）。** 新增 `Empty`、`Skeleton`、`Typography.css`、`List.css`；`Card` 增加 `extra`、`size="small"`，`Alert` 增加 `action`，`Badge` 增加 purple，`Input` 增加 `allowClear`/`onClear`。README 与组件矩阵样例。 |
| `33f6a7c33` | **docs：清单记录 `2026-10-08b.json`。** 三处归属：10699 注释改归 P4.3a、19729 改归 P4.4（协调者 2026-10-08 判定）；`Empty.tsx` 的许可说明按 `SelectEmpty.tsx` 的先例归 P6（已报告协调者，见[清单记录](#清单记录)）。生成脚本与该次扫描的审计（`checks/record-08b-audit.json`）。 |
| `365dc1297` | **feat：公共组件（二）。** `Button`/`LinkButton` `iconPlacement`，`Input` `warning`，`SelectOption.title`，`Checkbox` `onCheckedChange` 带事件，`ConfirmDialog` `width`。 |
| `76282079a` | **fix：排版文字自带应用字体与 14px**，同被替换组件的根（P4.3b 在它的对照里发现）。 |
| `d748fc48e` | **fix：公共组件与被替换组件的三处差异**（本批对照找到）：Menu 分组内缩进 8px；MultiSelect 选项正文的宽度；对话框页脚放不下时换行。 |
| `4ff9003e3` | **feat：公共组件（三）。** `Menu` 增加 `openOnArrowKeys`（默认 true）：false 时菜单关闭期间把 ↑/↓ 留给页面。见[代码审阅找到并修正的问题](#代码审阅找到并修正的问题)。 |
| `2d2895d86` | **feat：业务切换。** 20 个生产文件不再导入 antd；index.css 本批规则改写；24 个测试文件改按角色与名称定位；任务页的 Space 与列表标题的方向键同被替换控件（审阅找到的两处，`TaskListView.taskUrl.test.tsx` 新增 4 个单测）；OrbitKit 5 个文案对照测试的 11 处锚改到新标记（见[OrbitKit 的文案对照测试](#orbitkit-的文案对照测试)）。 |
| `dac57bade` | **test：同提交对照用例。** `p43a.browser.mjs`（14 个用例）、`p43a-fixtures.mjs`、`p43a.config.mjs`；P0 矩阵忽略 `p43a*.browser.mjs`。 |
| `e59b20f11` | **docs：清单记录 `2026-10-09b.json`。** 跟上 `19c760ae4` 后 `--check-owners` 报出的 3 个未归属点（main 从 Infrastructure 页项目带来的测试文件，只用 antd 的 `App` 包裹被测组件）按协调者 2026-10-09 的判定归 P6。生成脚本 `build-record-09b.py` 与该次扫描的审计（`checks/record-09b-audit.json`），`verify-record` 通过。见[清单记录](#清单记录) |

- 撤回 `2d2895d86` 就恢复本批的 AntD 页面，同提交参照树正是这样得到的。
- 公共组件提交单独存在时，没有业务页面引用新增的组件和样式；已有组件只多了可选属性（默认值与之前相同）。`d748fc48e` 改的三处对已迁移页面的影响由起点对照检查（[起点对照](#起点对照p41p42-用例与-p32-试点)）；`4ff9003e3` 的属性默认不变，只有任务页传 false。
- `9809e6b20`、`33f6a7c33`、`365dc1297`、`76282079a` 在 P4.3b 的分支 `orbit/p4-3b-09e7a7` 上有同一份内容：那边是本任务第 1 次运行 rebase 到 `a2e58b0ce` 后的同一批提交 `f99c3099e`、`aa80d2d9d`、`97965ab35`、`29138bbb9`，patch-id 与这里逐个相同（`git patch-id --stable` 核对），后落地的一方 rebase 时会按 patch-id 跳过。`d748fc48e`、`4ff9003e3` 只在本分支（P4.3b 的页面用不到）。

## 公共组件

用法写在 [components/ui/README.md](../../../../src/web/src/components/ui/README.md)。除 `d748fc48e` 的三处与 `4ff9003e3` 的按键选项外，每一项都在组件矩阵（`ui-migration/controls.html`）里与被替换组件逐部件对照；那几处由本批的同提交对照与单测检查。

| 组件 | 替换 | 说明 |
| --- | --- | --- |
| `Empty`（`image="default/simple"`） | Empty | 两幅插图改编自 Ant Design 的 MIT 图形（许可说明在文件注释里，2026-10-08b 记录归 P6）；描述、子节点与间距同被替换组件 |
| `Skeleton`（`rows`） | Skeleton（active、无标题） | 16px 行、16px 行距、末行 61%，1.4s 闪烁；`aria-hidden` |
| `Typography.css` | Typography（Title 2/4/5、Paragraph、Text secondary/warning/strong/code） | 原生元素加 `.orbit-typography`；根元素自带应用字体与 14px，同被替换组件的 common style（`76282079a`，组件矩阵加了 12px 父级中的两对样例） |
| `List.css` | List（split、small、Item.Meta） | `div.orbit-list > ul.orbit-list-items > li.orbit-list-item`；≤576px 行内换行 |
| `Card` `extra`、`size="small"` | Card 的 extra 与 small | 标题右侧附加区；小号卡头 38px、正文 12px 内边距 |
| `Alert` `action` | Alert 的 action | 右侧按钮区（项目列表与详情页的 Retry） |
| `Badge` `tone="purple"` | Tag purple | 明暗两套色板 |
| `Input` `allowClear`/`onClear`、`warning` | Input 的 allowClear、`status="warning"` | 清除按钮名为 Clear，字段为空时占位不可见，按下不夺焦点；警告色边框、悬停与聚焦外圈 |
| `Button`/`LinkButton` `iconPlacement="end"` | 图标在文字后的按钮 | 项目列表分节的展开/收起 |
| `SelectOption.title`、`Checkbox` 事件、`ConfirmDialog` `width` | 选项悬停提示、Shift 范围选择、480px 的替换确认 | 只为本批真实用到的地方增加 |
| Menu 分组、MultiSelect 选项、对话框页脚（`d748fc48e`） | Dropdown 分组、多选选项、Modal 页脚 | 见[对照找到并修正的差异](#对照找到并修正的差异) |
| `Menu` `openOnArrowKeys`（`4ff9003e3`） | 没有方向键的 Dropdown 触发器 | 任务页的列表标题；见[代码审阅找到并修正的问题](#代码审阅找到并修正的问题) |

## 业务切换

查询、变更、请求体、路由与拖放（现有的库）都不变，只替换控件、菜单、确认与状态展示。

| 文件 | AntD（之前） | 现在 |
| --- | --- | --- |
| `ProjectsPage` | Alert、App（`modal.confirm`）、Button、Empty、List、Modal、Popconfirm、Select、Spin、Tag、Typography | Alert（Retry 用 `action`）、`useConfirm`（替换协调者，480px）、Button、Empty、原生 `.orbit-list` 行、Dialog（记录状态、重绑、选择工作区）、Popconfirm（删除）、Select、Spinner、Badge、`.orbit-typography` |
| `ProjectsToolbar` | Button、Input（allowClear）、Segmented | Button、Input（`allowClear`）、Segmented |
| `ProjectSections` | Button、List | Button（`iconPlacement="end"`）、原生 `.orbit-list` |
| `ProjectShareControls` | Button、Dropdown | Button、Menu（`project-more-menu`；从菜单打开的分享对话框关闭后焦点回到 ⋯） |
| `ProjectCoordinatorCard` | Button、Dropdown、Space.Compact | Button、Menu（`.project-coordinator-split` 两半拼成一组，同被替换的紧凑组） |
| `ProjectPanoramaHeader` | Alert、Button、Spin、Typography | Alert（`action`）、Button、Spinner、`.orbit-typography` |
| `ProjectGoalCard`、`ProjectChainProgress` | Typography | `.orbit-typography` |
| `ProjectBlockers` | Alert、Button、Input.TextArea、Modal、Tag、Typography | Alert、Button、Textarea、Dialog（无关闭按钮，自定义页脚）、Badge |
| `ProjectReadyToRun` | Alert、Button、Popconfirm、Spin、Tag、Typography | Alert、Button、Popconfirm（恢复任务列表）、Spinner、Badge |
| `ProjectRunSettings` | Alert、Button、Input、InputNumber、Radio、Select、Spin、Switch | Alert、Button、Input（`warning`）、NumberInput、RadioGroup、Select、Spinner、Switch |
| `ProjectProgressStatus` | Alert、Button、Input.TextArea、Modal | Alert、Button、Textarea、Dialog（`project-open-item-dialog`） |
| `ProjectAcceptanceCard` | Alert、Button、Card、Skeleton、Typography | Alert、Button（`iconPlacement="end"`）、Card（`extra`）、Skeleton、`.orbit-typography` |
| `TaskListView` | Avatar、Button、Checkbox、Dropdown、Input、InputNumber、Modal、Popconfirm、Segmented、Select、Spin、Tag、Tooltip | Avatar、Button、Checkbox（Shift 范围选择读取事件）、Menu（范围菜单，带分组）、Input（`allowClear`）、NumberInput、Dialog（批量运行、指派）、Popconfirm、Segmented、MultiSelect（标签）、Combobox（指派）、Spinner、来源会话标记（Badge 样式）、Tooltip |
| `TaskDetailPage`、`TaskScheduleEditor` | Button、Input、Typography | Button、Input（`invalid`）、Textarea、`.orbit-typography` |
| `TaskAttributionCard` | Alert、Card、Skeleton、Tag、Typography（copyable） | Alert、Card（`size="small"`）、Skeleton、Badge、带 Tooltip 的复制按钮（Copy / Copied，3 秒） |
| `TaskDependencyList` | Popconfirm | Popconfirm |
| `MentionDeliveryNotes` | Tooltip | Tooltip |
| `TaskRoute` | Spin | Spinner |
| `SharedProjectPage`（P4.4） | — | 只改 `ProjectTaskGroupsList` 的调用 |

被替换的 Spin 都带 `aria-busy="true"`（与 `aria-live`）；换上的 Spinner 保留 `aria-busy="true"`。P0 的 “projects loading” 用例就是按 `main [aria-busy="true"]` 找加载区的。

## 层叠顺序：同权重的页面规则

被替换组件的样式由 antd cssinjs 注入，方式是 `prepend: 'queue'`（`@ant-design/cssinjs` → `@rc-component/util` 的 `dynamicCSS`）：插在 `<head>` 最前，排在应用自己的样式表之前，所以权重相同时**页面规则赢**。Orbit 组件的样式在 index.css 之后加载（ui/README 的约定），权重相同时 **Orbit 赢**。元素上同时带页面类和组件类、两条规则权重相同（多半都是 0,1,0）又设同一属性的地方，迁移后结果会反过来。

在交付构建上先跑的标准 P0 回归发现了这一点（[process/early-p0](process/early-p0)：32 个失败；修正后 16 个；再修正后 101 全过）。随后用静态检查 [scripts/ties.py](scripts/ties.py) 列出本批全部这种冲突（[process/ties/ties-before-fix.txt](process/ties/ties-before-fix.txt)），逐条按参照树的实际呈现处理，处理后的页面规则带上组件类：

| 页面规则 | 冲突的组件规则 | 处理 |
| --- | --- | --- |
| `.tdp-schedule-hint`、`.tdp-acceptance-empty`、`.tdp-acceptance-hint`（12px、行高 1.5） | `.orbit-typography` 的字号与行高 | 选择器加 `.orbit-typography` |
| `.tdp-acceptance-criteria-input`、`.tdp-acceptance-command-input`（13px） | 输入框自己的字号 | 加组件类，只在 ≥961px：≤960px 时所有输入框统一 16px（iOS 缩放规则），与被替换字段相同 |
| `.tdp-acceptance-exit-input`（64px 宽） | `.orbit-text-control` 的 100% 宽 | 加 `.orbit-input` |
| `.start-card-mono`（等宽、12px；How it runs 的合并检查输入框） | 输入框自己的字体与字号 | 这条规则 P4.3b 的启动卡片也在用，不改它；本批的 `.project-run-settings-grid .start-card-mono.orbit-text-control` 下另加一条（字号同样只在 ≥961px） |
| `.project-run-settings-error`（上边距 10px） | `.orbit-alert` 的 `margin: 0` | 加 `.orbit-alert` |
| `.projects-scope-action`（次要文字色；手机 8px 内边距） | `.orbit-button` 的颜色与内边距 | 加 `.orbit-button` |
| `.projects-new-button`（手机 40×40） | 按钮自己的高度、内边距；icon-only 的宽度 | 只给高度与内边距加类：参照里 40px 宽度本来就没生效（被替换按钮 icon-only 的宽度规则权重更高），按钮是 32×40，交付相同 |
| `.tasks-search`（200px 宽） | `.orbit-text-control` 的 100% 宽 | 加 `.orbit-text-control` |
| `.tasks-viewswitch`（上边距 10px） | `.orbit-segmented` 的 `margin: 0` | 加 `.orbit-segmented` |

检查只覆盖 `className` 字面量；弹层上的 `popupClassName` 等规则在改写时已带组件类。每一处都由同提交对照与 P0 回归验证。

## 对照找到并修正的差异

第 2 轮同提交对照（旧基础上，[process/round2](process/round2)：174 张超出，trace 有语义差别）找到下面这些差异，逐项用探针在两棵树上实测（[scripts/probe](scripts/probe)、[process/probes](process/probes)），修正后第 3 轮降到 61 张、trace 只剩 1 处观察时序差别：

| 差异（参照 → 交付） | 原因 | 修正 |
| --- | --- | --- |
| 协调者分裂按钮的箭头 12px → 14px | AntD 给作为下拉触发器的按钮里的下箭头 `fontSizeIcon`（`.ant-dropdown-trigger.ant-btn > .anticon-down`） | 页面规则把这个箭头设为 12px |
| 菜单打开时箭头按钮的左侧圆角出现 | 打开的菜单在按钮旁插入焦点哨兵，`:last-child` 不再成立 | 两半按钮按类名（`project-coordinator-lead/-caret`）选择 |
| 来源会话标签的关闭图标距文字 7px → 3px | 被替换 Tag 的 `> span + .anticon` 规则给图标 7px 左边距 | 7px |
| 失败页签被选中时计数为红 → 蓝 | 改写时 `[data-checked]` 属性多算一级权重，压过 `.seg-opt--danger .seg-count` | `:where([data-checked])`，保持原权重 |
| 锁定的“任务落在”单选：灰色禁用样式 → 品牌色 | 原页面规则写的是 AntD 6 已不渲染的 `.ant-radio-inner`，在参照里从未生效 | 删去这两条改写，交付显示组件默认的禁用样式，同参照 |
| 阻塞对话框页脚说明换行后左对齐 | 被替换的页脚 `text-align: end` | 页脚加 `text-align: end` |
| 手机上验收卡头矮 1px（57 → 56） | 原手机规则给卡头内层 56px 最小高度，加 1px 分隔线 | 卡头最小高度 57px |
| 范围菜单分组里的项左移 8px | 被替换菜单的分组列表左右各 8px 外边距 | Menu 公共组件：`.orbit-menu-group-list`（`d748fc48e`） |
| 标签筛选选项的计数左移 20px | 多选选项总给勾留 20px；被替换选项正文伸到内边距，选中时伸到 14px 的勾 | MultiSelect 公共组件（`d748fc48e`） |
| 手机上“替换协调者”确认的两个长按钮溢出对话框左缘 | 被替换页脚的按钮是行内排列，放不下就换行 | 对话框页脚 `flex-wrap`，行间无间隙（`d748fc48e`） |

另有几处是用例本身的时序，已在用例里修正（两棵树同样）：等通知消失再截下一张；对话框完全显示（不透明、无 transform）后再操作其中的下拉（被替换对话框的缩放在下一帧才开始，太早打开的 Select 列表按缩放中的宽度量成 94px）；页签与搜索都写地址栏，下一次输入等上一次在页面上生效；会话页先等布局稳定再把例外卡片滚到中间。

## 代码审阅找到并修正的问题

第 2 次运行在交证据前，让两个只读的审阅分别逐文件对照业务切换的新旧代码（项目侧 14 个文件；任务侧 7 个文件和 4 个公共组件提交），核对每个被替换组件的属性在 Orbit 组件里的对应。对照用例没有按到的两处键盘行为找出了回归，本批修正：

| 问题（交付 → 修正） | 原因 | 修正与验证 |
| --- | --- | --- |
| 任务页打开一个任务、焦点在某行的复选框上时按 Space：被替换的原生复选框不响应（列表在 keydown 时已经把 Space 用来勾选光标行并阻止了默认动作），只勾选光标行；Orbit 复选框是 span，在 keyup 时自己再按一次，于是焦点所在行也被勾选或取消（同一行时两次抵消，Space 像是失灵） | Base UI 的非原生按钮在 Space 的 keyup 上激活，keydown 被阻止也不取消（`useButton.mjs` 的注释写明了这一限制） | 列表拿走 Space 时记下，在捕获阶段阻止对应的 keyup（`TaskListView.tsx`）：与原生复选框一样，只勾选光标行。没有打开任务时 Space 仍是焦点所在复选框自己的 |
| 任务页的列表标题（范围菜单的按钮）有焦点时按 ↑/↓：被替换的 Dropdown 按钮没有方向键，按键交给页面，逐行移动任务；Orbit Menu 的按钮按 ↓/↑ 打开菜单并截住按键。选完列表后焦点留在标题上，于是下一次 ↓ 又打开菜单 | WAI-ARIA 菜单按钮的方向键约定（Base UI `openOnArrowKeyDown`） | `Menu` 增加 `openOnArrowKeys`（默认 true，其它调用方不变）；任务页传 false：菜单关闭时 ↑/↓ 留给页面，Enter、Space 与点击照常打开，打开后的方向键仍归菜单 |

- 单测：`TaskListView.taskUrl.test.tsx` 新增 4 个（另一行复选框有焦点时 Space、本行复选框有焦点时 Space、未打开任务时 Space、标题上的 ↓），`Menu.test.tsx` 新增 2 个（关闭时 ↑/↓ 留给页面、打开后方向键仍归菜单；默认仍按 ↓ 打开）。[scripts/keys-red-green.sh](scripts/keys-red-green.sh) 在交付上撤回修正的生产代码、保留新单测：6 个中的 4 个失败，正是审阅指出的现象（两行都被勾选 `[true, true]`、同一行抵消 `[false, false]`、↓ 打开了菜单）；恢复修正后两个文件 30 个全部通过，工作树回到 HEAD（[checks/keys-red-green.txt](checks/keys-red-green.txt)）。
- 同提交对照：P4.3a 用例新增 “keys with a task open”（P3.2 试点任务作为列表的第一行并打开）：另一行复选框有焦点时按两次 Space、标题有焦点时按 ↑ 与 ↓，逐步记录勾选的行、打开的菜单与地址，两棵树对比。
- 审阅的其余结论（不改）：
  - 验收标准卡片的标题现在是 `section` 里的 `h2`：Orbit `Card` 的约定（P4.1 引入，设置页与资料页同样如此），被替换的 AntD Card 标题是 `div`。只改变读屏的标题大纲，不改变外观。
  - 公开分享的项目页（P4.4）仍用 AntD `List.Item.Meta`。本批把 `.project-task-row-meta .ant-list-item-meta-content { min-width: 0 }` 改写成 `.orbit-list-item-meta-content`，那边的 AntD 元素因此不再命中这条规则。它不改变布局：AntD 给这个元素 `width: 0`（`antd/es/list/style/index.js`），弹性项目的自动最小宽度取明确宽度与内容的较小者，本来就是 0；外层 `.project-task-row-meta` 的 `min-width: 0` 也还在。同提交对照的 “a shared project” 截图可以核对。
  - 按钮的可访问名称不再带图标名（“Expand down” → “Expand”、“plus New project” → “New project”）：Orbit `Button` 对图标设 `aria-hidden`（P1.2 的约定）。Spinner 是 `role="status"`、替换协调者的确认是 `alertdialog`，同属 P1/P2 的组件约定。

## OrbitKit 的文案对照测试

OrbitKit（`src/macos/OrbitKit`）的 `*CopyParityTests` 逐字读取 Web 源文件，并把每句文案锚在它周围的标记上（`<Tag …>…</Tag>`、`message="…"`、`okText`、`</Typography.Text>`）。main 的 ci.yml “Swift core” 每次 push 都跑这套测试，Web 的合并检查不跑。协调者 2026-10-09 转告了 P4.3b 对本批的静态核对后，本批按 CI 的方式在 Linux 上跑（`docker run … swift:6.1 swift test`，[scripts/swift-check.sh](scripts/swift-check.sh)）：

- **改锚之前**（交付 `35227d130`，`--filter CopyParity`）：388 个测试，**11 个失败**（[checks/swift-copyparity-35227d130.txt](checks/swift-copyparity-35227d130.txt)）。全部是锚在被替换标记上、文案本身没变的断言。
- **改锚**：在业务切换提交里改 5 个测试文件的 11 处，只换标记，文案逐字不变，断言个数不变：

| 测试（行） | 原来的锚 | 现在的锚 |
| --- | --- | --- |
| `ProjectDoneCopyParityTests` 581 | `{PROJECT_DONE_COPY.readyToClose}</Tag>` | `{PROJECT_DONE_COPY.readyToClose}</Badge>` |
| `ProjectPageCopyParityTests` 84 | `<Tag color="default">{NOT_STARTED}</Tag>` | `<Badge>{NOT_STARTED}</Badge>` |
| `ProjectPageCopyParityTests` 191 | `<Tag color="gold">{PROJECT_DONE_COPY.readyToClose}</Tag>` | `<Badge tone="gold">{PROJECT_DONE_COPY.readyToClose}</Badge>` |
| `ProjectPageSectionsCopyParityTests` 128 | `okText: '…'`（替换协调者的确认） | `confirmText: '…'` |
| `ProjectPageSectionsCopyParityTests` 195 | `message="…"`（运行队列的影响排序提示） | `title="…"` |
| `ProjectRunSettingsCopyParityTests` 156 | `message="How it runs could not be loaded"` | `title="…"` |
| `ProjectRunSettingsCopyParityTests` 160 | `message={move.variables === 'resume' ? RUN_NOT_RESUMED : RUN_NOT_PAUSED}` | `title={…}` |
| `ProjectRunSettingsCopyParityTests` 161 | `message={RUN_NOT_SAVED}` | `title={RUN_NOT_SAVED}` |
| `TaskDetailCopyParityTests` 113 | `okText="Remove"` | `confirmText="Remove"` |
| `TaskDetailCopyParityTests` 199 | `Trigger </Typography.Text>` | `<span className="orbit-typography orbit-typography-secondary">Trigger </span>` |
| `TaskDetailCopyParityTests` 200 | `message="Attribution boundary could not be loaded"` | `title="…"` |

- **改锚之后，全量**：第 6 轮的交付 `d9e720533` 3502 个测试、5 个跳过、**0 失败**（[checks/swift-check-r6.txt](checks/swift-check-r6.txt)，逐套记录 [checks/swift-d9e720533.txt](checks/swift-d9e720533.txt)；比第 5 轮多出的 27 个是 main 新加的）。第 5 轮：交付 `de2426d9c` 3475 个、5 个跳过、0 失败，main `5b794d643` 同样 3475 个、5 个跳过、0 失败（[checks/swift-check.txt](checks/swift-check.txt)，逐套记录 [checks/swift-de2426d9c.txt](checks/swift-de2426d9c.txt)、[checks/swift-5b794d643.txt](checks/swift-5b794d643.txt)）。跳过的 5 个是 PerfBaselineTests，Linux 上总是跳过。

## 单测

本批 24 个测试文件改为按角色、可访问名称和页面自己的类名定位，去掉 `.ant-*` 选择器与 AntD `App` 包裹，断言内容不变：

- **菜单**：按触发按钮的 `aria-expanded`/`aria-haspopup` 与菜单的 `aria-labelledby` 找到 `role=menu`，按名称取 `role=menuitem`；分组按 `role=group`，当前项按 `data-selected`。
- **对话框与确认**：按 `role=dialog`/`alertdialog`、标题与按钮名称。
- **选择类控件**：分段控件按 `role=radiogroup`/`radio` 与 `aria-checked`；开关 `role=switch`；复选框 `role=checkbox`；禁用读 `aria-disabled`/`data-disabled`。
- **加载**：按 `role=status`、名称 Loading。
- **静态渲染中的样式断言**：读 Orbit 类名或 index.css 中改写后的选择器。

两处不只是换定位方式：

- `ProjectsPage.test.tsx` 两个用例数 `aria-expanded`：页面上的弹层触发按钮（⋯ 菜单、删除确认等）在 Orbit 里也带 `aria-expanded`，并带 `aria-haspopup` 说明自己是弹层触发器。用例原意是“行的展开控件”：数行的 `aria-expanded` 时排除带 `aria-haspopup` 的元素，叶子行仍断言页面上没有别的可展开控件。
- 同文件集成用例组的项目文档夹具缺 `maxConcurrentTasks`（真实接口总会返回它，库列可空，空时为 null）。被替换的 InputNumber 把 undefined 当空值，NumberInput 的契约是 `number | null`；夹具补上这个字段（同文件其它用例本来就有），断言不变。

另新增 6 个单测，守住审阅找到的两处键盘行为（`TaskListView.taskUrl.test.tsx` 4 个、`Menu.test.tsx` 2 个，见[代码审阅找到并修正的问题](#代码审阅找到并修正的问题)）。

全量 Vitest 结果见[合并检查与组件矩阵](#合并检查与组件矩阵)。

## 对照方法

沿用 P3.1/P3.2/P4.1/P4.2 的同提交对照。

- **三棵树**（[scripts/make-trees.sh](scripts/make-trees.sh)；第 4 轮用的版本是 [make-trees-r4.sh](scripts/make-trees-r4.sh)，差别只在构建：第 5、6 轮各树只用 vite 构建，类型检查在合并检查里）：
  - 参照树 `534e4831b`：交付 `d9e720533` 只撤回业务切换 `a2040156c`，本地提交、未推送。本批页面是 AntD，公共组件、P4.3a 用例和其它一切与交付相同。
  - 起点树 `76d41066d`：本批的基础 origin/main，跑标准 P0。第 4 轮的起点树是 `3369ee1e0`，在那里还检查了公共组件改动对已迁移页面的影响（起点对照）。
  - 交付树 `d9e720533`：完整检出（合并检查的单测会读 src/web 以外的文件）。
- **磁盘**：三棵树、TMPDIR 与全部运行产物在 `/mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1/`；每一步开始前按 `df -BM` 看根分区，低于 2 GB 就停下报告（第 1 次运行时剩余 56–69 GB，第 2 次运行的第 4 轮 36–64 GB，第 5 轮 15–26 GB）。
- **构建与环境**：各树 `vite build` 后 `vite preview`；Playwright 与 P0 相同的字体、`environment.mjs` 校验、DPR 1、en-US/UTC、固定时间与固定 REST 数据、reducedMotion=reduce；八个环境 = Chromium/WebKit × 明/暗 × 桌面 1280×900 / 手机 390×844；每次运行在独立网络命名空间里。
- **运行与比较**：一次跑完、一次只跑一个——第 6 轮 [scripts/formal6.sh](scripts/formal6.sh)，比较在 [scripts/analyze6.sh](scripts/analyze6.sh)；第 5 轮 [scripts/formal5.sh](scripts/formal5.sh) 与 [scripts/analyze5.sh](scripts/analyze5.sh)；第 4 轮 [scripts/formal.sh](scripts/formal.sh) 与 [scripts/analyze.sh](scripts/analyze.sh)。比较用的工具：
  - [p3.2/compare_runs.py](../p3.2/compare_runs.py) 比较截图、计算样式与 trace；[p4.1/summarize.py](../p4.1/summarize.py) 分类为逐字节相同 / 抗锯齿级（每个差异像素每通道 ≤2）/ 超出；[p4.2/scripts/beyond-clusters.py](../p4.2/scripts/beyond-clusters.py) 把 >2 级像素聚成区域；
  - [trace-semantics.py](trace-semantics.py) 逐步比较 trace 的语义字段：地址、请求（方法、路径、请求体）、通知、菜单项与禁用、alert、打开的选择（分段、单选、复选、开关），以及步骤里记录的分节顺序、行的顺序、勾选的行、列表选项、提示文字和字段值；焦点与对话框文字另行计数。两项按含义读：Orbit 选择控件（Base UI）在角色元素旁有一个供表单取值的隐藏原生输入，观察读成同名的第二项或无名项，去掉；每次按下 Run 的 `triggerId` 是随机的，按“存在”读。
- **P4.3a 用例**（[p43a.browser.mjs](../../../../src/web/ui-migration/p43a.browser.mjs)、[p43a-fixtures.mjs](../../../../src/web/ui-migration/p43a-fixtures.mjs)）：14 个用例 × 8 个环境，覆盖 P0 只走到一部分的本批状态：
  - 项目列表：各分节与提示、折叠为胶囊、Running/Ready 视图、搜索与两种清除、从行打开项目再按浏览器的后退回到列表、历史（完成/取消）、空状态、加载与读取失败再重试；
  - 项目页：页头（状态记录三问及被拒、分享菜单与 Shared · Live、删除确认及被拒）、协调者三种状态（分裂菜单与替换确认、工作区停用后的重绑、无处打开时选择工作区）、How it runs（合并检查警告、编辑与保存被拒、暂停与恢复、锁定）、工作概览（加载、手动就绪提示）、目标与链式进度、阻塞（文件、审阅被拒与接受、无提示的 Resolve）、待办项与运行队列（Run、恢复暂停的列表）、验收标准（方法展开、手机上的“全部”）、任务计划（子任务、过时的空子任务）；
  - 协调者会话里的例外卡片（取消任务、标记已处理被拒）；
  - 公开分享的项目页；
  - 任务页：范围菜单与列表切换、页签、搜索与清除、按列排序（按标题升序、降序、回到到达顺序）、标签筛选（列表、选中后）、来源会话标记与移除、行内提示；选择（Shift 范围）、批量运行与指派对话框、停止与删除确认、加载；打开一个任务时的按键（P3.2 试点任务作为列表第一行：另一行复选框有焦点时按两次 Space，列表标题有焦点时按 ↑、↓，↓ 打开的下一个任务的第一次读取被挂起，所以它的页面停在加载中）；
  - 单个任务（P3.2 试点任务上）：路由加载、归属卡片（加载、复制提示）、计划启动时间与非法时间、验收编辑与校验、移除前置的确认、提及投递及其提示。
  
  定位器是角色、可访问名称、标签和页面自己的类名，同一份文件驱动两棵树；被画出的盒用两边的类名并列（如 `.ant-modal-container, .orbit-overlay`）。每一步记录 trace。
- **P0 页面矩阵**：用 P3.2 的 [p32-reference.config.mjs](../p3.2/p32-reference.config.mjs)。参照树写出截图；交付树先按 `maxDiffPixels: 0` 对参照截图比较一次，再写出自己的截图供逐张分类。另外在交付树和起点树上各跑一次标准 P0 回归。
- **起点对照**（第 4 轮）：P4.1 用例、P4.2 用例与 P3.2 试点，在起点树 `3369ee1e0` 和交付树 `c02e83a5b` 上各跑一次，看本批的公共组件改动对已迁移页面的影响。

## 对照结果

第 6 轮的正式运行依次为：P4.3a 参照、P4.3a 交付、P0 参照、P0 严格比较、P0 交付、标准 P0（交付、起点）、合并检查、overlays、controls、choices（[scripts/formal6.sh](scripts/formal6.sh)，choices 一个环境一步）。重复运行与三个探针是第 5 轮的，跑在第 5 轮的树上（本批 8 个提交与第 6 轮逐个 patch-id 相同，见[重复运行](#重复运行)）；第 6 轮没有再跑，协调者要求第 6 轮跑完尽快交证据。起点对照是第 4 轮的（[起点对照](#起点对照p41p42-用例与-p32-试点)）。

- 日志在 [runs/](runs)（第 5 轮的在 [runs-r5/](runs-r5)，第 4 轮的在 [runs-r4/](runs-r4)）：开头记 argv、树、HEAD、未提交路径、负载、根分区余量与 TMPDIR，结尾记退出码、负载与结束时间；终端颜色码已去掉。
- 报告去掉了附件正文（`*.report.summary.json`）。为了让本目录不超过 30 MB：只写截图供比较的运行（P0 矩阵的参照与交付）不收报告，结果见日志，比较见 compare/；第 4、5 轮不收合并检查的日志，第 4 轮只收起点对照的报告，第 5 轮只收日志和比较的汇总。
- P0 参照第一次在参照树上没有开跑：P0 期望截图的组装要核对已接受层引用的判定文档，main 的 `e8ad36c0a` 起已接受层还引用 `webkit-scroll-lock/README.md`，而参照树与起点树是稀疏检出、没有这份文档（[scripts/make-trees.sh](scripts/make-trees.sh) 的文档清单是按第 5 轮的引用写的）。把它加进两棵树的稀疏检出（HEAD 不变，参照仍是 `534e4831b`）后从 P0 参照重跑；停下的两份日志在 /mnt/data 的 `runs6-stopped/`。
- 第 6 轮各步开始时根分区剩余 12–33 GB（`df -BM`，低于 2 GB 就停下报告）；三棵树、TMPDIR 与运行产物都在 /mnt/data。运行器回收会话时停下过一次运行链（停在 P0 严格比较，它这时因为没有参照截图正在失败）；各步可续跑，已完成的步不重跑。

### P4.3a 用例

| 运行 | 树 | 结果 |
| --- | --- | --- |
| [p43a-ref](runs/p43a-ref.txt) | 参照 `534e4831b` | 112 通过（17.5 分钟） |
| [p43a-del](runs/p43a-del.txt) | 交付 `d9e720533` | 111 通过、1 失败（16.3 分钟） |

失败的是 WebKit 明色手机的页头用例（“the header: …”）：用例的每一步与截图都已完成，失败在用例结束后的“应用里没有未处理的错误”检查——WebKit 页面错误 `…/api/projects/…/panorama/ready?limit=5 due to access control checks.`。这是用例最后一步 `page.reload()` 时被取消的一次读取（项目待办队列，这份数据下每 5 秒轮询一次，删除被拒时也会失效重读），WebKit 把取消记成控制台错误，Playwright 记为页面错误。见[重复运行](#重复运行)。

截图共 640 张，两边都齐（14 个用例，桌面每个环境 81 张、手机 79 张）。数据文件：汇总 [compare/p43a-summary.json](compare/p43a-summary.json)，逐张数据 [compare/p43a-compare.json](compare/p43a-compare.json)，>2 级像素的区域 [compare/p43a-beyond-clusters.txt](compare/p43a-beyond-clusters.txt)，超出的逐张归类 [compare/p43a-beyond-classes.json](compare/p43a-beyond-classes.json)（[scripts/classify6.py](scripts/classify6.py) 按下表的规则生成，并核对每类张数与下表相同）。超出的截图：边缘栅格化以外的 24 对是完整截图（[shots/p43a-beyond](shots/p43a-beyond)），边缘栅格化的 30 对放大裁切在一张图上（[shots/p43a-edges.png](shots/p43a-edges.png)：参照、交付、>2 级像素）。两棵树的全部截图留在 /mnt/data，证据判定后清理。

结果：**397 张逐字节相同，189 张抗锯齿级，54 张超出**。与第 5 轮（408 / 178 / 54，[compare-r5/](compare-r5)）相比，WebKit 桌面对话框滚动锁（4 张）与 WebKit 手机 382/390（2 张）两类没有了：main 的 WebKit 1px 修复让通知读屏区域不再撑高文档，两棵树同样带着它。超出的 54 张：

| 截图 | 环境 | 差异 | 归类 |
| --- | --- | --- | --- |
| `p43a-blocker-review` | 八个环境（8 张） | 审阅阻塞的对话框打开后，参照的 “What did you verify?” 输入框带聚焦框，交付没有（最多 150–171 级） | **对话框的初始焦点**（P2.1 约定，P3.2、P4.2 已记录）：被替换的对话框聚焦第一个控件——这个对话框没有关闭键，于是是输入框；Orbit Dialog 聚焦对话框本身，按一次 Tab 到输入框 |
| `p43a-coordinator-rebind` | 八个环境（8 张） | 重绑工作区的下拉列表里，参照的第一项带悬停底色（最多 10–15 级） | **Select 打开时不高亮第一项**：被替换的 Select 没有选值时打开即高亮第一项（`defaultActiveFirstOption`，Enter 选它）；Orbit `Select` 没有（Combobox、MultiSelect 有）。见[未消除的差异](#未消除的差异) |
| `p43a-coordinator-landing`、`-replace`、`p43a-status-cancel`、`-reopen` | Chromium 明色手机（4 张） | 对话框遮罩下成千上万个像素差 1–3 级，>2 级的每张 2–4 个 | **遮罩合成的取整**（P4.2 已记录，最多 3 级） |
| `p43a-run-settings-locked`、`p43a-coordinator-landing`（WebKit 暗色桌面），`p43a-shared`（Chromium 明色手机） | 3 张 | 参照截图时项目页下方的任务依赖图已画出（盒子、“3 tasks · 1 ready to run · 1 done”、全屏按钮），交付还没有；`p43a-coordinator-landing` 只差页面滚动条的滑块（页面高度随依赖图的盒子变） | **依赖图载入的时机**：依赖图是 P4.3b 的组件，两棵树代码相同，异步载入，这几张截图不等它。第 5 轮这三张都不超出；第 5 轮 `p43a-tasks-keys-space` 反过来是参照还没画出，两个方向都出现过。第 6 轮没有重复这三个用例 |
| `p43a-tasks-keys-space` | WebKit 暗色桌面（1 张） | 任务面板里的依赖图：交付截图时还没画出；列表：交付比参照高 8px；页面滚动条的滑块 | **依赖图载入的时机**（同上）与 **WebKit 不把工具栏重新排高**（见[重复运行](#重复运行)与[未消除的差异](#未消除的差异)） |
| 边缘栅格化 30 张（清单见表下） | 各环境 | 每张 >2 级的像素 1–18 个，加载点静止帧 33–76 个 | **边缘栅格化**：图标与圆角边缘的个别像素（遮罩与面板后面的页头垃圾桶图标、搜索框的放大镜、标签选择器的箭头、单选圆点、批量栏圆角）、输入框末尾的省略号、加载点的静止帧 |

边缘栅格化的 30 张：`p43a-run-settings-edited` ×2、`-escalation` ×2（Chromium 桌面，“Directly into main” 的单选圆点，6 个像素）；`p43a-session-handled-refused` ×2（Chromium 桌面，2 个像素）；`p43a-status-cancel` ×2、`-done` ×2、`-refused` ×2、`-reopen` ×2（Chromium 桌面，遮罩后页头 Delete project 的垃圾桶图标，1–2 个像素，最多 5 级）；`p43a-task-attribution`、`-attribution-copy`、`-attribution-loading`（Chromium 暗色桌面，面板后任务页搜索框的放大镜，6 个像素）；`p43a-tasks-assign`（Chromium 暗色桌面 1 个像素；四个手机环境：输入框末尾的省略号，16–18 个像素）；`p43a-tasks-delete`、`-labels`、`-run`、`-sorted`、`-stop`（Chromium 暗色桌面，批量栏圆角与标签选择器的箭头，1–12 个像素）；加载点的静止帧 `p43a-overview-loading`、`p43a-tasks-loading`（Chromium 暗色手机，33、35 个像素）与 `p43a-task-loading`（Chromium 明色桌面，76 个像素），最多 20 级。

计算样式差异出现在 242 次截图里，只剩两类，与 P3.2、P4.2 相同：
- 对话框的 `surface` 选择器（112 次）：参照命中 AntD 的透明外层，交付命中本身就是表面的 `.orbit-overlay`，背景、圆角与阴影因此不同，截图上的表面一致；
- 行高的数值精度（202 处）：`22px` 对 `22.000019px` 一类，来自全站 CSS 压缩。
第 5 轮还有的页头宽 928 对 920（对话框滚动锁）没有了。

**trace**（[compare/p43a-trace-semantics.json](compare/p43a-trace-semantics.json)，两棵树的逐步记录在 [traces/](traces)）：112 个用例、944 步。

- 语义字段：地址、请求（方法、路径、请求体）、通知、alert、打开的选择、分节顺序、行的顺序、勾选的行、列表选项、提示文字与字段值，**只有 2 步不同，都是参照的 AntD ⋯ 菜单在观察那一刻的动画**：WebKit 暗色手机 “share from the menu”，参照的菜单在 “Share…” 之后还画在屏上（还在淡出）；WebKit 暗色桌面 “shared · live”，用例已等到菜单项可见，参照的菜单在观察那一刻还没有读成可见（还在淡入，透明度为 0）。同一类在第 3、4a、4、5 轮都出现过，环境每轮不同，都在参照一侧。
- 其余差在不属于业务语义的字段，都是 P2.1–P4.2 已接受的约定：
  - 焦点 255 步：菜单、确认浮层与对话框打开时聚焦自身，关闭后回到打开它的按钮（参照多落在 body 或触发器上）；下拉列表打开时焦点在列表里；焦点在带角色的元素上，而不是 AntD 的隐藏 `input`。
  - 打开的对话框 48 步：锚定的确认在 Orbit 里是 `role=dialog`（被替换的是 tooltip）；被替换的确认框在文字里把标题重复一遍。
- 按键用例的语义字段（勾选的行、打开的菜单、地址）在两棵树的八个环境里逐步相同：另一行复选框有焦点时，第一次 Space 只勾选光标行（打开的任务），第二次取消；列表标题有焦点时，↑ 在第一行不动，↓ 打开下一个任务，菜单都不打开。

### P0 页面矩阵与标准 P0

| 运行 | 树 | 结果 |
| --- | --- | --- |
| [p0-ref](runs/p0-ref.txt) | 参照 `534e4831b`，写出截图 | 101 通过、11 跳过 |
| [p0-strict](runs/p0-strict.txt) | 交付对参照截图，`maxDiffPixels: 0` | 101 通过、11 跳过 |
| [p0-del](runs/p0-del.txt) | 交付 `d9e720533`，写出截图 | 101 通过、11 跳过 |
| [p0-standard](runs/p0-standard.txt) | 交付，标准 P0 回归 | 101 通过、11 跳过 |
| [p0-standard-base](runs/p0-standard-base.txt) | 起点 `76d41066d`，标准 P0 回归 | 101 通过、11 跳过 |

- 跳过的 11 个，各树相同：7 个环境里的“性能基线记录”和 4 个手机环境里的“600/640/960px 规则两侧”（配置只在别的环境跑它们）。
- P0 期望截图：87 张 P0.2 原图、143 张 main 漂移参考、22 张已接受的迁移差异（含 main `e8ad36c0a` 为 WebKit 1px 修复登记的 9 张）。
- P0 矩阵 252 张截图：**233 张逐字节相同、18 张抗锯齿级、1 张超出**（[compare/p0-summary.json](compare/p0-summary.json)）。超出的是 Chromium 暗色手机 `projects-list`，项目列表 All/Running 分段控件左下圆角的 3 个像素（最多 4 级），第 5 轮的两张超出也是这一处。计算样式差异只有 WebKit 行高的数值精度（16 次截图里 20 处）。
- **P0 截图没有因本批改变**：标准 P0 在交付上与在起点上一样 101 通过，对照的是 P0.2 原图、main 漂移层与已接受层（每张截图对照哪一层记在 `runs/*.expected-sources.json`）。本批没有需要逐张说明、等协调者确认后登记的 P0 截图。

### 起点对照（P4.1、P4.2 用例与 P3.2 试点）

第 4 轮在起点树 `3369ee1e0` 和交付树 `c02e83a5b` 上各跑一次已迁移页面的对照用例，看本批的公共组件改动对它们的影响：新增的组件与样式这些页面不引用，已有组件只多了可选属性，真正会改变它们的是 `d748fc48e` 的三处（菜单分组、多选选项、对话框页脚换行）。两棵树的页面代码相同，只差本批。第 5 轮没有重跑，原因见开头（两轮之间公共组件的变化只有 main 的子菜单修复）。

| 用例 | 起点 / 交付 | 截图：逐字节相同 / 抗锯齿级 / 超出 | trace |
| --- | --- | --- | --- |
| P4.1（[p41-base](runs-r4/p41-base.txt)、[p41-del](runs-r4/p41-del.txt)） | 各 96 通过 | 272 张：263 / 8 / 1 | 96 个用例、488 步，语义 0 处 |
| P4.2（[p42-base](runs-r4/p42-base.txt)、[p42-del](runs-r4/p42-del.txt)） | 各 180 通过、4 跳过 | 644 张：628 / 12 / 4 | 180 个用例、912 步，语义 0 处 |
| P3.2 试点（[pilot-base](runs-r4/pilot-base.txt)、[pilot-del](runs-r4/pilot-del.txt)） | 各 81 通过、7 跳过 | 256 张：209 / 30 / 17 | 72 个用例、368 步，语义 0 处 |

- 超出的 22 张都是已记录的栅格化（裁切对照 [shots/start-beyond-r4.png](shots/start-beyond-r4.png)，区域在 [compare-r4/](compare-r4)）：P4.1 的 `p41-profile-photo`（Chromium 暗色桌面，头像照片圆边的缩放取样，144 个像素，最多 30 级；P4.1、P4.2 已记录）；P4.2 的加载点静止帧 3 张（`p42-runners-loading` ×2、`p42-keys-loading`，35–37 个像素，20 级）与 `p42-workspace-menu` 的 1 个像素（3 级）；试点 WebKit 暗色桌面 16 张，任务面板依赖图里同一条连接线的栅格化（23 个像素最多 48 级，或 1 个像素 6 级），以及 Chromium 暗色桌面 `pilot-delete-confirm` 面板关闭图标的 5 个像素（15 级）。
- 计算样式：三对都没有差异。
- trace 只有焦点（P4.1 6 步、P4.2 2 步、试点 10 步）与打开的对话框（P4.1、试点各 2 步）的观察时机：关闭后焦点回到按钮之前或之后读数、对话框在关闭动画里还是已关，两个方向都有（起点读到 body、交付读到按钮，也有相反的）。

### 合并检查与组件矩阵

| 运行 | 命令（交付的完整检出） | 结果 |
| --- | --- | --- |
| [merge](runs/merge.txt) | `npm run build -w @orbit/web && npm run test -w @orbit/web` | 构建通过（`tsc -b` 与 vite）；Vitest 371 个文件、4847 个测试全部通过 |
| [overlays](runs/overlays.txt) | `npm run test:ui-overlays -w @orbit/web`（本批改了 ConfirmDialog 宽度与对话框页脚换行；main 随 WebKit 1px 修复加了应用框架用例） | 168 通过（第 5 轮 96 个，多出的 72 个是 main 的应用框架用例） |
| [controls](runs/controls.txt) | `npm run test:ui-controls -w @orbit/web`（Button、Input、Card、Alert、Badge、Empty、Skeleton、排版与列表） | 32 通过 |
| choices（`runs/choices-<环境>.txt`，八个环境各一步） | `npm run test:ui-choices -w @orbit/web -- --project <环境>`（Menu 分组、MultiSelect 选项与 Menu 的按键选项；main 的子菜单修复也改了 Menu） | 680 通过（八个环境各 85 个；第 4 轮是 648 个，多出的是 main 新加的子菜单几何用例） |

- 交证据前，在最终提交（交付 `dac57bade` 加本目录：合并检查的单测也读 src/web 以外的文件）上再跑合并检查、OrbitKit 的 Swift 全量测试（[scripts/swift-check.sh](scripts/swift-check.sh)；其中 4 个 CopyParity 测试读 main 改到的 `ProjectsPage.tsx`）和 apiserver 的 `npm test`（不连库的部分；其中的 removal 扫描读整棵树，包括 docs/evidence 里的日志）。这三次运行在证据提交里引用。

### 重复运行

为把运行间的变化与两棵树的差别分开，第 5 轮之后（基础 `5b794d643`，交付 `de2426d9c`，本批 8 个提交与第 6 轮逐个 patch-id 相同）两棵树各把页头与按键两个用例在 WebKit 明/暗桌面、明/暗手机重复运行 3 次（[scripts/repeat.sh](scripts/repeat.sh)，日志与分析在 [repeat-r5/](repeat-r5)；[scripts/repeat-analyze.py](scripts/repeat-analyze.py) 把第 5 轮的正式运行一并算进去，每棵树 4 次），另跑了三个探针。第 6 轮的正式运行里同样的现象又出现了：交付的页头用例在 WebKit 明色手机失败在 “access control checks”（`…/panorama/ready`），WebKit 暗色桌面的按键截图交付的列表高 8px。

| 运行 | 参照 | 交付 |
| --- | --- | --- |
| 第 5 轮正式运行（这两个用例的 WebKit 部分） | 按键用例 2 个失败（明、暗手机：ResizeObserver） | 按键用例 1 个失败（明色桌面：ResizeObserver） |
| 重复 1 | 8 通过 | 8 通过 |
| 重复 2 | 8 通过 | 8 通过 |
| 重复 3 | 2 失败：按键用例（明色手机：ResizeObserver）；页头用例（暗色手机：15 秒内没等到 “Recorded as done” 通知） | 8 通过 |

- **ResizeObserver 页面错误**：两棵树都有，都在按键用例（打开一个任务，任务面板带 P4.3b 的依赖图；任务列表自己也用 ResizeObserver 量滚动区），都在用例的最后一步之后。4 次运行 × 4 个环境里，参照 3 次、交付 1 次；参照树上的几何探针（见下）8 次里又有 1 次。不是本批引入的。
- **页头用例的 “access control checks” 页面错误**：交付一侧出现过三次——第 4 轮与第 5 轮 `bcf8c7fff` 那次在 WebKit 明色桌面，第 6 轮在 WebKit 明色手机（第 4 轮是 `…/api/runners`、`…/api/sessions/counts`，后两次是 `…/panorama/ready`：都是后台读取，在用例的 `page.reload()` 时被取消，WebKit 把取消记成控制台错误，Playwright 记为页面错误），参照一侧没有出现过。第 5 轮正式运行与 3 次重复里两棵树都没有出现；重新加载探针（[scripts/probe/p43a-reload-probe.browser.mjs](scripts/probe/p43a-reload-probe.browser.mjs)：项目页、被拒的删除、按 0–900ms 错开的重新加载，WebKit 明/暗桌面各 10 次）两棵树各 20 次全部通过、没有页面错误（[repeat-r5/probe-reload-ref.txt](repeat-r5/probe-reload-ref.txt)、[-del](repeat-r5/probe-reload-del.txt)）。这些读取的请求代码（应用外壳与 `lib/queries.ts`）本批没有改，重新加载是用例自己的一步；它只在交付一侧出现过，是不是与树有关没有确立，见[未确立的部分](#未确立的部分)。
- **“Recorded as done” 通知等待超时**：只在参照一侧出现过（重复 3 的暗色手机，`bcf8c7fff` 那次的明色手机），都在主机高负载时。
- **`p43a-tasks-keys-space` 的列表位置**：
  - WebKit 暗色桌面有两种截图，两棵树都出现过：列表较高的一种，参照 4 次中 1 次、交付 4 次中 3 次；WebKit 明色桌面这次 8 次全部逐字节相同（第 4 轮交付那张是较高的一种）；两个手机环境 8 次全部相同。
  - 按键探针（[scripts/probe/p43a-keys-probe.browser.mjs](scripts/probe/p43a-keys-probe.browser.mjs)，[repeat-r5/probe-keys-ref.txt](repeat-r5/probe-keys-ref.txt)、[-del](repeat-r5/probe-keys-del.txt)）逐步读列表的几何：没有任何元素滚动（`scrollTop` 全为 0），差别在 Space 让批量栏出现之后列标题行的位置。
  - 几何探针（[scripts/probe/p43a-keys-geom-probe.browser.mjs](scripts/probe/p43a-keys-geom-probe.browser.mjs)，[scripts/probe-geom.sh](scripts/probe-geom.sh)，WebKit 暗色桌面，每棵树 8 次，[repeat-r5/probe-geom.txt](repeat-r5/probe-geom.txt)）读出原因：批量栏总是 42px 高（内容 32px、边框 2px、它自己的 8px 横向滚动条——任务打开时列表区窄，批量栏的按钮放不下），装它的 `.tasks-toolbar` 却有时是 42px、有时是 34px，像是在批量栏出现滚动条之前排好、之后没有重新排高；34px 时列表上移 8px，批量栏的滚动条落在工具栏与列表之间的 8px 间隙里，不遮挡内容。34px 的情形参照 8 次中 1 次、交付 8 次中 5 次；连同重复运行，参照 12 次中 2 次、交付 12 次中 8 次，交付明显更常出现（见[未消除的差异](#未消除的差异)）。这几条规则（`.tasks-toolbar`、`.tasks-bulkbar` 的 `overflow-x: auto`）本批都没有改。真机 iOS 与默认设置的 macOS Safari 用覆盖式滚动条，不占位置，不会出现这种情况。
- **`p43a-delete-refused`（WebKit 明色手机）**：参照 4 次中 2 次右侧 8px 列画成滚动条，交付 4 次相同（WebKit 手机 382/390：第 5 轮的超出类别，第 6 轮随 main 的 WebKit 1px 修复消失）。
- 其余盯着的截图（`p43a-delete`、`p43a-header-live`、WebKit 明色桌面 `p43a-delete-refused`）每棵树 4 次逐字节相同。有变化的截图每种各留一张（[repeat-r5/variants](repeat-r5/variants)，文件名带 [repeat-r5/analysis.json](repeat-r5/analysis.json) 里的哈希）。

## 迁移清单

开工时与交证据前，都在交付上运行 `audit-antd.mjs --check-owners`：0 未归属、0 待定，P4.3a 已无使用点（[checks/delivery-check-owners.json](checks/delivery-check-owners.json)）。审计全文：交付 [checks/delivery-audit.json](checks/delivery-audit.json)，同提交参照 [checks/reference-audit.json](checks/reference-audit.json)。

[inventory-closure.mjs](inventory-closure.mjs) 对比第 6 轮的同提交参照 `534e4831b` 与交付 `d9e720533`（最终的 `dac57bade` 上本批文件逐行相同，`--check-owners` 见[跟上 origin/main](#跟上-originmain)），结果在 [inventory-closure.json](inventory-closure.json)。每个点都按审计自己的 `--check-owners` 规则（P0.1 清单加 inventory-delta 的六份记录 07、07b、07c、07d、08、08b）判归属：

- **使用点**：P4.3a 负责的使用点 **83 → 0**：20 个生产文件、24 个测试文件、index.css 39 行（逐点列表见 `before.p43a`）。未归属 0 → 0，待定 0 → 0；其它阶段两边相同：P4.3b 30、P4.4 55、P5.1 28、P5.2 11、P5.3 94、P6 38、KEEP 1。
- **导入**：20 个生产文件不再导入 antd（导入前后逐文件列在 `files`）；7 个测试文件去掉了 AntD `App` 包裹，`ProjectsPage` 不再用 `App.useApp`。`TaskAttributionCard` 新导入 `@ant-design/icons`（复制按钮自己画 Copy/Check 图标，被替换的可复制文字由 AntD 提供它们），所以引用独立图标包的生产文件多 1 个。
- **审计计数**（参照 → 交付）：直接引用 antd 的生产文件 79 → 59，测试文件 64 → 57；含 `.ant-*` 选择器的测试文件 42 → 29，含裸 `ant-*` 类名的测试文件 47 → 30；`--check-retired` 阻塞文件 196 → 152。
- **命中行**（参照 → 交付）：`ant-class` 307 → 222、`ant-selector` 285 → 215、`antd-reference` 299 → 237、`provider` 76 → 69、`use-app` 9 → 6、`imperative-confirm` 12 → 11。`imperative-feedback` 221 → 221 是对 Orbit `useToast` 返回值 `message.success/error(...)` 的文字命中，不是 AntD 调用，归属规则不把它算作使用点（P4.1、P4.2 相同）。

### 清单记录

本批新增 [2026-10-08b.json](../inventory-delta/2026-10-08b.json)（提交 `33f6a7c33`，由 [build-record-08b.py](../inventory-delta/build-record-08b.py) 从 `079c5f006` 的审计 [checks/record-08b-audit.json](checks/record-08b-audit.json) 生成），三个条目：

| 使用点 | 归属变化 | 依据 |
| --- | --- | --- |
| index.css 10699 「The two lines, one under the other; the class makes these rules outrank antd's own」 | P4.3b → **P4.3a**（reassigned） | 协调者 2026-10-08 判定。这段注释说明的执行模式单选规则只有 ProjectRunSettings 用；本批把它改写成描述剩下的 `.project-run-settings .project-run-lines` 规则，不再提 AntD，与下一行 10700 一起关闭 |
| index.css 19729 `.ant-popover .watch-row-list {` | P4.3a → **P4.4**（reassigned） | 协调者 2026-10-08 判定。**本批没有关闭它**：这条选择器限定的是 `WatchRelations.tsx` 里 AntD Popover 画出的关注列表，那个文件归 P4.4；Popover 不迁移，这条规则就不能改写（改了，弹层里的列表会失去样式），所以随 WatchRelations 一起由 P4.4 迁移 |
| `src/web/src/components/ui/Empty.tsx`（本批新增，注释写明两幅插图改编自 Ant Design 的 MIT 图形及许可文件） | 新增 → **P6** | 按 `2026-10-07.json` 中 `ui/SelectEmpty.tsx`（同一许可说明，归 P6）的先例：不是 antd 依赖，退役扫描里的这处文字由 P6 处理。P4.3b 在 `079c5f006` 上运行 `--check-owners` 时报出；第 1 次运行 2026-10-08 14:38Z 报告协调者（“若你同意，不用回”），之后没有收到异议。记录的 `decision` 把它与上面两项判定列在一起，依据字段写的是先例。**协调者若要别的归属，改这一条即可** |

- `verify-record.mjs` 用该记录自己那次扫描的审计核对通过（[checks/verify-record-08b.txt](checks/verify-record-08b.txt)）：1 个文件条目、2 个 index.css 条目与审计一致；读入前 5 份记录后，拿掉它的新增条目正好 1 个点失去归属，拿掉它的重新归属正好 2 个点换回原 owner；六份记录一起读时 0 未归属、0 待定。
- 原版 `verify-record.mjs` 的重新归属反向对照只比较“有没有归属”，对两个进行中批次之间的移动会误报失败（实测 `[] ≠ [10699, 19729]`）；本批把它改为比较每个点归谁，07、07b、07c 用各自的审计复核仍然通过（见 [inventory-delta/README.md](../inventory-delta/README.md) 的 verify-record 一行）。
- 记录里的行号 10699、19729 是扫描提交 `079c5f006` 上的行号；`--check-owners` 按文字与类型匹配，不受本批 index.css 改动造成的行号移动影响。

交证据前又新增 [2026-10-09b.json](../inventory-delta/2026-10-09b.json)（提交 `e59b20f11`，由 [build-record-09b.py](../inventory-delta/build-record-09b.py) 从 `dac57bade` 的审计 [checks/record-09b-audit.json](checks/record-09b-audit.json) 生成）：跟上 `19c760ae4` 后 `--check-owners` 报出的 3 个未归属点，都是另一个项目（34bmzOkov3xN2yLPrnsCk，Infrastructure 页）带进 main 的测试文件，只用 antd 的 `App` 包裹被测组件；协调者 2026-10-09 判定归 P6、status 记 new（P6 去掉 ConfigProvider/AntApp 时一起去掉，先例是 07c 的 `ProjectDoneConversation.test.tsx`），文件名用 09b 是因为 `2026-10-09.json` 留给在本批之后落地的 P4.3b。`verify-record.mjs` 用该次扫描的审计核对通过：3 个文件条目与审计一致，读入前 6 份记录后正好这 3 个点要它的新增条目，七份记录一起读时 0 未归属、0 待定；08b 用它自己的审计复核仍然通过。

## 协调者的判定与转告

第 1 次运行开工核实分界后报告协调者，协调者（会话 34b245G3NiwgVVUj2JFJw）2026-10-08 两次回复，都按默认：

1. **“四条都同意”**：
   - 公共能力的清单转告 P4.3b，沿用同样的文件名和 API；同名文件以先落地的为准，后落地的合并（P4.3b 已把本批前 4 个公共提交原样放进它的分支，见[提交](#提交)）。
   - `ProjectTaskGroupsList` 的分界：`SharedProjectPage` 只改调用这一处，AntD `List` 留给 P4.4；同提交对照覆盖公开分享的项目页（用例 “a shared project”）。
   - index.css 那段注释：只删 project-run 的选择器，不动 P4.3b 的选择器（随后被第 2 次判定细化，见下）。
   - `ItemAsCard` 也画在会话页：能走到的状态都在对照里覆盖（用例 “open items in the coordinator conversation”），并在证据里注明 **P5.3 要回归它**。
2. **“两条都按你的默认”**：index.css 10699 和 10700 两行都由本批关闭，注释改写成描述剩下的 `.project-run-settings .project-run-lines` 规则（已转告 P4.3b）；19729 改归 P4.4，本批不动；两处归属变化新增记录 `2026-10-08b.json` 登记，`verify-record` 要通过，证据写明 19729 未关闭的原因（见[清单记录](#清单记录)）。

第 2 次运行期间协调者 2026-10-09 又转告、判定了五件事，都已照做：

3. **main 的 Web 构建坏了**（自 `f6f385d2e` 起 `tsc -b` 在 `RunnerEngines.tsx` 432、438 两行报 `Quota.noLimit` 缺失，与本项目无关；修复是本项目任务 34ccSuT35QtQJtNvv8sHG，先落到项目线）：修复没落地前照常跟上 origin/main，合并检查里 tsc 只允许这两条报错并证明去掉本批后报错一样；落地后先 rebase 到项目 tip 再合并 origin/main，合并检查照常跑。本批先按前一种开跑第 5 轮，随即修复落到项目线、又并入 main，最终直接 rebase 到含修复的 origin/main，合并检查照常跑（见[跟上 origin/main](#跟上-originmain)）。
4. **修复已落到项目线**：按上一条的第二种做法。
5. **OrbitKit 的 Swift 文案对照测试**：交证据前在本批分支上跑 `swift test`，有失败就在业务切换提交里把锚改到新标记上，文案不变、不弱化断言，跑到全绿，证据列出结果与改了哪些锚。见[OrbitKit 的文案对照测试](#orbitkit-的文案对照测试)。
6. **跟上 main 的最后一条收紧**（第 6 轮跑完之后适用）：main 再前进时，干跑有冲突或改了本批自己的文件就再跟一次、只重跑受影响的检查；只改到本批依赖的全局层就不 rebase，在临时合并树上跑标准 P0 和本批入口；其余情况只在证据里写明干跑结果与 main 的改动清单。并请第 6 轮跑完尽快交证据（P4.3b 已经把与本分支的合并写成脚本，等本批落地）。所以第 6 轮没有再做重复运行与探针，交证据前的干跑见[跟上 origin/main](#跟上-originmain)。
7. **main 带来的 3 个未归属点归 P6**：本批跟上 `19c760ae4` 后报告了 `--check-owners` 的 3 个未归属点（见[跟上 origin/main](#跟上-originmain)），协调者判定归 P6、status 记 new，要求本批写 `2026-10-09b.json` 并附生成脚本、用 `verify-record.mjs` 核对、在 inventory-delta 的 README 清单里加一行、单独成一个提交，`--check-owners` 回到 0 未归属、0 待定后再交证据。见[清单记录](#清单记录)。

与 P4.3b 的往来（两边各自的分支，都未落地）：

- P4.3b 先用本批的公共提交（Empty、Skeleton、Typography、Alert action、Card small/extra 等），并报出 AntD Typography 的根元素自带字体与 14px（common style）；本批核实后修正为 `76282079a`，P4.3b 也放进了它的分支。
- 层叠顺序的发现（[层叠顺序](#层叠顺序同权重的页面规则)）与静态检查 `ties.py` 转告了 P4.3b；它在自己的页面上跑过，没有新的冲突。
- P4.3b 不取 `d748fc48e`（它的页面不用这三处）；两边相同的公共提交 patch-id 相同，后落地的一方 rebase 时跳过。

## 未消除的差异

- **Select 打开时不高亮第一项**（`p43a-coordinator-rebind` 八个环境）：被替换的 Select 没有选值时打开即高亮第一项（`defaultActiveFirstOption`），Enter 选它；Orbit `Select` 打开时不高亮，Enter 不选。重绑与选择工作区两个对话框的 Select 都没有初值，所以截图里第一项少了悬停底色，键盘上要先按 ↓。Orbit `Combobox`（P2.2）与 `MultiSelect`（P4.1）已经这样做，`Select` 没有：Base UI 的 Select 没有对应选项，要在公共组件里自己高亮，而它的键盘行为由 P2 的键盘窗口用例（select-keys、keyboard-window 两批）锁定。本批没有改它，留给协调者决定是否另建任务（建议：`Select` 在 `value === null` 时打开即高亮第一项，Enter 选它，与 Combobox 相同；用 P2 的窗口用例与 choices 矩阵回归）。
- **对话框的初始焦点**（`p43a-blocker-review` 八个环境）：P2.1 约定，见上表。
- **WebKit 里批量栏出现后工具栏有时不重新排高**（`p43a-tasks-keys-space`，WebKit 暗色桌面）：任务打开、列表区变窄时，批量栏放不下按钮，带上自己的 8px 横向滚动条（42px 高）；装它的 `.tasks-toolbar` 有时仍按没有滚动条时排成 34px，列表于是上移 8px，批量栏的滚动条落进工具栏与列表之间的间隙，不遮挡内容。两棵树都会出现，但交付明显更常出现：第 5 轮的树上参照 12 次中 2 次、交付 12 次中 8 次（重复运行与几何探针，见[重复运行](#重复运行)），第 6 轮的正式运行又是交付一侧。规则（`.tasks-toolbar`、`.tasks-bulkbar`）与页面结构本批都没有改，变的是批量栏里的控件（Orbit 按钮与确认浮层的触发器）；为什么换了控件后更常停在 34px，本批没有查清。只在占位置的经典滚动条下出现（Linux 的 WebKit 模拟；macOS 设成“始终显示滚动条”的 Safari）；iOS 与默认设置的 macOS 用覆盖式滚动条，不占位置。没有在本批修，建议另建任务：让工具栏的高度不取决于批量栏的滚动条何时出现，用几何探针回归。
- **遮罩合成的取整**（4 张，最多 3 级）与 **边缘栅格化**（30 张）。
- **依赖图载入的时机**（3 张，另有按键截图里的依赖图区域）：两棵树代码相同，截图不等依赖图画出，哪一侧先画出随运行而变（第 5 轮是参照没画出，第 6 轮是交付没画出）。
- 第 5 轮的 **WebKit 桌面对话框滚动锁**（4 张）与 **WebKit 手机 382/390**（2 张）在第 6 轮没有了：main 的 WebKit 1px 修复 `9f2f7e9a0`（[34cBi0yt6bFcSmbJFgDPj](orbit-task:34cBi0yt6bFcSmbJFgDPj)）两棵树都带着。
- **语义上的组件约定**（不影响截图）：验收标准卡片与归属卡片的标题是 `section` 里的 `h2`（Orbit `Card`，P4.1）；按钮的可访问名称不带图标名；Spinner 是 `role="status"`；锚定的确认是 `role=dialog`，替换协调者的确认是 `alertdialog`（P1/P2 约定）。
- **留给其它批次的**：index.css 19729（P4.4，见[清单记录](#清单记录)）；公开分享项目页的 AntD `List`（P4.4）；协调者会话页里 `ItemAsCard` 的例外卡片随会话页由 P5.3 迁移，**P5.3 需要回归它**。

## 未确立的部分

- 只在 Linux 上的 Playwright Chromium/WebKit 模拟中比较，没有真机，也没有用读屏软件实测。
- 同提交截图对照只在减少动态效果下做；菜单、对话框、提示的默认动效沿用 P2 公共组件已验证的取值，本批没有逐帧对照。
- 后端是固定 REST 数据，不连真实服务。
- **拖放**：本批页面里没有拖放。拖放库（`@dnd-kit`）只用在 Runner 页的卡片排序（P4.2）和会话侧栏的工作区排序（`TasksSidePanel`，会话工作区）；依赖图（P4.3b）的节点不可拖动，只能拖动画布平移。本批没有改动拖放库的任何用法。验收里的“排序/拖放”在本批由排序体现：任务页的列排序（同提交对照的 “按列排序” 三步）与项目列表的分节顺序（trace 的 `sections`）。
- `Empty.tsx` 的许可说明归 P6 是按先例登记、报告后未收到异议，不是协调者的明确判定（见[清单记录](#清单记录)）。
- 用例结束后的页面错误检查：
  - ResizeObserver 通知（按键用例）：第 5 轮两棵树都有（参照 2 个、交付 1 个，重复运行里参照又有 1 个），第 6 轮没有出现。不是本批引入的。
  - 页头用例的 “access control checks”（重新加载时被取消的后台读取）：交付一侧出现过三次（第 4 轮、第 5 轮 `bcf8c7fff` 那次、第 6 轮），参照一侧没有；第 5 轮的 4 次运行与各 20 次重新加载探针两棵树都没有出现。这些读取与重新加载的代码本批没有改，读取在轮询与删除被拒后的失效重读里随时可能在途；它是否与树有关，现有的次数不足以确立。用户看不到它：它只是导航时 WebKit 控制台里的一条记录。
- 按键截图里工具栏 34px 的情形为什么在交付上更常出现（见[未消除的差异](#未消除的差异)）。
- 第 6 轮没有做重复运行与探针：协调者要求第 6 轮跑完尽快交证据。运行间变化的数据（页面错误、按键截图、几何）来自第 5 轮的树（本批 8 个提交 patch-id 相同）；第 6 轮新出现的三张依赖图时机截图没有单独重复，判断依据是两个方向在第 5、6 轮各出现过，以及依赖图两棵树代码相同。
- 本批的对照用例截图前不等依赖图载入，几张截图的依赖图区域随载入快慢而变。用例是本批的，没有在最终轮之后改它：改了就要整轮重跑；建议以后给它加上等依赖图画出的一步。
- 本批 4 个公共提交与 P4.3b 分支上的提交内容相同（patch-id 相同），两边谁先落地都不影响内容；后落地的一方 rebase 时跳过它们。

## 对照的轮次

各轮都用同一套方法与工具（[对照方法](#对照方法)），参照都是“交付只撤回业务切换”。前几轮的摘要与日志在 [process/](process)（第 4 轮的在 [runs-r4/](runs-r4) 与 [compare-r4/](compare-r4)，第 5 轮的在 [runs-r5/](runs-r5)、[compare-r5/](compare-r5) 与 [repeat-r5/](repeat-r5)），原始运行留在 `/mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1/`（`runs-r2`、`runs-r3`、`runs-r4-killed`、`runs-r4a`、`runs-r4`、`runs5-killed-e6238f318`、`runs5-bcf8c7fff`、`runs5-a5c99e27f`、`runs5`、`repeat-r5`、`probe-*-r5`、`runs6`、`repeat`、`probe-*`），证据判定后清理。

| 轮次 | 基础 / 交付 / 参照 | 结果 | 之后 |
| --- | --- | --- | --- |
| 提前的标准 P0 | 基础 `721e48275`，交付构建（未提交的工作树） | 32 失败 → 修正后 16 失败 → 再修正后 101 通过（[process/early-p0](process/early-p0)） | 找到并处理同权重的层叠冲突，见[层叠顺序](#层叠顺序同权重的页面规则) |
| 第 1 轮 | `721e48275` / `b1eae8397` / `940c565aa` | 参照树上 2 个用例失败（项目列表、项目页头）：有的定位器只适用于 Orbit 一侧。链停下 | 用例改为两棵树通用的定位器（`fold()`、`named()`、卡片按两边类名） |
| 第 2 轮 | `721e48275` / `47d70e7d6` / `90c05f20b` | P4.3a 两棵树各 104 通过；616 张截图 317 张逐字节相同、125 张抗锯齿级、**174 张超出**；trace 864 步，按含义读之后仍有 13 处语义差别（[process/round2](process/round2)） | 逐项实测并修正，见[对照找到并修正的差异](#对照找到并修正的差异) |
| 第 3 轮 | `721e48275` / `1750eca22` / `87475fb04` | P4.3a 两棵树各 104 通过；624 张截图（加了标签选中后的一张）394 / 169 / **61 张超出**，全部归类；trace 872 步只剩 1 处语义差别（参照的 AntD 菜单在观察那一刻还在淡入）；P0 参照、严格比较、交付、标准 P0 各 101 通过，P0 矩阵 252 张 243 / 6 / 3（超出的 3 张是 1–4 个 ≤4 级的边缘像素）（[process/round3](process/round3)） | 起点的标准 P0 跑到一半，运行器回收会话时被停；这时项目 tip 前进到 `a2e58b0ce`，按跟上规则 rebase |
| 第 4 轮（第 1 次运行） | `a2e58b0ce` / `f12984640` / `bbc99d214` | 参照树跑到 38 个用例时会话额度用完，运行被停 | 第 2 次运行 rebase 到 origin/main，从头重跑 |
| 第 4a 轮（第 2 次运行） | `80dd4f134` / `184ae3c5a` / `a4e5fb30f` | P4.3a 两棵树各 104 通过；624 张截图 398 / 174 / **52 张超出**；trace 872 步 2 处语义差别，都是参照的 AntD ⋯ 菜单在 “Share…” 之后的观察那一刻还画在屏上（[process/round4a](process/round4a)） | 代码审阅找到两处键盘回归，链停下；修正后接上 origin/main `3369ee1e0` |
| 第 4 轮 | `3369ee1e0` / `c02e83a5b` / `a9caf9eca` | 完整的一轮（[runs-r4/](runs-r4)、[compare-r4/](compare-r4)）：P4.3a 参照 112 通过、交付 111 通过 1 失败（页头用例结束后的页面错误检查，见[重复运行](#重复运行)），640 张截图 415 / 171 / **54 张超出**，trace 944 步 1 处语义差别（参照的 AntD 菜单在观察那一刻还画着）；P0 参照、严格比较、交付各 101，P0 矩阵 252 张 226 / 24 / 2；标准 P0 交付与起点各 101；合并检查 370 个文件、4791 个测试；overlays 96、controls 32、choices 648；起点对照见[起点对照](#起点对照p41p42-用例与-p32-试点) | origin/main 又前进，按规则跟上；同提交对照与最终检查在第 5 轮重跑 |
| 第 5 轮（停下） | `e6238f318` / `13a19e0e1` / `f4c1e1aba` | 参照树跑了 13 分钟（65 个用例通过、0 失败）后停下 | 协调者转告构建修复已落到项目线，改为在项目 tip 上 rebase、合并 origin/main |
| 第 5 轮（合并方式，停下） | `bcf8c7fff`（本地：项目 tip 与 origin/main `f1837de8e` 的合并）/ `687c8035b` / `c987f4acf` | P4.3a 两棵树各 111 通过、1 失败（参照：WebKit 明色手机页头用例 15 秒内没等到 “Recorded as done” 通知；交付：WebKit 明色桌面页头用例结束后的页面错误检查），P0 参照 101 通过；P0 严格比较跑到一半时运行器回收会话 | 项目线已并入 main（`a5c99e27f`），按规则直接 rebase |
| 第 5 轮（`a5c99e27f`，停下） | `a5c99e27f` / `35227d130` / `890f0995f` | P4.3a 参照 112 通过、交付 111 通过 1 失败（WebKit 明色手机按键用例结束后的页面错误检查：`ResizeObserver loop completed with undelivered notifications`）；640 张截图 402 / 184 / **54 张超出**，分类与第 4 轮相同；trace 944 步 2 处语义差别（参照的 AntD 菜单在观察那一刻还画着）；P0 参照、严格比较、交付各 101，P0 矩阵 236 / 15 / 1；标准 P0 交付与起点各 101；合并检查 370 个文件、4807 个测试；overlays 96；controls 跑到一半 | main 又前进（子菜单位置修复改到公共组件），按规则 rebase，从头重跑 |
| 第 5 轮 | `5b794d643` / `de2426d9c` / `9acb176da` | 日志在 [runs-r5/](runs-r5)，比较在 [compare-r5/](compare-r5)：P4.3a 参照 110 通过 2 失败、交付 111 通过 1 失败（都是按键用例结束后的 ResizeObserver 页面错误）；640 张截图 408 / 178 / **54 张超出**，类别与第 4 轮相同；trace 944 步 1 处语义差别（参照的 AntD 菜单在观察那一刻还画着）；P0 参照、严格比较、交付各 101，P0 矩阵 252 张 220 / 30 / 2；标准 P0 交付与起点各 101；合并检查 370 个文件、4807 个测试；overlays 96、controls 32；Swift 3475 个 0 失败；choices 跑到 528/648（0 失败）时运行器回收会话被停。重复运行与探针跑在这一轮的树上（[repeat-r5/](repeat-r5)） | main 又前进 40 个提交，其中 WebKit 1px 修复改到 Toast，按规则再跟一次、重跑 |
| **第 6 轮** | `76d41066d` / `d9e720533` / `534e4831b` | 见[对照结果](#对照结果) | main 改了本批的 `ProjectsPage.tsx` 一行导航：rebase 到 `19c760ae4`（交付 `dac57bade`），只重跑受影响的检查 |

## 复现

```bash
# 第 6 轮：三棵树（都在 /mnt/data），然后一次跑完同提交对照与最终检查
scripts/make-trees.sh d9e720533 a2040156c 76d41066d   # 参照 534e4831b = 交付撤回业务切换；起点 origin/main 76d41066d
scripts/formal6.sh                 # 同提交对照与最终检查，日志在 /mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1/runs6/<name>.txt
scripts/analyze6.sh                # P4.3a 与 P0 矩阵两对的比较和分类
python3 -I scripts/classify6.py /mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1   # 超出截图的逐张归类，并核对每类张数
# 重复运行与探针（在第 5 轮的树上跑，输出在 v1/repeat-r5、v1/probe-*-r5；第 6 轮没有跑）：
scripts/repeat.sh && python3 -I scripts/repeat-analyze.py /mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1
scripts/probe-reload.sh; scripts/probe-keys.sh; scripts/probe-geom.sh ref; scripts/probe-geom.sh del   # 探针（文件在 scripts/probe/）
scripts/swift-check.sh d9e720533   # OrbitKit 全量 swift test（docker swift:6.1）
# 第 5 轮：scripts/make-trees.sh de2426d9c 5f310fb76 5b794d643 && scripts/formal5.sh && scripts/analyze5.sh
# 第 4 轮（另含 choices 矩阵与起点对照）：
scripts/make-trees-r4.sh c02e83a5b ad5e0c989 3369ee1e0 && scripts/formal.sh && scripts/analyze.sh
# P4.3a 用例单独运行（在要比较的树的 src/web 下）：
P43A_SNAPSHOTS=<dir> P43A_OUTPUT=<dir> npx playwright test --config ui-migration/p43a.config.mjs --update-snapshots=all
# 清单（审计、--check-owners、08b 记录核对、关闭对照）：
scripts/audit.sh
# 清单记录 2026-10-09b（在仓库根目录；审计是 dac57bade 上的扫描）：重新生成应逐字节相同，再核对
python3 -I docs/evidence/base-ui-migration/inventory-delta/build-record-09b.py docs/evidence/base-ui-migration/p4.3a/checks/record-09b-audit.json | cmp - docs/evidence/base-ui-migration/inventory-delta/2026-10-09b.json
node docs/evidence/base-ui-migration/inventory-delta/verify-record.mjs docs/evidence/base-ui-migration/p4.3a/checks/record-09b-audit.json 2026-10-09b.json
# 键盘修正的红绿（在交付的工作树里；补丁是修正的生产代码部分）：
scripts/keys-red-green.sh scripts/keys-fix.patch
# 本目录的副本由 scripts/collect.sh 从 /mnt/data 复制（报告去掉附件正文）。
```
