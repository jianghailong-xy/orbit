# P2 跟进：Menu 与 Select 打开窗口内的其余按键，与 AntD 对照

本目录服务于 [P2 跟进：Menu 与 Select 打开窗口内的其余按键，与 AntD 对照](orbit-task:34b7qz5n4yA7s4fJmHNDn)，处理 [P2 修复：Select 快速连按 ↓↓⏎ 时重选当前值](orbit-task:34b4miWykA9R4izIml42v) 的证据 [p2-select-keys](../p2-select-keys/README.md) 留下的两处未对照项：Orbit Menu 的同类窗口，以及 Orbit Select 窗口内其余按键。验收条目 key `1BvO6hYrlFnU60JqxQPUHt`，原文：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。**

本任务先后由三个 Claude Opus 5.5 执行会话完成，前两个都因 Claude 会话额度用尽而停止。
- 第一会话（5Tb4gkgTYHzNfhUUzo4qiH）写了探针，采完基线，并在基线树上跑了大部分回归。
- 第二会话（6ne1g27Q1KbMWHyE8f3gHk）把第一会话的原件接到本分支，补采 ↑ 作为打开键的三个菜单序列，在交付树上重跑了全部回归和合并检查。P2.2 原用例 `choices.browser.mjs:592` 会因 Orbit Menu 的窗口在自然时序下偶发失败，这是 P3.2 先发现、交给本任务的；第二会话在交付树上测到了这一失败，把是否修交给协调者判定。
- 协调者于 2026-10-07 00:10 UTC 选择方案 B，并改写了验收标准。
- 本会话（4Cx1L29ytLWR86WCqiV7ck）在最新项目分支上实施方案 B，完成修复前后对照和全部回归。

**结论**

1. 按任务规则，只修「旧 AntD 正确而 Orbit 不正确」的组合，没有组合符合：
   - 旧 AntD Dropdown 不从触发器处理 ↓/↑/Enter 导航，任何这类序列都不执行菜单项。
   - 旧 AntD Select 打开后不给 Home/End、Space、PageUp/PageDown、字符检索任何功能。
   - 旧 AntD 处理的序列（Space 或 Enter 打开后 ↓⏎），Orbit 在窗口内也已正确，靠的是前一任务的修复。

   Select 及 Select 窗口的其余按键都没有改。
2. 唯一的改动是协调者授权的例外：Orbit Menu 已打开、焦点还没进入时，落在触发器上的 ↓/↑/⏎ 交给菜单处理，做法同 `632b7950e`。
   - 提交 `4fb7ee43f`，只改 `Menu.tsx`（+17/−2），另加确定性单测 `Menu.test.tsx`。
   - burst 探针修复前后同时运行：9 个 ↓/↑/⏎ 序列 × 2 个 Orbit 菜单，修复后 burst 错误全部为 0/20。修复前其中 6 个序列是 20/20 错。修复后每个 burst 样本都交给了菜单；paced 结果和旧 AntD 结果前后相同。
   - 冻结帧探针不依赖 CDP，在八环境（含 WebKit）都跑：修复前每个环境都是同样 7 个用例失败（6 个序列加 Row actions，共 56/80），修复后 80/80 通过。
   - 确定性单测：修复前 6/18 失败，修复后 18/18 通过。
   - `choices.browser.mjs:592`「multiple choices in Dialog…」在 chromium-light-phone 上：
     - 修复后重复 40 次，0 失败；同时运行的修复前树那 40 次也没有失败（`nice -n -10`）。
     - 默认优先级下各重复 100 次：修复前 98/100，两次失败都是 Row actions 停在 1；修复后 100/100。
