# P2 修复：Select 快速连按 ↓↓⏎ 时重选当前值

> **证据瘦身（2026-10-07）**：完整原件见提交 `7732f14f82d4e6b4406d7d164c4b672f63aa0f56`（瘦身前最后一个含完整文件的提交）。取回单个文件用 `git show 7732f14f82d4e6b4406d7d164c4b672f63aa0f56:docs/evidence/base-ui-migration/p2-select-keys/<路径> > <文件>`，整个目录用 `git archive 7732f14f82d4e6b4406d7d164c4b672f63aa0f56 docs/evidence/base-ui-migration/p2-select-keys | tar -x -C <空目录>`。
>
> 本目录在瘦身中：10 份 Playwright 报告换成同目录的 `report.summary.json`，都只删附件正文；删除 5 个 trace 压缩包；2622 个逐用例 JSON（含打包的 attachments.tar.gz）换成所在目录的 `attachments.summary.json`（文件名、字节数、SHA-256 和顶层标量字段）；删除 257 张与本任务目录里保留副本逐字节相同的重复截图。下文链接若指向这些文件，按上面的命令从该提交取回；读取它们的脚本要在取回的目录里运行。
>
> 目录里的 SHA256SUMS 类清单（`*.sha256`、`artifact-index*.json`、`manifest.json`、各运行 `summary.json` 里的附件哈希等）保留原文件，核验的是提交 `7732f14f8` 里的文件。做法、保留理由和逐文件删除清单见 [evidence-slimming](../evidence-slimming/README.md)。

本目录服务于 [P2 修复：Select 快速连按 ↓↓⏎ 时重选当前值](orbit-task:34b4miWykA9R4izIml42v)，处理 [P2.2 第8版](../p2.2/revision-8/README.md)「Select 快速按键诊断」记录的缺口。验收条目 key `1BvO6hYrlFnU60JqxQPUHt`，原文：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。**

本轮由 Claude Opus 5.5 执行。产品代码只改了 Orbit `Select.tsx`；Base UI、Combobox、MultiSelect、Menu、fixture、原用例与断言、超时、重试和历史基线都没有改，也没有推送 main 或项目分支。

## 基线与提交

| 角色 | 提交 | Web 树 |
| --- | --- | --- |
| 分支起点 = 项目分支 tip（合入 `orbit/p2-2-2e616a`，含 `b138357db`；被测 `8a29e3493` 是其祖先） | `8ef6b60d1c18976cfca0c1bd98081bd381703c6e` | `9aa3a0b96d7c1e3fd473995798774d4f20144885`，与第8版最终被测 Web 树相同 |
| 修复（只改 `src/web/src/components/ui/Select.tsx`，+16/−2） | `632b7950ea2c303b7fab6856365ac233f6359f45` | `35301ab31d4cd93761cad55eb7bc2bf1f7a3fa98` |
| 证据（只新增本目录） | 修复之后的下一个提交 | 与修复相同 |

依赖用 `bash scripts/worktree-overlay.sh` 按本树锁文件隔离安装：主工作区的安装与锁文件不兼容，脚本因此执行了独立的 `npm ci`。每次浏览器运行的 globalSetup 都把实际环境与 P0.2 [environment.json](../p0.2/environment.json) 逐字段比较并通过：Chromium 1243 / WebKit 2359、Playwright 1.63.0、字体文件哈希、DPR 1、UTC/en-US。各运行目录保留了当次的 `environment.json`。全部浏览器运行都是单 worker、retries=0。运行期间主机负载约 10–17（24 核），其他会话的进程和容器同时在跑。

## 根因

Base UI 1.8.0（本树锁定版本）的 Select 使用非 virtual 的列表导航：弹层打开后，焦点要到下一动画帧才进入弹层。

- `FloatingFocusManager` 在打开时 `queueMicrotask` 后调用 `enqueueFocus`，后者用 `requestAnimationFrame` 执行（`floating-ui-react/components/FloatingFocusManager.mjs:362,391`，`floating-ui-react/utils/enqueueFocus.mjs:22`）。`useListNavigation` 聚焦高亮项同样排到下一帧，只有 `forceSyncFocus` 时才同步（`floating-ui-react/hooks/useListNavigation.mjs:135-136`）。
- 在这一帧里，列表已经渲染，当前值也已高亮，焦点却仍在 trigger 上，按键由 trigger 的处理器接收：
  - ↓/↑：trigger 的 `onKeyDown` 读到已打开（`useListNavigation.mjs:525`），先把索引置回已选项（`:557`），再进入 `commonOnKeyDown`（`:564`）。此时 `activeElement === trigger`，命中 “Reset the index if no item is focused” 分支（`:363-367`）：↓ 跳到第一项，↑ 跳到最后一项，而不是从当前高亮移动一步。Expires 和样例的当前值 Never 正是第一项，所以高亮停在 Never。
  - ⏎：原生 button 的 Enter 产生 click，`useClick` 因打开事件是 keydown 而按切换处理（`floating-ui-react/hooks/useClick.mjs:58,102-117`）。结果是列表关闭，什么也没选。
