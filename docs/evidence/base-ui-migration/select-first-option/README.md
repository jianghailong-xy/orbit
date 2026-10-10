# P2 跟进：Select 无选值时打开即高亮第一项，对话框 Close 的悬停底色对齐旧 AntD

本目录服务于任务 [P2 跟进：Select 无选值时打开即高亮第一项，对话框 Close 的悬停底色对齐旧 AntD](orbit-task:34coPBk43ULRuisicUTAy)（项目 [Orbit Web 组件迁移](orbit-project:34ZZeq0e3IR65GVm2kAs7)，验收条目 key `1BvO6hYrlFnU60JqxQPUHt`，P2）。差异来源见 [P4.3a「未消除的差异」](../p4.3a/README.md#未消除的差异) 与 P4.3b 的 `p43b-graph-full`、[probe-close-hover](../p4.3b/probes/probe-close-hover.browser.mjs)。本轮由 Claude Opus 5.5 执行；没有推送 main 或项目分支。

## 结论

- **Select**：没有选项持有 value（`null`，或 value 不在选项里）时，用指针（手机上是轻点）打开即高亮第一个可用选项，Enter 选它；有选值时仍高亮当前值；禁用项被跳过。与旧 AntD（rc-select 1.10.1 的 `defaultActiveFirstOption`）一致。键盘打开（↓、Enter、Space）本来就与旧 AntD 一致，没有改；↑ 是另一处早就存在的差异，见[键盘打开](#键盘打开)。
- **对话框 Close**：Orbit 对话框自己的 Close 悬停底色改为明 `rgba(0, 0, 0, 0.06)`、暗 `rgba(255, 255, 255, 0.12)`，八个环境都与旧 AntD 弹窗相同；静止、按下、颜色、尺寸本来就相同。控件共用的悬停底色（4%/8%）、按下底色和 Drawer 的 Close 都没有改。
- **常驻用例修复前失败、修复后通过**（同一份用例，八个环境）：`choices-first-option` 参照 80/96（失败的 16 个正是两种无值的指针打开 × 8 个环境），交付 96/96；`overlays-close-hover` 参照 0/8（只差悬停底色），交付 8/8。新增 13 个 Select 单测：参照树上其中 11 个失败，交付全部通过。
- **真实页面**：P4.3a 的重绑对话框（`p43a-coordinator-rebind`）在 P4.3a 找到差异的那一块（列表第一项）现在与 P4.3a 的旧 AntD 参照截图相同（6 个环境逐像素相同，Chromium 两个手机环境选项行内最多差 1 级）；参照树与 P4.3a 当时的 Orbit 截图在八个环境都逐像素相同。重绑、选择工作区、链接已有到期日时的 Expires、没有建议时的 Suggested 四处，交付都打开在第一项、Enter 选中它，参照都什么也不高亮、Enter 不选。P4.3a 协调者用例的 48 张截图里，除了这 8 张重绑截图的第一项，其余 38 张逐字节相同、2 张抗锯齿级。
- **回归**：合并检查（Web 构建与 Vitest 380 个文件、4974 个测试）全部通过；标准 P0 两棵树都是 101 通过、11 跳过，与记录的基线相同，**没有因本批按设计变化的 P0 截图**；overlays 入口 184/184；choices 入口 773 通过，3 个 Menu/子菜单用例在主机全局 OOM 期间超时，单独重跑两棵树都通过。
- **与后来落地的 P4.4 合并**（项目 tip `d580e572d`，临时合并 `b28e5ae6f`，不推送）：overlays 184/184、choices 776/776、合并检查 386 个文件 5051 个测试全部通过；标准 P0 93 通过、11 跳过、8 个失败，8 个都是设置页，**项目 tip 单独跑也是同样的 8 个、截图逐字节相同**：main 的 `83671b995` 给设置页加了 Session recaps 开关（P0 漂移，报告协调者）。
- **P2 键盘窗口用例**（文件与断言未改）：select-keys 两棵树各 1104/1104；keyboard-window 两批的 Select 序列两棵树逐序列结果相同（37/37、49/49）；菜单、子菜单、Popconfirm、对话框的序列在交付上 66/66、336/336。Orbit 一侧 burst 与 paced 不同的组合恰好是 P2 第 2 批记为「只记录，不改」的那些。
- **[报告协调者](#报告协调者)**：Drawer 的 Close 有同类差异（悬停 4%/8% 对旧 AntD 6%/12%），没有改；Select 清除图标直接悬停时的颜色、↑ 打开、指针离开列表后的高亮三处其他差异。`audit-antd.mjs --check-owners` 在本分支上报出的 2 个 main 带来的未归属使用点，P4.4 已在项目线上处理。

## 提交

| 角色 | 提交 | 内容 |
| --- | --- | --- |
| 起点 | `9e9787f7969edc460b69848cfc160d358b25a953`（origin/main，已含项目 tip `baad1a557`） | — |
| Select | `332fcb1eb93f2b637e87e42103547598f5e28249` | `Select.tsx`、`Select.test.tsx`（+13 个单测）、`ChoicesFixture.tsx`（只在带参数时生效的样例参数）、`ui-migration/choices-first-option.browser.mjs`、`ui/README.md` 一句 |
| Close | `a755f816a1800280719ecabf060bd6b7ad271776` | `Overlay.css` 一条规则、`foundation.css` 一个变量（明暗各一）、`ui-migration/overlays-close-hover.browser.mjs`、`ui/README.md` 一句 |
| 证据 | 本目录所在提交 | 只新增本目录 |

两处改动各自独立提交、带着自己的用例，可以分别回退。

## 跟上 origin/main

| 时间（UTC） | 基础 | 做法 |
| --- | --- | --- |
| 10-09 19:40 开工 | 项目 tip `baad1a557`（不在 main 里） | 按作业指导在项目 tip 上合并 origin/main `8698b0a20`（只改 apiserver），得 `10ef55456` |
| 10-09 20:39 最终轮之前 | origin/main `9e9787f79`（`e5404b73b` 把项目线并入 main，项目 tip 已在 main 里） | 按规则直接 rebase 到 origin/main，两个提交的 patch 不变；main 自 `10ef55456` 起改了 11 个文件，没有 `src/web`、`src/shared` |
| 10-10 00:2x 最终轮中 | origin/main `56c21bdd2` | 按规则先干跑：`git merge-tree --write-tree a755f816a origin/main` 退出 0（树 `790e5dad3`）。main 的 246 个文件（`src/web`、`src/shared` 下 44 个：Infrastructure 与 Provider 页及其测试、`WorkspaceView`、`Transcript`、决策卡片、这些页面在 `index.css` 里的新规则等）没有本批的文件，没有 `ui/` 公共组件、Toast 或弹层；`index.css` 的改动没有一条涉及 Select、选择列表、弹层或对话框；这些文件里 `<Select` 的数量没有变（唯一用到它的 `ProviderConnectPage` 仍是 1 个，值总是一个 runtime）。所以不再跟、不重跑，由落地的合并检查兜底 |
| 10-10 02:3x 交证据前 | origin/main `012f8a20c`（起点之后 139 个提交）；项目 tip `d580e572d`（P4.4 落地，不在 main 里） | [scripts/proof.sh](scripts/proof.sh)：对 origin/main 干跑退出 0，main 没有改本批的文件、`ui/` 公共组件、Toast，`index.css` 没有涉及选择列表、弹层、对话框的行；对项目 tip 干跑也退出 0（只有 `ui/README.md` 两边各加一句）。P4.4 改了本批依赖的全局层（`Floating.ts` 的 `useWholePixelOffsets` 多了一个可选参数 `pointAt`，Select 用的 `useDropdownPlacement` 不传它；Popover、Tooltip 新增的都是可选属性；`index.css` 是 Wiki 页面自己的规则），按规则不 rebase，在临时合并树上跑标准 P0、两个入口和合并检查，见[与 P4.4 的临时合并](#与-p44-的临时合并) |

## 改动

### Select：无值打开时第一项高亮

旧 AntD 的单选来自 rc-select 1.10.1（`@rc-component/select/es/OptionList.js`）：

- `activeIndex` 初值是第一个可用项（`getEnabledActiveIndex(0)` 跳过分组标题和禁用项，第 92 行），选项个数或搜索词变化时也回到它（第 110 行）；
- 打开时只有恰好一个值、并且能在选项里找到，才把高亮移到这个值（第 129 行）；值为空，或值不在选项里，高亮就停在第一个可用项；
- Enter 和 Tab 选当前高亮项（第 199 行起）。

Base UI 1.8.0 的 Select 只在两种情况下打开即高亮：有选中项（`floating-ui-react/hooks/useListNavigation.mjs:180`），或由键盘打开（`:221`、`:238`）。用指针打开、又没有选中项时什么也不高亮，焦点落在列表本身，Enter 没有任何作用，这就是 P4.3a 看到的差异。Base UI 的 Select 没有对应的选项（`alignItemWithTrigger` 时它自己会把高亮放到第 0 项，`select/popup/SelectPopup.mjs:303`，但 Orbit 的列表不对齐触发器，而且那里不跳过禁用项）。

做法（`Select.tsx`）：列表每次打开记一个标记（`useLayoutEffect` 跟随 `layer.open`），焦点第一次进入列表时清掉它；若这一次焦点落在列表本身、并且没有选项持有当前值，就把焦点交给第一个可用选项（`[role="option"]:not([data-disabled])`）。Base UI 的列表是非 virtual 的，焦点所在的选项就是高亮项：选项自己的 `onFocus` 同步高亮（`useListNavigation.mjs` 的 `syncCurrentTarget`），选项的 `tabIndex` 随之变为 0（`select/item/SelectItem.mjs:125`），Enter 经选项的 `useButton` 提交。Orbit 只决定「初始焦点给谁」，导航、提交、禁用、滚动仍是 Base UI 自己的代码。

- 只处理「焦点第一次落在列表本身」：键盘打开、有选中项时焦点直接进到选项，标记被清掉，什么也不做；指针离开选项后 Base UI 把焦点交回列表时，标记已经清掉，不会把高亮拉回第一项（单测 “opens on the first option only as it opens” 锁定；变异检查：去掉标记，它就失败）。
- 「没有选项持有 value」包括 value 不在选项里，rc-select 也是这样（只在找得到值时移动高亮）。生产里 `ShareModal` 的 Expires 在链接已有到期日时值是 `until`（不是选项），任务面板的 Suggested 在没有建议时值是 `null`（选项里的 “No suggestion” 是 `''`），这两处与重绑、选择工作区对话框一样恢复了旧行为（见[真实页面](#真实页面)）。Suggested 选中 “No suggestion” 时，`next || null` 与原值相同，不发请求。
- P2 的键盘窗口修复（`p2-select-keys`）：列表已打开、焦点还在触发器上时到达的 ↓/↑/Enter 交给「焦点正要去的元素」。原来交给高亮项或列表本身；现在先聚焦它，再把键派发给聚焦后的元素：若列表本身把焦点交给了第一项，键就落在第一项上（窗口里的 Enter 选它，↓ 从它移到下一项）。有高亮项时与原来完全相同。

### 键盘打开

键盘打开沿用 Base UI，本批没有改：↓、Enter、Space 打开在第一个可用项，有选值时在当前值，与 rc-select 相同（`choices-first-option` 的 ↓/Enter/Space 用例在参照树上就通过）。

↑ 不同：rc-select 1.10.1 把 ↑ 排除在打开键之外（`utils/keyUtil.js` 的 `isValidateOpenKey`：“Arrow keys - should not trigger open when navigating in input”），旧 AntD Select 关闭时按 ↑ 什么也不做（探针在四个桌面环境、三种情形里都读到列表没有打开）；Base UI 的 ↑ 打开列表，无值时在最后一个可用项（`useListNavigation.mjs:238`）。这是打开键的差异，不是「打开后高亮哪一项」，P2 时就已存在；`Select.test.tsx`（[P2/P3 补强](orbit-task:34blRfxvNoD5uIuXNTiEJ)写的 Select 窗口回归，本历史里是 `7820aee1a`）锁定了「无值时 ↑ 打开在 7 days」，验收要求这批键盘窗口用例原断言不改，所以本批没有动它，报告协调者。

### 对话框 Close 的悬停底色

- `foundation.css` 新增 `--orbit-dialog-close-hover-bg`：明 `rgba(0, 0, 0, 0.06)`、暗 `rgba(255, 255, 255, 0.12)`，即旧弹窗 Close 的悬停底色（P4.3b 的 probe-close-hover 实测值，本批 `overlays-close-hover` 再测相同）。
- `Overlay.css`：`:where(.orbit-dialog > .orbit-overlay-header) > .orbit-overlay-close:hover:not(:disabled)` 用这个变量。`:where()` 让它与共用的悬停规则同一权重、排在它之后、排在按下规则之前：悬停时取新底色，按下时仍是共用的按下底色（探针：按下时两边相同）；子选择器只命中对话框自己标题行里的 Close，嵌在对话框里的 Drawer 不受影响。`--orbit-control-hover-bg`、Drawer 的 Close、ConfirmDialog（没有 Close）都没有改。

## 常驻用例

- [`src/web/ui-migration/choices-first-option.browser.mjs`](../../../../src/web/ui-migration/choices-first-option.browser.mjs)（choices 入口）：同一位置分别打开旧 AntD Select 与 Orbit Select（choices fixture 的 `sample=select`），三种情形（无值、有值 `7`、无值且第一项禁用）× 四种打开方式（指针：桌面点击、手机轻点；↓、Enter、Space），记录列表里每个选项是否高亮及其底色，再按 Enter，记录值、列表是否关闭、焦点是否回到字段，两边逐项相等，并要求旧 AntD 打开在预期的项上。12 个用例 × 8 个环境。
- [`src/web/ui-migration/overlays-close-hover.browser.mjs`](../../../../src/web/ui-migration/overlays-close-hover.browser.mjs)（overlays 入口）：overlays fixture 的旧 AntD 弹窗与 Orbit 对话框（同一对外观样例），Close 静止与悬停时的底色、图标颜色、圆角、尺寸，两边相等，并要求旧 AntD 的悬停底色是明 6%、暗 12%。8 个环境。
- `ChoicesFixture.tsx` 的样例新增 `value`（`none` 或一个选项值，显示在 `Sample value` 里）与 `options=first-disabled`，不带这两个参数时样例与原来完全相同（已有用例与 P2 探针都不带）。旧 AntD 样例的无值用 `undefined`，与被替换的对话框一样（P4.3a 之前是 `useState<string | undefined>(undefined)`）。
- [`Select.test.tsx`](../../../../src/web/src/components/ui/Select.test.tsx) 新增 “Select opened by the pointer”：6 个序列（无值、第一项禁用、值不在选项里、有值）各跑焦点已进列表与窗口内两遍，再加一个只在打开时生效的检查，共 13 个。原有 26 个未改。

### 修复前失败、修复后通过

| 用例 | 参照树 `f492dbb30`（只撤回本批的三个产品文件） | 交付 `a755f816a` |
| --- | --- | --- |
| `Select.test.tsx` + `keyboardWindow.test.tsx` | **11 失败、86 通过**：失败的正是新增的 11 个（两个有值的序列两边都通过，本来就不该变）；原有 26 个 Select 单测与 58 个键盘窗口单测全部通过 | **97/97** |
| `choices-first-option` | **80/96**：失败的 16 个是「指针打开、无值」与「指针打开、无值且第一项禁用」× 8 个环境；Orbit 一侧什么也没高亮，Enter 后值仍是 `null`、列表开着、焦点不在字段上（[runs/f-first-option-ref.txt](runs/f-first-option-ref.txt)） | **96/96**（[runs/f-first-option-del.txt](runs/f-first-option-del.txt)） |
| `overlays-close-hover` | **0/8**：每个环境只差悬停底色，旧 AntD 明 0.06 / 暗 0.12，Orbit 0.04 / 0.08（[runs/f-close-hover-ref.txt](runs/f-close-hover-ref.txt)） | **8/8**（[runs/f-close-hover-del.txt](runs/f-close-hover-del.txt)） |

逐环境的数值在 [compare/first-option.json](compare/first-option.json) 与 [compare/close-hover.json](compare/close-hover.json)。两种无值指针打开的列表截图（两个系统、两棵树、八个环境）在 [shots/first-option/](shots/first-option/)，Close 悬停的局部截图在 [shots/close-hover/](shots/close-hover/)（`<环境>.antd.png`、`<环境>.orbit.png`）。开发中（rebase 之前、同样的 Select 补丁）还在工作树里做过：撤掉修复时 11 个新单测失败、去掉「只在打开时」的标记时那个检查失败。

## 同提交对照

两棵树在 `/mnt/data/tmp/34coPBk43ULRuisicUTAy/`（[scripts/make-trees.sh](scripts/make-trees.sh)）：交付 `del` = `a755f816a` 的完整检出；参照 `ref` = `a755f816a` 上把 `Select.tsx`、`Overlay.css`、`foundation.css` 换回起点 `9e9787f79` 的本地提交 `f492dbb30`（没有推送），稀疏检出 `src/web`、`src/shared`、`scripts` 与 `docs/evidence/base-ui-migration`。新用例、fixture 扩展和单测两棵树相同。

### 用到无初值 Select 的页面

`grep` 生产代码里所有 `<Select`（9 个文件）后逐个看初值：

| 页面 | 初值 | 会不会「没有选项持有 value」 |
| --- | --- | --- |
| 项目页：重绑协调者工作区（`ProjectsPage`） | `null` | 会，打开时总是 |
| 项目页：选择协调者打开的工作区（`ProjectsPage`） | 建议的工作区，没有时 `null` | 没有建议时会 |
| 任务面板：Suggested（`TaskDetailPanel`） | `modelHint ?? null`，选项里的 “No suggestion” 是 `''` | 没有建议时会 |
| 分享：Expires（`ShareModal`） | 选过的值，否则有到期日时 `until`、没有时 `never` | 链接已有到期日、本次还没选时会（`until` 不是选项） |
| Runner：Keep free（`RunnerDetailPage`）、项目：升级时限（`ProjectRunSettings`） | 当前值，不在档位里时把它加进选项 | 不会 |
| 启动卡片：Run tasks land on、账号、Provider runtime、设置页默认模式 | 总是选项之一 | 不会 |

### P4.3a 协调者用例

P4.3a 的协调者用例（`p43a.browser.mjs` 的 “the coordinator: its menu and replace question, rebinding, choosing where it opens”，生产构建）在两棵树上各跑一次、各写截图：8/8 与 8/8（[runs/f-p43a-coordinator-ref.txt](runs/f-p43a-coordinator-ref.txt)、[runs/f-p43a-coordinator-del.txt](runs/f-p43a-coordinator-del.txt)）。48 张截图（[compare/p43a-shots.json](compare/p43a-shots.json)）：

- **38 张逐字节相同**；
- **2 张抗锯齿级**：`p43a-coordinator-landing`（选择工作区对话框，列表没有打开）Chromium 两个桌面环境，3 个、9 个像素，最多 1 级；
- **8 张超出：都是 `p43a-coordinator-rebind`**，>2 级的像素全在列表第一项那一行（桌面 `408,272–872,304`，手机 `36,280–354,312`），即新加的高亮；参照左、交付右的裁切在 [shots/p43a/](shots/p43a/)。

与 P4.3a 的旧 AntD 截图比（[compare/rebind-vs-antd.json](compare/rebind-vs-antd.json)，区域取 P4.3a 自己的 AntD/Orbit 两张截图相差 >2 级的范围再外扩 8px，即列表第一项；P4.3a 的截图是 P4.3a 第 6 轮的，页面其他部分随后被 main 改过，所以只比这一块）：

| 环境 | 交付 vs P4.3a 的旧 AntD | 参照 vs P4.3a 的 Orbit |
| --- | --- | --- |
| Chromium 暗/明桌面，WebKit 暗/明桌面，WebKit 暗/明手机 | 逐像素相同 | 逐像素相同 |
| Chromium 暗色手机 | 抗锯齿级（最多 1 级） | 逐像素相同 |
| Chromium 明色手机 | 选项行内最多 1 级；行下沿 8 个像素 3 级（P4.3a 自己的 AntD/Orbit 两张在这里也不同：它记录的这个环境的遮罩取整） | 逐像素相同 |

逐环境四列对照（P4.3a 的旧 AntD、P4.3a 的 Orbit、本批参照、本批交付，2 倍放大）：[shots/rebind-first-option.png](shots/rebind-first-option.png)。

### 真实页面

页面探针（[probes/probe-pages.browser.mjs](probes/probe-pages.browser.mjs)，生产构建与 P4.3a、P3.2 的固定数据）在两棵树、八个环境里用指针打开四个选择器，记下高亮项，按 Enter，再读字段（[compare/pages.json](compare/pages.json)，Chromium 明色桌面的截图在 [shots/pages/](shots/pages/)）：

| 选择器 | 参照（八个环境相同） | 交付（八个环境相同） |
| --- | --- | --- |
| 重绑工作区（值 `null`） | 不高亮；Enter 后仍是 Workspace，列表开着 | 高亮 Orbit baseline (current)；Enter 选它、列表关闭、Rebind 可按 |
| 选择工作区（值 `null`） | 不高亮；Enter 不选 | 高亮 Orbit baseline；Enter 选它 |
| Expires（链接 7 天后到期，值 `until`，字段显示 Until Oct 5） | 不高亮；Enter 不选 | 高亮 Never；Enter 选它 |
| Suggested（没有建议，值 `null`） | 不高亮；Enter 不选 | 高亮 No suggestion；Enter 选它（值不变，不发请求） |

## P0

标准 P0（`npm run test:ui-migration`）：交付 101 通过、11 跳过（[runs/f-p0-del.txt](runs/f-p0-del.txt)），参照同样 101 通过、11 跳过（[runs/f-p0-ref.txt](runs/f-p0-ref.txt)），与记录的基线相同；每张截图对照的期望来源在 [runs/f-p0-del.expected-sources.json](runs/f-p0-del.expected-sources.json)。P0 场景里没有打开 Select 的步骤（`page-scenarios.mjs` 只在设置页截下关闭的 Select），也没有悬停对话框 Close 的步骤，所以**没有因本批按设计变化的 P0 截图**，不需要登记。

## choices 与 overlays 入口

- overlays 入口（`overlays*.browser.mjs`，八个环境）：184/184（[runs/f-overlays-del.txt](runs/f-overlays-del.txt)），含新的 Close 用例。
- choices 入口（`choices*.browser.mjs`，八个环境）：773 通过、3 个失败（[runs/f-choices-del.txt](runs/f-choices-del.txt)）。3 个都是 90 秒超时，都在 Menu/子菜单的用例里，都在 Chromium 手机环境：`choices-submenu-geometry` 的「页面中间的子菜单」（Chromium 明色手机，等的是**旧 AntD** 的子菜单，最后报 `Internal server error, session closed`）、`choices-first-frame` 的 menu 与 submenu（Chromium 暗色手机）。这次运行期间主机两次全局 OOM（21:35、21:36Z），负载 30–80。单独重跑，两棵树都通过：子菜单几何 4/4 与 4/4（[runs/f-rerun-submenu-geometry-del.txt](runs/f-rerun-submenu-geometry-del.txt)、[-ref](runs/f-rerun-submenu-geometry-ref.txt)），第一帧 menu 与 submenu 2/2 与 2/2（[runs/f-rerun-first-frame-del.txt](runs/f-rerun-first-frame-del.txt)、[-ref](runs/f-rerun-first-frame-ref.txt)）。本批没有改 Menu、子菜单或它们的定位。
- choices 入口里本批的新用例与原有的 Select 用例（箭头、Enter、清除、空、禁用、空字符串值，弹层与 Popover 里的 Select，live theme 等）全部通过。

## P2 键盘窗口用例

文件、断言、节奏都没有改，按 P2 的做法在 Chromium 上跑（键的排队是 DevTools 协议的功能，WebKit 用例自己跳过）。范围按本批的改动确定：

| 套件 | 范围 | 参照 | 交付 |
| --- | --- | --- | --- |
| `p2-select-keys/select-keys-burst` | 全部（每个环境 276 个），四个 Chromium 环境（命令没有限制环境，比 P2 只跑 chromium-dark-desktop 多） | 1104 通过 | 1104 通过 |
| `p2-keyboard-window/keyboard-window` 的 Select 序列 | 37 个目标×序列，各 3 次 burst、3 次 paced，chromium-dark-desktop | 222 通过 | 222 通过 |
| `p2-keyboard-window-2/keyboard-window-2` 的 Select 序列 | 49 个目标×序列，各 3+3（`KW2_BURST/KW2_PACED`） | 294 通过 | 294 通过 |
| 第 1 批的其余序列（菜单） | 33 个，各 1+1 | — | 66 通过 |
| 第 2 批的其余序列（菜单、子菜单、Popconfirm、对话框） | 168 个，各 1+1 | — | 336 通过（第一次在 105 个样本后被内核的全局 OOM 杀掉，01:07:18Z，原样重跑；被杀的日志在 [runs/runs-killed/](runs/runs-killed/)） |

结果（[compare/keyboard.json](compare/keyboard.json)）：

- **两棵树逐序列相同**：keyboard-window 37/37、keyboard-window-2 49/49（第 2 批的结果串连同焦点位置、打开的弹层一起比）。select-keys 12 组里 11 组相同，剩下一组是**旧 AntD** 的 search 样例：参照树上 80 次 burst 里 1 次结束时列表仍开着，交付 80 次都关了；这是两棵树完全相同的 AntD 代码在负载下的一次时序。
- **burst 与 paced**：Orbit 一侧不同的组合是 Select 的 ↓Home⏎、↓End⏎（字段与样例，4 个）与 ↓Space（从空值起，1 个），菜单 ⏎Space（2 个），Popconfirm ⏎⏎、⏎Space、⏎Shift+Tab（3 个），正是 [p2-keyboard-window-2](../p2-keyboard-window-2/README.md) 第 22–26 行记为「只记录、不改（旧 AntD 也不处理）」的组合（那里的 ConfirmDialog 两个在 P2 的修复后已与 paced 一致，这里也一致）；P2 第 2 批修过的组合在交付上 burst 与 paced 全部一致。其余不同的都在旧 AntD 一侧（AntD 自己的窗口）。

## 合并检查

交付树上 `npm run build -w @orbit/web && npm run test -w @orbit/web`：构建通过（`tsc -b && vite build`），Vitest 380 个文件、4974 个测试全部通过（[runs/f-merge-check-del.txt](runs/f-merge-check-del.txt)）。

另：apiserver 里扫描整个仓库的 42 个非 pg spec（`git ls-files`、`readdirSync` 一类，项目的合并检查不跑，落到 main 时会跑）在提交了本目录的树 `4666dfaaf`（与本提交只差这一段说明）上 344/345 通过（后台作业 `bgj_c64353a30e78`；输出没有放进本目录：测试名里引用了这些 spec 要在整个仓库里查找的已删除标识符，放进来它们就会失败）。唯一失败的是要求完整 git 历史的断言（“this census reads git history: check out with full history”）：本机共用的仓库是 shallow（`git rev-parse --is-shallow-repository` 为 `true`），任何一棵树都会这样，与内容无关；按内容扫描的检查全部通过。

## 与 P4.4 的临时合并

最终轮之后，P4.4（[34Za39J4QY3kDa5p2Wsau](orbit-task:34Za39J4QY3kDa5p2Wsau)）落到项目线（tip `d580e572d`，其中 `cb35d126a` 合并了 main），改了本批依赖的全局层：`Floating.ts`（`useWholePixelOffsets` 多了可选参数 `pointAt`，只有 Popover 传；Select 用的 `useDropdownPlacement` 不传它）、`Popover.tsx`、`Tooltip.tsx`（新增可选属性）、`index.css`（Wiki 页面自己的规则，没有一条改 Close 的悬停或 Select 的高亮）。按作业指导「只改到本批依赖的全局层时不 rebase，在临时合并树上跑标准 P0 和本批入口」，用 `git merge-tree` + `commit-tree` 把本分支 `ea95fb02d` 合到项目 tip 上，得本地提交 `b28e5ae6f`（不推送；与项目 tip 只差本批的 8 个文件，合并没有冲突，`ui/README.md` 两边各加的一句都在），在交付树里检出后跑（[scripts/tmp-merge.sh](scripts/tmp-merge.sh)，日志与精简报告在 [runs/tmp-merge/](runs/tmp-merge/)）：

| 检查 | 结果 |
| --- | --- |
| overlays 入口，八个环境 | 184/184（含 `overlays-close-hover`） |
| choices 入口，八个环境 | **776/776**（含 `choices-first-option`；最终轮那 3 个超时这次都没有出现） |
| 合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web` | 构建通过，Vitest 386 个文件、5051 个测试全部通过 |
| 标准 P0 | 93 通过、11 跳过、**8 个失败：都是设置页（`settings`），八个环境各一** |

设置页的 8 个失败与本批无关：**项目 tip `d580e572d` 单独跑标准 P0，结果相同**（93 / 11 / 8，同样的 8 个，[runs/tmp-merge/t-p0-project-tip.txt](runs/tmp-merge/t-p0-project-tip.txt)），两次运行的设置页截图在八个环境里**逐字节相同**。原因是 main 的 `83671b995`（2026-10-10，“the session list shows the server's recap, behind one account switch”）在设置页加了 Session recaps 开关，下面的内容整体下移（桌面约 1.3 万个像素，手机约 2400 个），经 `cb35d126a` 进了项目线；它不在本批验证的起点 `9e9787f79` 里，所以最终轮的 P0 是全绿的。期望（左）与实际（右）的裁切：[shots/p0-settings-main-drift.png](shots/p0-settings-main-drift.png)。按 [p0-drift](../p0-drift/README.md) 的维护规则，这是 main 漂移，由协调者另建登记任务处理，本批没有登记、没有改 P0 场景。其余 P0 截图在合并树上都与期望相同，所以本批没有让任何 P0 截图变化。

## 其他图标按钮的悬停底色

探针（[probes/probe-icon-hover.browser.mjs](probes/probe-icon-hover.browser.mjs)，交付树，四个桌面环境）读 fixture 里每一对旧 AntD/Orbit 图标按钮的静止、悬停、按下（会在按下时动作的清除与移除按钮只读静止与悬停）时的底色与颜色（[compare/icon-hover.json](compare/icon-hover.json)）：

| 图标按钮 | 结果 |
| --- | --- |
| 对话框 Close | 静止、悬停、按下都相同（本批） |
| **右侧 Drawer 的 Close、底部 Drawer 的 Close** | **悬停底色不同（同类差异）**：旧 AntD 明 `rgba(0, 0, 0, 0.06)` / 暗 `rgba(255, 255, 255, 0.12)`，Orbit `0.04` / `0.08`（共用的 `--orbit-control-hover-bg`）；静止、按下、颜色相同。按任务要求没有一并改 |
| 纯图标按钮（`button-icon-only`）、代码复制图标、输入框清除图标、多选标签的移除 | 都相同 |
| Select/Combobox 的清除图标 | 底色：旧 AntD 透明，Orbit 是控件自己的底色（`--bg-raised`，与背后的控件同色，看不出来）；**直接悬停在图标上时**：旧 AntD 颜色不变（`colorIcon`，本主题下与静止相同的 `#8f959e`），Orbit 变深为 `--text-2`。是颜色的差异，不是悬停底色；悬停整个控件时两边相同（choices 的状态用例已比） |

## 报告协调者

1. **Drawer 的 Close 悬停底色**与对话框的 Close 同类：旧 AntD 6%/12%，Orbit 4%/8%，没有改（任务要求不扩大范围）。若要对齐，可以给 `.orbit-drawer` 的 Close 用同一个 `--orbit-dialog-close-hover-bg`（变量名届时可改为不带 dialog 的）。
2. **Select 清除图标直接悬停时的颜色**：Orbit 变深，旧 AntD 不变（见上表）。
3. **↑ 打开**：旧 AntD 关闭时 ↑ 不打开，Orbit（Base UI）↑ 打开在最后一个可用项（无值）或当前值；P2 的 `Select.test.tsx` 锁定了 Orbit 的行为，本批没有改。
4. **指针离开列表之后**：探针（[probes/probe-select-openers.browser.mjs](probes/probe-select-openers.browser.mjs)，[compare/select-openers.json](compare/select-openers.json)）在 Chromium 两个桌面环境、三种情形里都读到：悬停某一项再把指针移出列表，旧 AntD 保留那一项的高亮，Enter 选它；Orbit（Base UI 的 `resetOnPointerLeave`）清掉高亮，Enter 不选。与有没有值无关，本批之前就存在。WebKit 里 Playwright 的悬停没有被 Orbit 列表当成移动（Base UI 在 WebKit 忽略零位移的 mousemove），所以 WebKit 没有确立。
5. **↓ 遇到禁用项**：旧 AntD 跳过禁用项并从末尾绕回开头，Orbit 停在禁用项上（P2 已知，`Select.test.tsx` 的注释写明 Base UI 的 Select 不传禁用索引）。
6. **清单**：`audit-antd.mjs --check-owners` 的 2 个未归属使用点已由 P4.4 处理，见[清单复扫](#清单复扫)，不需要再做什么。
7. **P0 漂移**：项目 tip `d580e572d` 上标准 P0 的设置页在八个环境都失败，起因是 main 的 `83671b995`（设置页的 Session recaps 开关），见[与 P4.4 的临时合并](#与-p44-的临时合并)。需要按 p0-drift 规则另建登记任务。

## 清单复扫

`node src/web/scripts/audit-antd.mjs --check-owners`（交付分支）：0 个待定，2 个未归属：`src/web/src/App.managedRunner.test.tsx`、`src/web/src/components/WorkspaceView.managedRunner.test.tsx`，都只为测试引入 `App as AntApp`，都来自 main 的 managed runner 功能（`94025579b`），本批没有碰它们，也不在本批范围。它们已由后来落地的 P4.4 在项目线上处理：协调者 2026-10-09 判定，`WorkspaceView.managedRunner.test.tsx` 归 P5.3（记录 `inventory-delta/2026-10-09c.json`，提交 `c5e250140`），`App.managedRunner.test.tsx` 在 P4.4 的业务切换里去掉了包裹（项目 tip 上已不引入 antd）。本批落到项目线之后两者都有着落，不需要再报。本批的 `ChoicesFixture.tsx` 原来就引用 antd（fixture），没有新的使用点。

## OrbitKit

本批改的文件没有一个被 Swift 测试读取（在 `src/macos`、`src/ios`、`src/android` 里 grep 这些路径与文件名：没有），也没有改任何业务页面的文案或它周围的标记，按作业指导不需要跑 OrbitKit 的 swift 套件。

## 环境与磁盘

- 主机：根分区在 4.4–27 GB 之间变化（低于 6 GB 时不在根分区上构建或跑浏览器），/mnt/data（机械盘）被别的会话占满 I/O（`sdb` 100% busy），内存经常只剩 2–3 GB、交换几乎用尽，负载 30–80，期间至少 3 次全局 OOM（21:35、21:36、01:07 UTC）。
- 依赖：本树的锁文件与 /root/orbit 的安装不兼容。工作树的 `node_modules` 用 `cp -al` 从同一锁文件的另一份安装（NVMe 上）硬链接而来，只多占约 20 MB 的目录块，`scripts/worktree-dependencies.mjs` 核对兼容；两棵运行树的 `node_modules` 链接到它（与 P4.3b 相同）。机械盘上的那份安装让 Vitest 的工作进程在 60 秒内起不来，所以改用 NVMe 上的。
- 每一步（[scripts/step.sh](scripts/step.sh)）：一次只跑一个；根分区低于 2 GB 停；等到可用内存至少 3 GB；独立的 systemd scope（`MemoryMax=6G`、`oom_score_adj 500`，OOM 时杀的是测试而不是 runner）；独立的网络命名空间（固定端口互不干扰，Chromium 看不到别的会话的网卡变化）；TMPDIR 与输出在 /mnt/data；日志记下命令、树、HEAD、未提交的文件、负载、内存、磁盘和退出码。
- 最终轮由 [scripts/final.sh](scripts/final.sh) 一次跑完（一个后台作业），补跑由 [scripts/reruns.sh](scripts/reruns.sh)。我自己的三个脚本问题，以及怎么处理的：
  1. 参照树的 `@types` 第一次用跨文件系统的 `cp -al` 复制，失败到一半，留下空的 `@types/react-dom`，参照树的 Web 构建停在 tsc，所以它的标准 P0、P4.3a 用例和页面探针在最终轮里没有跑起来（日志在 [runs/runs-setup-failed/](runs/runs-setup-failed/)）。`make-trees.sh` 改成普通复制、修好参照树后，在 `reruns.sh` 里重跑。
  2. `final.sh` 的 `probe()` 只给第一个文件名加了探针目录，三个探针各只复制了一个文件、没有跑起来（同一目录）；`reruns.sh` 逐个复制后重跑。`final.sh` 保持当时运行的样子。
  3. `MOVE_RESULTS` 经 `env` 传给了命令而不是 `step.sh`，几个把结果写在树里的配置（P0、select-keys、keyboard-window 第 1 批）的结果没有被自动移出；在被下一次运行覆盖之前手工移到了 `runs/`（第 1 批的 Select 结果在菜单序列开跑之前移走），`reruns.sh` 里改为显式移动。
- 原始运行（报告带附件正文、trace、全部截图、两棵树）留在 `/mnt/data/tmp/34coPBk43ULRuisicUTAy/`，证据判定后清理。本目录约 14 MB：运行日志、去掉附件正文的报告（`*.report.summary.json`）、对照数据、被引用的截图。

## 未确立的部分

- 只在 Linux 上的 Playwright Chromium/WebKit 模拟中比较，没有真机，也没有用读屏软件实测；手机环境是触屏模拟。
- 旧 AntD 一侧用的是 fixture 里的同位置样例和 P4.3a 留下的真实页面截图（重绑对话框），没有恢复旧 AntD 的业务页面重跑；其余三个真实页面（选择工作区、Expires、Suggested）只比了本批前后，旧 AntD 的行为按 rc-select 源码推断（值为空或不在选项里时高亮第一个可用项）。
- P2 键盘窗口用例按本批的改动缩小了样本：Select 序列每组 3+3（P2 是 20+20），菜单、子菜单、Popconfirm、对话框的序列每组 1+1、只在交付上跑；第 1、2 批都只在 chromium-dark-desktop。select-keys 是全量。
- 列表打开期间选项才加载（个数从 0 变多）的情形：rc-select 会把高亮移到第一项，本批只在打开时处理，没有覆盖，也没有找到这样用的页面。
- 「关闭列表后再打开」时旧 AntD 是否保留上次的高亮：探针里旧 AntD 在 Escape 之后的第二次点击没有打开列表，读数不可靠，没有确立。
- Drawer 的 Close、Select 清除图标、↑ 打开、指针离开列表、↓ 遇到禁用项五处差异只记录、报告，没有改。
- 与 P4.4 的临时合并只跑了标准 P0、两个入口和合并检查；P2 键盘窗口用例、同提交对照与探针是在合并之前的树上做的（P4.4 没有改 Select、对话框或它们用到的部分）。
- apiserver 扫描整个仓库的 spec 在本机只能证明按内容扫描的部分：本机共用的仓库是 shallow，要求完整历史的断言在任何树上都失败。

## 复现

```bash
# 两棵树（/mnt/data）：交付 = 分支头，参照 = 只把本批的三个产品文件换回起点
bash docs/evidence/base-ui-migration/select-first-option/scripts/make-trees.sh a755f816a 9e9787f79
# 最终轮，然后补跑（都可从中断处接着跑）
bash docs/evidence/base-ui-migration/select-first-option/scripts/final.sh
bash docs/evidence/base-ui-migration/select-first-option/scripts/reruns.sh
# 汇总与收集（本目录的 runs/、compare/、shots/ 由它们生成；collect.sh 只写新目录，不删除）
python3 -I docs/evidence/base-ui-migration/select-first-option/scripts/analyze.py /mnt/data/tmp/34coPBk43ULRuisicUTAy docs/evidence/base-ui-migration/select-first-option
bash docs/evidence/base-ui-migration/select-first-option/scripts/collect.sh
# 单测（任一树的 src/web）
npx vitest run src/components/ui/Select.test.tsx src/components/ui/keyboardWindow.test.tsx
```
