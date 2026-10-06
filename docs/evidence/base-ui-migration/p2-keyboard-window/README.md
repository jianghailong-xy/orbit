# P2 跟进：Menu 与 Select 打开窗口内的其余按键，与 AntD 对照

本目录服务于 [P2 跟进：Menu 与 Select 打开窗口内的其余按键，与 AntD 对照](orbit-task:34b7qz5n4yA7s4fJmHNDn)，处理 [P2 修复：Select 快速连按 ↓↓⏎ 时重选当前值](orbit-task:34b4miWykA9R4izIml42v) 的证据 [p2-select-keys](../p2-select-keys/README.md) 留下的两处未对照项：Orbit Menu 的同类窗口，以及 Orbit Select 窗口内其余按键。验收条目 key `1BvO6hYrlFnU60JqxQPUHt`，原文：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。**

本任务先后由两个 Claude Opus 5.5 执行会话完成。前一会话（5Tb4gkgTYHzNfhUUzo4qiH）写了探针、采完基线，并在基线树上跑了大部分回归，两次撞上 Claude 会话额度后停止。本会话（6ne1g27Q1KbMWHyE8f3gHk）按协调者交接，把它的分支和未提交原件接到本分支（见下表），补采 ↑ 作为打开键的三个菜单序列，并在交付树上重跑全部回归和合并检查。

**结论：没有任何组合属于「旧 AntD 正确而 Orbit 不正确」，所以没有改产品代码。** 旧 AntD Dropdown 不从触发器处理 ↓/↑/Enter 导航，任何这类序列都不会执行菜单项；旧 AntD Select 不给 Home/End、Space、PageUp/PageDown、字符检索任何功能。旧 AntD 处理的序列（Space 或 Enter 打开后 ↓⏎），Orbit 在窗口内也已正确，靠的是前一任务的修复。`Menu.tsx`、`Select.tsx` 及 `components/ui` 其余文件、fixture、原用例与断言、超时、重试和历史基线都没有改，也没有推送 main 或项目分支；相对项目分支 tip，本分支只新增了本目录。

## 基线与提交

两棵 Web 树：**基线树**是前一会话领取时的项目分支 tip，大部分基线和第一轮回归在它上面采；**交付树**是本分支（项目分支 tip `da13423d3` 合入前一会话分支），↑ 打开序列和第二轮回归在它上面跑。

| 角色 | 提交 | Web 树 |
| --- | --- | --- |
| 前一会话分支起点（领取时的项目分支 tip） | `f7a91822ee26d32ba6fe6ef66a12555bd491d213` | 基线树 `1780d071a6b402eef7d34ea74185684d73db3a85` |
| 探针与开发自检 | `eebe46a2b98976af45835a497d1aed4e95adcfb9` | 基线树 |
| 菜单基线与早期检查 | `7ad82e10aa625ab8b26fccea79aba4fc685048f3` | 基线树 |
| 选择基线 a–d；e 与重跑 | `7676745ffbd214b72e91c62e36cc399a1799078b`；`89256103213431815c02a5e5d4dc8456ef5015c6` | 基线树 |
| 基线树上的回归 | `fb8ea5e9eb6efe9b8744a25d071ed5a775ca312c`、`923c8d856c2637fe63a10da9a4f79813894e7a39`、`a93ecfb2e0f268d9e8ed1c31c4e497273aa1349f`（前一分支 tip）；overlays 运行在 `a93ecfb2e` 上，前一会话来不及提交 | 基线树 |
| 本分支起点（项目分支 tip，含 P3.1） | `da13423d3e80e00a487ed91327c31d6788cc7a7a` | 交付树 `7709bb72da4dd0ddb22b6563a62715821318a913` |
| 普通合并前一会话分支 `orbit/p2-menu-select-antd-fde1e4`（无冲突，只带入本目录） | `baf801def920acfa72f3bd45e7a66293df6c1b8e` | 交付树 |
| 接收前一会话的 262 个未提交原件（overlays 运行与 README 草稿；与协调者备份 `p2-kbwindow-wip-20261006T2133Z/untracked.tgz` 逐字节相同） | `92138644d00090a5503986c4cbf0fe6379b58f1f` | 交付树 |
| 探针加入 ↑ 打开序列 | `25309143fa5b571bb85c0f634cb04f339c9c3ccd` | 交付树 |
| ↑ 打开基线、交付树回归与本说明 | 其后的提交 | 交付树 |

