# DeepSeek Harness 安装与会话环境

这份交付说明供 runner 的 ACP 驱动和恢复流程使用。安装与配置遵循 [P0 契约](deepseek-harness-runtime-contract.md)，固定 `@deepseek-ai/dsh@0.2.0-rc.2`。P2 提供启动环境、目录探针和健康字段；会话协议循环由 P3 实现。

凭据（2026-10-09 起，[provider 与 engine 解耦](provider-engine-contract.md)）：

- DeepSeek key 不属于某个 engine：同一把 key 同时用于 Claude Code、OpenCode 和 DeepSeek Harness。
- dsh 会话用的是会话所选的那把 DeepSeek key，可以在多把之间切换。
- 停用或删除一把 key，会同时影响它在所有 engine 上的会话。
- dsh 会把 key 从它跑的命令的环境里去掉（见下文「凭据」）；同一把 key 交给 Claude Code、OpenCode 时，agent 跑的命令能在环境里直接读到它（[解耦契约](provider-engine-contract.md) §4.6）。

## 固定版本安装

首版准入为 Linux x64、服务 PATH 中的 Node 26。P0 的真实实验使用 Node 26.10.0；其他平台、架构、Node 主版本及真实模型仍未验证。runner 拒绝未准入平台，返回 `DSH_PLATFORM_UNSUPPORTED` 或 `DSH_NODE_UNSUPPORTED`。

安装使用嵌入的 P0 `package.json` 和完整 `package-lock.json`，在私有暂存目录执行 `npm ci`，核对 CLI `--version` 精确等于 `0.2.0-rc.2` 后，发布到 `${ORBIT_HOME}/engines/dsh/0.2.0-rc.2`。未指定 ORBIT_HOME 时沿用 runner 的 machineHome。启动使用该目录内部的绝对入口；用户 PATH 上的 dsh 和 npm latest 都不参与选择。ACP 的插件版本不用于判断发行版本。

`src/runner-go/dsh-install/` 的两个文件与 `scripts/deepseek-harness-p0/` 当前版本逐字节相同（测试断言），包括 `@deepseek-ai/libreoffice-kit` 的 `fflate` 0.8.3 安全覆盖；`@deepseek-ai/dsh` 0.2.0-rc.2 的 integrity 不变。P0 锁文件更新时同步复制这两个文件。已发布的 `0.2.0-rc.2` 目录不可变，不会因锁文件更新而重装。

首次自动安装沿用 `AutoInstallEngines` 授权，默认拒绝；用户发起的浏览器 Install 使用既有单次授权。安装、更新共用原有锁。更新只在已有 Orbit 管理的 dsh 安装上工作，活动会话沿用原有延后策略；以后提升支持版本时安装相邻的新目录，保留旧目录。损坏、不兼容或链接到外部目录的已发布安装会报错，不原地覆写。

## 启动与恢复接口

`PrepareDshLaunch(ctx, DshLaunchInput)` 返回 P0 的 `DshLaunchSpec`。`PrepareDshSessionLaunch(ctx, job, executionDir, fileMode)` 从已授权派发的 `job.Agent.Env` 读取 `ORBIT_DSH_API_KEY` 和 `ORBIT_DSH_BASE_URL`，也就是会话所选 DeepSeek key 的 key 与 baseUrl。服务端按会话 engine 注入它们（[解耦契约](provider-engine-contract.md) §4.2）；同一把 key 用在 Claude Code 会话上时注入的是 `ANTHROPIC_*`，两者互不影响。key 仍通过现有 AES GCM 加密存储、授权解密和派发链进入 runner；本模块不建立第二个凭据存储。

共享声明 `dsh_launch.go` 与 P3a 提交一致，避免并行合并出现重复类型或常量。P3a 的 `prepareDshSessionLaunch(ctx, job, scratchDir, execDir)` seam 保持未接入时明确失败；P3b 需要忽略 scratchDir，以 execDir 和显式验证的文件策略调用 P2 准备器，两个签名的字符串参数含义不同，不能直接赋值。

