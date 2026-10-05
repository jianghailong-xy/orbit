# DeepSeek Harness 安装与会话环境

这份交付说明供 runner 的 ACP 驱动和恢复流程使用。安装与配置遵循 [P0 契约](deepseek-harness-runtime-contract.md)，固定 `@deepseek-ai/dsh@0.2.0-rc.2`，保留原有通过 Claude 执行的 DeepSeek provider。P2 提供启动环境、目录探针和健康字段；会话协议循环由 P3 实现。

## 固定版本安装

首版准入为 Linux x64、服务 PATH 中的 Node 26。P0 的真实实验使用 Node 26.10.0；其他平台、架构、Node 主版本及真实模型仍未验证。runner 拒绝未准入平台，返回 `DSH_PLATFORM_UNSUPPORTED` 或 `DSH_NODE_UNSUPPORTED`。

安装使用嵌入的 P0 `package.json` 和完整 `package-lock.json`，在私有暂存目录执行 `npm ci`，核对 CLI `--version` 精确等于 `0.2.0-rc.2` 后，发布到 `${ORBIT_HOME}/engines/dsh/0.2.0-rc.2`。未指定 ORBIT_HOME 时沿用 runner 的 machineHome。启动使用该目录内部的绝对入口；用户 PATH 上的 dsh 和 npm latest 都不参与选择。ACP 的插件版本不用于判断发行版本。

`src/runner-go/dsh-install/` 的两个文件与 `scripts/deepseek-harness-p0/` 当前版本逐字节相同（测试断言），包括 `@deepseek-ai/libreoffice-kit` 的 `fflate` 0.8.3 安全覆盖；`@deepseek-ai/dsh` 0.2.0-rc.2 的 integrity 不变。P0 锁文件更新时同步复制这两个文件。已发布的 `0.2.0-rc.2` 目录不可变，不会因锁文件更新而重装。

首次自动安装沿用 `AutoInstallEngines` 授权，默认拒绝；用户发起的浏览器 Install 使用既有单次授权。安装、更新共用原有锁。更新只在已有 Orbit 管理的 dsh 安装上工作，活动会话沿用原有延后策略；以后提升支持版本时安装相邻的新目录，保留旧目录。损坏、不兼容或链接到外部目录的已发布安装会报错，不原地覆写。

## 启动与恢复接口

`PrepareDshLaunch(ctx, DshLaunchInput)` 返回 P0 的 `DshLaunchSpec`。`PrepareDshSessionLaunch(ctx, job, executionDir, fileMode)` 从已授权派发的 `job.Agent.Env` 读取 `ORBIT_DSH_API_KEY` 和 `ORBIT_DSH_BASE_URL`。配置 provider 的 Key 仍通过现有 AES GCM 加密存储、授权解密和派发链进入 runner；本模块不建立第二个凭据存储。

共享声明 `dsh_launch.go` 与 P3a 提交一致，避免并行合并出现重复类型或常量。P3a 的 `prepareDshSessionLaunch(ctx, job, scratchDir, execDir)` seam 保持未接入时明确失败；P3b 需要忽略 scratchDir，以 execDir 和显式验证的文件策略调用 P2 准备器，两个签名的字符串参数含义不同，不能直接赋值。

每个 Orbit 会话使用 `${machineHome}/dsh-sessions/<canonical-session-id>`，与可清理的 run scratch 分开。目录为 0700，Orbit overlay 与身份记录为 0600。身份记录固定 canonical cwd、CLI 版本、配置哈希和 profile 哈希。启动参数为 `--profile acp --patch <absolute-overlay>`；overlay 明确设置 `llm-deepseek.config.apiKeyEnv=ORBIT_DSH_API_KEY` 和 baseURL。

启动环境保留真实 HOME 和服务 PATH，只继承基础 locale、临时目录及网络代理设置。用户 Harness profile、其他 provider Key、NODE_OPTIONS 和项目 `.env` 不用于推断 dsh 凭据。专用 Key 只在子进程环境中存在，不写入 overlay、身份记录或恢复文件；缺少授权 Key 时在启动前返回 `DSH_CREDENTIAL_MISSING`。同 UID 工具可以读取进程环境和恢复数据，目录隔离不构成 OS 用户安全边界。

