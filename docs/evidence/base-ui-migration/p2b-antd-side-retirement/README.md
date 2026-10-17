# P2 跟进：退役 keyboard window 第 2 批的 AntD 一侧比较用例（同 P6 判定 1A）

服务于 [P2 跟进：退役 keyboard window 第 2 批的 AntD 一侧比较用例（同 P6 判定 1A）](orbit-task:34dq7m9wxKsEaWbvtNqk2)，项目「Orbit Web 组件迁移：Base UI + Orbit 自有组件」验收条目 key `1BvO6hYrlFnU60JqxQPUHt` 原文：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。**

本任务只动一个文件：第 2 批探测 [keyboard-window-2.browser.mjs](../p2-keyboard-window-2/keyboard-window-2.browser.mjs)（sha256 `2434c049…` → `44a9207f…`），按 P6 判定 1A 退役其中全部 7 个 AntD 一侧目标；Orbit 一侧的目标、序列、断言与读取工具一条未动。没有 `src/` 产品改动。修改逐行见 [retire-antd-targets.patch](retire-antd-targets.patch)。

工作树：项目线 `project/34ZZeq0e3IR65GVm2kAs7` 的 tip `a55e9d113`（= 本会话检出 HEAD），参照树是起点树 `743d21ab2` 的临时检出。

## 结论