- **前置修复已在本分支。** 本分支不含 `632b7950e` 这个对象，含项目分支落地时变基后的 `31aa07c913fc3833935d6f17ecb1064a790b8503`：两者 `git patch-id --stable` 都是 `4571f3f797eb63fade1c9cf6c1793212526e8622`，`Select.tsx` 逐字节相同；证据提交 `404dcc4e4` 与本分支的 `f7a91822e` 同为 `4c7becb124a588a08e2bf6b9c14767d116e0a135`。因此没有再合入 `orbit/p2-select-f0b881`。
- **基线树与前一任务不同。** 相对 `632b7950e` 的 Web 树 `35301ab31d4c…`，基线树多了项目分支吸收 main（`c500817e2`）带来的 27 个 Web 文件变化，没有一个在 `components/ui` 或 `ui-migration` 下，`src/web/package.json` 与锁文件不变，`index.css` 多 18 行。p2-select-keys 的回归结果因此不能直接沿用。
- **交付树与基线树的差别只有 P3.1（Textarea）。** 交付树多了 20 个 Web 文件变化：`Textarea.tsx`、`TextControls.css`、`index.css` 中 `.composer-field`/`.tdp-compose` 的 textarea 规则、composer fixture 与入口、`controls.browser.mjs`、`playwright.config.mjs` 的 testIgnore、`package.json` 的 `test:ui-composer` 脚本、`.gitignore`、`components/ui/README.md`，以及 `WorkspaceView.composerMenu.test.tsx`。`Menu.tsx`、`Select.tsx`、`Floating`、Combobox/MultiSelect、choices fixture、choices 用例与配置、`WorkspaceView.tsx`、根 `package.json` 与锁文件都没有变（`git diff --name-only` 核对）。choices 页经 Orbit `Input` 加载 `TextControls.css`：P3.1 把文本框的焦点规则改为 `:is(:focus, :focus-within):not([data-disabled])`，并把无前后缀文本框 16px 的断点从 600px 改为 960px。只有 `Input`/`Textarea` 带这个类，选择控件用自己的 `.orbit-choice`；探针也不操作文本框，两个视口（390/1280px）下改前改后的字号相同。所以基线树上的基线适用于交付树；已验收行为的回归则在交付树上全部重跑。
- **依赖与环境。** 两个会话都用 `bash scripts/worktree-overlay.sh` 准备依赖：它判定主工作区安装与本树锁文件不兼容，按锁文件独立执行 `npm ci`（两棵树的锁文件相同）。每次浏览器运行的 globalSetup 都把实际环境与 P0.2 [environment.json](../p0.2/environment.json) 逐字段比较并通过（Chromium 1243 / WebKit 2359、Playwright 1.63.0、字体文件哈希、DPR 1、UTC/en-US），各运行目录保留当次 `environment.json`。全部浏览器运行单 worker、retries=0。运行期间主机负载约 10–40（24 核），其他会话的进程同时在跑。

## 方法

[keyboard-window.browser.mjs](keyboard-window.browser.mjs)（配置 [keyboard-window.config.mjs](keyboard-window.config.mjs)）在 [p2-select-keys 的 burst 探针](../p2-select-keys/select-keys-burst.browser.mjs) 上扩展，旧文件未改，方法相同：

- **burst**：一个 CDP 会话依次发出与 Playwright 1.63 Chromium 键盘相同的可信按键（无文字的键为 rawKeyDown，有文字的为带 text 的 keyDown，然后 keyUp；键值按 playwright-core 的 US 布局核对），中间不等待。第一个键打开列表后，后续按键在输入队列中排队，于焦点移入列表的那一帧之前到达，相当于主线程繁忙时排队的输入。
- **paced**：同一组键用 `page.keyboard.press` 间隔 300ms，作为焦点已在列表中的参照。
- 观察器沿用前一探针（事件目标、`isTrusted`、列表是否显示、高亮项），另记录每个键当时的焦点元素。每个「目标 × 序列」burst 20 个、paced 20 个样本，每个样本都是新页面。

| 目标 | 页面（choices fixture，未改） | 结果 |
| --- | --- | --- |
| `antd-sample` / `orbit-sample` | `?system=antd\|orbit&sample=expiry`，外观对照用的同一对旧 AntD Select / Orbit Select 样例 | 样例显示的值，以及列表是否仍打开 |
| `orbit-field` | 字段页的 Expires（Orbit Select） | Expiry value 输出，以及列表是否仍打开 |
| `antd-menu` / `orbit-menu-sample` | `?system=antd\|orbit&sample=attachment`，同一对旧 AntD Dropdown / Orbit Menu（attachment 变体）样例 | 由 DOM 得出的菜单结果 |
| `orbit-menu` | 字段页的「Add attachment」Orbit Menu（带 onSelect） | 同上，另读 Action 输出 |

菜单结果：结束时菜单仍显示为 `open`；最后一个 Enter 落在菜单项上且菜单已关闭为 `ran <项>`（该项被执行）；其余为 `closed`。字段页全部 440 个样本中，这一推断与 Action 输出一一对应（`ran File`⇔`file`、`ran Image`⇔`image`、`ran Shell`⇔`shell`、`ran /Command`⇔`command`，`open`/`closed`⇔`none`），所以没有 Action 的样例页也用它。

序列都对旧 AntD 和 Orbit 同条件采样。菜单：`⏎`（对照）、`↓↓⏎`、`↓↑⏎`、`↓⏎`、`⏎↓⏎`、`⏎↑⏎`、`⏎⏎`，以及本会话补采的 ↑ 打开 `↑⏎`、`↑↑⏎`、`↑↓⏎`（Base UI Menu 也用 ↑ 打开，前一会话的序列只把 ↑ 放在第二个键）；另加旧 Dropdown 自己进入菜单的路径 `⏎ Tab ↓ ⏎` 作参照（Tab 不在本任务按键内）。选择：被测键都紧跟在打开列表的 ↓ 之后，即窗口内的第一个键；每个序列配一个去掉被测键的对照序列（`↓`、`↓⏎`、从 7 days 起的 `↓⏎`）。起点 Never 是样例自身的值；7 days 先用 paced 键选好；null 用字段自己的 Clear 按钮，只有 Orbit 字段有。

判定（[summarize-keyboard-window.py](summarize-keyboard-window.py) 生成 [keyboard-window-summary.json](keyboard-window-summary.json)）：每个「目标 × 序列」以 paced 多数结果为参照，burst 与之不同即为错。逐序列先判旧 AntD：

1. 旧 AntD 是否赋予被测键功能：选择看 paced 结果是否不同于对照序列；菜单看 paced 是否执行了某一项。
2. 旧 AntD 在 burst 下是否保持 paced 结果。

