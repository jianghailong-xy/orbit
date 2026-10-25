# P4 iOS/macOS：Runners 与 Providers 合并为 Infrastructure — 验证

代码在提交 `5e75edbde`，基于项目线 `150c7a655`（P1、P3、P2 之上）。效果图：
[`03-ios.png`](../../../mocks/infrastructure-page/03-ios.png)。iOS 与 macOS 共用 `src/macos/OrbitApp` 的源码，
规则与文案在 OrbitKit（Linux 上可测），视图只画它们。

## 1. 两端看到的是什么

| 验收要点 | 实现 | 用例 / 运行 |
|---|---|---|
| iOS 设置「Machines & models」只有一行 Infrastructure | `SettingsHome.rows(.machines) == [.infrastructure]`；行值 `SettingsHome.infrastructureValue`：Needs you 有几条就写「1 needs you」/「2 need you」（琥珀色），没有时写在线机器数；组下一行是 web 页标题下那句 `Infrastructure.subtitle` | `SettingsHomeTests` › testTheGroupsReadInTheOrderTheyWerePicked、testInfrastructureSaysHowManyThingsNeedYou、testOnlyMachinesAndModelsHasALineUnderIt；`SettingsStackWiringTests` › testTheListDrawsSettingsHome；截图 `ios-01-settings-*.png` |
| macOS 侧边栏显示 Infrastructure | `AppSection.runners.title == "Infrastructure"`（侧边栏画 `section.title`） | `AppSectionTests` › testTheRunnersSectionIsInfrastructure |
| 两端页面都包含需要处理、引擎概览、机器、账号池、API key | 同一个 `RunnersListView`：macOS / iPad 三栏的中间栏、iPhone 的 Infrastructure 区、设置里的 Infrastructure 页（`SettingsPage.infrastructure` → `RunnersListView(rowNavigation: .push)`）。从上到下：Needs you（只在有事时）→ What your agents can run on → Machines（行可排序、左滑删除，原样保留）→ Add Runner → Account pools → API keys | `RunnersPageWiringTests` › testThePageHoldsTheMocksBlocksInOrder、testTheTopBlocksAreTheWebsRulesOverThePagesLists；`SettingsStackWiringTests` › testSettingsInfrastructureIsTheSectionsOwnPage；截图 `ios-02/03/04-*.png` |
| 机器行：「N / M running」和退出登录的引擎数 | `Infrastructure.machineLine`：在线且有上限时「2 / 4 running」，再接「1 engine signed out」（与 Needs you 同一判定，琥珀色）；没有时接 web 机器卡片折叠摘要 `summaryOf` 的同一句（「All signed in」「1 of 3 signed in」…）；离线机器行尾写 Offline。页面开着时每 15 秒重读机器（与机器详情页相同），行尾的 Offline（按心跳与本机时钟）和「N / M running」（按读取时的 `online`）不会出自两个时刻 | `InfrastructureTests` › testAMachinesLineSaysItsSlotsAndItsEnginesSignedOut、testAMachinesSummaryIsTheWebCards；`RunnersPageWiringTests` › testTheRowIsTheMocksRow |
| 账号池、API key 复用 ProvidersOverviewForm 的分段，删掉「On your runners」 | 两段（含 `CodexPoolRowLabel`、`PoolRowLabel`、`PoolChip`、`PoolTone`）原样搬到跨平台的 `Views/InfrastructureSections.swift`，Mac 也能画；「On your runners」、Settings 的 Providers 页、`RunnersSettingsList`、`NavNode.settingsRunners` 删除 | `SettingsStackWiringTests` › testEveryPageHasItsView、testTheSheetsStackIsSettingsOwnStack |
| 不再有入口打开 web `/providers` | `ConsoleModel.providersURL` / `antigravityProvidersURL` 删除。四处使用——Antigravity 修复卡的 Open in Infrastructure、新会话主视图的 Fix it、引擎选择面板的修复、composer Provider 菜单的修复——改为 `AppModel.openRunnerEngine`：Infrastructure 区里那台机器的记录，其上推入该引擎页 | `GeminiEntryParityTests` › testNativeRepairsAreWiredToProvidersSwitchAndInstall；`NavigationTests` › testInfrastructureOpensAnEnginesPageOverItsMachine；截图 `ios-05-codex-on-mac-studio.png` |
| 机器详情页保持「登录在引擎页」 | `RunnerDetailView` / `RunnerEnginePage` 不变；引擎页另加 Install（失败后 Retry），对机器上没有的引擎——web 引擎行的同一操作（`POST /runners/:id/install {engine}`），让「Install on a machine」和「未安装」的修复入口有处可去 | `InfrastructureTests` › testAnEnginesPageInstallsWhatTheMachineLacks |

Needs you 每行的出口都留在 app 内：Sign in → 该机器的该引擎页；Details → 机器记录；Manage → 池的页面（iOS；Mac 没有池页面，那里行尾不放按钮）；
What your agents can run on 里 Not set up 的「Install on a machine」→ 第一台在线机器的该引擎页，没有在线机器时打开 Add Runner。

