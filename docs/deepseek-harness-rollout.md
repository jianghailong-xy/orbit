# DeepSeek Harness（dsh）分批启用与回退运维说明

适用版本：最终候选 `a5d3d20d7c9e8ac8cf3f5c96419a93367e2a00e8`（`project/34ZurCP3bv9yLXGVyUGnx` 尖端），包含 D3 修复 `1aa2a21c8` 和 F-P7-1 安装门禁 `b201b71a4`。
本文未标【解耦后】的每一步都已在隔离测试环境按文中顺序实际执行，记录见 [p7-drill](evidence/deepseek-harness/p7-drill/README.md)。
本文只覆盖测试环境的演练流程。生产部署、客户端发版和版本标签按仓库的 upgrade/release 流程及届时授权执行。

运行时细节（安装目录、会话目录、凭据传递、健康字段）见 [deepseek-harness-runtime-environment.md](deepseek-harness-runtime-environment.md)，协议契约见 [deepseek-harness-runtime-contract.md](deepseek-harness-runtime-contract.md)。

**2026-10-09 更新：provider 与 engine 解耦**（[provider-engine-contract.md](provider-engine-contract.md)）

- DeepSeek Harness 不再有单独的配置，用的是用户的 DeepSeek key。同一把 key 也用于 Claude Code 和 OpenCode。
- 回退改为 runner 级。
- 标【解耦后】的段落按新模型改写，还没有按本文顺序演练，由解耦项目的端到端验收验证。其余步骤的演练记录仍是上面的 p7-drill。

## 1. 固定版本支持表

| 组件 | 支持（已实测） | 不支持 / 未验 |
|---|---|---|
| apiserver + web | 最终候选 a5d3d20d7（迁移至 `0382_pool_credential_throttle`；dsh 领取保护 0377；派发前读取心跳 `engines[dsh]` 的安装门禁） | 早于 P1b 的服务端：没有 dsh 门禁，不得与本文的 runner 混用 |
| runner | 由最终候选构建，心跳声明 `provider:dsh`（`X-Orbit-Supported-Providers: claude,codex,opencode,antigravity,dsh`），并上报 `engines[dsh]` | ≤ 0.1.211（D1 修复之前的发布版，不声明 dsh）：服务端不派发 dsh，dsh 工作停在 PENDING 并提示升级 |
| DeepSeek Harness CLI | `@deepseek-ai/dsh@0.2.0-rc.2`（官方标签 dsh-v0.2.0-rc.2），`lib/bin.js` sha256 `1a03dee18683483ff6a1b27b2a1e650230da6bcca9a0f55f7d81b3308c3f307f`，安装在 `${ORBIT_HOME}/engines/dsh/0.2.0-rc.2` | 用户 PATH 上的 dsh、npm latest 以及其他版本都不会被使用 |
| 平台 | Linux x64，服务 PATH 中为 Node 26（实测 v26.10.0） | macOS、Windows、arm64 及其他 Node 主版本：runner 返回 `DSH_PLATFORM_UNSUPPORTED` / `DSH_NODE_UNSUPPORTED`（未在真实 macOS runner 上实测，见第 6 节） |
| 凭据【解耦后】 | DeepSeek API key：preset `deepseek`，或自定义且主机为 `api.deepseek.com`（Web 表单、`POST /api/providers/mine`；CLI/MCP 建的自定义 key 只要主机是它也算）。同一把 key 同时用于 Claude Code、OpenCode 和 DeepSeek Harness；DeepSeek Harness 会话可以在多把 DeepSeek key 之间选择和切换。原 preset `deepseek-harness`、runtime `dsh` 的配置由存量迁移并入 DeepSeek key，旧 slug 仍解析为该 key + DeepSeek Harness | DeepSeek 账号登录（第三阶段） |
| 模型 | 运行时目录实测返回 deepseek-v4-flash（默认） | — |
| 任务判据 | EXECUTABLE（验收命令由 runner 在工作区执行，不经过 dsh 和模型）、EVIDENCE_JUDGMENT、OWNER_CONFIRMED | 用户手动输入的 `!` shell 在 dsh 上仍被拒绝 |
| 客户端 | Web 已实测；macOS/iOS 只通过了 CI 构建和测试 | macOS/iOS 未在真实 Harness 会话上操作，也没有实机测试 |

【解耦后】DeepSeek key 上 engine 为 Claude Code 的会话（解耦前的旧 `deepseek` 会话），始终由 `claude -p` 执行。卸载 dsh、回退 runner 都不改变它们。但停用或删除这把 key，会同时停掉它在 Claude Code、OpenCode 和 DeepSeek Harness 上的会话。