只有 1、2 都成立而 Orbit burst 与自己的 paced 不同时才修。「窗口」列是 burst 中后续按键在列表已显示时仍落在第一个键目标（触发器）上的样本数，用来确认窗口确实被覆盖；旧 AntD 的焦点本来就留在触发器或输入框上，对它这是常态，不是窗口。「交接」列是日志中出现由页面重新派发（`isTrusted=false`）按键的样本数，即前一任务的 Select 修复把键交给列表的次数。

## 旧 AntD 基线

### Dropdown（旧附件菜单）

- `antd/es/dropdown`、`@rc-component/trigger` 对触发器没有任何按键处理（源码中没有 keydown 或 KeyCode）。Enter/Space 只是原生 button 的 click，`trigger={['click']}` 时切换开合（`antd/es/dropdown/dropdown.js:131-137`）。生产的 composer 附件菜单与样例相同：`trigger={['click']}`，没有 autoFocus 或按键处理（`WorkspaceView.tsx:10266`）。
- `@rc-component/dropdown` 只在打开时于 window 上监听 Esc 和 Tab：Esc 关闭并聚焦触发器，Tab 把焦点移入菜单（`es/hooks/useAccessibility.js:30-54`）。
- 菜单内，rc-menu 的方向键先设活动项，**下一动画帧**才移动 DOM 焦点（`@rc-component/menu/es/hooks/useAccessibility.js:197-217`）；Enter 由当前拥有焦点的项执行（`MenuItem.js:135-143`），AntD 随后关闭下拉（`dropdown.js:149-157`）。

所以旧 Dropdown 在触发器上：↓/↑ 既不打开也不移动，⏎ 只打开或关闭，任何 ↓/↑/⏎ 序列都不执行菜单项，burst 与 paced 结果相同。它进入菜单的方式是 Tab。在这条路上（`⏎ Tab ↓ ⏎`），paced 20/20 执行 Image，burst 20/20 执行 File：Tab 同步把焦点给 File，↓ 设好 Image 但焦点要下一帧才移过去，排队的 ⏎ 先到，执行了仍有焦点的 File。也就是说，旧 Dropdown 自己也不处理焦点移动窗口内的按键。

### Select（旧选择框）

- rc-select 的焦点始终在自己的输入框上，高亮用 `aria-activedescendant` 表示。打开的列表只处理 ↑/↓（Mac 另有 Ctrl+N/P）、Enter、Tab、Esc（`@rc-component/select/es/OptionList.js:166-225`）。
- Space 只在关闭时打开列表，打开后不交给列表（`BaseSelect/index.js:238-281`）。
- Home/End、PageUp/PageDown 和字符键只在关闭时打开列表（`utils/keyUtil.js` 的 `isValidateOpenKey`，`SelectInput/index.js:85-86`）；这个样例不可搜索，打开后这些键没有功能。

所以旧 Select 的 burst 结果全部等于 paced。被测键在打开的列表里都没有功能：结果与对照序列相同，Space 后列表保持打开。被测键作为打开键（`Space ↓ ⏎`、`⏎ ↓ ⏎`）时，后面的 ↓⏎ 照常生效。

## 逐组合结论

数据集为 `baseline-menu`、`baseline-select-a`…`-e`、`baseline-rerun`（基线树）与 `baseline-menu-up`、`baseline-menu-up-rerun`（交付树）的合集，70 个「目标 × 序列」各有 20 个 burst 和 20 个 paced 样本（共 1400 + 1400）。每格依次为：paced 参照结果及其次数/paced 样本数；burst 中与参照不同的样本数/burst 样本数（括号内为不同的结果和次数）；窗口命中数；交接数。Select 结果写作「值，列表开/关」，字段的值为原始值（`never`/`7`），样例为标签。

### 菜单（↓/↑/Enter）

| 序列 | 起点 | 旧 AntD Dropdown 样例 | Orbit 字段页菜单 | Orbit Menu 样例 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `menu-down-down-enter`（↓ ↓ ⏎） | — | open 20/20；burst 错 **0/20**，窗口 0，交接 0 | ran Image 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | ran Image 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | 旧 AntD 不处理：记录，不改 |
| `menu-down-enter`（↓ ⏎） | — | open 20/20；burst 错 **0/20**，窗口 0，交接 0 | ran File 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | ran File 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | 旧 AntD 不处理：记录，不改 |
| `menu-down-up-enter`（↓ ↑ ⏎） | — | open 20/20；burst 错 **0/20**，窗口 0，交接 0 | ran /Command 20/20；burst 错 **0/20**，窗口 20，交接 0 | ran /Command 20/20；burst 错 **0/20**，窗口 20，交接 0 | 旧 AntD 不处理：记录，不改 |
| `menu-enter`（⏎） | — | open 20/20；burst 错 **0/20**，窗口 0，交接 0 | open 20/20；burst 错 **0/20**，窗口 0，交接 0 | open 20/20；burst 错 **0/20**，窗口 0，交接 0 | 对照 |
| `menu-enter-down-enter`（⏎ ↓ ⏎） | — | closed 20/20；burst 错 **0/20**，窗口 20，交接 0 | ran Image 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | ran Image 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | 旧 AntD 不处理：记录，不改 |
| `menu-enter-enter`（⏎ ⏎） | — | closed 20/20；burst 错 **0/20**，窗口 20，交接 0 | ran File 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | ran File 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | 旧 AntD 不处理：记录，不改 |
| `menu-enter-tab-down-enter`（⏎ Tab ↓ ⏎） | — | ran Image 20/20；burst 错 **20/20**（ran File×20），窗口 20，交接 0 | closed 20/20；burst 错 **20/20**（ran Image×20），窗口 20，交接 0 | closed 20/20；burst 错 **20/20**（ran Image×20），窗口 20，交接 0 | 参照（Tab 不在本任务按键内） |
| `menu-enter-up-enter`（⏎ ↑ ⏎） | — | closed 20/20；burst 错 **0/20**，窗口 20，交接 0 | ran /Command 20/20；burst 错 **0/20**，窗口 20，交接 0 | ran /Command 20/20；burst 错 **0/20**，窗口 20，交接 0 | 旧 AntD 不处理：记录，不改 |
| `menu-up-down-enter`（↑ ↓ ⏎） | — | open 20/20；burst 错 **0/20**，窗口 0，交接 0 | ran File 20/20；burst 错 **0/20**，窗口 20，交接 0 | ran File 20/20；burst 错 **0/20**，窗口 20，交接 0 | 旧 AntD 不处理：记录，不改 |
| `menu-up-enter`（↑ ⏎） | — | open 20/20；burst 错 **0/20**，窗口 0，交接 0 | ran /Command 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | ran /Command 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | 旧 AntD 不处理：记录，不改 |
| `menu-up-up-enter`（↑ ↑ ⏎） | — | open 20/20；burst 错 **0/20**，窗口 0，交接 0 | ran Shell 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | ran Shell 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | 旧 AntD 不处理：记录，不改 |