3. 已验收的行为和外观没有变：
   - 前一任务的 burst 探针 A/B 同时运行，两边各 276/276：Select 已修好的 ↓↓⏎、↓↑⏎、↓⏎ 在两棵树上 burst 都是 0 错，旧 AntD、Combobox、MultiSelect 也都不变；同一探针里只作观察的 Orbit Menu ↓↓⏎ 由 20/20 错变为 0/20；
   - Select 窗口序列在修复树上重采 1480/1480，Orbit 字段与样例的结果、交接和逐序列判定都与基线数据集逐格相同；
   - choices 原入口八环境 32/32；
   - 完整 choices 矩阵 两次，各 519/520：两次各有一个不同的 WebKit 用例在负载下没采到退场中间状态，都不在 Menu 修复的路径上，各自单独重复 10 次在修复前后两棵树上都通过；`:592` 和菜单/选择键盘用例在两次运行的八个环境都通过；
   - overlays 八环境 96/96；
   - 生产页的 Orbit Menu（任务面板 More、分享 Access）由 P3.2 试点 A/B 覆盖：4×72 通过，请求逐步相同，计算样式 0 处不同，超出抗锯齿级的截图都是同一棵树两次运行之间的噪声；
   - 相关单测 7 个文件 / 109 个测试通过；
   - 合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web` 通过：构建成功，vitest 341 个文件 / 4345 个测试。

   原用例与断言、fixture、超时、重试和历史基线都没有改，也没有推送 main 或项目分支。

## 基线与提交

四棵 Web 树：
- **基线树**：第一会话领取时的项目分支 tip，大部分基线和第一轮回归在它上面采。
- **交付树**：第二会话的分支（项目分支 tip `da13423d3` 合入第一会话分支），↑ 打开序列和第二轮回归在它上面跑。
- **修复前树**：本会话的起点，也是修复 A/B 的对照，即项目分支 tip `066d3dd30` 合入第二会话分支后的 `46a418fba`。它的 Web 树与项目分支 tip 相同。
- **修复树**：修复提交 `4fb7ee43f` 及其后的提交。

| 角色 | 提交 | Web 树 |
| --- | --- | --- |
| 第一会话分支起点（领取时的项目分支 tip） | `f7a91822ee26d32ba6fe6ef66a12555bd491d213` | 基线树 `1780d071a6b402eef7d34ea74185684d73db3a85` |
| 探针与开发自检 | `eebe46a2b98976af45835a497d1aed4e95adcfb9` | 基线树 |
| 菜单基线与早期检查 | `7ad82e10aa625ab8b26fccea79aba4fc685048f3` | 基线树 |
| 选择基线 a–d；e 与重跑 | `7676745ffbd214b72e91c62e36cc399a1799078b`；`89256103213431815c02a5e5d4dc8456ef5015c6` | 基线树 |
| 基线树上的回归 | `fb8ea5e9eb6efe9b8744a25d071ed5a775ca312c`、`923c8d856c2637fe63a10da9a4f79813894e7a39`、`a93ecfb2e0f268d9e8ed1c31c4e497273aa1349f`（第一会话分支 tip）；overlays 运行在 `a93ecfb2e` 上，第一会话来不及提交 | 基线树 |
| 第二会话分支起点（项目分支 tip，含 P3.1） | `da13423d3e80e00a487ed91327c31d6788cc7a7a` | 交付树 `7709bb72da4dd0ddb22b6563a62715821318a913` |
| 普通合并第一会话分支 `orbit/p2-menu-select-antd-fde1e4`（无冲突，只带入本目录） | `baf801def920acfa72f3bd45e7a66293df6c1b8e` | 交付树 |
| 接收第一会话的 262 个未提交原件（overlays 运行与 README 草稿；与协调者备份 `p2-kbwindow-wip-20261006T2133Z/untracked.tgz` 逐字节相同） | `92138644d00090a5503986c4cbf0fe6379b58f1f` | 交付树 |
| 探针加入 ↑ 打开序列 | `25309143fa5b571bb85c0f634cb04f339c9c3ccd` | 交付树 |
| ↑ 打开基线、交付树回归、合并检查、Row actions 40 次 | `5e5a50581` … `2ec1f273342372c82f36e668dec3e9052c26707d` | 交付树 |
| 第二会话在做修复前合入项目分支 tip `77233e226`（第二会话分支 tip，之后没有再运行） | `f6b509e18ae0444e51fa88737425542263bc392c` | `6cd5ff308adc25d08a581d10f5e6e1bd08347451` |
| 本会话分支起点（项目分支 tip，含 P3.2 与 B1 修复） | `066d3dd30` | 修复前树 `62fce56ed0c10a115d5c4e567ce1c60e882f79a9` |
| 普通合并第二会话分支 `orbit/p2-menu-select-antd-288742`（无冲突，只带入本目录） | `46a418fba9889b88f3fd1a832c18e41845fb0546` | 修复前树 |
| **修复**：`Menu.tsx` 触发器把窗口内的 ↓/↑/⏎ 交给菜单；新增 `Menu.test.tsx` | `4fb7ee43f1a39d9ac0624270cc581cbcd75039a0` | 修复树 `c3c0956ee13af6c020a3de630819693c99dcd270` |
| 单测的帧编号在文件内不再重置（不改用例） | `25d4e9b1d941fe8eea0b804cf36eb97e60d74fba` | 修复树 `df7414507c6ffa7fa51b7cd6e3e2b8f70e13e816` |
| 冻结帧探针 | `5a6ee008acb448d5b237902bbbb163090b1a56d6` | 同上 |
| 修复前后对照、回归与本说明 | 其后的提交 | 同上 |

- **前置修复已在本分支。** 本分支不含 `632b7950e` 这个对象，含项目分支落地时变基后的 `31aa07c913fc3833935d6f17ecb1064a790b8503`：两者 `git patch-id --stable` 都是 `4571f3f797eb63fade1c9cf6c1793212526e8622`，`Select.tsx` 逐字节相同。证据提交 `404dcc4e4` 与本分支的 `f7a91822e` 同为 `4c7becb124a588a08e2bf6b9c14767d116e0a135`。因此没有再合入 `orbit/p2-select-f0b881`。
- **基线树与前一任务不同。** 相对 `632b7950e` 的 Web 树 `35301ab31d4c…`，基线树多了项目分支吸收 main（`c500817e2`）带来的 27 个 Web 文件变化，没有一个在 `components/ui` 或 `ui-migration` 下。`src/web/package.json` 与锁文件不变，`index.css` 多 18 行。p2-select-keys 的回归结果因此不能直接沿用。
- **交付树与基线树的差别只有 P3.1（Textarea）。** 交付树多了 20 个 Web 文件变化：
  - `Textarea.tsx`、`TextControls.css`；
  - `index.css` 中 `.composer-field`/`.tdp-compose` 的 textarea 规则；
  - composer fixture 与入口、`controls.browser.mjs`；
  - `playwright.config.mjs` 的 testIgnore、`package.json` 的 `test:ui-composer` 脚本、`.gitignore`；
  - `components/ui/README.md`、`WorkspaceView.composerMenu.test.tsx`。

  `Menu.tsx`、`Select.tsx`、`Floating`、Combobox/MultiSelect、choices fixture、choices 用例与配置、`WorkspaceView.tsx`、根 `package.json` 与锁文件都没有变（`git diff --name-only` 核对）。choices 页经 Orbit `Input` 加载 `TextControls.css`：P3.1 把文本框的焦点规则改为 `:is(:focus, :focus-within):not([data-disabled])`，并把无前后缀文本框 16px 的断点从 600px 改为 960px。只有 `Input`/`Textarea` 带这个类，选择控件用自己的 `.orbit-choice`；探针也不操作文本框，两个视口（390/1280px）下改前改后的字号相同。所以基线树上的基线适用于交付树。已验收行为的回归则在交付树上全部重跑。
- **修复前树与交付树不同。** 项目分支在此期间落地了 P3.2 试点、B1 修复（P2.3 成功提示胶囊）并吸收了 main，Web 树相对交付树有 55 个文件变化（`git diff --stat f6b509e18 066d3dd30 -- src/web`）。其中与本任务有关的有三处：
  - `Menu.tsx` 只改了定位：`useDropdownPlacement`、positioner ref、`container` 类型。
  - `Select.tsx` 改了定位、锚点宽度、`.orbit-select` 根类名和加载图标，并且只在值真正改变时回调 `onValueChange`。
  - `ChoicesFixture.css` 改了类名，并给旧样例的 AntD 菜单图标补了偏移。

  按键处理都没有变。因此：
  - 修复的前后对照全部在修复前树和修复树上同时重跑，不沿用旧树的数字；
  - Select 窗口序列也在修复树上重采了一次，见「修复」一节。
- **依赖与环境。** 三个会话都用 `bash scripts/worktree-overlay.sh` 准备依赖：它判定主工作区安装与本树锁文件不兼容，按锁文件独立执行 `npm ci`（各树锁文件相同）。每次浏览器运行的 globalSetup 都把实际环境与 P0.2 [environment.json](../p0.2/environment.json) 逐字段比较并通过：Chromium 1243 / WebKit 2359、Playwright 1.63.0、字体文件哈希、DPR 1、UTC/en-US。各运行目录保留当次 `environment.json`。全部浏览器运行都是单 worker、retries=0。
- **本会话的运行方式。**
  - 修复前后的对照两边同时运行。为了不在同一棵树里同时起两个开发服务器，用了几棵临时工作树（都在 `/var/tmp/p2kw-c2604b/`，各自按锁文件 `npm ci`）：
    - `before` 在 `46a418fba`（修复前树）：burst 探针、冻结帧、`:592` 重复、前一任务的 burst 探针的修复前一侧；
    - `before2` 在 `46a418fba`：P3.2 试点的修复前一侧（生产构建）；
    - `after2` 在 `0d0bd2c8a`，`after3` 在 `28405c86d`，Web 树都与修复树 `df7414507c6f…` 相同：`after2` 跑试点的修复后一侧和 Select 窗口序列重采，`after3` 跑 `:592` 重复和前一任务 burst 探针的修复后一侧；
    - 本工作树：burst 探针和冻结帧的修复后一侧，以及 choices 原入口、完整矩阵、overlays、单测和合并检查。
  - 每次运行都放在独立网络命名空间里（`unshare -n`，只开 lo），固定端口互不冲突，也不受主机网卡变化影响：前两个会话记录的 `net::ERR_NETWORK_CHANGED` 页面未挂载，本会话一次也没有出现。
  - 正式运行用 `nice -n -10`（`:592` 的 100 次重复特意用默认优先级）。主机负载约 9–35（24 核），其他会话的进程同时在跑。

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

序列都对旧 AntD 和 Orbit 同条件采样。菜单：`⏎`（对照）、`↓↓⏎`、`↓↑⏎`、`↓⏎`、`⏎↓⏎`、`⏎↑⏎`、`⏎⏎`，以及第二会话补采的 ↑ 打开 `↑⏎`、`↑↑⏎`、`↑↓⏎`（Base UI Menu 也用 ↑ 打开，第一会话的序列只把 ↑ 放在第二个键）；另加旧 Dropdown 自己进入菜单的路径 `⏎ Tab ↓ ⏎` 作参照（Tab 不在本任务按键内）。选择：被测键都紧跟在打开列表的 ↓ 之后，即窗口内的第一个键；每个序列配一个去掉被测键的对照序列（`↓`、`↓⏎`、从 7 days 起的 `↓⏎`）。起点 Never 是样例自身的值；7 days 先用 paced 键选好；null 用字段自己的 Clear 按钮，只有 Orbit 字段有。

判定（[summarize-keyboard-window.py](summarize-keyboard-window.py) 生成 [keyboard-window-summary.json](keyboard-window-summary.json)）：每个「目标 × 序列」以 paced 多数结果为参照，burst 与之不同即为错。逐序列先判旧 AntD：

1. 旧 AntD 是否赋予被测键功能：选择看 paced 结果是否不同于对照序列；菜单看 paced 是否执行了某一项。
2. 旧 AntD 在 burst 下是否保持 paced 结果。

只有 1、2 都成立而 Orbit burst 与自己的 paced 不同时才修。「窗口」列是 burst 中后续按键在列表已显示时仍落在第一个键目标（触发器）上的样本数，用来确认窗口确实被覆盖；旧 AntD 的焦点本来就留在触发器或输入框上，对它这是常态，不是窗口。「交接」列是日志中出现由页面重新派发（`isTrusted=false`）按键的样本数，即前一任务的 Select 修复（修复树上还有本任务的 Menu 修复）把键交给列表或菜单的次数。

修复的前后对照另用三种方法，都在修复前树和修复树上同条件运行：

- **同一个 burst/paced 探针**（上文，文件未改）：11 个菜单序列 × 3 个目标，每个组合 20 burst + 20 paced，两棵树同时运行。
- **冻结帧探针**（[menu-held-frames.browser.mjs](menu-held-frames.browser.mjs)，配置 [menu-held-frames.config.mjs](menu-held-frames.config.mjs)），不依赖 CDP，八个环境都能跑：
  - 先聚焦触发器，把页面的 `requestAnimationFrame` 换成只排队不执行的版本，再用普通的 `page.keyboard.press` 连按；
  - 按键是可信事件，Enter 激活 button 的默认动作也由浏览器自己完成；
  - Base UI 要到下一帧才把焦点移入菜单，所以无论主机负载如何，打开键之后的每个键都落在已显示菜单的触发器上；
  - 最后一个键之后释放排队的帧，再读结果。

  它覆盖字段页附件菜单的 9 个 ↓/↑/⏎ 序列，以及 P2.2 原用例 `:592` 用的 Row actions 菜单（↓⏎，不应点到所在的行）。每个用例都先断言「打开键之后的那个键确实落在触发器上且菜单已显示」，确认窗口被覆盖。
- **确定性单测**（[`src/web/src/components/ui/Menu.test.tsx`](../../../../src/web/src/components/ui/Menu.test.tsx)，jsdom，属于 `npm run test -w @orbit/web`）：
  - 用同样的思路截住全部动画帧，按键直接派发给当前焦点元素；
  - 浏览器在 button 上由 Enter 产生的 click 由测试补上，keydown 被阻止时不补；
  - 每个序列跑两遍：一遍每键之后执行帧，即焦点已在菜单，作为参照；一遍帧一直不执行，即窗口，要求两者执行同一项。

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

下面两表是前两个会话采集的基线数据集的判定，修复后的菜单数字见下一节「修复」。数据集为 `baseline-menu`、`baseline-select-a`…`-e`、`baseline-rerun`（基线树）与 `baseline-menu-up`、`baseline-menu-up-rerun`（交付树）的合集，70 个「目标 × 序列」各有 20 个 burst 和 20 个 paced 样本（共 1400 + 1400）。每格依次为：paced 参照结果及其次数/paced 样本数；burst 中与参照不同的样本数/burst 样本数（括号内为不同的结果和次数）；窗口命中数；交接数。Select 结果写作「值，列表开/关」，字段的值为原始值（`never`/`7`），样例为标签。

### 菜单（↓/↑/Enter）

| 序列 | 起点 | 旧 AntD Dropdown 样例 | Orbit 字段页菜单 | Orbit Menu 样例 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `menu-down-down-enter`（↓ ↓ ⏎） | — | open 20/20；burst 错 **0/20**，窗口 0，交接 0 | ran Image 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | ran Image 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | 旧 AntD 不处理；协调者授权的例外：已修（见「修复」） |
| `menu-down-enter`（↓ ⏎） | — | open 20/20；burst 错 **0/20**，窗口 0，交接 0 | ran File 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | ran File 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | 旧 AntD 不处理；协调者授权的例外：已修（见「修复」） |
| `menu-down-up-enter`（↓ ↑ ⏎） | — | open 20/20；burst 错 **0/20**，窗口 0，交接 0 | ran /Command 20/20；burst 错 **0/20**，窗口 20，交接 0 | ran /Command 20/20；burst 错 **0/20**，窗口 20，交接 0 | 旧 AntD 不处理；协调者授权的例外：修复后改由菜单处理，结果不变（见「修复」） |
| `menu-enter`（⏎） | — | open 20/20；burst 错 **0/20**，窗口 0，交接 0 | open 20/20；burst 错 **0/20**，窗口 0，交接 0 | open 20/20；burst 错 **0/20**，窗口 0，交接 0 | 对照 |
| `menu-enter-down-enter`（⏎ ↓ ⏎） | — | closed 20/20；burst 错 **0/20**，窗口 20，交接 0 | ran Image 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | ran Image 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | 旧 AntD 不处理；协调者授权的例外：已修（见「修复」） |
| `menu-enter-enter`（⏎ ⏎） | — | closed 20/20；burst 错 **0/20**，窗口 20，交接 0 | ran File 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | ran File 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | 旧 AntD 不处理；协调者授权的例外：已修（见「修复」） |
| `menu-enter-tab-down-enter`（⏎ Tab ↓ ⏎） | — | ran Image 20/20；burst 错 **20/20**（ran File×20），窗口 20，交接 0 | closed 20/20；burst 错 **20/20**（ran Image×20），窗口 20，交接 0 | closed 20/20；burst 错 **20/20**（ran Image×20），窗口 20，交接 0 | 参照（Tab 不在本任务按键内） |
| `menu-enter-up-enter`（⏎ ↑ ⏎） | — | closed 20/20；burst 错 **0/20**，窗口 20，交接 0 | ran /Command 20/20；burst 错 **0/20**，窗口 20，交接 0 | ran /Command 20/20；burst 错 **0/20**，窗口 20，交接 0 | 旧 AntD 不处理；协调者授权的例外：修复后改由菜单处理，结果不变（见「修复」） |
| `menu-up-down-enter`（↑ ↓ ⏎） | — | open 20/20；burst 错 **0/20**，窗口 0，交接 0 | ran File 20/20；burst 错 **0/20**，窗口 20，交接 0 | ran File 20/20；burst 错 **0/20**，窗口 20，交接 0 | 旧 AntD 不处理；协调者授权的例外：修复后改由菜单处理，结果不变（见「修复」） |
| `menu-up-enter`（↑ ⏎） | — | open 20/20；burst 错 **0/20**，窗口 0，交接 0 | ran /Command 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | ran /Command 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | 旧 AntD 不处理；协调者授权的例外：已修（见「修复」） |
| `menu-up-up-enter`（↑ ↑ ⏎） | — | open 20/20；burst 错 **0/20**，窗口 0，交接 0 | ran Shell 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | ran Shell 20/20；burst 错 **20/20**（closed×20），窗口 20，交接 0 | 旧 AntD 不处理；协调者授权的例外：已修（见「修复」） |

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

## 修复：Orbit Menu 的打开窗口（协调者授权的例外）

### 授权与范围

第二会话把 `:592` 的自然时序失败交给协调者（会话请求 `34bUNOhiTQGErfRAAwIwR`，见下文「Menu 窗口在现有用例中的自然时序表现」）。协调者于 2026-10-07 00:10 UTC 选择方案 B（本任务评论 `34bUf9MN8y7uuvO509WbF`），并改写了验收标准，要求如下：

- 在 Orbit Menu 包装层修打开窗口：菜单已打开、焦点尚未进入时，落在触发器上的 ↓/↑/⏎ 交给菜单处理，做法同 `632b7950e`。
- 只走 Base UI 公开 API 或 Orbit 自己的事件处理，不加延时、不重试、不读取 AntD DOM。
- Select 窗口的其余按键不改。
- P2.2 已验收的行为和外观不变，原断言不改。
- 修复前后要有对照：Menu burst 探针 0 错；`:592` 在 chromium-light-phone 上 40 次 0 失败；另要有一个不依赖自然时序的确定性回归。

这是对任务规则（只修「旧 AntD 正确而 Orbit 不正确」）的唯一例外：旧 Dropdown 不从触发器处理这些键（见「旧 AntD 基线」），所以本修复不是在还原旧行为。它让窗口内的键与焦点已在菜单时的同一组键结果相同，也就是 Orbit Menu 自己的 paced 结果。Space、Tab、Home/End、字符检索等其他键，以及子菜单触发器，都不在授权范围内，没有改。

### 改动

[`src/web/src/components/ui/Menu.tsx`](../../../../src/web/src/components/ui/Menu.tsx)（`4fb7ee43f`，+17/−2）只加了两样东西：给 `BaseMenu.Popup` 一个 Orbit 自己的 ref（`Menu.tsx:76,106`），给 `BaseMenu.Trigger` 一个 Orbit 的 `onKeyDown`（`Menu.tsx:89-103`）。没有改 CSS、DOM 属性、Base UI 状态属性、`Items`/`Submenu`，也没有改公共 API。

当 `layer.open` 为真、弹层已挂载，而 ↓/↑/Enter 落在触发器上时，处理器做两件事：

1. **截住这个键。** 调用 `preventDefault()`、`stopPropagation()` 和 Base UI 公开的 `preventBaseUIHandler()`。Base UI 的 `mergeProps` 先执行使用方（右侧）的处理器，所以触发器的重置（方向键）和原生 button 的 click 切换（Enter）都不再发生。`preventDefault()` 同时取消了 Enter 在 button 上的激活。这个键也不再冒泡给祖先。这一步与 `632b7950e` 相同。
2. **交给菜单。** 在菜单当前高亮的项（Base UI 公开的 `data-highlighted`）上重新派发同一个键，带上 key、code 和修饰键；没有高亮项时派发到弹层本身。于是走 Base UI 菜单自己的处理：
   - 方向键从当前高亮移动，循环、跳过禁用项都与焦点已在菜单时相同；
   - Enter 由该项的 `useButton` 转成 click（`internals/use-button/useButton.mjs:138-140`），执行动作并按 `closeOnClick` 关闭菜单（`menu/item/useMenuItemCommonProps.mjs:52`）。

   重派发的事件 `isTrusted=false`，Base UI 的 keydown 处理不检查它，与 `632b7950e` 相同。

**与 `632b7950e` 唯一的差别：不先移动焦点。** Select 的修复先把焦点交给高亮项，再派发。Menu 不能这样做：
- Menu 默认 `loopFocus`，越过首尾的方向键会把 `forceSyncFocusRef` 置回 false（`useListNavigation.mjs:375-377,396-398`），新高亮项的焦点要下一帧才移过去；
- 若先把焦点交给旧的高亮项，紧随其后排队的 Enter 就会落在旧项上并执行它。开发中按 `632b7950e` 原样先移焦点的第一版，单测就是这样失败的：`↓↑⏎`、`⏎↑⏎` 执行了 File，`↑↓⏎` 执行了 /Command。那次运行在本会话前台执行，没有单独归档。
- 现在焦点留给 Base UI：不越界的方向键会同步移动焦点（`forceSyncFocusRef`，`useListNavigation.mjs:136,300`），之后的键落在新项上，与 paced 相同；越界时焦点仍在触发器，之后的键再由本处理器交给新的高亮项。

另外两点：
- 菜单项被点击时会自己取得焦点（`useListNavigation.mjs:426`），关闭后由 Base UI 把焦点还给触发器。
- 焦点已在菜单时触发器收不到这些键，原有路径不变；菜单关闭或正在退场时 `layer.open` 为假，触发器的打开行为也不变。

### 确定性回归

[`Menu.test.tsx`](../../../../src/web/src/components/ui/Menu.test.tsx) 用 fixture 附件菜单的同一组项（含分隔线和一个禁用项），对 9 个 ↓/↑/⏎ 序列各跑参照和窗口两遍，共 18 个用例。窗口用例先断言三件事：菜单已打开、首个高亮是打开键决定的那一项、焦点仍在触发器。

| 运行 | 树 | 结果 | 原件 |
| --- | --- | --- | --- |
| 修复前 | 修复前树 + 从 `4fb7ee43f` 原样复制的 `Menu.test.tsx`（`git status` 只显示这一个未跟踪文件） | **6 失败 / 12 通过**：9 个参照全部通过；窗口里失败的正是 burst 探针修复前 20/20 错的 6 个序列（↓↓⏎、↓⏎、⏎↓⏎、⏎⏎、↑⏎、↑↑⏎，什么也不执行），越界的 3 个（↓↑⏎、⏎↑⏎、↑↓⏎）与探针一样巧合正确 | [checks/unit-menu-window-before](checks/unit-menu-window-before.json) |
| 修复后 | `4fb7ee43f` | **18/18 通过** | [checks/unit-menu-window-after](checks/unit-menu-window-after.json) |

后来的 `25d4e9b1d` 不改用例，只让桩的帧编号在整个文件内递增。Base UI 把上一次排队的焦点帧编号存在模块里，下一次移焦点时会取消它；每个用例都从 1 开始编号，有可能误删后一个用例的帧。改后 18/18 照常通过，也包含在合并检查里。

### 修复前后对照

#### burst/paced 探针（Chromium，同一探针、同时运行）

[fix-menu-before](fix-menu-before/summary.json)（修复前树）与 [fix-menu-after](fix-menu-after/summary.json)（修复树）各 1320 个测试全部通过，没有页面未挂载。汇总见 [keyboard-window-summary.json](keyboard-window-summary.json) 的 `fix:menu-before-after`。

每格写「burst 中与 paced 参照不同的样本数，修复前 → 修复后」，以及 paced 参照结果；两棵树上 paced 参照逐格相同。

| 序列 | 旧 AntD Dropdown 样例 | Orbit 字段页菜单 | Orbit Menu 样例 | 修复后交接 |
| --- | --- | --- | --- | --- |
| `menu-down-down-enter`（↓ ↓ ⏎） | 0/20 → 0/20（open） | **20/20 → 0/20**（ran Image） | **20/20 → 0/20**（ran Image） | 20 + 20 |
| `menu-down-enter`（↓ ⏎） | 0/20 → 0/20（open） | **20/20 → 0/20**（ran File） | **20/20 → 0/20**（ran File） | 20 + 20 |
| `menu-down-up-enter`（↓ ↑ ⏎） | 0/20 → 0/20（open） | 0/20 → 0/20（ran /Command） | 0/20 → 0/20（ran /Command） | 20 + 20 |
| `menu-enter-down-enter`（⏎ ↓ ⏎） | 0/20 → 0/20（closed） | **20/20 → 0/20**（ran Image） | **20/20 → 0/20**（ran Image） | 20 + 20 |
| `menu-enter-up-enter`（⏎ ↑ ⏎） | 0/20 → 0/20（closed） | 0/20 → 0/20（ran /Command） | 0/20 → 0/20（ran /Command） | 20 + 20 |
| `menu-enter-enter`（⏎ ⏎） | 0/20 → 0/20（closed） | **20/20 → 0/20**（ran File） | **20/20 → 0/20**（ran File） | 20 + 20 |
| `menu-up-enter`（↑ ⏎） | 0/20 → 0/20（open） | **20/20 → 0/20**（ran /Command） | **20/20 → 0/20**（ran /Command） | 20 + 20 |
| `menu-up-up-enter`（↑ ↑ ⏎） | 0/20 → 0/20（open） | **20/20 → 0/20**（ran Shell） | **20/20 → 0/20**（ran Shell） | 20 + 20 |
| `menu-up-down-enter`（↑ ↓ ⏎） | 0/20 → 0/20（open） | 0/20 → 0/20（ran File） | 0/20 → 0/20（ran File） | 20 + 20 |
| `menu-enter`（⏎，对照） | 0/20 → 0/20（open） | 0/20 → 0/20（open） | 0/20 → 0/20（open） | 0 + 0 |
| `menu-enter-tab-down-enter`（⏎ Tab ↓ ⏎，Tab 参照） | 20/20 → 20/20（ran Image） | 20/20 → 20/20（closed） | 20/20 → 20/20（closed） | 0 + 0 |

修复后，9 个授权序列在两个 Orbit 菜单上 burst 全部 0 错，每个 burst 样本都至少交接了一次。修复前 20/20 错的 6 个序列全部改正。修复前就巧合正确的 3 个越界序列结果不变，但现在也是交给菜单处理的。

paced 参照（焦点已在菜单）和旧 Dropdown 的结果前后相同。对照序列和 Tab 参照序列没有交接，结果不变：Tab 不在授权按键内，见「范围外观察」。

#### 冻结帧探针（八环境，含 WebKit）

[fix-held-frames-before](fix-held-frames-before/summary.json)（修复前树）与 [fix-held-frames-after](fix-held-frames-after/summary.json)（修复树）同时运行，各 80 个测试（10 个用例 × 8 个环境）。汇总见 [keyboard-window-summary.json](keyboard-window-summary.json) 的 `fix-held-frames-before`/`-after`。

每行是一个用例在八个环境（Chromium/WebKit × 明/暗 × 桌面/手机）中通过的环境数。「窗口」是打开键之后的那个键确实落在触发器上、且菜单已显示的运行数，每个用例都断言了这一点；「交接」是日志里出现重新派发按键的运行数。

| 用例 | 修复前树：通过 / 窗口 / 交接 | 修复树：通过 / 窗口 / 交接 |
| --- | --- | --- |
| 附件菜单 ↓ ↓ ⏎ → image | **0/8** / 8 / 0 | **8/8** / 8 / 8 |
| 附件菜单 ↓ ⏎ → file | **0/8** / 8 / 0 | **8/8** / 8 / 8 |
| 附件菜单 ↓ ↑ ⏎ → command | 8/8 / 8 / 0 | 8/8 / 8 / 8 |
| 附件菜单 ⏎ ↓ ⏎ → image | **0/8** / 8 / 0 | **8/8** / 8 / 8 |
| 附件菜单 ⏎ ↑ ⏎ → command | 8/8 / 8 / 0 | 8/8 / 8 / 8 |
| 附件菜单 ⏎ ⏎ → file | **0/8** / 8 / 0 | **8/8** / 8 / 8 |
| 附件菜单 ↑ ⏎ → command | **0/8** / 8 / 0 | **8/8** / 8 / 8 |
| 附件菜单 ↑ ↑ ⏎ → shell | **0/8** / 8 / 0 | **8/8** / 8 / 8 |
| 附件菜单 ↑ ↓ ⏎ → file | 8/8 / 8 / 0 | 8/8 / 8 / 8 |
| Row actions ↓ ⏎ → 执行动作、不点行 | **0/8** / 8 / 0 | **8/8** / 8 / 8 |
| 合计 | 24 通过 / 56 失败 | **80 通过** |

修复前的 56 个失败，都是窗口断言通过之后的产品断言（`menu-held-frames.browser.mjs:71`、`:80`）：
- 应执行 image、file、command、shell 的地方，Action 停在 none；
- Row actions 停在 0，应为 1。

没有一个是环境性失败。修复前失败的正是 burst 探针里 20/20 错的那 6 个序列，越界的 3 个巧合正确，这在 Chromium 和 WebKit 上完全一致。修复后，所有用例在八个环境都执行了 paced 参照会执行的那一项，Row actions 没有点到所在的行。原件分别是 [fix-held-frames-before](fix-held-frames-before/summary.json)（`--diagnostic` 归档，保留 trace 和 error-context）和 [fix-held-frames-after](fix-held-frames-after/summary.json)。

#### `choices.browser.mjs:592` 自然时序重复（原用例，未改）

原用例、超时、重试都没有改，每次运行各在独立网络命名空间里。两组都是修复前树与修复树同时运行：

| 运行 | 修复前树 | 修复树 | 原件 |
| --- | --- | --- | --- |
| `--repeat-each 40`，chromium-light-phone + webkit-light-phone，`nice -n -10` | chromium 40/40，webkit 40/40 | **chromium 40/40（0 失败）**，webkit 40/40 | [fix-row-actions-before](fix-row-actions-before/summary.json)、[fix-row-actions-after](fix-row-actions-after/summary.json) |
| `--repeat-each 100`，chromium-light-phone，默认优先级 | **98/100**：归档名 `--repeat-11`、`--repeat-21` 的两次在 `:624` 失败，Row actions 停在 1 | **100/100** | [fix-row-actions-100-before](fix-row-actions-100-before/summary.json)（`--diagnostic`，[trace 归类](fix-row-actions-100-before-traces.json)）、[fix-row-actions-100-after](fix-row-actions-100-after/summary.json) |

- **验收要求的运行**：修复后 chromium-light-phone 40 次 0 失败。
- **修复前 40 次为什么也没失败**：那一组以 `nice -n -10` 运行，自然时序 80 次都没有把 ⏎ 送进窗口。所以第一组只能说明修复后没有失败，不能单独说明修复的作用。
- **第二组（默认优先级，100 次）**：修复前的两次失败正是窗口的症状。trace 没有失败的请求，也没有网络变化错误；↓ 从 +0ms 开始、+12.7ms 结束，⏎ 分别在 +14.4ms、+14.9ms 开始，落在一帧之内（[row-actions-traces.py](row-actions-traces.py)）。修复树在同时运行的 100 次里没有失败。
- **频率**：自然时序下落入窗口的频率随负载变化，此前测得的是 1/40（交付树）和 6/40、9/40（P3.2）。修复的作用由上面两个确定性对照证明，这里的重复只说明它在自然时序下也成立。

### Select 与其他没有改的部分

本任务对 Select 没有改动：
- 相对项目分支 tip，本分支只改了 `Menu.tsx`、新增了 `Menu.test.tsx` 和本目录（`git diff --name-only 066d3dd30 HEAD`）。
- Select 窗口内的 Home/End、Space、PageUp/PageDown、字符检索，按「逐组合结论」都属于「旧 AntD 自己也不处理」，只记录。

修复树上另做了两项检查：

- **前一任务的 burst 探针 A/B**：Select 已修好的 ↓/↑/Enter 修复前后逐行相同，唯一变化的是同一探针里只作观察的 Orbit Menu 那一行（20/20 错 → 0/20）。详见「其他已验收行为」的修复树表。
- **Select 窗口序列重采**：基线是在基线树上采的，此后项目分支的 P3.2 改过 `Select.tsx` 的定位、类名和 `onValueChange`（见「基线与提交」），所以在修复树上把本目录探针的 13 个 select 序列重采了一次，每个组合同样是 20 burst + 20 paced。结果（数据集 `fix-select-after`，13 段共 1480 个测试全部通过）：
  - Orbit 字段与 Orbit 样例在每个序列上的 paced 参照、burst 错误数和交接数，都与基线数据集逐格相同（`summarize-keyboard-window.py` 逐序列比较），所以「逐组合结论」的选择表在修复树上仍然成立。
  - 唯一不同的是旧 AntD 样例：`↓ Home ⏎` 的 burst 有 1/20（文件名中的样本 18）值仍为 7 days、与参照相同，但列表结束时仍打开；Home 与 Enter 在 ↓ 之后 13.5ms、13.8ms 到达。看来与基线里旧 AntD `↓ PgUp ⏎` paced 的那一次同类：rc-select 的关闭经一个宏任务延后执行，期间的开合调用会取消它；这次是哪个调用，同样没有查明。它不影响判定：旧 Select 在打开的列表里仍不给 Home 任何功能，值也与对照相同。

## Orbit 在窗口内的行为从何而来（修复前）

下面是修复前的机制（Menu 部分已由上一节的修复改变；Select 部分至今未改，前一任务的 Select 修复见 p2-select-keys）。

Base UI 1.8.0 的 Menu 与 Select 都是非 virtual 列表导航：键盘打开后焦点在下一动画帧才进入列表（`floating-ui-react/components/FloatingFocusManager.mjs:362,391`，`floating-ui-react/hooks/useListNavigation.mjs:136`）。这一帧里按键仍落在触发器上：

- **Menu 的 ↓**：触发器把主方向键交给 `commonOnKeyDown`（`useListNavigation.mjs:556-566`），此时焦点在触发器，命中「Reset the index if no item is focused」（`:360-367`）：↓ 回到第一项 File，与已有高亮相同，索引不变，焦点也不移动。**Menu 的 ⏎**：原生 button 产生 click，触发器的 `useClick` 设为 `toggle: true`（`menu/trigger/MenuTrigger.mjs:155-160`，`useClick.mjs:102-117`），菜单关闭，什么也不执行。窗口内的 Orbit Menu 因此与旧 Dropdown 一样：触发器上的 ⏎ 关闭菜单，不执行菜单项。
- **Menu 的 ↑**（`↓↑⏎`、`⏎↑⏎`）：同一重置把 ↑ 送到最后一项 /Command，索引改变；`commonOnKeyDown` 置 `forceSyncFocusRef`（`useListNavigation.mjs:300`），焦点同步移到 /Command，随后的 ⏎ 落在它上面。Menu 默认 `loopFocus`（`menu/root/MenuRoot.mjs:42`），paced 从 File 按 ↑ 也回绕到 /Command，所以两种节奏结果巧合地相同。
- **Menu 的 ↑ 作为打开键**（`↑⏎`、`↑↑⏎`、`↑↓⏎`，第二会话补采）：触发器上的 ↑ 与 ↓ 一样打开菜单（`menu/root/MenuRoot.mjs:374` 的 `openOnArrowKeyDown`），按打开键高亮最后一项 /Command（`useListNavigation.mjs:238`）。窗口内的 ⏎ 仍是原生 click，按切换关闭菜单，什么也不执行；第二个 ↑ 命中同一重置分支，被送到最后一项 /Command，与已有高亮相同，索引不变，焦点不动，随后的 ⏎ 关闭菜单；↓ 被重置到第一项 File，索引改变，焦点同步移到 File，⏎ 执行 File。paced 下 ↑ 从 /Command 跳过禁用的 Skill 到 Shell（Orbit 的禁用项不注册为可选项，见 `Menu.tsx` 的注释），↓ 从 /Command 回绕到 File，所以 `↑↓⏎` 两种节奏结果巧合地相同。旧 Dropdown 的触发器对 ↑ 没有任何处理，三个序列都只是 ⏎ 打开了菜单。
- **Select 的 Home/End**：只有 `commonOnKeyDown` 处理（`useListNavigation.mjs:336-345`），触发器只把主方向键交给它（`:529,556`），窗口内的 Home/End 没有作用。随后的 ⏎ 由前一任务的修复交给仍高亮的当前值，结果与旧 Select 相同（值不变）。paced 下 Home 到 Never；End 到最后一项 30 days，它是禁用项（Select 传 `disabledIndices: EMPTY_ARRAY`，`select/root/SelectRoot.mjs:292`），⏎ 不能选它，列表保持打开。
- **Select 的 PageUp/PageDown**：Base UI 1.8.0 的 floating-ui、select、menu 中都没有处理，两种节奏下都只有浏览器默认动作，与旧 Select 相同。
- **Select 的 Space**：窗口内落在触发器上。typeahead 不为 Space 阻止事件，只把它记入检索字符串，匹配不到也不重置（`useTypeahead.mjs:67-71,84,107,123`）；列表导航只记下它，不处理（`useListNavigation.mjs:530`）；原生 button 在 keyup 时产生 click，`useClick` 按切换关闭列表（`select/root/SelectRoot.mjs:282-285`，`useClick.mjs:102-117`），不选择。paced 下 Space 由高亮项执行并选中它。从样例自身的值开始，两者结果都是原值、列表关闭；从 null 开始，paced 选中 Never，burst 保持 null。旧 Select 打开后 Space 没有功能，列表保持打开。
- **Select 的字符检索**：typeahead 的同一个处理器同时挂在触发器和弹层上（`useTypeahead.mjs:160-161`），打开时匹配只移动高亮（`SelectRoot.mjs:315-318`）。窗口内的字符照样移动高亮，随后的 ⏎ 被前一修复交给新高亮项，所以 burst 与 paced 相同。
- **Space/Enter 打开**（`Space ↓ ⏎`、`⏎ ↓ ⏎`）：窗口内的 ↓/⏎ 由前一任务的修复交给列表，与旧 Select 和 paced 都相同。

## 范围外观察（均未改）

1. **Tab 的语义不同，与窗口无关。** 旧 Dropdown 用 Tab 进入打开的菜单；Orbit Menu 用 Enter/↓ 打开时已把焦点移入菜单，此时 Tab 离开菜单并关闭它：paced 下焦点移到触发器之后的下一个可聚焦元素（字段页为 Open context，随后的 ⏎ 打开了它的 Popover；样例页触发器之后没有可聚焦元素，回到页首的 Switch theme），40/40。所以 `⏎ Tab ↓ ⏎` 在 paced 下旧 Dropdown 执行 Image，Orbit 不执行任何菜单项。burst 下，Tab 在窗口内落在触发器上，随后的 ↓ 已落在菜单项 File 上（40/40），Orbit 反而执行 Image；本次没有追查这一焦点移动来自哪段代码。这是 P2.2 起就存在的键盘模型差异，Tab 不在本任务按键内，P2.2 证据也没有对照过；是否需要处理，由协调者决定。本任务的修复只处理 ↓/↑/⏎，不涉及 Tab：修复前后 `⏎ Tab ↓ ⏎` 的结果相同，burst 都与 paced 不同（20/20），也没有发生交接（见「修复前后对照」）。
2. **Orbit Select 的 End 停在禁用的最后一项**，⏎ 不选择、列表保持打开（见上）。旧 Select 没有 End 功能，这是 Base UI 自身语义，本任务不改。

## Menu 窗口在现有用例中的自然时序表现

P2.2 的原用例「multiple choices in Dialog keep their owner and menus do not activate a clickable row」（`choices.browser.mjs:592`）在 `:621-623` 聚焦 Orbit「Row actions」菜单按钮，连按 ↓、⏎，中间不等待，在 `:624` 期望 Row actions 为 2。这是 Orbit 自有的键盘行为：旧 Dropdown 的触发器不响应 ↓，没有对应的旧行为。修复前，如果 ⏎ 在 ↓ 之后一帧之内到达，就落进上文的窗口：⏎ 落在触发器上，按切换关闭菜单，Row actions 停在 1。这个用例是窗口在自然时序下的可见症状：

- [P3.2 任务](orbit-task:34Za39ACSBoCkYKc80Md8)的证据（分支 `orbit/p3-2-590579`，`p3.2/README.md` 第 208、273 行）在 chromium-light-phone 上把该用例单独重复 40 次：项目 tip 失败 6 次，P3.2 交付失败 9 次。P3.2 的完整 choices 矩阵因此没有一轮全绿，那份证据写明交由本任务处理。
- 第二会话在交付树上同样重复 40 次，失败 1 次（[regression-row-actions-repeat](regression-row-actions-repeat/summary.json)，第 22 次）。trace 中没有网络错误：↓ 从 +0ms 开始、+13.7ms 结束，⏎ 在 +15.7ms 开始，落在一帧之内。前两个会话的四次完整矩阵（基线树两次、交付树两次）里，这个用例在八个环境都通过。

按任务规则，`menu-down-enter` 属于「旧 AntD 自己也不处理」的组合，第二会话因此只记录、没有改 Menu，并请协调者在两种处理之间判定：(A) 维持规则，完整矩阵按实际结果报告；(B) 在 Orbit Menu 包装层按 `632b7950e` 的做法修这个窗口。**协调者选择了 (B)**，修复见上一节。修复后的结果：

- chromium-light-phone 上，修复树在 `nice -n -10` 下重复 40 次、默认优先级下重复 100 次，都是 **0 失败**。同时运行的修复前树分别是 40/40 和 98/100；两次失败都是 Row actions 停在 1，⏎ 在 ↓ 之后 14–15ms 开始。webkit-light-phone 上修复前后各 40/40。
- 冻结帧探针把同一个 ↓⏎ 确定地放进窗口：修复前八个环境 Row actions 都停在 0，修复后都执行了动作，也都没有点到行。
- 本会话完整 choices 矩阵里这个用例的结果，见「其他已验收行为」。

## 其他已验收行为

第一、二会话没有改产品代码，所以他们在基线树和交付树上的运行只是已验收行为的重跑，原件都保留在下面两小节。本会话改了 `Menu.tsx`，回归在修复树上重跑；能做同时对照的检查，也在修复前树上同时跑了。

修复没有改任何 CSS、DOM 属性或 Base UI 状态属性，只加了一个 ref 和一个按键处理器。

- 菜单密度、手机附件菜单的 42.4px 行高 / 17px 字号 / 26px 圆角、入场退场动效、子菜单、搜索/清除/禁用/空值、Dialog 内逐层 Esc、焦点归还、滚动锁和 IME 合成：都由下面完整矩阵与原入口中没有改动的原用例覆盖。
- 生产页上的 Orbit Menu：由 P3.2 试点 A/B 覆盖。
- Select 已修好的 ↓/↑/Enter：由前一任务的 burst 探针 A/B 确定性覆盖。
- 焦点归还：修复后的 burst 探针里，执行了菜单项的 400 个样本最后焦点都回到菜单按钮，与 paced 相同。

### 修复树（本会话）

| 检查 | 结果 | 原件 |
| --- | --- | --- |
| choices 测试清单 `--list` | 520 个测试 / 4 个文件，从「Listing tests:」起与 `checks/list-choices.txt`、`checks/list-choices-delivered.txt` 和 `p2-select-keys/checks/list-choices.txt` 逐字节相同（sha256 `869171286b2f…`）：没有增删或改名。新单测属于 vitest，不在这个清单里 | [checks/list-choices-fix.txt](checks/list-choices-fix.txt)、[作业](checks/list-choices-fix-job.json) |
| choices 原入口（Dialog/旧 Modal 内选择器、逐层 Esc、Tab、主题、IME 合成、外部点击、子菜单 Esc、键盘清除、正常/减少动效下 Dialog→Popover→Select 逐层退出），八环境 | **32/32**，与基线树、交付树相同 | [fix-choices-entry](fix-choices-entry/summary.json) |
| 完整 choices 矩阵 `npm run test:ui-choices -w @orbit/web` | 两次运行，各 **519/520**，都在独立网络命名空间里，没有页面未挂载、没有失败的请求。两次失败的用例不同，都在负载下没采到退场的中间状态，都不在 Menu 修复的路径上：<br>- **第一次（22.7 分钟）**：webkit-dark-phone「normal attachment can reopen during exit without stale unmount」（`choices-lifecycle.browser.mjs:140`）。按 Escape 后要看到附件菜单的退场状态（`data-closed`），但元素已经不在（element(s) not found，页面只剩触发器）。trace 中 Escape 按下用了 145ms，断言在按下开始后 359ms 才开始，超过菜单 0.2s 的退场。Escape 由 Base UI 的 dismiss 处理，菜单是轻触打开的、焦点在菜单里，本修复的处理器（菜单打开时触发器上的 ↓/↑/⏎）不在这条路径上。<br>- **第二次（25.2 分钟）**：webkit-light-desktop「no-preference Dialog Popover Select exits restore one layer at a time」（`:45`，经 `:82`）。Select 弹层 0.2s 的退场只采到两帧（opacity 1 可见，然后 opacity 1 已不可见），与第一会话在基线树上记录的 `regression-choices-full-second` 同一签名。这是 Select 的退场，与 Menu 无关。<br>两个失败用例各自在原环境单独重复 10 次（用例、超时、重试未改），修复前树与修复树同时运行，四组都是 **10/10**。<br>`:592`、「menu arrows, disabled items, submenu, checkbox and focus return work」和「select supports arrows, Enter, clear…」在两次运行的八个环境都通过。 | 第一次 [fix-choices-full](fix-choices-full/summary.json)（`--diagnostic`，[trace 归类](fix-choices-full-traces.json)），重复 [fix-repeat-reopen-exit-before](fix-repeat-reopen-exit-before/summary.json)、[-after](fix-repeat-reopen-exit-after/summary.json)；第二次 [fix-choices-full-second](fix-choices-full-second/summary.json)（`--diagnostic`，[trace 归类](fix-choices-full-second-traces.json)），重复 [fix-repeat-exit-frames-before](fix-repeat-exit-frames-before/summary.json)、[-after](fix-repeat-exit-frames-after/summary.json) |
| 前一任务的 burst 探针（`p2-select-keys/select-keys-burst.browser.mjs`，文件未改），修复前树与修复树同时运行，按目标分 5 段 | 两边各 **276/276**。burst 中与参照不同的样本数，修复前 → 修复后（括号内为修复后的交接数）：<br>- Orbit 字段 ↓↓⏎、↓↑⏎、↓⏎（从 null）：0/20 → 0/20（20、20、20）；Orbit 样例 ↓↓⏎、↓↑⏎：0/20 → 0/20（20、19）。即 Select 已修好的键前后相同，仍由前一任务的修复交给列表。<br>- 旧 AntD 样例 2 个序列、Combobox、旧 AntD search、MultiSelect、旧 AntD multiple：全部 0/20 → 0/20，没有交接。<br>- 只作观察的 Orbit Menu ↓↓⏎：**20/20 → 0/20**（20 次交接）。<br>与交付树上的结果（[regression-select-keys-burst-delivered](regression-select-keys-burst-delivered/summary.json)）逐行相同，唯一的例外就是这一行。 | 修复前 [fix-select-keys-burst-before-*](fix-select-keys-burst-before-field/summary.json)，修复后 [fix-select-keys-burst-after-*](fix-select-keys-burst-after-field/summary.json)（各 5 段：field、sample、antd、search-multiple、menu），汇总见 [keyboard-window-summary.json](keyboard-window-summary.json) 的 `fix-select-keys-burst-before`/`-after`；整段作业 [checks/fix-select-keys-burst-before-job](checks/fix-select-keys-burst-before-job.json)、[-after-job](checks/fix-select-keys-burst-after-job.json)；被排空终止的第一次运行 [checks/fix-select-keys-burst-before-killed](checks/fix-select-keys-burst-before-killed.json)、[-after-killed](checks/fix-select-keys-burst-after-killed.json) |
| Select 窗口序列（本目录探针的 13 个 select 序列，3 个目标），修复树，按序列分 13 段 | **1480/1480**：Orbit 两个目标的结果与基线数据集逐格相同；旧 AntD `↓ Home ⏎` burst 有 1/20 列表仍开、值不变（见「修复」一节） | [fix-select-after-*](fix-select-after-down/summary.json)（13 段），汇总见 [keyboard-window-summary.json](keyboard-window-summary.json) 的 `dataset:fix-select-after`；整段作业 [checks/fix-select-after-job](checks/fix-select-after-job.json)；被排空终止的单次运行 [checks/fix-select-after-killed](checks/fix-select-after-killed.json) |
| overlays 矩阵 `npm run test:ui-overlays -w @orbit/web`，八环境（overlays fixture 不渲染 Orbit Menu，按任务点名的专项入口照常重跑） | **96/96** | [fix-overlays](fix-overlays/summary.json) |
| P3.2 试点（生产 TaskDetailPanel 的 More 菜单、ShareModal 的 Access 菜单都是 Orbit Menu，另有账号选择器），修复前树与修复树各自生产构建，同时运行，两轮，八环境 | 4×**72/72**。<br>按 P3.2 的 `compare_runs.py`（未改）对照：<br>- 截图：修复前后 256 张中 222 张逐字节相同、22 张抗锯齿级、12 张超出；第二轮 235/19/2。超出的都在同一棵树两次运行之间也超出：修复树自己两轮之间同样是这 12 张，修复前树自己两轮之间是其中 2 张（两个 Chromium 桌面的删除确认）。<br>- 请求：4 组对照里每条 trace 的请求逐步相同。不同的只有动作之后瞬间的焦点、对话框或列表快照，两个方向都有，都不涉及菜单。<br>- 计算样式：0 处不同。<br>修复使主 chunk 增加约 0.39 kB（gzip 0.05 kB） | [fix-pilot-summary.json](fix-pilot-summary.json)；对照 [fix-pilot-compare.json](fix-pilot-compare.json)、[-compare-again](fix-pilot-compare-again.json)、[-noise-before](fix-pilot-noise-before.json)、[-noise-after](fix-pilot-noise-after.json)；运行 [fix-pilot-run-before](fix-pilot-run-before/manifest.json)、[-after](fix-pilot-run-after/manifest.json)、[-before-again](fix-pilot-run-before-again/manifest.json)、[-after-again](fix-pilot-run-after-again/manifest.json)；构建 [checks/fix-pilot-build-before](checks/fix-pilot-build-before.json)、[-after](checks/fix-pilot-build-after.json) |
| choices / overlays / toasts / toasts-tests 四套 fixture 类型检查 | 通过（退出码 0，无输出） | [checks/fixture-types-fix.json](checks/fixture-types-fix.json) |
| 相关单测：P2.2 的单测集合（theme 5、ui boundary 1、ShareModal 10、composer 菜单 6，共 22 个，与前两轮相同），加新的 `Menu.test.tsx`（18），以及使用 Orbit Menu 的任务面板（65 + 4） | **7 个文件 / 109 个测试通过**；boundary 仍确认 Base UI 只在 Orbit 组件内、公共组件不依赖 AntD | [checks/unit-tests-fix.json](checks/unit-tests-fix.json) |
| 项目合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web` | **通过**：构建成功（`tsc -b && vite build`，保留既有的大 chunk 提示），然后 vitest 341 个测试文件 / 4345 个测试全部通过（295.7 秒），含 `Menu.test.tsx` | [checks/merge-check-fix.json](checks/merge-check-fix.json) |

