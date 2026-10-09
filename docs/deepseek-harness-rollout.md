# DeepSeek Harness（dsh）分批启用与回退运维说明

适用版本：最终候选 `a5d3d20d7c9e8ac8cf3f5c96419a93367e2a00e8`（`project/34ZurCP3bv9yLXGVyUGnx` 尖端），包含 D3 修复 `1aa2a21c8` 和 F-P7-1 安装门禁 `b201b71a4`。
本文每一步都已在隔离测试环境按文中顺序实际执行，记录见 [p7-drill](evidence/deepseek-harness/p7-drill/README.md)。
本文只覆盖测试环境的演练流程。生产部署、客户端发版和版本标签按仓库的 upgrade/release 流程及届时授权执行。

运行时细节（安装目录、会话目录、凭据传递、健康字段）见 [deepseek-harness-runtime-environment.md](deepseek-harness-runtime-environment.md)，协议契约见 [deepseek-harness-runtime-contract.md](deepseek-harness-runtime-contract.md)。

## 1. 固定版本支持表

| 组件 | 支持（已实测） | 不支持 / 未验 |
|---|---|---|
| apiserver + web | 最终候选 a5d3d20d7（迁移至 `0382_pool_credential_throttle`；dsh 领取保护 0377；派发前读取心跳 `engines[dsh]` 的安装门禁） | 早于 P1b 的服务端：没有 dsh 门禁，不得与本文的 runner 混用 |
| runner | 由最终候选构建，心跳声明 `provider:dsh`（`X-Orbit-Supported-Providers: claude,codex,opencode,antigravity,dsh`），并上报 `engines[dsh]` | ≤ 0.1.211（D1 修复之前的发布版，不声明 dsh）：服务端不派发 dsh，dsh 工作停在 PENDING 并提示升级 |
| DeepSeek Harness CLI | `@deepseek-ai/dsh@0.2.0-rc.2`（官方标签 dsh-v0.2.0-rc.2），`lib/bin.js` sha256 `1a03dee18683483ff6a1b27b2a1e650230da6bcca9a0f55f7d81b3308c3f307f`，安装在 `${ORBIT_HOME}/engines/dsh/0.2.0-rc.2` | 用户 PATH 上的 dsh、npm latest 以及其他版本都不会被使用 |
| 平台 | Linux x64，服务 PATH 中为 Node 26（实测 v26.10.0） | macOS、Windows、arm64 及其他 Node 主版本：runner 返回 `DSH_PLATFORM_UNSUPPORTED` / `DSH_NODE_UNSUPPORTED`（未在真实 macOS runner 上实测，见第 6 节） |
| 凭据 | DeepSeek API Key，通过 preset `deepseek-harness`、runtime `dsh` 的配置写入（Web 表单或 `POST /api/providers/mine`） | DeepSeek 账号登录（第三阶段）；CLI/MCP 暂不能创建 dsh 配置（F2） |
| 模型 | 运行时目录实测返回 deepseek-v4-flash（默认） | — |
| 任务判据 | EXECUTABLE（验收命令由 runner 在工作区执行，不经过 dsh 和模型）、EVIDENCE_JUDGMENT、OWNER_CONFIRMED | 用户手动输入的 `!` shell 在 dsh 上仍被拒绝 |
| 客户端 | Web 已实测；macOS/iOS 只通过了 CI 构建和测试 | macOS/iOS 未在真实 Harness 会话上操作，也没有实机测试 |

旧的 `deepseek` 配置（preset `deepseek`，runtime `claude`）与 dsh 无关，升级和回退都不改变它，始终由 `claude -p` 执行。

## 2. 启用前提（逐台 runner 核对）

1. 服务端已部署最终候选：`GET /api/health` 返回 ok；`_prisma_migrations` 的最新一条与候选版本一致。
2. runner 主机为 Linux x64，服务账户 PATH 中的 `node --version` 为 v26.x；`npm ci` 能访问 registry（安装使用内嵌锁文件）。
3. runner 未开启 AutoInstallEngines（默认就是关闭）。dsh 必须显式安装：在 Web 的 Infrastructure 页点 Install（API keys 表里 DeepSeek Harness key 的下方按机器列出；机器详情页的 DeepSeek Harness 行只读）、调用 `POST /api/runners/:id/install {"engine":"dsh"}`，或在 runner 上运行 `orbit doctor`。
4. 获准使用 dsh 的用户已有 DeepSeek API Key。Key 只能经 provider 加密存储和派发进入 runner，不得写入 runner 环境、日志、文档或证据。

## 3. 分批启用步骤

**批次 0：先部署服务端，所有 runner 保持旧版。**
- 核对：`GET /api/runners` 中所有 runner 的 capabilities 都没有 `provider:dsh`。
- 核对旧引擎：新建并续聊一个 Claude 会话，续聊一个旧 `deepseek` 会话，两者都成功，`runtimeSessionId` 不变。
- 预期：任何 dsh 会话创建都返回 409 `DeepSeek Harness requires a newer Orbit runner with dsh support; update this runner first`。
- 如果对应的 dsh 配置已停用，则返回 400 `provider not available`。