### 选择（窗口内的其余按键）

| 序列 | 起点 | 旧 AntD Select 样例 | Orbit 字段 Expires | Orbit Select 样例 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `select-down`（↓） | Never | Never，列表开 20/20；burst 错 **0/20**，窗口 0，交接 0 | never，列表开 20/20；burst 错 **0/20**，窗口 0，交接 0 | Never，列表开 20/20；burst 错 **0/20**，窗口 0，交接 0 | 对照 |
| `select-down-7-enter`（↓ 7 ⏎） | Never | Never，列表关 20/20；burst 错 **0/20**，窗口 20，交接 0 | 7，列表关 20/20；burst 错 **0/20**，窗口 20，交接 20 | 7 days，列表关 20/20；burst 错 **0/20**，窗口 20，交接 20 | 旧 AntD 不处理：记录，不改 |
| `select-down-end-enter`（↓ End ⏎） | Never | Never，列表关 20/20；burst 错 **0/20**，窗口 20，交接 0 | never，列表开 20/20；burst 错 **20/20**（never，列表关×20），窗口 20，交接 20 | Never，列表开 20/20；burst 错 **20/20**（Never，列表关×20），窗口 20，交接 20 | 旧 AntD 不处理：记录，不改 |
| `select-down-enter`（↓ ⏎） | Never | Never，列表关 20/20；burst 错 **0/20**，窗口 20，交接 0 | never，列表关 20/20；burst 错 **0/20**，窗口 20，交接 20 | Never，列表关 20/20；burst 错 **0/20**，窗口 20，交接 20 | 对照 |
| `select-down-enter-from-7`（↓ ⏎） | 7 days | 7 days，列表关 20/20；burst 错 **0/20**，窗口 20，交接 0 | 7，列表关 20/20；burst 错 **0/20**，窗口 20，交接 20 | 7 days，列表关 20/20；burst 错 **0/20**，窗口 20，交接 20 | 对照 |
| `select-down-home-enter`（↓ Home ⏎） | 7 days | 7 days，列表关 20/20；burst 错 **0/20**，窗口 20，交接 0 | never，列表关 20/20；burst 错 **20/20**（7，列表关×20），窗口 20，交接 20 | Never，列表关 20/20；burst 错 **20/20**（7 days，列表关×20），窗口 20，交接 20 | 旧 AntD 不处理：记录，不改 |
| `select-down-n-enter`（↓ n ⏎） | 7 days | 7 days，列表关 20/20；burst 错 **0/20**，窗口 20，交接 0 | never，列表关 20/20；burst 错 **0/20**，窗口 20，交接 20 | Never，列表关 20/20；burst 错 **0/20**，窗口 20，交接 20 | 旧 AntD 不处理：记录，不改 |
| `select-down-pagedown-enter`（↓ PgDn ⏎） | Never | Never，列表关 20/20；burst 错 **0/20**，窗口 20，交接 0 | never，列表关 20/20；burst 错 **0/20**，窗口 20，交接 20 | Never，列表关 20/20；burst 错 **0/20**，窗口 20，交接 20 | 旧 AntD 不处理：记录，不改 |
| `select-down-pageup-enter`（↓ PgUp ⏎） | 7 days | 7 days，列表关 19/20（paced 另有 7 days，列表开×1）；burst 错 **0/20**，窗口 20，交接 0 | 7，列表关 20/20；burst 错 **0/20**，窗口 20，交接 20 | 7 days，列表关 20/20；burst 错 **0/20**，窗口 20，交接 20 | 旧 AntD 不处理：记录，不改 |
| `select-down-space`（↓ Space） | Never | Never，列表开 20/20；burst 错 **0/20**，窗口 20，交接 0 | never，列表关 20/20；burst 错 **0/20**，窗口 20，交接 0 | Never，列表关 20/20；burst 错 **0/20**，窗口 20，交接 0 | 旧 AntD 不处理：记录，不改 |
| `select-down-space-from-null`（↓ Space） | null | 无对应样本（旧样例不能清空），按 `select-down-space` 判定 | never，列表关 20/20；burst 错 **20/20**（null，列表关×20），窗口 20，交接 0 | — | 旧 AntD 不处理：记录，不改 |
| `select-enter-down-enter`（⏎ ↓ ⏎） | Never | 7 days，列表关 20/20；burst 错 **0/20**，窗口 20，交接 0 | 7，列表关 20/20；burst 错 **0/20**，窗口 20，交接 20 | 7 days，列表关 20/20；burst 错 **0/20**，窗口 20，交接 20 | 两者都正确：不改 |
| `select-space-down-enter`（Space ↓ ⏎） | Never | 7 days，列表关 20/20；burst 错 **0/20**，窗口 20，交接 0 | 7，列表关 20/20；burst 错 **0/20**，窗口 20，交接 20 | 7 days，列表关 20/20；burst 错 **0/20**，窗口 20，交接 20 | 两者都正确：不改 |