- 焦点进入弹层后，同样的键由弹层处理：↓/↑ 从当前高亮移动，⏎ 经选项的 `useButton` 转成 click 并提交（`select/item/SelectItem.mjs` 的 `commitSelection`）。AntD 的焦点始终在输入框上，按键始终作用于当前高亮项。
- CPU 节流复现不了：页面变慢时，Playwright 每次按键的往返也同样变慢。

探针日志与此一致。修复前不节流的 r8 原探针里，Orbit 丢失的 11 个样本全部是「第二个 ↓ 落在 trigger、列表已显示、高亮为 Never」。其中 9 个随后到了下一帧，焦点移到 Never，⏎ 落在 `option:Never` 上重选了它；另 2 个的 ⏎ 也落在 trigger 上，列表直接关闭（[before-repeat](before-repeat/summary.json)）。

**Combobox / MultiSelect 不共用这条路径。** Base UI Combobox 的列表导航是 `virtual: true`（`combobox/root/AriaCombobox.mjs:1041`），焦点始终留在输入框上，高亮通过 `aria-activedescendant` 表示。trigger 分支对 virtual 直接调用 `commonOnKeyDown`（`useListNavigation.mjs:531-532`），而重置分支要求 `!virtual`。下面的 burst 探针也实测确认：两者在窗口内的结果与逐键等待时相同。所以两者都没有改动。

## 改动

`src/web/src/components/ui/Select.tsx`：`BaseSelect.Popup` 加 Orbit 自己的 ref；`BaseSelect.Trigger` 加 Orbit 的 `onKeyDown`。当弹层已打开（`layer.open`）而 ↓/↑/Enter 仍落在 trigger 上时：

1. 调用 `preventDefault()`、`stopPropagation()` 和 Base UI 公开的 `preventBaseUIHandler()`。Base UI 的 `mergeProps` 先执行右侧（使用方）的处理器（`merge-props/mergeProps.mjs:9`，`select/trigger/SelectTrigger.mjs:117`），因此 trigger 的重置/切换逻辑不再运行，这个键也不会再冒泡给祖先。
2. 立即完成本应在下一帧发生的焦点移动：聚焦弹层中当前高亮的选项（Base UI 公开的 `data-highlighted`）；没有高亮项时聚焦弹层本身，与 `FloatingFocusManager` 的默认初始焦点一致。
3. 在该元素上重新派发同一个键（key、code、修饰键），交给 Base UI 弹层和选项自己的处理器。

这样，窗口内的 ↓/↑/Enter 与焦点已在弹层时走同一段 Base UI 代码：禁用项、首尾不循环、滚动到可见、Enter 提交并关闭都相同，Orbit 没有复制任何导航逻辑。焦点已在弹层时 trigger 收不到这些键，原有路径不变。修复没有用延时、重试，不读取 AntD DOM，也没有改用例节奏。重派发的事件 `isTrusted=false`：Base UI 的 keydown 处理不检查它（1.8.0 源码中唯一的 `isTrusted` 判断在 `isVirtualClick`，只用于 click），浏览器对合成事件不执行默认动作，而 Base UI 本来就会阻止这些默认动作。

## 修复前后对照（同一探针、同一环境）

所有探针都在 `chromium-dark-desktop` 上运行，与第8版相同。修复前在 `8ef6b60d1`，修复后在 `632b7950e`。汇总由 [summarize-select-keys.py](summarize-select-keys.py) 生成，见 [select-keys-summary.json](select-keys-summary.json)。

### 第8版原探针，不节流（`select-keys-repeat`，文件未改动）

修复前用 `--repeat-each 5`，修复后用 `--repeat-each 6`；每个样本的操作完全相同。修复后多跑一轮，是为环境性加载失败留余量，保证每个目标仍有至少200个有效样本。

| 目标 | 修复前：丢失/样本 | 修复前：第二个 ↓ 落在 trigger 且列表已显示 | 修复后：丢失/样本 | 修复后：同上（均已交给列表） |
| --- | --- | --- | --- | --- |
| Orbit 字段 Expires | **7/200** | 7 | **0/240** | 0 |
| Orbit 样例 Sample choice | **4/198** | 4 | **0/238** | 1 |
| 旧 AntD 样例 | 0/200 | 127（均正确） | 0/240 | 104（均正确） |

