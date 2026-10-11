# MultiSelect 视口下缘：chip 换行收起不触发 ResizeObserver 循环（WebKit 手机）

任务 [34dcr9bZPPrl6TDzvXowg](orbit-task:34dcr9bZPPrl6TDzvXowg)，交付 `62ab70582`（父 `743d21ab2` = 项目 tip 合入 `origin/main` 后）。

P6 的补偿控制把这条红记录为「既存问题、因样例位置暴露」（[p6/README.md](../p6/README.md) 第 163–172 行）：`choices.browser.mjs` 的「multiple labels search, toggle, collapse, remove and clear without losing the remaining values」在 webkit-light-phone 与 webkit-dark-phone 上总是失败，红在 afterEach 的页面错误检查——

```
Error: expect(received).toEqual(expected) // deep equality
- Array []
+ Array [ "ResizeObserver loop completed with undelivered notifications." ]
  at ui-migration/choices.browser.mjs:12:63  (test.afterEach)
```

断言全部通过，只有这条页面错误。本任务修 Orbit MultiSelect，使该用例在两个 WebKit 手机环境转绿；用例、样例与断言都没有改，没有补占位。

## 机制：谁在观察谁，为什么只有靠近视口下缘才触发

观察者（P6 的逐步探针之外，再加一层把每个 ResizeObserver 编号、记录构造/observe/unobserve/disconnect 与回调的探针，[scripts/ro-mechanism-probe.mjs](scripts/ro-mechanism-probe.mjs)，输出 [runs/mechanism/](runs/mechanism/)）：

1. **Floating UI 的 `autoUpdate`**（Base UI `useAnchorPositioning` → `whileElementsMounted`）在列表打开时建一个 ResizeObserver，观察**字段**（`div.orbit-select.orbit-multi`，depth 8）和 **positioner**（`div.orbit-floating-positioner.orbit-choice-positioner`，depth 4）。回调里：positioner 被收到过一条 entry 就 unobserve 它、下一帧再 observe（防 `size()` 中间件回环），然后 `update()`。`update()` 是 Floating UI 的 `computePosition(...).then(...)`，数据不同就 `ReactDOM.flushSync` 提交——**同步布局**。
2. **Base UI 的 `size()` 中间件**在每次 placement 里给 positioner 写 `--available-width/height`、`--anchor-width/height`（`floating.style.setProperty`）。
3. **Base UI 的 lazyFlip**（`useAnchorPositioning`，Combobox 的 positioner 传 `lazyFlip: true`）：`layoutEffect` 里若 `renderedSide !== side` 就 `setMountSide(renderedSide)`——把这次翻转「钉住」。

逐步序列（修复前的日志，`tap Ops` 一步，frame 25–27，`runs/mechanism/before-light.json`）：

| t (ms) | frame | 事件 |
| --- | --- | --- |
| 648 | 25 | 观察者 1 回调：`div.orbit-select.orbit-multi` 188×**40**（第三个 chip `Ops` 换行；上一步还是 188×20）。回调里 unobserve positioner → **flushSync 提交** |
| 648 | 25 | 这次提交把列表换到上方：positioner 的 `data-side` 在 648 的记录里还是 `bottom`、653 已是 `top`；列表在 `tap Ops` 前位于下方（y 690–826）、之后在上方（y 522–658，探针的 `boxes`）。Base UI `size()` 写 CSS 变量 + lazyFlip 的 `setMountSide('top')` |
| 653 | 25 | `disconnect` 观察者 1，**新建观察者 2**（`by: autoUpdate < react_stack_bottom_frame`，`side:'top'`）并 `observe(字段, depth 8)`、`observe(positioner, depth 4)`——都在**同一个帧、同一个 resize-observation 步内** |
| 655 | 25 | `error`：`ResizeObserver loop completed with undelivered notifications.` |
| 670 | 26 | 观察者 2 的回调才收到 entry（`字段 188×40`、`positioner 200×136`） |

为什么第 653 步会重启动跟踪（读依赖源码得出的读法，并见下面的实测）：Floating UI 的 `useFloating` 里 `update` 由 `useCallback(..., [latestMiddleware, placement, strategy, platformRef, openRef])` 而来，而 `latestMiddleware` 是 `useState`，只有 `deepEqual(latestMiddleware, middleware)` 为真时才保持恒等。Base UI 的 `useAnchorPositioning` 每次渲染都新建 `middleware` 数组，里面的 `offset(state => …)`、`size({...})` 等是**新的函数实例**，`deepEqual` 对函数用 `Object.is`，于是每次渲染都 `setLatestMiddleware` → `update` 换新 → 依赖它的 `autoUpdate` layout effect 清理并重跑 → `disconnect` 旧 observer、新建并 observe 字段与 positioner。648 那一步的 RO 回调里 `update()` 同步提交（`flushSync`），这次提交（`setData` 与/或 lazyFlip 的 `setMountSide`）带来的渲染就发生在**观察步内**。

