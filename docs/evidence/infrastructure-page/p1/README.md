# P1 Web：Runners 与 Providers 合并为 Infrastructure 页 — 验证

代码在提交 `6b2f53d87`（基于 main `86203ffb0`）。效果图：[`docs/mocks/infrastructure-page`](../../../mocks/infrastructure-page/)。

## 1. 旧两页的每个操作，在新页面的哪里

对照 `01-before-runners.png` 与 `01-before-providers.png` 列出旧两页的全部操作。
「测试」列是 `src/web/src` 下的 vitest 用例（文件 › 用例名），全部在第 3 节的本分支整套运行中通过；
截图是本任务会话的附件（真实 web 控制台 + 假 `/api`，见第 3 节）。

| # | 旧页面上的操作 | 新页面上的位置 | 测试 / 截图 |
|---|---|---|---|
| 1 | Runners：Register Runner | 右上 Add › Register a machine（→ `/runners/register`）；Machines 为空时的 Register a machine | `pages/InfrastructurePage.test.tsx` › adds what each section holds from Add: a machine, a key, or a pool；› says what each section is for before there is anything in it；`components/RunnerEngines.test.tsx` › offers the free route first when there is no runner at all；截图 `infrastructure-add-menu.png` |
| 2 | Runners：点卡片进入机器页 | 机器卡片头 Details → | `pages/InfrastructurePage.machines.test.tsx` › opens the machine’s page from Details |
| 3 | Runners：拖拽排序（`POST /runners/reorder`） | 机器卡片头左侧的拖拽柄（键盘 Space / ↓ / Space 同样可排） | `InfrastructurePage.machines.test.tsx` › moves a machine down by its handle from the keyboard, and saves the new order |
| 4 | Runners：⋯ › Rename | 机器卡片 ⋯ › Rename | `InfrastructurePage.machines.test.tsx` › renames a machine from its ⋯, empty meaning the machine’s own name |
| 5 | Runners：⋯ › Rotate token | 机器卡片 ⋯ › Rotate token | `InfrastructurePage.machines.test.tsx` › rotates a machine’s token from its ⋯ once asked, and shows the new one |
| 6 | Runners：⋯ › Delete | 机器卡片 ⋯ › Delete | `InfrastructurePage.machines.test.tsx` › deletes a machine from its ⋯ once asked |
| 7 | Runners：第三行（runnerAttention：不能自更新 / 版本落后、配额、磁盘、签出卡住） | 机器卡片名下的告警行，折叠时也在 | `InfrastructurePage.machines.test.tsx` 第一组 6 个用例（含 knows the latest release from /dl/version.json, and does without it when it cannot be read = “Can’t update itself”）；截图 `infrastructure-desktop.png` 的 HPC 卡 |
| 8 | Runners：利用率（N / M running 与槽位条） | 机器卡片头 “N / M running” 与槽位条；Machines 区块头 “N machines · x / y slots busy” | `InfrastructurePage.machines.test.tsx` › says how busy the machine is, and under that what it needs, in amber with a warning triangle；`InfrastructurePage.test.tsx` › heads the page with its name, its line and Add, then Machines, API keys and Account pools in that order |
| 9 | Providers：引擎 Sign in | 展开机器卡片后的引擎行 | `InfrastructurePage.test.tsx` › opens a machine on its engines, with each way in Providers had: sign in, install, add an account, pause it；`App.infrastructure.test.tsx` › /providers?runner=&lt;id&gt;&engine=&lt;engine&gt; opens that machine’s card on that engine, as Providers did；`components/RunnerEngines.accounts.test.tsx` › signs in the runner's own login from the Codex row, exactly as before accounts |
| 10 | Providers：Install | 引擎行 Install | `InfrastructurePage.test.tsx` › opens a machine on its engines…（`POST /runners/:id/install`）；`InfrastructurePage.antigravity.test.tsx` › warns when no online machine is ready and offers installation on the focused CLI row |
| 11 | Providers：Add account | 引擎行 Add account | `InfrastructurePage.test.tsx` › opens a machine on its engines…；`RunnerEngines.accounts.test.tsx` › adds an account the moment Add account is pressed, under a name it picks, and never under none |
| 12 | Providers：账号 Re-sign in | 账号行 ⋯ › Re-sign in | `RunnerEngines.accounts.test.tsx` › re-signs in Default by name, not as whatever the runner defaults to |
| 13 | Providers：账号改名 | 账号行 ⋯ › Rename，或双击名字 | `components/RunnerEngines.renameAccount.test.tsx` › renames Default…；› renames an added account, and a double-click on its name opens the same editor |
| 14 | Providers：删除账号 | 账号行 ⋯ › Remove account | `components/RunnerEngines.removeAccount.test.tsx` › asks the control plane to remove the account the row is for, and no other |
| 15 | Providers：暂停 / 恢复账号 | 账号行 ⋯ › Pause account… | `InfrastructurePage.test.tsx` › opens a machine on its engines…（菜单里有 Pause account…）；`components/AccountPause.test.tsx` › pauses and resumes personal runner slots while retaining sign-in and quota |
| 16 | Providers：Add provider（加 key） | Add › Connect an API key（→ `/providers/new`）；API keys 下的 Connect another provider 图库，无 key 时的空状态图库 | `InfrastructurePage.test.tsx` › adds what each section holds from Add…；› keeps the gallery under the keys there are, edits a key on its page, and deletes one once asked；› says what each section is for before there is anything in it |
| 17 | Providers：编辑 key | API keys 表 Edit（→ `/providers/:id`） | `InfrastructurePage.test.tsx` › keeps the gallery under the keys there are, edits a key on its page, and deletes one once asked |
| 18 | Providers：删除 key | API keys 表 Delete，确认后 `DELETE /providers/mine/:id` | 同上 |
| 19 | Providers：建池（New pool / Create a pool） | Account pools 头的 New pool；Add › New account pool（同一个 NewPoolModal）；API keys 顶部的 Create a pool 提示 | `InfrastructurePage.test.tsx` › adds what each section holds from Add…（打开 New account pool）；`InfrastructurePage.pools.test.tsx` › creates a pool from the hint with every key that can join, and none that cannot；`InfrastructurePage.sharedPools.test.tsx` › makes a shared Codex pool with the people it names, and opens it；`InfrastructurePage.codexLogin.test.tsx` › makes a "Just me" Codex pool one of these, and opens it straight to signing in |
| 20 | Providers：池卡片上的操作（ChatGPT 账号重新登录、替换被拒的 key、折叠） | Account pools 区块（AccountPools 原样） | `InfrastructurePage.codexLogin.test.tsx` › signs an account OpenAI signed out in again from its card, as that account；`InfrastructurePage.sharedPools.test.tsx` › replaces a refused key from its card with a working one, sending it once；`InfrastructurePage.pools.test.tsx` › is open on a wide screen until folded, and the fold sticks |
| 21 | Providers：`/providers?runner=&engine=` 深链（旧版 macOS/iOS 客户端用） | 落到 `/infrastructure`，保留 query，展开并定位 | 见第 2 节 |