修复前 Orbit 共 11/398 丢失，修复后 0/478；AntD 修复前 0/200，修复后 0/240。修复前丢失的11个样本、且只有这11个，带有上述根因特征。修复后那 1 个落入窗口的样本（`after-repeat/…orbit-sample…sample-25--repeat-4…`），日志依次为：trigger 上的 ↓（33.0ms，列表已显示，高亮 Never）、重派发到 `option:Never` 的 ↓（33.6ms）、落在 `option:7 days` 上的 ⏎，最终值为 7 days。

两次运行各有2个测试没有产生样本：样例页 fixture 没有挂载，trace 显示模块请求以 `net::ERR_NETWORK_CHANGED` 中止（修复前 4/11 个、修复后 18/1 个），发生在任何按键之前。这与第8版在已验收树上记录的主机环境签名相同；原报告、trace 和 error-context 都已保留。

### 第8版原探针，CPU 节流 1×/6×/20×（`select-keys`，文件未改动）

修复前：Orbit 字段在 1× 下丢失 2/5，两次都是 ⏎ 落在 trigger 上；其余 Orbit 0/25，AntD 0/15（[before-throttle](before-throttle/summary.json)）。修复后：Orbit 0/30，其中 1 个 1× 样本落入窗口并已交给列表；AntD 0/15（[after-throttle](after-throttle/summary.json)）。Orbit 在 6×/20× 下修复前后都没有样本落入窗口，与第8版“节流复现不了”的结论一致。

### 确定性 burst 探针（本目录新增）

[select-keys-burst.browser.mjs](select-keys-burst.browser.mjs) 通过一个 CDP 会话依次发出与 Playwright 键盘相同的可信按键事件，中间不等待。第一个 ↓ 打开列表后，渲染期间后续按键在输入队列中排队，于是在焦点移动的那一帧之前到达 trigger，相当于主线程繁忙时的输入。`paced` 每键间隔 300ms，作为焦点已在列表时的参照。日志沿用第8版观察器，另加 `trusted`，并把 menu 也视作列表。每个组合 burst 20 次、paced 3 次。

| 组合 | 期望（焦点已在列表） | 修复前 burst | 修复后 burst | paced（前/后） |
| --- | --- | --- | --- | --- |
| Orbit 字段 ↓↓⏎（从 never） | 7 | 20/20 错（never） | 20/20 对，20 次交接 | 3/3 对 / 3/3 对 |
| Orbit 样例 ↓↓⏎（从 Never） | 7 days | 20/20 错（Never） | 20/20 对，20 次交接 | 3/3 / 3/3 |
| Orbit 字段 ↓↑⏎（从 7） | never | 20/20 错（7） | 20/20 对，20 次交接 | 3/3 / 3/3 |
| Orbit 样例 ↓↑⏎（从 7 days） | Never | 20/20 错（7 days） | 19/19 对，19 次交接 | 3/3 / 3/3 |
| Orbit 字段 ↓⏎（从 null，清除后） | never | 20/20 错（null，列表关闭未选择） | 20/20 对，20 次交接 | 3/3 / 3/3 |
| 旧 AntD 样例 ↓↓⏎ / ↓↑⏎ | 7 days / Never | 0/40 错 | 0/40 错 | 全对 |
| Orbit Combobox ↓↓⏎ / 旧 AntD search | 与 paced 相同 | 0/20、0/20 错 | 0/20、0/20 错，0 次交接 | 全对 |
| Orbit MultiSelect ↓↓⏎ / 旧 AntD multiple | 与 paced 相同（Bug、Ops） | 0/20、0/20 错 | 0/20、0/20 错，0 次交接 | 全对 |
| Orbit Menu ↓↓⏎（仅观察，未改） | image | 20/20 错（none） | 20/20 错（none） | 3/3 对 / 3/3 对 |

修复后 Orbit Select 的 burst 共 99/99 正确，修复前为 0/100。paced 样本在修复前后都正确，也没有发生交接，说明焦点已在列表时原路径没有变化。修复后少的那1个样本同样是 `ERR_NETWORK_CHANGED`：2个模块请求中止，fixture 未挂载，发生在任何按键之前；当时另一会话正在创建容器（`sudo-rollout-pg`、`sudo-rollout-host`）。本目录探针中的5次此类加载失败（修复前2次、修复后3次），以及第8版探针中的1次，都落在 Orbit 样例页上，原因未查明；它们都发生在按键之前，不影响任何已记录样本。

提交前另在未提交、但内容与 `632b7950e` 相同的工作树上跑过一次开发自检：burst 下 Orbit 字段/样例共5个组合各5次，25/25 正确（[dev-burst-check](dev-burst-check/summary.json)）。

## 其他已验收行为（修复后的树 `632b7950e`）