## 2. 规则：与 web（P3）一致

`src/macos/OrbitKit/Sources/OrbitKit/App/Infrastructure.swift` 逐个移植 web 的函数，读的也是 web 页的同四个列表
（`GET /runners`、`/providers/mine`、`/providers/pools`、`/providers/shared-pools`，池按 web 的 `poolList` 合成：成员池在前，
自己的 Codex 池并上它的 access 视图），四个都有回答（含失败）之后才画顶上两块。

| web（`InfrastructureOverview.tsx` / `RunnerEngines.tsx`） | Swift（`Infrastructure`） |
|---|---|
| `NeedsAttention`：在线机器 × 引擎的 `signedOutOn`，再离线机器，再 `unavailable` 的池 | `attention(runners:memberPools:ownPools:)` |
| `signedOutOn`（`rowKindOf` = out、无账号仍登录、Antigravity 只在 `supported` 且 `googleLogin = available`） | `signedOut(_:_:)`，`signedOutEngines(_:)` |
| `EngineOverview`：Subscription（在线机器的 `loginsOn`，多于一个写 `×N`）、API key（`enabled` 且 `runtime` 为该引擎，带 `defaultModelOf`）、Pool（`!unavailable`，`poolRunsCodex` 定引擎）；任一即 Ready | `engines(runners:keys:pools:)` |
| `installOn`：第一台在线机器，没有则注册 | `installTarget(_:)` |
| `engineHealthOf`、`rowKindOf`、`summaryOf`、`signedIn` | `engineHealth`、`rowKind`、`summary`、`signedIn` |
| `providerDisplayLabel`、`defaultModelOf`、`machineName` | `keyLabel`、`defaultModel`、`RunnerPageFormat.displayName` |

`InfrastructureTests` 用 web 用例（`InfrastructurePage.overview.test.tsx`）的同一组数据——Mac Studio / HPC / ThinkPad、
Anthropic (Claude) / Anthropic · Work / DeepSeek / Moonshot / 停用的 OpenAI、Claude keys 池——断言同样的结果：
「Codex is signed out on Mac Studio · Sessions there can’t use it」、「ThinkPad is offline · Last seen 1d ago · …」、
「Claude keys is unavailable · No account can run · …」、Claude Code 的 Subscription「Mac Studio ×2, HPC」与三把 key 的模型名、
Codex「HPC ×2」、Kimi「HPC」、Antigravity Not set up，另一个账号仍登录或 CLI 不肯说时不进 Needs you，离线机器 / 停用的 key /
不可用的池都不算来源。

## 3. 文案：与 web 一致

`SettingsCopyParityTests` 读 web 源文件逐字核对（缺一个就是失败，不是跳过）：
Needs you 的三种行与 Sign in / Details / Manage（`InfrastructureOverview.tsx`）；What your agents can run on 的标题、副标题、
Ready / Not set up、Subscription / API key / Pool 与 `×N`、`', '` 的连接、「No machine signed in, no key.」与「Install on a machine」；
Machines 的标题、副标题与「N machines · x / y slots busy」、页标题下那句、Disabled（`InfrastructurePage.tsx`）；
机器卡片头的「N / M running」与 `summaryOf` 的每一句（`RunnerEngines.tsx`）；引擎名（`RunnerSignIn.tsx`）；`providerDisplayLabel`。
P2 合入后这些字面量都还在（`150c7a655` 上逐条核对过）。
有意不比对：「Needs you」标题、设置行的「1 needs you」、机器行的「1 engine signed out」——效果图自己的词，web 没有对应
（web 的需要处理块没有标题，机器卡片也不数退出登录的引擎）。

## 4. 运行记录