## 2. 旧地址与侧边栏

`src/web/src/App.infrastructure.test.tsx` 挂真实的 `App` 路由（BrowserRouter，读地址栏）：

- `/runners` → `/infrastructure`：Machines、API keys、Account pools 三个区块齐全，没有卡片因此展开。
- `/providers` → `/infrastructure#keys`：API keys 区块被 `scrollIntoView`。
- `/providers?runner=<id>&engine=codex` → `/infrastructure?runner=<id>&engine=codex`：那台机器的卡片展开、另一台不展开，codex 行带 `focused` 并被 `scrollIntoView`，行上有 Sign in。
- `/runners?runner=<UUID>&engine=claude` 同样保留 query 并定位（旧 UUID 拼法也认）。
- `/runners/register`、`/runners/:id`、`/providers/new`、`/providers/new/:slug`、`/providers/:id`、`/providers/pools/:id` 地址不变；它们的返回链接指向 `/infrastructure`（key 的页面回到 `#keys`，池的页面回到 `#pools`）。

侧边栏：`components/TasksSidePanel.destinations.test.tsx` › the sidebar’s Infrastructure row —
只有一个 Infrastructure 入口（没有 Runners、Providers），点它到 `/infrastructure`；
在 `/infrastructure`、`/runners`、`/runners/*`、`/providers`、`/providers/*` 下展开栏和收起栏都只亮它。