## 2. 启用前提（逐台 runner 核对）

1. 服务端已部署最终候选：`GET /api/health` 返回 ok；`_prisma_migrations` 的最新一条与候选版本一致。
2. runner 主机为 Linux x64，服务账户 PATH 中的 `node --version` 为 v26.x；`npm ci` 能访问 registry（安装使用内嵌锁文件）。
3. runner 未开启 AutoInstallEngines（默认就是关闭）。dsh 必须显式安装：在 Web 的 Providers / runner 页点 Install、调用 `POST /api/runners/:id/install {"engine":"dsh"}`，或在 runner 上运行 `orbit doctor`。
4. 获准使用 dsh 的用户已连接 DeepSeek key（与 Claude Code、OpenCode 共用同一把）。Key 只能经加密存储和派发进入 runner，不得写入 runner 环境、日志、文档或证据。

## 3. 分批启用步骤

**批次 0：先部署服务端，所有 runner 保持旧版。**
- 核对：`GET /api/runners` 中所有 runner 的 capabilities 都没有 `provider:dsh`。
- 核对旧引擎：新建并续聊一个 Claude 会话，续聊一个 DeepSeek key 上的 Claude Code 会话，两者都成功，`runtimeSessionId` 不变。
- 预期：任何 dsh 会话创建都返回 409 `DeepSeek Harness requires a newer Orbit runner with dsh support; update this runner first`。
- 【解耦后】如果所选 DeepSeek key 已停用，则返回 400 `provider not available`。这同样挡住这把 key 在其它 engine 上的新建。

**批次 1：金丝雀 runner。**
1. 在这台 runner 上，等空闲时把 runner 二进制升级到最终候选并重启服务。重启时进行中的会话会被 reclaim，Claude 会话会续用原 session id。
2. 等一个心跳周期（30 秒以内），核对这台 runner 的 `capabilities` 含 `provider:dsh`，其他 runner 仍然没有。
3. 安装 dsh（第 2 节第 3 条），并核对 `engines[dsh]` 为 `installed:true`、`version:"0.2.0-rc.2"`。
   安装完成之前，服务端对这台 runner 返回 409 `DSH_NOT_INSTALLED…`；已有会话的续聊停在 PENDING，不会被领取，安装后自动派发（第 4、5 节）。
4. 【解耦后】开放入口：获准用户连接 DeepSeek key（已有的直接用），新建会话时 engine 选 DeepSeek Harness。没有单独的 dsh 开关：启用一把 key，就同时开放了它在所有 engine 上的使用。
5. 冒烟：在金丝雀 runner 的工作区新建 dsh 会话。核对 init 事件为 `provider:"dsh"`、`cliVersion:"0.2.0-rc.2"`，turn_end 为 `completed / end_turn`，并且续聊时 `resumed:true`、ACP 会话 id 不变。
6. EXECUTABLE 冒烟（可选，推荐）：【解耦后】建一个 engine 为 DeepSeek Harness、provider 为该 DeepSeek key 的 EXECUTABLE 任务并执行，核对任务被平台机械判定为 DONE。
   任务会话用账号的默认权限模式（没设置时是 Auto）。Default 下 dsh 以只读文件策略启动，写文件时会出审批卡，只有 Approve / Reject。
   Auto 下工作区和临时目录内的写直接执行；要写到别处的命令，日常的那些（隔离 worktree 里的 git commit / merge、构建缓存）由 runner 自动放行一次，push、fetch、安装等仍出审批卡。
   不写文件的命令（包括联网的）在哪个模式下都不经文件沙箱审批；其中会动到别的系统的那几类——push、远程 shell、HTTP 写入、GitHub/集群/云/服务变更、提权、发布——由 Orbit 的工具闸门先问（Don't Ask 下直接拒绝）。
   第三方 MCP 工具只在 Auto 下挂载，每次调用先出审批卡；Orbit 自己的 MCP 不问。
7. 核对旧引擎：重复批次 0 中的 Claude 续聊，以及 DeepSeek key 上 Claude Code 会话的续聊。

**批次 2..n：其余 runner。** 每台都按批次 1 的第 1–3 步和第 5、7 步执行。
还没升级的 runner 上，dsh 会话会被服务端拒绝（409 升级提示）；已升级但还没安装的 runner 上，会被拒绝为 409 `DSH_NOT_INSTALLED`。两种情况下已有 dsh 工作都不会被领取。

