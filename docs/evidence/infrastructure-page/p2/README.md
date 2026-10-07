# P2 Web：机器详情页复用引擎组件，改掉指向 Providers 的链接和文案 — 验证

代码在提交 `39f906344`（基于项目分支 `d60daf95f`，即 P1 之后）。

## 1. 机器详情页的 Engines

`RunnerDetailPage` 的 Engines 区块不再用只读的 `RunnerEnginesSection`（已删除，连同它的测试和 `rd-engine-*` 样式），
而是用机器卡片的引擎行：`MachineEngines` 从 `RunnerEngines` 的卡片里抽出来，卡片自己和机器页都用它，机器页上不折叠、没有卡片头。

- 引擎行上直接登录、安装、加账号；账号行的 ⋯ 里改名、重新登录、暂停、移除 —— 和 Infrastructure 上同一台机器的卡片完全一样。
- 机器层面的操作留在区块头：Refresh models、Update engines，以及更新的报告（Dismiss）。
- 只在机器页上，另外列出 OpenCode 和 DeepSeek Harness 两行（只读，一行）：Update engines 也更新它们，iOS/macOS 的机器页同样列出（`RunnerPageFormat.engineOrder`）。
- Needs Attention 卡片的 Sign In 就地打开该引擎行的登录（行下多个账号时打开 Default 那一行的），并把该行高亮、滚到视野里；不再跳 `/providers?runner=`。
- 引擎行「没在更新」的提示在机器页上不再带「Update this machine’s engines →」链接（它只会链回本页，Update engines 就在区块头）。

| 行为 | 测试（`src/web/src` 下 vitest 用例） |
|---|---|
| 引擎行上有登录按钮，点击后不离开机器详情页，登录从本页发起（验收 2） | `pages/RunnerDetailPage.engines.test.tsx` › signs in from its own row, and the page stays where it is |
| Needs Attention 的 Sign In 就地登录：不导航，该行 `focused` 并被 `scrollIntoView`，行下出现 “Sign in to Claude Code” | `pages/RunnerDetailPage.layout.test.tsx` › offers each card’s one action, and each does what it says |
| 安装缺失的引擎（`POST /runners/:id/install`） | `RunnerDetailPage.engines.test.tsx` › installs one the machine lacks, from its row |
| 账号各占一行，⋯ 菜单为 Rename / Re-sign in / Pause account… / Remove account；Add account 开面板并按选好的名字发起登录 | › keeps each account on a row of its own, with its menu, and adds another from the engine’s row |
| Refresh models、Update engines | › re-reads the model lists and updates every CLI, from Engines’ head |
| 更新报告（含跳过的 CLI）与 Dismiss | › reports what an update did, including what it left alone, until it is dismissed |
| 安装失败的 relay 归引擎行，不进区块头的报告 | › leaves an engine’s own install to its row |
| OpenCode、DeepSeek Harness 排在可登录的引擎之后 | › lists the CLIs it updates that nothing signs in, after the ones that sign in |
| 不在更新的引擎：版本落后提示、机器的原话、没有指回本页的链接；区块脚注 | › says on a row that is not keeping current why, and points at nothing but this page’s Update engines |
| 没上报引擎的 runner 不被当成空机器 | › never reads a runner that has not reported its engines as an empty machine |
| 离线机器：区块里没有可按的按钮，脚注说明原因 | `RunnerDetailPage.layout.test.tsx` › the Mac mini, offline: … |
| 机器页的 Antigravity 行与卡片上的逐字相同（一个/两个 Google 账号、有账号登出、走 Gemini key） | `components/RunnerEngines.antigravityAccounts.test.tsx` › the runner page’s Antigravity rows are the card’s own；`RunnerEngines.antigravityGoogle.test.tsx` |

截图（vite dev server + 假 `/api`，Chromium headless，本任务会话上传目录 `p2-screenshots/`）：
`machine-page-desktop.png`、`machine-page-desktop-signin.png`（点 Needs Attention 的 Sign In 之后，地址仍是 `/runners/:id`，Codex 行高亮并展开登录）、
`machine-page-phone.png`、`machine-page-phone-signin.png`。

## 2. 链接

指向某台机器某个引擎的，改到 `/infrastructure?runner=&engine=`（P1 的卡片会展开并定位到该引擎）；泛指的改到 `/infrastructure`，
与 API key 相关的改到 `/infrastructure#keys`（与旧的 `/providers` 落点相同）。子路由（`/providers/new…`、`/providers/:id`、`/providers/pools/:id`、`/runners/:id`、`/runners/register`）按项目定论不动。

| 位置 | 原来 | 现在 |
|---|---|---|
| `components/NewSessionProviderHero.tsx` 不可用引擎行与 Fix it | `/providers?runner=&engine=` | `/infrastructure?runner=&engine=` |
| 同上，Connect a provider… / Manage | `/providers` | `/infrastructure` |
| `components/TaskDetailPanel.tsx` 任务的 Provider 选了不可用的引擎 | `/providers?runner=&engine=` | `/infrastructure?runner=&engine=` |
| `components/WorkspaceView.tsx` 输入框里选了已登出的账号、不可用的 provider、别的引擎下已登出的账号 | `/providers?runner=&engine=`（3 处） | `/infrastructure?runner=&engine=` |
| 同上，Antigravity 修复卡的 Open in … | `/providers?runner=&engine=antigravity` | `/infrastructure?runner=&engine=antigravity` |
| 同上，DeepSeek Harness 修复卡的 Update the API key（找不到它的 key 时）；登录失败卡的 Use an API key instead 与 key 被拒时的 Update the API key | `/providers` | `/infrastructure#keys` |
| `pages/RunnerDetailPage.tsx` Needs Attention 的 Sign In | `/providers?runner=&engine=` | 就地登录（见上） |
| `components/RunnerEnginesSection.tsx` 每个引擎行 | `/providers?runner=&engine=` | 文件删除，行改为可操作的引擎行 |
| `App.tsx` 默认落地页（多台机器、还没有 workspace） | `/runners` | `/infrastructure` |
| `App.tsx` `admin/providers` | `/providers`（再重定向） | 直接 `/infrastructure#keys` |
| `pages/ProjectsPage.tsx` New project（没有可开的 workspace、多台机器） | `/runners` | `/infrastructure` |
| `components/WikiPlanPage.tsx` 维基计划卡的 View runners | `/runners` | `/infrastructure` |