每个 Orbit 会话使用 `${machineHome}/dsh-sessions/<canonical-session-id>`，与可清理的 run scratch 分开。目录为 0700，Orbit overlay 与身份记录为 0600。身份记录固定 canonical cwd、CLI 版本、配置哈希和 profile 哈希。启动参数为 `--profile acp --patch <absolute-overlay>`；overlay 明确设置 `llm-deepseek.config.apiKeyEnv=ORBIT_DSH_API_KEY` 和 baseURL，并关闭会话日志与插件清单上传（见下文）。

启动环境保留真实 HOME 和服务 PATH，只继承基础 locale、临时目录及网络代理设置。用户 Harness profile、其他 provider Key、NODE_OPTIONS 和项目 `.env` 不用于推断 dsh 凭据。专用 Key 只在子进程环境中存在，不写入 overlay、身份记录或恢复文件；缺少授权 Key 时在启动前返回 `DSH_CREDENTIAL_MISSING`。同 UID 工具可以读取进程环境和恢复数据，目录隔离不构成 OS 用户安全边界。

P3 按以下顺序接入：

1. Prepare，使用返回的 Executable、Args、Env 和 Cwd 启动常驻进程。
2. initialize 成功后调用 `SealDshProfile(spec)`，再 new 或 resume。
3. 保存真实 runtimeSessionId。恢复必须重用 DshHome 和 canonical cwd，并重新提供 MCP 配置。

`ConfigHash` 覆盖固定 CLI 版本、acp profile 身份、文件策略和 Orbit overlay。Harness 启动生成的四个 profile 文件由 Seal 另行计算 `ProfileHash` 并持久化；下一次 Prepare 会在启动前验证两个哈希。profile、overlay、cwd、身份或版本不符返回 `DSH_CONFIG_CONFLICT`，保留恢复数据。已授权的 endpoint 或文件策略更改先 Dispose 旧进程，再 Prepare 更新 overlay；Key 更新不改变 profile 或恢复路径。

`Close` 只关闭 ACP session；EOF、SIGTERM 与 Dispose 结束进程。两种操作都保留整棵 DSH_HOME，包含 profile、sessions、storages、cache 和锁等运行时数据。本模块不提供删除恢复数据的隐式路径。撤销 Key 后旧进程的环境不会自动变更，调用方必须结束旧进程并以最新授权派发重新 Prepare；不得继续使用旧 Env，也不得自动重发崩溃前的 prompt 或 tool。

## 随模型请求上传的会话日志

`DSH_TELEMETRY_DISABLED=1` 只关闭 OpenTelemetry 遥测，不关闭请求扩展字段。固定版本默认 bundle（`dsh-base/cordis.patch.yml`）挂载两个插件，它们通过 `@deepseek-ai/dsh-deepseek-llm-api-extensions` 给 `llm-deepseek` 发出的每个模型请求加上顶层字段，发往配置的 baseURL，即 api.deepseek.com 或任何自定义端点：

- `@deepseek-ai/dsh-session-log-deepseek`（row `session-log-deepseek`）写 `dsh_session_log`。字段内容为 `{version, sessionFormatVersion, session: {version, id, createdAt, cwd}, afterSeq, throughSeq, events}`，`events` 是会话规范日志中上次服务端确认之后的全部事件，原样不脱敏。实测出现的事件类型：用户消息（含 workspace `AGENTS.md`/skills 注入）、system 消息（含 Orbit 追加提示词）、`request/header`（模型、工具定义）、助手消息与流、`tool/call` 参数、`tool/result` 输出（读文件的路径与逐行内容、bash 输出）、会话标题、审批策略、沙箱模式及 `session-log-deepseek/delivery-accepted`。单次字段上限 `maxBytes` 默认 8 MiB；积压分多次请求续传，超限的单个事件不发送并阻塞其后事件。HTTP 2xx 后在日志追加 `delivery-accepted` 水位，失败的范围下次重发（至少一次）。
- `@deepseek-ai/dsh-plugin-package-inventory-deepseek`（row `plugin-package-inventory-deepseek`）写 `dsh_plugin_packages`，内容为 `{version, packages: [{name, version}]}`，列出启用的插件包；实测 84 个，其中包括 Orbit 的 `orbit-dsh-append-system-prompt`。