**批次 1：金丝雀 runner。**
1. 在这台 runner 上，等空闲时把 runner 二进制升级到最终候选并重启服务。重启时进行中的会话会被 reclaim，Claude 会话会续用原 session id。
2. 等一个心跳周期（30 秒以内），核对这台 runner 的 `capabilities` 含 `provider:dsh`，其他 runner 仍然没有。
3. 安装 dsh（第 2 节第 3 条），并核对 `engines[dsh]` 为 `installed:true`、`version:"0.2.0-rc.2"`。
   安装完成之前，服务端对这台 runner 返回 409 `DSH_NOT_INSTALLED…`；已有会话的续聊停在 PENDING，不会被领取，安装后自动派发（第 4、5 节）。
4. 开放入口：由获准用户在 Web 连接 DeepSeek Harness Key，或把已存在的 dsh 配置设为启用（`PATCH /api/providers/mine/:id {"enabled":true}`）。
5. 冒烟：在金丝雀 runner 的工作区新建 dsh 会话。核对 init 事件为 `provider:"dsh"`、`cliVersion:"0.2.0-rc.2"`，turn_end 为 `completed / end_turn`，并且续聊时 `resumed:true`、ACP 会话 id 不变。
6. EXECUTABLE 冒烟（可选，推荐）：建一个 provider 为该 dsh 配置的 EXECUTABLE 任务并执行，核对任务被平台机械判定为 DONE。
   任务会话用账号的默认权限模式（没设置时是 Auto）。Default 下 dsh 以只读文件策略启动，写文件时会出审批卡，只有 Approve / Reject。
   Auto 下工作区和临时目录内的写直接执行；要写到别处的命令，日常的那些（隔离 worktree 里的 git commit / merge、构建缓存）由 runner 自动放行一次，push、fetch、安装等仍出审批卡。
   不写文件的命令（包括联网的）在哪个模式下都不经文件沙箱审批；其中会动到别的系统的那几类——push、远程 shell、HTTP 写入、GitHub/集群/云/服务变更、提权、发布——由 Orbit 的工具闸门先问（Don't Ask 下直接拒绝）。
   第三方 MCP 工具只在 Auto 下挂载，每次调用先出审批卡；Orbit 自己的 MCP 不问。
7. 核对旧引擎：重复批次 0 中的 Claude 和 `deepseek` 续聊。

**批次 2..n：其余 runner。** 每台都按批次 1 的第 1–3 步和第 5、7 步执行。
还没升级的 runner 上，dsh 会话会被服务端拒绝（409 升级提示）；已升级但还没安装的 runner 上，会被拒绝为 409 `DSH_NOT_INSTALLED`。两种情况下已有 dsh 工作都不会被领取。

## 4. 回退步骤

回退分两级。两级都会停止新增 dsh 派发，并保留既有会话状态。
无论哪一级，都不要删除 provider 配置，不要删除 `${ORBIT_HOME}/dsh-sessions/`，也不要清理 `engines/dsh/`。

**一级：关闭入口（按用户 / 配置生效，不需要重启）。**
- 对每个 dsh 配置执行 `PATCH /api/providers/mine/:id {"enabled":false}`，或在 Web 停用它。
- 预期：新建 dsh 会话返回 400 `provider not available`。已有 dsh 会话的新消息会被接受并排队，会话停在 PENDING，错误为 `Provider is unavailable; check its configuration`，不会派发，也不会改走 Claude。
- 重新启用后，排队的消息会在同一个 ACP 会话上继续执行（`resumed:true`）。
- 没有全局开关：账号级的统一回退请用二级。

**二级：回退 runner（覆盖所有用户，适用于 runner 侧故障）。**
- 把 runner 换回上一个发布版（≤ 0.1.211）并重启。心跳会把 `provider:dsh` 从 capabilities 中去掉。
- 预期：新建 dsh 会话返回 409 升级提示。已有 dsh 会话的消息排队，会话停在 PENDING 并显示同一升级提示。
  旧 runner 不会领取这些会话，任何进程 argv 中都不会出现 dsh ACP 会话 id。
- 保留 `dsh-sessions/` 和 `engines/dsh/`：旧 runner 不会读写它们（两轮演练中回退前后都逐字节一致）。

**回退后检查清单**
1. 依次检查：capabilities 中 `provider:dsh` 的有无；`engines[dsh]`；dsh 配置的 `enabled` 状态；对一个已有 dsh 会话发消息后的 PENDING 状态和错误文字。
2. 运行 `ps -eo args | grep <dsh ACP 会话 id>`，预期没有任何进程（尤其是 `claude --resume` / `--session-id`）。
3. 在 DB 中核对：所有 runtime 不是 dsh 的会话，其 init 事件里的 sessionId 都不等于任何 dsh 会话的 `runtime_session_id`（SQL 见 [audit.sql](evidence/deepseek-harness/p7-drill/stack/audit.sql)，预期计数为 0）。
4. Claude 新建、Claude 续聊、旧 `deepseek` 续聊三项都成功。