### 交付树 `7709bb72da…`（第二会话）

| 检查 | 结果 | 原件 |
| --- | --- | --- |
| 前一任务的 burst 探针 `p2-select-keys/select-keys-burst.browser.mjs`（文件未改） | **276/276**，与基线树上的结果逐项相同：Orbit Select 已修好的 ↓↓⏎、↓↑⏎、↓⏎（从 null）burst 全部正确，且全部交给列表（字段 3×20、样例 2×20）；旧 AntD、Combobox、MultiSelect 全对；Orbit Menu ↓↓⏎ 仍为 20/20 不执行 | [regression-select-keys-burst-delivered](regression-select-keys-burst-delivered/summary.json)，汇总见 [keyboard-window-summary.json](keyboard-window-summary.json) 的 `regression-select-keys-burst-delivered` |
| choices 原入口（Dialog/旧 Modal 内选择器、逐层 Esc、Tab、主题、IME 合成、外部点击、子菜单 Esc、键盘清除、正常/减少动效下 Dialog→Popover→Select 逐层退出），八环境 | **32/32**，与基线树相同 | [regression-choices-entry-delivered](regression-choices-entry-delivered/summary.json) |
| choices 测试清单 `--list` | 520 个测试 / 4 个文件，从「Listing tests:」起与基线树的 `checks/list-choices.txt` 和 `p2-select-keys/checks/list-choices.txt` 逐字节相同（sha256 `869171286b2f…`）：没有增删或改名 | [checks/list-choices-delivered.txt](checks/list-choices-delivered.txt) |
| 完整 choices 矩阵 `npm run test:ui-choices -w @orbit/web`，第一次 | 517/520，主机负载约 22–38（用时 30.6 分钟）。三个失败都在 `choices-motion.browser.mjs:104`，都是 90 秒超时。chromium-light-phone「normal top … search」页面没有挂载：trace 中 13 个模块请求以 `net::ERR_NETWORK_CHANGED` 中止，发生在点击之前。webkit-light-desktop「normal flipped … search」和 webkit-dark-phone「normal flipped … attachment」没有网络错误，卡在 Orbit 一侧的入场采样（`:70`，经 `:114`）：32 次观察里弹层都已显示、带入场动画名、opacity 1，`document.getAnimations()` 却一直为空，即 200ms 的入场在观察器第一次采样之前已经结束，等待「至少记录到一个 CSSAnimation」永远不成立。P2.2 第 2 版记录过同一现象（WebKit 手机自动翻转的搜索列表，只靠帧观察取不到入场动画），观察器因此另加了 animationstart 监听；这次在高负载下两者都没赶上。这三个用例在基线树的两次完整运行中都通过 | [regression-choices-full-delivered](regression-choices-full-delivered/summary.json)，[trace 归类](regression-choices-full-delivered-traces.json)；Orbit 一侧的观察记录在同目录的 `*--motion-diagnostic.json` |
| 上述三个失败用例，各自在原环境单独重复 10 次（用例、超时、重试未改） | webkit-light-desktop flipped search 10/10，webkit-dark-phone flipped attachment 10/10，chromium-light-phone top search 10/10 | [regression-repeat-motion-flipped-search](regression-repeat-motion-flipped-search/summary.json)、[regression-repeat-motion-flipped-attachment](regression-repeat-motion-flipped-attachment/summary.json)、[regression-repeat-motion-top-search](regression-repeat-motion-top-search/summary.json) |
| 完整 choices 矩阵，第二次 | 517/520，主机负载约 23–52（用时 35.1 分钟），三个失败都不是第一次的失败用例。chromium-dark-desktop「email tags support …」页面没有挂载（`choices.browser.mjs:552` 的主题断言），trace 中 9 个模块请求以 `net::ERR_NETWORK_CHANGED` 中止，发生在用例主体之前；chromium-light-desktop「popover end zoom origin matches」（`choices-motion.browser.mjs:141`）在旧 AntD 一侧等不到样例按钮（90 秒点击超时，全程只有 10 个模块请求，其中 2 个以 `net::ERR_NETWORK_CHANGED` 中止，0 次动效观察）；webkit-light-desktop「normal flipped … attachment」没有网络错误，与第一次的两个 WebKit 失败相同：Orbit 一侧 32 次观察里菜单都已显示、带入场动画名、opacity 1，`document.getAnimations()` 一直为空 | [regression-choices-full-delivered-second](regression-choices-full-delivered-second/summary.json)，[trace 归类](regression-choices-full-delivered-second-traces.json) |
| 第二次的三个失败用例，各自在原环境单独重复 10 次（用例、超时、重试未改） | chromium-dark-desktop email tags 10/10，chromium-light-desktop popover end zoom origin 10/10，webkit-light-desktop flipped attachment 10/10（单次 3.4–32.2 秒，主机负载很高） | [regression-repeat-email-tags-delivered](regression-repeat-email-tags-delivered/summary.json)、[regression-repeat-popover-end-origin](regression-repeat-popover-end-origin/summary.json)、[regression-repeat-motion-flipped-attachment-desktop](regression-repeat-motion-flipped-attachment-desktop/summary.json) |
| overlays 矩阵 `npm run test:ui-overlays -w @orbit/web`（Dialog/Drawer 外观、Tab 循环、Esc/外部关闭与焦点归还、嵌套层、新旧弹层双向共存、异步确认、主题继承、合成中 Esc、动效与滚动恢复），八环境，第一次 | 95/96。唯一失败是 chromium-dark-desktop 的「explicit focus, native form validation, motion and document scroll restore correctly」：页面没有挂载（`overlays.browser.mjs:9` 的主题断言），trace 中 7 个模块请求以 `net::ERR_NETWORK_CHANGED` 中止，发生在用例任何步骤之前。`collect-overlay-evidence.mjs` 拒绝归档有失败的运行、也没有诊断模式，所以这次用 `collect-choice-evidence.mjs --from=src/web/.overlays-results --diagnostic` 归档：文件命名相同，另带 trace | [regression-overlays-delivered](regression-overlays-delivered/summary.json)，[trace 归类](regression-overlays-delivered-traces.json) |
| 上述 overlays 失败用例，在原环境单独重复 10 次（用例、超时、重试未改） | **10/10**（chromium-dark-desktop）；用 `collect-choice-evidence.mjs --from=src/web/.overlays-results` 归档，它给重复的用例编号，overlays 的收集器会互相覆盖 | [regression-repeat-overlays-scroll](regression-repeat-overlays-scroll/summary.json) |
| overlays 矩阵，第二次 | **96/96**，八个环境全部通过 | [regression-overlays-delivered-second](regression-overlays-delivered-second/summary.json) |
| choices / overlays / toasts / toasts-tests 四套 fixture 类型检查 | 通过（退出码 0，无输出） | [checks/fixture-types-delivered.json](checks/fixture-types-delivered.json) |
| 相关单测（`theme.test.tsx`、`boundary.test.ts`、`ShareModal.test.tsx`、`WorkspaceView.composerMenu.test.tsx`，即 P2.2 的单测集合；最后一个文件 P3.1 改过） | 4 个文件 / 22 个测试通过；boundary 确认 Base UI 仍只在 Orbit 组件内、公共组件不依赖 AntD | [checks/unit-tests-delivered.json](checks/unit-tests-delivered.json) |
| 项目合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web` | 通过：构建（`tsc -b && vite build`，4236 个模块，保留既有的大 chunk 提示）后 323 个测试文件 / 4065 个测试全部通过 | [checks/merge-check.json](checks/merge-check.json) |

### 基线树 `1780d071a6…`（第一会话）

第一会话在这棵树上没有跑第三次完整矩阵；它启动的合并检查见「原件与复核」。

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

在这两棵树上，上述已验收行为都由完整矩阵与原入口中未改动的原用例覆盖；Select 已修好的 ↓/↑/Enter 另由前一任务的 burst 探针确定性覆盖。

## 证据边界

- **burst 探针依赖 CDP 的输入队列，只在 Chromium（`chromium-dark-desktop`）上跑**，与前一任务相同。修复在 WebKit 上的窗口行为由两类证据覆盖：
  - **确定性**：冻结帧探针在 webkit-light/dark-desktop/phone 四个环境上，修复前后各跑 9 个序列加 Row actions，用的是可信按键和浏览器自己的 Enter 激活（见上表）。
  - **自然时序**：完整 choices 矩阵里没改动的原用例。
    - Menu 的 ↓⏎ 在「multiple choices in Dialog keep their owner and menus do not activate a clickable row」（`choices.browser.mjs:592`，两键之间不等待；本会话另在 webkit-light-phone 上修复前后各重复 40 次，见上表）。
    - Menu 的 ↓、Enter、方向键子菜单和 Space 在「menu arrows, disabled items, submenu, checkbox and focus return work」（`:198`，每步等待焦点断言，不进入窗口）。
    - Select 的 ↓↓⏎ 在「select supports arrows, Enter, clear…」（`:263`，不等待）。

  Menu 的 ↑ 作为打开键、打开的 Select 上的 Home/End、Space、PageUp/PageDown、字符检索，现有用例在任何浏览器上都没有按过（`choices-lifecycle.browser.mjs:107` 的 PageDown 是所有弹层关闭后滚动页面用的）。这些键在 WebKit 上的旧 AntD 与 Orbit 基线没有建立；冻结帧探针只覆盖 Menu。
- **冻结帧探针替换了页面的 `requestAnimationFrame`**，这是测试手段，不是产品状态。
  - 被截住的帧在最后一个键之后才按原顺序交还浏览器；在此之前，依赖帧的其他工作（Base UI 的入场状态、定位更新）也都推迟了。
  - 它证明的是「焦点移动之前到达的键」这一类输入的结果，不代表真人打字速度或真实负载下的帧间隔。
  - 第一版探针给被截住的帧用负数编号，与 floating-ui `autoUpdate` 取消哨兵 `-1` 的调用冲突，菜单因此退不了场（见「原件与复核」）。改用 2^30 起的编号后，修复后 80/80 通过。
- **单测在 jsdom 里运行**：没有布局，也没有浏览器默认动作，所以 Enter 在 button 上产生 click 由测试按浏览器规则补上；ResizeObserver 是空桩。它锁定的是 Orbit 处理器与 Base UI 交互的逻辑，浏览器里的完整行为由上面两个探针和原用例覆盖。
- **范围。** 修复只覆盖顶层 Menu 触发器上的 ↓/↑/⏎。
  - 子菜单触发器（方向键打开子菜单后、焦点进入子菜单前的那一帧）没有改：P2.2 的用例对它逐步等待焦点，本任务没有为它建立基线。
  - 菜单内越过首尾的方向键之后、焦点移动之前到达的键，仍由旧焦点所在的项处理。这是 Base UI 自身的 `loopFocus` 行为，旧 rc-menu 在菜单内同样下一帧才移动焦点。
  - Space、Tab、Home/End、字符检索在触发器窗口内的处理也没有改。
- **burst 是把按键确定性地放进窗口的手段**，模拟主线程繁忙时排队的输入，不代表真人打字速度。自然时序下落入窗口的频率随负载和优先级变化（修复前：`nice -n -10` 下 0/80，默认优先级下 2/100），本次没有系统统计；`:592` 的重复只说明修复后在这些条件下没有再失败。
- **结论只覆盖上表的序列和起点**，没有穷举所有按键组合、菜单或选择项配置（例如分组、可搜索的 Combobox/MultiSelect 不在本任务内）。
- **没有用真实读屏软件、真机或输入法验证。** 重派发的按键事件 `isTrusted=false`。
- **环境性加载失败。** 前两个会话的 `net::ERR_NETWORK_CHANGED` 页面未挂载如实保留在各自目录，均发生在按键之前，不计入样本，并在 `baseline-rerun`、`baseline-menu-up-rerun` 中补跑。本会话的运行都在独立网络命名空间里，没有出现这类失败。
- **本交付不声称已落地**；合并与落地由协调者和平台完成。

## 原件与复核

- 每次后台作业都用 [record-check.py](record-check.py) 写入 [checks/](checks/)，不覆盖已有文件。记录内容包括命令、作业号、提交、Web 树、退出码和原始输出；退出码取自 runner 的 bg_output。
  - 记录里的提交是归档时的 HEAD，被测内容以其中的 Web 树为准：同一棵 Web 树上，作业运行期间只有本目录在变。
  - 在临时工作树上跑的作业，命令里写明了 `cd` 到哪棵树，提交字段填那棵树的提交。
  - 被 runner 在排空时终止、没有留下报告的那次选择基线也保留在 [checks/baseline-select-killed.json](checks/baseline-select-killed.json)。
  - 第一会话停止前在基线树上启动过一次合并检查，它的退出码那个会话没有读到，后来的会话也读不到（作业属于第一会话），所以没有记录、不计入。
- 浏览器原件用仓库现有的 `src/web/ui-migration/collect-choice-evidence.mjs`（overlays 用 `collect-overlay-evidence.mjs`）归档到新目录，每份附件带 SHA-256。有失败的运行用 `--diagnostic` 归档，trace 和 error-context 都保留，并用 p2.2 第 8 版的 `read-trace.py` 归类到同名的 `*-traces.json`。
- 试点运行用 [collect-pilot.py](collect-pilot.py) 归档：报告原样保留，JSON 附件按 P3.2 的做法打包成 `attachments.tar.gz`；清单记下每张截图的 SHA-256，只复制在某个对照里不逐字节相同的截图。对照用 P3.2 的 `compare_runs.py`（未改），分类由 [summarize-pilot.py](summarize-pilot.py) 写入 [fix-pilot-summary.json](fix-pilot-summary.json)。
- 冻结帧探针的两次开发运行和一次诊断不计入结论，原始输出都保留：
  - [checks/dev-held-frames-1](checks/dev-held-frames-1.json)：初稿，被本会话在 5/20 时终止。菜单项都执行了，但菜单退不了场。
  - [checks/dev-held-frames-diagnostic](checks/dev-held-frames-diagnostic.json)：诊断脚本没有保留，它的后续三次运行查到原因：floating-ui `autoUpdate` 取消哨兵 `-1`，撞上了初稿给 Base UI 帧调度器用的负数编号。
  - [checks/dev-held-frames-2](checks/dev-held-frames-2.json)：改用 2^30 起的编号后，chromium-dark-desktop 与 webkit-light-phone 20/20 通过。

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
| [regression-choices-full-delivered](regression-choices-full-delivered/summary.json)、[-second](regression-choices-full-delivered-second/summary.json) | 交付树 | 完整 choices 矩阵的两次运行 |
| [regression-repeat-motion-flipped-search](regression-repeat-motion-flipped-search/summary.json)、[-flipped-attachment](regression-repeat-motion-flipped-attachment/summary.json)、[-top-search](regression-repeat-motion-top-search/summary.json) | 交付树 | 第一次完整运行失败用例的单独重复 |
| [regression-repeat-email-tags-delivered](regression-repeat-email-tags-delivered/summary.json)、[regression-repeat-popover-end-origin](regression-repeat-popover-end-origin/summary.json)、[regression-repeat-motion-flipped-attachment-desktop](regression-repeat-motion-flipped-attachment-desktop/summary.json) | 交付树 | 第二次完整运行失败用例的单独重复 |
| [regression-overlays-delivered](regression-overlays-delivered/summary.json)、[-second](regression-overlays-delivered-second/summary.json) | 交付树 | overlays 矩阵的两次运行 |
| [regression-repeat-overlays-scroll](regression-repeat-overlays-scroll/summary.json) | 交付树 | overlays 第一次运行失败用例的单独重复 |
| [regression-row-actions-repeat](regression-row-actions-repeat/summary.json) | 交付树 | `:592` 在 chromium-light-phone 上重复 40 次（修复前，39/40） |
| [fix-menu-before](fix-menu-before/summary.json)、[fix-menu-after](fix-menu-after/summary.json) | 修复前树、修复树（同时） | 菜单序列的 burst/paced 对照，各 1320 个测试 |
| [fix-held-frames-before](fix-held-frames-before/summary.json)、[fix-held-frames-after](fix-held-frames-after/summary.json) | 修复前树、修复树（同时） | 冻结帧探针，八环境各 80 个测试；修复前的失败用 `--diagnostic` 归档 |
| [fix-row-actions-before](fix-row-actions-before/summary.json)、[fix-row-actions-after](fix-row-actions-after/summary.json) | 修复前树、修复树（同时） | `:592` 在 chromium-light-phone、webkit-light-phone 上各重复 40 次（`nice -n -10`） |
| [fix-row-actions-100-before](fix-row-actions-100-before/summary.json)、[fix-row-actions-100-after](fix-row-actions-100-after/summary.json) | 修复前树、修复树（同时） | `:592` 在 chromium-light-phone 上重复 100 次（默认优先级）；修复前两次失败的 trace 归类见 [fix-row-actions-100-before-traces.json](fix-row-actions-100-before-traces.json) |
| [fix-select-keys-burst-before-*](fix-select-keys-burst-before-field/summary.json)、[fix-select-keys-burst-after-*](fix-select-keys-burst-after-field/summary.json) | 修复前树、修复树（同时） | 前一任务的 burst 探针，各分 5 段（field、sample、antd、search-multiple、menu） |
| [fix-select-after-*](fix-select-after-down/summary.json) | 修复树 | 13 个 select 序列，每段一个序列 |
| [fix-choices-entry](fix-choices-entry/summary.json) | 修复树 | choices 原入口，八环境 |
| [fix-choices-full](fix-choices-full/summary.json)、[fix-choices-full-second](fix-choices-full-second/summary.json)；[fix-repeat-reopen-exit-before](fix-repeat-reopen-exit-before/summary.json)、[-after](fix-repeat-reopen-exit-after/summary.json)；[fix-repeat-exit-frames-before](fix-repeat-exit-frames-before/summary.json)、[-after](fix-repeat-exit-frames-after/summary.json) | 修复树；失败用例的重复在修复前树与修复树上同时运行 | 完整 choices 矩阵两次（`--diagnostic`，trace 归类在同名 `*-traces.json`），以及两次失败用例的单独重复 |
| [fix-overlays](fix-overlays/summary.json) | 修复树 | overlays 矩阵 |
| [fix-pilot-run-before](fix-pilot-run-before/manifest.json)、[-after](fix-pilot-run-after/manifest.json)、[-before-again](fix-pilot-run-before-again/manifest.json)、[-after-again](fix-pilot-run-after-again/manifest.json) | 修复前树、修复树（两轮，每轮同时） | P3.2 试点的四次运行；对照与分类见 [fix-pilot-summary.json](fix-pilot-summary.json) |

- 复核：
  - `python3 docs/evidence/base-ui-migration/p2-keyboard-window/summarize-keyboard-window.py` 从各目录的原始样本重新生成 [keyboard-window-summary.json](keyboard-window-summary.json)，包括 `fix:menu-before-after` 与冻结帧、前一任务探针的 A/B。
  - `python3 docs/evidence/base-ui-migration/p2-keyboard-window/summarize-pilot.py` 从四份试点对照重新生成 [fix-pilot-summary.json](fix-pilot-summary.json)。
  - [index-artifacts.py](index-artifacts.py) 生成 [artifact-index.json](artifact-index.json)，提交后可用 `python3 docs/evidence/base-ui-migration/p2-keyboard-window/index-artifacts.py --verify <commit>` 从 Git 对象逐个核对。