P1 已改的 `ProviderConnectPage.tsx`、`ProviderPoolPage.tsx` 返回链接本次没有再动。`AccountPools.tsx`、`sessionProviderChoices.ts` 里剩下的 `/providers/…` 都是不变的子路由或 API 路径。

验收 1：`git grep -nE "/providers\?runner|Providers page" -- src/web/src ':!*.test.*'` 无输出（运行记录见第 4 节）。

## 3. 文案

| 位置 | 原来 | 现在 |
|---|---|---|
| `NewSessionProviderHero.tsx` 不可用引擎行的提示 | — fix it on the Providers page | — fix it in Infrastructure |
| `SharedPool.tsx`（Who can use it 的说明、共享前的说明）、`AccountPools.tsx`（New pool 对话框） | They see … on their Providers page and in the session picker… | They see … on their Infrastructure page and in the session picker… |
| `Transcript.tsx` 会话里的修复卡 | … in Providers / Install it from Providers / Open in Providers / Update it in Providers | … in Infrastructure / Install it from Infrastructure / Open in Infrastructure / Update it in Infrastructure |
| `lib/dshRuntime.ts` DeepSeek Harness 的提示 | … from Providers. | … from Infrastructure. |

「See runners ↑」「sign a runner in above」在 P1 搬到 `InfrastructurePage.tsx` 时已改成 “See machines ↑”“sign a machine in above”；
旧的 `ProvidersPage.tsx` 已没有路由引用，留给 P5 删除。代码注释里的 “Providers page” 也一并改掉（验收 1 的 grep 不区分注释）。

OrbitKit 有逐字对照 web 的 CopyParity 测试（`PoolAccessCopyParityTests`、`GeminiEntryParityTests`、`DshRuntimeTests`），所以同一提交里
`WhoCanUseIt.swift`、`EngineAuth.swift`、`DshRuntime.swift` 的同一句话一起改，`EngineAuthTests`、`GeminiEntryParityTests` 跟着改；
macOS 修复卡的按钮和 key 被拒的那句（`RunnerSignInView.swift`）也说 Infrastructure。

## 4. 运行记录

每条都是本任务会话里的 Orbit 后台作业（`bgj_…`）或会话内的命令，完整输出由 Orbit 保存；JSON 报告在本任务会话上传目录的 `p2-evidence/`。

web 全量（`npx vitest run --maxWorkers=2`，另写 JSON 报告），本分支与干净 main 各跑一次：

| 树 | 作业 | 结果 |
|---|---|---|
| 本分支 `39f906344` | `bgj_b3db5013b276` | 342 个文件，4352 个用例全部通过 |
| 干净 main `db69d833b`（`origin/main`，项目分支的基点；临时 git worktree） | `bgj_7d9676f2e840` | 340 个文件，4326 个用例全部通过 |
| 对比：P1 的 [`compare.mjs`](../p1/compare.mjs) 按失败用例全名求差集 | 会话内命令 | 两边都没有失败用例；本分支独有的失败：无 |

两边文件之差：main 独有 P1 搬走的 `ProvidersPage.*.test.tsx`、`RunnersPage.test.tsx`，以及本次删除的 `RunnerEnginesSection.test.tsx`；
本分支独有 P1 的 `InfrastructurePage.*.test.tsx`、`App.infrastructure.test.tsx`，以及本次新增的 `RunnerDetailPage.engines.test.tsx`。

验收 1 的 grep：在 `39f906344` 上 `git grep -nE "/providers\?runner|Providers page" -- src/web/src ':!*.test.*'` 无输出（退出码 1）。

OrbitKit（`swift:6.1` docker，`swift test` 全量）：`bgj_75a56ed904fe` 在 `f5efedeb3` 上 3257 个用例，0 失败（5 个 `PerfBaselineTests` 在 Linux 上跳过）。
`f5efedeb3` 与 `39f906344` 只差 `NewSessionProviderHero.test.tsx`，没有 Swift 测试读它。此前一次运行（`bgj_e6f6c5ffaa27`）有 2 个失败：
`PoolAccessCopyParityTests` 也读 web 的 `ProviderPoolPage.whoCanUseIt.test.tsx`，当时它还写着旧文案；同一提交里已改。

`npm run build`（`tsc -b && vite build`）在本分支通过。

## 5. 有意没做，或留给后续阶段

- macOS 的 Antigravity 修复卡仍然打开 web 的 `/providers?runner=&engine=antigravity`（经重定向落到对应卡片）；改成 app 内跳转是 P4。
- 维基计划卡的按钮文案 “View runners” 与 OrbitKit 的 `WikiPlanCopy.viewRunners` 逐字对照，本次只改了它的链接。
- `index.css` 里几处以 “Providers →” 开头的样式分节注释、OrbitKit 里提到 Providers 的代码注释，留给 P5 的文档清理。
- WorkspaceView 里几处引擎深链没有专门的测试（原来也没有）；同样写法的 Hero 与 TaskDetailPanel 用例断言了新地址。