为什么 WebKit 报「undelivered notifications」：ResizeObserver 的通知按**深度**顺序派发（规范如此；本任务没有从 WebKit 源码核实这条错误在这台浏览器里的精确条件，只核实了下面这个序列），而在同一个步内新加进来、不比刚上报的元素更深的观察者，其由这次 resize 触发的通知不会被递送。步骤 653 新观察的字段（depth 8）与 positioner（depth 4）都不比刚上报的字段（depth 8）更深，两者都被跳过；浏览器于是顺带抛出这条 error（WebKit 把它交给 `window.onerror`；Chromium 只 console.warn，所以 Chromium 不红）。观察者日志里这条错误的时刻（653 observe → 655 error，同一帧、同一个回调之后）与这条读法一致。

为什么只有靠近视口下缘才触发：第三个 chip 让字段从 20px 长到 40px（`maxTagCount=2` 的 `+1 more` 随后把它收回 20px——但列表打开时是 40px）。字段在 y 662–686（390×844 视口）时，列表放在下方 y 690–826 还装得下，**不发生翻转**；样例区块上移 44px（y 694 → 650）后，列表放下方会越出视口下缘，`flip` 把它放到上方（`data-side` bottom → top，列表从 690 移到 522），lazyFlip 钉住这个 side。上表两个方向都成立：同一条代码，位置在 650（会翻转）红、694（不翻转）绿。观察到的差别只在这一步：会翻转时，这个 RO 回调里出错误（[runs/mechanism/before-light.json](runs/mechanism/before-light.json)：`tap Ops`、frame 25）；不翻转时同样回调、同样重启动却没有这条错误（补测见 [runs/mechanism/](runs/mechanism/) 的 `*with-button*`）。

## 修复

`src/web/src/components/ui/Floating.ts` 新增 `useResizingAnchor(open, anchor)`，`MultiSelect.tsx` 里把它的返回值交给 `BaseCombobox.Positioner` 的 `anchor`（原来直接传 anchor ref）：

- 打开期间每次 commit 后用 `useLayoutEffect` 量一次字段的 `getBoundingClientRect()`；**尺寸与上次不同**时 `setState` 一个新的 anchor 对象（`{ getBoundingClientRect, getClientRects, contextElement }`，Base UI 自己在 `setPositionReference` 里就是这样包装元素的），`layoutEffect` 的 `setState` 在同一个 commit 内同步重渲染。
- 于是翻转让 Base UI 重渲染、Floating UI 重起 `autoUpdate` 的那一步，**连同新的 observers 与一次 placement，都发生在 resize-observation 步之前**；到步骤到来时，那次 resize 只面对「已经在观察、深度更浅」的 positioner 与刚建立、尚未上报过的字段观察者，不再有未派发的通知。
- 尺寸未变时返回的仍是调用方给的 ref（对象恒等），所以默认行为与没有这个组合的其它调用方完全不变：`useDropdownPlacement`、`useWholePixelOffsets`、`useAnchorWidth`、`Select`/`Combobox` 都不经过它；`MultiSelect` 在字段尺寸不变的所有提交里传给 Base UI 的也是同一个 ref。
- 单测 [Floating.anchor.test.tsx](../../../../src/web/src/components/ui/Floating.anchor.test.tsx)（3 例）：尺寸不变的提交给出同一个 ref；尺寸变化的提交在**该提交**里给出新 anchor 且指向同一元素、下一次尺寸变化再换；每次打开（`open` 边沿）重新起算，关着时的尺寸变化不算。

为什么选「同一提交内重放位」而不是「把定位挪到 rAF」：`update()` 内部是 `flushSync`，在 RO 回调里推迟到下一帧会让这次 resize 的定位晚一帧（可见的跳动）。也没有现成的钩子可用：Base UI 1.8.0 不把 positioner 的 context（其中才有 `update`）暴露给消费者，`Positioner` 的 ref 只到元素本身（`usePositioner` 把 `forwardedRef` 与它自己的 ref 合成一个），`disableAnchorTracking` 只关跟踪、不改 `update`。把定位推迟到 `requestAnimationFrame`、或在回调里不跑 `update` 也都改变「列表始终贴在字段旁」的观感，本任务不这么做。

## 红绿对照

### 该用例：修复前/后（两个 WebKit 手机环境，各 10 次）

