# WebKit 对话框滚动锁：通知读屏区域的 1px 溢出

任务 [WebKit 对话框滚动锁：通知读屏区域的 1px 溢出让已滚动页面跳回顶部](orbit-task:34cBi0yt6bFcSmbJFgDPj)，属于 [Orbit Web 组件迁移](orbit-project:34ZZeq0e3IR65GVm2kAs7)，服务于验收项 key `1BvO6hYrlFnU60JqxQPUHt`：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。** 起因是 [P4.2](orbit-task:34Za39Feocgj42rrBYwzl) 的同提交对照（[p4.2 README「协调者对差异的判定」第 1 条](../p4.2/README.md#协调者对差异的判定)）。

## 结论

- **根因**（[机制](#机制)）：
  - `lib/toast` 的读屏 live region 挂在 body 末尾，按 `position: absolute` 的静态位置排在视口下缘之外，文档因此比视口高 1px。
  - WebKit 给文档画出全站 8px 的滚动条，Base UI 的 `useScrollLock` 于是换成“内嵌滚动条”那条锁法。它先把 body 写成 `overflow-y: scroll` 并强制排版。
  - WebKit 在这一步丢掉 `.app-view` 的滚动位置（条件是页面里有由内容撑高的 `.re-card` 尺寸容器），之后也不还原。
  - 三环之中只有第一环是本项目的代码。
- **修法**（提交 `9f2f7e9a0`，[修法](#修法)）：
  - `src/web/src/lib/toast.tsx` 创建 live region 时加 `position: fixed`（附注释，共 6 行）。固定定位的盒不计入文档高度，文档在应用框架里始终一个视口高，Base UI 只写 `overflow: hidden`。
  - 没有改浮层组件、Base UI、业务页面或全站 `.sr-only`。
- **常驻用例**（提交 `78cae80d9`，[常驻用例](#常驻用例)）：overlays 入口新增 `overlays-app-frame.browser.mjs`，夹具 `overlays.html?app-frame` 按应用的页面框架搭建。八个环境各 9 个用例：1 个文档高度用例，加 Orbit 与 AntD 的对话框、右侧抽屉、底部抽屉、确认框各 1 个，在出通知前后打开、关闭，检查页面滚动位置。
  - 修复前（`78cae80d9`）：72 个中 16 个失败。8 个是文档高度用例（八个环境都多 1px）；8 个是 WebKit 明、暗桌面的 4 个 Orbit 浮层，出过通知后打开时 1536→0，关闭后仍是 0。
  - 修复后（分支头 `d49a8749b`）：72/72 通过。
  - AntD 的 4 种浮层在修复前后、所有环境都保持位置，修复后 Orbit 与它一致。
- **真实页面**：P4.2 自己的账号池探针。修复前 WebKit 桌面 Replace key 打开时与关闭后都从 72 变成 0；修复后保持 72，打开时 body 只有 `overflow: hidden`。其余环境前后都保持。
- **读屏播报照常**（[读屏播报](#读屏播报)）：live region 仍是 body 末尾的 `.sr-only[aria-live]`，内容、优先级与写入时机不变。以下都通过：
  - Vitest 的 toast 用例（完整 Vitest 在合并检查里全过）；
  - toasts 入口的读屏用例；
  - p0-drift 的读屏副本诊断（announce-duplicate），参照与分支头各 16/16；
  - 本用例里 polite 区域的文字检查。
- **P0**（[P0 的影响](#p0-的影响12-张-webkit-截图9-张需要重登)）：
  - 同提交对照 252 张截图，218 张逐字节相同，22 张是 Chromium 噪声，12 张 WebKit 截图因修法改变。
  - 变化只有两类：文档滚动条（右侧 8px 透明列和 (0,0) 一点）消失；桌面主区宽了 8px，内容右移 4 或 8px。
  - **9 张越过 P0 比较器**，需要协调者确认后按 p0-drift README 重登进已接受层：WebKit 明暗桌面的 settings-saved、profile-validation、notification-error，WebKit 暗色手机的同三张，其中暗色手机 profile-validation 是 P4.1 已接受层的那一张。
  - 另 3 张（WebKit 明色手机同三张，含 P4.1 已接受层的明色那张）变化低于阈值。
  - 标准 P0 在分支头上 92 通过、9 失败、11 跳过，失败正是这 9 张；参照（项目 tip）上 101 通过、11 跳过。
  - 没有改 P0.2 原图、两层登记、比较参数或 known-failures。
- **回归**（[回归](#回归)，全部在分支头 `d49a8749b` 及其参照上）：
  - 项目合并检查通过：构建通过，Vitest 370 个文件、4793 个用例；
  - overlays 168/168；choices 648/648；
  - P4.1 两树各 96/96，P4.2 两树各 180 通过、4 跳过，P3.2 试点两树各 81 通过、7 跳过；同提交对照里 WebKit 的变化都是修法的结果，Chromium 的都在 P0 比较器内；
  - toasts 入口参照 270/272、分支头 269/272，失败的都是两棵树上都会出现的负载计时用例（[toasts 入口](#toasts-入口失败都是已知的负载计时用例参照上同样出现)）；
  - `--check-owners` 0 未归属、0 待定。
- **跟上 main**（[跟上 main](#跟上-main)）：最终轮的基础是项目 tip `15b7b5609` 合并 origin/main `f1837de8e`（协调者的答复）。之后 main 又前进，按协调者决定只做干跑：与交证据时的 origin/main 干跑合并没有冲突，main 新带来的文件与本批 3 个文件不重叠。

## 机制

一共三环，缺一环就不出问题（探针脚本与原始输出在 [probes/](probes)，各探针的跑法见[复跑](#复跑)）：

1. **1px 溢出**：第一次出通知时，`lib/toast.tsx` 的 `announce()` 把读屏 live region（`div.sr-only`）挂到 `<body>` 末尾。`.sr-only` 是 `position: absolute`、1×1，没有 top/left，于是按静态位置排在 `#root` 下面，也就是视口下缘之外 1px。应用框架里 html、body、`#root` 都是一个视口高，页面在 `.app-view` 里滚，所以这 1px 让文档比视口高 1px（桌面 900→901，手机 844→845；八个环境都是，见[常驻用例](#常驻用例)第一个测试）。
2. **WebKit 画出文档滚动条，Base UI 换了一条锁法**：index.css 全站的 `::-webkit-scrollbar { width: 8px }` 让 WebKit 的滚动条占位（不是覆盖式）。文档多出 1px，桌面 WebKit 就给文档画出 8px 滚动条（`innerWidth - clientWidth = 8`）。Base UI 的 `useScrollLock`（`@base-ui/utils` 0.4.0，`useScrollLock.mjs`）据此认定有“内嵌滚动条”（第 22、247 行），改走 `preventScrollInsetScrollbars`（第 72 行）。这条路先调用 `supportsStableScrollbarGutter`（第 30、125 行）测一下能否只靠 `scrollbar-gutter`：它给 html 写 `scrollbar-gutter: stable`、给 body 写 `overflow-y: scroll`，读一次 `offsetWidth`（强制排版），再写 `overflow-y: hidden` 读一次。WebKit 26.6 两次读数不同（1272 对 1280），于是接着改写 body（`position: relative; height: 100dvh; width: calc(100vw - 8px); overflow: hidden`）。没有内嵌滚动条时，Base UI 只给 body 写 `overflow: hidden`。
3. **WebKit 在那次强制排版里丢掉 `.app-view` 的滚动位置**：条件是页面里有尺寸容器（`container-type: inline-size`，应用的 `.re-card` 就是 `container: re-card / inline-size`），且容器高度由多行内容撑开。Providers、账号池、Runners 等页面都由 `.re-card` 组成。位置一旦丢掉，之后的 body 改写和解锁都不会还原它（Base UI 解锁时只还原 html 的 scrollTop）。

真实页面上的证据（P4.2 的账号池页 `/providers/pools/…6002`，WebKit 明色桌面，P4.2 用例的固定数据与生产构建）：

| 探针 | 做法 | 结果 |
| --- | --- | --- |
| [probe-scroll-reset](probes/probe-scroll-reset.browser.mjs)（[输出](probes/reset-wld.jsonl)） | 出过通知后点 Replace key，记录 `.app-view` 的每次滚动、每次 scrollTop 写入与 focus 调用及其调用栈 | Base UI 的 `lock`（调用栈 `lock → eC → l`）写 `body.scrollTop = 0` 时，`.app-view` 已经是 0；之前对话框获得焦点（`preventScroll: true`）时还是 72。没有任何代码写 `.app-view` 的 scrollTop 或调用它的滚动方法 |
| [probe-lock-layouts](probes/probe-lock-layouts.browser.mjs)（[输出](probes/layouts.jsonl)） | 同上，在 `supportsStableScrollbarGutter` 的两次 `offsetWidth` 读取时记录 | 第一次读取（html `scrollbar-gutter: stable`、body `overflow-y: scroll`，body 宽 1272）时已从 72 变成 0 |
| [probe-reduce](probes/probe-reduce.browser.mjs)（[输出](probes/reduce.jsonl)） | 不开对话框，直接执行上面那一步（写两条样式、读一次 `offsetWidth`），每次去掉页面的一样东西 | 原样 72→0；没有 live region（因而也没有滚动条）72→0；去掉侧栏 72→0；卡片 `overflow: visible` 72→0；**卡片改成 `container-type: normal` 后 72 保持** |
| [probe-reduce2](probes/probe-reduce2.browser.mjs)（[输出](probes/reduce2.jsonl)） | 页面末尾加 1000px，从 500 开始，同一步 | 有带内容的卡片时都会跳，这时跳到滚动范围的底部（1071、727、647 等）；两张卡都去掉、都清空、只留一行文字、或固定为 100px 高时都保持 |
| [probe-reset-variants](probes/probe-reset-variants.browser.mjs)（[输出](probes/variants.jsonl)） | 出过通知后点 Replace key；页面内容固定高度（924、1500、1500.55px）或保持原样，滚动在底部或中间 | 原样时在 72（底部）和 36（中间）都变成 0；内容固定高度后都保持 |
| [probe-anchor](probes/probe-anchor.browser.mjs)（[输出](probes/anchor.jsonl)） | 同 reduce，`.app-view` 加 `overflow-anchor: none` | 仍是 72→0，不是滚动锚定 |

`probe-reduce` 不开对话框也不移动焦点，只执行那一步就丢位置；出通知之前打开对话框（同样的焦点移动，Base UI 走另一条路）位置不变。所以丢位置的是那次强制排版，不是焦点。“没有 live region”那一行还说明，live region 的作用只是让 Base UI 去执行那一步。

其余三个现象也由这三环解释：

- **旧 AntD 不出问题**：AntD 的滚动锁（`@rc-component/portal` 的 `useScrollLocker`）注入 `html body { overflow-y: hidden }`，文档溢出时再加 `width: calc(100% - 滚动条宽)`，从不把 body 写成 `overflow-y: scroll`。P4.2 的参照树上出过通知后打开 AntD 对话框，账号池页保持 72（[p4.2 README](../p4.2/README.md#协调者对差异的判定)）；本目录的常驻用例在同一页面框架里也是这样。
- **Chromium 不出问题**：Playwright 的 headless Chromium 不画占位的滚动条，`innerWidth - clientWidth` 始终是 0，Base UI 只写 `overflow: hidden`。1px 溢出在 Chromium 里同样存在（文档 901px），只是看不见。
- **WebKit 手机不出问题**：Linux WebKit 手机模拟出了溢出以后 `documentElement.clientWidth` 仍是 390，不算内嵌滚动条；它的副作用是视觉视口变成 382，之后排版的固定定位元素按 382 排（P2.3-B1、P4.1、P4.2 记录的 382/390）。

## 修法

`src/web/src/lib/toast.tsx`（提交 `9f2f7e9a0`）：创建 live region 时加 `liveRegion.style.position = 'fixed'`，并写明原因。固定定位的盒不计入文档的可滚动范围，挂在 body 末尾也不会让文档变高；它仍是 `.sr-only`（1×1、`clip-path: inset(50%)`），仍在 body 末尾、仍在可访问树里，`aria-live`/`aria-atomic` 与写入方式都不变。

- **为什么是根上去掉溢出**：三环里只有第一环是本项目的代码。去掉它，文档在应用框架里始终一个视口高，Base UI 在所有页面都只写 `overflow: hidden`，第二、三环不再发生；WebKit 手机的 382/390 也随之消失。
- **为什么不改全站 `.sr-only`**：另外两处用它的是正文里的行内 span（`RunSettingsSummary`、`WorkspaceView` 的标签名），它们不在 body 末尾，不造成文档溢出。改全站类会动到它们所在滚动容器的可滚动范围，超出本任务。
- **为什么不在浮层层处理**：可以让 Dialog/Drawer 自己保存和还原 `.app-view` 的滚动位置，或换掉 Base UI 的滚动锁，但那样 1px 溢出和 WebKit 的文档滚动条仍在（桌面上通知之后页面右侧多一条 8px 的滚动条列、内容区窄 8px，手机上固定层按 382 排），还要为测试环境之外的浏览器另做判断。
- **边界**：本修法只去掉 live region 造成的溢出。页面本身让文档溢出时（应用框架和公开页 `.share-page` 都是一个视口高，目前没有这样的页面），Base UI 仍会走内嵌滚动条那条路。

## 常驻用例

提交 `78cae80d9`，overlays 入口（`npm run test:ui-overlays -w @orbit/web`，`overlays.config.mjs` 的 `overlays*.browser.mjs`，八个环境）：

- **夹具**：`overlays.html?app-frame`（[OverlaysFixture.tsx](../../../../src/web/src/components/ui/__fixtures__/OverlaysFixture.tsx) 的 `AppFrame`）。按 main.tsx 的结构（ConfigProvider、AntApp、BrowserRouter，旁边是应用自己的 `ToastViewport`）和 AppShell 的 DocView（`.app-shell > .app-main > .app-view.app-view--doc`）搭页面：html、body、`#root` 一个视口高，页面在 `.app-view` 里滚。页面由两张应用的 `.re-card` 组成，各 40 行文字撑开高度，中间是“Show notice”（经 `lib/toast` 出一条 `toast.success`）、“Clear notifications”和原有的 Orbit/AntD 对照样例：Dialog、右侧 Drawer、底部 Drawer、确认框各一对。夹具只用已有的样例与应用自身的类名、组件，没有新增 AntD 使用点（该文件原已归 P6，`--check-owners` 0 未归属、0 待定）。
- **用例**：[overlays-app-frame.browser.mjs](../../../../src/web/ui-migration/overlays-app-frame.browser.mjs)，每个环境 9 个：
  - `a notice leaves the document one viewport high, with no scrollbar of its own`：出通知前后，文档高等于视口高，`innerWidth - clientWidth` 为 0。
  - 8 个 `<Orbit|AntD> <dialog|right drawer|bottom drawer|confirm> leaves the page where it was scrolled, before and after a notice`：先在没出过通知时、再在出过一次通知（并清掉）之后，把页面滚到让打开按钮离视图顶部 80px 处，点开浮层，等它稳定并锁住滚动，读 `.app-view` 的 scrollTop；点 Cancel 关闭，等滚动锁解除，再读一次。打开时与关闭后都必须等于打开前（`expect.soft`，两处都记录）。每一步的位置、文档高度、文档滚动条宽和 html/body 的内联样式作为附件留下。
- **夹具为什么用 `.re-card`**：最初的版本用固定高度的空白区，修复前在 WebKit 桌面也不失败（64 个滚动用例全过，[probes/](probes) 里 `range2-wld`、`content`、`container`、`recard`、`direct` 是逐步排查的记录：位置在滚动范围里的哪里、内容是否撑高、只加 `container-type`、只加 `.re-card` 类都不复现）。改成由多行内容撑开的 `.re-card` 之后与真实页面一致（[filled](probes/overlays-probe-filled.browser.mjs)：直接执行锁的那一步 900→0，出通知后开 Orbit 对话框 1536→0）。

| 运行 | 提交 | 结果 |
| --- | --- | --- |
| [修复前](runs/app-frame-before.txt) | `78cae80d9`（只有用例，没有修法） | 72 个中 56 通过、16 失败：8 个环境的文档高度用例（桌面 901 对 900、手机 845 对 844；WebKit 桌面另有 8px 文档滚动条）；WebKit 明、暗桌面的 Orbit 对话框、右侧抽屉、底部抽屉、确认框各 1 个（出过通知后打开时 1536→0，关闭后仍是 0）。所有 AntD 用例、所有“出通知之前”的步骤、Chromium 与 WebKit 手机上的 Orbit 用例都通过 |
| [修复后](runs/app-frame-after.txt) | 分支头 `d49a8749b` | 72 个全部通过：出通知后文档仍是 900/844、没有滚动条；WebKit 桌面 Orbit 浮层打开时 body 只有 `overflow: hidden`，打开时与关闭后都是 1536 |

每次运行的精简报告（`*.report.summary.json`）与逐用例记录（[runs/app-frame-before.scroll-records.json](runs/app-frame-before.scroll-records.json)、[runs/app-frame-after.scroll-records.json](runs/app-frame-after.scroll-records.json)，由 [tools/scroll-records.py](tools/scroll-records.py) 从报告附件取出）在 [runs/](runs)。

真实页面上的对照（P4.2 自己的探针 [probe-dialog-scroll](probes/probe-dialog-scroll.browser.mjs) 与 [probe-dialog-gutter](probes/probe-dialog-gutter.browser.mjs)，P4.2 的固定数据与生产构建，八个环境，[输出](probes/p42-probes.jsonl)）：

| 环境 | 树 | 出过通知后：文档高 / 文档滚动条 / 内容左缘 | Codex 账号池：页面位置 → 打开 Replace key → 关闭后 | 打开时 body 的内联样式 |
| --- | --- | --- | --- | --- |
| WebKit 明、暗桌面 | 参照 `15b7b5609` | 901 / 8 / 326 | 72 → **0** → **0** | `position: relative; height: 100dvh; …` |
| | 分支头 `d49a8749b` | 900 / 0 / 330 | 72 → 72 → 72 | `overflow: hidden;` |
| Chromium 明、暗桌面 | 参照 / 分支头 | 901 / 0 / 330，900 / 0 / 330 | 72 → 72 → 72（两树） | `overflow: hidden;`（两树） |
| 四个手机环境 | 参照 / 分支头 | 845 / 0 / 16，844 / 0 / 16 | 712 → 693 → 693（Chromium 714 → 695），两树相同 | `overflow: hidden;`（两树） |

- WebKit 桌面修复后内容左缘一直是 330，与出通知前、与 Chromium 相同；P4.2 记录的旧 AntD 参照在对话框打开时也是 330（它的锁去掉了文档滚动条）。
- 手机上打开 Replace key 时位置从 712 变成 693，两棵树相同，P4.2 的旧 AntD 参照也相同，是页面自身的行为，与滚动锁无关。
- 第 1 轮在 `870e33a1f` 上对参照的同一组探针得到相同结果（`base-870e33a1f` 行）。

## 读屏播报

修法只给 live region 加了一条内联 `position: fixed`。它仍是 `lib/toast` 第一次播报时创建的同一个元素，挂在 body 末尾，`.sr-only` 类、`aria-live`（失败与警告为 assertive，其余 polite）、`aria-atomic` 和“先清空、50ms 后写入”的写法都不变。固定定位不影响可访问树，`.sr-only` 的 `clip-path: inset(50%)` 让它照旧不可见、也不接收指针。

检查（都在分支头 `d49a8749b` 上）：

- **Vitest**：`src/lib/toast.test.tsx` 的“reads the line out after the headline”等用例检查 `.sr-only[aria-live="assertive"]` 的文字。合并检查里的完整 Vitest 通过（见[回归](#回归)）。
- **toasts 入口**：“copyable diagnostics and live announcements survive nested overlays and theme changes”检查 assertive 区域的文字、它不在 `aria-hidden`/`inert` 里，以及 polite 区域的文字。参照与分支头都是八个环境 8/8 通过。
- **读屏副本诊断**：p0-drift 的 [announce-duplicate](../p0-drift/flake/announce-duplicate.browser.mjs)，在 P0 的设置页和资料页上等 live region 写入后检查两点：全页的 `getByText` 仍匹配到读屏副本与通知两处（严格模式违例，与 P0.2 以来的记录相同），限定在 Notifications 区域的定位只匹配可见的通知。参照与分支头各 16/16（[runs/announce-reference.txt](runs/announce-reference.txt)、[runs/announce.txt](runs/announce.txt)）。
- **本任务的用例**：每个出通知的步骤都等 `body > [aria-live="polite"]` 写成“Workspace saved”，八个环境都通过。

没有用读屏软件实测（见[未确立的部分](#未确立的部分)）。

## P0 的影响：12 张 WebKit 截图，9 张需要重登

### 同提交对照

按 [p0-drift README](../p0-drift/README.md)「已接受的迁移差异」第 3 条 (b) 的做法（[same-commit-originals.sh](../p0-drift/tools/same-commit-originals.sh) 的方法，本目录 [tools/p0-originals.sh](tools/p0-originals.sh)）：同一套 P0 原测试与固定数据，以 `--update-snapshots=all` 把截图写进临时目录，各自先做与 `pretest:ui-migration` 相同的构建。

- before：本批起点、项目 tip `15b7b5609`（本批第一个提交 `78cae80d9` 的父提交；分支头的 web 与 shared 相对它只多本批 3 个文件，其中用例与夹具不进生产构建）；after：分支头 `d49a8749b`。
- 两次运行都是 101 通过、11 跳过、252 张截图；两份环境记录逐字节相同，SHA-256 `fe69e824…f9cbdf`，等于 P0.2 的 environment.json（`environment.mjs` 在每次运行前逐字段核对）。
- **before 复现当前期望**：252 张 before 原件在 P0 比较器下与组装出的三层期望全部相符。期望共 88 张 P0.2 原图、150 张 main 漂移参考、14 张已接受差异，来源见 [compare/expected-sources-15b7b5609.json](compare/expected-sources-15b7b5609.json)。其中 215 张逐字节相同。其余 37 张都低于阈值（[compare/p0-expected-vs-reference.json](compare/p0-expected-vs-reference.json)）：11 张是 p0-drift README 记过的 P3.2 那 11 张（深色 task-action-menu 4 张、WebKit 暗色手机任务详情 3 张、WebKit 桌面 breakpoint-599/601-dialog 4 张），其余是 Chromium 噪声。下面 12 张的 before 原件与当前期望**逐字节相同**。
- **before → after**（[compare/p0-reference-vs-fix.json](compare/p0-reference-vs-fix.json)，归类在 [compare/p0-reference-vs-fix.classified.json](compare/p0-reference-vs-fix.classified.json)，[tools/compare.cjs](tools/compare.cjs) 用 P0 的比较参数）：218 张逐字节相同，34 张不同。
  - 22 张 Chromium 各 3–50 个像素、单通道最多差 4，按 p0-drift README「Chromium 渲染噪声」的判定是噪声，全部通过 P0 比较器。
  - **12 张 WebKit 截图是本修法的结果**，9 张越过 P0 比较器。WebKit 重跑逐字节稳定：第 1 轮（`870e33a1f` → `42efe9cc5`）的 12 对原件与本轮逐字节相同。
- **after 对照当前期望**（[compare/p0-expected-vs-fix.json](compare/p0-expected-vs-fix.json)）：越过比较器的正好是这 9 张。逐张的层、哈希与判定在 [compare/p0-changed-webkit.json](compare/p0-changed-webkit.json)。

### 逐张说明

每张的 before、after 与差异图在 [shots/p0/](shots/p0)。差异图把每个不同的像素归类（[tools/p0-shots.py](tools/p0-shots.py)，计数在 [shots/p0/classes.json](shots/p0/classes.json)）：灰 = 文档滚动条（右侧 8px 列，加上 WebKit 随它在 (0,0) 画的一个点）；蓝 = 等于 before 右移 4px；绿 = 等于 before 右移 8px；红 = 都不是。

两件事解释全部 12 张：

1. **文档滚动条没有了**。修复前，这三个场景都在出通知后截图，文档多出 1px，Linux WebKit 的截图里右侧 8px 是没有绘制的透明列（RGBA 0,0,0,0），左上角 (0,0) 多一个灰点（明色 217,217,217，暗色 74,74,77）。修复后两者都没有，右侧 8px 是页面本身。[probe-corner-pixel](probes/probe-corner-pixel.browser.mjs)（[输出](probes/corner.jsonl)）在设置页上证明这两处只取决于文档是否多出 1px：任意一个 1px 的绝对定位盒都会让它们出现，去掉就消失。
2. **桌面的主区宽了 8px**。修复前文档滚动条占去 8px，主区按 1272 排；修复后按 1280 排。居中的内容右移 4px，靠右的内容右移 8px；通知列按视口宽度定位（`ToastViewport` 的固定定位测量节点，1272→1280），右移 8px。左侧导航不变。手机上布局视口始终是 390，内容和通知都不动。

| 截图 | 当前期望所在层 | 不同像素 | 归类（灰 / 蓝 / 绿 / 红） | P0 比较器（after 对当前期望） | 说明 |
| --- | --- | ---: | --- | --- | --- |
| webkit-light-desktop/settings-saved | main 漂移参考 | 63266 | 7201 / 49622 / 6439 / 4 | 14799 像素不符 | 文档滚动条消失；设置卡片列右移 4px；“Setting saved”胶囊右移 8px；红色 4 个是移动与不动的块交界处的抗锯齿边缘 |
| webkit-dark-desktop/settings-saved | main 漂移参考 | 66395 | 7201 / 53609 / 5583 / 2 | 20709 像素不符 | 同上 |
| webkit-light-desktop/profile-validation | main 漂移参考 | 47775 | 7201 / 32906 / 7665 / 3 | 9314 像素不符 | 文档滚动条消失；资料卡片列右移 4px；“Name saved”胶囊右移 8px |
| webkit-dark-desktop/profile-validation | main 漂移参考 | 51674 | 7201 / 37657 / 6813 / 3 | 15662 像素不符 | 同上 |
| webkit-light-desktop/notification-error | main 漂移参考 | 29906 | 7201 / 5193 / 17259 / 253 | 3131 像素不符 | 文档滚动条消失；会话页消息列与输入框宽 8px：错误卡片、靠右的用户气泡和输入框右侧的模型与发送键右移 8px；红色是错误卡片右移后露出的标题文字与卡片阴影边 |
| webkit-dark-desktop/notification-error | main 漂移参考 | 27115 | 7201 / 5023 / 14565 / 326 | 10149 像素不符 | 同上 |
| webkit-dark-phone/settings-saved | main 漂移参考 | 6753 | 6753 / 0 / 0 / 0 | 6726 像素不符 | 只有文档滚动条消失：右侧 8px 由透明变为页面（含 `.app-view` 自己的滚动条），(0,0) 一点 |
| webkit-dark-phone/profile-validation | **已接受层**（P4.1） | 6753 | 6753 / 0 / 0 / 0 | 6728 像素不符 | 同上；P4.1 接受的“Name saved”胶囊位置（x 127，390 宽排版）不变 |
| webkit-dark-phone/notification-error | P0.2 原图 | 6753 | 6753 / 0 / 0 / 0 | 6599 像素不符 | 同上 |
| webkit-light-phone/settings-saved | main 漂移参考 | 6753 | 6753 / 0 / 0 / 0 | 相符 | 同上；明色下透明列按白色比较，变化低于阈值 |
| webkit-light-phone/profile-validation | 已接受层（P4.1） | 6753 | 6753 / 0 / 0 / 0 | 相符 | 同上 |
| webkit-light-phone/notification-error | P0.2 原图 | 6753 | 6753 / 0 / 0 / 0 | 相符 | 同上 |

- **P4.1 已接受层的两张**（WebKit 明暗手机 profile-validation）：胶囊位置、文字与卡片都不变，只差文档滚动条那 8px 列与一个点。暗色一张越过比较器，需要重登；明色一张低于阈值，仍对当前期望通过。
- **P2.3-B1 相关的截图**（成功提示胶囊：settings-saved、profile-validation，P0 期望里 profile-validation 的 main 漂移参考按 B1 修法生成）：手机上胶囊位置与宽度都不变（WebKit 手机的通知列本来就按 390 排，修复后不再有 382 的可能）；桌面上胶囊随通知列右移 8px，与 Chromium 桌面一致。
- **WebKit 手机其余截图**：除上面 6 张外逐字节相同（没有出过通知的场景，文档本来就不多 1px）。

### 重登

越过比较器的 9 张不能靠放宽比较或改期望通过，要按 p0-drift README「已接受的迁移差异」的规则重登：协调者对本证据 CONFIRM 后，由本任务的后续提交或协调者另建的登记任务，用 [register-accepted.cjs](../p0-drift/tools/register-accepted.cjs) 以本节的同提交原件写入（before `15b7b5609`，after `d49a8749b`；完整原件留在 `/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/p0/f2-*`，判定前不清理；本目录 shots/p0 里的 before/after 是这 12 张的逐字节副本。登记时 after 应取本批落地后的项目线提交，按 p0-drift README 第 3 条重跑同提交对照）。其中 webkit-dark-phone/profile-validation 已有 P4.1 的接受条目，重登时旧条目移入 `previous`。低于阈值的 3 张不登记（登记工具不收），仍对当前期望通过。本任务没有改 P0.2 原图、main 漂移参考、已接受层、比较参数或 known-failures。

## 回归

全部在最终轮：分支头 `d49a8749b`（交付），参照为项目 tip `15b7b5609`（本批起点；web 与 shared 相对分支头只差本批 3 个文件），常驻用例的修复前一侧在 `78cae80d9`。各入口都在 P0.2 的浏览器与字体环境里（`environment.mjs` 每次核对），每次运行放在独立网络命名空间。overlays、choices 与合并检查跑在同一提交的另一棵 NVMe 工作树里，toasts 的复跑跑在两棵 NVMe 工作树里，其余在会话工作树（分支头）和 `/mnt/data` 上的参照树里。

| 检查 | 树 | 结果 | 记录 |
| --- | --- | --- | --- |
| 项目合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web` | 分支头 | 退出码 0：构建通过（含 `tsc -b`）；Vitest 370 个文件、4793 个用例全部通过 | [runs/merge-check.txt](runs/merge-check.txt) |
| 常驻用例 `overlays-app-frame.browser.mjs` | `78cae80d9` / 分支头 | 56 通过、16 失败 / 72 通过 | [runs/app-frame-before.txt](runs/app-frame-before.txt)、[runs/app-frame-after.txt](runs/app-frame-after.txt) |
| overlays 入口（含新用例） | 分支头 | 168 通过 | [runs/overlays.txt](runs/overlays.txt) |
| choices 入口 | 分支头 | 648 通过 | [runs/choices.txt](runs/choices.txt) |
| toasts 入口 | 参照 / 分支头（同时跑） | 270 通过、2 失败 / 269 通过、3 失败，见下 | [runs/toasts-reference.txt](runs/toasts-reference.txt)、[runs/toasts.txt](runs/toasts.txt) |
| 标准 P0 `npm run test:ui-migration -w @orbit/web` | 参照 / 分支头 | 101 通过、11 跳过 / 92 通过、9 失败、11 跳过（失败即[P0 的影响](#p0-的影响12-张-webkit-截图9-张需要重登)那 9 张，actual 与同提交原件逐字节相同） | [runs/p0-standard-reference.txt](runs/p0-standard-reference.txt)、[runs/p0-standard.txt](runs/p0-standard.txt) |
| P0 同提交原件 | 参照 / 分支头 | 各 101 通过、11 跳过、252 张 | [runs/p0-originals-reference.txt](runs/p0-originals-reference.txt)、[runs/p0-originals.txt](runs/p0-originals.txt) |
| P4.2 同提交对照 | 参照 / 分支头 | 各 180 通过、4 跳过、644 张，见下 | [runs/p42-reference.txt](runs/p42-reference.txt)、[runs/p42.txt](runs/p42.txt) |
| P4.1 同提交对照 | 参照 / 分支头 | 各 96 通过、272 张，见下 | [runs/p41-reference.txt](runs/p41-reference.txt)、[runs/p41.txt](runs/p41.txt) |
| P3.2 试点同提交对照 | 参照 / 分支头 | 各 81 通过、7 跳过、256 张，见下 | [runs/pilot-reference.txt](runs/pilot-reference.txt)、[runs/pilot.txt](runs/pilot.txt) |
| P4.2 真实页面探针 | 参照 / 分支头 | 各 8+8 个运行全部完成，结果见[常驻用例](#常驻用例)末尾 | [probes/p42-probes.jsonl](probes/p42-probes.jsonl) |
| 读屏副本诊断（p0-drift announce-duplicate） | 参照 / 分支头 | 16/16 / 16/16 | [runs/announce-reference.txt](runs/announce-reference.txt)、[runs/announce.txt](runs/announce.txt) |
| `audit-antd.mjs --check-owners` | 分支头 | 0 未归属、0 待定，归属计数与开工时相同 | [runs/check-owners.json](runs/check-owners.json) |

### 同提交对照：P4.2、P4.1、P3.2 试点

两棵树各自构建后跑同一组用例，截图写进临时目录，按 P0 的比较参数逐张比（[compare/](compare)：`*-reference-vs-fix.json` 与 `.classified.json`，汇总 [compare/entries-summary.json](compare/entries-summary.json)）。WebKit 的归类与 P0 一节相同（文档滚动条 / 右移 4px / 右移 8px / 其它）。

| 入口 | 截图 | 逐字节相同 | 不同 | 越过 P0 比较器 |
| --- | ---: | ---: | --- | ---: |
| P4.2 | 644 | 597 | 47 = WebKit 20 + Chromium 27 | 18（全是 WebKit） |
| P4.1 | 272 | 238 | 34 = WebKit 16 + Chromium 18 | 12（全是 WebKit） |
| 试点 | 256 | 224 | 32 = Chromium 32 | 0 |

**WebKit 的变化都是修法的结果，都出在出过通知之后的截图里：**

- **P4.2 账号池**：
  - `p42-pool-replace-key`、`p42-pool-signout`（明暗桌面）：修复前，页面已被对话框或之前的对话框滚回顶部；修复后页面停在原处，确认浮层贴着它的按钮。这就是本任务修的现象，P4.2 记为“对话框滚动锁”的 6 张里的 4 张。
  - `p42-pool-add-account`（明暗桌面，那 6 张里的另 2 张）：这一页本来在顶部，只差文档滚动条与 8px 主区宽。
  - 示例见 [shots/p42/](shots/p42)。
- **P4.2 用户页**：
  - `p42-users-delete`、`p42-users-disabled`（明暗桌面）：同一用例前面的操作出过通知，修复前表格按窄 8px 排，行操作按钮换行不同；修复后表格按原宽排。
  - `p42-pool-delete`（明暗桌面）：文档滚动条与右移 4px。
- **P4.2 手机**：
  - `p42-pool-signout`、`p42-users-delete`：确认浮层右缘从 382 回到 390。这是 P4.2 记为“WebKit 手机 382/390”的 4 张，旧 AntD 浮层也画到 390。
  - `p42-pool-delete`、`p42-users-disabled`：只差文档滚动条。
- **P4.1**：`p41-settings-saving`、`p41-settings-theme`、`p41-profile-reset`、`p41-cli-denied`（明暗桌面）是文档滚动条加右移 4/8px，四个手机环境只差文档滚动条。

**Chromium 的不同都在 P0 比较器内：**

- 65 张按 p0-drift 的判定是噪声；另有 P4.2 记过的加载点静止帧与边缘栅格化 4 张（7–63 个像素）。
- `p41-profile-photo`（明暗桌面，37–66 个像素）：两次参照运行之间也有同样位置的不同（第 1 轮 `870e33a1f` 对本轮 `15b7b5609`，[compare/reruns.json](compare/reruns.json)），是运行间的差异。
- 试点 `pilot-share-loading`、`pilot-share-error`（明色桌面，整块对话框各 3.75 万个像素、最多差 2 级）：这个流程里没有出过通知，修法碰不到。分支头第二次运行与参照逐字节相同（[runs/pilot-share-again.txt](runs/pilot-share-again.txt)），是这一次运行带着的整块偏差。
- P4.2 `p42-pool-add-account`、`p42-pool-replace-key`（明暗桌面，出过通知之后打开的对话框，2.1–4.7 万个像素、最多差 1–3 级，在阴影与边缘一圈）：
  - 两次参照运行逐字节相同，分支头两次运行也逐字节相同（[runs/p42-pools-again.txt](runs/p42-pools-again.txt)），差异稳定来自修法。
  - 内容与位置相同，通过比较器。
  - 推断（没有读 Chromium 源码）：修复前文档可滚动 1px，对话框所在的固定定位层合成方式不同。

示例：[shots/p42/chromium-light-desktop-pool-add-account-diff-x60.png](shots/p42/chromium-light-desktop-pool-add-account-diff-x60.png)（差异放大 60 倍）。

### toasts 入口：失败都是已知的负载计时用例，参照上同样出现

完整矩阵（272 个用例，两棵树同时跑，主机 1 分钟负载 38–51）：参照 270 通过、2 失败；分支头 269 通过、3 失败。

| 用例族 | 参照 | 分支头 | 断言 |
| --- | --- | --- | --- |
| notification pixels stay intact through \<弹层\> opening and closing | 1（Dialog，WebKit 暗色手机） | 1（Bottom drawer，WebKit 明色桌面） | 点开或按 Esc 后两帧，弹层的入场/退场动画必须还在跑（`the real popup animation must exist`），读到 0 |
| exit keeps its own native progress through modal transfers with reduce motion | 1（WebKit 暗色手机） | 1（WebKit 明色桌面） | 退场进度的帧数要多于 3，读到 3 |
| entrance progress survives a modal transfer before its first 180ms completes | 0 | 1（WebKit 暗色手机） | 入场 180ms 内的进度 |

这三族都靠帧与原生计时：负载高时动画或计时会在读数之前走完。为了把它们和回归分开，两棵 NVMe 工作树同时只跑前两族（WebKit 明、暗桌面）：

| 轮次 | 用例 × 次数（每棵树） | 参照 `15b7b5609` 失败 | 分支头 `d49a8749b` 失败 |
| --- | --- | --- | --- |
| A/B 1 | 两族 6 个 × 2 × 5 = 60 | exit 2/20，像素 0/40 | exit 4/20，像素 1/40 |
| A/B 2 | 像素 4 个 × 2 × 10 = 80 | 1/80 | 0/80 |
| A/B 3 | exit 2 个 × 2 × 10 = 40 | 3/40 | 7/40 |
| A/B 4 | exit 2 个 × 2 × 25 = 100 | 0/100 | 2/100 |
| 合计 | | exit 5/160，像素 1/120 | exit 13/160，像素 1/120 |

- 像素用例两棵树一样。
- exit 用例在两棵树之间分支头失败得多一些（13/160 对 5/160）。失败的几乎都是同一处断言：退场的通知在 250ms 内没有换到嵌套对话框的图层（`owner` 只有一个），即嵌套对话框在退场结束之后才打开；参照上的失败也是这一处。逐帧记录（[tools/exit-transfer.py](tools/exit-transfer.py)）里，换层发生在 Dismiss 后的中位数参照 157ms、分支头 167ms，各轮有高有低（完整矩阵一轮分支头更快）。
- 为了只看 live region 的定位本身，在同一棵树、同一个开发服务器上把这个用例原样复制成探针，出过通知后把 live region 设成绝对定位（修复前）或固定定位（修复后），两种交替运行（WebKit 明、暗桌面，2 种动效 × 20 次，各 80 次；[probes/toasts-probe-exit-position.browser.mjs](probes/toasts-probe-exit-position.browser.mjs)，汇总 [probes/exit-position.summary.json](probes/exit-position.summary.json)）：绝对定位失败 2/80（都是没换层），固定定位 0/80；换层时间中位数两种都是 132.5ms（p90 162 对 172ms）。定位本身不让这个用例更容易失败，上表两棵树之间的差别来自运行与工作树，不来自修法。

修法在这个入口里也不改变布局。toasts 夹具的页面本来就比视口高（`minHeight: 150vh`），WebKit 桌面一直有文档滚动条，live region 绝对定位还是固定定位都不改变文档高度，也不改变通知列的位置。

## 跟上 main

- **开工**：项目 tip `a2e58b0ce` 已在 origin/main 里，按作业指导直接跟到 origin/main `870e33a1f`（快进）。
- **第 2 轮**：交证据前 origin/main 前进到 `e6238f318`，rebase 上去后发现 main 自身的 `tsc -b` 不通过，已报告协调者（[过程记录](#过程记录)）。
- **最终轮**：
  - 协调者答复：修复已在项目线，项目 tip `15b7b5609` 不在 main 里。
  - 按规则先 rebase 到项目 tip，再合并 origin/main `f1837de8e`，得到分支头 `d49a8749b`。
  - 本文的最终检查与同提交对照都以它为准，`--check-owners` 在它上面是 0 未归属、0 待定。
- **之后 main 又前进**：按协调者的决定（P4.2 的先例）不再 rebase、不重跑，只做干跑（[tools/main-dryrun.sh](tools/main-dryrun.sh)，输出 [runs/main-dryrun.txt](runs/main-dryrun.txt)）：
  - 交证据时 origin/main 为 `5b794d643`，它已包含此时的项目 tip `797bf06d1`。`git merge-tree --write-tree d49a8749b origin/main` 退出码 0（无冲突），合并树 `d02befbaf`；对项目 tip 干跑得到同一棵树。
  - 合并带进来的文件中，Web 与 shared 下只有两组：
    - main 的 start card：`ProjectDependencyGraph.tsx`（及测试）、`StartPlanGraph.tsx`、`StartProjectCard.tsx`（及测试）、`lib/projectStart.ts`，以及 `index.css` 里 `.start-card` 的几条规则；
    - 项目线新落地的子菜单几何修正：`ui/Menu.tsx`、`ui/Floating.ts`、`ui/Floating.css`、`ChoicesFixture.tsx`、`choices-first-frame.browser.mjs`、`choices-submenu-geometry.browser.mjs`。
  - 其余是 Android 与 macOS 的改动、docs/mocks 与证据文件。
  - 本批 3 个文件（`src/web/src/lib/toast.tsx`、`src/web/src/components/ui/__fixtures__/OverlaysFixture.tsx`、`src/web/ui-migration/overlays-app-frame.browser.mjs`）不在其中，合并树里这 3 个文件与分支头相同。
  - 这两组都不碰 html/body、`.sr-only`、滚动条、通知、Dialog/Drawer/ConfirmDialog 或滚动锁；子菜单修正只改菜单浮层的定位。本文的 choices 648/648 是在不含它的分支头上跑的，落地时的合并检查会在合并后的树上再跑一遍。
- **与 P4.3b 的修正 `a0b33edff`**：协调者提醒它也改 `OverlaysFixture.tsx` 与 `overlays.browser.mjs`。它还没进项目线；本分支与它干跑合并（`git merge-tree`）没有冲突。按协调者的安排，谁后落地谁合并两边的夹具用例，并在合并后的树上重跑 overlays 与 overlays-app-frame 两套。

## 未确立的部分

- **只在 Linux 的 Playwright 模拟里测过**（Chromium 1243、WebKit 2359/26.6，P0.2 的字体与环境）。没有在 macOS Safari、Windows 上的 Chrome 或真机上测。推断（未测）：凡是 `::-webkit-scrollbar` 让滚动条占位的浏览器，修复前出过通知后都会多一条文档滚动条；Base UI 是否走内嵌滚动条那条路、浏览器是否在那一步丢掉位置，要看各自的实现。
- **WebKit 在那次强制排版里丢掉滚动位置的引擎内部原因没有查到**：探针只确定了触发条件（尺寸容器由内容撑高，内嵌滚动条下 body 的 `overflow-y` 改成 `scroll` 并强制排版），没有读 WebKit 源码，也没有向 WebKit 报告。本修法让应用不再触发 Base UI 的那条路，不依赖 WebKit 修复。
- **Chromium 对话框阴影 1–3 级的差异**（P4.2 两个对话框，明暗桌面 4 张，通过比较器）确定来自修法，但“合成方式不同”只是推断，没有用 Chromium 的图层工具核实。
- **读屏只按可访问树检查**：live region 的属性、内容和写入时机由 Vitest、toasts 入口和 P0 的读屏副本诊断检查，没有用 VoiceOver、NVDA 等读屏软件实测。
- **toasts 入口不是全绿**：两棵树各有 2–3 个负载计时用例失败（[toasts 入口](#toasts-入口失败都是已知的负载计时用例参照上同样出现)）。同族用例在参照上同样失败；只改 live region 定位的探针里，固定定位 0/80、绝对定位 2/80。这说明修法没有让它们更容易失败，但这几族用例在高负载主机上本身不稳定。
- **文档本身滚动的页面不在本修法范围**：应用框架与公开页都是一个视口高（见[修法](#修法)边界），本任务没有找到文档本身滚动、又会打开 Orbit 浮层的页面；如果以后有，Base UI 仍会走内嵌滚动条那条路。
- **P0 的 9 张截图尚未重登**：要等协调者对本证据的判定（见[重登](#重登)）。在那之前，标准 P0 在本分支上是 92 通过、9 失败、11 跳过，失败正是这 9 张。
- **最终轮之后 main 的改动没有重跑**：按协调者的决定只做了干跑（见[跟上 main](#跟上-main)），合并后的检查由落地时的合并检查覆盖。

## 过程记录

由 Claude Opus 5.5 执行（会话 `1leTbzfgo250CLBsIDMSmr`）。上一次运行 `212cSMhpGdmzyC2cKI3OLy` 只读完了资料，工作树里没有留下改动。没有推送 main 或项目分支，没有部署或发布。

| 轮次 | 基础 | 提交（用例 / 修法） | 内容 |
| --- | --- | --- | --- |
| 第 1 轮 | origin/main `870e33a1f` | `dd22fa1a4` / `42efe9cc5` | 查清机制（[probes/](probes)），定修法。用例修复前 16 失败、修复后 72/72。P0 同提交对照：12 张 WebKit 截图变化、9 张越过比较器，与最终轮逐字节相同。标准 P0 92/9/11。原始运行在 [process/round1/](process/round1) |
| 第 2 轮 | origin/main `e6238f318` | `a4c06a8b6` / `f5b731070` | 用例修复前 16 失败、修复后 72/72（[process/round2/](process/round2)）。合并检查在构建一步失败：origin/main 自身的 `tsc -b` 不通过（`RunnerEngines.tsx` 的 `Quota.noLimit`，main 提交 `f6f385d2e`，[日志](process/round2/merge-check-main-break.txt)）。已报告协调者（任务评论 `34cd60Tpp6THKyJQ959EK`），协调者答复修复 `74fc42d4f` 已在项目线 |
| 最终轮 | 项目 tip `15b7b5609`，再合并 origin/main `f1837de8e` | `78cae80d9` / `9f2f7e9a0`，分支头 `d49a8749b` | 本文的全部最终检查 |

- 最初的夹具用固定高度的空白区。修复前在 WebKit 桌面也不失败（[process/round1/app-frame-fixed-spacers.txt](process/round1/app-frame-fixed-spacers.txt)：只有 8 个文档高度用例失败），于是转到真实页面上找触发条件（见[机制](#机制)）。
- 第 2 轮的 toasts、P0 与同提交对照在发现 main 的构建问题后停掉，没有结果。
- 最终轮中途会话引擎重启，3 个后台队列被停掉（`drain_cap`），处理如下：
  - 留在参照树里的两个探针文件、半截的运行目录都移到 `/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/trash/`；
  - 被打断的步骤（分支头的 P4.1、choices、参照的 gutter 探针）完整重跑；
  - 改用按完成标记续跑的脚本（[tools/queue3-mine.sh](tools/queue3-mine.sh)、[tools/queue3-base.sh](tools/queue3-base.sh)、[tools/step.sh](tools/step.sh)）。
- 完整原始运行留在 `/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/`，判定后清理。

## 提交

| 提交 | 内容 |
| --- | --- |
| `78cae80d9` test(web) | `OverlaysFixture.tsx` 的 `?app-frame` 模式（`AppFrame`、`PageCard`）；`ui-migration/overlays-app-frame.browser.mjs` |
| `9f2f7e9a0` fix(web) | `lib/toast.tsx`：live region `position: fixed` 及注释 |
| `d49a8749b` merge | 合并 origin/main `f1837de8e`（只有 apiserver 与 runner 的改动） |
| 本目录所在提交 docs(evidence) | 本 README、[runs/](runs)、[compare/](compare)、[shots/](shots)、[probes/](probes)、[process/](process)、[tools/](tools) |

## 复跑

在仓库根目录、P0.2 的浏览器与字体环境里（[p0.2 README](../p0.2/README.md#环境与复跑)）：

```sh
NO_COLOR=1 npm run test:ui-overlays -w @orbit/web -- overlays-app-frame.browser.mjs   # 常驻用例
NO_COLOR=1 npm run test:ui-overlays -w @orbit/web                                     # overlays 入口
NO_COLOR=1 npm run test:ui-toasts -w @orbit/web
NO_COLOR=1 npm run test:ui-choices -w @orbit/web
NO_COLOR=1 npm run test:ui-migration -w @orbit/web                                    # 标准 P0
npm run build -w @orbit/web && npm run test -w @orbit/web                             # 项目合并检查
```

本任务的运行都用 [tools/](tools) 里的脚本包一层：独立网络命名空间（`unshare -n`，固定端口不冲突），运行原件写到 `/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/`。

- `run-entry.sh`：开发服务器入口；
- `p0-standard.sh`：标准 P0 原命令；
- `p0-originals.sh`：P0 同提交原件，P3.1 的方法；
- `entry-shots.sh`：P4.1/P4.2/试点同提交截图；
- `run-probe.sh`、`run-dev-probe.sh`：探针；
- `queue*.sh`：最终轮在分支头与参照树上的顺序；
- `compare.cjs`、`p0-shots.py`、`classify.py`：比较与归类；
- `scroll-records.py`、`exit-samples.py`、`exit-transfer.py`：从报告附件取出逐用例记录；
- `main-dryrun.sh`：与最新 origin/main 的干跑；
- `collect.sh`：把引用的文件收进本目录。