两者的官方开关是各自 row 的 `config.enabled`，上游默认 `true`。Orbit 的 `orbit.patch.json` 默认把两者都设为 `{"enabled": false}`。命令行 `--patch` 的优先级高于 profile、`DSH_HOME` 补丁和 Web 设置开关；ACP 模式没有设置界面。关闭后插件仍挂载，只是不登记字段，也不写 `delivery-accepted`。上游说明：若之后重新打开，会补传关闭期间记录的未确认事件。已有会话下次 Prepare 时会改写 overlay 并更新 `ConfigHash`，恢复数据保留。

凭据：Key 只放在 dsh 进程环境和请求的 `x-api-key` 头里。dsh 启动子进程时会去掉名字匹配 `KEY|PASSWORD|SECRET|TOKEN` 的环境变量和所有 `DSH_*` 变量（`dsh-subprocess` 的 `scrubbedParentEnv`），所以 agent 执行 `env` 看不到 `ORBIT_DSH_API_KEY`。runner 自身的其他环境变量不会进入 dsh。实测两种配置下，Key 和 runner 侧合成凭据都没有出现在任何请求体或其他请求头中。限制：agent 读取的文件和命令输出本来就作为模型输入发往端点，与本开关无关；名字不匹配上述模式、但值里带凭据的变量（例如带用户名密码的 `HTTP_PROXY`）会出现在 `env` 输出中。

本开关不控制的部分：每个请求仍带 `user-agent`、`x-deepseek-harness-session-id`，以及 `x-deepseek-harness-user-id`（保存在 `DSH_HOME/.anonymous-user-id` 的随机 UUID，Orbit 下每个会话一个）。固定版本没有关闭它们的配置。

复现：`node scripts/deepseek-harness-session-log/record.mjs <dir>`。脚本先安装 canonical P0 锁，然后用真 dsh 和本地 mock 端点各录制一遍上游默认和 Orbit 配置。结果与字段清单在 `docs/evidence/deepseek-harness/session-log-upload/`。

## 目录与健康状态

目录探针使用临时的独立 DSH_HOME，执行 initialize、session/new、session/close 和 EOF；不执行 authenticate 或模型请求。它同时检查 startup stderr、协议响应和退出结果。目录由运行时 `configOptions` 提供，模型值保持 opaque，思考选项来自 `reasoning_effort`；不补静态模型、思考级别或 contextWindow。上下文窗口初始未知，P3 从 usage 更新学习。

`RunnerEngineHealth.dsh` 分开携带 `versionCompatible`、`credentialPresent`、`modelCatalogReadable`、`requestValidation` 和 `sandboxEnforcement`。机器探针没有会话 Key，始终报告 credentialPresent=false、requestValidation=unknown、auth=unknown；会话驱动用派发 Key 的存在性填充自己的状态。`dshRequestValidation` 只接收实际模型请求结果：成功为 valid，明确认证错误为 invalid，内部协议错误、限流、网络或服务器错误保留 unknown。握手、authenticate 和目录可读均不证明登录。

健康诊断使用固定 `DSH_*` 代码。普通日志与 API 不输出启动 Env、Key 或上游原始错误；API 清洗也不接收附加 env/apiKey 字段。沙箱状态在未独立验证时保持 unknown，目录探针明确遇到 `SANDBOX_UNAVAILABLE` 时失败，不推断 full enforcement。

上述脱敏覆盖 P2 准备器、目录探针、健康和 API 边界。P3 启用生产 seam 前须对运行时 stderr 与 RPC Message/Data 另行脱敏，并统一 canonical cwd；不得将原始运行时错误直接送入普通日志或 turn settlement。

## 未安装时的派发门禁

runner 在 `X-Orbit-Supported-Providers` 和心跳里声明 `dsh`，只表示它支持这一协议，不表示 CLI 已安装（D1）。所以服务端另外读取该 runner 最近一次心跳里的引擎报告 `engines[dsh]`（`runner-provider-support.ts` 的 `dshRuntimeUnavailable`）。只有固定版本已安装、版本核对通过、平台准入时，才会派发 dsh 会话。快照缺失、报告里没有 dsh 条目，或者字段无法解析时，一律按未安装处理，不放行。

