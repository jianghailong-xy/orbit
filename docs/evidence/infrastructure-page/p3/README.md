# P3 Web：Infrastructure 页的「需要处理」和引擎概览 — 验证

代码在提交 `992f51432`，基于项目线 `d60daf95f`（P1 之上，main `db69d833b`）。
效果图：[`02-after-infrastructure.png`](../../../mocks/infrastructure-page/02-after-infrastructure.png) 顶部两块。
实现：`src/web/src/components/InfrastructureOverview.tsx`（`NeedsAttention`、`EngineOverview`），
样式是 `src/web/src/index.css` 的 `.infra-attn*` / `.infra-engine*` / `.infra-model`。

## 1. 规则

两块都只读页面本来就有的四个查询——`GET /runners`、`GET /providers/mine`、`GET /providers/pools`、
`GET /providers/shared-pools`（池按页面已有的 `poolList` 合成，含 Codex 池的 access 视图）——在前端计算，没有新接口。
页面等这四个都有结果才画这两块：在 key 到达之前说某个引擎 Not set up 是错的；`#keys` / `#pools` 的滚动也随之等到这时。

**需要处理**（`NeedsAttention`）：没有任何一行时整块不渲染。依次是：

| 行 | 何时出现 | 行尾操作 |
|---|---|---|
| **Codex** is signed out on **Mac Studio** · Sessions there can’t use it | 机器在线；引擎（Claude Code / Codex / Kimi Code / Antigravity）已安装，CLI 自己答 no（与机器卡片引擎行同一判定 `rowKindOf` = `out`），并且它没有哪个账号仍是 signed in——还有一个登录着，那台机器的会话照样能用它。Antigravity 只在那台机器支持它、并能发起 Google 登录时（`supported` 不为 false，`googleLogin = available`） | **Sign in**：在这一行下面展开 `RunnerSignIn`（机器卡片引擎行打开的同一个组件），就地登录，不跳页 |
| **ThinkPad** is offline · Last seen 1d ago · its subscriptions are unavailable until it’s back | `runner.online` 不为 true（与机器卡片的 Offline 同一判定）；从未上报过心跳时写 Never checked in | **Details** → `/runners/:id` |
| **Claude keys** is unavailable · No account can run · no session can start on it | 池的 `unavailable` 有值（服务端或 `withLogin` / `ownPoolWithAccess` 给出的原因，原样写出） | **Manage** → `/providers/pools/:id`（池卡片上同一链接的叫法） |

**What your agents can run on**（`EngineOverview`）：Claude Code、Codex、Kimi Code、Antigravity 各一张卡，列出现在可用的来源：

- **Subscription**：在线机器上该引擎已登录的账号。引擎报了账号列表时数 `auth = yes` 的账号（Antigravity 跑在本机 Gemini key 上的 Default 也算，与机器卡片一致），没报列表时看引擎自己的 `auth`；一台机器上多于一个写 `×N`（Mac Studio ×2）。离线机器不算。
- **API key**：`enabled` 且 `runtime` 等于该引擎的 key，名字旁边是它的默认模型名（`defaultModel` 在该 key 自己 `models` 里的 label；没有 `defaultModel` 时取第一个模型）。所以 DeepSeek 的 key（runtime `claude`）在 Claude Code 下，显示 DeepSeek V4 Pro；Moonshot 的在 Kimi Code 下。停用的 key 不算。
- **Pool**：该引擎的账号池（与会话选择器同一归属：`poolRunsCodex` 为 Codex，否则 Claude Code）。`unavailable` 的池不算——它在「需要处理」里；只是额度用完、会自己恢复的池算。

至少有一个来源 → **Ready**；一个都没有 → **Not set up**，写「No machine signed in, no key. Install on a machine or connect a key.」：
Install on a machine 打开第一台在线机器的卡片并定位到该引擎行（`?runner=<id>&engine=<engine>`，RunnerEngines 本来就读这两个参数；行上就是 Install / Sign in），
没有在线机器时去 `/runners/register`；connect a key 去 `/providers/new`。

