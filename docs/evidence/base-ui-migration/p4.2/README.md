# P4.2 Provider、Runner、账号池与用户管理

服务于 [P4.2 迁移 Provider、Runner、账号池与用户管理](orbit-task:34Za39Feocgj42rrBYwzl)，项目验收条目 key `hnPVsE0kmorHXurrs4Qdp`：**P4：全部非会话业务界面完成迁移，既有页面操作和响应式呈现保持一致。** 本任务承担其子范围：本批管理页面的既有操作、权限呈现、确认流程和响应式表格保持一致；加载/空/错误状态可验证，相关回归通过，本批 AntD 使用点关闭。

本批在项目分支 tip `3aa26fb97`（P4.1 交付）上开工，交付过两版：

- **第 1 版**：按协调者转告的“跟上 origin/main”，rebase 到 `7e4655bc2` 后交付（证据第 1 版）。对照本身成立，但分支落不了地，被退回（SEND_BACK）：
  - 和项目 tip `1d3cd4c70` 合并时，`inventory-delta/README.md` 冲突（07c、07d 两份记录在同一处各加了一行）；
  - 和 origin/main 合并时，同一 README 与 `AdminUsersPage.tsx` 冲突（main fce7a19cf 的 X1：管理员停用、恢复账号）。
- **第 2 版（本文）**：按退回要求，以当时最新的 origin/main 为准重新接基础。对照开跑后，main 和项目分支又前进了几次，每次都接上新基础从头重跑（见[跟上 origin/main](#跟上-originmain)）。
  - 最后一轮：本批 4 个提交接在项目 tip `dea1d8128` 上（origin/main `075b7a6c8` 加 P0 漂移登记第 5 批），同提交对照在交付 `822c00ff0` 上跑完。
  - 交证据前，项目分支已并入 main，于是把当时最新的 origin/main `710c66e6d` 合了进来（`a794459b1`）。在合并后的 tip 上重跑了合并检查、标准 P0、组件矩阵、P4.1 用例、P3.2 试点和交付自己的截图，清单记录也在那里重建。
  - 冲突都已解决：README 两份记录的行都保留；AdminUsersPage 保留 X1 的行为，用 Orbit 组件实现。

第 1 版和第 2 版前几轮的对照留作过程记录，见[过程记录](#过程记录)。

## 结论

- **迁移**：
  - 本批 17 个生产文件不再导入 antd，含 main 新增的 `DeepSeekBalance`。
  - Provider 密钥表与管理员用户表改为原生 `table.orbit-table`。
  - 10 个 `modal.confirm` 与 1 个 `modal.success` 改为局部的 `useConfirm`/`ConfirmDialog`。
  - X1 的停用/恢复在原生表格上，用 Orbit 组件实现。
  - 查询、变更、请求体与路由都不变。
- **清单**：
  - 本批 81 个使用点和 main 带来、落在本批页面里的 3 个点全部关闭：同提交参照是 81 + 3，交付是 0。
  - 合并 origin/main 之后的 tip `a794459b1` 上，`--check-owners` 为 0 未归属、0 待定。
  - 重建的 `2026-10-07c.json` 通过 `verify-record.mjs`。
- **同提交对照**：交付 `822c00ff0` 对参照 `60f16a6ee`，覆盖 Chromium/WebKit × 明/暗 × 桌面/手机八个环境。
  - **P4.2 用例**：两棵树各 180 通过。644 张截图中，364 张逐字节相同、221 张抗锯齿级、59 张超出。超出的全部归类：45 张边缘栅格化、6 张 WebKit 桌面对话框滚动锁、4 张 WebKit 手机 382/390、4 张 Tooltip 贴边。X1 的 32 张截图全部逐字节相同。
  - **trace**：共 912 步，地址、请求、通知、alert 全部相同。菜单只有 6 步不同，都是参照的 AntD 下拉还在入场动画里。
  - **P0 页面矩阵**：252 张截图 0 张超出；参照、0 像素严格比较、交付各 101 通过。
- **回归**：
  - 交付 `822c00ff0` 上全部通过：标准 P0（交付、起点各 101 通过）、合并检查（368 个文件、4753 个测试）、overlays 96、controls 32；P4.1 用例与 P3.2 试点在起点和交付上也各自全过。
  - 合并 origin/main 之后的 tip 上：标准 P0（101）、合并检查（368 个文件、4754 个测试）、overlays 96、controls 32、P4.1 96、P3.2 试点 81、P4.2 180、P0 矩阵 101 全部通过；交付自己的截图与 `822c00ff0` 上相比，只有同一份代码两次运行之间也会出现的差别（见[合并 origin/main 之后](#合并-originmain-之后)）。
- **未消除的差异**都已由协调者判定，或早有记录：
  - WebKit 桌面对话框滚动锁：协调者另建了修复任务；
  - Tooltip 贴边 8px、固定引擎的灰色勾选：协调者已接受；
  - WebKit 手机确认浮层 382/390：P2.3-B1、P4.1 已记录。

## 范围

开工时按复扫规则运行 `audit-antd.mjs` 与 `--check-owners`：P4.2 负责 81 个使用点。新基础上的参照树（撤回本批业务切换）同样是这 81 个点，另有 main 带来、落在本批页面里的 3 个未归属点，协调者判定由本批迁移：`DeepSeekBalance.tsx`、`RunnerEngines.accountFold.test.tsx` 和 X1 的 `AdminUsersPage.disable.test.tsx`。逐点列表见 [inventory-closure.json](inventory-closure.json) 的 `before.p42` 与 `before.unowned`。

- 审计记为“生产”的 18 个文件：
  - `components/` 下 10 个：`AccountPause`、`AccountPools`、`ClaudeHistoryOffer`、`CodexSignIn`、`DeepSeekBalance`、`RunnerEngines`、`RunnerEnginesSection`、`RunnerRegisterGuide`、`RunnerTokenRotation`、`SharedPool`；
  - `pages/` 下 7 个：`AdminUsersPage`、`EnrollPage`、`ProviderConnectPage`、`ProviderPoolPage`、`ProvidersPage`、`RunnerDetailPage`、`RunnersPage`；
  - `RunnerEngines.test-helpers.ts`（测试辅助，文件名不是 test/spec，所以审计记为生产）。

  前 17 个导入 antd。`DeepSeekBalance` 来自 main 936ebbd3c（Providers 列表与 Provider 编辑页的 DeepSeek 账户余额）。
- 测试 24 个：
  - `AccountPause.test`；
  - `RunnerEngines` 的 `.accounts`、`.antigravityAccounts`、`.claudeAccount`、`.duplicateAccount`、`.removeAccount`、`.renameAccount`、`.singleAccount`，以及 main 16d157656 新增的 `.accountFold`；
  - `AdminUsersPage` 的 `.accessTokens`、`.signIn`，以及 main fce7a19cf（X1）新增的 `.disable`；`ProviderConnectPage.gemini`；`ProviderPoolPage` 的 `.access`、`.whoCanUseIt`；
  - `ProvidersPage` 的 `.codexLogin`、`.pools`、`.sharedPools`；
  - `RunnerDetailPage` 的 `.antigravityAccount`、`.codexAccount`、`.layout`、`.modelRouting`、`.selfUpdate`；
  - `RunnersPage.test`。
- index.css 42 行：本批页面的 `.ant-*` 覆盖样式，以及提到 AntD 的注释。
- `routes-and-tests.md` 列出的命令式调用中，归本批的有 10 个 confirm 和 1 个 success：
  - confirm：`RunnerDetailPage` 6 个、`RunnersPage` 1 个、`RunnerTokenRotation` 1 个、`SharedPool` 2 个；
  - success：`AdminUsersPage` 1 个。

为完成切换还改了下面这些文件，每处都有直接原因：

| 文件 | 归属 | 改动与原因 |
| --- | --- | --- |
| `pages/CliLoginPage.tsx` | P4.1 页面（无 antd） | 它自带的标签-值表和结果块收为公共 `Descriptions`、`Result`（注册确认页也需要），页面改用公共组件，index.css 去掉 `.cli-login-*` 那段样式。渲染不变，见[起点对照](#起点对照p41-用例与-p32-试点) |
| `docs/evidence/base-ui-migration/inventory-delta/` | 清单增量 | 按协调者要求新增 `2026-10-07c.json` 及其生成脚本，README 的产物表加两行 |
| `ui-migration/playwright.config.mjs` | 标准 P0 配置 | P0 矩阵忽略 `p42*.browser.mjs` |
| `ui-migration/p41.browser.mjs` | P4.1 用例 | Session defaults 卡里的开关按名称取（`822c00ff0`）。main def134095 在这张卡里加了第二个开关，原来的 `getByRole('switch')` 在新基础上触发严格模式冲突 |

## 跟上 origin/main

**第 1 版**（rebase 到 `7e4655bc2`，从 `3aa26fb97` 起）：

- 冲突只有两处 import 块（`ProvidersPage`、`ProviderConnectPage`），是 main 的 DeepSeek 余额导入和本批的 Orbit 组件导入撞在一起，两边都保留。
- main 在本批文件里的其它改动自动合并：`RunnerEngines` 的登录将过期提示、登出后的说明与运行器卡片的折叠三角；`AdminUsersPage` 的 Google 登录说明 `GOOGLE_SIGN_IN_ONLY_HINT`；`RunnerEngines.singleAccount`、`AdminUsersPage.signIn` 两份单测的新断言，合进了已改为按角色和名称定位的版本。
- main 新增、落在本批页面里的 antd 使用点 `DeepSeekBalance.tsx`（两处 antd `Button`），在业务切换提交里迁移：刷新和重试用 Orbit `Button size="small"`，保留 loading；充值用 `LinkButton variant="primary" size="small"`，仍是新标签页打开的 `<a>`。main 的 `DeepSeekBalance.test.tsx` 不用改就通过。
- P4.2 浏览器用例：Add user 的 Google 说明断言随 main 的新文字更新；新增 DeepSeek 余额用例（P0 和原有 P4.2 固定数据都走不到余额区）。

**第 2 版**：每接上一次新基础，对照链都从头重跑，结论只取第 5 轮；第 6 轮在合并后的 tip 上重跑交付一侧。

| 轮 | 基础 | 交付 / 参照 | 对照链 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | origin/main `01e794977`（已含项目 tip `1d3cd4c70`） | `97ab985d4` / `b201ebe94` | bgj_e44e4219a708 | 参照的 P4.2 跑完（180 通过）后，main 前进到 `def134095`，停下重接 |
| 2 | origin/main `def134095` | `54622530e` / `c6bc33e86` | bgj_b920b99fff59 | 跑完，本批的部分全过。另有 main 带来的红，起点树（即 main 本身）同样失败，见表下 |
| 3 | origin/main `bcc89c7af` | `8af0c298d` / `1400754db` | bgj_df81ceb65a19 | main bcc89c7af（折叠头点哪里都能折叠）改了本批的 RunnerEngines、AccountPools 与 index.css，所以重跑。跑完，本批的部分全过，main 带来的红同上 |
| 4 | origin/main `075b7a6c8` | `36e79a059` / `61ef054c1` | bgj_2f14f3031ffe | main 74ecbdad8（Providers 页加 OpenCode 一行）又改了 RunnerEngines、RunnerEnginesSection 与 index.css。参照的 P4.2 跑到一半时，P0 漂移登记第 5 批落到项目分支，停下重接 |
| 5 | 项目 tip `dea1d8128`（origin/main `075b7a6c8` 加 P0 漂移登记第 5 批） | `822c00ff0` / `60f16a6ee`，起点 `b478f5f57` | bgj_617df5ce5b36，续跑 bgj_697cf54043a5 | 跑完，全部通过，就是下文的对照结果 |
| 6 | 合入 origin/main `710c66e6d` 之后的 `a794459b1` | `a794459b1` | bgj_f5926361ec25 | 交付一侧重跑，见[合并 origin/main 之后](#合并-originmain-之后) |

- **第 2、3 轮里 main 带来的红**（起点树即 main 本身，同样失败）：
  - main 2ba6765d9 的 Wiki 分享让 wiki 页发出 `GET /api/wiki/spaces/:id/share`，P0 固定数据没有这条路由。P0 矩阵三次运行各 12 个失败（wiki 8 个、断点 4 个）。
  - main def134095 加了 “Suggested replies” 开关，没有登记。标准 P0 交付与起点各 20 个失败（上一项的 12 个，加 settings 8 个）。
  - P4.1 settings 用例 8 个失败。
  - 前两项由协调者的 P0 漂移登记第 5 批解决，第三项由本批的 `822c00ff0` 解决（见[提交](#提交)）。
- **第 5 轮的磁盘停顿**：中途根分区低于 2 GB，链在两步之间按规则停下；空间回升后，从断点续跑。
- **冲突**：只在第 1 轮，只有 `AdminUsersPage.tsx`：main fce7a19cf（X1）给 AntD 表格加了 Status 列和 Enable/Disable。第 1 版的证据提交没有带过来：07c、它的 README 行和本目录都在新基础上重新生成，`inventory-delta/README.md` 里 07c 和 07d 的行都保留。之后几次 rebase 都没有冲突。
- **X1 搬到原生表格上**，行为不变：
  - Status 列在 Role 之后：停用的账号显示 `Badge tone="error"` 的 Disabled，悬停提示 `Disabled on <日期>`；其余显示 Active；
  - 行操作里：停用的账号有 Enable，其余账号有 Disable，管理员自己的那一行两者都没有（`meQuery`）；
  - Disable 先经 `useConfirm` 确认，说明会停止什么、什么都不删；服务器拒绝时，拒绝原因以 `role=alert` 显示在这个确认框里；Enable 不问，直接恢复；
  - 请求仍是 `PATCH /admin/users/:id/disabled`，通知文字不变。
- **X1 的单测** `AdminUsersPage.disable.test.tsx` 改为按原生表格的行和表头定位，去掉 AntD `App` 包裹，断言不变。
- **P4.2 浏览器用例**新增 X1 一例：谁能看到哪个按钮、被拒（拒绝原因在确认框里）、确认、已停用、恢复。固定数据加了一个已停用的账号和 `PATCH …/disabled` 的应答。
- **main 写进本批文件的新代码**：第 4 轮 74ecbdad8 的 `<Button size="small" disabled>Sign in</Button>` 在本批的文件里解析为 Orbit Button，不需要额外迁移。
- **main 新带来的未归属点**都不在本批页面里，按协调者 2026-10-08 的判定写进重建的 `2026-10-07c.json`，见[协调者转告的事项](#协调者转告的事项)。
- **第 6 轮**：
  - 交证据前，项目分支已并入 main（6a58a9515），项目 tip 在 main 里，没有 main 之外的提交。按协调者 03:10Z 的规则，把当时最新的 origin/main `710c66e6d` 合进本分支（`a794459b1`），无冲突。
  - main 自 `dea1d8128` 以后在 src/web 只有一个提交 f7c90a1b7：会话页失败卡片的 Retry 先问服务端。它改了 `WorkspaceView.tsx`、`Transcript.tsx`，并给已有的 `WorkspaceView.retrySessionMessage.test.tsx` 加了用例。
  - 这个提交不碰本批文件，本批页面不引用这两个组件，本任务用到的浏览器用例的固定数据也不模拟失败卡片。
  - 那份测试文件 P0.1 时就已归属，main 只加了用例，没有新的 AntD 用法。

## 提交

| 提交 | 内容 |
| --- | --- |
| `9f4c4c4d1` | **feat：公共组件。**<br>新增 `NumberInput`、`Result`、`Descriptions`；`Table.tsx` 增加 `TableFrame`/`TableEmptyRow`。<br>已有组件加变体：`Badge` 增加 green/orange/red/gold，`Button` 增加 dashed，`RadioGroup` 增加 `buttonStyle="solid"`，`PasswordInput` 可受控显示，`ConfirmDialog` 增加 `kind="success"`，`Switch` 补上旧开关的 `min-width`。<br>README 写明用法。 |
| `865a0a6e3` | **feat：业务切换。**<br>17 个生产文件不再导入 antd（含 main 新增的 `DeepSeekBalance`）；AdminUsersPage 在原生表格上保留 main 的 X1（停用/恢复）；index.css 去掉本批的 `.ant-*` 覆盖，改写到 Orbit 类名；CliLoginPage 改用公共 `Descriptions`/`Result`。<br>22 个单测、accountFold、X1 的 disable 单测和测试辅助文件改按角色、可访问名称和页面类名定位，去掉 AntD `App` 包裹。 |
| `d3aadf781` | **test：同提交对照用例。**<br>`p42.browser.mjs`（23 个用例）、`p42-fixtures.mjs`、`p42.config.mjs`；P0 矩阵忽略 `p42*.browser.mjs`。 |
| `822c00ff0` | **test：P4.1 settings 用例按名称取 Smart model selection 开关。**<br>main def134095 的 “Suggested replies” 让 Session defaults 卡里有了两个开关，`getByRole('switch')` 触发严格模式冲突。改为按名称取用例本来就要按的那个开关，断言不变。<br>放在本批，是为了让 P4.1 用例在新基础上能跑；它该放在哪里，等协调者确认。 |
| `a794459b1` | **合入 origin/main `710c66e6d`**，无冲突（见上一节第 6 轮）。 |

之后的提交只增加本目录的证据和 `inventory-delta` 的 07c 记录。

- 撤回 `865a0a6e3` 就恢复本批的 AntD 页面，同提交参照树正是这样得到的。
- `9f4c4c4d1` 单独存在时，没有业务页面引用新增组件；已有组件只多了变体，`Switch` 的 `min-width` 只在开关被挤窄时起作用。

## 公共组件

用法写在 [components/ui/README.md](../../../../src/web/src/components/ui/README.md)。

| 组件 | 替换 | 约定 |
| --- | --- | --- |
| `NumberInput` | InputNumber | 见表下说明 |
| `Result` | Result | `status="success/info/warning"` 的 72px 图标、24px 标题、14px 说明；用在注册确认页与 CLI 登录页 |
| `Descriptions` | Descriptions（bordered、small） | 单列标签-值表，标签为 `th scope=row`；`labelWidth` 固定标签列宽 |
| `TableFrame`、`TableEmptyRow` | Table 的加载与空状态 | 与盒同宽的原生表格。加载时半透明、不可操作、中间显示 Spinner、带 `aria-busy`；无行时显示插图与 “No data” |
| `Badge` 色调 | Tag 预设色 | green/orange/red/gold，明暗主题各取被替换标签的色板 |
| `Button` `variant="dashed"` | Button `type="dashed"` | 添加模型、添加变量 |
| `RadioGroup` `buttonStyle="solid"` | Radio.Group `buttonStyle="solid"` | 暂停时长：选中项以主色填充 |
| `PasswordInput` `visible`/`onVisibleChange` | Input.Password 的受控显示 | Provider 编辑页显示已存密钥前，先向服务器取回 |
| `ConfirmDialog` `kind="success"` | `modal.success` | 只需确认的通知（管理员新建用户、重置密码后的一次性密码），默认聚焦确认键 |
| `Switch` `min-width` | Switch | 宽 44px（small 28px）且不再变窄，与旧开关的 `min-width` 相同。手机上 flex 行的长说明会把没有 `min-width` 的开关挤窄，见[开发中发现并修正的问题](#开发中发现并修正的问题)第 2 条 |

`NumberInput` 的行为：

- 输入中只上报界内的数；失焦、回车或步进时收回界内，并按精度取整（十进制精确运算，精度取值与步长小数位中较大的那个，步长 0.5 时 3 显示为 3.0）。
- ArrowUp/Down 步进；悬停时末端出现 22px 步进键，按住 600ms 后每 200ms 重复一次；`role=spinbutton`。
- 没有封装 Base UI NumberField，原因有二：它在输入过程中就把界外值夹到边界并上报（暂停时长输入 169 时，“暂停”按钮应保持禁用）；它按地区格式化显示（200000 显示为 200,000）。

## 业务切换

查询、变更、请求体与路由都不变，只替换控件、菜单、确认与状态展示。

| 文件 | AntD（之前） | 现在 |
| --- | --- | --- |
| `ProvidersPage` | Table、Tag、Popconfirm、Space、Button | 原生表格（`TableFrame`）、Badge、Popconfirm、Button |
| `ProviderConnectPage` | Input、Input.Password、InputNumber、Select、Switch、Space、Spin、Button | Input、PasswordInput、NumberInput、Select、Switch、Spinner、Button |
| `DeepSeekBalance`（main 936ebbd3c） | Button ×2（刷新/重试；带 `href` 的充值） | Button（small，loading）、LinkButton（primary，small） |
| `ProviderPoolPage` | Modal、Popconfirm、Radio、Spin、Button | Dialog、Popconfirm、Radio、Spinner、Button |
| `AccountPools` | Modal、Popconfirm、Radio、Segmented、Select（tags）、Checkbox、Input、Tooltip、Button | Dialog、Popconfirm、RadioGroup、Segmented、MultiSelect、Checkbox、Input、Tooltip、Button |
| `SharedPool` | `App.useApp().modal.confirm` ×2、Dropdown、Modal、Segmented、Select（tags）、Switch、Checkbox、Input、Button | `useConfirm`、Menu、Dialog、Segmented、MultiSelect、Switch、Checkbox、PasswordInput、Input、Button |
| `CodexSignIn` | Modal、Typography（可复制的代码）、Button | Dialog、带 Tooltip 的复制按钮（Copy code / Copied）、LinkButton、Button |
| `AccountPause` | Modal、Radio.Group（solid 按钮）、InputNumber、Tag、Button | Dialog、RadioGroup `buttonStyle="solid"`、NumberInput、Badge、Button |
| `RunnerEngines` | Dropdown、Popconfirm、Tag、Button | Menu、Popconfirm（移除确认锚定在 More 上）、Badge、Button |
| `RunnerEnginesSection`、`RunnerRegisterGuide`、`ClaudeHistoryOffer` | Button、Segmented、Radio | Button、Segmented、RadioGroup |
| `RunnerTokenRotation` | `modal.confirm`、Modal、Button | `useConfirm`、Dialog、Button |
| `RunnersPage` | Dropdown、`modal.confirm`、Modal、Input、Spin、Button | Menu、`useConfirm`、Dialog、Input、Spinner、Button |
| `RunnerDetailPage` | `modal.confirm` ×6、Dropdown、Modal、InputNumber、Select、Switch、Checkbox、Input/TextArea/Password、Tag、Spin、Button | `useConfirm`、Menu、Dialog、NumberInput、Select、Switch、Checkbox、Input/Textarea/PasswordInput、Badge、Spinner、Button |
| `EnrollPage` | Card、Descriptions、Result、Alert、Tag、Spin、Button | Card、Descriptions、Result、Alert、Badge、Spinner、Button |
| `AdminUsersPage` | Table、`modal.success`、Modal、Popconfirm、Input、Space、Tag、Spin、Button（X1 的 Status 列与 Enable/Disable 也在 AntD 表格里） | 原生表格（`TableFrame`）、`ConfirmDialog kind="success"`、Dialog、Popconfirm、Input、Badge、Spinner、Button；X1 的 Status 列与 Enable/Disable 在原生表格里 |

index.css：本批 42 行 `.ant-*` 覆盖逐条改写到 Orbit 类名，不再需要的删去，提到 AntD 的注释也改写了。被替换控件在这些位置的几何与配色，按两棵树逐项实测对齐，例如：账号菜单图标后的 8px、重名提醒、对话框的无单位行高、`.re-action` 按钮的静止/悬停/按下三态。

## 两张表格

两处 AntD Table 改为原生 `table.orbit-table`，放在新增的 `TableFrame` 里（与盒同宽，不横向滚动），没有引入表格框架。

- **Provider 的 API 密钥表**（`ProvidersPage`）：
  - `table-layout: fixed` 加 `colgroup`，保留原列宽；
  - Models、Endpoint、Enabled 三列只在 `(min-width: 768px)` 时出现，与原表 `responsive: ['md']` 的断点相同；
  - 操作列手机 88px、桌面 170px；行操作是 Edit 与 Delete（Popconfirm 确认）；
  - 加载时 `TableFrame` 加遮罩和 Spinner；没有密钥时仍是原来的 “No keys yet” 区块，不画表；
  - DeepSeek key 的名称格里有 main 加的余额行，由 DeepSeek 余额用例覆盖。
- **管理员用户表**（`AdminUsersPage`）：
  - 列与原表相同：Email、Name、Role、Status（X1）、Sign-in、Created、操作；
  - `users.isLoading` 时加遮罩和 Spinner，无用户时显示 `TableEmptyRow`；
  - 行操作：Reset password（Popconfirm）、Access tokens（令牌弹窗）、Unlink Google（确认对话框，只在关联了 Google 的行）、Make admin / Make member、Enable 或 Disable（X1；自己的行没有）、Delete（Popconfirm）。
- P4.2 用例覆盖两张表的加载、有数据、删除确认与空状态，以及 X1 的停用确认、被拒、已停用，桌面与手机各 4 个环境：`p42-keys-loading`、`p42-keys`、`p42-keys-delete`、`p42-keys-empty`、`p42-users-loading`、`p42-users`、`p42-users-reset`、`p42-users-password`、`p42-users-delete`、`p42-users-empty`、`p42-users-disable`、`p42-users-disable-refused`、`p42-users-disabled`。

## 确认流程、权限与错误反馈

- **确认**：上面 10 个 confirm 与 1 个 success 都改为局部的 `useConfirm`/`ConfirmDialog`：
  - RunnerDetailPage：放弃修改（两处）、移除导入的会话、删除工作区、修复检出、删除 Runner；
  - RunnersPage 的删除、令牌轮换；
  - SharedPool：改为仅自己、移出成员；
  - 管理员页：新建用户与重置密码后的一次性密码通知（同一处 success）。
  - X1 的 Disable 本来就用 `useConfirm`（main 的实现），本批保持；被拒时原因显示在确认框里，Enable 不问。

  锚定确认改为 Orbit Popconfirm：移除账号、删除 API 密钥、删除或离开账号池、从池中移出密钥、登出 ChatGPT 账号、重置密码、删除用户。

  文案、按钮、危险色与请求都不变；trace 中每个确认发出的请求，两棵树逐字相同。
- **权限呈现**：账号池页按读者身份（拥有者、成员、被加入者）显示的内容不变，包括“谁能用”、规则开关、成员菜单、Delete pool / Leave pool。覆盖它们的有：用例 `a Codex pool of one’s own`、`a pool somebody added the reader to`，单测 `ProviderPoolPage.whoCanUseIt`、`.access`、`ProvidersPage.sharedPools`。
- **错误反馈**：
  - 通知仍走 `useToast`；
  - 确认对话框里失败的请求以 `role=alert` 显示，可以重试；
  - 两棵树对照了这些错误状态：Provider 探测失败的 alert（`p42-connect-probe-error`）、注册确认的失效码（`p42-enroll-error`）、重名提醒（`p42-enroll-conflict`）、DeepSeek 拒绝密钥（`p42-deepseek-refused`）、X1 的停用被拒（`p42-users-disable-refused`）。

## 单测

本批 22 个测试文件、accountFold 用例、X1 的 `AdminUsersPage.disable` 用例和测试辅助文件，改为按角色、可访问名称和页面自己的类名定位，去掉 `.ant-*` 选择器与 AntD `App` 包裹。断言内容不变。

- **菜单**：按按钮的 `aria-expanded` 与菜单的 `aria-labelledby`，找到这个按钮打开的那个 `role=menu`，再按名称点 `role=menuitem`。
- **对话框与确认**：按 `role=dialog`/`alertdialog`，以及 `aria-labelledby` 指向的标题、`aria-describedby` 指向的说明；锚定确认的取消、确认按钮在该对话框内查找。
- **单选、分段、复选、开关**：用 `role=radio`/`checkbox`/`switch` 和 `aria-checked`、`aria-disabled`。Keep Free 选择器用 `role=combobox`/`option`，选项按浏览器的完整按下序列点击。
- **状态标签**：Badge 和被替换的 Tag 一样没有 ARIA 角色，所以按页面自己的状态槽 `.re-status`/`.pool-status` 读可见文字。单账号行的“预设色”断言原来读 AntD 的 `ant-tag-green`、`ant-btn-text`，现在读 Orbit 的色调与按钮变体类名（`orbit-badge-green`、`orbit-button-text`）。
- **改名**：编辑器要等菜单交还焦点后才打开（见[开发中发现并修正的问题](#开发中发现并修正的问题)第 1 条），所以用例改为等编辑器出现，仍断言它获得焦点、全选原名。

main 新增和改动的相关单测，在新基础上不用改就通过：`DeepSeekBalance.test`、`lib/deepseekBalance.test`、`lib/accountLogin.test`、`RunnerEngines.loginLapse.test`、`RunnerEngines.kimiSite.test`、`RunnerSignIn.test`、`AdminSignInPage.test`、`LoginPage.google.test`。合并检查里的全量 Vitest 结果见[组件矩阵、合并检查与重复运行](#组件矩阵合并检查与重复运行)。

## 对照方法

沿用 P3.1/P3.2/P4.1 的同提交对照。

- **三棵树**：
  - 参照树 `60f16a6ee`：交付 `822c00ff0` 只撤回业务切换 `865a0a6e3`，在独立的稀疏工作树里本地提交，没有推送。本批页面是 AntD，公共组件、P4.2 用例和其它一切都与交付相同。
  - 起点树 `b478f5f57`：项目 tip `dea1d8128` 加上 `822c00ff0`（本地 cherry-pick，没有推送），使两棵树跑同一份 P4.1 用例。它用来检查公共组件改动对已迁移页面的影响。
  - 交付树 `822c00ff0`：交付提交自己的完整检出（合并检查的单测会读 src/web 以外的文件）。
  
  三棵树在对照跑完后都已删除，可由脚本重建。
- **磁盘**：三棵树、TMPDIR 与全部运行产物都在 `/mnt/data/tmp/34Za39Feocgj42rrBYwzl/v2/`（协调者 2026-10-08 的磁盘规则：这样的运行不必等根分区回到 6 GB；每一步开始前按 `df -BM` 看根分区，低于 2 GB 就停下报告）。
- **构建与环境**：
  - 三棵树各自 `vite build`，再 `vite preview`；
  - Playwright 1.63.0 / Chromium 1243 / WebKit 2359；P0 字体与 `environment.mjs` 校验；DPR 1、en-US/UTC、固定时间与固定 REST 数据；reducedMotion=reduce；
  - 八个环境 = Chromium/WebKit × 明/暗 × 桌面 1280×900 / 手机 390×844；
  - 每次运行在独立网络命名空间里，固定端口互不干扰。
- **脚本**：
  - 工作树的建法见 [make-reference-v2.sh](scripts/make-reference-v2.sh) 与 [make-delivery-tree-v2.sh](scripts/make-delivery-tree-v2.sh)。
  - 正式运行与探针一次跑完（[formal-v2.sh](scripts/formal-v2.sh)），始终一次只跑一个；比较与分类的命令在 [analyze-v2.sh](scripts/analyze-v2.sh)。
  - 合并后的 tip 上的运行与比较见 [final-v2.sh](scripts/final-v2.sh)、[compare-final.sh](scripts/compare-final.sh)。
  - 本目录只收引用的副本（[collect.sh](scripts/collect.sh)），原始运行留在 /mnt/data。

对照内容：

- **P4.2 用例**（[p42.browser.mjs](../../../../src/web/ui-migration/p42.browser.mjs)）：23 个用例 × 8 个环境，覆盖 P0 矩阵走不到的本批状态（P0.2 没有 Provider、Runner、用户页）。
  - 定位器是角色、可访问名称、标签和页面自己的类名，同一份文件驱动两棵树。对话框、选择器、数字框、表格的外框用两边的类名并列（如 `.ant-modal-container, .orbit-overlay`），只用于样式取值。
  - 每一步记录 trace：地址、焦点、打开的对话框与菜单（项与禁用状态）、alert、通知区文字、该步发出的请求。
  - 新增的 DeepSeek 余额用例只在这个用例里加入三把 DeepSeek key（预设、团队、`api.deepseek.com` 上的自定义端点），并模拟余额接口（可以暂扣应答）。截图有：列表行、读取、刷新中、过低（充值按钮）、被拒（Retry）、首次加载中。
  - 第 2 版新增的 X1 用例：已停用账号与自己的行各显示什么按钮；Disable 被拒（原因在确认框里）、Disable 的确认、已停用的行、Enable。
  - trace 另记充值链接的 tag、href、target、rel；[trace-semantics.py](trace-semantics.py) 把它和“显示已存密钥的输入框类型”一起算作语义字段。
- **P0 页面矩阵**：用 P3.2 的 [p32-reference.config.mjs](../p3.2/p32-reference.config.mjs)。参照树写出截图；交付树先按 `maxDiffPixels: 0`（Playwright 默认的逐像素色差阈值 0.2）对参照截图比较一次，再写出自己的截图供逐张分类。另外在交付树和起点树上各跑一次标准 P0 回归（对照 P0.2 原图和漂移层、已接受层）。
- **起点对照**：P4.1 用例（CLI 登录、访问令牌、管理员令牌弹窗等）与 P3.2 试点（任务详情、分享、账号选择器），在起点树和交付树上各跑一次。
- **分类**：逐字节相同 / 抗锯齿级（每个差异像素每通道 ≤2）/ 超出。超出的逐张说明，并用 [beyond-clusters.py](scripts/beyond-clusters.py) 把 >2 级的像素聚成区域。各脚本的分工：
  - [p3.2/compare_runs.py](../p3.2/compare_runs.py) 比较截图、计算样式与 trace；
  - [p4.1/summarize.py](../p4.1/summarize.py) 分类；
  - [trace-semantics.py](trace-semantics.py) 逐步比较 trace 的语义字段（地址、请求、通知、菜单项、alert，以及上面两项），焦点与对话框文字另行计数。

## 对照结果

第 5 轮的正式运行依次为：P4.2 参照、P4.2 交付、P0 参照、P0 严格比较、P0 交付、标准 P0（交付、起点）、合并检查、overlays、controls、起点与交付的 P4.1 用例和 P3.2 试点、WebKit 重复运行，然后是探针。

- 日志在 [runs/](runs)：开头记 argv、树、HEAD、未提交路径、负载、根分区余量与 TMPDIR，结尾记退出码。
- 日志去掉了终端颜色码；报告去掉了附件正文（`*.report.summary.json`）。为了让本目录不超过 30 MB，只写截图供比较的运行不收报告，包括 P0 矩阵的参照与交付、两棵树的 P4.1 用例与试点。它们的结果见日志，比较见 compare/。

### P4.2 用例

| 运行 | 提交 | 结果 |
| --- | --- | --- |
| [f-p42-ref](runs/f-p42-ref.txt) | 参照 `60f16a6ee` | 180 通过、4 跳过 |
| [f-p42-del](runs/f-p42-del.txt) | 交付 `822c00ff0` | 180 通过、4 跳过 |

跳过的 4 个是手机上的“页面自己的按钮：静止、悬停、按下”（触屏没有悬停）。

截图共 644 张，桌面每个环境 81 张、手机 80 张。数据文件：

- 汇总：[compare/f-p42-summary.json](compare/f-p42-summary.json)；
- 逐张数据：[compare/f-p42-compare.json](compare/f-p42-compare.json)；
- >2 级像素的区域：[compare/f-p42-beyond-clusters.txt](compare/f-p42-beyond-clusters.txt)；
- 超出的每一对截图：[shots/f-p42-beyond](shots/f-p42-beyond)。

结果：**364 张逐字节相同，221 张抗锯齿级，59 张超出**。超出的 59 张：

| 截图 | 环境 | 差异 | 归类 |
| --- | --- | --- | --- |
| 边缘栅格化 45 张（清单见表下） | 各环境 | 每张 >2 级的像素 1–73 个 | **边缘栅格化**：菜单与浮层的圆角、菜单图标、提供方图块与复选框的圆角、对话框关闭图标、输入框里最后一个字形、加载点的静止帧（最多 21 级）。手机对话框截图里成千上万个 1–2 级的像素是遮罩合成的取整，计入抗锯齿级 |
| `p42-pool-add-account`、`p42-pool-replace-key`、`p42-pool-signout` | WebKit 明/暗桌面（6 张） | 8px 滚动条列；两棵树的页面滚动位置不同 | **对话框滚动锁**：已知差异，协调者的修复任务处理，见[协调者对差异的判定](#协调者对差异的判定) |
| `p42-pool-signout`、`p42-users-delete` | WebKit 明/暗手机（4 张） | 确认浮层右缘 382 对 390 | **WebKit 手机 382/390**（P2.3-B1、P4.1 已记录）：内容与宽度相同 |
| `p42-pool-tooltip` | 桌面 4 个 | 气泡左移 8px，箭头不动 | **Tooltip 贴边边距**：协调者已接受 |

边缘栅格化的 45 张：

- `p42-engine-menu` ×8、`p42-new-pool-people` ×8；
- `p42-runner-delete`/`rename`/`rotate`/`token`（Chromium 明色手机）；
- 加载点：`p42-runners-loading` ×3、`p42-keys-loading`、`p42-users-loading`（每张 35–73 个像素，最多 21 级）；
- `p42-workspace-edit` ×2、`-history` ×2、`-discard`、`-menu`；
- `p42-account-pause-custom` ×2、`p42-new-pool-claude` ×2、`p42-new-pool`、`p42-engine-remove` ×2、`p42-pool-just-mine` ×2；
- `p42-pool-replace-key`（Chromium 手机 ×2）、`p42-pool-add-account`（Chromium 明色手机）、`p42-connect-edit-shown`、`p42-connect-dialect-open`。

除加载点外，每张 >2 级的像素不超过 25 个。

新增状态的截图：

- **X1**：`p42-users`、`p42-users-disable`、`p42-users-disable-refused`、`p42-users-disabled` 八个环境共 32 张，**全部逐字节相同**：原生表格带上 Status 列与 Enable/Disable 后，与 AntD 表格画得一样。
- **DeepSeek 余额**：48 张中 44 张逐字节相同、4 张抗锯齿级。

计算样式差异出现在 298 次截图里，只有几类，与第 1 版相同：

- 对话框的 `surface` 选择器：参照命中 AntD 的透明外层，交付命中本身就是表面的 `.orbit-overlay`（P3.2、P4.1 已记录）；
- 行高的数值精度：WebKit 下 `22px` 对 `22.000019px` 一类，共 142 处；X1 的已停用行在 WebKit 下也只差这一项。Chromium 下只有 Codex 登录码的 4 处（`40.8571px` 对 `40.8572px` 一类）；
- Codex 登录码的复制按钮：参照里位于代码元素内，交付里与它并列，测量宽度差 26px，截图相同；
- WebKit 手机上确认浮层宽 390 对 382。

**trace**（[compare/f-p42-trace-semantics.json](compare/f-p42-trace-semantics.json)，两棵树的逐步记录在 [traces/](traces)）：共 180 个用例、912 步。

- 语义字段**全部相同**：地址、请求（方法、路径、请求体，含 X1 的 `PATCH …/disabled`）、通知、alert、显示已存密钥的输入框类型，以及充值链接。
- 菜单项与禁用状态：两棵树都记到菜单的步骤全部相同。另有 6 步，参照在观察那一刻还没有记到可见的 AntD 下拉（入场动画中透明度为 0）：
  - 成员菜单 5 步（Chromium 四个环境、WebKit 暗色手机）；
  - WebKit 明色桌面的 Runner 列表菜单 1 步。
  
  紧接着的截图里菜单已经打开，与交付只差 5–11 个 1 级的像素。
- 其余差在不属于业务语义的字段，都是 P2.1–P4.1 已接受的约定：
  - 焦点 334 步：焦点在带角色的元素上，而不是 AntD 的隐藏 `input`；菜单、确认浮层与对话框打开时聚焦自身；关闭后回到打开它的按钮。
  - 打开的对话框 120 步：Orbit 锚定确认是 `role=dialog`；AntD 的确认与成功弹窗在文字里把标题重复一遍；通知挂在打开的 Orbit 对话框里。

### P0 页面矩阵与标准 P0

| 运行 | 树 | 结果 |
| --- | --- | --- |
| [f-p0-ref](runs/f-p0-ref.txt) | 参照 `60f16a6ee`，写出截图 | 101 通过、11 跳过 |
| [f-p0-strict](runs/f-p0-strict.txt) | 交付对参照截图，`maxDiffPixels: 0` | 101 通过、11 跳过 |
| [f-p0-del](runs/f-p0-del.txt) | 交付 `822c00ff0`，写出截图 | 101 通过、11 跳过 |
| [f-p0-standard](runs/f-p0-standard.txt) | 交付，标准 P0 回归 | 101 通过、11 跳过 |
| [f-p0-standard-base](runs/f-p0-standard-base.txt) | 起点 `b478f5f57`，标准 P0 回归 | 101 通过、11 跳过 |

- 跳过的 11 个，两棵树相同：7 个环境里的“性能基线记录”和 4 个手机环境里的“600/640/960px 规则两侧”（配置只在别的环境跑它们）。
- P0 矩阵 252 张截图：**232 张逐字节相同、20 张抗锯齿级、0 张超出**（[compare/f-p0-summary.json](compare/f-p0-summary.json)）。
- 标准 P0 每张截图对照的是哪一层（P0.2 原图、漂移层、已接受层），记在 `runs/*.expected-sources.json`。

### 起点对照（P4.1 用例与 P3.2 试点）

| 运行 | 树 | 结果 |
| --- | --- | --- |
| [f-p41-base](runs/f-p41-base.txt) | 起点 `b478f5f57` | 96 通过 |
| [f-p41-del](runs/f-p41-del.txt) | 交付 `822c00ff0` | 96 通过 |
| [pilot-base](runs/pilot-base.txt) | 起点 | 81 通过、7 跳过 |
| [pilot-del](runs/pilot-del.txt) | 交付 | 81 通过、7 跳过 |

两棵树跑的是同一份 P4.1 用例：起点树带上了 `822c00ff0` 的定位器修正。试点跳过的 7 个是 7 个环境里的“性能记录”。

**P4.1 用例**（[compare/f-p41-summary.json](compare/f-p41-summary.json)）：

- **截图** 272 张：241 张逐字节相同、28 张抗锯齿级、3 张超出。超出的是 `p41-profile-photo`（Chromium 暗色桌面、暗色手机、明色手机），即头像照片圆边的缩放取样：每张 >2 级的像素 10–20 个，最多 40 级。个人资料页不属本批，本批也没有改它。
- **计算样式**：差异只在 `p41-admin-tokens`（8 个环境），即管理员从用户页打开的令牌对话框。AdminUsersPage 属本批，Modal 换成了 Orbit Dialog，`surface` 选择器命中的元素不同；截图逐字节相同或抗锯齿级。
- **trace**：96 个用例中 80 个相同，请求、地址与 alert 全部相同。不同的 16 个：
  - 管理员令牌对话框，八个环境各 1 个，都是 P2.1 的焦点约定：
    - 打开时 AntD 聚焦关闭键，Orbit 聚焦对话框本身；
    - 撤销令牌后 AntD 落到 body，Orbit 留在对话框（Chromium 四个环境记到）；
    - WebKit 明色桌面按下 Escape 后的那一刻，交付的对话框还在退场帧里。
  - 另外 8 个是观察那一刻焦点在不在按钮上，两个方向都有：设置页去访问令牌（Chromium 3 个）、登录密码错误（WebKit 4 个）、CLI 登录批准被拒（WebKit 暗色手机 1 个）。

**P3.2 试点**（[compare/pilot-summary.json](compare/pilot-summary.json)）：

- **截图** 256 张：207 张逐字节相同、48 张抗锯齿级、1 张超出。超出的是 Chromium 明色桌面 `pilot-delete-confirm` 遮罩下 ⋮ 图标的边缘：5 个像素 >2 级，最多 20 级。
- **trace**：72 个中 62 个相同。不同的 10 个：
  - 9 个是观察那一刻的焦点或下拉列表，两个方向都有：任务详情的选择器 5 个、分享对话框 3 个、Antigravity 账号选择器 1 个；
  - 1 个是 Chromium 明色桌面“移除输入”之后，交付的确认框还在退场帧里。

### 组件矩阵、合并检查与重复运行

| 运行 | 命令 | 结果 |
| --- | --- | --- |
| [c-merge](runs/c-merge.txt) | `npm run build -w @orbit/web && npm run test -w @orbit/web`，交付的完整检出 | 构建通过；Vitest 368 个文件、4753 个测试全部通过 |
| [c-overlays](runs/c-overlays.txt) | `npm run test:ui-overlays -w @orbit/web` | 96 通过 |
| [c-controls](runs/c-controls.txt) | `npm run test:ui-controls -w @orbit/web` | 32 通过 |
| [f-p42-repeat](runs/f-p42-repeat.txt) | WebKit 明/暗桌面，`-g "engines\|its menus"` 选中的 3 个用例各重复 5 次 | 30 通过 |

### 合并 origin/main 之后

合并后的 tip `a794459b1` 上，用交付的完整检出一次一个地重跑（[final-v2.sh](scripts/final-v2.sh)，日志在 [runs-final/](runs-final)）：

| 运行 | 内容 | 结果 |
| --- | --- | --- |
| [g-p0-standard](runs-final/g-p0-standard.txt) | 标准 P0 回归 | 101 通过、11 跳过 |
| [g-merge](runs-final/g-merge.txt) | 合并检查：`npm run build -w @orbit/web && npm run test -w @orbit/web` | 构建通过；Vitest 368 个文件、4754 个测试全部通过（比 `822c00ff0` 多的 1 个，是 main 给 `WorkspaceView.retrySessionMessage.test.tsx` 加的） |
| [g-overlays](runs-final/g-overlays.txt) | `npm run test:ui-overlays -w @orbit/web` | 96 通过 |
| [g-controls](runs-final/g-controls.txt) | `npm run test:ui-controls -w @orbit/web` | 32 通过 |
| [g-p41-del](runs-final/g-p41-del.txt) | P4.1 用例 | 96 通过 |
| [g-pilot-del](runs-final/g-pilot-del.txt) | P3.2 试点 | 81 通过、7 跳过 |
| [g-p42-del](runs-final/g-p42-del.txt) | P4.2 用例 | 180 通过、4 跳过 |
| [g-p0-del](runs-final/g-p0-del.txt) | P0 页面矩阵（交付，写出截图） | 101 通过、11 跳过 |

交付自己的截图：`a794459b1` 对 `822c00ff0`，同样的比较与分类（[compare-final.sh](scripts/compare-final.sh)）。

- 汇总与超出截图的像素区域在 [compare-final/](compare-final)。
- 下面三处之前从未变过的截图，各留一对在 `shots/final-*-beyond/`。
- 为了让本目录不超过 30 MB，合并后的 tip 上只收了标准 P0 的报告；其余几次运行的结果在日志里，截图、用例与 trace 的比较在 compare-final/，报告原件留在 /mnt/data。

两次之间本批页面的代码没有变，所以这里的差异就是同一份代码两次运行之间的差别：

| 比较 | 截图 | 逐字节相同 | 抗锯齿级 | 超出 |
| --- | --- | --- | --- | --- |
| P4.2 用例 | 644 | 602 | 34 | 8 |
| P0 页面矩阵 | 252 | 234 | 17 | 1 |
| P4.1 用例 | 272 | 252 | 17 | 3 |
| P3.2 试点 | 256 | 216 | 34 | 6 |

逐次运行的哈希见 [compare-final/shot-variants.txt](compare-final/shot-variants.txt)：每张超出的截图在第 2、3、5 轮两棵树和合并后的 tip 上各是哪一种字节。

- **之前就会变的 10 张**：
  - P4.2 的 7 张：加载点的静止帧（`p42-runners-loading` ×2、`p42-users-loading`、`p42-keys-loading`），以及三处图标或菜单边缘（`p42-connect-dialect-open`、`p42-account-pause-custom`、`p42-workspace-menu`）；
  - P4.1 的 3 张：`p41-profile-photo` 的头像缩放取样。
  
  这几张在之前各轮的两棵树里本来就有两到四种变体，`a794459b1` 这一次多半落在最常见的那一种。例如 `p42-connect-dialect-open`，与众不同的是 `822c00ff0` 那一次。
- **之前从未变过的 8 张**：
  - P4.2 的 `p42-enroll-loading`（Chromium 明色手机，加载点的静止帧，73 个像素 >2 级，最多 20 级）；
  - P0 的 `projects-list`（Chromium 暗色手机，3 个像素，最多 4 级）；
  - 试点里 WebKit 明色桌面分享对话框的 6 张：差在对话框遮罩下的依赖图上，一条依赖边的竖段比 `822c00ff0` 那一次偏了约 1.5px，节点与连接点不动。
  
  在同一棵树 `a794459b1` 上把这三个用例各重跑三次（[rerun-odd-final.sh](scripts/rerun-odd-final.sh)、[rerun-enroll-final.sh](scripts/rerun-enroll-final.sh)，日志在 [runs-final/](runs-final)），九次都与 `822c00ff0` 那一次、也与之前各轮逐字节相同。这些差异只出在 `a794459b1` 的那一次运行里，不是合并带来的。
- **trace**：P4.2 的 912 步语义字段全部相同（[final-p42-trace-semantics](compare-final/final-p42-trace-semantics.json)），只有 5 步焦点不同。P4.1 有 8 个用例、试点有 9 个用例不同，都是观察那一刻的焦点或下拉列表，以及对话框的退场帧。这些步骤与起点对照里的差异是同一批（设置页去访问令牌、登录密码错误、令牌对话框按 Escape、任务详情的选择器、分享对话框），说明那些差异也只是取样时刻不同。

## 开发中发现并修正的问题

### 1. WebKit：从菜单打开的行内编辑器立即关闭

- **现象**：旧基础第一轮正式运行中，交付的 WebKit 暗色桌面在“账号菜单 → Rename”之后等不到改名输入框（[r1-f-p42-del](rename-race/r1-f-p42-del.txt)、[错误上下文](rename-race/r1-error-context.md)）。同一用例的其它 7 个环境和参照树都通过。
- **机制**：
  1. Base UI 的菜单在弹层卸载的那次提交里，于 mutation 阶段（layout effect 清理）读取当前焦点，并安排一个微任务把焦点还给菜单按钮。如果这时焦点不在别处（弹层刚被移除，焦点在 body），微任务就聚焦按钮。
  2. 原实现用 `setTimeout(0)` 推迟打开编辑器。WebKit 中这个计时器常和菜单的卸载落在同一次提交：编辑器的 `autoFocus` 先拿到焦点，随后的微任务又把焦点还给 More，编辑器的 `onBlur` 随即关闭它。
  3. 这个顺序是用未压缩的开发服务器记录每次 `focus()` 的调用栈得到的（[探针](rename-race/rename-probe.browser.mjs)）。
- **修正**：
  - Rename 和工作区的 Configure 不再计时，而是等菜单把焦点交还给它自己的按钮时（按钮的 `onFocus`）才打开编辑器。
  - 如果选中时焦点从未进入菜单（键盘连按），先让按钮失焦，使交还成为一次真正的焦点移动。
  - 点选或回车选中菜单项后，Base UI 总会把焦点还给按钮，这个时刻之后不会再有焦点归还。
- **验证**：在项目 tip 上用同一探针（[rename-probe.browser.mjs](rename-race/rename-probe.browser.mjs)）对照修正前后：未压缩的开发服务器，Chromium 明色与 WebKit 明/暗桌面，各 5 次。
  - **修正前**：树 `b8385ffbd` 是交付 `822c00ff0` 撤回这一修正（[rename-fix-reversed.patch](rename-race/rename-fix-reversed.patch)）。
    - WebKit 暗色桌面 5 次里有 3 次、明色桌面 5 次里有 1 次，Rename 的编辑器打开、拿到焦点后随即失焦关闭，焦点留在 More（[rename-before.jsonl](rename-race/rename-before.jsonl)）；Chromium 5/5 没有复现。
    - 这一轮修正前的 Configure 没有复现竞争（15/15），它与 Rename 是同一机制、同样的改法。
    - 之前几轮在 WebKit 桌面同样复现过，例如第 1 版的基础上，WebKit 明色桌面 5 次里有 3 次。
  - **修正后**：Rename 与 Configure 各 15/15（[rename-after.jsonl](rename-race/rename-after.jsonl)）。
  - **正式运行**：这两个用例八个环境都通过；WebKit 明/暗桌面再各重复 5 次，也全部通过（f-p42-repeat）。

### 2. 手机：开关被 flex 行挤窄

- **现象**：第一轮对照中，账号池页 Who can use it 的两条规则在手机上（Chromium/WebKit、明/暗）开关只有约 28px，关闭态只剩圆点，说明文字随之换行。Provider 编辑页的 Enabled 开关被挤到 43.3px。
- **原因**：Orbit `Switch` 只设了 `width: 44px`，作为 flex 子项会被旁边的长文字压缩；旧开关有 `min-width: 44px`（small 28px）。
- **修正**：公共 `Switch` 补上同样的 `min-width`。其它页面只有在开关被挤窄时才会有变化。
- **验证**：项目 tip 上，两棵树八个环境里的规则开关与 Enabled 开关都是 44px（[probe-geometry-ref](probes/probe-geometry-ref.jsonl)、[probe-geometry-del](probes/probe-geometry-del.jsonl)；探针按角色取编辑页上的开关，参照里被替换的开关没有可访问名称）。

### 3. 工作区编辑器里“固定”的引擎勾选

- **现象**：起点对照的 P3.2 试点截到了 Runner 详情的工作区编辑器。Engines it may use 中，智能体自己的引擎是勾选且不可取消的：旧页面画成灰色的禁用勾，交付画成蓝色的已勾选框。
- **原因**：index.css 这段旧规则写着“drawn as on, not as greyed out”，但其中给勾选框上色的两条在 AntD 下从未生效（AntD 自己的禁用样式选择器同样具体、注入在后），页面实际一直显示灰色。迁移后，这两条对 Orbit 复选框生效了。
- **修正**：按“保持现有外观”，删去这两条，保留确实生效的芯片底色、文字颜色与光标规则。交付与起点在这几张截图上回到抗锯齿级。
- **判定**：规则作者原本想要的“画成已勾选”从未上线；协调者 2026-10-08 判定接受保持灰色常显（见[协调者对差异的判定](#协调者对差异的判定)）。

### 4. 用例的时序：Always allowed 的加载

- **现象**：第一轮对照中，Chromium 桌面的 `p42-workspace-advanced` 整页差 15px。
- **原因**：用例在 Advanced 展开后立刻滚动。交付在那一刻 Always allowed 的规则列表还在加载（字段高 48.42px），参照已经加载完（63.61px）。两棵树加载中和加载后的高度都相同，差别只是取样时刻。
- **修正**：用例改为等规则列表出现后再滚动截图，没有放宽任何断言。
- **验证**：项目 tip 上，两棵树八个环境都是：加载中 48.42px；加载后桌面 63.61px、手机 82.2px（[probe-geometry](probes/probe-geometry-del.jsonl)）。

## 迁移清单

在合并 origin/main 之后的 tip `a794459b1` 上重跑复扫：

- 审计：[delivery-audit-summary](checks/delivery-audit-summary.txt)，审计全文 [delivery-audit.json](checks/delivery-audit.json)；
- `--check-owners`：[delivery-check-owners](checks/delivery-check-owners.json)，0 未归属、0 待定；
- 去掉 07c 时的复扫：[without-07c-check-owners](checks/without-07c-check-owners.json)，正是协调者判定的 11 个点。

[inventory-closure.mjs](inventory-closure.mjs) 对比同提交参照 `9317b2712` 与交付 `a794459b1`，结果在 [inventory-closure.json](inventory-closure.json)。参照 `9317b2712` 是 `a794459b1` 只撤回 `865a0a6e3`，只用来跑审计（[make-reference-final.sh](scripts/make-reference-final.sh)）：

- **使用点**：P4.2 负责的使用点 **81 → 0**。未归属 3 → 0，即参照树上 main 带来、落在本批页面里的 `DeepSeekBalance.tsx`、`RunnerEngines.accountFold.test.tsx` 和 X1 的 `AdminUsersPage.disable.test.tsx`；待定 0 → 0。
  - 其它阶段的数量两边相同：P4.3a 83、P4.3b 31、P4.4 54、P5.1 28、P5.2 11、P5.3 94、P6 37、KEEP 1。
  - 两边读的是同一组四份记录（`2026-10-07.json`、`2026-10-07b.json`、`2026-10-07c.json`、`2026-10-07d.json`）。
- **导入**：17 个生产文件不再导入 antd（导入前后逐文件列在 `files`）。16 个测试文件去掉了 AntD `App` 包裹（含 X1 的 disable 单测），另有 5 个生产文件不再用 `App.useApp`。
- **审计计数**（参照 → 交付）：
  - 直接引用 antd 的生产文件 96 → 79，测试文件 80 → 64；
  - 含 `.ant-*` 选择器的测试文件 61 → 42，含裸 `ant-*` 类名的测试文件 66 → 47（审计的 `antSelectorTestFiles`、`antClassTestFiles`）；
  - `--check-retired` 阻塞文件 237 → 195。
- **命中行**（参照 → 交付）：
  - `ant-class` 443 → 306、`ant-selector` 417 → 284、`antd-reference` 351 → 297；
  - `imperative-confirm` 22 → 12、`use-app` 16 → 9、`provider` 92 → 76、`internal-ref` 6 → 4。
- **`imperative-feedback`** 剩 221 行：这是对 Orbit `useToast` 返回值 `message.success/error(...)` 的文字命中（P4.1 的页面同样如此），不是 AntD 调用，审计的归属规则不把它算作使用点。
- **清单自检**都通过：[selfcheck](checks/selfcheck.txt)（原有自检与 owner 自检）、[p01-verify](checks/p01-verify.txt)（P0.1 覆盖）。

## 协调者转告的事项

1. **`RunnerEngines.accountFold.test.tsx`**（main 16d157656 引入，原未归属）：
   - `.ant-tag` 定位已去掉。状态标签（Orbit Badge，与被替换的 Tag 一样）没有 ARIA 角色和可访问名称，没法按角色或名称定位；改为读页面自己的状态槽 `.re-status` 的可见文字（项目约定允许页面自有类名），`toEqual` 的精确列表不变。
   - 若要严格按角色定位，需要给状态槽加 role/aria，这是可访问性方面的产品改动，本批没有做。
   - 同样的写法也用于 `RunnerEngines.accounts`、`.claudeAccount`、`.antigravityAccounts`。
2. **`DeepSeekBalance.tsx`**（main 936ebbd3c，导入 antd `Button`）：本批迁移，见[跟上 origin/main](#跟上-originmain)与 DeepSeek 余额用例。
3. **X1**（main fce7a19cf，管理员停用、恢复账号）：`AdminUsersPage.tsx` 的 Status 列与 Enable/Disable 在原生表格上实现；`AdminUsersPage.disable.test.tsx` 随 X1 在本批迁移，写进关闭记录（见[迁移清单](#迁移清单)）。
4. **重建的 `2026-10-07c.json`**（协调者 2026-10-07、2026-10-08 的判定）：

   | 使用点 | owner | 依据 |
   | --- | --- | --- |
   | `ProjectDoneConversation.test.tsx`（main 21090b959，只有固定数据里的 “antd migration” 字样） | P6 | 先例 `ProjectWhyNotDoneGate.test.tsx` |
   | `StartProjectCard.test.tsx`（main 50e7ca040 起用了 `.ant-select-content`） | P4.3b | Start 卡片归 P4.3b |
   | `WorkspaceView.neverStarted.test.tsx`（main 622c30e1f，导入 antd `App`） | P5.3 | 会话工作区 |
   | `WorkspaceView.promptSuggestion.test.tsx`（main def134095，导入 antd `App`） | P5.3 | 会话工作区 |
   | `WikiReviewPage.decided.test.tsx`（main 6ec468a25，`App` 与 `.ant-modal` 等选择器） | P4.4 | WikiReviewPage 归 P4.4 |
   | `WikiShareButton.tsx`（main 2ba6765d9，导入 antd `Button`） | P4.4 | Wiki 分享 |
   | `SharedWikiPage.tsx`（main 2ba6765d9，导入 antd `Drawer`、`Popover`） | P4.4 | 公开分享页 |
   | `SharedWikiPage.test.tsx`（main 2ba6765d9，`.ant-popover` 选择器） | P4.4 | 随页面 |
   | index.css `.ant-dropdown-menu-item.composer-engine-title` 两行（main 81845a53d） | P5.3 | 输入框引擎菜单 |
   | index.css 提到 `.ant-radio-group` 的注释（main 50e7ca040） | P4.3a | project-run 设置 |

   - **行号**：取自交付 `a794459b1`，按原文登记，是 6698、6699、10700。本批的 index.css 改动让这 3 行比 origin/main `710c66e6d` 上前移一行（main 上是 6699、6700、10701）；协调者当时说的 6695、6696、10697 是 def134095 上的行号。
   - **依据**：owner 和依据都写协调者的判定，没有使用 `2026-10-07d.json` 或 `2026-10-08.json`。
   - **生成**：记录由 [build-record-c.py](../inventory-delta/build-record-c.py) 生成。它只读入排在它前面的两份记录，算出仍未归属的点，从审计、P0.1 基线和 git blame 取事实，再写入判定。有点缺判定、或判定对不上任何点，脚本都会失败。排在它后面的 `2026-10-07d.json` 只重述 `2026-10-07.json` 已登记的 `ChoicesFixture.tsx`，不影响它。
   - **验证**：`verify-record.mjs` 通过（[verify-record-c](checks/verify-record-c.txt)）。
     - 8 个文件条目和 3 个 index.css 条目与审计一致；
     - 读入前两份记录之后，拿掉它的新增/改动条目，正好有这 11 个点失去归属；
     - 四份记录一起读时 0 未归属、0 待定。
5. **跟上 origin/main**：第 2 版六轮接基础见上文。最终检查在合并后的 tip 上重跑，清单也在那里重建。
6. **P4.1 定位器**（`822c00ff0`）：放在本批，等协调者确认归属。

## 协调者对差异的判定

协调者 2026-10-08 在退回第 1 版证据时判定，第 2 版沿用：

1. **WebKit 桌面：打开 Orbit 对话框后，已滚动的页面回到顶部**（公共层，不在本批页面代码里）：协调者另建修复任务 [WebKit 对话框滚动锁：通知读屏区域的 1px 溢出让已滚动页面跳回顶部](orbit-task:34cBi0yt6bFcSmbJFgDPj)，本批不改，记为已知差异。
   - **机制**：出现过一次通知后，`lib/toast.tsx` 的 `announce()` 在 body 末尾插入读屏 live region，文档高变成 901px；WebKit 因全站 8px 的 `::-webkit-scrollbar` 给文档画出内嵌滚动条；Base UI `useScrollLock` 这时改写 body（`position: relative; height: 100dvh; width: calc(100vw - 8px); overflow: hidden`），本应用的 `.app-view` 丢掉滚动位置。
   - **项目 tip 上复测**：
     - WebKit 桌面交付：账号池页从 72px 回到 0，关闭对话框后也不恢复；参照保持 72。Chromium 与 WebKit 手机两棵树都保持原来的滚动位置。
     - 另一面：参照打开对话框时去掉文档滚动条，内容右移 4px（326→330）；Orbit 保留滚动条槽位，内容不动（326）（[probe-geometry](probes/)）。
     - 截图上是 WebKit 桌面的 `p42-pool-add-account`、`p42-pool-replace-key`、`p42-pool-signout` 各 2 张。
2. **Tooltip 贴视口边缘的 8px 边距**：接受为迁移差异（Orbit Tooltip 的碰撞边距；旧气泡贴边约 1px）。
3. **工作区编辑器里固定引擎的勾选保持灰色常显**：接受，见[开发中发现并修正的问题](#开发中发现并修正的问题)第 3 条。

## 未消除的差异

- **已知差异**：WebKit 桌面对话框的滚动锁（6 张），协调者的修复任务处理。
- **已接受的迁移差异**：Tooltip 贴边边距（4 张）；工作区编辑器里固定引擎的灰色勾选。
- **WebKit 手机确认浮层贴右缘**（4 张：`p42-pool-signout`、`p42-users-delete`，明/暗各一）：内容与宽度相同，Orbit 浮层右缘在 382px，旧浮层画到 390px。这是 P2.3-B1 与 P4.1 已记录的 WebKit 手机机制：1px 溢出后 `visualViewport` 宽 382，Floating UI 以它为边界。
- **其余 45 张超出**：都是图标、圆角、输入框末字或加载点的边缘栅格化，每张 >2 级的像素不超过 73 个（加载点的静止帧），其余不超过 25 个。逐张区域见 [compare/f-p42-beyond-clusters.txt](compare/f-p42-beyond-clusters.txt)。
- **行高的数值精度**：`22.000019px` 一类的数值来自全站 CSS 压缩，与 P3.2 相同，截图不受影响。

## 未确立的部分

- 只在 Linux 上的 Playwright Chromium/WebKit 模拟中比较，没有真机，也没有用读屏软件实测。
- 同提交截图对照只在减少动态效果下做。菜单、对话框、提示与开关的默认动效沿用 P2 公共组件已验证的取值，本批没有逐帧对照。
- 后端是固定 REST 数据，不连真实服务（DeepSeek 余额与 X1 的停用/恢复同样只用固定应答）。Gemini 密钥、Antigravity/Kimi 账号等没有进入 P4.2 截图的状态，由各自的单测覆盖。
- 同提交对照（含参照一侧）在项目 tip 上的 `822c00ff0` 完成。合并 origin/main `710c66e6d` 之后，只重跑了交付一侧，没有在 `a794459b1` 上重建参照树、重做同提交对照。理由是：main 这段改动只在会话页的失败卡片，本批页面不引用它，本任务用到的浏览器用例的固定数据也不模拟失败卡片。
- 提交证据前，origin/main 又前进到 `29f49af63`：在 `710c66e6d` 之后多了 25 个提交，都是 wiki 项目的。本分支没有再合并它，只做了干跑：
  - 合并无冲突；
  - 这些提交不碰本批的任何文件，也没有新增 AntD 用法；
  - 合并结果上 `--check-owners` 仍是 0 未归属、0 待定。
  
  合并检查与标准 P0 没有在那个合并结果上重跑，由落地时并入 main 后的检查覆盖。

## 过程记录

**第 1 版**（基础 `7e4655bc2`，提交 `0d66801d6` / `b4ebd792c` / `a731c59ac`，参照 `ad04b5817`，证据第 1 版）：

- P4.2 用例两棵树各 172 通过、4 跳过；620 张截图 334 张逐字节相同、225 张抗锯齿级、61 张超出，全部归类（47 边缘栅格化、6 WebKit 对话框滚动锁、4 WebKit 手机 382/390、4 Tooltip 贴边）；trace 872 步的语义字段全部相同。
- P0 参照、严格比较、交付各 101 通过，标准 P0 在交付上 101 通过；合并检查 4570 个测试通过；overlays 96、controls 32；P4.1 用例与 P3.2 试点在起点与交付上各自全过。
- 摘要与日志在 [process/v1/](process/v1)。被退回只因为分支落不了地（见开头）。

**第 2 版的第 1–4 轮**：基础、提交与结果见[跟上 origin/main](#跟上-originmain)的表。

- 各轮运行的结果行在 [process/v2-rounds.txt](process/v2-rounds.txt)。
- 原始运行留在 `/mnt/data/tmp/34Za39Feocgj42rrBYwzl/v2/`：`killed-run-1`、`killed-run-2`、`runs-def134095`、`runs-bcc89c7af`、`killed-run-3`。

**最初的旧基础**（`3aa26fb97`，提交 `396fff3d1` / `9fb516a04` / `241b00a8b`，参照 `ede2ca966`）：

- P4.2 用例两棵树各 164 通过、4 跳过；572 张截图 300 张逐字节相同、215 张抗锯齿级、57 张超出，全部归类；trace 的地址、请求、通知与 alert 全部相同；P0 参照与严格比较 101 通过。
- 那一轮链上其余的运行，在 2026-10-08 00:31Z 按协调者的磁盘紧急要求停下，之后被 rebase 后的运行取代。[开发中发现并修正的问题](#开发中发现并修正的问题)第 1–4 条都是在这一轮发现并修正的，修正随提交一起 rebase 了过来。摘要与日志在 [process/oldbase/](process/oldbase)。

## 复现

```bash
# 第 5 轮：三棵树（都在 /mnt/data），然后一次跑完正式对照与探针
scripts/make-reference-v2.sh 822c00ff0 865a0a6e3 dea1d8128 822c00ff0   # 参照 60f16a6ee，起点 b478f5f57
scripts/make-delivery-tree-v2.sh 822c00ff0
scripts/formal-v2.sh                       # 日志在 /mnt/data/tmp/34Za39Feocgj42rrBYwzl/v2/runs/<name>.txt
scripts/analyze-v2.sh                      # 截图、计算样式与 trace 的比较和分类
# 第 6 轮：合并 origin/main 之后的 tip
scripts/make-delivery-tree-v2.sh a794459b1
scripts/final-v2.sh                        # 日志在 …/v2/runs-final/<name>.txt
scripts/compare-final.sh                   # 交付自己的截图：a794459b1 对 822c00ff0
# P4.2 用例单独运行（在要比较的树的 src/web 下）：
P42_SNAPSHOTS=<dir> P42_OUTPUT=<dir> npx playwright test --config ui-migration/p42.config.mjs --update-snapshots=all
# 清单（从仓库根目录，在 a794459b1 或其后只加了证据的提交上）：
node src/web/scripts/audit-antd.mjs --check-owners
python3 -I docs/evidence/base-ui-migration/inventory-delta/build-record-c.py docs/evidence/base-ui-migration/p4.2/checks/delivery-audit.json \
  | cmp - docs/evidence/base-ui-migration/inventory-delta/2026-10-07c.json
node docs/evidence/base-ui-migration/inventory-delta/verify-record.mjs docs/evidence/base-ui-migration/p4.2/checks/delivery-audit.json 2026-10-07c.json
scripts/make-reference-final.sh a794459b1 865a0a6e3   # 参照 9317b2712，在其中跑 audit-antd.mjs --json
node docs/evidence/base-ui-migration/p4.2/inventory-closure.mjs REF_AUDIT.json DEL_AUDIT.json > inventory-closure.json
# 本目录的副本由 scripts/collect.sh 从 /mnt/data 复制（报告去掉附件正文）。
```