- 新建会话（`POST /sessions`）和恢复已结束的会话（`POST /sessions/:id/resume`）返回 409，提示与升级提示同类。提示以 runner 自己的诊断码开头，Web 的 `dshRepair` 和 OrbitKit 的 `DshRuntime.repair` 按已有修复卡识别：
  - `DSH_NOT_INSTALLED: DeepSeek Harness is not installed on this runner, or the runner has not reported it yet; install it from Infrastructure, then try again`
  - `DSH_PLATFORM_UNSUPPORTED: …`，报告为 `DSH_PLATFORM_UNSUPPORTED` 或 `DSH_NODE_UNSUPPORTED` 时使用
  - `DSH_VERSION_INCOMPATIBLE: …; reinstall it from Infrastructure, then try again`，用于已安装但版本不符或版本探测失败。客户端暂无对应修复卡，只显示原文。

  被拒绝的请求不写会话，也不改变已有会话。runner 没有声明 dsh 时，仍先得到 P1b 的升级提示，升级提示优先于权限模式校验；安装状态在权限模式校验之后判断。
- 领取（`GET /runner/sessions/claim`）：runner 的声明原样保留。该 runner 上 engine 为 dsh 的会话不派发。解耦前它们是内置 `dsh` 与 runtime 为 dsh 的配置 provider；engine 为空的旧行仍按这条旧规则判断。PENDING 行写上同一条提示，机制与升级提示相同，领取成功时清除。已持久化会话的后续消息照常入队，保持 PENDING，不会被领取后失败。数据库层的 `orbit.runner_supports_dsh` 在这次领取中同样为 `0`。
- 安装完成（Infrastructure 页上 DeepSeek Harness 的 Install，即 `POST /runners/:id/install {engine: dsh}`）后，runner 重新探测引擎，下一次心跳（30 秒以内）带上 `installed=true`。新建和恢复随即放行。等待中的会话在下一个领取长轮询（25 秒以内）派发，沿用原 runtimeSessionId 和 DSH_HOME 续聊。
- 不受影响的部分：runner 重启后的 reclaim 和租约接管只检查声明，因为它们交还的是这台 runner 已经在运行的会话；修改会话配置不读取安装状态；其他引擎照常派发，不会被 dsh 未安装卡住。
- 时效：门禁以最近一次报告为准，领取长轮询在开始时读取报告。已经发布的安装目录如果事后消失，在下一次探测（5 分钟以内）上报之前，以及其后一个领取长轮询内，会话仍可能被领取，并在 runner 上以 `DSH_NOT_INSTALLED` 失败。从未安装过的 runner 不存在这个窗口。
- 运维：升级 runner 后不必赶在开放入口前先装好 dsh。未安装期间，API、CLI 和自动派发的任务都会得到上述提示，而不是一个失败的会话。

验收入口：`bash scripts/test-dsh-install-gate.sh`。脚本使用真实 PostgreSQL、生产 apiserver，以及从本仓库编译的 runner；先在已安装状态跑两个会话，再移除版本目录、重启同一个 runner（等同于已升级未安装），最后通过 Orbit 的安装中继安装。共 6 个具名场景，缺失、跳过或失败均非零退出。服务端分支由 `src/apiserver/src/sessions/dsh-install-preflight.spec.ts`、`src/apiserver/src/queue/dsh-install-gate.spec.ts` 和 `src/apiserver/src/queue/dsh-install-gate.pg.spec.ts`（`scripts/run-pg-spec.sh`）覆盖。结果在 `docs/evidence/deepseek-harness/install-gate/`。

## 验证入口与范围

在仓库根运行 `bash scripts/test-dsh-runtime-environment.sh`。脚本重新编译 shared 和 API，强制执行 45 个具名 Go/API 场景及 9 个脚本防护测试；缺失、未匹配、跳过、启动失败或测试失败均非零退出。node:test 的两个输出流直接写普通文件。

新增场景使用假安装器、假版本探测、假 ACP 进程及本地 mock HTTP 服务。两个进程同时请求，核对不同 Key、baseURL、文件策略、目录和 HOME；重启保留各自状态；缺 Key、撤销、无效 Key、Key 更新、目录冲突、profile/overlay 哈希变化及不兼容版本均有直接检查。API 场景核对加密派发与脱敏输出。脚本对真实 HOME 下 `.dsh` 的递归内容和权限取前后指纹，变更即失败。