**恢复（回退之后再启用）：** 先升级 runner 并核对 `engines[dsh].installed`，再重新启用配置。被暂留的消息按原顺序在原 ACP 会话上执行，上下文保留。

## 5. 故障诊断

| 现象 | 原因 | 处理 |
|---|---|---|
| 创建返回 409 `…requires a newer Orbit runner with dsh support…` | 目标 runner 没有声明 `provider:dsh`（旧版，或刚重启、心跳未到） | 升级 runner，或等一个心跳周期；如果是有意回退，这就是预期结果 |
| 创建返回 409 `DSH_NOT_INSTALLED: DeepSeek Harness is not installed on this runner, or the runner has not reported it yet…`；已有会话 PENDING 并显示同一文字 | runner 已声明 dsh，但心跳上报未安装（或还没上报） | 安装（第 2 节第 3 条）；30 秒内心跳带上 installed，PENDING 会话在下一个领取长轮询（25 秒内）派发，沿用原 ACP id |
| 会话 FAILED，错误为 `DSH_NOT_INSTALLED`（被领取后才失败） | 已发布的安装目录事后被删除，且下一次探测尚未上报（第 6 节限制 1） | 重新安装；之后新开会话或续聊 |
| 创建返回 400 `provider not available: "<slug>"` | dsh 配置已停用 | 有意回退时保持现状；需要开放时重新启用 |
| 会话 PENDING，错误为 `Provider is unavailable; check its configuration` | 配置停用期间收到了新消息 | 重新启用后会自动执行；不要改走其他配置 |
| `DSH_PLATFORM_UNSUPPORTED` / `DSH_NODE_UNSUPPORTED` | 非 Linux x64，或 Node 不是 26 | 不要在这台 runner 上启用 dsh |
| `DSH_INSTALL_FAILED` / `DSH_VERSION_INCOMPATIBLE` | npm 安装失败，或已有目录的版本不对 | 查看 runner 日志；不要手动覆盖已发布的目录（`DSH_VERSION_INCOMPATIBLE` 没有客户端修复卡，见第 6 节） |
| `DSH_CREDENTIAL_MISSING` | 配置没有 Key | 在 Web 补上 Key |
| `DSH_CREDENTIAL_INVALID`，Web 显示 "Update the API key" | DeepSeek 拒绝了这把 Key（真实 401） | 更新 Key；轮次已如实记为 FAILED |
| `DSH_REQUEST_FAILED`（限流、断网、服务端错误） | 上游错误 | 重试；不会被记为成功 |
| `DSH_CONFIG_CONFLICT` | 恢复时 cwd、profile 或版本与身份记录不一致（例如工作区目录被移动） | 恢复原目录；不要删除会话目录 |
| `DSH_PERMISSION_UNSUPPORTED` / `DSH_MCP_UNSUPPORTED` / `DSH_TOOL_POLICY_UNSUPPORTED` | 选择了 dsh 不支持的权限模式或工具限制 | 改用 Default / Auto / Don't Ask |
| EXECUTABLE 任务会话一直 RUNNING | 审批卡在等人处理：Default 下的写文件，或 Auto 下的 push、fetch、安装等 | 在会话里 Approve / Reject；只是写文件的任务可以改用 Auto 模式派发 |

排查顺序：先看 `GET /api/runners` 中的 capabilities 和 `engines[dsh]`，再看 provider 的 `enabled`，最后看会话的 `error` 和 run_event 中的 init、error、turn_end。

## 6. 已知限制

1. 已发布的安装目录事后消失时，在 runner 下一次引擎探测（5 分钟以内）上报之前，加上其后一个领取长轮询（25 秒以内），即最多约 5 分钟加 25 秒，会话仍可能被领取，并在 runner 上以 `DSH_NOT_INSTALLED` 失败。从未安装过的 runner 不存在这个窗口。
2. `DSH_VERSION_INCOMPATIBLE` 没有客户端修复卡。
3. runner 完成首次引擎探测之前，Web/macOS 的 runner 状态显示 ready，与服务端「未安装」的判定不一致；以服务端 409 和 `engines[dsh]` 为准。
4. 平台不准入的提示（`DSH_PLATFORM_UNSUPPORTED` / `DSH_NODE_UNSUPPORTED`）未在真实 macOS runner 上实测。
5. 没有全局 dsh 开关：一级回退要逐个停用配置，账号级回退靠回退 runner。
6. 未选模型时，首轮 `session.model` 为空字符串，模型目录到达后才填上（F3）。