| 检查 | 结果 | 原件 |
| --- | --- | --- |
| 原用例 `choices.browser.mjs:263`「select supports arrows, Enter, clear…」，八环境各重复10次 | **80/80**（每个环境 10/10），断言未改 | [after-original-select](after-original-select/summary.json) |
| choices 原入口（Dialog 内选择器、逐层 Esc/焦点/滚动锁），八环境 | **32/32**，与第8版相同 | [after-choices-entry](after-choices-entry/summary.json) |
| choices 测试清单 `--list` | 520 个测试 / 4 个文件，与第8版 `r8-final-list-choices.txt` 逐字节相同（sha256 `869171286b2f…`） | [checks/list-choices.txt](checks/list-choices.txt) |
| 完整 choices 矩阵 `npm run test:ui-choices -w @orbit/web` | **520/520**，单次运行即全部通过（20.6 分钟），每个环境 65/65；第8版首轮为 515/520 | [after-choices-full](after-choices-full/summary.json) |
| choices / overlays / toasts / toasts-tests 四套 fixture 类型检查 | 通过（退出码 0，无输出） | [checks/fixture-types.json](checks/fixture-types.json) |
| 相关单测（`boundary.test.ts`、`theme.test.tsx`） | 2 个文件 / 6 个测试通过；boundary 确认 Base UI 仍只在 Orbit 组件内、公共组件不依赖 AntD | [checks/unit-tests.json](checks/unit-tests.json) |
| 项目合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web` | 构建通过（`tsc -b && vite build`，保留既有的大 chunk 提示），320 个文件 / 3987 个测试通过，与第8版最终组合相同 | [checks/merge-check.json](checks/merge-check.json)、[日志](checks/merge-check.txt) |

修复没有改任何 CSS、DOM 属性或 Base UI 状态属性，只加了一个 ref 和一个按键处理器。菜单密度、手机附件菜单的 42.4px 行高 / 17px 字号 / 26px 圆角、入场退场动效、搜索/清除/禁用/空值、Dialog 内逐层 Esc、焦点归还、滚动锁和 IME 合成，都由上面的原入口和完整矩阵中的原用例覆盖。Menu、Popover、Tooltip、Combobox、MultiSelect 的源文件与第8版逐字节相同。

## 范围外发现：Menu 有同样的窗口

burst 探针附带观察了 Orbit Menu（「Add attachment」→ Action）：↓↓⏎ 在 burst 下修复前后都是 20/20 没有选中（Action 停在 `none`）；paced 3/3 选中 `image`。日志显示第二个 ↓ 和 ⏎ 都落在菜单按钮上，此时菜单已显示、高亮为 File。Base UI Menu 同样使用非 virtual、可用方向键打开的列表导航（`menu/root/MenuRoot.mjs:363-374`），因此很可能是同一机制。第2.2版 README 记录过 WebKit 手机子菜单的类似时序，当时在用例中加入了逐步焦点断言。本任务按要求只改 Select，Menu 没有改动。旧 AntD Dropdown 的键盘基线与 Select 不同，是否以及如何修复，需要另立任务先确定对照基线。

## 证据边界

- 探针只在 Chromium（`chromium-dark-desktop`）上运行，与第8版相同：r8 探针按设计只跑 Chromium，burst 依赖 CDP。WebKit 和手机项目只由完整矩阵与八环境原用例在自然时序下覆盖，没有在窗口内做确定性验证。
- burst 是把按键确定性地放进窗口的方法，模拟主线程繁忙时排队的输入，不代表真人的打字速度。自然时序下落入窗口的频率随主机负载变化：修复前 11/398，修复后 1/478。修复后自然时序只覆盖了1次交接，窗口内的确定性证据来自 burst 的99个样本。
- 只按任务要求处理 ↓、↑、Enter。窗口内到达的其他键（Home/End、Space、PageUp/PageDown、字符检索）仍由 trigger 处理，行为与修复前相同。
- 重派发的按键事件 `isTrusted=false`。没有用真实读屏软件或真机输入法验证；trigger 是 button，不承载输入法组合。
- 环境性加载失败（`ERR_NETWORK_CHANGED`）共5次，均发生在按键之前，原件保留，没有计入样本。
- 本交付不声称已落地；合并与落地由协调者和平台完成。

## 原件与复核

- 每次后台作业的命令、作业号、提交、Web 树、退出码和原始输出，都用 [record-check.py](record-check.py) 写入 [checks/](checks/)，不覆盖已有文件；退出码取自 runner 的 bg_output。
- 浏览器原件用仓库现有的 `src/web/ui-migration/collect-choice-evidence.mjs` 归档，每份附件带 SHA-256；有失败的运行用 `--diagnostic` 归档，trace 和 error-context 都保留。
- 复核脚本：[summarize-select-keys.py](summarize-select-keys.py) 生成汇总；第8版的 `read-trace.py` 用于归类加载失败；[index-artifacts.py](index-artifacts.py) 生成 [artifact-index.json](artifact-index.json)。提交后可用 `python3 docs/evidence/base-ui-migration/p2-select-keys/index-artifacts.py --verify <commit>` 从 Git 对象逐个核对。
