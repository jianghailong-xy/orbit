# P2 跟进（第 2 批窗口）：子菜单、Popconfirm、Dialog 与触发器内其余按键，与 AntD 对照

本目录服务于 [P2 跟进（第 2 批窗口）](orbit-task:34blUhb6Wip3e5nyziKfq)。验收条目 key `1BvO6hYrlFnU60JqxQPUHt`，原文：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。**

分支从当时的项目 tip `7732f14f8` 开工，修复与对照都在这棵树上做；最后合入了项目分支新的 tip `【待补】`，在合入后的树上再跑合并检查（见[合入项目 tip 之后](#合入项目-tip-之后)）。

## 结论

1. **基线**：旧 AntD 与 Orbit 用同一组探针、同样条件采样，共 63 个按键序列、217 个「目标 × 序列」组合（Orbit 133 个，旧 AntD 84 个）。每个组合 20 个 burst、20 个 paced 样本，合计 8680 个，都在 Chromium `chromium-dark-desktop` 上采。每个组合的 paced 参照都是 20/20 一致。
2. **判定**按前两个任务的规则（旧 AntD 赋予该键功能、自己的 burst 保持 paced 结果，而 Orbit 的 burst 与自己的 paced 不同，才修），加上协调者 2026-10-07 的两次判定：
   - **按规则修**，共 16 个 Orbit 组合：
     - Dialog/ConfirmDialog 6 个：ConfirmDialog 的 ⏎⏎、⏎Space、⏎Tab⏎，Dialog 的 ⏎Tab、⏎Shift+Tab、⏎Tab⏎；
     - 顶层 Menu 的 ⏎Tab⏎、⏎Shift+Tab⏎，4 个；
     - Select 的 ↓Tab、↓Shift+Tab、⏎Tab，6 个。
   - **按协调者判定修**：
     - 子菜单窗口（方案 B，回归修复）：Orbit 45 个子菜单组合中有 36 个 burst 与 paced 不同。其中 10 个执行了父菜单里的别的项：Delete 2 个、Default model 4 个、Group by tag 2 个、勾选 Important tag 2 个；
     - 顶层 Menu 窗口内的 ⏎Tab、⏎Shift+Tab（按 10-07 的约定）4 个；
     - 顶层 Menu 的 ⏎End⏎、↓End⏎、↑Home⏎ 6 个。
   - **只记录、不改**（旧 AntD 也不处理），共 12 个组合：
     - 顶层 Menu ⏎Space 2 个；
     - Select ↓Home⏎、↓End⏎ 4 个，↓Space（从空值起，只有 Orbit 字段页这一个目标）1 个；
     - Popconfirm ⏎⏎、⏎Space、⏎Shift+Tab 3 个；
     - ConfirmDialog ⏎Tab、⏎Shift+Tab 2 个：旧 `modal.confirm` 自己的 burst 也 20/20 不同。Overlay 修复后这两个顺带与 paced 一致。
   - 其余组合：旧 AntD 与 Orbit 都已与各自的 paced 一致，或者是对照序列。
3. **修复后**，在终版树（`aed0a7bab`）上用同一探针、同样条件重采：
   - 所有要修的组合 burst 错 0/20；
   - 只记录的组合与修复前逐样本同一结果（ConfirmDialog 那两个除外，见上）；
   - 每个 Orbit 组合的 paced 参照都与修复前相同。
4. **Popconfirm 只记录**：修复前后，Orbit 各 280 个样本（7 个序列 × burst/paced × 20），确认都是 0 次。取消只出现在 ⏎Tab⏎，paced 与 burst 都是 20/20，与旧 AntD 相同（Tab 到 Cancel，⏎ 取消）。
   - ⏎⏎、⏎Space 的 burst：确认框关上，焦点留在 Delete task；
   - ⏎Shift+Tab 的 burst：确认框关上，焦点到前一个按钮；
   - 都没有回答问题。
5. **确定性回归**：
   - jsdom 单测 [`keyboardWindow.test.tsx`](../../../../src/web/src/components/ui/keyboardWindow.test.tsx)（58 个用例）：修复前 26 个窗口用例失败、参照全过；修复后 58/58。
   - 冻结帧探针，八个环境，49 例 × 8 = 392：修复前通过 72，第一版修复后 312，终版 392。第一版的问题见[第二次子菜单修复](#第二次子菜单修复)。
6. **约定和已验收的行为不变**：
   - Menu 的 Tab 约定不变：窗口内 ⏎Tab 的 burst 等于 paced，Tab 离开并关闭菜单。⏎Tab⏎ 与旧 Dropdown 不同，是约定所致，不是回归。
   - 前两个任务的探针修复前后相同：Select ↓/↑/⏎ 276 个样本，Menu 冻结帧 80 例。
   - 其他回归检查见[已验收行为的回归](#已验收行为的回归)：choices 原入口八环境、overlays、choices 测试列表、试点、P0、相关单测；项目合并检查在合入项目 tip 后的树上跑。

## 旧 AntD 的机制（源码）

- **Dropdown 子菜单**（`@rc-component/menu` 1.5.0）：→ 或 ⏎ 落在子菜单标题上时，`useAccessibility.js:251` 打开子菜单，`:252-264` 用 `raf(…, 5)` 等 5 帧，再把焦点给子菜单第一项（还要再过一帧）。在此之前，按键仍由标题处理：↓/↑ 走父级兄弟导航，`tryFocus` 里的 `cleanRaf()` 会取消待移的焦点；⏎ 再次打开子菜单，重新等 5 帧。菜单项只在自己拥有焦点时由 `MenuItem.js:137` 处理 ⏎。所以旧子菜单在这段时间里不执行任何项，焦点移进去以后才执行。
- **Dropdown 与 Tab**（`@rc-component/dropdown` 1.0.3 `hooks/useAccessibility.js:29-48`）：打开期间在 window 上监听，Tab（不分 Shift）把焦点移进菜单第一项并阻止默认动作，Esc 关闭并聚焦触发器。触发器本身没有按键处理，⏎/Space 只是 button 的 click，切换开合。
- **Select 与 Tab**（`@rc-component/select` 1.10.1 `OptionList.js:199-215`）：打开的列表里 Tab 与 ⏎ 相同，选中活动项；列表打开时阻止默认动作，焦点留在输入框上。
- **Popconfirm**（antd 6.6.5 `popconfirm/index.js`）：没有按键处理。触发器由 rc-trigger 按 click 切换，焦点不进入确认框。
- **Modal**（`@rc-component/dialog` 1.10.0 `Dialog/Content/Panel.js:41`）：`useLockFocus` 一生效，`@rc-component/util` `Dom/focus.js:148` 的 `lockFocus` 就调用 `syncFocus`（`:105`），把焦点放到面板里第一个可聚焦元素上，并通过 focusin 把焦点留在面板内。Esc 由 `@rc-component/portal` 的全局 `onEsc` 处理。`modal.confirm` 另外用 `ActionButton` 在 `setTimeout` 后（`_util/ActionButton.js:30`）把焦点给 Cancel。

## Orbit（Base UI 1.8.0）在窗口里的机制

- Base UI 的弹层在打开后的下一动画帧才移动焦点：`FloatingFocusManager` 先 `queueMicrotask`，再由 `enqueueFocus` 排到 `requestAnimationFrame`；菜单和选择列表的高亮项也一样（`useListNavigation` 的 `focusItem`）。
- **子菜单**：子菜单触发器是父菜单里的一项。窗口内的键先经它自己的处理，再冒泡到父菜单弹层的列表导航：
  - ↓/↑/Home/End 移动父菜单的高亮，焦点同步移走，子菜单随之关闭，随后的 ⏎ 执行父菜单此时高亮的项；
  - ⏎/Space 只是再按一次子菜单触发器，子菜单已开，什么也不执行；
  - ← 在父菜单里没有作用；
  - Shift+Tab 由父菜单处理，关闭整个菜单；
  - Tab 从子菜单触发器沿页面前进。
- **顶层 Menu 的 Tab/Shift+Tab**：菜单打开时，`MenuTrigger.mjs:226-237` 在触发器两侧渲染焦点守卫。
  - 窗口内的 Tab 落到后守卫，`utils/popups/useTriggerFocusGuards.mjs:30-33` 把它当作从页面进入菜单，焦点进了菜单。
  - Shift+Tab 落到前守卫，`:23-29` 先 `flushSync` 关闭菜单，守卫随即卸载；再找守卫之前的可聚焦元素时已找不到，焦点掉到 body。
  - 焦点在菜单里时，Tab 经菜单内的守卫离开并关闭菜单（`:34-46`），Shift+Tab 由 `useListNavigation` 的 floating 处理器关闭菜单并回到触发器。这就是 10-07 判定的约定。
- **Select 的 Tab/Shift+Tab**：窗口内的 Tab 从触发器沿 DOM 前进：
  - 字段页先到 Clear 按钮，列表因焦点离开而关闭；
  - 样例页触发器之后就是弹层门户的外层守卫，它把焦点送进列表，列表保持打开。
  - 焦点在列表里时，Tab 经守卫链落到 `getNextTabbable(触发器)`，越过 Clear；Shift+Tab 由 floating 处理器关闭列表并回到触发器。
- **Dialog/ConfirmDialog**：Orbit 的初始焦点是弹层本身，或调用方给的元素（ConfirmDialog 给的是 Cancel），要下一帧才到。在此之前：
  - ⏎/Space 再按一次页面上的打开按钮（ConfirmDialog 的 ⏎Tab⏎ 因此叠出第二个确认框）；
  - Tab/Shift+Tab 沿页面移动，随后的 ⏎ 会激活页面上的别的按钮；
  - 下一帧初始焦点再把焦点拉回弹层。

## 方法

四种探针，前两种沿用前两个任务（`p2-select-keys`、`p2-keyboard-window`），原文件都不改：

- **burst / paced**（[keyboard-window-2.browser.mjs](keyboard-window-2.browser.mjs)，配置 [keyboard-window-2.config.mjs](keyboard-window-2.config.mjs)，只在 Chromium `chromium-dark-desktop` 上跑，因为依赖 CDP 输入队列）：
  - burst：一个 CDP 会话依次发出与 Playwright 1.63 Chromium 键盘相同的可信按键，中间不等待。Shift+Tab 依次是 Shift 按下、带 Shift 修饰的 Tab 按下和抬起、Shift 抬起。打开键之后的键排在输入队列里，在焦点移进弹层之前到达，相当于主线程繁忙时排队的输入。
  - paced：同一组键用 `page.keyboard.press`，间隔 300ms，作为「焦点已在弹层里」的参照。
  - 每个样本都是新页面。观察器记录每个键的事件目标、`isTrusted`、当时的焦点、已显示的弹层和高亮项。结果统一写成「结果 \| 显示中的弹层 \| @焦点」：
    - 结果是执行了什么、选了什么、回答了什么，或者 `none`；
    - 字段页、会话菜单和确认框样例读页面上的 `output`；
    - 没有 output 的样例由 DOM 推断：最后一个 ⏎/Space 落在弹层内的菜单项或按钮上，之后显示的弹层变少，就记为执行了它。
  - `窗口` 是打开键之后第一个键落在触发器（或弹层外）上、而弹层已显示的样本数；`交接` 是该键被转交到弹层内的样本数。
- **冻结帧**（[held-frames-2.browser.mjs](held-frames-2.browser.mjs)，不依赖 CDP，八个环境都跑）：
  - 按键期间把页面的 `requestAnimationFrame` 换成只排队不执行的版本，用普通 `page.keyboard.press` 连按；最后一个键之后才把帧交还浏览器。
  - 菜单与选择的用例先断言窗口确实出现：打开键之后的那个键落在触发器上，且弹层已显示。
  - 然后断言结果等于 paced 参照。Popconfirm 的 6 例（标 recorded）只断言回答与 paced 相同：⏎Tab⏎ 是取消，其余 5 例都没有回答。
- **jsdom 确定性单测**（[`src/web/src/components/ui/keyboardWindow.test.tsx`](../../../../src/web/src/components/ui/keyboardWindow.test.tsx)，属于 `npm run test -w @orbit/web`）：
  - 截住所有动画帧，每个序列跑两遍：每键之后执行帧（参照）和一帧都不执行（窗口），要求两者结果相同。
  - jsdom 没有默认动作，测试按浏览器规则补上：⏎ 激活拥有焦点的 button，Space 在 keyup 时激活接到 keydown 的 button，Tab/Shift+Tab 沿文档的可聚焦顺序移动焦点（越界回绕，与探针所用浏览器一致）。三者都在 keydown 未被阻止时才执行。
  - 子菜单的窗口用例另断言没有执行任何父菜单项。
- **前两个任务的探针**（原文件不改，用 [prior-select-keys.config.mjs](prior-select-keys.config.mjs)、[prior-menu-held-frames.config.mjs](prior-menu-held-frames.config.mjs) 只换结果目录）：Select 与顶层 Menu 已修好的 ↓/↑/⏎，修复前后各跑一次。

运行方式：
- [run-chunks.py](run-chunks.py) 按块运行，每块在自己的网络命名空间里（只有 lo），`nice -n -10`，单 worker，不重试。
- 原始结果（`report.json` 含附件正文、失败时的 trace）留在 `/var/tmp/kw2-246921c8/runs/<块名>`。
- 这里只提交 [slim.py](slim.py) 生成的瘦身副本：
  - `report.summary.json`：每个测试的标题、项目、状态、耗时、重试、错误信息，以及附件名和各自正文的 SHA-256，不含正文；
  - `samples.csv`：每样本一行；
  - `environment.json`。
- `checks/<块名>.json/.txt` 是该块的命令、提交、Web 树、起止时间、负载、退出码和原始输出。

目标（choices fixture 与 overlays fixture；本任务只给 choices fixture 的外观样例新增两种 `sample`，见[改动](#改动)）：

| 目标 | 页面 | 组件 |
| --- | --- | --- |
| `antd-menu` / `orbit-menu-sample` / `orbit-menu` | `?system=antd\|orbit&sample=attachment`；字段页「Add attachment」 | 旧 Dropdown / Orbit Menu |
| `antd-submenu` / `orbit-submenu-sample` | `?system=antd\|orbit&sample=submenu`（原有样例，父菜单只有 Provider 一项） | 旧 Dropdown 子菜单 / Orbit Submenu |
| `antd-session` / `orbit-session` | `?system=antd\|orbit&sample=session`（新增：Default model、Provider▸Codex/Claude、分隔线、Group by tag、Delete（danger），同一触发器，`Picked` 输出所选项） | 同上，父菜单里有其他项 |
| `orbit-submenu` | 字段页「Session actions」（分组、禁用项、Provider 子菜单、勾选项、Edit details、Delete） | Orbit Submenu |
| `antd-sample` / `orbit-sample` / `orbit-field` | `?system=antd\|orbit&sample=expiry`；字段页 Expires | 旧 Select / Orbit Select |
| `antd-popconfirm` / `orbit-popconfirm` | `?system=antd\|orbit&sample=popconfirm`（新增：任务面板的删除确认，同一触发器，`Answer` 输出确认或取消） | 旧 Popconfirm / Orbit Popconfirm |
| `antd-dialog` / `orbit-dialog`、`antd-confirm` / `orbit-confirm` | overlays fixture 外观对照的四个按钮（原有） | 旧 Modal / Orbit Dialog、`modal.confirm`（Cancel 自动聚焦）/ Orbit ConfirmDialog |

子菜单目标先用 paced 键打开父菜单，等焦点停在 Provider 上再开始序列：
- 旧 Dropdown 用 ⏎、Tab（焦点到这时才进菜单）；
- Orbit 样例用 ⏎；
- 会话菜单两边各自再加 ↓；
- 字段页用 ↓↓。

判定（[summarize.py](summarize.py)）沿用前两个任务：
- 每个「目标 × 序列」以 paced 多数结果为参照，burst 与之不同即为错。
- 逐序列先判旧 AntD：
  1. 是否赋予被测键功能：paced 结果是否不同于去掉被测键的对照序列。菜单与子菜单沿用前一任务的规则，看 paced 是否执行了某一项；Popconfirm 看是否作出确认或取消。旧组件靠再按一次触发器把弹层关上，不算功能。
  2. burst 是否保持 paced 结果，比较整个结果，含焦点。
- 两条都成立而 Orbit 的 burst 与自己的 paced 不同时，才修。

## 协调者的判定（2026-10-07）

本任务向协调者提了两次判定请求：

1. 第一次（请求 `34bmkQOQMVlLBnWVNUDVt`，回复选 1B、2 确认、3 确认）：
   - **子菜单**按 B 修。协调者的理由：这不是对「只记录」开例外，而是回归修复。旧 AntD 在窗口里什么也不执行，Orbit 却执行父菜单的其他项，甚至 Delete。要求：
     - 只改 `Menu.tsx`；
     - jsdom 单测断言窗口内的 ↓↑/Home/End/⏎ 不执行任何父菜单项，结果与 paced 一致；
     - 顶层 Menu 已验收的行为、Tab 约定和原断言不变。
   - **顶层 Menu 窗口内的 Tab/Shift+Tab** 按 10-07 的约定修：Tab 离开并关闭，Shift+Tab 与 paced 一样回到触发器。目标是 burst 等于 paced，不是恢复旧 Dropdown 语义。⏎Tab⏎ 在这里与旧 Dropdown 不同，是约定带来的差异，不是回归。
   - **Popconfirm** 归为「旧 AntD 不处理」，只记录不改。要列出 Orbit burst 的实际结果，证明它从不误确认、也不误取消。
   - Dialog/ConfirmDialog 与 Select 的 Tab 按规则直接修。Dialog 的修法在共享的 `OverlaySurface` 上，要证明其他用到它的弹层已验收的行为不变：打开时的初始焦点、关闭后焦点回到触发器、Escape；choices、overlays、试点和 P0 入口里涉及的都要跑。新增的 fixture 样例不能改变已有截图和断言。8000 个样本的原始数据留在 `/var/tmp`，只提交汇总和被引用的原件。
2. 第二次（请求 `34bokehBhWb4VvfWqyOV4`，选 B）：顶层 Menu 的交接再加 Home/End。
   - 理由同子菜单：旧 AntD 在窗口里什么也不执行，Orbit 的 burst 却执行了错误的项，算回归。
   - jsdom 至少覆盖 ⏎End⏎、↓End⏎ 和 ↑Home⏎，三者都要在修复前的代码上失败。
   - 冻结帧加 ⏎End⏎、↑Home⏎。
   - ⏎Space 维持只记录。
   - ↑Home⏎ 判为回归时还没有采样，依据是读代码；之后补采了基线（`baseline-menu-c`），修复后由确定性用例证实。
3. 清单复扫后的两条（2026-10-07，见[清单复扫](#清单复扫与-2026-10-07djson)）：ChoicesFixture.tsx 新增的 antd Popconfirm 导入登记为 `inventory-delta/2026-10-07d.json`，owner 仍为 P6，条目 status 用 `amended`（请求 `34bt5NJy7hlys1RIl41ij`，选 B）；合并树上另有的 2 个未归属测试文件由 P4.2 用 `2026-10-07c.json` 登记，不归本任务。

## 基线与逐组合结论

逐组合的完整数字（每个目标的 paced 参照与一致数、burst 错数及其结果、窗口和交接数，修复后的同一组数字）在 [combinations.md](combinations.md)，由 [render-tables.py](render-tables.py) 从 [keyboard-window-summary.json](keyboard-window-summary.json) 生成。下表只列需要处理或记录的组合（Orbit 目标；`20/20` 指 burst 20 个样本全部与 paced 参照不同）。

下表列出修复前 burst 与 paced 不同的全部 74 个 Orbit 组合，每个目标一行；其余 59 个 Orbit 组合 burst 本来就与 paced 一致，在 [combinations.md](combinations.md) 里。「对应旧 AntD」：会话菜单对 `antd-session`，其余子菜单目标对 `antd-submenu`，菜单对 `antd-menu`，Select 对 `antd-sample`，Popconfirm 对 `antd-popconfirm`，Dialog 对 `antd-dialog`，ConfirmDialog 对 `antd-confirm`。「修复后」：子菜单取终版 `aed0a7bab` 上的 `after2-sub-*`，其余取 `069601b67` 上的 `after-*`（终版只改了子菜单触发器）。

| 序列 | Orbit 目标 | 对应旧 AntD 的 paced 参照（burst 错） | Orbit paced 参照 | Orbit 修复前 burst | 结论 | 修复后 burst 错 |
| --- | --- | --- | --- | --- | --- | --- |
| `dlg-enter-enter`（⏎ ⏎） | `orbit-confirm` | `ran Cancel \| none \| @button:AntD confirm`（0/20） | `ran Cancel \| none \| @button:Orbit confirm` | 20/20：`none \| alertdialog:Delete runner? \| @button:Cancel`×20 | 规则：修 | **0/20** |
| `dlg-enter-shift-tab`（⏎ Shift+Tab） | `orbit-confirm` | `none \| dialog:Delete runner? \| @button:Delete`（20/20） | `none \| alertdialog:Delete runner? \| @button:Delete` | 20/20：`none \| alertdialog:Delete runner? \| @button:Cancel`×20 | 规则：只记录（旧 modal.confirm 自己的 burst 也 20/20 不同）；Overlay 修复后顺带一致 | **0/20** |
| `dlg-enter-shift-tab`（⏎ Shift+Tab） | `orbit-dialog` | `none \| dialog:Edit workspace \| @button:Save`（0/20） | `none \| dialog:Edit workspace \| @button:Save` | 20/20：`none \| dialog:Edit workspace \| @dialog（弹层本身）`×20 | 规则：修 | **0/20** |
| `dlg-enter-space`（⏎ Space） | `orbit-confirm` | `ran Cancel \| none \| @button:AntD confirm`（0/20） | `ran Cancel \| none \| @button:Orbit confirm` | 20/20：`none \| alertdialog:Delete runner? \| @button:Cancel`×20 | 规则：修 | **0/20** |
| `dlg-enter-tab`（⏎ Tab） | `orbit-confirm` | `none \| dialog:Delete runner? \| @button:Delete`（20/20） | `none \| alertdialog:Delete runner? \| @button:Delete` | 20/20：`none \| alertdialog:Delete runner? \| @button:Cancel`×20 | 规则：只记录（旧 modal.confirm 自己的 burst 也 20/20 不同）；Overlay 修复后顺带一致 | **0/20** |
| `dlg-enter-tab`（⏎ Tab） | `orbit-dialog` | `none \| dialog:Edit workspace \| @input:`（0/20） | `none \| dialog:Edit workspace \| @button:Close` | 20/20：`none \| dialog:Edit workspace \| @dialog（弹层本身）`×20 | 规则：修 | **0/20** |
| `dlg-enter-tab-enter`（⏎ Tab ⏎） | `orbit-confirm` | `ran Delete \| none \| @button:AntD confirm`（0/20） | `ran Delete \| none \| @button:Orbit confirm` | 20/20：`none \| alertdialog:Delete runner?+dialog:Delete runner? \| @button:Cancel`×20 | 规则：修 | **0/20** |
| `dlg-enter-tab-enter`（⏎ Tab ⏎） | `orbit-dialog` | `none \| dialog:Edit workspace \| @input:`（0/20） | `ran Close \| none \| @button:Orbit dialog` | 20/20：`none \| dialog:Edit workspace \| @button:Close`×20 | 规则：修 | **0/20** |
| `menu-down-end-enter`（↓ End ⏎） | `orbit-menu` | `none \| menu×1 \| @button:Add attachment`（0/20） | `Action=command \| none \| @button:Add attachment` | 20/20：`Action=file \| none \| @button:Add attachment`×20 | 协调者判定 2B：回归，修 | **0/20** |
| `menu-down-end-enter`（↓ End ⏎） | `orbit-menu-sample` | `none \| menu×1 \| @button:Add attachment`（0/20） | `ran /Command \| none \| @button:Add attachment` | 20/20：`ran File \| none \| @button:Add attachment`×20 | 协调者判定 2B：回归，修 | **0/20** |
| `menu-enter-end-enter`（⏎ End ⏎） | `orbit-menu` | `none \| none \| @button:Add attachment`（0/20） | `Action=command \| none \| @button:Add attachment` | 20/20：`Action=file \| none \| @button:Add attachment`×20 | 协调者判定 2B：回归，修 | **0/20** |
| `menu-enter-end-enter`（⏎ End ⏎） | `orbit-menu-sample` | `none \| none \| @button:Add attachment`（0/20） | `ran /Command \| none \| @button:Add attachment` | 20/20：`ran File \| none \| @button:Add attachment`×20 | 协调者判定 2B：回归，修 | **0/20** |
| `menu-enter-shift-tab`（⏎ Shift+Tab） | `orbit-menu` | `none \| menu×1 \| @menuitem:File`（0/20） | `none \| none \| @button:Add attachment` | 20/20：`none \| none \| @body:darkSwitch themeOpen Dia`×20 | 协调者判定 1-2：按约定修（burst 等于 paced） | **0/20** |
| `menu-enter-shift-tab`（⏎ Shift+Tab） | `orbit-menu-sample` | `none \| menu×1 \| @menuitem:File`（0/20） | `none \| none \| @button:Add attachment` | 20/20：`none \| none \| @body:darkSwitch themeAdd atta`×20 | 协调者判定 1-2：按约定修（burst 等于 paced） | **0/20** |
| `menu-enter-shift-tab-enter`（⏎ Shift+Tab ⏎） | `orbit-menu` | `ran File \| none \| @body:darkSwitch themeAdd atta`（0/20） | `none \| menu×1 \| @menuitem:File` | 20/20：`none \| none \| @body:darkSwitch themeOpen Dia`×20 | 规则：修 | **0/20** |
| `menu-enter-shift-tab-enter`（⏎ Shift+Tab ⏎） | `orbit-menu-sample` | `ran File \| none \| @body:darkSwitch themeAdd atta`（0/20） | `none \| menu×1 \| @menuitem:File` | 20/20：`none \| none \| @body:darkSwitch themeAdd atta`×20 | 规则：修 | **0/20** |
| `menu-enter-space`（⏎ Space） | `orbit-menu` | `none \| none \| @button:Add attachment`（0/20） | `Action=file \| none \| @button:Add attachment` | 20/20：`none \| none \| @button:Add attachment`×20 | 规则：只记录，不改 | **20/20** |
| `menu-enter-space`（⏎ Space） | `orbit-menu-sample` | `none \| none \| @button:Add attachment`（0/20） | `ran File \| none \| @button:Add attachment` | 20/20：`none \| none \| @button:Add attachment`×20 | 规则：只记录，不改 | **20/20** |
| `menu-enter-tab`（⏎ Tab） | `orbit-menu` | `none \| menu×1 \| @menuitem:File`（0/20） | `none \| none \| @button:Open context` | 20/20：`none \| menu×1 \| @menuitem:File`×20 | 协调者判定 1-2：按约定修（burst 等于 paced） | **0/20** |
| `menu-enter-tab`（⏎ Tab） | `orbit-menu-sample` | `none \| menu×1 \| @menuitem:File`（0/20） | `none \| none \| @button:Switch theme` | 20/20：`none \| menu×1 \| @menuitem:File`×20 | 协调者判定 1-2：按约定修（burst 等于 paced） | **0/20** |
| `menu-enter-tab-enter`（⏎ Tab ⏎） | `orbit-menu` | `ran File \| none \| @body:darkSwitch themeAdd atta`（0/20） | `none \| dialog:Context \| @dialog（弹层本身）` | 20/20：`Action=file \| none \| @button:Add attachment`×20 | 规则：修 | **0/20** |
| `menu-enter-tab-enter`（⏎ Tab ⏎） | `orbit-menu-sample` | `ran File \| none \| @body:darkSwitch themeAdd atta`（0/20） | `none \| none \| @button:Switch theme \| theme changed` | 20/20：`ran File \| none \| @button:Add attachment`×20 | 规则：修 | **0/20** |
| `menu-up-home-enter`（↑ Home ⏎） | `orbit-menu` | `none \| menu×1 \| @button:Add attachment`（0/20） | `Action=file \| none \| @button:Add attachment` | 20/20：`Action=command \| none \| @button:Add attachment`×20 | 协调者判定 2B：回归，修 | **0/20** |
| `menu-up-home-enter`（↑ Home ⏎） | `orbit-menu-sample` | `none \| menu×1 \| @button:Add attachment`（0/20） | `ran File \| none \| @button:Add attachment` | 20/20：`ran /Command \| none \| @button:Add attachment`×20 | 协调者判定 2B：回归，修 | **0/20** |
| `pop-enter-enter`（⏎ ⏎） | `orbit-popconfirm` | `none \| none \| @button:Delete task`（0/20） | `none \| dialog:Delete this task? \| @dialog（弹层本身）` | 20/20：`none \| none \| @button:Delete task`×20 | 规则：只记录，不改 | **20/20** |
| `pop-enter-shift-tab`（⏎ Shift+Tab） | `orbit-popconfirm` | `none \| tooltip:Delete this task?A r \| @button:Switch theme`（0/20） | `none \| dialog:Delete this task? \| @button:Delete task` | 20/20：`none \| none \| @button:Switch theme`×20 | 规则：只记录，不改 | **20/20** |
| `pop-enter-space`（⏎ Space） | `orbit-popconfirm` | `none \| none \| @button:Delete task`（0/20） | `none \| dialog:Delete this task? \| @dialog（弹层本身）` | 20/20：`none \| none \| @button:Delete task`×20 | 规则：只记录，不改 | **20/20** |
| `select-down-end-enter`（↓ End ⏎） | `orbit-field` | `Never \| list closed \| none \| @combobox:Sample choice`（0/20） | `never \| list open \| listbox×1 \| @option:30 days` | 20/20：`never \| list closed \| none \| @combobox:Expires`×20 | 规则：只记录，不改 | **20/20** |
| `select-down-end-enter`（↓ End ⏎） | `orbit-sample` | `Never \| list closed \| none \| @combobox:Sample choice`（0/20） | `Never \| list open \| listbox×1 \| @option:30 days` | 20/20：`Never \| list closed \| none \| @combobox:Sample choice`×20 | 规则：只记录，不改 | **20/20** |
| `select-down-home-enter`（↓ Home ⏎） | `orbit-field` | `7 days \| list closed \| none \| @combobox:Sample choice`（0/20） | `never \| list closed \| none \| @combobox:Expires` | 20/20：`7 \| list closed \| none \| @combobox:Expires`×20 | 规则：只记录，不改 | **20/20** |
| `select-down-home-enter`（↓ Home ⏎） | `orbit-sample` | `7 days \| list closed \| none \| @combobox:Sample choice`（0/20） | `Never \| list closed \| none \| @combobox:Sample choice` | 20/20：`7 days \| list closed \| none \| @combobox:Sample choice`×20 | 规则：只记录，不改 | **20/20** |
| `select-down-shift-tab`（↓ Shift+Tab） | `orbit-field` | `Never \| list closed \| none \| @combobox:Sample choice`（0/20） | `never \| list closed \| none \| @combobox:Expires` | 20/20：`never \| list closed \| none \| @button:Open legacy Modal`×20 | 规则：修 | **0/20** |
| `select-down-shift-tab`（↓ Shift+Tab） | `orbit-sample` | `Never \| list closed \| none \| @combobox:Sample choice`（0/20） | `Never \| list closed \| none \| @combobox:Sample choice` | 20/20：`Never \| list closed \| none \| @button:Switch theme`×20 | 规则：修 | **0/20** |
| `select-down-space-from-null`（↓ Space） | `orbit-field` | — | `never \| list closed \| none \| @combobox:Expires` | 20/20：`null \| list closed \| none \| @combobox:Expires`×20 | 无旧样本：只记录，不改 | **20/20** |
| `select-down-tab`（↓ Tab） | `orbit-field` | `Never \| list closed \| none \| @combobox:Sample choice`（0/20） | `never \| list closed \| none \| @combobox:Workspace` | 20/20：`never \| list closed \| none \| @button:Clear selection`×20 | 规则：修 | **0/20** |
| `select-down-tab`（↓ Tab） | `orbit-sample` | `Never \| list closed \| none \| @combobox:Sample choice`（0/20） | `Never \| list closed \| none \| @combobox:Sample choice` | 20/20：`Never \| list open \| listbox×1 \| @option:Never`×20 | 规则：修 | **0/20** |
| `select-enter-tab`（⏎ Tab） | `orbit-field` | `Never \| list closed \| none \| @combobox:Sample choice`（0/20） | `never \| list closed \| none \| @combobox:Workspace` | 20/20：`never \| list closed \| none \| @button:Clear selection`×20 | 规则：修 | **0/20** |
| `select-enter-tab`（⏎ Tab） | `orbit-sample` | `Never \| list closed \| none \| @combobox:Sample choice`（0/20） | `Never \| list closed \| none \| @combobox:Sample choice` | 20/20：`Never \| list open \| listbox×1 \| @option:Never`×20 | 规则：修 | **0/20** |
| `sub-enter-down-enter`（⏎ ↓ ⏎） | `orbit-session` | `Picked=claude \| menu×1 \| @menuitem:Claude`（20/20） | `Picked=claude \| none \| @button:Session actions` | 20/20：`Picked=group \| none \| @button:Session actions`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-enter-down-enter`（⏎ ↓ ⏎） | `orbit-submenu` | `ran Claude \| menu×1 \| @menuitem:Claude`（20/20） | `Action=claude \| none \| @button:Session actions` | 20/20：`Tag=true \| menu×1 \| @menuitemcheckbox:Important tag`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-enter-down-enter`（⏎ ↓ ⏎） | `orbit-submenu-sample` | `ran Claude \| menu×1 \| @menuitem:Claude`（20/20） | `ran Claude \| none \| @button:Add attachment` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-enter-enter`（⏎ ⏎） | `orbit-session` | `Picked=codex \| menu×1 \| @menuitem:Codex`（20/20） | `Picked=codex \| none \| @button:Session actions` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-enter-enter`（⏎ ⏎） | `orbit-submenu` | `ran Codex \| menu×1 \| @menuitem:Codex`（20/20） | `Action=codex \| none \| @button:Session actions` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-enter-enter`（⏎ ⏎） | `orbit-submenu-sample` | `ran Codex \| menu×1 \| @menuitem:Codex`（20/20） | `ran Codex \| none \| @button:Add attachment` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-c-enter`（→ c ⏎） | `orbit-session` | `Picked=codex \| menu×1 \| @menuitem:Codex`（20/20） | `Picked=claude \| none \| @button:Session actions` | 20/20：`none \| menu×2 \| @menuitem:Claude`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-c-enter`（→ c ⏎） | `orbit-submenu` | `ran Codex \| menu×1 \| @menuitem:Codex`（20/20） | `Action=claude \| none \| @button:Session actions` | 20/20：`none \| menu×2 \| @menuitem:Claude`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-c-enter`（→ c ⏎） | `orbit-submenu-sample` | `ran Codex \| menu×1 \| @menuitem:Codex`（20/20） | `ran Claude \| none \| @button:Add attachment` | 20/20：`none \| menu×2 \| @menuitem:Claude`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-down-enter`（→ ↓ ⏎） | `orbit-session` | `Picked=claude \| menu×1 \| @menuitem:Claude`（20/20） | `Picked=claude \| none \| @button:Session actions` | 20/20：`Picked=group \| none \| @button:Session actions`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-down-enter`（→ ↓ ⏎） | `orbit-submenu` | `ran Claude \| menu×1 \| @menuitem:Claude`（20/20） | `Action=claude \| none \| @button:Session actions` | 20/20：`Tag=true \| menu×1 \| @menuitemcheckbox:Important tag`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-down-enter`（→ ↓ ⏎） | `orbit-submenu-sample` | `ran Claude \| menu×1 \| @menuitem:Claude`（20/20） | `ran Claude \| none \| @button:Add attachment` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-end-enter`（→ End ⏎） | `orbit-session` | `Picked=claude \| menu×1 \| @menuitem:Claude`（20/20） | `Picked=claude \| none \| @button:Session actions` | 20/20：`Picked=delete \| none \| @button:Session actions`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-end-enter`（→ End ⏎） | `orbit-submenu` | `ran Claude \| menu×1 \| @menuitem:Claude`（20/20） | `Action=claude \| none \| @button:Session actions` | 20/20：`Action=delete \| none \| @button:Session actions`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-end-enter`（→ End ⏎） | `orbit-submenu-sample` | `ran Claude \| menu×1 \| @menuitem:Claude`（20/20） | `ran Claude \| none \| @button:Add attachment` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-enter`（→ ⏎） | `orbit-session` | `Picked=codex \| menu×1 \| @menuitem:Codex`（20/20） | `Picked=codex \| none \| @button:Session actions` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-enter`（→ ⏎） | `orbit-submenu` | `ran Codex \| menu×1 \| @menuitem:Codex`（20/20） | `Action=codex \| none \| @button:Session actions` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-enter`（→ ⏎） | `orbit-submenu-sample` | `ran Codex \| menu×1 \| @menuitem:Codex`（20/20） | `ran Codex \| none \| @button:Add attachment` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-home-enter`（→ Home ⏎） | `orbit-session` | `Picked=codex \| menu×1 \| @menuitem:Codex`（20/20） | `Picked=codex \| none \| @button:Session actions` | 20/20：`Picked=default \| none \| @button:Session actions`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-home-enter`（→ Home ⏎） | `orbit-submenu` | `ran Codex \| menu×1 \| @menuitem:Codex`（20/20） | `Action=codex \| none \| @button:Session actions` | 20/20：`Action=default \| none \| @button:Session actions`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-home-enter`（→ Home ⏎） | `orbit-submenu-sample` | `ran Codex \| menu×1 \| @menuitem:Codex`（20/20） | `ran Codex \| none \| @button:Add attachment` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-left`（→ ←） | `orbit-session` | `none \| menu×1 \| @menuitem:Provider`（20/20） | `none \| menu×1 \| @menuitem:Provider` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-left`（→ ←） | `orbit-submenu` | `none \| menu×1 \| @menuitem:Provider`（20/20） | `none \| menu×1 \| @menuitem:Provider` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-left`（→ ←） | `orbit-submenu-sample` | `none \| menu×1 \| @menuitem:Provider`（20/20） | `none \| menu×1 \| @menuitem:Provider` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-shift-tab`（→ Shift+Tab） | `orbit-session` | `none \| menu×1 \| @button:Switch theme`（20/20） | `none \| menu×1 \| @menuitem:Provider` | 20/20：`none \| none \| @button:Session actions`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-shift-tab`（→ Shift+Tab） | `orbit-submenu` | `none \| menu×1 \| @button:Switch theme`（20/20） | `none \| menu×1 \| @menuitem:Provider` | 20/20：`none \| none \| @button:Session actions`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-shift-tab`（→ Shift+Tab） | `orbit-submenu-sample` | `none \| menu×1 \| @button:Switch theme`（20/20） | `none \| menu×1 \| @menuitem:Provider` | 20/20：`none \| none \| @button:Add attachment`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-space`（→ Space） | `orbit-session` | `none \| menu×2 \| @menuitem:Codex`（0/20） | `Picked=codex \| none \| @button:Session actions` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-space`（→ Space） | `orbit-submenu` | `none \| menu×2 \| @menuitem:Codex`（0/20） | `Action=codex \| none \| @button:Session actions` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-space`（→ Space） | `orbit-submenu-sample` | `none \| menu×2 \| @menuitem:Codex`（0/20） | `ran Codex \| none \| @button:Add attachment` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-tab`（→ Tab） | `orbit-session` | `none \| menu×1 \| @body:darkSwitch themeSession `（20/20） | `none \| none \| @button:Switch theme` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-tab`（→ Tab） | `orbit-submenu` | `none \| menu×1 \| @body:darkSwitch themeAdd atta`（20/20） | `none \| none \| @button:Add attachment` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-tab`（→ Tab） | `orbit-submenu-sample` | `none \| menu×1 \| @body:darkSwitch themeAdd atta`（20/20） | `none \| none \| @button:Switch theme` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-up-enter`（→ ↑ ⏎） | `orbit-session` | `Picked=claude \| menu×1 \| @menuitem:Claude`（20/20） | `Picked=claude \| none \| @button:Session actions` | 20/20：`Picked=default \| none \| @button:Session actions`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-up-enter`（→ ↑ ⏎） | `orbit-submenu` | `ran Claude \| menu×1 \| @menuitem:Claude`（20/20） | `Action=claude \| none \| @button:Session actions` | 20/20：`Action=default \| none \| @button:Session actions`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |
| `sub-right-up-enter`（→ ↑ ⏎） | `orbit-submenu-sample` | `ran Claude \| menu×1 \| @menuitem:Claude`（20/20） | `ran Claude \| none \| @button:Add attachment` | 20/20：`none \| menu×2 \| @menuitem:Codex`×20 | 协调者判定 1B：子菜单回归，修 | **0/20** |

合计：要修的 62 个组合修复后都是 0/20；只记录的 12 个里，ConfirmDialog 的 2 个因 Overlay 修复顺带变成 0/20，其余 10 个仍是 20/20，结果与修复前逐样本相同；74 个组合的 paced 参照都没有变。

## 改动

产品代码只改了三个组件，都在 `src/web/src/components/ui/`。修法同 632b7950e：只用 Base UI 的公开 API（`initialFocus` 函数、`preventBaseUIHandler`）和 Orbit 自己的事件处理，不加延时、不重试，也不读 AntD 的 DOM。

| 提交 | 文件 | 改了什么 | 修的组合 |
| --- | --- | --- | --- |
| `e78ecf527` | `Overlay.tsx` 的 `OverlaySurface`（Dialog、ConfirmDialog、Drawer 共用） | `BaseDialog.Popup` 的 `initialFocus` 改成函数。Base UI 打开时调用它：焦点不在弹层里，就立刻把焦点放到原来的初始焦点上（调用方给的元素，否则弹层本身），并返回 `false`，Base UI 下一帧不再移动焦点。调用方给的 ref 为空时返回 `true`，沿用 Base UI 的默认，和原来一样。`finalFocus`、Escape、滚动锁和逐层关闭都不动。 | Dialog ⏎Tab、⏎Shift+Tab、⏎Tab⏎；ConfirmDialog ⏎⏎、⏎Space、⏎Tab⏎；顺带 ConfirmDialog ⏎Tab、⏎Shift+Tab |
| `616f1e378` | `Select.tsx` | 触发器的窗口交接（632b7950e 的 ↓/↑/⏎）加上 Tab：Tab 先把焦点移到高亮项（没有就移到列表），不阻止默认动作，由浏览器从那里继续 Tab；Shift+Tab 与 ↓/↑/⏎ 一样转交给高亮项。↓/↑/⏎ 的处理与原来逐行相同。 | ↓Tab、↓Shift+Tab、⏎Tab |
| `069601b67` | `Menu.tsx` | 顶层触发器的交接（4fb7ee43f 的 ↓/↑/⏎）提成 `handOver()`，交接键加上 Home、End 和 Tab（Tab 先移焦点再由浏览器继续，Shift+Tab 转交）。子菜单触发器在自己的子菜单打开、且其中有高亮项（从键盘打开）时，把 ↓/↑/Home/End/⏎/Space/←/Tab/Shift+Tab 交给那一项；鼠标悬停打开的子菜单没有高亮项，键仍归父菜单。 | 顶层 Menu ⏎Tab、⏎Shift+Tab、⏎Tab⏎、⏎Shift+Tab⏎、⏎End⏎、↓End⏎、↑Home⏎；子菜单窗口的全部组合 |
| `aed0a7bab` | `Menu.tsx` | 子菜单触发器转交 ⏎/Space 之前，先把焦点移到子菜单的高亮项，下一帧本来也会这样做。见下节。 | 子菜单窗口里执行子菜单项的组合（焦点归还） |

测试与样例：
- `0594f6d2c`、`4d54fbe5f`：新增 jsdom 单测 `keyboardWindow.test.tsx`（子菜单 18、顶层 Menu Tab/Shift+Tab 8、Home/End 6、Select Tab 6、Dialog 10、ConfirmDialog 10）。原有测试文件和断言一行未改。
- `5cd02c2ae`、`53d8fcb2d`：choices fixture（`__fixtures__/ChoicesFixture.tsx`）的外观样例新增 `sample=popconfirm` 和 `sample=session` 两种，旧 AntD 与 Orbit 各一份，同一触发器，带 output。已有样例的渲染不变：choices 测试列表 520 个用例在修改前后逐字节相同（[prod-before-choices-list](checks/prod-before-choices-list.txt)、[prod-after-choices-list](checks/prod-after-choices-list.txt)、[prod-final-choices-list](checks/prod-final-choices-list.txt)）。完整 choices 矩阵在终版树上的结果见[已验收行为的回归](#已验收行为的回归)。

### 第二次子菜单修复

第一版（`069601b67`）上的冻结帧探针是 312/392。失败的是子菜单的 10 例（→⏎、→Space、→Home⏎、→↑⏎、⏎⏎，会话菜单与字段页各 5 例），八个环境都失败：
- 这 10 例执行的项都对，失败在焦点：菜单关上后焦点落到 body，没有回到菜单按钮。
- 它们的共同点是 ⏎/Space 转交给子菜单项时，焦点还在父菜单的子菜单触发器上。→Home⏎ 的 Home 停在第一项，焦点不动；→↑⏎ 的 ↑ 从第一项绕到最后一项，焦点要下一帧才移。→↓⏎、→End⏎、⏎↓⏎ 的 ↓/End 当即把焦点移进子菜单，所以这 3 例通过。

burst 也一样：`after-sub-a` 里会话菜单和字段页的 →⏎、→↑⏎ 都是 20/20 执行了对的项，但焦点落到 body（[after-sub-a](after-sub-a/samples.csv)）。

浏览器 trace 显示了原因。第一版把 ⏎ 转交给子菜单项时，焦点还在父菜单的子菜单触发器上。菜单项执行时自己拿焦点，而这一步和两层菜单的关闭发生在同一个任务里，Base UI 因此不再把焦点交还菜单按钮；随后弹层卸载，焦点就掉到了 body。焦点已在子菜单里时（paced），关闭从子菜单开始，焦点照常回到菜单按钮。

`aed0a7bab` 在转交 ⏎/Space 之前先把焦点移到那一项。这一步下一帧本来也会做，之后的过程就与 paced 相同。修复后冻结帧 392/392，burst 见下文。

这次焦点丢失在 jsdom 里没能复现，补上 `getAnimations` 的模拟后也一样。所以子菜单窗口里「执行后焦点回到菜单按钮」这一点，确定性回归靠冻结帧探针：八个环境，不依赖自然时序。jsdom 单测覆盖的是执行了哪一项，以及没有执行父菜单项。

## 修复前后对照

同一探针、同样条件，修复前后各采一次。

| 探针 | 修复前 | 第一版修复（`069601b67`） | 终版（`aed0a7bab`） |
| --- | --- | --- | --- |
| burst/paced，Chromium（Orbit 目标；每组合 20+20） | Orbit 有 74 个组合 burst 与 paced 不同，全是 20/20：要修的 62 个（规则 16、子菜单 36、顶层 Menu ⏎Tab/⏎Shift+Tab 4、Home/End 6），只记录的 12 个 | 菜单、Select、Dialog/ConfirmDialog、Popconfirm 全部重采（`after-*`，3200 样本）：要修的组合 0/20；只记录的组合与修复前相同；子菜单第一块（`after-sub-a`）见上节 | 子菜单三块重采（`after2-sub-*`）：【待补】。其余组件没有改动（`aed0a7bab` 只动子菜单触发器的 ⏎/Space），沿用 `069601b67` 上的 `after-*` |
| 冻结帧，八环境（49 例 × 8） | 72/392（[before](checks/fix-held-frames-before.txt)、[before-home-end](checks/fix-held-frames-before-home-end.txt)）：通过的 9 例是本来就相同的（Dialog/ConfirmDialog 的 ⏎Escape、Dialog ⏎⏎、Popconfirm 6 例） | 312/392（[after](checks/fix-held-frames-after.txt)）：子菜单 10 例焦点落到 body | **392/392**（[after2](checks/fix-held-frames-after2.txt)） |
| jsdom 单测 `keyboardWindow.test.tsx` | 0594f6d2c 上 23/52 失败（[unit-window-before](checks/unit-window-before.txt)）；加入 Home/End 后 4d54fbe5f 上 26/58 失败（[unit-window-before-2](checks/unit-window-before-2.txt)）。失败的全是窗口用例，参照全过 | 58/58（[unit-window-after](checks/unit-window-after.txt)） | **58/58**（[unit-window-final](checks/unit-window-final.txt)） |
| 前任务 Select 探针（↓/↑/⏎，276 样本） | 276/276，burst 0 错（[prior-select-keys-before](checks/prior-select-keys-before.txt)） | 276/276（[prior-select-keys-after](checks/prior-select-keys-after.txt)） | Select 未再改动，沿用 |
| 前任务 Menu 冻结帧（10 例 × 8） | 80/80（[prior-menu-held-frames-before](checks/prior-menu-held-frames-before.txt)） | 80/80（[after](checks/prior-menu-held-frames-after.txt)） | **80/80**（[after2](checks/prior-menu-held-frames-after2.txt)） |
| `Menu.test.tsx`（前任务的确定性单测） | 18/18 | 18/18 | **18/18** |

修复前 jsdom 的失败（[unit-window-before](checks/unit-window-before.txt)）逐项对应探针看到的错误：
- 子菜单 9 个：执行了父菜单项（group、default、delete），或子菜单没有执行；
- 顶层 Menu Tab/Shift+Tab 4 个；
- Select Tab/Shift+Tab 3 个；
- Dialog Tab/Shift+Tab 3 个；
- ConfirmDialog ⏎/Space/Tab 4 个；
- Home/End 3 个：⏎End⏎、↓End⏎ 执行 File 而不是 /Command，↑Home⏎ 执行 /Command 而不是 File（[unit-window-before-2](checks/unit-window-before-2.txt)）。

本来就相同的 3 个窗口用例（Dialog ⏎⏎、Dialog ⏎Escape、ConfirmDialog ⏎Escape）在修复前也通过，说明测试不是只认修复后的写法。

## 已验收行为的回归

都用各自的原有命令和配置，经 [prod-runs.sh](prod-runs.sh) 在生产构建上跑，每次只跑一个，各在自己的网络命名空间里，`nice -n -10`。修复前在 `0594f6d2c` 上跑：它只加了测试和探针，没改组件。第一版在 `069601b67` 上跑，终版在 `aed0a7bab` 的源码上跑（记录里的提交是当时的 HEAD，之后只多了证据提交，Web 树不变）。终版的运行在 [final-queue.sh](final-queue.sh) 里排队。原件在 `/var/tmp/kw2-246921c8/runs/<步骤>-<标签>`，这里是瘦身副本和 `checks/prod-<标签>-<步骤>.*` 记录。

| 检查 | 修复前 | 第一版 | 终版 |
| --- | --- | --- | --- |
| choices 原入口，八环境（`test:ui-choices -- --grep "Dialog owns choices\|Dialog keeps composition\|Dialog Popover Select exits"`，32 个用例） | 32/32 | 30/32：`no-preference Dialog Popover Select exits restore one layer at a time` 在 chromium-light-desktop 和 webkit-dark-phone 各失败一次（负载 48.7，与另外两个探针同时跑） | **32/32**（负载 10.8） |
| 上面那条用例在这两个环境各重复 10 次（`--repeat-each 10`，40 次） | — | — | 终版 **40/40**（[entry-repeat-final](checks/prod-final-entry-repeat.txt)）；三个组件换回修复前（`0638f1944` 的 Overlay/Select/Menu，只换工作区，记录里是 dirty）也是 **40/40**（[entry-repeat-prefix](checks/prod-prefix-entry-repeat.txt)） |
| overlays 矩阵（`test:ui-overlays`，96 个用例：初始焦点、焦点归还、逐层 Esc、滚动锁、Drawer 等） | 96/96 | 96/96（负载 62.8） | **96/96** |
| choices 测试列表（`playwright --list`） | 520 个用例 | 逐字节相同 | **逐字节相同**（sha256 `869171286b2f…`） |
| 完整 choices 矩阵（`test:ui-choices`，按项目分 8 次跑） | — | — | 【待补】 |
| 试点（P3.2 pilot，生产构建，每棵树两次） | 72/72、72/72 | — | 72/72、【待补】 |
| P0（`npm run test:ui-migration`，原命令） | 93 通过、8 失败、11 跳过；失败的都是 `profile`（`GET /api/auth/methods` 没有浏览器 fixture，P0 fixture 漂移） | — | 【待补】 |
| 相关单测 | — | 16 个文件 260 个用例（[unit-related-after](checks/unit-related-after.txt)） | 合并检查里的完整 Vitest，见[合入项目 tip 之后](#合入项目-tip-之后) |

choices 入口那两次失败，不是第一版修复造成的：
- 终版在低负载下 32/32；
- 那条用例在两个环境各跑 10 次，终版和修复前的组件都是 40/40；
- 两次失败的断言都取决于时间（[checks/prod-after-choices-entry](checks/prod-after-choices-entry.txt)）：
  - chromium-light-desktop：最后一层关上后，页面滚动 320ms 后才动，上限是 250ms（滚动锁释放的时限）；
  - webkit-dark-phone：退出动画的帧采样里，没有一帧处在半透明（0 < opacity < 1），也就是没采到中间帧。

**试点**（[pilot-summary.json](pilot-summary.json)，由 [summarize-pilot.py](summarize-pilot.py) 对 `../p3.2/compare_runs.py` 的输出分类）：

| 对比 | 截图（相同 / 抗锯齿级 / 超出） | trace（相同 / 请求不同 / 只有快照字段不同） | 计算样式差异 |
| --- | --- | --- | --- |
| 修复前第 1 次 vs 第 2 次（同一棵树的噪声） | 223 / 32 / 1 | 57/64 / 0 / 9 | 0 |
| 修复前第 1 次 vs 终版第 1 次 | 224 / 31 / 1 | 58/64 / 0 / 8 | 0 |
| 终版第 1 次 vs 第 2 次（同一棵树的噪声） | 234 / 21 / 1 | 57/64 / 0 / 10 | 0 |
| 修复前第 2 次 vs 终版第 2 次 | 218 / 37 / 1 | 58/64 / 0 / 6 | 0 |

- 两次修复前后对比各有 1 张超出抗锯齿级的截图，都是 chromium-light-desktop 的 `pilot-delete-confirm.png`：5 个和 75 个像素，最大通道差 20。
- 差异全在任务面板右上角关闭按钮（×）图标的抗锯齿边缘上，x 1246–1247、y 28–39。本任务没有改这个图标，也没有改它所在的面板头。
- 两棵树各自两次运行之间也各有 1 张超出，是 chromium-dark-desktop 的同一张图，像素位置完全相同（最大差 15）。逐像素看，深色下这个图标在两种边缘状态之间来回：修复前和终版的第 1 次是同一状态，第 2 次是另一状态。
- 浅色下，修复前两次恰好都是一种状态，终版两次都是另一种。每棵树只有两次，这样分组可能是巧合，为此在两棵树上各补跑了 5 次：【待补：pilot-repeat 结果】
- trace 里没有请求不同的步骤。只有快照字段不同的几步，都是动作后立即采的焦点或列表快照，与噪声对比里出现的是同一类。

## 清单复扫与 2026-10-07d.json

作业指导要求各批开工时和交证据前都运行 `src/web/scripts/audit-antd.mjs`。本任务开工时漏跑了，这里在开工提交 `7732f14f8` 的源码上补跑。审计只读源码，所以结果与当时跑的相同。

[antd-audit.sh](antd-audit.sh) 用 git archive 取出审计的输入，在三棵树上各跑一次；[antd-audit-compare.py](antd-audit-compare.py) 写出对照 [antd-audit.json](antd-audit.json)，运行记录在 [checks/antd-audit](checks/antd-audit.txt)。
- 开工 `7732f14f8` → 终版 `aed0a7bab`：
  - 计数只有 scannedFiles、testFiles 各 +1，即新增的 `keyboardWindow.test.tsx`，它不含 antd 文本；
  - 直接引用 antd 的生产文件 100 → 100，`--check-retired` 阻塞文件 241 → 241；
  - antd 系列依赖的声明与锁定版本不变。
- 改动的 5 个文件里，只有 `ChoicesFixture.tsx` 的 antd 导入有变化：多了 `Popconfirm`（5cd02c2ae，Popconfirm 基线的旧实现参照）。`Menu.tsx`、`Overlay.tsx` 没有 antd 文本；`Select.tsx` 原有一处「as with AntD」注释，本次只在同一注释后面续写，命中数不变。
- 本分支与当时项目 tip `3aa26fb97` 的合并树（git merge-tree，不提交），用 tip 的脚本跑 `--check-owners`：2 个未归属点，都不是本分支带来的，而是随 tip 合并 main 进来的 `ProjectDoneConversation.test.tsx` 和 `RunnerEngines.accountFold.test.tsx`。已报告协调者，他判定这两个由 P4.2 用 `2026-10-07c.json` 登记，不归本任务。

协调者要求把 `ChoicesFixture.tsx` 新增的 antd Popconfirm 导入登记为 `inventory-delta/2026-10-07d.json`，owner 仍为 P6：
- 这个文件已由 `2026-10-07.json` 登记（status new，owner P6）。`--check-owners` 只对 P0.1 归属的文件检查符号增长，所以多出 Popconfirm 时它没有失去归属，新条目也就不是归属所必需的。
- 如果照 07 的格式写成 `changed`，`verify-record.mjs` 第 3 项（每个新增/改动条目都必需）会失败；在临时目录里实测确实如此。
- 协调者选了 B（请求 `34bt5NJy7hlys1RIl41ij`）：条目 status 用 `amended`，表示「重述已登记条目的当前事实，owner 不变，不是归属所必需」，所以第 3 项不适用；`added` 照写，相对被重述的条目计算。记录本身（`statusMeaning`）和 `inventory-delta/README.md` 都写明了这个含义；README 只在产物表追加一行、在 status 取值处补一条，不重排已有内容。
- 记录由 [build-inventory-record.py](build-inventory-record.py) 从本分支源码的审计生成，scan 是 `aed0a7bab` 的源码；[inventory-check.sh](inventory-check.sh) 做核对。结果：【待补】

## 合入项目 tip 之后

【待补：合入】

## 边界

本证据**不**证明下面这些：
- **浏览器与设备**：burst/paced 依赖 CDP 输入队列，只在 Chromium（`chromium-dark-desktop`）上采。WebKit 和手机视口由冻结帧覆盖（八个环境）。项目环境里没有 Firefox。真实设备、触摸和读屏软件都没有覆盖。
- **窗口出现的频率**：burst 让按键排在输入队列里，冻结帧扣住动画帧，两者都能稳定地造出窗口。真实使用中窗口多久出现一次取决于负载，本证据不测量。
- **jsdom 的近似**：测试按浏览器规则补的默认动作（⏎ 激活 button、Space 在 keyup 时激活、Tab 顺序）是近似。子菜单项执行后焦点能否回到菜单按钮，jsdom 复现不了，由冻结帧覆盖。
- **只记录的组合**修复后 burst 仍与 paced 不同；旧 AntD 在这些组合上也不处理该键，按规则不改：
  - 顶层 Menu ⏎Space：burst 不执行 File，菜单关上；
  - Select ↓Home⏎、↓End⏎：burst 时 Home/End 没有移动高亮，⏎ 选的是 ↓ 停的那一项；
  - Select ↓Space（从空值起）；
  - Popconfirm ⏎⏎、⏎Space、⏎Shift+Tab：burst 关上确认框，不回答问题。
- **Menu 的 Tab 约定**：⏎Tab⏎ 的 Orbit 结果与旧 Dropdown 不同。Orbit 是 Tab 离开并关闭菜单，⏎ 落在页面下一个按钮上；旧 Dropdown 是 Tab 进菜单，⏎ 执行 File。这是 10-07 约定带来的，不是回归。
- **字符检索**（`s`、`c`、`7`、`n`）：顶层 Menu 与 Select 的检索序列在基线上 Orbit 的 burst 已与 paced 一致，无需处理；子菜单的 →c⏎ 随子菜单窗口一起修。
- **P0**：`profile` 在八个环境都失败，是 P0 fixture 的漂移（`GET /api/auth/methods` 没有浏览器 fixture）。修复前后相同，与本任务无关。【待补：终版与合并树】
- **清单**：合并树上那 2 个未归属点要等 P4.2 的 `2026-10-07c.json` 落地后才消失。
【待补：其余】

## 文件与原始数据

脚本：

| 文件 | 用途 |
| --- | --- |
| [keyboard-window-2.browser.mjs](keyboard-window-2.browser.mjs)、[keyboard-window-2.config.mjs](keyboard-window-2.config.mjs) | burst/paced 探针 |
| [held-frames-2.browser.mjs](held-frames-2.browser.mjs)、[held-frames-2.config.mjs](held-frames-2.config.mjs) | 冻结帧探针（八环境） |
| [prior-select-keys.config.mjs](prior-select-keys.config.mjs)、[prior-menu-held-frames.config.mjs](prior-menu-held-frames.config.mjs) | 前两个任务的探针，原文件不改，只换结果目录 |
| [run-chunks.py](run-chunks.py)、[slim.py](slim.py) | 分块运行、原件留在 `/var/tmp`、这里放瘦身副本和运行记录 |
| [prod-runs.sh](prod-runs.sh)、[final-queue.sh](final-queue.sh) | 生产构建上的回归检查；终版树上的排队（一次一个，可续跑，每步要 6 GB 空闲） |
| [record-check.py](record-check.py) | 把一个 `mcp__orbit__bg_run` 作业的原始输出和退出码记成 `checks/<名字>.json/.txt` |
| [summarize.py](summarize.py)、[render-tables.py](render-tables.py) | 判定与 [keyboard-window-summary.json](keyboard-window-summary.json)；逐组合表 [combinations.md](combinations.md) |
| [summarize-pilot.py](summarize-pilot.py) | 试点对比分类，写 [pilot-summary.json](pilot-summary.json) |
| [antd-audit.sh](antd-audit.sh)、[antd-audit-compare.py](antd-audit-compare.py) | 清单复扫与对照 [antd-audit.json](antd-audit.json) |
| [build-inventory-record.py](build-inventory-record.py)、[inventory-check.sh](inventory-check.sh) | 生成并核对 `inventory-delta/2026-10-07d.json` |
| [index-artifacts.py](index-artifacts.py) | 本目录每个文件的 SHA-256 清单 [artifact-index.json](artifact-index.json)，`--verify <提交>` 从 Git 对象复核 |

数据目录（每个都有 `report.summary.json`、`environment.json`，探针还有 `samples.csv`；对应的 `checks/<名字>.json/.txt` 是命令、提交、Web 树、时间、负载、退出码和原始输出）：

| 目录 | 内容 |
| --- | --- |
| `dev-check/` | 探针开发时的自检。它早于 `inPopup` 字段，判定不用它 |
| `baseline-menu-{a,b,c}/`、`baseline-sub-{a,b,c,d}/`、`baseline-select-{a,b,c}/`、`baseline-pop/`、`baseline-dlg/` | 基线，8680 个样本（`0594f6d2c`、`4d54fbe5f`、`9975b1f55` 上，组件都未改）。记录里的 dirty 项是当时一个未跟踪的临时目录 `src/web/src/components/kw2scratch/`：jsdom 试验，没有任何页面引用，修复前已删 |
| `after-menu/`、`after-select-{a,b,c}/`、`after-dlg/`、`after-pop/` | `069601b67` 上的修复后对照（3200 个样本） |
| `after-sub-a/` | `069601b67` 上子菜单第一块，留作第一版焦点问题的记录 |
| `after2-sub-{a,b,c}-{field,sample,session}/` | 终版 `aed0a7bab` 上的子菜单（1800 个样本） |
| `fix-held-frames-{before,before-home-end,after,after2}/` | 冻结帧：修复前、修复前补 Home/End、第一版、终版 |
| `prior-select-keys-{before,after}/`、`prior-menu-held-frames-{before,after,after2}/` | 前两个任务的探针 |
| `choices-entry-{before,after,final}/`、`entry-repeat-{final,prefix}/`、`overlays-{before,after,final}/`、`choices-full-<项目>-final/`、`pilot-{before,final}-{1,2}/`、`p0-{before,final}/` | 生产构建上的回归检查 |
| `pilot-{compare,compare-again,noise-before,noise-after}.json` | `../p3.2/compare_runs.py` 的输出 |
| `checks/` | 每次运行的记录与原始输出（单测、清单、合并检查也在这里） |

原件：
- `/var/tmp/kw2-246921c8/runs/<名字>` 里是完整的 `report.json`（含附件正文）和失败时的 trace；`/var/tmp/kw2-246921c8/pilot/<标签>-<n>-shots` 里是试点截图。
- 按协调者要求，这些原件留到证据判定之后；`report.summary.json` 里记了每个附件正文的 SHA-256，可以对照。
- 本目录没有提交 trace.zip、带附件正文的 report.json 或截图。

【待补：大小与清点】