## 3. 运行记录

每条都是本任务会话里的 Orbit 后台作业（`bgj_…`），完整输出由 Orbit 保存。

web 全量（`npx vitest run --maxWorkers=2`，另写 JSON 报告），本分支与干净 main 在同一基点各跑一次：

| 树 | 作业 | 结果 |
|---|---|---|
| 本分支 `6b2f53d87` | `bgj_a71e32ad6167` | 342 个文件，4359 个用例全部通过 |
| 干净 main `86203ffb0`（临时 git worktree） | `bgj_50dd78e24749` | 340 个文件，4326 个用例全部通过 |
| 对比：[`compare.mjs`](compare.mjs) 按失败用例全名求差集 | `bgj_fe54125ac7aa` | 两边都没有失败用例；本分支独有的失败：无 |

两边文件数之差就是本次的测试搬家：main 独有 `ProvidersPage.{antigravity,codexLogin,pools,sharedPools}.test.tsx`、
`RunnersPage.test.tsx`；本分支独有它们搬到的 `InfrastructurePage.*.test.tsx` 五个，以及新增的
`InfrastructurePage.test.tsx`、`App.infrastructure.test.tsx`。改动开始前在 main `de0838eb7` 上也跑过一次
（`bgj_c2ceaf212ec4`：340 个文件，4326 个用例全过）。

OrbitKit（`swift:6.1` docker，`git archive 6b2f53d87` 的副本）：

| 运行 | 作业 | 结果 |
|---|---|---|
| 全量 `swift test` | `bgj_b0a6a055a435` | 3257 个用例，0 失败（5 个 `PerfBaselineTests` 在 Linux 上跳过）；`SettingsCopyParityTests`、`ProviderPoolsParityTests`、`PoolAccessCopyParityTests`、`SharedPoolCopyParityTests`、`CodexSignInCopyParityTests` 都通过 |
| CopyParity 系列：`--filter 'CopyParity\|ProviderPoolsParityTests'` | `bgj_cbe0ded7414b` | 46 个测试类、378 个用例，0 失败 |

`SettingsCopyParityTests` 现在从 `InfrastructurePage.tsx` 读 Machines / API keys / No keys yet 三处文案，
`ProvidersOverview`（iOS 设置里的 Providers 页）随之说同样的话；其余四个测试读的文件和文案本次没有改到。

截图来自真实 web 控制台（vite dev server + 假 `/api`，Chrome headless，作业 `bgj_67d696a388ba`），是本任务会话的附件：
`infrastructure-desktop.png`（Mac Studio 卡展开，HPC 卡带告警行，ThinkPad 离线）、
`infrastructure-add-menu.png`（Add 菜单）、`infrastructure-phone-top.png` / `infrastructure-phone-cards.png`（390 宽手机）。

## 4. 有意没做，或留给后续阶段

- 「需要处理」与引擎概览（`02-after-infrastructure.png` 顶部两块）属于 P3。
- `ProvidersPage.tsx`、`RunnersPage.tsx` 还在，但已没有路由引用它们，P5 删除；它们的测试已搬到新页面。
- 机器卡片不再列 runner 的 labels，也不写 “Online · / Draining / last seen”：离线用 Offline 标签表示，
  其余在机器页（Details →）上。
- 引擎行里仍有 “runner” 字样（如 “Update this runner to sign in with Google.”、“Update runner”），
  其它页面也仍有指向 `/providers`、`/runners` 的入口（WorkspaceView、NewSessionProviderHero、TaskDetailPanel、
  ProjectsPage、默认落地页），它们经重定向落到新页面；这些链接和文案的清理是 P2。
- iOS：`ProvidersOverview` 的区块文案随 web 改为 Machines / API keys / “usable from every machine”，
  让 `SettingsCopyParityTests` 对照的仍是在用的 web 页面；OrbitApp 源码没有改动。
- 侧边栏沿用「亮着的行点了不跳转」：在 `/providers/new` 等子页上点 Infrastructure 不动（以前 `/runners/:id`
  上的 Runners 也是这样）；每个子页都有回到 Infrastructure 的链接。
- `TasksSidePanel.tsx` 里描述 Providers 入口的注释（原定 P5 修）随入口一起改掉了。