两处需要单独说明：

- 旧 AntD `↓ PgUp ⏎` 的 paced 有 1/20（样本 17）结束时列表仍打开，值仍为 7 days。这个样本的 PageUp 在 ↓ 之后 870ms 才被处理（脚本间隔 300ms，主机当时负载很高），Enter 落在打开的列表上却没有关闭它。rc-select 的关闭经一个 MessageChannel 宏任务延后执行，期间的任何开合调用都会取消它（`@rc-component/select/es/hooks/useOpen.js:53-79`），但没有查明这次是哪个调用。20 个样本的值都等于对照，判定不受影响。
- `select-down-space-from-null` 只有 Orbit 字段能从 null 开始（旧样例没有清除按钮），所以按旧 Select 自己的 `↓ Space` 判定：旧 Select 打开后 Space 没有功能。

## Orbit 在窗口内的行为从何而来（只说明，未改）

Base UI 1.8.0 的 Menu 与 Select 都是非 virtual 列表导航：键盘打开后焦点在下一动画帧才进入列表（`floating-ui-react/components/FloatingFocusManager.mjs:362,391`，`floating-ui-react/hooks/useListNavigation.mjs:136`）。这一帧里按键仍落在触发器上：

- **Menu 的 ↓**：触发器把主方向键交给 `commonOnKeyDown`（`useListNavigation.mjs:556-566`），此时焦点在触发器，命中「Reset the index if no item is focused」（`:360-367`）：↓ 回到第一项 File，与已有高亮相同，索引不变，焦点也不移动。**Menu 的 ⏎**：原生 button 产生 click，触发器的 `useClick` 设为 `toggle: true`（`menu/trigger/MenuTrigger.mjs:155-160`，`useClick.mjs:102-117`），菜单关闭，什么也不执行。窗口内的 Orbit Menu 因此与旧 Dropdown 一样：触发器上的 ⏎ 关闭菜单，不执行菜单项。
- **Menu 的 ↑**（`↓↑⏎`、`⏎↑⏎`）：同一重置把 ↑ 送到最后一项 /Command，索引改变；`commonOnKeyDown` 置 `forceSyncFocusRef`（`useListNavigation.mjs:300`），焦点同步移到 /Command，随后的 ⏎ 落在它上面。Menu 默认 `loopFocus`（`menu/root/MenuRoot.mjs:42`），paced 从 File 按 ↑ 也回绕到 /Command，所以两种节奏结果巧合地相同。
- **Menu 的 ↑ 作为打开键**（`↑⏎`、`↑↑⏎`、`↑↓⏎`，本会话补采）：触发器上的 ↑ 与 ↓ 一样打开菜单（`menu/root/MenuRoot.mjs:374` 的 `openOnArrowKeyDown`），按打开键高亮最后一项 /Command（`useListNavigation.mjs:238`）。窗口内的 ⏎ 仍是原生 click，按切换关闭菜单，什么也不执行；第二个 ↑ 命中同一重置分支，被送到最后一项 /Command，与已有高亮相同，索引不变，焦点不动，随后的 ⏎ 关闭菜单；↓ 被重置到第一项 File，索引改变，焦点同步移到 File，⏎ 执行 File。paced 下 ↑ 从 /Command 跳过禁用的 Skill 到 Shell（Orbit 的禁用项不注册为可选项，见 `Menu.tsx` 的注释），↓ 从 /Command 回绕到 File，所以 `↑↓⏎` 两种节奏结果巧合地相同。旧 Dropdown 的触发器对 ↑ 没有任何处理，三个序列都只是 ⏎ 打开了菜单。
- **Select 的 Home/End**：只有 `commonOnKeyDown` 处理（`useListNavigation.mjs:336-345`），触发器只把主方向键交给它（`:529,556`），窗口内的 Home/End 没有作用。随后的 ⏎ 由前一任务的修复交给仍高亮的当前值，结果与旧 Select 相同（值不变）。paced 下 Home 到 Never；End 到最后一项 30 days，它是禁用项（Select 传 `disabledIndices: EMPTY_ARRAY`，`select/root/SelectRoot.mjs:292`），⏎ 不能选它，列表保持打开。
- **Select 的 PageUp/PageDown**：Base UI 1.8.0 的 floating-ui、select、menu 中都没有处理，两种节奏下都只有浏览器默认动作，与旧 Select 相同。
- **Select 的 Space**：窗口内落在触发器上。typeahead 不为 Space 阻止事件，只把它记入检索字符串，匹配不到也不重置（`useTypeahead.mjs:67-71,84,107,123`）；列表导航只记下它，不处理（`useListNavigation.mjs:530`）；原生 button 在 keyup 时产生 click，`useClick` 按切换关闭列表（`select/root/SelectRoot.mjs:282-285`，`useClick.mjs:102-117`），不选择。paced 下 Space 由高亮项执行并选中它。从样例自身的值开始，两者结果都是原值、列表关闭；从 null 开始，paced 选中 Never，burst 保持 null。旧 Select 打开后 Space 没有功能，列表保持打开。
- **Select 的字符检索**：typeahead 的同一个处理器同时挂在触发器和弹层上（`useTypeahead.mjs:160-161`），打开时匹配只移动高亮（`SelectRoot.mjs:315-318`）。窗口内的字符照样移动高亮，随后的 ⏎ 被前一修复交给新高亮项，所以 burst 与 paced 相同。
- **Space/Enter 打开**（`Space ↓ ⏎`、`⏎ ↓ ⏎`）：窗口内的 ↓/⏎ 由前一任务的修复交给列表，与旧 Select 和 paced 都相同。