这些测试证明 P2 启动边界的隔离与错误语义。真实 CLI 协议基线沿用 P0 已确认实验；新产品驱动、真实模型、MCP 守卫、取消与恢复竞态，以及其他平台仍由 P3、P4 和 P6 对应任务验证。

## P3b 会话生命周期

生产 seam 已接入：`prepareDshSessionLaunch(ctx, job, execDir)` 以会话 checkout 调用 `PrepareDshSessionLaunch`，文件策略由 `dshFileModeForPermission` 显式给出（plan 为 `read-only`，其余为 `workspace-write`，从不更宽），准备器拒绝其他取值。驱动以 canonical cwd（Abs + EvalSymlinks）核对 `spec.Cwd`，并以同一 cwd 执行 new/resume；initialize 后对准备出的 spec 调用 `SealDshProfile`，再 new 或 resume。已有 runtimeSessionId 时只 `session/resume`，失败即报错，不改用 new。

DSH_HOME 内的 `orbit-turns.json` 是 runner 的回合台账：保存 runtimeSessionId，以及每个 Orbit turn 在写出 prompt 前的 `prompted` 记录、未终态工具 id 和首次结算。Orbit 尚未收到 runtime id 时，从台账恢复同一会话。已 `prompted` 却未结算的回合再次投递时（runner 崩溃、租约转移），不重发 prompt，补齐其工具的失败终态并结算为 INTERRUPTED；已结算但完成回执丢失的回合按原结算再报一次。同一进程内的重复投递直接丢弃。

单会话只有一个进行中 prompt；运行中的新消息留在 Orbit 队列（服务端在 IN_FLIGHT 期间不投递下一条），租约过期造成的提前投递在 runner 本地排队，按序开始。不声明原生 mid-turn steer；shell 回合以 `unknown_kind` 失败结算，不结束会话。

结算优先级由 `dshSettlementOutcome` 固定，从高到低：本地停止（interrupt、end、关机、会话取消、租约丢失）一律为 cancelled，晚到的 end_turn 也不改变；其次 prompt 响应（end_turn、max_tokens 输出上限、refusal、cancelled）；再次 JSON-RPC 错误；最后是无响应的进程退出或传输断开。每个回合只结算一次。审批请求在本阶段一律回复 cancelled，停止或断开后不会有迟到许可；已结算回合的迟到 `tool_call_update` 与消息块被丢弃，不进入下一回合。

租约丢失时先结束整个进程组（含工具子进程），只在本地结算，不向新租约持有者回报，台账保留 `prompted` 给下一任处理。进程意外退出且有活动回合时，回合 FAILED 并结束会话；若该回合已先被本地停止，则结算 INTERRUPTED，会话保持可恢复。关机与 end 先 `session/close`，保留整棵 DSH_HOME。reload 改变 Key、baseURL 或文件策略时结束旧进程，由监督者从最新派发重新 Prepare 并 resume；会话切换到另一把 DeepSeek key 也走这条路径，ACP 会话 id 与 DSH_HOME 不变；仅模型变化时在线 `session/set_config_option`。撤销 Key 后 Prepare 以 `DSH_CREDENTIAL_MISSING` 失败，不再启动。

运行时 stderr 与 RPC 错误的 Message/Data 在写入日志或结算前替换启动 Key 及 `sk-` 形态的值，错误仍为失败终态。

验收入口：在仓库根运行 `bash scripts/test-dsh-session-lifecycle.sh`。脚本先以 TAP 文件运行 `test/test-dsh-session-lifecycle.test.mjs` 防护用例，再在隔离目录 `npm ci` 当前仓库的 canonical P0 锁文件，核对 CLI 版本与哈希，然后以 `go test -json` 强制执行全部具名生命周期、受影响的 P3a 驱动及真实 dsh 场景，并对进程内场景再跑 `go test -race`。缺失、未匹配、跳过、失败或启动失败均非零退出。传入 `--evidence <dir>` 时保存输出与录制；录制把控制面回合行（状态、投递次数、完成回执）、引擎会话日志、请求序列、副作用文件、runner 台账和 Orbit 事件放在一起对照。本次结果在 `docs/evidence/deepseek-harness/p3b/`。