| 验收要点 | 结果 |
| --- | --- |
| 88 条按 1A 退役并逐条列出 | 逐条核对见[这 88 条的形态](#这-88-条的形态逐条核对)；88 条逐名、逐条错误与「原先证明的差异」在 [deleted-cases.json](runs/deleted-cases.json)，出处指向第 2 批自己的 [combinations.md](../p2-keyboard-window-2/combinations.md) 与 baseline 运行目录。 |
| 同时退役的另外 3 个 AntD 侧目标 | `antd-menu`(17 序列)、`antd-sample`(16)、`antd-popconfirm`(7) 上线后是绿的，但已不是「对照」：P6 之后 `?system=antd` 与 `?system=orbit` 画的是同一个页面（[dup-check](runs/dup-check.json)：7 个样例 × 2 系统 × 2 次，摘要逐字节相同），它们是 `orbit-menu-sample`/`orbit-sample`/`orbit-popconfirm` 的重复测量。按同一个判定（1A：与 AntD 现场比较的用例整体退役）一并退役，见[退役清单](#退役清单逐条)。 |
| Orbit 一侧用例与断言一条不留不弱化 | 退役前后的测试名逐字比较：Orbit 侧 42,560 个名字（10 个 `orbit-*` 目标 × 40 样本 × 8 环境）**逐字相同**、新增 0（[orbit-test-names-before/after](runs/) 两份 `diff` 无输出）；`TARGETS` 里 orbit-* 的定义、`SEQUENCES`、读取工具（`read`/`value`/`activated`/`pageState`/`observeKeys`）与 `RUNS`/`KEYS` 均未改，删除前后在同一棵树与起点树上的逐样本状态与 `result` 一致，见[前后对照](#删除前后orbit-一侧在两棵树上的结果一致)。 |
| 双选择器读取工具与 `[class*="ant-"]` 普查保留（判定 2） | 本任务没有触及任何工具：`git diff --stat` 只有这一个探测文件；`src/web/ui-migration` 的各批同提交对照工具 0 改动；三个探测文件里本来也没有 `.ant-`/`[class*="ant-"]` 选择器（逐文件 0 命中），没有任何普查行为被改动。 |
| 第 2 批相关套件在项目 tip 上转绿（只余已记录处置） | 见[套件](#第-2-批相关套件在项目-tip-上转绿)：第 2 批 select 与其余序列 0 失败，第 1 批与 select-keys 0 失败。 |
| 无产品改动 | `git diff --stat HEAD -- src/` 为空；只有 `docs/evidence/base-ui-migration/p2-keyboard-window-2/keyboard-window-2.browser.mjs` 一个文件被改（sha256 `2434c049…` → `44a9207f…`）。 |
| 构建与完整 Vitest | `tsc -b && vite build` 退出 0（`✓ built in 712ms`）；Vitest **403 个文件、5,258 个用例全部通过**（[merge-check.txt](runs/merge-check.txt)）。审计 `audit-antd.mjs --check-owners`：`unowned: []`、`pending: []`。 |

## 范围与判定

- 项目验收条目 P2 的原文见上；本任务的服务对象是协调者按 P6 判定 1A（「共存样例里与 AntD 现场比较的用例与共存场景删除，Orbit 一侧的断言全部保留」）开出的补充任务：P6 删掉六个共存 fixture 的 AntD 一侧后，第 2 批探测里以 AntD 一侧为目标的比较序列就成了「活的 AntD 现场比较」——比较对象已不在运行期。
- 起因里的 88 条（`antd-submenu` 30、`antd-session` 30、`antd-dialog` 14、`antd-confirm` 14）在起点树 `743d21ab2` 上全红、逐名相同，见 [multiselect-ro-loop 的 runs](../multiselect-ro-loop/runs/suites/kw2-other-del.txt)；本任务在项目 tip 上重跑，逐名一致（[red-tip.txt](runs/red-tip.txt) 对 [red-ro.txt](runs/red-ro.txt)：`diff` 无输出）。
- 退役方式：删掉 `TARGETS` 里的 7 个 AntD 一侧条目与 `MENUS`/`SUBMENUS`/`SELECTS`/`POPCONFIRMS`/`DIALOGS` 里的成员，并收束描述它们的那几行注释；其余一字未动。

## 这 88 条的形态（逐条核对）

88 条全部是 `antd-*` 目标，逐条在项目 tip 上重跑并读错误（[deleted-cases.json](runs/deleted-cases.json) 的 `red_failing_tests`，每条含名称、错误、等待的元素）：

| 目标 | 条数 | 失败点 | 等待的元素 |
| --- | ---: | --- | --- |
| `antd-submenu` | 30（15 序列 × burst/paced） | 打开前置断言 `toBeFocused` | `getByRole('menuitem', { name: /^Provider/ })`——旧 Dropdown 的「⏎ 打开、Tab 才把焦点移进菜单」在样例页上不再成立，菜单在 Tab 时已关闭 |
| `antd-session` | 30（15 序列 × 2） | 同上 | 同上 |
| `antd-dialog` | 14（7 序列 × 2） | 打开前置的 `field.focus()` | `getByRole('button', { name: 'AntD dialog' })`——P6 从 overlays fixture 删掉的按钮 |
| `antd-confirm` | 14（7 序列 × 2） | 同上 | `getByRole('button', { name: 'AntD confirm' })` |

逐条形态一致：目标落在 AntD 宿主不再画的元素上（旧 Dropdown 子菜单标题、`AntD dialog`/`AntD confirm` 按钮），AntD 已不在运行期，比较对象不存在——属 P6 判定 1A 的同类。**没有发现 88 条里有不属于「活的 AntD 对照」的用例**（例如仍应通过的 Orbit 行为用例）：88 条的名字全部以 `antd-` 目标开头，失败点全部是它们自己的打开前置，Orbit 侧 200 条在两次基线里全过（另 48 条通过的是三个绿的 AntD 侧目标本身，见下）。

## 退役清单（逐条）

删除的每一个「目标 × 序列」（84 个组合，运行期展开为 8 环境 × 40 样本 = 26,880 个测试名）在 [deleted-cases.json](runs/deleted-cases.json) 里逐条列出：序列名、它在第 2 批证据里记录的「原先证明的差异」（该 AntD 目标自己的 paced 参照与 burst 错数，取自 [combinations.md](../p2-keyboard-window-2/combinations.md) 的对应列）、以及指向那个文件与该序列在 `baseline-*` 运行目录里的样本的出处。

### 红的那 4 个（88 条）

| 目标 | 序列（15 或 7 个） | 原先证明的差异（举例，逐条在 JSON 里） | 出处 |
| --- | --- | --- | --- |
| `antd-submenu` | `sub-right`、`sub-right-enter`、…、`sub-enter-down-enter` | 旧 Dropdown 子菜单在窗口内的行为：`sub-enter` 的 paced 参照 `none \| menu×2 \| @menuitem:Codex`，burst 错 0/20；`sub-right` 等以 →/⏎ 打开子菜单、焦点未进菜单前的落点 | [combinations.md §子菜单](../p2-keyboard-window-2/combinations.md)、`baseline-sub-a…d/` |
| `antd-session` | 同上 15 个 | 同上，父菜单里有其它项（Default model、Group by tag、Delete） | 同上 |
| `antd-dialog` | `dlg-enter`、`dlg-enter-enter`、… 7 个 | 旧 Modal 的窗口内行为：如 `dlg-enter-enter` 的 paced 参照 `ran Close \| none \| @button:AntD dialog`、burst 错 0/20 | [combinations.md §Dialog](../p2-keyboard-window-2/combinations.md)、`baseline-dlg/` |
| `antd-confirm` | 同上 7 个 | 旧 `modal.confirm`（Cancel 自动聚焦）的窗口内行为：`dlg-enter-space` 的 paced 参照 `ran Cancel \| none \| @button:AntD confirm` | 同上 |

### 同源退役的 3 个（绿，但已是重复测量）

`antd-menu`(17 序列)、`antd-sample`(16)、`antd-popconfirm`(7) 的逐条记录同样在 [deleted-cases.json](runs/deleted-cases.json)。它们在第 2 批证据里的角色与红的那 4 个相同（README 的目标表把每个 `antd-*` 与它的 `orbit-*` 成对列出），只是它们等待的控件名（`Add attachment`、`Sample choice`、`Delete task`）在 Orbit 样例里同名存在，于是「通过」了。P6 之后 `?system=antd` 画的就是 Orbit 样例，这一对目标读到的是同一个页面，见 [dup-check](runs/dup-check.json)：7 个样例在 `?system=antd`/`?system=orbit` 下各跑两次，DOM 摘要 4 份全部相同（噪声对照：同 URL 两次的摘要也相同）。删掉它们不丢任何覆盖——那些样本正是 `orbit-menu-sample`/`orbit-sample`/`orbit-popconfirm` 已经采的同一样本。

## 退役只动这些目标

- 删除前后的测试名单逐字比较（`--list`，8 个环境 × 40 样本）：AntD 侧 26,880 个名字消失（`antd-submenu`/`antd-session` 各 4,800，`antd-menu` 5,440，`antd-sample` 5,120，`antd-dialog`/`antd-confirm`/`antd-popconfirm` 各 2,240；[deleted-test-names.txt.gz](runs/deleted-test-names.txt.gz)），**新增 0**；Orbit 侧 42,560 个名字（`orbit-menu`/`orbit-menu-sample`/`orbit-field` 各 5,440，`orbit-sample` 5,120，`orbit-submenu`/`orbit-submenu-sample`/`orbit-session` 各 4,800，`orbit-dialog`/`orbit-confirm`/`orbit-popconfirm` 各 2,240；[orbit-test-names-before/after](runs/)）在删除前后**逐字相同**。
- `TARGETS` 里 orbit-* 的条目、`SEQUENCES` 数组、`RUNS`/`KEYS`、`pageState`/`observeKeys`/`read`/`value`/`activated` 都没有改；改动只有 [retire-antd-targets.patch](retire-antd-targets.patch) 里的 19 增 22 删。
- 三个探测文件里 `.ant-`/`[class*="ant-"]` 选择器 0 命中，第 2 批本就不带双选择器工具；`src/web/ui-migration` 的 13 个文件 191 处双选择器/普查（判定 2 保留）不在本任务 diff 里。

## 删除前后：Orbit 一侧在两棵树上的结果一致

同一组命令（`KW2_BURST=1 KW2_PACED=1`、`--grep-invert " select-"`、`chromium-dark-desktop`），删除前 / 删除后在**同一棵树**（项目 tip `a55e9d113`）与**起点树**（`743d21ab2`）上各跑一遍，逐测试比较状态与每样本记录的 `result` 字符串（[summarize.py](scripts/summarize.py) `--compare`）：

| 树 | 删除前 | 删除后 | 比较 |
| --- | --- | --- | --- |
| 项目 tip `a55e9d113` | 248 passed、88 failed（[kw2-oth-before.txt](runs/kw2-oth-before.txt)） | 200 passed、0 failed（[kw2-oth-after.txt](runs/kw2-oth-after.txt)） | Orbit 侧 200 条逐测试状态与 `result` 相同（[compare-tip.txt](runs/compare-tip.txt)） |
| 起点树 `743d21ab2` | 248 passed、88 failed（[kw2-oth-ref-before.txt](runs/kw2-oth-ref-before.txt)） | 200 passed、0 failed（[kw2-oth-ref-after.txt](runs/kw2-oth-ref-after.txt)） | 同上（[compare-ref.txt](runs/compare-ref.txt)） |

删除前的两次运行本身也逐名相同（`red-tip.txt` 对 `red-ref.txt`：`diff` 无输出）。

## 第 2 批相关套件在项目 tip 上转绿

| 套件 | 命令 | 结果 | 日志 |
| --- | --- | --- | --- |
| 第 2 批 select（3 burst + 3 paced） | `KW2_BURST=3 KW2_PACED=3 … --grep "(orbit-field\|orbit-sample) select-"` | 198 passed（删除前 294，其中 96 条是 `antd-sample`） | [kw2-sel-after.txt](runs/kw2-sel-after.txt) |
| 第 2 批其余序列（1 + 1） | `KW2_BURST=1 KW2_PACED=1 … --grep-invert " select-"` | 200 passed、0 failed | [kw2-oth-after.txt](runs/kw2-oth-after.txt) |
| 第 1 批（keyboard-window，未改） | select 全量 3+3（222）与其余 1+1（66），同 RO 任务的方法 | 222 + 66 passed；其中 Orbit 侧 select 单跑（150）也通过 | [kw1-all-sel-after.txt](runs/kw1-all-sel-after.txt)、[kw1-after.txt](runs/kw1-after.txt)、[kw1-other-after.txt](runs/kw1-other-after.txt) |
| select-keys（未改） | 该探测的默认运行（burst 20 + paced 3） | 276 passed | [sk-after.txt](runs/sk-after.txt) |

第 1 批与 select-keys 这两个探测文件本任务未改；它们各自的 `antd-*` 目标（`antd-menu`、`antd-sample`、`antd-search`、`antd-multiple`）同样是 P6 之后没有 AntD 现场的残留，本任务按范围只退役第 2 批，其余按协调者决定。

## 构建与完整 Vitest

[merge-check.txt](runs/merge-check.txt)：`npm run build -w @orbit/web && npm run test -w @orbit/web`（即项目的合并检查命令）在项目 tip 加上本改动后通过——`tsc -b && vite build` 退出 0（`✓ built in 712ms`），Vitest **403 个文件、5,258 个用例全部通过**，退出 0（也含 P2 的 jsdom 单测 `keyboardWindow.test.tsx`）。审计 `node src/web/scripts/audit-antd.mjs --check-owners` 输出 [audit-antd-owners.json](runs/audit-antd-owners.json)：`unowned: []`、`pending: []`。

## 复现

```
bash scripts/queue.sh before   # 删除前三件套：tip select 3+3、tip 非 select 1+1、起点树非 select 1+1
git apply -p1 retire-antd-targets.patch
bash scripts/queue.sh after    # 删除后：同上三件 + 第 1 批 + select-keys + 构建/Vitest
```

`scripts/step.sh NAME TREE CMD…` 是每步的运行记录器（argv、树的 HEAD、未提交文件、负载/内存/磁盘、退出码；串行、自建 6G systemd scope、独立网络命名空间、可续跑）。`dup-check` 用 [dup-check.browser.mjs](dup-check.browser.mjs)（配置同目录）跑：`DUP_OUT=… npx playwright test --config dup-check.config.mjs --project chromium-dark-desktop`。比较与提取：[scripts/summarize.py](scripts/summarize.py)（`--failed`/`--targets`/`--compare`）、[scripts/slim.py](scripts/slim.py)、[scripts/extract-deleted.py](scripts/extract-deleted.py)。

## 边界

- 只退役第 2 批探测里的 AntD 一侧；第 1 批、select-keys 的同类残留（都还是绿的重复测量）没有动，留待协调者判定（见上）。
- 88 条里没有发现不属于「活的 AntD 对照」的用例；若判定方认为其中某条应保留，可从 `../p2-keyboard-window-2/` 原文件（sha256 `2434c049…`，`git show HEAD:` 可取）与 [retire-antd-targets.patch](retire-antd-targets.patch) 精确回退该条。
- 运行样本沿用各套件自己的方法（第 2 批 1+1 或 3+3、第 1 批 3+3/1+1、select-keys 20+3），未做 8 环境全量 20+20 的重采；判定 1A 的删除本身与样本数无关（删除前后 Orbit 侧的名字集合逐字相同）。
- 起点树只用于前后对照（它是 RO 修复任务的起点、也是那 88 条红的记录树）；没有第三棵树。
