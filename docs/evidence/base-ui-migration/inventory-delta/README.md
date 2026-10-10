# AntD 迁移清单增量记录（2026-10-07）

本目录交付[迁移清单增量复核：main 新增 antd 使用点归属](orbit-task:34bkjldwhL7rVdYPgWBwz)，服务于 [Orbit Web 组件迁移项目](orbit-project:34ZZeq0e3IR65GVm2kAs7) 的 P0 验收：**所有 AntD 使用点均有迁移归属**。它在 [P0.1 清单](../README.md)之上记新增、改动、重新归属和已关闭的使用点。P0.1 的原始基线文件（`audit-baseline.json`、`ownership.json`、`css-ownership.json`、`routes-and-tests.md`、`component-contracts.md`）一字未改。本任务只做清单和归属，`src/web/src` 下没有任何文件改动，没有迁移任何组件。

## 结论

- 扫描对象是项目分支 tip `7732f14f82d4e6b4406d7d164c4b672f63aa0f56`。它已完整包含 `origin/main` `216cc204f67bb88fed5425371745ba97899e1e7a`：`git rev-list --count 7732f14f8..origin/main` 为 0。审计 scopeHash 为 `bb238f9ed5588bd9e5c3ae2d4f32a9302b85fe7d219d5c05c6b1f16e024d5a2a`。本任务提交只改 `src/web/scripts` 和 `docs`，不在审计范围内，所以 scopeHash 在提交后不变。
- 对比基线是 P0.1 的 `1068a14b899911838526111b6814394e99762aaf`（scopeHash `ddd5a6c0…`）。
- 读入两份记录后，`node src/web/scripts/audit-antd.mjs --check-owners` 在 tip 和交付提交上都是 **0 个未归属、0 个待定**。第一份记录 [2026-10-07.json](2026-10-07.json) 留给协调者的 9 个点（4 个 P4.3a/P4.3b 分界问题），协调者 2026-10-07 已全部按建议判定，写在第二份记录 [2026-10-07b.json](2026-10-07b.json)，见[协调者的决定](#协调者的决定)。
- `verify-record.mjs` 按读取顺序对照审计逐份核对：
  - `2026-10-07.json` 的 119 个文件条目和 73 个 index.css 条目与审计一致。拿掉它的新增/改动条目，正好有这 76 个点失去归属；拿掉它的重新归属，正好有这 118 个点（文件和 index.css 行）改变状态。它单独读入时留下的待定点正好是那 4 个问题的 9 个点。
  - `2026-10-07b.json` 的 6 个文件条目和 3 个 index.css 条目同样一致；拿掉它，正好是这 9 个点退回待定。

  也就是说，每个条目都是必需的，也没有漏项。
- main 在 P0.1 之后引入的使用点全部有了归属。P3.3 报告的 6 个文件都在其中：AccessTokenTable、NewAccessTokenDialog、AccessTokensPage（d233a6cd0），AccountPause（0ba581f31），WikiActivityPage（6c4e0ac0e），CliLoginPage（cf98836d4）。此外 main 还带来：
  - 1 个测试辅助文件 `RunnerEngines.test-helpers.ts`（审计按文件名记为生产）；
  - 22 个新增测试；
  - 4 个已有文件新增的 antd 符号（ProjectSettlementCard、RunnerEngines、AdminUsersPage、ProfilePage）；
  - index.css 里 17 行新增的覆盖样式和注释。
- 迁移项目线自身新增的使用点也已登记：
  - 16 个 `components/ui` 文件和对照样例（P1.1–P3.2 写入的 AntD 对照注释和 AntD 参照样例）；
  - 1 个负向测试；
  - P3.1 改写的 7 行输入框样式；
  - P3.2 写下的 2 行注释。
- 已按协调者 2026-10-07 的补充处理：
  - `StatusTag.tsx` 核实为死代码，记为 P6 删除；
  - 原 P4.3 的使用点全部细分到 P4.3a / P4.3b，分不清的 4 个已由协调者判定（`2026-10-07b.json`）。

| 文件口径（审计 counts） | P0.1 基线 | 本次 tip |
| --- | ---: | ---: |
| 扫描文件 | 554 | 690 |
| 直接引用 antd 的生产文件 | 93 | 100 |
| 直接引用 antd 的测试文件 | 64 | 76 |
| 含 `.ant-*` 的测试文件 | 54 | 62 |
| 含裸 `ant-*` 的测试文件 | 60 | 69 |
| 引用独立图标包的生产文件 | 80 | 97 |
| `--check-retired` 阻塞文件 | 203 | 241 |

antd 的声明与锁定版本没有变化：`src/web/package.json` 的 declared 与 lockfile 中 antd 系列条目都和基线逐条相同。

## 产物

| 文件 | 用途 |
| --- | --- |
| [2026-10-07.json](2026-10-07.json) | 机器可读的增量记录。以后的批次和 P6 的 `--check-owners` 直接读它。 |
| [2026-10-07b.json](2026-10-07b.json) | 协调者对第一份记录里 4 个问题的判定：9 个点的 owner。第一份记录保持原样。 |
| [2026-10-07c.json](2026-10-07c.json) | 协调者 2026-10-08 判定：main 带来、不在 P4.2 页面里的未归属点。`ProjectDoneConversation.test.tsx` → P6（只是固定数据里的 “antd migration” 字样，先例是 `ProjectWhyNotDoneGate.test.tsx`）；`StartProjectCard.test.tsx` → P4.3b；`WorkspaceView.neverStarted.test.tsx`、`WorkspaceView.promptSuggestion.test.tsx` → P5.3；`WikiReviewPage.decided.test.tsx`、`WikiShareButton.tsx`、`SharedWikiPage.tsx`、`SharedWikiPage.test.tsx` → P4.4；index.css 的两行 `.ant-dropdown-menu-item.composer-engine-title` → P5.3；提到 `.ant-radio-group` 的一行注释 → P4.3a。同批报出、落在 P4.2 页面里的 `DeepSeekBalance.tsx`、`RunnerEngines.accountFold.test.tsx`、`AdminUsersPage.disable.test.tsx` 由 P4.2 直接迁移，不在记录里。由 [P4.2](orbit-task:34Za39Feocgj42rrBYwzl) 按协调者要求登记，扫描对象是 P4.2 的交付。 |
| [2026-10-07d.json](2026-10-07d.json) | [P2 跟进（第 2 批窗口）](../p2-keyboard-window-2/README.md)登记 `ChoicesFixture.tsx` 新增的 antd `Popconfirm` 导入（Popconfirm 基线的 AntD 参照），owner 仍为 P6，条目 status 为 `amended`；由 `../p2-keyboard-window-2/build-inventory-record.py` 生成。 |
| [2026-10-08.json](2026-10-08.json) | [浮层第一帧位置](../overlay-first-frame/README.md)登记 `ChoicesFixture.tsx` 新增的 antd `Drawer` 导入（第一帧检查「抽屉内」位置的 AntD 参照），owner 仍为 P6，条目 status 为 `amended`（重述 07d 的条目）；由 `../overlay-first-frame/build-inventory-record.py` 生成。 |
| [build-record.py](build-record.py) | 由审计 JSON 和 git 历史算出事实，再合入手工归属表（owner 与理由）生成记录。有使用点缺决定时直接失败退出。 |
| [build-decision.py](build-decision.py) | 从第一份记录复制 9 个待定条目的事实，写入协调者判定的 owner，生成 `2026-10-07b.json`。 |
| [2026-10-08b.json](2026-10-08b.json) | [P4.3a](orbit-task:34Za39GvWRQ08ZmKOpFNe) 登记协调者 2026-10-08 的三项判定：`ui/Empty.tsx`（079c5f006 新增，注释写明改编自 Ant Design 的 MIT 插图）按 `ui/SelectEmpty.tsx` 的先例归 P6；index.css 「The two lines…」那段注释由 P4.3b 改归 P4.3a（它说明的单选规则只有 ProjectRunSettings 用）；`.ant-popover .watch-row-list` 由 P4.3a 改归 P4.4（它限定的 AntD Popover 在 P4.4 的 WatchRelations.tsx 里）。由 `build-record-08b.py` 从 079c5f006 的审计（`../p4.3a/checks/record-08b-audit.json`）生成。 |
| [build-record-08b.py](build-record-08b.py) | 只读入排在它前面的记录，确认只剩 `ui/Empty.tsx` 未归属，再从审计和 git 取事实，写入上面三项判定，生成 `2026-10-08b.json`；多出未归属点或判定对不上任何点都直接失败。 |
| [2026-10-09.json](2026-10-09.json) | [P4.3b](orbit-task:34blYpxEcHMAf4oafuC2W) 登记协调者 2026-10-09 的判定：`src/web/src/firstPageStylesheet.test.ts`（P4.3b 的首屏样式表修正新增，钉住首屏唯一样式表的顺序，期望里写着 `antd/dist/reset.css`）归 P6——P6 从 main.tsx 去掉 antd reset 时一并改这条期望；先例是 07c 的 `ProjectDoneConversation.test.tsx` 与 08b 的 `ui/Empty.tsx`。 |
| [build-record-09.py](build-record-09.py) | 读入其余记录（排在它前面的与后面的），确认拿掉本记录时只剩这个测试文件未归属（排在前面的记录另外留下 main 带来的 3 个 Infrastructure 测试文件，它们归排在后面的 `2026-10-09b.json`），再从审计和 git 取事实，写入上面的判定，生成 `2026-10-09.json`；多出未归属点或判定对不上任何点都直接失败（build-record-08b.py 去掉 index.css 部分）。 |
| [2026-10-09b.json](2026-10-09b.json) | [P4.3a](orbit-task:34Za39GvWRQ08ZmKOpFNe) 登记协调者 2026-10-09 的判定：P4.3a 跟上 origin/main `19c760ae4` 后 `--check-owners` 报出 3 个未归属点，都是另一个项目（34bmzOkov3xN2yLPrnsCk，Infrastructure 页）带进 main 的测试文件，只用 antd 的 `App` 包裹被测组件（被测的 InfrastructurePage、RunnerDetailPage 本身不导入 antd）：`App.infrastructure.test.tsx`、`InfrastructurePage.overview.test.tsx`、`RunnerDetailPage.engines.test.tsx` → P6，status 记 new（P6 去掉 ConfigProvider/AntApp 时一起去掉；先例是 07c 的 `ProjectDoneConversation.test.tsx`）。文件名用 09b，`2026-10-09.json` 留给在它之后落地的 P4.3b。由 `build-record-09b.py` 从 `dac57bade` 的审计（`../p4.3a/checks/record-09b-audit.json`）生成。 |
| [build-record-09b.py](build-record-09b.py) | 只读入排在它前面的记录，确认只剩这 3 个测试文件未归属、没有待定点，再从审计和 git 取事实，写入判定，生成 `2026-10-09b.json`；多出未归属点或判定对不上任何点都直接失败。 |
| [2026-10-09c.json](2026-10-09c.json) | [P4.4](orbit-task:34Za39J4QY3kDa5p2Wsau) 登记协调者 2026-10-09 的判定：P4.4 跟上 origin/main `251c3de8f` 后 `--check-owners` 报出 2 个未归属点，都是 managed runner 项目（`94025579b`）带进 main 的测试文件，只用 antd 的 `App` 包裹被测组件：`WorkspaceView.managedRunner.test.tsx` → **P5.3**，status 记 new（与其余 `WorkspaceView.*.test.tsx` 一致）；`App.managedRunner.test.tsx` 落在 P4.4 的 `App.tsx` 范围里，由 P4.4 在业务切换 `90ce00944` 里去掉包裹，那个提交上它已不是使用点，不进记录。文件名用 09c，因为 `2026-10-09.json`（P4.3b）与 `2026-10-09b.json`（P4.3a）已被占用。由 `build-record-09c.py` 从交付 `29ef702b3` 的审计（`../p4.4/checks/record-09c-audit.json`）生成。 |
| [build-record-09c.py](build-record-09c.py) | 只读入排在它前面的记录，确认只剩这个测试文件未归属、没有待定点，再从审计和 git 取事实，写入判定，生成 `2026-10-09c.json`；多出未归属点或判定对不上任何点都直接失败（`build-record-09b.py` 的做法）。 |
| [2026-10-10.json](2026-10-10.json) | [P5.2](orbit-task:34Za39Mm04q5p66pqUTtj) 登记协调者 2026-10-10 的判定：P5.2 开工时在项目 tip `d580e572d`（已含 origin/main `46e28aaa3`）上 `--check-owners` 报出 1 个未归属点，`WorkspaceView.recapRow.test.tsx`，由 main 的会话列表 recap（`2255a5313`，0418）带进，只用 antd 的 `App` 包裹被测的会话工作区 → **P5.3**，status 记 new（与 `2026-10-09c.json` 的 `WorkspaceView.managedRunner.test.tsx` 同形，随 P5.3 去掉包裹而消失）。P5.2 自己的使用点在交付上已为 0，所以这条是记录里唯一的点。由 `build-record-10.py` 从交付 `08a8964da` 的审计（`../p5.2/checks/record-10-audit.json`）生成。 |
| [build-record-10.py](build-record-10.py) | 只读入排在它前面的记录，确认只剩这个测试文件未归属、没有待定点，再从审计和 git 取事实，写入判定，生成 `2026-10-10.json`；多出未归属点或判定对不上任何点都直接失败（`build-record-09c.py` 的做法）。输出先写到目录外再移入：生成时目录里若已有空的 `2026-10-10.json`，读入记录的一步会读到它而失败。 |
| [build-record-c.py](build-record-c.py) | 只读入排在它前面的两份记录，算出仍未归属的点，再从审计 JSON、P0.1 基线和 git blame 取出它们的事实，写入协调者的判定，生成 `2026-10-07c.json`。有点缺判定，或判定对不上任何点，都直接失败。 |
| [verify-record.mjs](verify-record.mjs) | 按读取顺序逐份核对记录与审计是否一致，并做反向对照：拿掉新增/改动、拿掉重新归属、单独检查 P0.1 基线；补充记录必须排在被补充的记录之后。2026-10-08 起（P4.3a），重新归属的反向对照比较每个点归谁（owner 本身，或待定、未归属），不再只比较有没有归属：08b 把点从一个仍在进行的批次移到另一个，原来的比较看不出变化、会误报失败（实测原版报 `[] ≠ [10699, 19729]`）。07、07b、07c 用各自的审计复核仍然通过（07d 只有 `amended` 条目，不经过这一项）。 |
| `src/web/scripts/audit-antd.mjs --check-owners` | 新增的只读检查模式；原有的默认、`--json`、`--check-retired` 输出逐字节不变。 |
| [checks/](checks/) | 本次实际输出，详见文末[复现与验证](#复现与验证)。 |

## 记录怎么读

`2026-10-07.json` 的主要字段如下。

- `files`：路径 → 条目。
  - `status` 取值：
    - `new`：P0.1 之后出现；
    - `changed`：P0.1 已有，多了 antd 符号或命中；
    - `reassigned`：P0.1 已有，原 owner 已完成或已拆分。
    - `amended`（`2026-10-07d.json` 起）：重述已登记条目（`amends` 所指记录中的同一路径）的当前事实，owner 不变，`added` 相对该条目计算。它不是归属所必需，所以 `verify-record.mjs` 第 3 项（拿掉新增/改动或重新归属的条目后的反向对照）不适用。
  - 其余字段：`category`、`types`、`antdImports`、`hitKinds`（tip 上的事实），`added`（相对 P0.1 增加的部分），`introducedBy`，`p01Owner`，`owner`，`reason`；可选 `reviewPhase`、`action`、`pending`。
- `css`：只针对 `src/web/src/index.css`，按命中**原文**对照，不用行号（P0.1 的行号规则见 `css-ownership.json` 的 `rule`）。字段有 `kind`、`text`、`count`、`lines`（tip 行号，仅供定位）、`status`、`type`、`introducedBy`、`p01Group`、`owner`、`reason`。
- `introducedBy[]`：引入这处使用的提交，带 `commit`、`short`、`date`、`subject` 和 `line`。`line: "main"` 表示提交来自 main，由 “Merge refs/heads/main into refs/heads/project/…” 或任务分支内的 main 合并带进项目线。`line: "project"` 表示本迁移项目自己的提交（P0–P3 各批）。算法见 `build-record.py` 的 `project_line()`：沿项目分支 first-parent 走，main 吸收合并只算 main。
- `reviewPhases`：P0.1 中 reviewPhase 为 P4.3 的 KEEP 文件（无使用点），只拆分复核批次。
- `closed`：P0.1 中已经消失或减少的使用点，带 `closedBy`（关闭提交）和 `closureRecord`（对应批次的关闭记录）。index.css 行另有 `disposition`：`removed` 是选择器已删除，`rewritten` 是改写成选择器列表后仍在。
- `reviewedNotUse`：只有候选命中（`message.*`、`ref.focus` 等）、经人工核实不是 antd 的文件。
- `forCoordinator`：待协调者决定的问题。
- `inactiveOwners`：不能再关闭使用点的 owner，即已完成的阶段和已拆分的 P4.3。
- `batches`：批次代码 → 任务 id 与范围。

`2026-10-07b.json` 是对前一份的补充：
- `amends` 指向被补充的记录，`decision` 写明判定来源；
- 条目字段相同，另有 `basis`（判定依据）和 `alsoTestedBy`（改到渲染它的卡片或页面时也要跑它测试的批次）。

记录按文件名排序读取，后读的覆盖先读的。同一天的后续记录要用 `2026-10-07b.json`、`2026-10-07c.json` 这类后缀；不能用 `2026-10-07-x.json`，因为 `-` 排在 `.` 之前，它会先于原记录被读到、再被原记录覆盖。`verify-record.mjs` 会检查带 `amends` 的记录确实排在被补充的记录之后。

`types` 取值：
- `antd-import`：直接导入，符号在 `antdImports`；
- `antd-provider`：`<App>`/`<ConfigProvider>`，测试里多为 AntApp 包裹；
- `antd-use-app`：`App.useApp`；
- `antd-imperative`：`modal.confirm` 等；
- `antd-theme`；
- `internal-ref`：如 TextArea 的 `resizableTextArea`；
- `ant-selector`：`.ant-*` 选择器，包括 CSS 规则和测试中的 querySelector；
- `ant-class`：不带点的 `ant-*` 类名，如正则断言；
- `antd-text`：注释、字符串、测试名里的 “antd/AntD” 字样；
- `css-override`：index.css 中针对 AntD 内部类的覆盖样式。

使用点的判定与 `--check-owners` 一致：
- 生产或测试文件导入 antd（或 v5 patch），或含 `antd-reference`、`ant-class`、`ant-selector`、`internal-ref`、`use-app`、`use-token`、`react19-patch` 之一的命中；
- index.css 按行判定，只看 `antd-reference` 与 `ant-class`，与 `css-ownership.json` 同口径；
- `@ant-design/icons` 和 `.anticon` 按项目约定保留，不算使用点。

## 归属结果

两份记录合计（P4.3a、P4.3b 已含 `2026-10-07b.json` 判定的 9 个点）：

| 批次 | 新增/改动文件 | 重新归属文件 | index.css 新增/改写行 | index.css 重新归属行 |
| --- | ---: | ---: | ---: | ---: |
| P4.1 登录、初始化、个人资料、设置 | 11 | 0 | 3 | 0 |
| P4.2 Provider、Runner、账号池、用户管理 | 10 | 0 | 10 | 0 |
| P4.3a 任务与项目的列表、详情页和工具栏 | 0 | 44 | 0 | 38 |
| P4.3b 依赖图与业务决策卡片 | 1 | 17 | 2 | 13 |
| P4.4 Wiki、共享和其余非会话入口 | 4 | 0 | 2 | 0 |
| P5.1 会话导航、搜索、输出 | 2 | 0 | 0 | 0 |
| P5.2 Transcript 与富内容 | 1 | 0 | 0 | 0 |
| P5.3 会话工作区 | 4 | 0 | 7 | 0 |
| P6 运行时与遗留说明退役 | 18 | 7 | 2 | 0 |
| 待协调者 | 0 | 0 | 0 | 0 |

### A. main 新增或改动的文件

| 路径 | 类型 | 引入提交 | 归属 | 理由 |
| --- | --- | --- | --- | --- |
| `components/AccessTokenTable.tsx`（新增） | antd-import：Button/Popconfirm/Table/TableColumnsType/Tag | d233a6cd0（main） | **P4.1**，复核 P4.2 | 令牌表（Table、Tag、Popconfirm），主调用方是设置下的 /settings/access-tokens（P4.1），AdminUsersPage（P4.2）也复用；按 P0.1 AccountSelect 的先例由最先到达的调用方批次迁移、后到的批次复核。 |
| `components/NewAccessTokenDialog.tsx`（新增） | antd-import：Alert/Button/Checkbox/Input/Modal/Radio/Select | d233a6cd0（main） | **P4.1** | 只由 AccessTokensPage 打开的新建令牌弹窗（Modal、Input、Radio、Select、Checkbox、Alert），属设置页的表单、校验与提交。 |
| `pages/AccessTokensPage.test.tsx`（新增） | ant-selector | d233a6cd0（main） | **P4.1** | 覆盖 AccessTokensPage 与新建令牌弹窗，.ant-* 选择器随页面迁移改为角色/标签。 |
| `pages/AccessTokensPage.tsx`（新增） | antd-import：Button/Spin | d233a6cd0（main） | **P4.1** | /settings/access-tokens 设置页（Button、Spin）。 |
| `pages/CliLoginPage.test.tsx`（新增） | ant-selector | cf98836d4（main） | **P4.1** | CliLoginPage 的测试。 |
| `pages/CliLoginPage.tsx`（新增） | antd-import：Alert/Button/Card/Descriptions/Result/Space/Spin/Tag | cf98836d4（main） | **P4.1** | /cli-login 在浏览器里批准 orbit login（PAT device flow）的登录类页面（Card、Descriptions、Result、Alert、Tag、Spin、Space、Button）。 |
| `pages/ProfilePage.revokeAccessTokens.test.tsx`（新增） | ant-selector | d233a6cd0（main） | **P4.1** | 个人资料页改密码时撤销令牌的测试。 |
| `pages/ProfilePage.signInMethods.test.tsx`（新增） | ant-selector、antd-text | 558a8ba1f（main） | **P4.1** | 个人资料页的登录方式（Google 关联/解绑）测试。 |
| `pages/ProfilePage.tsx`（改动） | antd-import：Avatar/Button/Card/Checkbox/Form/Input | d233a6cd0（main） | **P4.1** | P0.1 已归 P4.1；main d233a6cd0 为改密码时撤销令牌新增 Checkbox，归属不变。 |
| `pages/SettingsPage.accessTokens.test.tsx`（新增） | ant-selector | d233a6cd0（main） | **P4.1** | 设置页里的访问令牌入口测试。 |
| `pages/SettingsPage.modelRouting.test.tsx`（新增） | ant-selector | 82c7e92ff（main） | **P4.1** | 设置页的模型路由开关测试（main 82c7e92ff）。 |
| `components/AccountPause.test.tsx`（新增） | ant-selector | 0ba581f31（main）、c8cee9c19（main） | **P4.2** | AccountPause 的测试。 |
| `components/AccountPause.tsx`（新增） | antd-import：Button/InputNumber/Modal/Radio/Tag | 0ba581f31（main） | **P4.2** | Runner 与账号池凭据的手动暂停（Modal、Radio、InputNumber、Tag、Button），只在 RunnerEngines 与 AccountPools 里渲染。 |
| `components/RunnerEngines.antigravityAccounts.test.tsx`（新增） | ant-selector | 712d324a8（main） | **P4.2** | RunnerEngines 的 Antigravity 多账号测试。 |
| `components/RunnerEngines.test-helpers.ts`（新增） | ant-selector、antd-text | c8cee9c19（main） | **P4.2** | RunnerEngines 各测试共用的 .ant-dropdown 菜单查找辅助；文件名不是 test/spec，审计记为生产，实际随 RunnerEngines 的测试迁移。 |
| `components/RunnerEngines.tsx`（改动） | antd-import：Button/Dropdown/MenuProps/Popconfirm/Tag | c8cee9c19（main） | **P4.2** | P0.1 已归 P4.2；main c8cee9c19 把账号操作收进 Dropdown 溢出菜单，新增 Dropdown/MenuProps，归属不变。 |
| `pages/AdminUsersPage.accessTokens.test.tsx`（新增） | ant-selector、antd-import、antd-provider：App | d233a6cd0（main） | **P4.2** | 管理员用户页里的令牌表测试，随 AdminUsersPage 归 P4.2。 |
| `pages/AdminUsersPage.signIn.test.tsx`（新增） | ant-selector、antd-import、antd-provider：App | 558a8ba1f（main） | **P4.2** | 管理员用户页的登录方式测试，随 AdminUsersPage 归 P4.2。 |
| `pages/AdminUsersPage.tsx`（改动） | antd-import、antd-use-app：App/Button/Input/Modal/Popconfirm/Space/Spin/Table/TableColumnsType/Tag | d233a6cd0（main）、558a8ba1f（main） | **P4.2** | P0.1 已归 P4.2；main 为令牌与 Google 解绑新增 Spin，归属不变。 |
| `pages/RunnerDetailPage.antigravityAccount.test.tsx`（新增） | antd-import、antd-provider：App | 712d324a8（main） | **P4.2** | RunnerDetailPage 的 Antigravity 账号测试（AntApp 包裹）。 |
| `pages/RunnerDetailPage.selfUpdate.test.tsx`（新增） | antd-import、antd-provider：App | f22557aff（main） | **P4.2** | RunnerDetailPage 的自更新测试（AntApp 包裹）。 |
| `components/ProjectSettlementCard.tsx`（改动） | antd-import：Alert/Input/Modal | 0f47238c1（main） | **P4.3b** | P0.1 归 P4.3；结算卡属 P4.3b；main 0f47238c1 为项目完成结算流程新增的 Input/Modal 也在卡内。 |
| `components/WikiActivityPage.test.tsx`（新增） | ant-class | 6c4e0ac0e（main）、a884fda36（main） | **P4.4** | Wiki Activity 页测试。 |
| `components/WikiActivityPage.tsx`（新增） | antd-import：Button | 6c4e0ac0e（main） | **P4.4** | WikiPage 里的 Wiki Activity 页（Button）。 |
| `components/WikiHome.window.test.tsx`（新增） | antd-import、antd-provider：App | b85473546（main） | **P4.4** | 渲染 WikiPage 首页的测试（AntApp 包裹）。 |
| `components/WikiHomeContent.test.tsx`（新增） | ant-selector、antd-import、antd-provider：App | 2f9cc095f（main） | **P4.4** | 渲染 WikiPage 首页内容的测试（AntApp 包裹、.ant-* 选择器）。 |
| `components/WorkspaceView.projectSessions.test.tsx`（新增） | ant-class、ant-selector、antd-import、antd-provider：App | 68883c7cc（main）、609d4f226（main） | **P5.1** | 实际渲染 SessionSearch 会话列表里的项目条目与其 .ant-dropdown 行菜单，属会话导航（P5.1）。 |
| `components/WorkspaceView.sessionProjects.test.tsx`（新增） | ant-selector、antd-import、antd-provider：App | 634c8cb0c（main） | **P5.1** | 实际渲染 SessionSearch 会话列表的项目分组与筛选子菜单，属会话导航（P5.1）。 |
| `components/QueuedUserTurn.test.tsx`（新增） | antd-import、antd-provider、antd-text：App | 118fd4ce7（main） | **P5.2** | 渲染 Transcript 的排队消息尾部（QueuedUserTurn 由 Transcript 导出），随 Transcript 归 P5.2。 |
| `components/WorkspaceView.coordinatorChat.test.tsx`（新增） | antd-import、antd-provider：App | 00cf1c7d9（main） | **P5.3** | 渲染 WorkspaceView 的 “Chat about this” 测试（AntApp 包裹）。 |
| `components/WorkspaceView.loginPool.test.tsx`（新增） | antd-import、antd-provider、antd-text：App | f929ab1e4（main） | **P5.3** | 渲染 WorkspaceView 输入框的登录池账号测试（AntApp 包裹）。 |
| `components/WorkspaceView.taskStartWaiting.test.tsx`（新增） | antd-import、antd-provider：App | 9a7e818a2（main） | **P5.3** | 渲染 WorkspaceView 的 TaskStart 等待卡测试（AntApp 包裹）。 |
| `components/ProjectWhyNotDoneGate.test.tsx`（新增） | antd-text | ff68293bb（main） | **P6** | 只有测试数据里的 “antd migration”（以本项目为例的固定数据名），不是 antd 依赖；组件行为随 ProjectSettlementCard 由 P4.3b 复核，退役扫描里的这处文字由 P6 改名或登记为允许的说明。 |

### B. index.css 新增或改写的行

按命中原文对照；括号里是 tip 上的行号，只用于定位。

| 原文（tip 行号） | 类型 | 引入提交 | 归属 | 理由 |
| --- | --- | --- | --- | --- |
| `.composer-field textarea.ant-input,`（6348, 6371） | css-override | 81f15bef1（项目线） | **P5.3** | P3.1（81f15bef1）把输入框 textarea.ant-input 规则改成选择器列表、加上 Orbit Textarea；.ant-input 部分仍服务现有 AntD 输入框，按 P0.1 区段「WorkspaceView 输入框试点与完整切换（P3.1 → P5.3）」由 P5.3 清理。 |
| `.composer-field textarea.ant-input::placeholder,`（6382） | css-override | 81f15bef1（项目线） | **P5.3** | P3.1（81f15bef1）把输入框 textarea.ant-input 规则改成选择器列表、加上 Orbit Textarea；.ant-input 部分仍服务现有 AntD 输入框，按 P0.1 区段「WorkspaceView 输入框试点与完整切换（P3.1 → P5.3）」由 P5.3 清理。 |
| `.composer-field textarea.ant-input::selection,`（6386） | css-override | 81f15bef1（项目线） | **P5.3** | P3.1（81f15bef1）把输入框 textarea.ant-input 规则改成选择器列表、加上 Orbit Textarea；.ant-input 部分仍服务现有 AntD 输入框，按 P0.1 区段「WorkspaceView 输入框试点与完整切换（P3.1 → P5.3）」由 P5.3 清理。 |
| `.composer-field textarea.ant-input:focus-visible,`（6395） | css-override | 81f15bef1（项目线） | **P5.3** | P3.1（81f15bef1）把输入框 textarea.ant-input 规则改成选择器列表、加上 Orbit Textarea；.ant-input 部分仍服务现有 AntD 输入框，按 P0.1 区段「WorkspaceView 输入框试点与完整切换（P3.1 → P5.3）」由 P5.3 清理。 |
| `.composer-box-shell .composer-field textarea.ant-input,`（6424） | css-override | 81f15bef1（项目线） | **P5.3** | P3.1（81f15bef1）把输入框 textarea.ant-input 规则改成选择器列表、加上 Orbit Textarea；.ant-input 部分仍服务现有 AntD 输入框，按 P0.1 区段「WorkspaceView 输入框试点与完整切换（P3.1 → P5.3）」由 P5.3 清理。 |
| `.composer-box textarea.ant-input,`（6432） | css-override | 81f15bef1（项目线） | **P5.3** | P3.1（81f15bef1）把输入框 textarea.ant-input 规则改成选择器列表、加上 Orbit Textarea；.ant-input 部分仍服务现有 AntD 输入框，按 P0.1 区段「WorkspaceView 输入框试点与完整切换（P3.1 → P5.3）」由 P5.3 清理。 |
| `.project-done-not-yet .ant-input { font: inherit; font-size: 13px; }`（10764） | css-override | 0f47238c1（main） | **P4.3b** | main 0f47238c1 项目完成结算流程里 ProjectSettlementCard 的 Input/Modal 覆盖样式，随结算卡归 P4.3b。 |
| `.project-done-dialog .ant-modal-content { padding: 0; overflow: hidden; }`（10777） | css-override | 0f47238c1（main） | **P4.3b** | main 0f47238c1 项目完成结算流程里 ProjectSettlementCard 的 Input/Modal 覆盖样式，随结算卡归 P4.3b。 |
| `/* The Reopen question replaced an AntD Modal, whose line height is unitless: …`（12019） | antd-text | 5311a0cf7（项目线） | **P6** | P3.2（5311a0cf7）为 .tdp-reopen-dialog 写的、说明与被替换的 AntD Modal 行高一致的注释；不是依赖，P6 退役时改写或移入证据目录。 |
| `/* Unitless line height, as the AntD Modal this dialog replaced: smaller text …`（14170） | antd-text | 5311a0cf7（项目线） | **P6** | P3.2（5311a0cf7）为 .share-dialog 写的同类注释；P6 退役时改写或移入证据目录。 |
| `.re-runner-status > .ant-tag {`（14821） | css-override | f9dcb8807（main） | **P4.2** | RunnerEngines 卡头运行状态与账号行里 Tag 的覆盖样式（main 重画卡头、收拢账号操作时加入），随 RunnerEngines 归 P4.2。 |
| `.re-runner-card .re-row > .ant-tag {`（14971） | css-override | c8cee9c19（main） | **P4.2** | RunnerEngines 卡头运行状态与账号行里 Tag 的覆盖样式（main 重画卡头、收拢账号操作时加入），随 RunnerEngines 归 P4.2。 |
| `.re-action.ant-btn {`（15075） | css-override | c8cee9c19（main） | **P4.2** | main c8cee9c19 RunnerEngines 账号溢出菜单（Dropdown）与操作按钮的覆盖样式，随 RunnerEngines 归 P4.2。 |
| `.re-action.ant-btn-default:not(:disabled) {`（15084） | css-override | c8cee9c19（main） | **P4.2** | main c8cee9c19 RunnerEngines 账号溢出菜单（Dropdown）与操作按钮的覆盖样式，随 RunnerEngines 归 P4.2。 |
| `.re-action.re-more.ant-dropdown-open {`（15116） | css-override | c8cee9c19（main） | **P4.2** | main c8cee9c19 RunnerEngines 账号溢出菜单（Dropdown）与操作按钮的覆盖样式，随 RunnerEngines 归 P4.2。 |
| `.re-account-menu .ant-dropdown-menu {`（15126） | css-override | c8cee9c19（main） | **P4.2** | main c8cee9c19 RunnerEngines 账号溢出菜单（Dropdown）与操作按钮的覆盖样式，随 RunnerEngines 归 P4.2。 |
| `.re-account-menu .ant-dropdown-menu .ant-dropdown-menu-item {`（15133） | css-override | c8cee9c19（main） | **P4.2** | main c8cee9c19 RunnerEngines 账号溢出菜单（Dropdown）与操作按钮的覆盖样式，随 RunnerEngines 归 P4.2。 |
| `.re-account-menu .ant-dropdown-menu .ant-dropdown-menu-item-icon {`（15140） | css-override | c8cee9c19（main） | **P4.2** | main c8cee9c19 RunnerEngines 账号溢出菜单（Dropdown）与操作按钮的覆盖样式，随 RunnerEngines 归 P4.2。 |
| `.re-account-menu .ant-dropdown-menu .ant-dropdown-menu-item-danger .ant-dropdo…`（15144） | css-override | c8cee9c19（main） | **P4.2** | main c8cee9c19 RunnerEngines 账号溢出菜单（Dropdown）与操作按钮的覆盖样式，随 RunnerEngines 归 P4.2。 |
| `/* A card drawn without AntD, which components/ui has none of (docs/evidence/b…`（18476） | antd-text | 558a8ba1f（main） | **P4.1** | main 558a8ba1f 为个人资料页 .orbit-card 写的注释，以旁边的 AntD Card 为对照；P4.1 迁移资料页 Card 时一并改写。 |
| `the AntD Card it sits beside on the profile page, from the same tokens. */`（18478） | antd-text | 558a8ba1f（main） | **P4.1** | main 558a8ba1f 为个人资料页 .orbit-card 写的注释，以旁边的 AntD Card 为对照；P4.1 迁移资料页 Card 时一并改写。 |
| `.access-token-field .ant-radio-group {`（18726） | css-override | d233a6cd0（main） | **P4.1** | main d233a6cd0 NewAccessTokenDialog 里 Radio.Group 的覆盖样式，随该弹窗归 P4.1。 |
| `.wk-activity-btn.ant-btn { position: relative; overflow: visible; }`（20935） | css-override | 6c4e0ac0e（main） | **P4.4** | main 6c4e0ac0e WikiPage 头部 Activity 按钮的 Button 覆盖样式，归 P4.4。 |
| `.wk-activity-btn.on.ant-btn, .wk-activity-btn.on.ant-btn:hover { border-color:…`（20937） | css-override | 6c4e0ac0e（main） | **P4.4** | main 6c4e0ac0e WikiPage 头部 Activity 按钮的 Button 覆盖样式，归 P4.4。 |
| `.account-pause-durations .ant-radio-button-wrapper {`（22281） | css-override | 0ba581f31（main） | **P4.2** | main 0ba581f31 AccountPause 里 Radio.Button 的覆盖样式，随 AccountPause 归 P4.2。 |

### C. 迁移项目线自身产生的使用点

| 路径 | 类型 | 引入提交 | 归属 | 理由 |
| --- | --- | --- | --- | --- |
| `components/WorkspaceView.composerMenu.test.tsx` | ant-class、ant-selector、antd-import、antd-provider、antd-text：App | 81f15bef1（项目线） | **P5.3** | P0.1 已归 P5.3；P3.1（81f15bef1）把对 textarea.ant-input 规则的源码断言改成选择器列表并加了一处说明，归属不变。 |
| `components/ui/Floating.css` | antd-text | 1a70fbb90（项目线） | **P6** | Orbit 浮层样式里说明与 AntD 对齐的注释（P2.2）；P6 退役时改写或移入证据目录。 |
| `components/ui/MultiSelect.tsx` | antd-text | 1a70fbb90（项目线） | **P6** | Orbit MultiSelect 里说明与 AntD 对齐的注释（P2.2）；P6 退役时改写。 |
| `components/ui/README.md` | ant-selector、antd-text | 1a70fbb90（项目线）、297d33e97（项目线）、5bea0a3f6（项目线）、df79e55f7（项目线）、3389ce299（项目线）、81f15bef1（项目线）、5311a0cf7（项目线） | **P6** | components/ui 使用约定里与 AntD 对照、说明替代关系的文字（P1.1–P3.1 写入）；不是运行时依赖，但退役扫描会拦，P6 移除 AntD 时改写或移入证据目录。 |
| `components/ui/Select.tsx` | antd-text | 1a70fbb90（项目线）、31aa07c91（项目线） | **P6** | Orbit Select 里说明与 AntD 对齐的注释（P2.2）；P6 退役时改写。 |
| `components/ui/SelectEmpty.tsx` | antd-text | 1a70fbb90（项目线） | **P6** | Orbit Select 空状态里说明与 AntD 对齐的注释（P2.2）；P6 退役时改写。 |
| `components/ui/TextControls.css` | antd-text | 297d33e97（项目线）、3dd6e9b51（项目线）、81f15bef1（项目线） | **P6** | Orbit 文本控件样式里说明与 AntD 对齐的注释（P1.2/P3.1）；P6 退役时改写或移入证据目录。 |
| `components/ui/Textarea.tsx` | antd-text | 297d33e97（项目线）、81f15bef1（项目线） | **P6** | Orbit Textarea 里说明与 AntD 对齐的注释（P3.1）；P6 退役时改写。 |
| `components/ui/__fixtures__/ChoicesFixture.css` | ant-selector、antd-text | 1a70fbb90（项目线）、6e3e4f464（项目线） | **P6** | ChoicesFixture 的 AntD 参照样式（P2.2/P3.2），随该样例由 P6 处理。 |
| `components/ui/__fixtures__/ChoicesFixture.tsx` | antd-import、antd-provider：App/Button/ConfigProvider/Dropdown/Modal/Popover/Select/Tooltip | 1a70fbb90（项目线） | **P6** | ui-migration 浏览器对照用的 AntD 参照样例（P2.2），故意导入 antd 渲染旧实现；antd 移除时须一并删除或改为只渲染 Orbit 组件。 |
| `components/ui/__fixtures__/ComposerFixture.css` | ant-selector、antd-text | e207a13eb（项目线）、076e4ad0c（项目线） | **P6** | ComposerFixture 的 AntD 参照样式（P3.1/P3.2），随该样例由 P6 处理。 |
| `components/ui/__fixtures__/ComposerFixture.tsx` | antd-import、antd-provider、antd-text、internal-ref：App/Avatar/Button/ConfigProvider/Image/Input | e207a13eb（项目线） | **P6** | ui-migration 输入框对照用的 AntD 参照样例（P3.1），含 TextArea 内部 ref；antd 移除时须一并处理。 |
| `components/ui/__fixtures__/ControlsFixture.css` | ant-selector | 297d33e97（项目线） | **P6** | ControlsFixture 的 AntD 参照样式（P1.2），随该样例由 P6 处理。 |
| `components/ui/__fixtures__/ControlsFixture.tsx` | antd-import、antd-provider、antd-text：App/Button/Checkbox/ConfigProvider/Input/Radio/Spin/Switch/Tag | 297d33e97（项目线） | **P6** | ui-migration 基础控件对照用的 AntD 参照样例（P1.2）。 |
| `components/ui/__fixtures__/FoundationFixture.tsx` | antd-import、antd-provider、antd-text：App/Button/ConfigProvider/Modal | 5bea0a3f6（项目线） | **P6** | ui-migration 主题基础对照用的 AntD 参照样例（P1.1）。 |
| `components/ui/__fixtures__/OverlaysFixture.tsx` | antd-imperative、antd-import、antd-provider、antd-text、antd-use-app：App/Button/ConfigProvider/Drawer/Input/Modal/Popconfirm/Select | df79e55f7（项目线） | **P6** | ui-migration 弹层对照用的 AntD 参照样例（P2.1），含 useApp 与 modal.confirm。 |
| `components/ui/__fixtures__/ToastsFixture.tsx` | antd-imperative、antd-import、antd-provider、antd-use-app：App/ConfigProvider | e361ee373（项目线） | **P6** | ui-migration 通知对照用的 AntD 参照样例（P2.3），含 useApp 与 modal.confirm。 |
| `components/ui/boundary.test.ts` | antd-text | 5bea0a3f6（项目线） | **P6** | 断言 components/ui 不导入 antd 的负向测试（P1.1）；P6 决定保留为允许的负向断言还是改写，不得为过扫描删掉有效断言。 |

### D. P0.1 条目重新归属

原 P4.3 已拆成 [P4.3a](orbit-task:34Za39GvWRQ08ZmKOpFNe)（任务与项目的列表、详情页和工具栏，含其中的状态、调度、分享入口组件）和 [P4.3b](orbit-task:34blYpxEcHMAf4oafuC2W)（任务/项目依赖图，以及决策、审阅、结算、确认类卡片）。P0.1 中所有仍有使用点的 P4.3 条目都在记录里细分了，逐项理由见 JSON 的 `reason`。

划分依据：
- 按组件的功能和实际渲染位置决定：渲染关系用模块引用核实过，见每条的 `reason`。
- 页面级测试（`pages/ProjectsPage*.test.tsx` 等）随页面归 P4.3a。P4.3b 的组件出现在这些页面里时，P4.3b 也要跑这些测试。
- StartProjectCard 与 ProjectRunSettings 在 index.css 共用两条单选规则（`.start-card-* , .project-run-* .ant-radio…`）。按选择器拆开：start-card 归 P4.3b，project-run 归 P4.3a，两批各删自己的选择器。规则前的两行说明记在 P4.3b，由后完成的一批删除，并写进关闭记录。ProjectRunSettings 只从 StartProjectCard 引用 `START_MAX_CONCURRENT_TASKS` 常量，不共用控件。

- **P4.3a（44 个文件，index.css 38 行，含判定的 5 个文件和 3 行）**：
  - 页面：`pages/ProjectsPage`、`pages/TaskDetailPage`、`pages/TaskListView`、`pages/TaskRoute`；
  - 组件：`ProjectsToolbar`、`ProjectSections`、`ProjectShareControls`、`ProjectPanoramaHeader`、`ProjectGoalCard`、`ProjectAcceptanceCard`、`ProjectChainProgress`、`ProjectCoordinatorCard`、`ProjectReadyToRun`、`ProjectRunSettings`、`TaskScheduleEditor`、`TaskAttributionCard`、`MentionDeliveryNotes`；
  - 协调者判定归入的：`ProjectBlockers`（含测试和 `.project-blockers-*` 三行）、`ProjectProgressStatus`（含测试）、`TaskDependencyList`；
  - 上述组件的 7 个测试，以及 15 个页面级测试（ProjectsPage*、ProjectCoordinatorSection、ProjectDetailPanorama、ProjectTasksTopology、TaskListView*、TaskRoute）；
  - index.css：TaskListView 范围菜单与过滤计数、项目详情元信息/目标/待运行/运行设置/任务行、验收卡、项目工具栏分段、WatchRelations 浮层。
- **P4.3b（17 个文件，index.css 13 行，含判定的 1 个文件）**：
  - 决策、审阅、结算、确认类卡片：`AcceptanceConfirmationCard`、`ConfirmationReviewTurnCards`、`CoordinatorQuestionCard`、`CriteriaChangeCard`、`CriteriaDecisionCard`、`DecisionRail`、`EvidenceDecisionCard`、`OwnerConfirmationCard`、`OwnerConfirmationReopen`、`OwnerConfirmationReview`、`ProjectPromotionCard`、`StartProjectCard`；
  - 依赖图：`ProjectDependencyGraph`、`TaskDependencyGraph`、`ProjectTasksGraph`（及其测试）；
  - 协调者判定归入的：`ProjectCrossingsCard`；
  - `ProjectSettlementCard` 因 main 有改动，列在 A 表；
  - index.css：依赖图标题与全屏弹窗、启动卡单选及其说明。
- **曾待协调者的 4 个问题**已判定，见下节。
- **KEEP 复核批次**（`reviewPhases`，这些文件没有使用点）：
  - P4.3a：`ProjectIntegrationLine`、`ProjectPageBlocks`、`ProjectTaskLink`、`ProjectTaskPanel`、`TaskProgressBlock`、`TaskStatusPill`；
  - P4.3b：`BatchGraph`、`CardAction`、`CardHotkey`、`OpenItemDeliveryCard`、`ProjectStartedCard`、`RunSettingsSummary`。

已完成阶段遗留的使用点改由 P6 负责（7 个文件）：

| 路径 | P0.1 | 现归属 | 理由 |
| --- | --- | --- | --- |
| `components/StatusTag.tsx` | P1.2 | **P6（删除）** | 死代码。`src/web` 里没有任何对它的引用，P0.1 基线时也没有：当时唯一的 `StatusTag` 是 RunnerEngines 内的同名局部函数，main 0ba581f31 之后也没了。P1.2 按其 README 只建了 Badge、没有切换业务调用。P6 删除这个文件即可关闭这处 antd `Tag` 导入。 |
| `components/ToastViewport.tsx`、`lib/toast.tsx`、`lib/toastStore.ts` | P2.3 | **P6** | P2.3 已完成，按 P0.1 只保留验证；剩下的是说明替代 AntD message 的注释，`--check-retired` 会拦。 |
| `components/TaskDetailPanel.test.tsx` | P3.2 | **P6** | P3.2 已关闭它的 `.ant-*` 选择器，剩一句说明 antd Tooltip 空标题行为的注释。 |
| `indexCss.test.ts`、`lib/toast.test.tsx` | P1、P2 | **P6** | 只剩提到 AntD 历史行为的注释。 |

## 与 P1–P3 关闭记录的对照

`closed` 共 34 项（14 个文件，20 行 index.css），每项写明关闭提交和对应的关闭记录。这些都已经关闭，不再计入待迁移：

- **P3.2**（`closureRecord: p3.2/inventory-closure.json`，c4cc93eb7）：
  - 生产文件：TaskDetailPanel、ShareModal、TaskInputs、AccountSelect；
  - 测试：ShareModal、TaskDetailPanel.modelRouting/share/test、ProjectShareControls、WorkspaceView.shareEntry、RunnerDetailPage.codexAccount、SharedLinksPage 的 `.ant-*` 选择器（部分测试只关闭了一部分，`remaining` 列出剩下的）；
  - index.css：「TaskDetailPanel」「TaskDetailPanel compose」「ShareModal」三个区段的 13 行全部删除。

  这些与 P3.2 的关闭记录逐项对应。`.tdp-compose .ant-input` 先被 P3.1（81f15bef1）改写成选择器列表，再由 P3.2 删除。
- **P3.1**（81f15bef1）：输入框区段的 6 种 `textarea.ant-input` 选择器改写成了选择器列表（`disposition: rewritten`），`.ant-input` 部分仍在，仍归 P5.3，记在 B 表的 `changed` 行。P3.1 没有切换任何业务文件。
- **P1.1 / P1.2 / P2.x**：只建了 `components/ui` 和对照样例，没有切换业务页面，与各自 README 一致。它们自身新增的注释和样例见 C 表，归 P6。
- **main 自行关闭的**：
  - `pages/LoginPage.tsx`：14ed14ace 重做登录页，改用 Orbit `ui/Button`，antd 导入全部消失，P0.1 的 P4.1 条目已无使用点；
  - `components/AccountPools.tsx` 的 `Tag`：0ba581f31 移到 AccountPause；
  - index.css 的 `.re-act .re-icon.ant-btn:not(:disabled)`：c8cee9c19。

  这些不需要再迁移。P4.1 和 P4.2 开工时仍应复核相关测试与样式。

## 协调者的决定

第一份记录把 4 个原 P4.3 内部的分界问题（9 个点）列为 `pending`：组件按功能属于一批，却渲染在另一批的页面里。协调者 2026-10-07 在退回第 1 版证据（38IfqZvjjfRG2lpbvFKqOb）时全部按建议判定，写在 [2026-10-07b.json](2026-10-07b.json)：

| 组件 | 涉及的点 | 决定 | 测试要求 | 原来拿不准的原因 |
| --- | --- | --- | --- | --- |
| `ProjectBlockers` | 组件、测试、`.project-blockers-*` 3 行 | **P4.3a** | P4.3b 改 ProjectPromotionCard 时跑它的测试 | 渲染在 ProjectsPage 详情页，也嵌在 ProjectPromotionCard 晋升确认卡里，还带“解决说明”表单。 |
| `ProjectProgressStatus` | 组件、测试 | **P4.3a** | P4.3b、P5.3 改到渲染它的卡片或页面时跑它的测试 | 在 ProjectsPage、ProjectCoordinatorCard、ProjectPromotionCard 和 WorkspaceView 里都会渲染。 |
| `ProjectCrossingsCard` | 组件 | **P4.3b**（决策卡，按功能） | P4.3a 改 ProjectsPage 详情页或 TaskAttributionCard 时跑相关测试 | 带批准/拒绝确认，但渲染在 ProjectsPage 详情页和 TaskAttributionCard 里。 |
| `TaskDependencyList` | 组件 | **P4.3a**（列表，属任务详情） | — | 在 TaskDetailPanel 的依赖视图里与依赖图切换显示，它是列表不是图。 |

现在两份记录合起来没有待定点。以后再有拿不准的点，照同样的做法处理：先在记录里列为 `pending`，协调者判定后再新增一份排在其后的记录。

## 复扫规则（各批开工和交证据前必做）

适用于 P4.1、P4.2、P4.3a、P4.3b、P4.4、P5.x、P6 及以后任何改动 `src/web/src` 的任务。

1. **开工时**：本批工作树刚从项目 tip 建好、还没改动时，运行下面两条，把输出存进本批证据。项目线每次吸收 main 都可能带来新的使用点，开工时的结果就是本批的起点。

   ```sh
   node src/web/scripts/audit-antd.mjs                  # 计数摘要
   node src/web/scripts/audit-antd.mjs --check-owners   # 归属检查，只读
   ```

2. **处理 `unowned`**：`--check-owners` 退出 1 时，逐个看列出的使用点：
   - **在本批范围内**（按页面和功能，范围见记录的 `batches` 和本批任务描述）：本批一并迁移，并在本批关闭记录里写明路径、类型和引入提交。
   - **不在本批范围内**：不要自己登记归属，也不要去改别批的代码。报告协调者，写明路径（index.css 写原文和行号）、类型、引入提交（`git log -S` / `git blame`）和建议批次。由协调者或其指定的登记任务新增一份带日期的增量记录来补登归属。
3. **`pending` 的点**：等协调者定了再迁移，不要先动。
4. **交证据前**：再跑一遍上面两条命令。
   - `unowned` 必须为 0；本批开工后新出现的点要么已迁移，要么已报告协调者，并在证据里写明。
   - `owners` 里本批的计数应降为 0；还有剩余的，逐项写明原因。
   - 关闭记录可以照 [p3.2/inventory-closure.py](../p3.2/inventory-closure.py) 的做法，从同提交参照树和交付树两次 `--json` 生成。
5. **不改原有基线**：不改 P0.1 原始文件，也不改已有的增量记录来消掉缺口。新事实写新的带日期记录，格式与本记录相同，可用 `build-record.py` / `build-decision.py` 的做法生成，用 `verify-record.mjs` 核对。新记录的文件名要排在它补充的记录之后（同一天用 `b`、`c` 后缀，见[记录怎么读](#记录怎么读)）。
6. **P6**：
   - `--check-owners` 必须 0 `unowned`、0 `pending`；
   - `--check-retired` 必须退出 0；
   - 照 P0.1 README 的「P6 退役入口」做人工复核和依赖树检查。
   - 注意 `src/web/ui-migration/` 不在 audit-antd.mjs 的扫描范围内，按作业指导 P6 要另行扫描该目录的 `.ant-*` 定位器。

## `--check-owners` 的判定规则

- **owner 来源**：
  - P0.1：`ownership.json`（生产文件）、`routes-and-tests.md`（测试，按小节阶段）、`css-ownership.json` 加 `audit-baseline.json`（index.css 每行按原文找到所在区段）；
  - 增量记录：本目录下所有 `YYYY-MM-DD*.json`，按文件名顺序读取，后读的覆盖先读的。`status: "reassigned"` 的 css 条目改写同一原文在 P0.1 中的 owner；其他条目追加 owner。
- **P0.1 owner 何时有效**：只在文件的“特征”（antd 符号和使用点命中类型的集合）没有超出 P0.1 基线时成立。文件新增了符号或类型，就必须由增量记录登记。这样 main 往已有文件里加 antd 组件不会被旧归属悄悄盖住。行数变多但类型不变，仍由原 owner 负责。
- **不算 owner**：`inactiveOwners` 中的代码（已完成的阶段和已拆分的 P4.3）。归属是 `A → B` 写法的，取最后一个。
- **输出与退出码**：输出 JSON，包括 `owners`（各批负责的使用点数）、`pending` 和 `unowned`。
  - 有 `unowned` 时退出 1；
  - 与其他参数同用时退出 2；
  - 只读，不写任何文件。
- **原有输出不变**：默认摘要、`--json`、`--check-retired`、`--json --check-retired` 和未知参数这五种调用，与修改前的脚本逐字节相同，退出码相同（见 `checks/outputs-unchanged.txt`）。`--help` 只追加了两行说明。
- **局限**：
  - 词法扫描的局限与 P0.1 相同：看不到计算出的模块名、拼接类名和间接别名。
  - index.css 中原文完全相同的多行按出现次数匹配，不区分具体是哪一行。
  - 候选命中（`message.*`、`*.confirm`、`ref.focus`）单独出现时不判定为使用点。
  - P0.1 已定为 KEEP 且特征没变的文件仍算 KEEP，例如 `WikiMarks.tsx` 里的一句 AntD 注释，P6 的 `--check-retired` 仍会拦它。

## 复现与验证

从仓库根目录运行，只需 Node 和 git。`bash docs/evidence/base-ui-migration/inventory-delta/checks/run-checks.sh` 会一次跑完下面除构建/测试外的各项，把输出写进 `checks/`，任一项不通过即退出非 0。

```sh
D=docs/evidence/base-ui-migration/inventory-delta
# 两份记录都由扫描于 7732f14f8 的审计（checks/antd-audit.json，不会被重写）生成，逐字节重建；git 历史须含该提交。
python3 $D/build-record.py $D/checks/antd-audit.json 2026-10-07 | cmp - $D/2026-10-07.json
python3 $D/build-decision.py | cmp - $D/2026-10-07b.json
# 新审计只要 scopeHash 与记录相同（本任务的提交不改 src/web/src），就能逐份核对记录。
node src/web/scripts/audit-antd.mjs --json > /tmp/antd-current.json
node $D/verify-record.mjs /tmp/antd-current.json 2026-10-07.json
node $D/verify-record.mjs /tmp/antd-current.json 2026-10-07b.json
node src/web/scripts/audit-antd-selfcheck.mjs
node src/web/scripts/verify-antd-inventory.mjs
node src/web/scripts/audit-antd.mjs --check-owners
npm run build -w @orbit/web && npm run test -w @orbit/web
```

`src/web/src` 改动之后，`verify-record.mjs` 的 scopeHash 断言会失败，这是预期的：两份记录只描述这一次扫描。以后各批用 `--check-owners` 检查归属，有新事实就写新记录。

本次结果（第 2 版，原始输出在 [checks/](checks/)）：

| 检查 | 结果 |
| --- | --- |
| 审计两次 `--json` | 逐字节一致；scopeHash 与记录所用的审计相同（`checks/audit-repeat.txt`；记录所用审计 `checks/antd-audit.json`，697 KB） |
| `audit-antd-selfcheck.mjs` | 原有自检与新增 owner 自检都通过（`checks/selfcheck.txt`） |
| `verify-antd-inventory.mjs`（P0.1 覆盖，不带参数） | 通过，149 个归属、37 种契约、287 个测试、187 个 CSS 命中，与修改前相同（`checks/p01-verify.txt`） |
| `build-record.py` / `build-decision.py` 重新生成 | 两份记录都逐字节一致（`checks/rebuild.txt`） |
| `verify-record.mjs` | 两份记录都通过，见上文结论（`checks/verify-record.txt`） |
| `--check-owners` | 退出 0：读两份记录，0 `unowned`、0 `pending`（`checks/check-owners.json`） |
| 原有输出不变 | 五种调用逐字节相同（`checks/outputs-unchanged.txt`） |
| P0.1 原始文件 | 与 tip 无差异（`checks/p01-unchanged.txt`） |
| 项目合并检查 | 通过：`tsc -b && vite build` 成功，只有 Vite 的大 chunk 提示；Vitest 344 个测试文件、4379 个用例全部通过（262 s；bg_run `bgj_493a7111d3a8` 退出 0，`checks/merge-check.txt`） |

第 1 版的合并检查（bg_run `bgj_2f2e2ec273ae`）也已通过：344 个测试文件、4379 个用例。

本任务进行期间，项目分支又前进到 `058beb463`（P0 漂移第 3 批、P2/P3 补强和一次 main 吸收）。其中落在审计范围内的只有两处，合并后不会出现新的使用点，`--check-owners` 的结论不变：
- `src/web/src/components/ui/README.md`：只改一行，命中种类和数量不变，仍是 antd-reference 11、ant-selector 2、ant-class 2；
- 新增的 `src/web/src/components/ui/Select.test.tsx`：没有任何 antd 命中。

## 证据体积

本目录全部为文本，合计约 927 KB，没有截图、trace 或报告附件。合并检查的完整原始日志留在 `/var/tmp/antd-delta-34bk/`，不提交；`checks/merge-check.txt` 只保留构建输出和测试汇总，运行本身由 Orbit 的 bg_run 作业记录。