| 树 | 提交 | 结果 | 日志 |
| --- | --- | --- | --- |
| 修复前 | `743d21ab2` | 6/6 失败（3+3，各条都是这条页面错误） | [runs/repro-before.txt](runs/repro-before.txt) |
| 修复后 | `62ab70582` | **20/20 通过**，0 条 ResizeObserver 行 | [runs/fix-first.txt](runs/fix-first.txt) |

（`repro-before` 用 3 次/环境定位红；`fix-first` 用 10 次/环境作验收。用例文件、样例、断言未改；`--repeat-each`。）

### P6 的 ro-loop-variants 方法复跑（脚本 [scripts/ro-loop-variants.sh](scripts/ro-loop-variants.sh)）

三棵树 × 各 10 次/环境，与 P6 同一方法（补回「Open legacy Modal」占位按钮即绿、删掉即红）：

| 样例 | 提交 | 区块上缘 y（390×844） | 结果 |
| --- | --- | --- | --- |
| 修复前原样 | `743d21ab2` | 650 | 20 failed（10+10），20 条 ResizeObserver 行 |
| 修复前 + 占位按钮（同名、背后什么都没有） | `743d21ab2` | 694 | 20 passed |
| P6 的父提交原样（按钮还在） | `f78e93f61` | 694 | 20 passed |
| P6 的父提交删掉该按钮 | `f78e93f61` | 650 | 20 failed |
| 修复后 | `62ab70582` | 650 | 20 passed |

y 的实测：650 与 694 分别是「无按钮」「有按钮」两种样例由 P6 的逐步探针记录的区域位置（[p6/runs/ro-loop/](../p6/runs/ro-loop/) 的 `base-without-button-light.json`、`base-light.json` 等）；本任务的探针在两棵树上记的是字段与列表——无按钮样例里字段 y 662–686、列表开在下方 690–826，`tap Ops` 后字段 662–706、列表翻到上方 522–658（[runs/mechanism/](runs/mechanism/)），与区域 650 一致。

即：**红绿只跟区块在页面上的位置走，与 P6 无关**——P6 之前就有，P6 删掉 AntD 的按钮把区块上移 44px 后暴露；修复后无论位置都绿。日志与精简报告在 [runs/variants/](runs/variants/)。

### 观察者日志（before/after，各 2 次/主题）

[runs/mechanism/after-light.json](runs/mechanism/after-light.json) 的 `tap Ops`：观察者 1 对 188×40 的**第一次**回调发生在帧 24 之后（`0/2 runs with page errors`），字段尺寸变化与换位都记在帧 24 内（新的观察者在**回调之前**就已 observe），帧 25 的回调对字段与 positioner 一次一并收到（`unobserve(positioner)` → 下一帧重 observe），没有 error 行。修前/修后各 2 次 × 明/暗共 8 次运行，只有修前的 4 次有 error。

## 回归检查

在交付树（本会话工作树，`62ab70582`）上串行运行，一步一个 memory-capped scope 与私有网络命名空间（[scripts/suites.sh](scripts/suites.sh)；`p0-ref` 跑在起点树 `743d21ab2` 的检出上）。结果表与日志、精简报告在 [runs/suites/](runs/suites/)；本文件在运行中提交过一次，结果表随运行结束补上（见下一个提交）。

## 复现

```
bash docs/evidence/base-ui-migration/multiselect-ro-loop/scripts/make-trees.sh          # 三棵临时检出（/mnt/data，跑完删除）
bash docs/evidence/base-ui-migration/multiselect-ro-loop/scripts/ro-loop-variants.sh OUT # 上表五行的红绿对照
bash docs/evidence/base-ui-migration/multiselect-ro-loop/scripts/probe-run.sh TREE OUT NAME RUNS  # 观察者日志
bash docs/evidence/base-ui-migration/multiselect-ro-loop/scripts/suites.sh              # 回归检查
```

## 边界

- 只修 Orbit 的 MultiSelect（`Floating.ts` + `MultiSelect.tsx` 一行）；`Select`、`Combobox`、`Menu`、子菜单等其它 Base UI 调用方不经过 `useResizingAnchor`。同类问题（被观察的浮层元素在打开期间变尺寸且靠近视口边缘）在其它组件上是否存在，本任务未排查——本次只有 MultiSelect 的 field 会被自己的内容改变尺寸。
- WebKit 的「loop completed」按规范是**通知**而非致命错误；本用例把它当页面错误是既有的用例断言（P2 起），本任务不改断言，而是让这个序列不再产生它。
- 视口只用 390×844（两个手机环境）。其它尺寸/真机未在本任务范围内。