| 运行 | 树 | 结果 |
|---|---|---|
| swift:6.1 docker，基线（`bgj_441522e4398e`） | 项目线 `c8b92dd0d`（本任务开始时） | 3257 个用例，5 个跳过，0 失败 |
| swift:6.1 docker（`bgj_9116d0a33644`） | `5e75edbde`（最终树） | 3279 个用例，5 个跳过，0 失败，`swift test` 退出码 0；本任务涉及的九个套件（含 SettingsCopyParityTests、InfrastructureTests 与各结构用例）全过 |
| probe CI：[run 37579348930](https://github.com/jianghailong-xy/orbit/actions/runs/37579348930) | `probe/p4-infrastructure` @ `01a1c6620` = `5e75edbde` + 临时 client.yml（只改触发与汇总，不改各 job 的命令） | font-tokens、nav-push、macOS（OrbitKit `swift test` 3279 / 0 失败；OrbitApp `swift build` Build complete，错误摘要为空）、iOS（xcodebuild 模拟器构建 BUILD SUCCEEDED）全部 success；汇总在 `probe/p4-infrastructure-results` |
| iPhone 截图：[run 37579355063](https://github.com/jianghailong-xy/orbit/actions/runs/37579355063) | `probe/p4-infrastructure-shots` @ `cb85dd577` = `5e75edbde` + `.p4-probe`（真实 CompactShell 与设置 sheet + 假 API） | success：两个 UI 用例通过（TEST SUCCEEDED），下面的截图出自这一轮；图片、笔记、请求日志在 `probe/p4-infrastructure-shots-results`（`c2ff36b7d`） |
| 更早的一轮（同一套检查） | `d11f5ee57`：docker `bgj_9376bd824ed0`（3279 / 0 失败）、[run 37576911455](https://github.com/jianghailong-xy/orbit/actions/runs/37576911455)（全部 success）、[run 37577389807](https://github.com/jianghailong-xy/orbit/actions/runs/37577389807)（截图 success） | 那轮截图里 Mac Studio、HPC 行尾写着 Offline 而自己的行写「2 / 4 running」，Codex 页也当它离线：假 API 的心跳只在启动时盖一次，跑过 90 秒后 iOS 按心跳判离线，而这一行按读取时的 `online`。真实页面开久了也会这样，于是加了每 15 秒重读（见第 1 节），假 API 改为每次回答时盖心跳，截图用例加了断言：在线机器的行不写 Offline，它的 Codex 页不说机器离线 |

`git diff 150c7a655 5e75edbde` 里新增的行没有一处 `async let`；页面的几个列表各是一个 SwiftUI `.task`，视图消失时由 SwiftUI 取消。

## 5. 截图（iPhone，真实 app 代码）

`.p4-probe`（改自 `probe/ds-balance-shots` 的 `.dsb-probe`）把 iOS app 自己的 `CompactShell` 与设置 sheet、全部共用源码编成一个
一次性 app，指向假 API `stub.py`（效果图那组数据：Mac Studio 在线、2/4 running、Codex 退出登录；HPC 在线、全部登录、两个 Codex 账号；
ThinkPad 一天前离线；Claude keys 池两把 key 一把用尽；三把 key 和一把停用的 OpenAI）。XCUITest 用 app 自己的点击打开设置 →
Infrastructure，逐段核对文字并拍照，再点 Needs you 的 Sign in 打开 Mac Studio 上 Codex 的页面。浅色与深色各一遍。

| 文件 | 内容 |
|---|---|
| [`ios-01-settings-light.png`](ios-01-settings-light.png) | 设置：Machines & models 只有 Infrastructure 一行，行值「2 need you」（琥珀色），组下是 web 页那句；没有 Runners / Providers 行（用例数了：0） |
| [`ios-02-infrastructure-top-light.png`](ios-02-infrastructure-top-light.png)、[`ios-02-infrastructure-top-dark.png`](ios-02-infrastructure-top-dark.png) | Needs you（Codex is signed out on Mac Studio + Sign in；ThinkPad is offline + Details）与 What your agents can run on 四行（Claude Code / Codex / Kimi Code Ready 及来源，Antigravity Not set up 与 Install on a machine） |
| [`ios-03-infrastructure-machines-light.png`](ios-03-infrastructure-machines-light.png) | Machines：「2 / 4 running · 1 engine signed out」（琥珀色）、「5 / 8 running · All signed in」、ThinkPad「1 of 3 signed in」与 Offline；Add Runner；Account pools 起头 |
| [`ios-04-infrastructure-pools-and-keys-light.png`](ios-04-infrastructure-pools-and-keys-light.png) | Account pools（Claude keys 1 of 2 available）与 API keys（各自的模型名，停用的 OpenAI 写 Disabled） |
| [`ios-05-codex-on-mac-studio.png`](ios-05-codex-on-mac-studio.png) | Needs you 的 Sign in 打开的页面：Mac Studio 上的 Codex，Default Signed out 与可按的 Sign In——登录在引擎页 |

## 6. 有意没做，或留给后续

- 打开 web 的 key 表单的三处保留：Connect Gemini（`/providers/new/gemini` 或该 key 的 `/providers/:id`）、Harness 的 Update the API key
  与 Provider 菜单里的「DeepSeek Harness — Add API key」（`/providers/new/deepseek-harness`）。app 没有 key 编辑器，项目也约定
  `/providers/new…`、`/providers/:id` 子路由不动；被改掉的是打开 `/providers`（`?runner=&engine=`）页面的入口。
- API keys 一段改读 `GET /providers/mine`（账号自己的 key，含停用的，行尾写 Disabled），与 web 页一致；原 iOS Providers 页读的是
  选择器目录（共享 + 自己的已启用 key）。共享 provider（ownerId = null）的展示按项目约定不在本项目内。
- Mac 没有池页面：池的行只读，Needs you 里池那一行不放 Manage。
- 设置行的计数在池读回之前只数机器的两类（偏少不偏多）。
- 另一个项目线 `project/34b7qmu7w992fd5pVBHYW`（DeepSeek 余额）改了 `ProvidersOverviewForm` 的 key 行、`ConfiguredProvider` 的
  init 与 `NavNode`，它与本任务谁后进 main，谁要把 key 行的改动挪到 `InfrastructureSections.swift`。
- `RunnerAttention.runnerListSubtitle` 不再被 app 调用（与 web 共用用例集的 parity 函数，保留）。
- macOS 没有截图（结构由同一个 `RunnersListView` 保证，见第 1 节的用例）。