机器卡片和这两块读引擎状态用同一个函数：原来写在 `RunnerEngineCard` 里的那段（Antigravity 的安装与凭据取自 `runner.antigravity`）
提成了 `RunnerEngines.tsx` 的 `engineHealthOf`，卡片改为调用它，行为不变。

## 2. 用例

`src/web/src/pages/InfrastructurePage.overview.test.tsx`（真实 `InfrastructurePage` + 假 `api`），9 个用例：

| 验收条目 | 用例（describe › it） |
|---|---|
| 引擎退出登录：行与就地 Sign in | Needs attention › lists an engine signed out on a machine that is online, and signs it in from that line（断言行文字与 Sign in；点 Sign in → 该行下出现 RunnerSignIn 的 “Sign in to Codex” → 点它发出 `POST /runners/<id>/login {engine: 'codex'}`；离线机器上退出登录的 Codex 不另起一行） |
| 引擎退出登录的边界 | Needs attention › says nothing of an engine still signed in on another account, or one whose CLI would not say |
| 机器离线：行与 Details | Needs attention › lists a machine that is offline, and opens its page（断言行文字、`href=/runners/<id>`，点击后到达该地址） |
| 池不可用：行与链接 | Needs attention › lists an account pool no session can start on, and opens its page（断言行文字、`href=/providers/pools/<id>`，点击到达；该池也不再算 Claude Code 的来源） |
| 没有问题时整块不渲染 | Needs attention › is not there at all while nothing needs a person（`.infra-attn` 不存在） |
| Ready 的判定与各来源 | What your agents can run on › heads the page’s sections, an engine to a card, each Ready with what can pay for it now（与效果图同一组数据：Claude Code 的 Subscription · Mac Studio ×2, HPC / API key 带模型名 / Pool · Claude keys；Codex · HPC ×2；Kimi Code · HPC；Antigravity Not set up；区块顺序 What your agents can run on、Machines、API keys、Account pools） |
| key 归到它走的引擎下并显示模型名 | What your agents can run on › puts a key under the engine it runs on, beside the model it starts on（DeepSeek → Claude Code 显示 DeepSeek V4 Pro；Moonshot → Kimi Code；停用的 OpenAI key 不让 Codex Ready） |
| Not set up 的判定与两个入口 | What your agents can run on › calls an engine with nothing that can pay for it Not set up, and offers to install it on a machine or connect a key（文案、`/providers/new`、`?runner=<第一台在线机器>&engine=antigravity`，点击后该机器卡片展开且 antigravity 行 focused、行上有 Install） |
| Not set up：现在不能用的不算 | What your agents can run on › is Not set up on what cannot be used now: a machine offline, a key switched off, a pool nothing can start on（且没有在线机器时 Install on a machine → `/runners/register`） |

这些用例确实能抓住规则被改坏：分别把「退出登录」判定改成恒假、把不可用的池算作来源、把停用的 key 算作来源、把离线机器算作订阅，
每一种都让 2–3 个用例失败；改回后 9 个全过（本任务会话里的同一次 Bash 调用）。

页面原有用例的改动只有区块顺序：`InfrastructurePage.test.tsx` 与 `App.infrastructure.test.tsx` 断言的区块标题前面多了
What your agents can run on。

## 3. 截图

真实 web 控制台（`npx vite` + 浏览器里拦截 `/api`，Chromium headless，数据与效果图同一组：Mac Studio / HPC / ThinkPad、
Anthropic (Claude) / Anthropic · Work / DeepSeek 三个 key、Claude keys 池），脚本 [`shot.cjs`](shot.cjs)
（`node shot.cjs <src/web> <vite 地址> <out.png> [light|dark] [宽] [page|signin] [倍率]`）。
应用在内层面板里滚动，所以截下的是一屏：1440×1700，与效果图（2880×3400，2 倍）同一画框。