## 4. 回退步骤【解耦后】

回退在 runner 级进行：卸载这台 runner 上的 dsh，或回退 runner。两种都停止新增 dsh 派发，并保留既有会话状态。

**不要用停用 DeepSeek key 来回退 dsh。** 没有按 key 或按用户的 dsh 开关。一把 key 停用后，它在 Claude Code、OpenCode 和 DeepSeek Harness 上的会话会一起停下：新建返回 400 `provider not available`；已有会话的新消息停在 PENDING，错误为 `Provider is unavailable; check its configuration`。解耦前的「一级：按配置停用」因此取消。

无论哪种回退，都不要删除 DeepSeek key，也不要删除 `${ORBIT_HOME}/dsh-sessions/`。

### 卸载 dsh（只停这台 runner 的 dsh，runner 版本不变）

1. 等这台 runner 上没有进行中的 dsh 回合，与批次 1 第 1 步相同。重启时 reclaim 会把进行中的会话交还给这台 runner，而它已经启动不了 dsh。
2. 把 `${ORBIT_HOME}/engines/dsh/0.2.0-rc.2` 移到 `engines/dsh/` 之外保存（不要删除），然后重启 runner 服务。
   - runner 重新探测后上报 `engines[dsh]` 未安装。
   - 这一步与 `scripts/test-dsh-install-gate.sh` 演练的「移除版本目录、重启同一个 runner」相同。

预期：

- 新建和恢复 dsh 会话返回 409 `DSH_NOT_INSTALLED…`。
- 已有 dsh 会话的消息排队，停在 PENDING 并显示同一文字，不会被领取，也不会改走 Claude Code。
- 其它 engine 不受影响，包括同一把 DeepSeek key 上的 Claude Code 和 OpenCode 会话。

恢复：把目录移回原处并重启 runner，或在 Providers 重新 Install。下一次心跳带上 `installed:true` 后放行，PENDING 会话在原 ACP 会话上继续。

### 回退 runner（适用于 runner 侧故障）

- 把 runner 换回不声明 dsh 的发布版（≤ 0.1.211）并重启。心跳会把 `provider:dsh` 从 capabilities 中去掉。
- 预期：新建 dsh 会话返回 409 升级提示。已有 dsh 会话的消息排队，会话停在 PENDING 并显示同一升级提示。
  旧 runner 不会领取这些会话，任何进程 argv 中都不会出现 dsh ACP 会话 id。
- 保留 `dsh-sessions/` 和 `engines/dsh/`：旧 runner 不会读写它们（两轮演练中回退前后都逐字节一致）。

### 回退后检查清单

1. 依次检查：capabilities 中 `provider:dsh` 的有无；`engines[dsh]`；对一个已有 dsh 会话发消息后的 PENDING 状态和错误文字。
2. 运行 `ps -eo args | grep <dsh ACP 会话 id>`，预期没有任何进程（尤其是 `claude --resume` / `--session-id`）。
3. 在 DB 中核对：engine 不是 dsh 的会话，其 init 事件里的 sessionId 都不等于任何 dsh 会话的 `runtime_session_id`，预期计数为 0。
   - SQL 见 [audit.sql](evidence/deepseek-harness/p7-drill/stack/audit.sql)。
   - audit.sql 按解耦前的 key runtime 判断 dsh 会话；解耦后改用 `session.engine`。
4. Claude 新建、Claude 续聊、DeepSeek key 上 Claude Code 会话的续聊三项都成功。

### 恢复（回退之后再启用）

先恢复 dsh 安装（移回目录、重新 Install 或升级 runner），并核对 `engines[dsh].installed`。DeepSeek key 不需要改动。被暂留的消息按原顺序在原 ACP 会话上执行，上下文保留。

## 5. 故障诊断

