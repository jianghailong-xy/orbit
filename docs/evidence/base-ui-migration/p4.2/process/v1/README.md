# P4.2 Provider、Runner、账号池与用户管理

服务于 [P4.2 迁移 Provider、Runner、账号池与用户管理](orbit-task:34Za39Feocgj42rrBYwzl)，项目验收条目 key `hnPVsE0kmorHXurrs4Qdp`：**P4：全部非会话业务界面完成迁移，既有页面操作和响应式呈现保持一致。** 本任务承担其子范围：本批管理页面的既有操作、权限呈现、确认流程和响应式表格保持一致；加载/空/错误状态可验证，相关回归通过，本批 AntD 使用点关闭。

本批在项目分支 tip `3aa26fb97`（P4.1 交付）上开工。2026-10-08 协调者转告账号所有者的要求：各分支跟上最新 origin/main。当时项目 tip `490b5dceb` 已经在 origin/main 里，所以本批的 3 个提交直接 rebase 到 origin/main `7e4655bc2`。这个提交就是协调者说的 `c7efa24cb`，只多了一个 runner-go 提交（`src/runner-go/worktree.go` 及其测试），不涉及 Web。下文的结论都在这个新基础上得出。旧基础上的同一套对照留作过程记录，见[旧基础上的过程记录](#旧基础上的过程记录)。

对照期间 origin/main 又前进到 `7cc52e0cf`（多 80 个提交，Web 改了 6 个文件）。没有再追：对它的 `git merge-tree` 干跑没有冲突，这 80 个提交在本批文件里只改了 runner 卡片折叠箭头的原生字形；它们带来的范围外新使用点（`WikiReviewPage.decided.test.tsx`）已报告协调者。

## 结论

- **本批 AntD 使用点关闭**：
  - P4.2 负责的 81 个使用点在交付上为 0。main 带来、协调者判定由本批迁移的 2 个点（`DeepSeekBalance.tsx`、`RunnerEngines.accountFold.test.tsx`）也已迁移。17 个生产文件不再导入 antd。
  - 新基础上 `--check-owners` 读入三份记录，结果 0 未归属、0 待定；`verify-record.mjs` 对 07c 通过；07c 可由交付的审计逐字节重建。
- **同提交对照**（参照 = 交付只撤回业务切换）：
  - P4.2 用例：22 个 × 8 个环境，两棵树各 172 通过（4 个手机跳过）。
  - 620 张截图：334 张逐字节相同、225 张抗锯齿级、61 张超出。超出的全部归类：47 张边缘栅格化；6 张 WebKit 对话框滚动锁、4 张 Tooltip 贴边，这两类待判定；4 张 WebKit 手机 382/390。
  - trace 共 872 步：地址、请求、通知、alert、已存密钥输入框的类型、充值链接，两棵树全部相同。
- **P0**：
  - 参照与交付各 101 通过；交付对参照按 `maxDiffPixels: 0` 比较，101 通过。
  - 标准 P0 回归在交付上 101 通过。同一条链上 origin/main 自身有 1 项因通知计时失败，交付该项通过。
- **合并检查**：构建与全量 Vitest 通过，357 个测试文件、4570 个测试；overlays 96、controls 32 通过。
- **公共组件改动对已迁移页面的影响**：P4.1 用例和 P3.2 试点在起点（origin/main）与交付上各自全过。超出级截图各 3 张，都是加载点、头像或图标的边缘栅格化。除焦点的取样时刻外，唯一的不同是本批 AdminUsersPage 令牌对话框的焦点约定。
- **菜单打开行内编辑器的 WebKit 竞争已修正**：撤回修正时，WebKit 明色桌面 5 次 Rename 有 3 次编辑器被关；修正后探针 30/30，WebKit 重复运行 30/30。
- **待协调者判定 4 项**，见[待协调者判定](#待协调者判定已在任务评论报告)。

## 范围

开工时按复扫规则运行 `audit-antd.mjs` 与 `--check-owners`：P4.2 负责 81 个使用点。新基础上的参照树（撤回本批业务切换）同样是这 81 个点，另有 main 带来的 2 个未归属点，协调者判定由本批迁移：`DeepSeekBalance.tsx` 和 `RunnerEngines.accountFold.test.tsx`。逐点列表见 [inventory-closure.json](inventory-closure.json) 的 `before.p42` 与 `before.unowned`。

- 审计记为“生产”的 18 个文件：
  - `components/` 下 10 个：`AccountPause`、`AccountPools`、`ClaudeHistoryOffer`、`CodexSignIn`、`DeepSeekBalance`、`RunnerEngines`、`RunnerEnginesSection`、`RunnerRegisterGuide`、`RunnerTokenRotation`、`SharedPool`；
  - `pages/` 下 7 个：`AdminUsersPage`、`EnrollPage`、`ProviderConnectPage`、`ProviderPoolPage`、`ProvidersPage`、`RunnerDetailPage`、`RunnersPage`；
  - `RunnerEngines.test-helpers.ts`（测试辅助，文件名不是 test/spec，所以审计记为生产）。

  前 17 个导入 antd。`DeepSeekBalance` 来自 main 936ebbd3c（Providers 列表与 Provider 编辑页的 DeepSeek 账户余额）。
- 测试 23 个：
  - `AccountPause.test`；
  - `RunnerEngines` 的 `.accounts`、`.antigravityAccounts`、`.claudeAccount`、`.duplicateAccount`、`.removeAccount`、`.renameAccount`、`.singleAccount`，以及 main 16d157656 新增的 `.accountFold`；
  - `AdminUsersPage` 的 `.accessTokens`、`.signIn`；`ProviderConnectPage.gemini`；`ProviderPoolPage` 的 `.access`、`.whoCanUseIt`；
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

## Rebase 到 origin/main

- **冲突**：只有两处 import 块（`ProvidersPage`、`ProviderConnectPage`），是 main 的 DeepSeek 余额导入和本批的 Orbit 组件导入撞在一起，两边都保留。
- **自动合并的 main 改动**（都在新基础上重新验证过）：
  - `RunnerEngines`：登录将过期的提示、登出后的说明（原生按钮），以及运行器卡片的折叠三角；
  - `AdminUsersPage`：Google 登录说明 `GOOGLE_SIGN_IN_ONLY_HINT`；
  - 两份单测的新断言：`RunnerEngines.singleAccount` 的 Codex 未登录说明，`AdminUsersPage.signIn` 的新说明文字。它们合进了已改为按角色和名称定位的版本，没有带回 `.ant-*` 选择器。
- **main 新增、落在本批页面里的 antd 使用点**：`DeepSeekBalance.tsx` 的两处 antd `Button`，在业务切换提交里迁移：
  - 刷新和重试用 Orbit `Button size="small"`，保留 loading；
  - 充值用 `LinkButton variant="primary" size="small"`，仍是新标签页打开的 `<a>`。

  main 的 `DeepSeekBalance.test.tsx` 不用改就通过。
- **P4.2 浏览器用例**：
  - main 改了 Add user 对话框里 Google 登录说明的文字，用例断言随之改为新文字（两棵树相同）；
  - 新增一个 DeepSeek 余额用例，见[对照方法](#对照方法)。P0 和原有的 P4.2 固定数据里都没有 DeepSeek key，不加这个用例的话，同提交对照走不到余额区。
- **范围外的未归属点**：rebase 后（DeepSeekBalance 已迁移、07c 尚未扩充）`--check-owners` 报出 5 个点（[after-rebase-check-owners](checks/after-rebase-check-owners.json)）。协调者 2026-10-08 判定了它们的 owner，登记在 `2026-10-07c.json`，见[协调者转告的事项](#协调者转告的事项)。

## 提交

| 提交 | 内容 |
| --- | --- |
| `0d66801d6` | **feat：公共组件。**<br>新增 `NumberInput`、`Result`、`Descriptions`；`Table.tsx` 增加 `TableFrame`/`TableEmptyRow`。<br>已有组件加变体：`Badge` 增加 green/orange/red/gold，`Button` 增加 dashed，`RadioGroup` 增加 `buttonStyle="solid"`，`PasswordInput` 可受控显示，`ConfirmDialog` 增加 `kind="success"`，`Switch` 补上旧开关的 `min-width`。<br>README 写明用法。 |
| `b4ebd792c` | **feat：业务切换。**<br>17 个生产文件不再导入 antd（含 main 新增的 `DeepSeekBalance`）；index.css 去掉本批的 `.ant-*` 覆盖，改写到 Orbit 类名；CliLoginPage 改用公共 `Descriptions`/`Result`。<br>22 个单测、accountFold 用例和测试辅助文件改按角色、可访问名称和页面类名定位，去掉 AntD `App` 包裹。 |
| `a731c59ac` | **test：同提交对照用例。**<br>`p42.browser.mjs`（22 个用例）、`p42-fixtures.mjs`、`p42.config.mjs`；P0 矩阵忽略 `p42*.browser.mjs`。 |

之后的提交只增加本目录的证据和 `inventory-delta` 的 07c 记录。

- 撤回 `b4ebd792c` 就恢复本批的 AntD 页面，同提交参照树正是这样得到的。
- `0d66801d6` 单独存在时，没有业务页面引用新增组件；已有组件只多了变体，`Switch` 的 `min-width` 只在开关被挤窄时起作用。

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
| `AdminUsersPage` | Table、`modal.success`、Modal、Popconfirm、Input、Space、Tag、Spin、Button | 原生表格（`TableFrame`）、`ConfirmDialog kind="success"`、Dialog、Popconfirm、Input、Badge、Spinner、Button |

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
  - 列与原表相同：Email、Name、Role、Sign-in、Created、操作；
  - `users.isLoading` 时加遮罩和 Spinner，无用户时显示 `TableEmptyRow`；
  - 行操作：Reset password（Popconfirm）、Access tokens（令牌弹窗）、Unlink Google（确认对话框，只在关联了 Google 的行）、Make admin / Make member、Delete（Popconfirm）。
- P4.2 用例覆盖两张表的加载、有数据、删除确认与空状态，桌面与手机各 4 个环境：`p42-keys-loading`、`p42-keys`、`p42-keys-delete`、`p42-keys-empty`、`p42-users-loading`、`p42-users`、`p42-users-reset`、`p42-users-password`、`p42-users-delete`、`p42-users-empty`。

## 确认流程、权限与错误反馈

- **确认**：上面 10 个 confirm 与 1 个 success 都改为局部的 `useConfirm`/`ConfirmDialog`：
  - RunnerDetailPage：放弃修改（两处）、移除导入的会话、删除工作区、修复检出、删除 Runner；
  - RunnersPage 的删除、令牌轮换；
  - SharedPool：改为仅自己、移出成员；
  - 管理员页：新建用户与重置密码后的一次性密码通知（同一处 success）。

  锚定确认改为 Orbit Popconfirm：移除账号、删除 API 密钥、删除或离开账号池、从池中移出密钥、登出 ChatGPT 账号、重置密码、删除用户。

  文案、按钮、危险色与请求都不变；trace 中每个确认发出的请求，两棵树逐字相同。
- **权限呈现**：账号池页按读者身份（拥有者、成员、被加入者）显示的内容不变，包括“谁能用”、规则开关、成员菜单、Delete pool / Leave pool。覆盖它们的有：用例 `a Codex pool of one’s own`、`a pool somebody added the reader to`，单测 `ProviderPoolPage.whoCanUseIt`、`.access`、`ProvidersPage.sharedPools`。
- **错误反馈**：
  - 通知仍走 `useToast`；
  - 确认对话框里失败的请求以 `role=alert` 显示，可以重试；
  - 两棵树对照了这些错误状态：Provider 探测失败的 alert（`p42-connect-probe-error`）、注册确认的失效码（`p42-enroll-error`）、重名提醒（`p42-enroll-conflict`）、DeepSeek 拒绝密钥（`p42-deepseek-refused`）。

## 单测

本批 22 个测试文件、accountFold 用例和测试辅助文件，改为按角色、可访问名称和页面自己的类名定位，去掉 `.ant-*` 选择器与 AntD `App` 包裹。断言内容不变。

- **菜单**：按按钮的 `aria-expanded` 与菜单的 `aria-labelledby`，找到这个按钮打开的那个 `role=menu`，再按名称点 `role=menuitem`。
- **对话框与确认**：按 `role=dialog`/`alertdialog`，以及 `aria-labelledby` 指向的标题、`aria-describedby` 指向的说明；锚定确认的取消、确认按钮在该对话框内查找。
- **单选、分段、复选、开关**：用 `role=radio`/`checkbox`/`switch` 和 `aria-checked`、`aria-disabled`。Keep Free 选择器用 `role=combobox`/`option`，选项按浏览器的完整按下序列点击。
- **状态标签**：Badge 和被替换的 Tag 一样没有 ARIA 角色，所以按页面自己的状态槽 `.re-status`/`.pool-status` 读可见文字。单账号行的“预设色”断言原来读 AntD 的 `ant-tag-green`、`ant-btn-text`，现在读 Orbit 的色调与按钮变体类名（`orbit-badge-green`、`orbit-button-text`）。
- **改名**：编辑器要等菜单交还焦点后才打开（见[开发中发现并修正的问题](#开发中发现并修正的问题)第 1 条），所以用例改为等编辑器出现，仍断言它获得焦点、全选原名。

main 新增和改动的相关单测，在新基础上不用改就通过：`DeepSeekBalance.test`、`lib/deepseekBalance.test`、`lib/accountLogin.test`、`RunnerEngines.loginLapse.test`、`RunnerEngines.kimiSite.test`、`RunnerSignIn.test`、`AdminSignInPage.test`、`LoginPage.google.test`。合并检查里的全量 Vitest 结果见[组件矩阵、合并检查与重复运行](#组件矩阵合并检查与重复运行)。

## 对照方法

沿用 P3.1/P3.2/P4.1 的同提交对照。

- **三棵树**：
  - 参照树 `ad04b5817`：交付 `a731c59ac` 只撤回业务切换 `b4ebd792c`，在独立的稀疏工作树里本地提交，没有推送；对照跑完后已删除，可由脚本重建。本批页面是 AntD，公共组件、P4.2 用例和其它一切都与交付相同。
  - 起点树 `7e4655bc2`：新基础本身，用来检查公共组件改动对已迁移页面的影响。
  - 交付树 `a731c59ac`。
- **构建与环境**：
  - 三棵树各自 `vite build`，再 `vite preview`；
  - Playwright 1.63.0 / Chromium 1243 / WebKit 2359；P0 字体与 `environment.mjs` 校验；DPR 1、en-US/UTC、固定时间与固定 REST 数据；reducedMotion=reduce；
  - 八个环境 = Chromium/WebKit × 明/暗 × 桌面 1280×900 / 手机 390×844；
  - 每次运行在独立网络命名空间里，固定端口互不干扰。

  工作树的建法见 [make-reference-newbase.sh](scripts/make-reference-newbase.sh)。正式运行一次跑完（[formal-newbase.sh](scripts/formal-newbase.sh)），随后跑探针（[probe-newbase.sh](scripts/probe-newbase.sh)；开关探针改用按角色的定位器后在两棵树上重跑，见 [probe-switch-newbase.sh](scripts/probe-switch-newbase.sh)），始终一次只跑一个。比较与分类的命令在 [analyze-newbase.sh](scripts/analyze-newbase.sh)。原始运行放在 `/mnt/data/tmp/34Za39Feocgj42rrBYwzl/`（本目录只收引用的副本，见 [collect.sh](scripts/collect.sh)）。

对照内容：

- **P4.2 用例**（[p42.browser.mjs](../../../../src/web/ui-migration/p42.browser.mjs)）：22 个用例 × 8 个环境，覆盖 P0 矩阵走不到的本批状态（P0.2 没有 Provider、Runner、用户页）。
  - 定位器是角色、可访问名称、标签和页面自己的类名，同一份文件驱动两棵树。对话框、选择器、数字框、表格的外框用两边的类名并列（如 `.ant-modal-container, .orbit-overlay`），只用于样式取值。
  - 每一步记录 trace：地址、焦点、打开的对话框与菜单（项与禁用状态）、alert、通知区文字、该步发出的请求。
  - 新增的 DeepSeek 余额用例只在这个用例里加入三把 DeepSeek key（预设、团队、`api.deepseek.com` 上的自定义端点），并模拟余额接口（可以暂扣应答）。截图有：列表行、读取、刷新中、过低（充值按钮）、被拒（Retry）、首次加载中。
  - trace 另记充值链接的 tag、href、target、rel；[trace-semantics.py](trace-semantics.py) 把它和“显示已存密钥的输入框类型”一起算作语义字段。
- **P0 页面矩阵**：用 P3.2 的 [p32-reference.config.mjs](../p3.2/p32-reference.config.mjs)。参照树写出截图；交付树先按 `maxDiffPixels: 0`（Playwright 默认的逐像素色差阈值 0.2）对参照截图比较一次，再写出自己的截图供逐张分类。另外在交付树和起点树上各跑一次标准 P0 回归（对照 P0.2 原图和漂移层、已接受层）。
- **起点对照**：P4.1 用例（CLI 登录、访问令牌、管理员令牌弹窗等）与 P3.2 试点（任务详情、分享、账号选择器），在起点树和交付树上各跑一次。
- **分类**：逐字节相同 / 抗锯齿级（每个差异像素每通道 ≤2）/ 超出。超出的逐张说明，并用 [beyond-clusters.py](scripts/beyond-clusters.py) 把 >2 级的像素聚成区域。各脚本的分工：
  - [p3.2/compare_runs.py](../p3.2/compare_runs.py) 比较截图、计算样式与 trace；
  - [p4.1/summarize.py](../p4.1/summarize.py) 分类；
  - [trace-semantics.py](trace-semantics.py) 逐步比较 trace 的语义字段（地址、请求、通知、菜单项、alert，以及上面两项），焦点与对话框文字另行计数。

## 对照结果

正式运行依次为：P4.2 参照、P4.2 交付、P0 参照、P0 严格比较、P0 交付、标准 P0（交付、起点）、合并检查、overlays、controls、起点与交付的 P4.1 用例和 P3.2 试点、WebKit 重复运行。

- 日志在 [runs/](runs)：开头记 argv、树、HEAD、未提交路径、负载与磁盘余量，结尾记退出码。
- 报告去掉了附件正文（`*.report.summary.json`）。

链上的两次中断：

- 第一次启动后不久就停了：main 改了 Add user 的 Google 说明，用例断言要随之改，见上文。改完重启，所以下面的结果都是同一个交付提交上的。
- 05:04Z 根分区可用空间降到 5.7 GB，按协调者规则暂停了链（SIGSTOP 链脚本）：正在跑的 pilot-del 继续跑完，下一步先不启动。不到一分钟后回到 7 GB 以上，链继续（SIGCONT），各步的退出码照常记录。

### P4.2 用例

| 运行 | 提交 | 结果 |
| --- | --- | --- |
| [f-p42-ref](runs/f-p42-ref.txt) | 参照 `ad04b5817` | 172 通过、4 跳过 |
| [f-p42-del](runs/f-p42-del.txt) | 交付 `a731c59ac` | 172 通过、4 跳过 |

跳过的 4 个是手机上的“页面自己的按钮：静止、悬停、按下”（触屏没有悬停）。

截图共 620 张，桌面每个环境 78 张、手机 77 张。

- 汇总 [compare/f-p42-summary.json](compare/f-p42-summary.json)，逐张数据 [compare/f-p42-compare.json](compare/f-p42-compare.json)；
- >2 级像素的区域 [compare/f-p42-beyond-clusters.txt](compare/f-p42-beyond-clusters.txt)，超出的每一对在 [shots/f-p42-beyond](shots/f-p42-beyond)。

结果：**334 张逐字节相同，225 张抗锯齿级，61 张超出**。超出的 61 张：

| 截图 | 环境 | 差异 | 归类 |
| --- | --- | --- | --- |
| 边缘栅格化 47 张（清单见表下） | 各环境 | 每张 >2 级的像素 1–37 个 | **边缘栅格化**，具体部位见表下 |
| `p42-pool-add-account`、`p42-pool-replace-key`、`p42-pool-signout` | WebKit 明/暗桌面（6 张） | 8px 滚动条列；两棵树的页面滚动位置不同 | **对话框滚动锁**（待判定，见下）：通知的 1px 溢出让文档出现内嵌滚动条后，参照打开对话框会去掉滚动条（内容右移 4px），交付保留槽位；交付打开 Replace key 时页面滚回 0，之后的登出截图延续这个位置 |
| `p42-pool-signout`、`p42-users-delete` | WebKit 明/暗手机（4 张） | 确认浮层右缘 382 对 390 | **WebKit 手机 382/390**（P2.3-B1、P4.1 已记录）：内容与宽度相同 |
| `p42-pool-tooltip` | 桌面 4 个 | 气泡左移 8px，箭头不动 | **Tooltip 贴边边距**（待判定） |

边缘栅格化的 47 张：

- `p42-engine-menu` ×8、`p42-new-pool-people` ×8；
- `p42-runner-delete`/`rename`/`rotate`/`token`（Chromium 明色手机）；
- 加载中的：`p42-runners-loading` ×3、`p42-users-loading` ×2、`p42-keys-loading`；
- 工作区：`p42-workspace-edit` ×2、`-history` ×2、`-discard`、`-menu`；
- `p42-account-pause-custom` ×2、`p42-new-pool-claude` ×2、`p42-new-pool`、`p42-engine-remove` ×2、`p42-pool-just-mine` ×2；
- `p42-pool-replace-key`（Chromium 手机 ×2）、`p42-pool-add-account`（Chromium 明色手机）；
- `p42-connect-edit-shown`、`p42-connect-dialect-open`、`p42-deepseek-refreshing`（WebKit 明色手机）。

差异落在这些部位：菜单与浮层的圆角、菜单图标、提供方图块与复选框的圆角、对话框关闭图标、输入框里最后一个字形或眼睛图标的边缘、加载点的静止帧（20 级以内）。

- 手机对话框截图里成千上万个 1–2 级的像素，是遮罩合成的取整，计入抗锯齿级。
- 新出现的两张的放大对照：[密钥框的眼睛图标](shots/crops/chromium-light-desktop-p42-connect-dialect-open-ref-vs-del.png)、[刷新按钮的加载弧](shots/crops/webkit-light-phone-p42-deepseek-refreshing-ref-vs-del.png)。
- DeepSeek 余额的 48 张：42 张逐字节相同、5 张抗锯齿级、1 张即上面这条加载弧（1 个像素 3 级）。

计算样式差异（294 次截图）只有几类，与旧基础相同：

- 对话框的 `surface` 选择器：参照命中 AntD 的透明外层，交付命中本身就是表面的 `.orbit-overlay`（P3.2、P4.1 已记录）；
- WebKit 下行高的数值精度：`22px` 对 `22.000019px`；
- Codex 登录码的复制按钮：参照里位于代码元素内，交付里与它并列，测量宽度差 26px，截图相同；
- WebKit 手机上确认浮层宽 390 对 382（上一节）。

DeepSeek 余额的截图没有计算样式差异。

**trace**（[compare/f-p42-trace-semantics.json](compare/f-p42-trace-semantics.json)，两棵树的逐步记录在 [traces/](traces)）：共 172 个用例、872 步。

- 语义字段**全部相同**：地址、请求（方法、路径、请求体）、通知、alert、显示已存密钥的输入框类型，以及充值链接（`<a>`、href、`target=_blank`、`rel=noreferrer`）。
- 菜单项与禁用状态：两棵树都记到菜单的步骤全部相同。另有 5 步，参照在观察那一刻还没有记到可见的 AntD 下拉（入场动画中透明度为 0）：
  - Chromium 4 步：成员菜单 ×3、Runner 的 Actions 菜单；
  - WebKit 暗色桌面 1 步：Runner 列表菜单。

  紧接着的截图里菜单已经打开，与交付只差 8–16 个 ≤1 级的像素。
- 其余差在不属于业务语义的字段，都是 P2.1–P4.1 已接受的约定：

| 字段 | 步数 | 内容 |
| --- | --- | --- |
| 焦点 | 335 | 焦点落在带角色的元素上，而不是 AntD 的隐藏 `input`（单选、分段、选择器、数字框）；菜单、确认浮层与对话框打开时聚焦自身（P2.1/P2.2），模态确认默认聚焦 Cancel；关闭后焦点回到打开它的按钮（AntD 多数落到 body） |
| 打开的对话框 | 120 | Orbit 锚定确认是 `role=dialog`，打开时列在对话框里（旧确认浮层是 tooltip）；AntD 的确认与成功弹窗在文字里把标题重复一遍，多选框把标签文字重复一遍；通知挂在打开的 Orbit 对话框里（P2.3），其文字出现在对话框文字中 |

### P0 页面矩阵与标准 P0

| 运行 | 树 | 结果 |
| --- | --- | --- |
| [f-p0-ref](runs/f-p0-ref.txt) | 参照 | 101 通过、11 跳过（写出参照截图） |
| [f-p0-strict](runs/f-p0-strict.txt) | 交付 | 101 通过、11 跳过：按 `maxDiffPixels: 0`（Playwright 默认的逐像素色差阈值 0.2）对参照截图比较 |
| [f-p0-del](runs/f-p0-del.txt) | 交付 | 101 通过、11 跳过（写出交付截图，供逐张分类） |
| [f-p0-standard](runs/f-p0-standard.txt) | 交付 | **101 通过**、11 跳过：标准 P0 回归，对照 P0.2 原图、漂移层与已接受层（[各截图的期望来源](runs/f-p0-standard.expected-sources.json)） |
| [f-p0-standard-base](runs/f-p0-standard-base.txt) | 起点 origin/main `7e4655bc2` | 100 通过、1 失败、11 跳过 |

- **逐张分类**：参照与交付的截图共 252 张，226 张逐字节相同、25 张抗锯齿级、1 张超出。超出的是 `breakpoint-639-projects`（Chromium 暗色桌面）：侧栏图标边缘 3 个像素 >2 级，最多 4 级。
- **起点树的失败**：Chromium 明色桌面的 `settings-saved`，467 个像素不同，全部在右上角 “Setting saved” 通知里（[expected/actual/diff](shots/p0-standard-base)）。这是在 origin/main 本身上跑的，不含本批改动；同一条链上交付的这一项通过。通知区的这类计时抖动在负载高的共享主机上已有记录。
- **WebKit 手机 `profile-validation`**：P4.1 留待判定的这一项，已由协调者对 P4.1 的判定写进已接受层（`p0-drift/accepted`），交付的标准 P0 按它通过。

### 起点对照（P4.1 用例与 P3.2 试点）

| 运行 | 树 | 结果 |
| --- | --- | --- |
| [f-p41-base](runs/f-p41-base.txt) | 起点 `7e4655bc2` | 96 通过 |
| [f-p41-del](runs/f-p41-del.txt) | 交付 | 96 通过 |
| [pilot-base](runs/pilot-base.txt) | 起点 | 81 通过、7 跳过 |
| [pilot-del](runs/pilot-del.txt) | 交付 | 81 通过、7 跳过 |

- **P4.1 用例**：截图 272 张，244 张逐字节相同、25 张抗锯齿级、3 张超出（[compare/f-p41-summary.json](compare/f-p41-summary.json)）。
  - 超出的 3 张：`p41-tokens-loading`（Chromium 暗色桌面，加载点静止帧，67 个像素 >2 级，最多 21 级）；`p41-profile-photo` ×2（Chromium 暗色手机、明色桌面，头像照片圆边的缩放取样，10 个与 144 个像素，最多 30 级，[放大对照](shots/crops/chromium-light-desktop-p41-profile-photo-base-vs-del.png)）。
  - 计算样式差异只在 `p41-admin-tokens`（8 个环境）。这是管理员从用户页打开的令牌对话框，AdminUsersPage 属本批，Modal 换成了 Orbit Dialog，`surface` 选择器命中的元素不同（同上）；截图逐字节相同或抗锯齿级。
  - trace：96 个中 82 个相同。另外 14 个只差焦点，共 18 步：
    - 8 步是这个令牌对话框：AntD 聚焦关闭键，Orbit 聚焦对话框本身（P2.1 约定）；
    - 6 步是登录失败、设置页、CLI 登录批准时，按下按钮后焦点落在按钮还是 body。两个方向都有，这些页面的代码两棵树相同（本批对 CLI 登录页只换了标签-值表与结果块），是取样时刻的差别。
- **P3.2 试点**：截图 256 张，228 张逐字节相同、25 张抗锯齿级、3 张超出（[compare/pilot-summary.json](compare/pilot-summary.json)），没有计算样式差异。
  - 超出的 3 张：`pilot-delete-confirm`（Chromium 明色桌面，对话框遮罩下 ⋮ 图标边缘 5 个像素，最多 20 级，[放大对照](shots/crops/chromium-light-desktop-pilot-delete-confirm-base-vs-del.png)）；`pilot-dependencies`、`pilot-dependency-view-hover`（WebKit 明色手机，各 1 个像素、3 级）。
  - trace：72 个中 64 个相同。不同的 8 个里，焦点 9 步（同样两个方向都有），另有 1 步确认浮层在起点树上观察时还在关闭，1 步下拉在起点树上观察时还开着。
  - 本批对这些页面的改动只有公共组件的新增变体；`ConfirmDialog` 默认 kind 的图标、按钮、初始焦点与回调不变。

### 组件矩阵、合并检查与重复运行

| 运行 | 命令 | 结果 |
| --- | --- | --- |
| [c-merge](runs/c-merge.txt) | `npm run build -w @orbit/web && npm run test -w @orbit/web` | 构建通过；Vitest 357 个文件、4570 个测试全部通过 |
| [c-overlays](runs/c-overlays.txt) | `npm run test:ui-overlays -w @orbit/web` | 96 通过 |
| [c-controls](runs/c-controls.txt) | `npm run test:ui-controls -w @orbit/web` | 32 通过 |
| [f-p42-repeat](runs/f-p42-repeat.txt) | WebKit 明/暗桌面，`-g "engines\|its menus"` 选中的 3 个用例各重复 5 次：账号菜单的 Rename、工作区的 Configure，以及名字里同样含 its menus 的 Codex 账号池用例 | 30 通过 |

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
- **验证**：新基础上用同一探针（[rename-probe.browser.mjs](rename-race/rename-probe.browser.mjs)）对照修正前后：未压缩的开发服务器，Chromium 明色与 WebKit 明/暗桌面，各 5 次。
  - **修正前**：树 `3e249ddb5` 是交付撤回这一修正（[rename-fix-reversed.patch](rename-race/rename-fix-reversed.patch)）。WebKit 明色桌面 5 次 Rename 中，有 3 次编辑器打开后立即关闭，焦点留在 More（[rename-before.jsonl](rename-race/rename-before.jsonl)）：编辑器在移除菜单的同一次提交里由 `autoFocus` 拿到焦点，5ms 后 Base UI 的焦点归还聚焦 More，编辑器失焦关闭。这一轮修正前的 Configure 没有复现竞争（15/15），它与 Rename 是同一机制、同样的改法。
  - **修正后**：Rename 与 Configure 各 15/15（[rename-after.jsonl](rename-race/rename-after.jsonl)）。
  - **正式运行**：这两个用例八个环境都通过；WebKit 明/暗桌面再各重复 5 次，也全部通过（f-p42-repeat）。

### 2. 手机：开关被 flex 行挤窄

- **现象**：第一轮对照中，账号池页 Who can use it 的两条规则在手机上（Chromium/WebKit、明/暗）开关只有约 28px，关闭态只剩圆点，说明文字随之换行。Provider 编辑页的 Enabled 开关被挤到 43.3px。
- **原因**：Orbit `Switch` 只设了 `width: 44px`，作为 flex 子项会被旁边的长文字压缩；旧开关有 `min-width: 44px`（small 28px）。
- **修正**：公共 `Switch` 补上同样的 `min-width`。其它页面只有在开关被挤窄时才会有变化。
- **验证**：新基础上，两棵树八个环境里的规则开关与 Enabled 开关都是 44px（[probe-switch-ref](probes/probe-switch-ref.jsonl)、[probe-switch-del](probes/probe-switch-del.jsonl)）。
  - 第一次运行按名称找 Enabled 开关。参照里被替换的开关没有可访问名称，8 个环境都没找到，即 [probe-geometry-ref](probes/probe-geometry-ref.txt) 的 8 个失败。
  - 改为按角色取编辑页上的开关后，两棵树重跑。

### 3. 工作区编辑器里“固定”的引擎勾选

- **现象**：起点对照的 P3.2 试点截到了 Runner 详情的工作区编辑器。Engines it may use 中，智能体自己的引擎是勾选且不可取消的：旧页面画成灰色的禁用勾，交付画成蓝色的已勾选框。
- **原因**：index.css 这段旧规则写着“drawn as on, not as greyed out”，但其中给勾选框上色的两条在 AntD 下从未生效（AntD 自己的禁用样式选择器同样具体、注入在后），页面实际一直显示灰色。迁移后，这两条对 Orbit 复选框生效了。
- **修正**：按“保持现有外观”，删去这两条，保留确实生效的芯片底色、文字颜色与光标规则。交付与起点在这几张截图上回到抗锯齿级。
- **待定**：规则作者原本想要的“画成已勾选”从未上线，是否实现由协调者决定（见[待协调者判定](#待协调者判定已在任务评论报告)）。

### 4. 用例的时序：Always allowed 的加载

- **现象**：第一轮对照中，Chromium 桌面的 `p42-workspace-advanced` 整页差 15px。
- **原因**：用例在 Advanced 展开后立刻滚动。交付在那一刻 Always allowed 的规则列表还在加载（字段高 48.42px），参照已经加载完（63.61px）。两棵树加载中和加载后的高度都相同，差别只是取样时刻。
- **修正**：用例改为等规则列表出现后再滚动截图，没有放宽任何断言。
- **验证**：新基础上两棵树八个环境都是：加载中 48.42px；加载后桌面 63.61px、手机 82.2px（[probe-geometry](probes/probe-geometry-del.jsonl)）。

## 迁移清单

在交付提交上重跑复扫：[delivery-audit-summary](checks/delivery-audit-summary.txt)、[delivery-check-owners](checks/delivery-check-owners.json)，审计全文 [delivery-audit.json](checks/delivery-audit.json)。[inventory-closure.mjs](inventory-closure.mjs) 对比参照 `ad04b5817` 与交付 `a731c59ac`，结果在 [inventory-closure.json](inventory-closure.json)：

- **使用点**：P4.2 负责的使用点 **81 → 0**。未归属 2 → 0，即参照树上 main 带来的 `DeepSeekBalance.tsx` 和 `RunnerEngines.accountFold.test.tsx`；待定 0 → 0。
  - 其它阶段的数量不变：P4.3a 83、P4.3b 31、P4.4 50、P5.1 28、P5.2 11、P5.3 93、P6 37、KEEP 1。
  - 两边读的是同一组三份记录（`2026-10-07.json`、`2026-10-07b.json`、`2026-10-07c.json`）。
- **导入**：17 个生产文件不再导入 antd（导入前后逐文件列在 `files`）。15 个测试文件去掉了 AntD `App` 包裹，另有 5 个生产文件不再用 `App.useApp`。
- **审计计数**（参照 → 交付）：
  - 直接引用 antd 的生产文件 94 → 77，测试文件 77 → 62；
  - 含 `.ant-*` 选择器的测试文件 58 → 40，含裸 `ant-*` 类名的测试文件 63 → 45（审计的 `antSelectorTestFiles`、`antClassTestFiles`）；
  - `--check-retired` 阻塞文件 231 → 190。
- **命中行**（参照 → 交付）：
  - `ant-class` 433 → 299、`ant-selector` 407 → 277、`antd-reference` 346 → 293；
  - `imperative-confirm` 22 → 12、`use-app` 16 → 9、`provider` 89 → 74、`internal-ref` 5 → 3。
- **`imperative-feedback`** 剩 219 行：这是对 Orbit `useToast` 返回值 `message.success/error(...)` 的文字命中（P4.1 的页面同样如此），不是 AntD 调用，审计的归属规则不把它算作使用点。
- **清单自检**都通过：[selfcheck](checks/selfcheck.txt)（原有自检与 owner 自检）、[p01-verify](checks/p01-verify.txt)（P0.1 覆盖：149 个归属、37 种契约、287 个测试、187 个 CSS 命中）。

## 协调者转告的事项

1. **`RunnerEngines.accountFold.test.tsx`**（main 16d157656 引入，原未归属）：
   - `.ant-tag` 定位已去掉。状态标签（Orbit Badge，与被替换的 Tag 一样）没有 ARIA 角色和可访问名称，没法按角色或名称定位；改为读页面自己的状态槽 `.re-status` 的可见文字（项目约定允许页面自有类名），`toEqual` 的精确列表不变。
   - 若要严格按角色定位，需要给状态槽加 role/aria，这是可访问性方面的产品改动，本批没有做。
   - 同样的写法也用于 `RunnerEngines.accounts`、`.claudeAccount`、`.antigravityAccounts`。
2. **`DeepSeekBalance.tsx`**（main 936ebbd3c，导入 antd `Button`）：本批迁移，见[业务切换](#业务切换)与 DeepSeek 余额用例。
3. **`2026-10-07c.json`**（协调者 2026-10-07 与 2026-10-08 的判定）：

   | 使用点 | owner | 依据 |
   | --- | --- | --- |
   | `ProjectDoneConversation.test.tsx`（main 21090b959，只有固定数据里的 “antd migration” 字样） | P6 | 先例 `ProjectWhyNotDoneGate.test.tsx` |
   | `StartProjectCard.test.tsx`（main 50e7ca040 起用了 `.ant-select-content`） | P4.3b | Start 卡片归 P4.3b |
   | `WorkspaceView.neverStarted.test.tsx`（main 622c30e1f，导入 antd `App`） | P5.3 | 会话工作区 |
   | index.css 第 6623–6624 行 `.ant-dropdown-menu-item.composer-engine-title` 两行（main 81845a53d） | P5.3 | 输入框引擎菜单 |
   | index.css 第 10625 行提到 `.ant-radio-group` 的注释（main 50e7ca040） | P4.3a | project-run 设置 |

   - 行号取自交付树，按原文登记，与协调者所说的 6624–6625、10626 是同一组行（本批的 index.css 改动让行号前移了一行）。owner 和依据都写协调者 2026-10-08 判定。
   - 记录由 [build-record-c.py](../inventory-delta/build-record-c.py) 生成：只读入前两份记录，算出仍未归属的点，从审计、P0.1 基线和 git blame 取事实，再写入判定。有点缺判定、或判定对不上任何点，脚本都会失败。没有使用 `2026-10-07d.json`。
   - `verify-record.mjs` 通过（[verify-record-c](checks/verify-record-c.txt)）：3 个文件条目和 3 个 index.css 条目与审计一致；读入前两份记录之后，拿掉它的新增/改动条目，正好有这 6 个点失去归属；三份记录一起读时 0 未归属、0 待定。
   - 交付上 `--check-owners` 为 0 未归属、0 待定。
4. **Rebase 到 origin/main**：已完成，最终检查都在新基础上重跑，见上文。

## 待协调者判定（已在任务评论报告）

1. **WebKit：打开 Orbit 对话框时，已滚动的页面跳回顶部**（公共层，不在本批页面代码里）。
   - **触发条件**：出现过一次通知后，`lib/toast.tsx` 的 `announce()` 在 body 末尾插入读屏 live region，文档高变成 901px（P4.1 已记录的 1px 溢出）。WebKit 因为全站 8px 的 `::-webkit-scrollbar`，给文档画出内嵌滚动条。
   - **机制**：Base UI `useScrollLock` 在有内嵌滚动条、又不能用 `scrollbar-gutter: stable` 时改写 body（`position: relative; height: 100dvh; width: calc(100vw - 8px); overflow: hidden`），这时本应用的 `.app-view` 丢掉滚动位置。
   - **新基础上复测**（[probe-geometry](probes/)）：
     - WebKit 桌面交付：账号池页从 72px 回到 0，关闭对话框后也不恢复；参照保持 72。
     - Chromium 与 WebKit 手机：两棵树都保持。
     - 另一面：参照打开对话框时去掉文档滚动条，内容右移 4px（326→330）；Orbit 保留滚动条槽位，内容不动（326）。
   - **截图**：WebKit 桌面的 `p42-pool-add-account`、`p42-pool-replace-key`、`p42-pool-signout` 各 2 张。
   - **影响与修法**：影响所有 Orbit Dialog/Drawer/ConfirmDialog。可能的修法是让 live region 不占文档流，或者在 Overlay 层处理。改 live region 会改变 P4.1 记录的 WebKit 手机通知位置（profile-validation），需要统筹，本批没有改。
2. **Tooltip 贴视口边缘时的边距**（P2.2 公共 Tooltip）：
   - 账号池页右缘按钮的提示：旧气泡贴边（距右缘约 1px）；Orbit Tooltip 的 `collisionPadding` 为 8（约 9px），箭头仍指向同一个按钮。截图是桌面 4 张 `p42-pool-tooltip`。
   - P4.1 已把 Popconfirm 改为 0 边距，Tooltip 没有改。
3. **固定引擎勾选的原意**：见[开发中发现并修正的问题](#开发中发现并修正的问题)第 3 条。本批保持了一直以来显示的灰色禁用勾。
4. **范围外的新未归属点**（2026-10-08 03:42Z 已报告）：main 6ec468a25 新增的 `WikiReviewPage.decided.test.tsx` 导入 antd `App`，并用 `.ant-modal` 等选择器。本批落在 `7e4655bc2` 上，不含它，合入后会是未归属点。建议归 P4.4（`WikiReviewPage.tsx` 在 P0.1 归 P4.4）；本批不登记它。

## 未消除的差异

- **待判定的两类**：WebKit 桌面对话框的滚动锁（6 张）与 Tooltip 边距（4 张），见上。
- **WebKit 手机确认浮层贴右缘**（4 张：`p42-pool-signout`、`p42-users-delete`，明/暗各一）：内容与宽度相同，Orbit 浮层右缘在 382px，旧浮层画到 390px。这是 P2.3-B1 与 P4.1 已记录的 WebKit 手机机制：1px 溢出后 `visualViewport` 宽 382，Floating UI 以它为边界。
- **其余 47 张超出**：都是图标、圆角、输入框末字或加载点的边缘栅格化，每张 >2 级的像素不超过 37 个。逐张区域见 [compare/f-p42-beyond-clusters.txt](compare/f-p42-beyond-clusters.txt)。
- **WebKit 下的行高精度**：`22.000019px` 一类的数值来自全站 CSS 压缩，与 P3.2 相同，截图不受影响。

## 未确立的部分

- 只在 Linux 上的 Playwright Chromium/WebKit 模拟中比较，没有真机，也没有用读屏软件实测。
- 同提交截图对照只在减少动态效果下做。菜单、对话框、提示与开关的默认动效沿用 P2 公共组件已验证的取值，本批没有逐帧对照。
- 后端是固定 REST 数据，不连真实服务（DeepSeek 余额同样只用固定应答）。Gemini 密钥、Antigravity/Kimi 账号等没有进入 P4.2 截图的状态，由各自的单测覆盖。
- 结论基于 origin/main `7e4655bc2`。之后 main 的提交只做了合并干跑，没有在合并结果上重跑对照。

## 旧基础上的过程记录

本批最初交付在 `3aa26fb97` 上，提交为 `396fff3d1` / `9fb516a04` / `241b00a8b`，参照树 `ede2ca966`。那一轮的结果（[oldbase/](oldbase)）：

- **P4.2 用例**：两棵树各 164 通过、4 跳过。572 张截图中，300 张逐字节相同、215 张抗锯齿级、57 张超出，全部归类：边缘栅格化 43 张、对话框滚动锁 6 张、WebKit 手机 382/390 共 4 张、Tooltip 贴边 4 张。
- **trace**：地址、请求、通知与 alert 全部相同。
- **P0**：参照与严格比较 101 通过。
- 当时链上其余的运行，在 2026-10-08 00:31Z 按协调者的磁盘紧急要求停下；之后协调者要求 rebase，这一轮就被新基础上的运行取代了。上面第 1–4 条问题都是在旧基础上发现并修正的，修正随提交一起 rebase 了过来。

## 复现

```bash
# 参照树与起点树（见 scripts/make-reference-newbase.sh），然后一次跑完正式对照与探针：
scripts/make-reference-newbase.sh <delivery> b4ebd792c 7e4655bc2
scripts/formal-newbase.sh                  # 日志在 /var/tmp/p4.2-753ee3/newbase/runs/<name>.txt（链接到 /mnt/data/tmp/34Za39Feocgj42rrBYwzl/）
scripts/probe-newbase.sh && scripts/probe-switch-newbase.sh
scripts/analyze-newbase.sh                 # 截图、计算样式与 trace 的比较和分类
# P4.2 用例单独运行（在要比较的树的 src/web 下）：
P42_SNAPSHOTS=<dir> P42_OUTPUT=<dir> npx playwright test --config ui-migration/p42.config.mjs --update-snapshots=all
# 比较与分类：
python3 -I ../p3.2/compare_runs.py REF_SHOTS DEL_SHOTS REF_REPORT DEL_REPORT compare.json
python3 -I ../p4.1/summarize.py compare.json > summary.json
python3 -I trace-semantics.py REF_REPORT DEL_REPORT > trace-semantics.json
# 清单（从仓库根目录）：
node src/web/scripts/audit-antd.mjs --check-owners
python3 -I docs/evidence/base-ui-migration/inventory-delta/build-record-c.py docs/evidence/base-ui-migration/p4.2/checks/delivery-audit.json \
  | cmp - docs/evidence/base-ui-migration/inventory-delta/2026-10-07c.json
node docs/evidence/base-ui-migration/inventory-delta/verify-record.mjs docs/evidence/base-ui-migration/p4.2/checks/delivery-audit.json 2026-10-07c.json
node docs/evidence/base-ui-migration/p4.2/inventory-closure.mjs REF_AUDIT.json DEL_AUDIT.json > inventory-closure.json
# 本目录的副本由 scripts/collect.sh 从 /var/tmp 复制（报告去掉附件正文）。
```