- [`infrastructure-desktop.png`](infrastructure-desktop.png)：1440 宽。与 `02-after-infrastructure.png` 结构一致：标题与 Add →
  需要处理（Codex signed out on Mac Studio + Sign in；ThinkPad offline + Details）→ What your agents can run on 四张卡
  （Claude Code / Codex / Kimi Code Ready 及其来源，Antigravity Not set up 及两个入口）→ Machines（Mac Studio 展开）→ API keys。
  与效果图的差别：key 旁多了模型名（任务要求）；离线时间写 “Last seen 1d ago”（页面已有的 `ago` 写法）而不是 “yesterday”。
- [`infrastructure-signin.png`](infrastructure-signin.png)：点「需要处理」里的 Sign in 后，RunnerSignIn 在该行下展开。
- [`infrastructure-phone.png`](infrastructure-phone.png)：390 宽，卡片变成一列，行文字换行、操作留在行尾。

## 4. 运行记录

每条都是本任务会话里的 Orbit 后台作业（`bgj_…`）或 Bash 调用，完整输出由 Orbit 保存。

web 全量（`npx vitest run --maxWorkers=2`，另写 JSON 报告），本分支与干净 main 各跑一次。干净 main 取 `origin/main`
`db69d833b`——它就是项目线的基点，所以两边之差只有 P1 与本次：

| 树 | 作业 | 结果 |
|---|---|---|
| 本分支 `992f51432` | `bgj_cedfff9383d8` | 343 个文件，4368 个用例全部通过 |
| 干净 main `db69d833b`（临时 git worktree，`npm ci` 后同一命令） | `bgj_f7f35a2060d8` | 340 个文件，4326 个用例全部通过 |
| 对比：P1 的 [`compare.mjs`](../p1/compare.mjs) 按失败用例全名求差集 | Bash，`node docs/evidence/infrastructure-page/p1/compare.mjs <main.json> <branch.json>`，退出码 0 | 两边都没有失败用例；本分支独有的失败：无 |

文件数之差：main 独有的 5 个是 P1 搬走的 `ProvidersPage.*` / `RunnersPage` 测试；本分支独有的 8 个是它们搬到的
`InfrastructurePage.*` 五个、P1 新增的 `InfrastructurePage.test.tsx` 与 `App.infrastructure.test.tsx`，以及本次的
`InfrastructurePage.overview.test.tsx`。用例数之差 42 = P1 的 33 + 本次的 9。

开发中的局部运行：`InfrastructurePage*`、`App.infrastructure`、`RunnerEngines*`、`RunnerSignIn` 共 19 个文件 273 个用例全过；
其中第一次运行抓到 `InfrastructurePage.antigravity.test.tsx` 失败——概览卡片起初也带 `data-engine`，与机器卡片引擎行的属性同名，
未限定范围的 `[data-engine="antigravity"]` 选到了它。卡片已去掉这个属性（概览用例按卡片名字找卡片），之后全过。
`tsc -p src/web/tsconfig.json --noEmit` 退出码 0。

## 5. 有意没做，或留给后续阶段

- 引擎有多个账号、只有一部分退出登录时不进「需要处理」：会话仍能在其余账号上跑，这一行会说错；该账号在机器卡片的账号行上有自己的 Sign in。
- 不能从这里发起 Google 登录的机器（需要升级的 runner、macOS）上退出登录的 Antigravity 不进「需要处理」：这里给不出 Sign in；机器卡片折叠摘要也不数它。
- 暂停中的账号仍算 Subscription（它仍是登录着的）；额度用完的池仍算 Pool（会自己恢复）。
- Install on a machine 去第一台在线机器，而不是让人挑机器。
- iOS / macOS 的同两块属于 P4；本次没有改任何 OrbitKit 读取的 web 文案（`SettingsCopyParityTests` 读的 Machines / API keys / No keys yet 等字面量都还在原文件里）。