## 范围外观察（均未改）

1. **Tab 的语义不同，与窗口无关。** 旧 Dropdown 用 Tab 进入打开的菜单；Orbit Menu 用 Enter/↓ 打开时已把焦点移入菜单，此时 Tab 离开菜单并关闭它：paced 下焦点移到触发器之后的下一个可聚焦元素（字段页为 Open context，随后的 ⏎ 打开了它的 Popover；样例页触发器之后没有可聚焦元素，回到页首的 Switch theme），40/40。所以 `⏎ Tab ↓ ⏎` 在 paced 下旧 Dropdown 执行 Image，Orbit 不执行任何菜单项。burst 下，Tab 在窗口内落在触发器上，随后的 ↓ 已落在菜单项 File 上（40/40），Orbit 反而执行 Image；本次没有追查这一焦点移动来自哪段代码。这是 P2.2 起就存在的键盘模型差异，Tab 不在本任务按键内，P2.2 证据也没有对照过；是否需要处理，由协调者决定。
2. **Orbit Select 的 End 停在禁用的最后一项**，⏎ 不选择、列表保持打开（见上）。旧 Select 没有 End 功能，这是 Base UI 自身语义，本任务不改。

## 其他已验收行为（无产品改动）

本任务没有改任何产品代码、CSS、DOM 属性、fixture 或用例，所以没有「修复后」可对照；下面是对已验收行为的重跑。前一会话在基线树上跑了第一轮；交付树多了 P3.1，本会话在交付树上把全部检查重跑了一轮，两轮的原件都保留。

### 交付树 `7709bb72da…`（本会话）

