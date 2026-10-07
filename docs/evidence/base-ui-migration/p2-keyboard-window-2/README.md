# P2 跟进（第 2 批窗口）：子菜单、Popconfirm、Dialog 与触发器内其余按键，与 AntD 对照

（草稿：数字待正式基线与修复后运行完成后填写。）

本目录服务于 [P2 跟进（第 2 批窗口）](orbit-task:34blUhb6Wip3e5nyziKfq)。验收条目 key `1BvO6hYrlFnU60JqxQPUHt`，原文：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。**

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
  - ⏎/Space 再按一次页面上的打开按钮；
  - Tab/Shift+Tab 沿页面移动，随后的 ⏎ 会激活页面上的别的按钮；
  - 下一帧初始焦点再把焦点拉回弹层。

## 方法（草稿）

四种探针，前两种沿用前两个任务（`p2-select-keys`、`p2-keyboard-window`），原文件都不改：

- **burst / paced**（[keyboard-window-2.browser.mjs](keyboard-window-2.browser.mjs)，配置 [keyboard-window-2.config.mjs](keyboard-window-2.config.mjs)，只在 Chromium `chromium-dark-desktop` 上跑，因为依赖 CDP 输入队列）：
  - burst：一个 CDP 会话依次发出与 Playwright 1.63 Chromium 键盘相同的可信按键，中间不等待。Shift+Tab 依次是 Shift 按下、带 Shift 修饰的 Tab 按下和抬起、Shift 抬起。打开键之后的键排在输入队列里，在焦点移进弹层之前到达，相当于主线程繁忙时排队的输入。
  - paced：同一组键用 `page.keyboard.press`，间隔 300ms，作为「焦点已在弹层里」的参照。
  - 每个样本都是新页面。观察器记录每个键的事件目标、`isTrusted`、当时的焦点、已显示的弹层和高亮项。结果统一写成「结果 \| 显示中的弹层 \| @焦点」：
    - 结果是执行了什么、选了什么、回答了什么，或者 `none`；
    - 字段页、会话菜单和确认框样例读页面上的 `output`；
    - 没有 output 的样例由 DOM 推断：最后一个 ⏎/Space 落在弹层内的菜单项或按钮上，之后显示的弹层变少，就记为执行了它。
- **冻结帧**（[held-frames-2.browser.mjs](held-frames-2.browser.mjs)，不依赖 CDP，八个环境都跑）：
  - 按键期间把页面的 `requestAnimationFrame` 换成只排队不执行的版本，用普通 `page.keyboard.press` 连按；最后一个键之后才把帧交还浏览器。
  - 菜单与选择的用例先断言窗口确实出现：打开键之后的那个键落在触发器上，且弹层已显示。
  - 然后断言结果等于 paced 参照。
- **jsdom 确定性单测**（[`src/web/src/components/ui/keyboardWindow.test.tsx`](../../../../src/web/src/components/ui/keyboardWindow.test.tsx)，属于 `npm run test -w @orbit/web`）：
  - 截住所有动画帧，每个序列跑两遍：每键之后执行帧（参照）和一帧都不执行（窗口），要求两者结果相同。
  - jsdom 没有默认动作，测试按浏览器规则补上：⏎ 激活拥有焦点的 button，Space 在 keyup 时激活接到 keydown 的 button，Tab/Shift+Tab 沿文档的可聚焦顺序移动焦点（越界回绕，与探针所用浏览器一致）。三者都在 keydown 未被阻止时才执行。
- **前两个任务的探针**（原文件不改，用 [prior-select-keys.config.mjs](prior-select-keys.config.mjs)、[prior-menu-held-frames.config.mjs](prior-menu-held-frames.config.mjs) 只换结果目录）：Select 与顶层 Menu 已修好的 ↓/↑/⏎，修复前后各跑一次。

目标（choices fixture 与 overlays fixture；本任务只给 choices fixture 的外观样例新增两种 `sample`，见「改动」）：

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

判定沿用前两个任务（[summarize.py](summarize.py)）：
- 每个「目标 × 序列」以 paced 多数结果为参照，burst 与之不同即为错。
- 逐序列先判旧 AntD：
  1. 是否赋予被测键功能：paced 结果是否不同于去掉被测键的对照序列。菜单与子菜单沿用前一任务的规则，看 paced 是否执行了某一项；Popconfirm 看是否作出确认或取消。旧组件靠再按一次触发器把弹层关上，不算功能。
  2. burst 是否保持 paced 结果，比较整个结果，含焦点。
- 两条都成立而 Orbit 的 burst 与自己的 paced 不同时，才修。
- 协调者另有两项判定（2026-10-07）：
  - 子菜单窗口执行父菜单项属于回归，按方案 B 修；
  - 顶层 Menu 窗口内的 Tab/Shift+Tab 按 10-07 的约定修。

## 协调者的判定（2026-10-07）

本任务向协调者提了两次判定请求，都写在本说明里：

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
