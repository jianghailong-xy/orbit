# 子菜单几何与旧 AntD 对齐：起点、宽度与右缘翻转

任务 [子菜单几何与旧 AntD 对齐](orbit-task:34cC5ZWY0xCWquFuz3rNY)，属于 [Orbit Web 组件迁移](orbit-project:34ZZeq0e3IR65GVm2kAs7)，验收项 P2。起因是 [浮层第一帧位置](orbit-task:34broktJh4EJXI1eiF7Jm) 的发现（[overlay-first-frame/README](../overlay-first-frame/README.md)「范围外」）。

## 结论

- **改动前**：Orbit 子菜单比旧 AntD 子菜单多偏 4px，至少与父项同宽（122px，旧的按内容 76.375px）。翻转按视觉视口减 9px 判断，两侧都放不下时放到父项下方；菜单项不折行。所以手机上放在页面中间时，短文字的子菜单 Orbit 翻到左侧而旧的留在右侧；中、长文字时 Orbit 放到下方，旧的翻到左侧或收窄折行。
- **改动后**：子菜单的起点、宽度和翻转与旧组件的规则一致（见下一节）。常驻用例 `choices-submenu-geometry` 比较了 4 处位置 × 2 个样例 × 3 种文字 × 8 个环境，共 192 处，Orbit 与同一处的旧子菜单方向相同，相对父项的 x、y、宽、高逐一相等，没有容差。其中 WebKit 桌面对话框的 12 处，两页因已知的对话框滚动锁差异宽度不同，父项相距 8px，只比相对父项的盒子（见[对照](#对照)）。
  - 修复前的参照（合并后的 tip 撤回修复提交，`ee0b413da`）：八环境 32 个用例全部失败，192 处全部不同，失败的断言全部是「子菜单的盒子」（[geometry-before](runs/geometry-before/)）。
  - 修复后（`12fdef2f7`）：32 个用例全部通过，192 处盒子全部相同（在 choices 全量 680/680 里，见[回归](#回归)）。
- **翻转阈值**：探针（[probe/threshold.browser.mjs](probe/threshold.browser.mjs)，非常驻；在 `426e8e524` 和 `216897fa6` 上，所测代码与最终提交相同）把父菜单按 1px 逐步右移，跨过短文字子菜单放不下的那一点，每步两个系统各开一次。四个浅色环境（Chromium、WebKit × 桌面、手机）里，修复后 17 个位置的子菜单盒子全部相同；两者在同一位置翻转，即 `父项右缘 + 宽度 − clientWidth` 从 −0.562 变为 +0.438 的那一步。WebKit 手机里，子菜单右缘超出 382px 宽的视觉视口、但还在 390px 以内时，两者都留在右侧。修复前，Orbit 在整个扫描范围（旧组件翻转点之前 12px 到之后 4px）都已在左侧，17 个位置一个都不相同（[threshold-before](runs/threshold-before/threshold.json)、[threshold-after](runs/threshold-after/threshold.json)）。
- **剩余差异**：本任务对照的各处没有差异；对照覆盖不到的 5 点逐项见[剩余差异](#剩余差异)。
- **回归**（最终提交 `12fdef2f7`）：choices 入口全量 680/680；overlays 入口全量 96/96；合并检查原命令通过，Vitest 370 个文件、4793 个用例；标准 P0 101 通过、11 跳过、0 失败；第 2 批窗口冻结帧探针 392/392；`audit-antd.mjs --check-owners` 0 个未归属、0 个待定。纵向对齐、子菜单键盘窗口修复、Menu 的 Tab 约定、浮层第一帧位置都不变，原断言没有改（见[回归](#回归)）。
- **main 的问题**：交证据前第一次跟上时，`origin/main` 自己的 `tsc -b` 失败（`RunnerEngines.tsx`，与本任务无关），已报告协调者，由项目任务 [修复 main 的 Web 构建](orbit-task:34ccSuT35QtQJtNvv8sHG) 修好。最终轮建立在含这个修复的项目 tip 上，详见[基础与提交](#基础与提交)。

## 旧子菜单怎么放（antd 6.6.5，@rc-component/menu 1.5.0，@rc-component/trigger 3.10.1）

Dropdown 的菜单是 vertical 模式，子菜单的位置是 `rightTop`（`points: ['tl', 'tr']`，`overflow: { adjustX: 1, adjustY: 1 }`）。弹层挂在 body 上，`position: absolute`，用 `left`/`top` 定位：

- **起点**：弹层左上角对父项右上角。`useAlign.js` 最后把偏移向下取整（`Math.floor`），所以左缘在 `floor(父项右缘)`。父项在父菜单 4px 内边距的里侧，子菜单因此盖住父菜单右边这 4px。
- **宽度**：rc-menu 只给 horizontal 模式加 `stretch: 'minWidth'`。vertical 的子菜单不跟父项同宽，`min-width` 为 0，宽度按内容。菜单项是 `white-space: normal`。弹层从 `left` 处排版，可用宽度到包含块（布局视口）右缘为止，内容更宽时收窄、折行。
- **翻转**：右侧放不下（`父项右缘 + 宽度 > documentElement.clientWidth`）时，比较翻到左侧和留在原处各自在可视区里露出的面积。可视区是 `[0, clientWidth] × [0, clientHeight]`，body 和 html 不算裁切。左侧不小于原处就翻，翻过去后右缘贴父项左缘，左缘取 `floor(父项左缘 − 宽度)`，可能出屏。比较用的宽度是 `left: 0` 时量到的自然宽度。不平移（没有 `shiftX`），也不换到父项上下。
- **纵向**：顶边对父项顶边。下方放不下、翻上去露出更多时，底边对父项底边。本任务不改纵向。

## 改动前的 Orbit 子菜单（Base UI 1.8.0）

`Menu.tsx` 的 `Submenu`：`side="right" align="start" sideOffset={4} collisionPadding={8}`，碰撞规避用 Base UI 子菜单的默认值 `{ fallbackAxisSide: 'end' }`。

- 起点：父项右缘 + 4，按 Floating UI 四舍五入。
- 宽度：`.orbit-menu` 的 `min-width: var(--orbit-menu-anchor-width, var(--anchor-width))`。子菜单弹层不在根菜单的 DOM 里，继承不到根菜单的变量，于是取 Base UI 的 `--anchor-width`，也就是父项宽度（122px）。`max-width` 是 Base UI 的 `--available-width`。菜单项 `white-space: nowrap`。
- 翻转：Floating UI 的 `flip`，按视觉视口减去 8 + 1px（Base UI 加 1px 偏置，左侧再加 1）判断。两侧都放不下时，退到父项下方或上方（`fallbackAxisSide: 'end'`）。

## 改动

两个提交，测试在前，修复在后。修复前的参照就是撤回修复提交后的树（见[回归](#基础与提交)）：

- 测试提交：`ChoicesFixture.tsx` 的子菜单（`sample=submenu` 的 Provider、`sample=session` 会话菜单的 Provider，两个系统同一份）第二项文字可由 `labels=medium`（`Claude · work account`，171px 宽的子菜单）或 `labels=long`（`Claude Opus 5.5 with extended thinking (work)`，自然宽度 322px，比手机上父项右边剩下的宽）切换，默认仍是 `Claude`。新增常驻用例 [`choices-submenu-geometry.browser.mjs`](../../../../src/web/ui-migration/choices-submenu-geometry.browser.mjs)，属于 `npm run test:ui-choices`。
- 修复提交：
  - [`Floating.ts`](../../../../src/web/src/components/ui/Floating.ts) 新增 `useSubmenuPlacement`。它在 Base UI 的 `sideOffset` 回调里按上面旧组件的规则选边：右侧给出把左缘落在 `floor(父项右缘)` 的偏移；左侧给出把左缘落在 `floor(父项左缘 − 宽度)` 的偏移。没选中的那一侧给 1e6，Base UI 的 `flip` 试到它时一定判为放不下，最后落在选中的一侧（`data-side` 也随之是 `left`/`right`）。碰撞规避改为 `{ fallbackAxisSide: 'none' }`，不再退到父项上下；纵向的翻转和平移仍由 Base UI 处理，参数不变（`align="start"`、`collisionPadding={8}`）。同时把从左缘到布局视口右缘的宽度写到 Positioner 的 `--orbit-submenu-room`。
  - [`Floating.css`](../../../../src/web/src/components/ui/Floating.css)：`.orbit-menu[data-nested]` 的 `min-width: 0`、`max-width: var(--orbit-submenu-room, none)`，子菜单里的 `.orbit-menu-item` 为 `white-space: normal`。根菜单的规则不变。
  - [`Menu.tsx`](../../../../src/web/src/components/ui/Menu.tsx) 的 `Submenu`：给 `SubmenuTrigger` 加 ref 作为锚点，Positioner 用 `useSubmenuPlacement` 的结果，去掉 `sideOffset={4}`。键盘交接（第 2 批窗口修复）和焦点处理没有改。
  - [`choices-first-frame.browser.mjs`](../../../../src/web/ui-migration/choices-first-frame.browser.mjs) 只改了一处注释：原注释说子菜单「x 多 4px、至少与触发项同宽」，修复后不再成立，改为指向新用例。`compared: ['y']` 等断言没有改。

为什么用 1e6 而不是自己算 `side`：选边要用到弹层宽度，只有 Base UI 定位时才量得到。如果先渲染再改 `side`，第一帧就可能在另一侧。在 `sideOffset` 回调里选边，第一次定位就落在最终位置，浮层第一帧的修复不受影响（见[回归](#回归)）。

## 对照

常驻用例 [`choices-submenu-geometry.browser.mjs`](../../../../src/web/ui-migration/choices-submenu-geometry.browser.mjs)：

- 每个环境 4 个用例，每个用例对应一处位置：
  - 页面左侧：样例原位，`left: 24`；
  - 页面中间：`anchor=center`，`left: 45%`；
  - 页面右缘：`anchor=right`；
  - 对话框右缘：`owner=dialog&anchor=right`，旧组件在旧 Modal 里。
- 每处 6 种情形：两个样例（`submenu`：父菜单只有 Provider；`session`：会话菜单，Provider 夹在其他项之间）× 三种第二项文字（短、中、长）。
- 每种情形分别打开旧 Dropdown 和 Orbit Menu 的父菜单，指针分步移到 Provider 上，等两者都静止后读取子菜单和父项的位置。旧组件要等动效类名去掉，WebKit 有时会让旧子菜单在起始缩放上停几帧。
- 断言（逐项 `expect.soft`）：
  - 父项位置相同，也就是同一处。唯一的例外是 Linux WebKit 桌面的对话框：页面有 8px 经典滚动条，旧 Modal 的滚动锁把它去掉（视口 1280），Orbit 对话框保留滚动条槽位（1272）。这是 [P4.2](../p4.2/README.md#协调者对差异的判定) 记录的已知差异「对话框滚动锁」，由 [WebKit 对话框滚动锁](orbit-task:34cBi0yt6bFcSmbJFgDPj) 处理，不属于子菜单。两页宽度不同时父项相距 8px，用例不比父项位置，留注记 `not the same place`，只比子菜单相对父项的盒子；两边都远离翻转点，方向不受影响；
  - 页面左侧旧子菜单在右侧、两处右缘旧子菜单在左侧，确认情形本身；
  - Orbit 子菜单的方向、相对父项左上角的 x、y 和宽、高与旧子菜单相等。数值取到千分之一像素，没有容差。
- WebKit 手机模拟里，固定定位的样例在页面溢出之前排版就停在 390 宽的位置，之后打开菜单的页面会挪到 382 宽的位置（见浮层第一帧用例的 `narrowed` 说明）。用例在打开前先滚动 1px 再回来，让两边的样例都按 382 排好，因此手机的两处右缘也能比较。

下表是两种视口的结果。两种浏览器、明暗主题、两个样例的数值都相同，只有表里注明「或」的格子例外。数值是方向、相对父项左缘的 x、宽 × 高，纵向偏移不为 0 时注明 y；父项宽 122.063px，「下」表示放在父项下方。

桌面（1280×900；WebKit 1272）

| 位置 | 第二项 | 旧 AntD | 修复前 Orbit | 修复后 Orbit |
| --- | --- | --- | --- | --- |
| 页面左侧 | `Claude` | 右 122 / 76.375 × 72 | 右 126 / 122 × 72 | 右 122 / 76.375 × 72 |
| 页面左侧 | `Claude · work account` | 右 122 / 171.297 × 72 | 右 126 / 171.297 × 72 | 右 122 / 171.297 × 72 |
| 页面左侧 | `Claude Opus 5.5 …` | 右 122 / 322.281 × 72 | 右 126 / 322.281 × 72 | 右 122 / 322.281 × 72 |
| 页面中间 | `Claude` | 右 122 / 76.375 × 72 | 右 126 / 122 × 72 | 右 122 / 76.375 × 72 |
| 页面中间 | `Claude · work account` | 右 122 / 171.297 × 72 | 右 126 / 171.297 × 72 | 右 122 / 171.297 × 72 |
| 页面中间 | `Claude Opus 5.5 …` | 右 122 / 322.281 × 72 | 右 126 / 322.281 × 72 | 右 122 / 322.281 × 72 |
| 页面右缘 | `Claude` | 左 -77 / 76.375 × 72 | 左 -126 / 122 × 72 | 左 -77 / 76.375 × 72 |
| 页面右缘 | `Claude · work account` | 左 -172 / 171.297 × 72 | 左 -175 / 171.297 × 72 | 左 -172 / 171.297 × 72 |
| 页面右缘 | `Claude Opus 5.5 …` | 左 -323 / 322.281 × 72 | 左 -326 / 322.281 × 72 | 左 -323 / 322.281 × 72 |
| 对话框右缘 | `Claude` | 左 -77 / 76.375 × 72 | 左 -126 / 122 × 72 | 左 -77 / 76.375 × 72 |
| 对话框右缘 | `Claude · work account` | 左 -172 / 171.297 × 72 | 左 -175 / 171.297 × 72 | 左 -172 / 171.297 × 72 |
| 对话框右缘 | `Claude Opus 5.5 …` | 左 -323 / 322.281 × 72 | 左 -326 / 322.281 × 72 | 左 -323 / 322.281 × 72 |

手机（390×844；WebKit 视觉视口 382）

| 位置 | 第二项 | 旧 AntD | 修复前 Orbit | 修复后 Orbit |
| --- | --- | --- | --- | --- |
| 页面左侧 | `Claude` | 右 122 / 76.375 × 72 | 右 126 / 122 × 72 | 右 122 / 76.375 × 72 |
| 页面左侧 | `Claude · work account` | 右 122 / 171.297 × 72 | 右 126 / 171.297 × 72 | 右 122 / 171.297 × 72 |
| 页面左侧 | `Claude Opus 5.5 …` | 右 122 / 240 × 94 | 下 0 / 322.281 × 72 (y 36) | 右 122 / 240 × 94 |
| 页面中间 | `Claude` | 右 122 / 76.375 × 72 | 左 -126 / 122 × 72 | 右 122 / 76.375 × 72 |
| 页面中间 | `Claude · work account` | 左 -172 / 171.297 × 72 | 下 0 / 171.297 × 72 (y 36) | 左 -172 / 171.297 × 72 |
| 页面中间 | `Claude Opus 5.5 …` | 左 -323 / 322.281 × 72 | 下 -167 / 322.281 × 72 (y 36) 或 下 -171 / 322.281 × 72 (y 36) | 左 -323 / 322.281 × 72 |
| 页面右缘 | `Claude` | 左 -77 / 76.375 × 72 | 左 -126 / 122 × 72 | 左 -77 / 76.375 × 72 |
| 页面右缘 | `Claude · work account` | 左 -172 / 171.297 × 72 | 左 -175 / 171.297 × 72 | 左 -172 / 171.297 × 72 |
| 页面右缘 | `Claude Opus 5.5 …` | 左 -323 / 322.281 × 72 | 下 -200 / 322.281 × 72 (y 36) | 左 -323 / 322.281 × 72 |
| 对话框右缘 | `Claude` | 左 -77 / 76.375 × 72 | 左 -126 / 122 × 72 | 左 -77 / 76.375 × 72 |
| 对话框右缘 | `Claude · work account` | 左 -172 / 171.297 × 72 | 左 -175 / 171.297 × 72 | 左 -172 / 171.297 × 72 |
| 对话框右缘 | `Claude Opus 5.5 …` | 左 -323 / 322.281 × 72 | 下 -200 / 322.281 × 72 (y 36) | 左 -323 / 322.281 × 72 |

修复前、修复后两份逐处记录：[geometry-before/geometry.json](runs/geometry-before/geometry.json)、[choices/geometry.json](runs/choices/geometry.json)。逐处对照表由 `python3 summarize.py <geometry.json>` 生成：修复后 192 处盒子全部相同，其中 180 处父项也在同一位置；另 12 处是 WebKit 桌面的对话框，两页宽度不同（见上）。修复前 192 处盒子全部不同。

## 剩余差异

本任务覆盖的各处（四个位置 × 两个样例 × 三种文字 × 八个环境）稳定几何没有差异。以下几点没有被这些对照覆盖，逐项说明：

1. **打开期间的重新对齐**：rc-trigger 记住本次打开里已经翻转过（`prevFlipRef`），之后每次重新对齐（窗口变化、滚动、内容变化）即使不越界也会重新比较；左侧露出的不比原处少，就继续留在左侧，所以两侧都放得下时它仍在左侧。Orbit 每次定位都按当时的几何重新选边，同样情况下会回到右侧。只在子菜单打开期间视口变宽或内容变窄时出现；固定视口的对照里不会发生。没有照搬这份记忆：那要像 `useDropdownPlacement` 一样为每次打开保存状态，只为这种动态情形，不值得。
2. **纵向**：没有改，仍是 Base UI 的翻转（按视觉视口减 9px 判断）和平移（留 8px），旧组件是按 `clientHeight` 判断的翻转、不平移。本用例的四个位置、浮层第一帧用例里与旧组件比较的 8 处，纵向都相同，其中没有一处需要纵向翻转。子菜单贴近视口底边时两者可能不同，不在本任务范围（任务要求纵向对齐不变）。
3. **折行后的高度变化**：子菜单在右侧收窄折行时，第一次定位用的是折行前的高度，样式生效、尺寸变化后 Base UI 再定位一次。纵向位置只有在折行后的高度碰到视口底边时才会变，也就是第一帧和稳定位置不同；旧组件同样在尺寸变化后重新对齐。浮层第一帧用例用的是短文字，不涉及这种情况。
4. **取整的原点**：rc-trigger 对弹层相对其包含块原点的偏移取整，Orbit 对视口坐标取整。页面横向滚动量是整数像素时两者相同，对照里都是。
5. **面积与宽度**：rc-trigger 比较两侧露出的面积，Orbit 比较露出的宽度。两侧纵向位置相同，只要子菜单有一部分在视口里，两种比较结果一样；父项整个在视口外（打不开子菜单）时才可能不同。

与改动前的 Orbit 相比、但与旧组件相同的两点，提请注意：
- 手机上两侧都放不下（长文字）时，子菜单翻到左侧后有一部分在屏幕外（x 为负），与旧组件相同；改动前的 Orbit 是放到父项下方、整个在屏幕内。P5 的 Effort、Speed、Filter by Tag 若有很长的项，会遇到这种情况。
- 判断用布局视口宽度（`clientWidth`），与旧组件和根菜单的 `useDropdownPlacement` 一致。Linux WebKit 手机模拟里视觉视口窄 8px（经典滚动条），子菜单可以伸到这 8px 里，与旧组件相同。

## 回归

### 基础与提交

- 开工时：`origin/main` `870e33a1f`。项目 tip `a2e58b0ce` 已在其中，所以直接以 `origin/main` 为基础。第一轮的探针与用例都在这一基础上（只记计数，见[早先各轮](#早先各轮)）。
- 交证据前第一次跟上：`origin/main` `5e17800a0`，测试提交 `426e8e524`，修复提交 `216897fa6`。这一基础上，main 自己的 `tsc -b` 报两个错，都在 `RunnerEngines.tsx` 的 432、438 行（`Quota.noLimit` 缺失）：`f6f385d2e` 把 `noLimit` 改成必填，`16d157656` 折叠账号组的两处还按旧形状构造。修复前、修复后两棵树报的错逐字相同（[tsc-before](runs/tsc-before/output.txt)、[tsc-fix](runs/tsc-fix/output.txt)）。已报告协调者，协调者建了 [修复 main 的 Web 构建](orbit-task:34ccSuT35QtQJtNvv8sHG)。在那之前，P0 用的包按协调者认可的做法改由 `vite build` 生成（同一份代码，只跳过类型检查；`tsconfig` 是 `noEmit`，产物相同）。
- 最终：修复任务的 `74fc42d4f` 落到项目线（tip `15b7b5609`，还不在 `origin/main` 里）。按规则先 rebase 到项目 tip，再合并 `origin/main` `f1837de8e`，得到测试提交 `1f889cc61`、修复提交 `561bffd75`、合并提交 `12fdef2f7`。修复前的参照是 `ee0b413da`：在 `12fdef2f7` 上 revert `561bffd75`，只撤回修复提交的 4 个文件（含 first-frame 那处注释）。
- 最终轮开始后 main 又前进到 `945098b11`（项目线晋升、start card 的改动、设计图等）。按作业指导新增的规则，不再 rebase、不重跑，记录 `git merge-tree` 的结果和 main 改动的文件，由落地时的合并检查兜底（[merge-tree-origin-main](checks/merge-tree-origin-main.txt)）：
  - 与 `945098b11` 合并干净（`git merge-tree --write-tree` 退出码 0，树 `256c196f5`）。
  - main 改动的 69 个文件里，Web 只有 `ProjectDependencyGraph`、`StartPlanGraph`、`StartProjectCard`（及测试）、`lib/projectStart.ts`、`RunnerEngines`（与项目线同一个修复），以及 `index.css` 里 `.start-card`、`.start-card-graph` 的规则。
  - 与本分支重叠的只有 `RunnerEngines.tsx` 和它的测试，两边是同一个修复。`index.css` 的改动里没有一行涉及菜单、浮层或弹层。
- 与 `216897fa6` 相比，`12fdef2f7` 的 Web 只多两处：项目线上的 `RunnerEngines.tsx` 修复（及其测试），以及本用例对对话框一处的调整（见[对照](#对照)）。`Floating.ts`、`Floating.css`、`Menu.tsx` 逐字相同。

### 最终一轮（`12fdef2f7`，修复前参照 `ee0b413da`）

| 检查 | 修复前（`ee0b413da`） | 修复后（`12fdef2f7`） |
| --- | --- | --- |
| 本用例 `choices-submenu-geometry`，八环境 | **0/32**，192 处全部不同，失败全部是「子菜单的盒子」（[geometry-before](runs/geometry-before/)） | **32/32**，192 处盒子全部相同（在 choices 全量里，[choices](runs/choices/)） |
| choices 入口全量（`npm run test:ui-choices`），八环境 | — | **680/680**：first-frame 128、lifecycle 96、motion 192、open-value 24、本用例 32、choices 208（[choices](runs/choices/)） |
| overlays 入口全量（`npm run test:ui-overlays`），八环境 | — | **96/96**（[overlays](runs/overlays/)） |
| 合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web`（会话工作树，NVMe） | — | **通过**：构建通过；Vitest 370 个文件、4793 个用例全部通过，其中 `Menu.test.tsx` 18、`keyboardWindow.test.tsx` 58、`Select.test.tsx` 26（[merge-check](runs/merge-check/output-summary.txt)） |
| 标准 P0（`npm run test:ui-migration`，用合并检查构建的包） | — | **101 通过、11 跳过、0 失败**，112 个用例的结果与 `5e17800a0` 上的同提交对照逐一相同（[p0](runs/p0/)） |
| 第 2 批窗口冻结帧探针（[held-frames-2](../p2-keyboard-window-2/held-frames-2.browser.mjs)，原文件不改），八环境 | — | **392/392**，其中子菜单 176 例（[held-frames](runs/held-frames/)，同提交的独立检出） |
| `audit-antd.mjs --check-owners` | — | 0 个未归属、0 个待定（[check-owners-12fdef2f7](checks/check-owners-12fdef2f7.txt)） |

### 沿用的 `5e17800a0` 一轮

协调者确认这几项不必因换基础重跑：

| 检查 | 修复前（`426e8e524`） | 修复后（`216897fa6`） |
| --- | --- | --- |
| P0 同提交对照（包由 `vite build` 生成，两棵树同时跑） | 101 通过、11 跳过、0 失败（[p0-before](runs/p0-before/)） | 101 通过、11 跳过、0 失败（[p0-after](runs/p0-after/)），112 个用例结果逐一相同 |
| 翻转阈值探针（4 个浅色环境 × 17 个位置） | 17 个位置都不同（[threshold-before](runs/threshold-before/)） | 17 个位置全部相同，翻转在同一步（[threshold-after](runs/threshold-after/)） |
| `vite build` | 通过（[vitebuild-before](runs/vitebuild-before/)） | 通过（[vitebuild-after](runs/vitebuild-after/)） |

### 早先各轮

依「证据体积」约定，只提交结论所依据的那一轮；其余各轮只记计数，原始运行在 `/mnt/data/tmp/34cC5ZWY0xCWquFuz3rNY/runs/`：

| 原始运行（`/mnt/data/tmp/34cC5ZWY0xCWquFuz3rNY/runs/` 下的名字） | 基础 | 内容 | 结果 |
| --- | --- | --- | --- |
| `explore-2` | `870e33a1f`，改动前 | 探针：两个样例 × 三处 × 三种文字，两个系统，八环境 | 八环境里所有情形都不同（起点 +4、宽 122、手机翻转与放到下方） |
| `geometry-fix-2` | `870e33a1f` + 改动（当时三处位置） | 本用例 | 24/24 通过，144 处相同 |
| `geometry-before` | `5e17800a0`，`426e8e524` | 本用例（含对话框一处） | 0/32，192 处全部不同 |
| `choices-final` | `5e17800a0`，`216897fa6` | choices 全量 | 换基础时停在 511 个，510 个通过；唯一的失败是 WebKit 浅色桌面对话框一处的「父项位置」断言，盒子与方向都相同（对话框滚动锁），因此调整了本用例 |
| `dialog-check` | `216897fa6` | 只跑 WebKit 桌面对话框一处 | 6 处失败都是「父项位置」，盒子与方向相同 |

不变的几项约定和修复：

- **纵向对齐**：本用例逐处断言 y 相等；浮层第一帧用例与旧组件比较的 8 处断言 y 相等（`compared: ['y']` 未改）。
- **第 2 批窗口的子菜单键盘修复**：`keyboardWindow.test.tsx`（属于 Vitest 全量，子菜单 18 例）、冻结帧探针的子菜单 22 例 × 8。`Submenu` 的 `onKeyDown` 交接没有改。
- **Menu 的 Tab 约定**：三处依据都通过，测试文件没有改：`Menu.test.tsx`（Vitest 18 例）、choices 的「menu arrows, disabled items, submenu, checkbox and focus return work」（八环境）、P0 `pages.browser.mjs` 的 `task`（八环境，其中的 `task-action-menu` 截图）。
- **浮层第一帧位置**：`choices-first-frame.browser.mjs` 的 16 个用例（8 种浮层 × 两项）× 八环境在 choices 全量里，只改了注释。

## 文件与运行方式

常驻用例按原命令运行：`npm run test:ui-choices -w @orbit/web`（只跑本用例：后面加 `choices-submenu-geometry`）。本任务的运行用 choices、overlays、P0 各自的配置原样运行，只把结果目录改到 `/mnt/data/tmp/34cC5ZWY0xCWquFuz3rNY/runs/<名字>/`；每次运行在自己的网络命名空间里（只有 lo），单 worker，不重试。修复前的参照（`/mnt/data/tmp/34cC5ZWY0xCWquFuz3rNY/before`）和修复后的独立检出（`.../after`）各有自己的 `node_modules`（`scripts/worktree-overlay.sh`）。

| 文件 | 内容 |
| --- | --- |
| [slim.py](slim.py) | 运行目录 → 提交的副本：`report.summary.json`（原报告只删 `attachments[].body`）、`geometry.json`（本用例附件正文按项目、用例汇总）、`threshold.json`（阈值探针的附件正文）、`run.txt`（树、提交、起止时间、负载、退出码）、`output.txt`（list 输出） |
| [verify.py](verify.py) | 只读本目录里提交的文件，重新算出 README 引用的数字：各次运行的树、提交、退出码与结果计数，本用例修复前后的盒子，P0 同提交对照，阈值探针，合并检查总数（`python3 verify.py`） |
| [summarize.py](summarize.py) | `geometry.json` → 逐处对照表（盒子是否相同、父项是否在同一位置） |
| [tables.py](tables.py) | 修复前后两份 `geometry.json` → 上面的对照表 |
| [probe/](probe) | 翻转阈值探针、它的配置与运行脚本、汇总脚本（`threshold.py`） |
| [checks/](checks) | `audit-antd.mjs --check-owners` 的输出（第一次跟上后的 `216897fa6`、最终的 `12fdef2f7`）；对最新 `origin/main` 的 `git merge-tree` 结果与 main 改动的文件（`merge-tree-origin-main.txt`） |
| `runs/<名字>/` | 各次运行的副本，见[回归](#回归) |

完整原始运行（含附件正文的 `report.json`）留在 `/mnt/data/tmp/34cC5ZWY0xCWquFuz3rNY/runs/`，证据判定后清理。