| 检查 | 结果 | 原件 |
| --- | --- | --- |
| 前一任务的 burst 探针 `p2-select-keys/select-keys-burst.browser.mjs`（文件未改） | **276/276**，与基线树上的结果逐项相同：Orbit Select 已修好的 ↓↓⏎、↓↑⏎、↓⏎（从 null）burst 全部正确，且全部交给列表（字段 3×20、样例 2×20）；旧 AntD、Combobox、MultiSelect 全对；Orbit Menu ↓↓⏎ 仍为 20/20 不执行 | [regression-select-keys-burst-delivered](regression-select-keys-burst-delivered/summary.json)，汇总见 [keyboard-window-summary.json](keyboard-window-summary.json) 的 `regression-select-keys-burst-delivered` |
| choices 原入口（Dialog/旧 Modal 内选择器、逐层 Esc、Tab、主题、IME 合成、外部点击、子菜单 Esc、键盘清除、正常/减少动效下 Dialog→Popover→Select 逐层退出），八环境 | **32/32**，与基线树相同 | [regression-choices-entry-delivered](regression-choices-entry-delivered/summary.json) |
| choices 测试清单 `--list` | 520 个测试 / 4 个文件，从「Listing tests:」起与基线树的 `checks/list-choices.txt` 和 `p2-select-keys/checks/list-choices.txt` 逐字节相同（sha256 `869171286b2f…`）：没有增删或改名 | [checks/list-choices-delivered.txt](checks/list-choices-delivered.txt) |
| 完整 choices 矩阵 `npm run test:ui-choices -w @orbit/web`，第一次 | 517/520，主机负载约 22–38（用时 30.6 分钟）。三个失败都在 `choices-motion.browser.mjs:104`，都是 90 秒超时。chromium-light-phone「normal top … search」页面没有挂载：trace 中 13 个模块请求以 `net::ERR_NETWORK_CHANGED` 中止，发生在点击之前。webkit-light-desktop「normal flipped … search」和 webkit-dark-phone「normal flipped … attachment」没有网络错误，卡在 Orbit 一侧的入场采样（`:70`，经 `:114`）：32 次观察里弹层都已显示、带入场动画名、opacity 1，`document.getAnimations()` 却一直为空，即 200ms 的入场在观察器第一次采样之前已经结束，等待「至少记录到一个 CSSAnimation」永远不成立。P2.2 第 2 版记录过同一现象（WebKit 手机自动翻转的搜索列表，只靠帧观察取不到入场动画），观察器因此另加了 animationstart 监听；这次在高负载下两者都没赶上。这三个用例在基线树的两次完整运行中都通过 | [regression-choices-full-delivered](regression-choices-full-delivered/summary.json)，[trace 归类](regression-choices-full-delivered-traces.json)；Orbit 一侧的观察记录在同目录的 `*--motion-diagnostic.json` |
| 上述三个失败用例，各自在原环境单独重复 10 次（用例、超时、重试未改） | webkit-light-desktop flipped search 10/10，webkit-dark-phone flipped attachment 10/10，chromium-light-phone top search 10/10 | [regression-repeat-motion-flipped-search](regression-repeat-motion-flipped-search/summary.json)、[regression-repeat-motion-flipped-attachment](regression-repeat-motion-flipped-attachment/summary.json)、[regression-repeat-motion-top-search](regression-repeat-motion-top-search/summary.json) |
| 完整 choices 矩阵，第二次 | FULL2_DELIVERED | [regression-choices-full-delivered-second](regression-choices-full-delivered-second/summary.json) |
| overlays 矩阵 `npm run test:ui-overlays -w @orbit/web`（Dialog/Drawer 外观、Tab 循环、Esc/外部关闭与焦点归还、嵌套层、新旧弹层双向共存、异步确认、主题继承、合成中 Esc、动效与滚动恢复），八环境 | OVERLAYS_DELIVERED | [regression-overlays-delivered](regression-overlays-delivered/summary.json) |
| choices / overlays / toasts / toasts-tests 四套 fixture 类型检查 | 通过（退出码 0，无输出） | [checks/fixture-types-delivered.json](checks/fixture-types-delivered.json) |
| 相关单测（`theme.test.tsx`、`boundary.test.ts`、`ShareModal.test.tsx`、`WorkspaceView.composerMenu.test.tsx`，即 P2.2 的单测集合；最后一个文件 P3.1 改过） | 4 个文件 / 22 个测试通过；boundary 确认 Base UI 仍只在 Orbit 组件内、公共组件不依赖 AntD | [checks/unit-tests-delivered.json](checks/unit-tests-delivered.json) |
| 项目合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web` | MERGE_DELIVERED | [checks/merge-check.json](checks/merge-check.json) |

### 基线树 `1780d071a6…`（前一会话）

前一会话在这棵树上没有跑第三次完整矩阵；它启动的合并检查见「原件与复核」。

| 检查 | 结果 | 原件 |
| --- | --- | --- |
| 前一任务的 burst 探针 `p2-select-keys/select-keys-burst.browser.mjs`（文件未改） | **276/276**。Orbit Select 已修好的 ↓↓⏎、↓↑⏎、↓⏎（从 null）burst 全部正确，且全部交给列表（字段 3×20、样例 2×20）；旧 AntD、Combobox、MultiSelect 全对；Orbit Menu ↓↓⏎ 仍为 20/20 不执行，与前一任务一致 | [regression-select-keys-burst](regression-select-keys-burst/summary.json)，汇总见 [keyboard-window-summary.json](keyboard-window-summary.json) 的 `regression-select-keys-burst` |
| choices 原入口（Dialog/旧 Modal 内选择器、逐层 Esc、Tab、主题、IME 合成、外部点击、子菜单 Esc、键盘清除、正常/减少动效下 Dialog→Popover→Select 逐层退出），八环境 | **32/32**，与前一任务相同 | [regression-choices-entry](regression-choices-entry/summary.json) |
| choices 测试清单 `--list` | 520 个测试 / 4 个文件，从「Listing tests:」起与 `p2-select-keys/checks/list-choices.txt` 逐字节相同（sha256 `869171286b2f…`）：没有增删或改名 | [checks/list-choices.txt](checks/list-choices.txt) |
| 完整 choices 矩阵 `npm run test:ui-choices -w @orbit/web`，第一次 | 519/520。唯一失败是 chromium-dark-phone 的「email tags support …」：beforeEach 中页面没有挂载，trace 显示 11 个模块请求以 `net::ERR_NETWORK_CHANGED` 中止，发生在用例主体之前 | [regression-choices-full-first](regression-choices-full-first/summary.json)，[trace 归类](regression-choices-full-first-traces.json) |
| 完整 choices 矩阵，第二次 | 519/520。唯一失败是 webkit-light-desktop 的「no-preference Dialog Popover Select exits restore one layer at a time」（`choices-lifecycle.browser.mjs:82`→`:45`）：页面正常加载，Select 弹层退出期间帧采样只记到两帧（opacity 1 可见，然后 opacity 1 已不可见），200ms 的退场落在两个动画帧之间，没有观察到中间透明度。同一用例在第一次运行的八个环境都通过 | [regression-choices-full-second](regression-choices-full-second/summary.json)，[trace 与采样帧](regression-choices-full-second-traces.json) |
| 上述两个失败用例，各自在原环境单独重复 10 次（用例、超时、重试未改） | exit-frames 10/10（webkit-light-desktop），email tags 10/10（chromium-dark-phone） | [regression-repeat-exit-frames](regression-repeat-exit-frames/summary.json)，[regression-repeat-email-tags](regression-repeat-email-tags/summary.json) |
| overlays 矩阵 `npm run test:ui-overlays -w @orbit/web`（Dialog/Drawer 外观、Tab 循环、Esc/外部关闭与焦点归还、嵌套层、新旧弹层双向共存、异步确认、主题继承、合成中 Esc、动效与滚动恢复），八环境 | **96/96** | [regression-overlays](regression-overlays/summary.json) |
| choices / overlays / toasts / toasts-tests 四套 fixture 类型检查 | 通过（退出码 0，无输出） | [checks/fixture-types.json](checks/fixture-types.json) |
| 相关单测（`theme.test.tsx`、`boundary.test.ts`、`ShareModal.test.tsx`、`WorkspaceView.composerMenu.test.tsx`，即 P2.2 的单测集合） | 4 个文件 / 22 个测试通过；boundary 确认 Base UI 仍只在 Orbit 组件内、公共组件不依赖 AntD | [checks/unit-tests.json](checks/unit-tests.json) |

菜单密度、手机附件菜单的 42.4px 行高 / 17px 字号 / 26px 圆角、入场退场动效、子菜单、搜索/清除/禁用/空值、Dialog 内逐层 Esc、焦点归还、滚动锁和 IME 合成，都由完整矩阵与原入口中未改动的原用例在两棵树上覆盖；Select 已修好的 ↓/↑/Enter 另由前一任务的 burst 探针在两棵树上确定性覆盖。

## 证据边界

- 探针依赖 CDP 的输入队列，只在 Chromium（`chromium-dark-desktop`）上跑，与前一任务相同。WebKit 只由完整 choices 矩阵中的自然时序用例覆盖，均未改动：Menu 的 ↓、Enter、方向键子菜单和 Space 在「menu arrows, disabled items, submenu, checkbox and focus return work」（`choices.browser.mjs:198`，每步等待焦点断言，不进入窗口）；Menu 的 ↓⏎ 在「multiple choices in Dialog keep their owner and menus do not activate a clickable row」（`:592`，两键之间不等待）；Select 的 ↓↓⏎ 在「select supports arrows, Enter, clear…」（`:263`，不等待）。Menu 的 ↑（包括作为打开键），以及打开的 Select 上的 Home/End、Space、PageUp/PageDown、字符检索，现有用例在任何浏览器上都没有按过（`choices-lifecycle.browser.mjs:107` 的 PageDown 是所有弹层关闭后滚动页面用的）；它们在 WebKit 上的旧 AntD 与 Orbit 基线本次没有建立。
- burst 是把按键确定性地放进窗口的手段，模拟主线程繁忙时排队的输入，不代表真人打字速度；自然时序下落入窗口的频率随负载变化，本次没有统计。
- 结论只覆盖上表的序列和起点，没有穷举所有按键组合、所有菜单或选择项配置（例如分组、可搜索的 Combobox/MultiSelect 不在本任务内）。
- 没有用真实读屏软件或真机输入法验证。
- 没有产品改动，所以没有「修复后」运行。基线大部分在基线树上采，↑ 打开序列在交付树上采；两棵树在探针涉及的文件上相同（见「基线与提交」），前一任务的 burst 探针在两棵树上的结果见上表。
- 环境性加载失败（页面没有挂载，trace 中为 `net::ERR_NETWORK_CHANGED`）如实保留，均发生在按键之前，不计入样本，并在 `baseline-rerun`、`baseline-menu-up-rerun` 中补跑。
- 本交付不声称已落地；合并与落地由协调者和平台完成。

## 原件与复核

- 每次后台作业的命令、作业号、提交、Web 树、退出码和原始输出，都用 [record-check.py](record-check.py) 写入 [checks/](checks/)，不覆盖已有文件；退出码取自 runner 的 bg_output。记录里的提交是归档时的 HEAD，被测内容以其中的 Web 树为准：同一棵 Web 树上，作业运行期间只有本目录在变。被 runner 在排空时终止、没有留下报告的那次选择基线也保留在 [checks/baseline-select-killed.json](checks/baseline-select-killed.json)。前一会话停止前在基线树上启动过一次合并检查，它的退出码那个会话没有读到，本会话也读不到（作业属于前一会话），所以没有记录、不计入；合并检查以交付树上的这一次为准。
- 浏览器原件用仓库现有的 `src/web/ui-migration/collect-choice-evidence.mjs`（overlays 用 `collect-overlay-evidence.mjs`）归档到新目录，每份附件带 SHA-256；有失败的运行用 `--diagnostic` 归档，trace 和 error-context 都保留，并用 p2.2 第 8 版的 `read-trace.py` 归类到同名的 `*-traces.json`。

| 目录 | 树 | 内容 |
| --- | --- | --- |
| [dev-check](dev-check/summary.json) | 基线树 | 开发自检：每个组合 burst/paced 各 1 个样本，在探针提交之前（当时还没有 `select-enter-down-enter`），不计入判定 |
| [baseline-menu](baseline-menu/summary.json) | 基线树 | 菜单基线，960 个测试 |
| [baseline-select-a](baseline-select-a/summary.json) … [-e](baseline-select-e/summary.json) | 基线树 | 选择基线五段，共 1480 个测试 |
| [baseline-rerun](baseline-rerun/summary.json) | 基线树 | 13 个页面未挂载样本的补跑 |
| [baseline-menu-up](baseline-menu-up/summary.json) | 交付树 | ↑ 打开的菜单基线，360 个测试 |
| [baseline-menu-up-rerun](baseline-menu-up-rerun/summary.json) | 交付树 | 1 个页面未挂载样本的补跑 |
| [regression-select-keys-burst](regression-select-keys-burst/summary.json)、[-delivered](regression-select-keys-burst-delivered/summary.json) | 基线树、交付树 | 前一任务 burst 探针的重跑 |
| [regression-choices-entry](regression-choices-entry/summary.json)、[-delivered](regression-choices-entry-delivered/summary.json) | 基线树、交付树 | choices 原入口，八环境 |
| [regression-choices-full-first](regression-choices-full-first/summary.json)、[-second](regression-choices-full-second/summary.json) | 基线树 | 完整 choices 矩阵的两次运行 |
| [regression-repeat-exit-frames](regression-repeat-exit-frames/summary.json)、[regression-repeat-email-tags](regression-repeat-email-tags/summary.json) | 基线树 | 前两次失败用例的单独重复 |
| [regression-overlays](regression-overlays/summary.json) | 基线树 | overlays 矩阵 |
| [regression-choices-full-delivered](regression-choices-full-delivered/summary.json) | 交付树 | 完整 choices 矩阵 |
| [regression-repeat-motion-flipped-search](regression-repeat-motion-flipped-search/summary.json)、[-flipped-attachment](regression-repeat-motion-flipped-attachment/summary.json)、[-top-search](regression-repeat-motion-top-search/summary.json) | 交付树 | 第一次完整运行失败用例的单独重复 |
| [regression-overlays-delivered](regression-overlays-delivered/summary.json) | 交付树 | overlays 矩阵 |

- 复核：`python3 docs/evidence/base-ui-migration/p2-keyboard-window/summarize-keyboard-window.py` 从各目录的原始样本重新生成 [keyboard-window-summary.json](keyboard-window-summary.json)；[index-artifacts.py](index-artifacts.py) 生成 [artifact-index.json](artifact-index.json)，提交后可用 `python3 docs/evidence/base-ui-migration/p2-keyboard-window/index-artifacts.py --verify <commit>` 从 Git 对象逐个核对。