P3 按以下顺序接入：

1. Prepare，使用返回的 Executable、Args、Env 和 Cwd 启动常驻进程。
2. initialize 成功后调用 `SealDshProfile(spec)`，再 new 或 resume。
3. 保存真实 runtimeSessionId。恢复必须重用 DshHome 和 canonical cwd，并重新提供 MCP 配置。

`ConfigHash` 覆盖固定 CLI 版本、acp profile 身份、文件策略和 Orbit overlay。Harness 启动生成的四个 profile 文件由 Seal 另行计算 `ProfileHash` 并持久化；下一次 Prepare 会在启动前验证两个哈希。profile、overlay、cwd、身份或版本不符返回 `DSH_CONFIG_CONFLICT`，保留恢复数据。已授权的 endpoint 或文件策略更改先 Dispose 旧进程，再 Prepare 更新 overlay；Key 更新不改变 profile 或恢复路径。

`Close` 只关闭 ACP session；EOF、SIGTERM 与 Dispose 结束进程。两种操作都保留整棵 DSH_HOME，包含 profile、sessions、storages、cache 和锁等运行时数据。本模块不提供删除恢复数据的隐式路径。撤销 Key 后旧进程的环境不会自动变更，调用方必须结束旧进程并以最新授权派发重新 Prepare；不得继续使用旧 Env，也不得自动重发崩溃前的 prompt 或 tool。

## 目录与健康状态

目录探针使用临时的独立 DSH_HOME，执行 initialize、session/new、session/close 和 EOF；不执行 authenticate 或模型请求。它同时检查 startup stderr、协议响应和退出结果。目录由运行时 `configOptions` 提供，模型值保持 opaque，思考选项来自 `reasoning_effort`；不补静态模型、思考级别或 contextWindow。上下文窗口初始未知，P3 从 usage 更新学习。

`RunnerEngineHealth.dsh` 分开携带 `versionCompatible`、`credentialPresent`、`modelCatalogReadable`、`requestValidation` 和 `sandboxEnforcement`。机器探针没有会话 Key，始终报告 credentialPresent=false、requestValidation=unknown、auth=unknown；会话驱动用派发 Key 的存在性填充自己的状态。`dshRequestValidation` 只接收实际模型请求结果：成功为 valid，明确认证错误为 invalid，内部协议错误、限流、网络或服务器错误保留 unknown。握手、authenticate 和目录可读均不证明登录。

健康诊断使用固定 `DSH_*` 代码。普通日志与 API 不输出启动 Env、Key 或上游原始错误；API 清洗也不接收附加 env/apiKey 字段。沙箱状态在未独立验证时保持 unknown，目录探针明确遇到 `SANDBOX_UNAVAILABLE` 时失败，不推断 full enforcement。

上述脱敏覆盖 P2 准备器、目录探针、健康和 API 边界。P3 启用生产 seam 前须对运行时 stderr 与 RPC Message/Data 另行脱敏，并统一 canonical cwd；不得将原始运行时错误直接送入普通日志或 turn settlement。

## 验证入口与范围

在仓库根运行 `bash scripts/test-dsh-runtime-environment.sh`。脚本重新编译 shared 和 API，强制执行 45 个具名 Go/API 场景及 9 个脚本防护测试；缺失、未匹配、跳过、启动失败或测试失败均非零退出。node:test 的两个输出流直接写普通文件。

新增场景使用假安装器、假版本探测、假 ACP 进程及本地 mock HTTP 服务。两个进程同时请求，核对不同 Key、baseURL、文件策略、目录和 HOME；重启保留各自状态；缺 Key、撤销、无效 Key、Key 更新、目录冲突、profile/overlay 哈希变化及不兼容版本均有直接检查。API 场景核对加密派发与脱敏输出。脚本对真实 HOME 下 `.dsh` 的递归内容和权限取前后指纹，变更即失败。

这些测试证明 P2 启动边界的隔离与错误语义。真实 CLI 协议基线沿用 P0 已确认实验；新产品驱动、真实模型、MCP 守卫、取消与恢复竞态，以及其他平台仍由 P3、P4 和 P6 对应任务验证。