| 现象 | 原因 | 处理 |
|---|---|---|
| 创建返回 409 `…requires a newer Orbit runner with dsh support…` | 目标 runner 没有声明 `provider:dsh`（旧版，或刚重启、心跳未到） | 升级 runner，或等一个心跳周期；如果是有意回退，这就是预期结果 |
| 创建返回 409 `DSH_NOT_INSTALLED: DeepSeek Harness is not installed on this runner, or the runner has not reported it yet…`；已有会话 PENDING 并显示同一文字 | runner 已声明 dsh，但心跳上报未安装（或还没上报） | 安装（第 2 节第 3 条）；30 秒内心跳带上 installed，PENDING 会话在下一个领取长轮询（25 秒内）派发，沿用原 ACP id |
| 会话 FAILED，错误为 `DSH_NOT_INSTALLED`（被领取后才失败） | 已发布的安装目录事后被删除，且下一次探测尚未上报（第 6 节限制 1） | 重新安装；之后新开会话或续聊 |
| 创建返回 400 `provider not available: "<slug>"` | 所选 DeepSeek key 已停用或已删除，这同样挡住它在其它 engine 上的新建 | 重新启用这把 key，或改选另一把 DeepSeek key。不要用停用 key 的方式回退 dsh（第 4 节） |
| 创建返回 400 `DeepSeek Harness runs on a DeepSeek API key; connect one in Providers first` | 只选了 DeepSeek Harness，用户没有启用的 DeepSeek key | 连接或启用一把 DeepSeek key |
| 创建或切换返回 400 `provider "<slug>" cannot run on DeepSeek Harness; …` | 选的 key 不是 DeepSeek key | 改选一把 DeepSeek key |
| 会话 PENDING，错误为 `Provider is unavailable; check its configuration` | 会话所用的 DeepSeek key 在停用或删除期间收到了新消息 | 重新启用后自动执行；也可以把会话切到另一把 DeepSeek key，engine 不变，在原 ACP 会话上续聊 |
| `DSH_PLATFORM_UNSUPPORTED` / `DSH_NODE_UNSUPPORTED` | 非 Linux x64，或 Node 不是 26 | 不要在这台 runner 上启用 dsh |
| `DSH_INSTALL_FAILED` / `DSH_VERSION_INCOMPATIBLE` | npm 安装失败，或已有目录的版本不对 | 查看 runner 日志；不要手动覆盖已发布的目录（`DSH_VERSION_INCOMPATIBLE` 没有客户端修复卡，见第 6 节） |
| `DSH_CREDENTIAL_MISSING` | 派发时没有 DeepSeek key：解耦前建的内置 `dsh` 会话，用户既没有 DeepSeek key，工作区 env 里也没有手写的 key | 连接一把 DeepSeek key |
| `DSH_CREDENTIAL_INVALID`，Web 显示 "Update the API key" | DeepSeek 拒绝了这把 Key（真实 401） | 更新 Key；轮次已如实记为 FAILED |
| `DSH_REQUEST_FAILED`（限流、断网、服务端错误） | 上游错误 | 重试；不会被记为成功 |
| `DSH_CONFIG_CONFLICT` | 恢复时 cwd、profile 或版本与身份记录不一致（例如工作区目录被移动） | 恢复原目录；不要删除会话目录 |
| `DSH_PERMISSION_UNSUPPORTED` / `DSH_MCP_UNSUPPORTED` / `DSH_TOOL_POLICY_UNSUPPORTED` | 选择了 dsh 不支持的权限模式或工具限制 | 改用 Default / Auto / Don't Ask |
| EXECUTABLE 任务会话一直 RUNNING | 审批卡在等人处理：Default 下的写文件，或 Auto 下的 push、fetch、安装等 | 在会话里 Approve / Reject；只是写文件的任务可以改用 Auto 模式派发 |

排查顺序：先看 `GET /api/runners` 中的 capabilities 和 `engines[dsh]`，再看会话所用 DeepSeek key 的 `enabled`，最后看会话的 `error` 和 run_event 中的 init、error、turn_end。

## 6. 已知限制

1. 已发布的安装目录事后消失时，在 runner 下一次引擎探测（5 分钟以内）上报之前，加上其后一个领取长轮询（25 秒以内），即最多约 5 分钟加 25 秒，会话仍可能被领取，并在 runner 上以 `DSH_NOT_INSTALLED` 失败。从未安装过的 runner 不存在这个窗口。
2. `DSH_VERSION_INCOMPATIBLE` 没有客户端修复卡。
3. runner 完成首次引擎探测之前，Web/macOS 的 runner 状态显示 ready，与服务端「未安装」的判定不一致；以服务端 409 和 `engines[dsh]` 为准。
4. 平台不准入的提示（`DSH_PLATFORM_UNSUPPORTED` / `DSH_NODE_UNSUPPORTED`）未在真实 macOS runner 上实测。
5. 【解耦后】没有全局或按 key 的 dsh 开关，dsh 的回退只在 runner 级：卸载 dsh 或回退 runner（第 4 节）。按 key 停用会同时停掉这把 key 在 Claude Code、OpenCode 和 DeepSeek Harness 上的会话，不能当作 dsh 的回退。
6. 未选模型时，首轮 `session.model` 为空字符串，模型目录到达后才填上（F3）。
