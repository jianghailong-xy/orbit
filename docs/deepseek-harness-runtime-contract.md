# DeepSeek Harness ACP 运行时契约（P0）

本契约供 P2 安装隔离、P3 基础驱动/恢复、P4 MCP/审批分别实现。**【约定】** 内部 engine 名为 `dsh`，用户名称为 **DeepSeek Harness**。

**【约定，2026-10-09 起，取代原「现有 `deepseek` provider 继续属于 Claude runtime」】** provider 与 engine 已解耦，见 [provider-engine-contract.md](provider-engine-contract.md)：

- `dsh` 只是 engine，不再是一类 provider，也不再是 key 的 runtime。
- DeepSeek API key（preset `deepseek`，或自定义且主机为 `api.deepseek.com`）同一把同时用于 Claude Code、OpenCode 和 DeepSeek Harness。会话用哪个 engine 记录在 `Session.engine`，终身不变。
- DeepSeek Harness 会话可以在多把 DeepSeek key 之间切换，切换后在原 ACP 会话上续聊。
- 原来的 `deepseek-harness` 配置（runtime `dsh`）由存量迁移并入 DeepSeek key，旧 slug 仍解析为该 key + DeepSeek Harness。

**【仓库核对】** 冻结基线 `src` 没有已有 `dsh` 符号；P1 仍须验证可配置 provider 名的实际保留字冲突。本任务没有注册引擎、修改产品路由、部署或完成整个接入。

## 1. 基线、方法与判据

- **【实测】** 2026-10-04，官方 npm `@deepseek-ai/dsh@0.2.0-rc.2`，Linux x64，Node `v26.10.0`、npm `11.19.1`，内核 `6.12.107+deb13-amd64`。每次启动执行真 CLI；没有 mock dsh、替换 ACP 实现或使用真实 API Key。
- **【源码】** 官方标签 `dsh-v0.2.0-rc.2`，提交 `639ed015397290b3745d163aafe02ffee4aa3f84`。复用前序留下的该提交源码和项目确认结论，没有改用 master。项目记录指定 `project/34ZurCP3bv9yLXGVyUGnx`，P0 起步时该 ref 尚未在本地建立；已检查协调分支，未发现 DeepSeek 已提交产物。Orbit 起步提交是 `93d3ec5804a15f240290f5c0971983c6fb7e9c5c`。
- **【实测】** 固定直接与传递依赖的[锁文件](../scripts/deepseek-harness-p0/package-lock.json)，CLI 文件 SHA-256、npm integrity、锁文件 SHA-256、平台、时间都写入[summary.json](evidence/deepseek-harness/dsh-v0.2.0-rc.2/summary.json)。`initialize.agentInfo.version=0.0.1` 是 ACP 插件标识，不能用来判断 CLI 版本。
- **【实测】** 24 个场景在真 dsh + 本地 Messages SSE mock + 真 stdio MCP peer 上执行。录制为[protocol.ndjson](evidence/deepseek-harness/dsh-v0.2.0-rc.2/protocol.ndjson)；summary 每条给出 `seq` 范围和断言结果。[manifest.json](evidence/deepseek-harness/dsh-v0.2.0-rc.2/manifest.json) 给出录制 SHA-256。场景名是本文的证据索引。
- **【实测】** HOME 保持真实值；dsh 子进程只继承 PATH/HOME，再加入实验配置和合成 Key。依赖安装隔离在 `/tmp` 或本脚本专用目录，workspace 和多个 `DSH_HOME` 在 `/tmp`，不复制用户配置/凭据。真实 `~/.dsh` 的递归内容/权限指纹前后相同；本机起步不存在该目录，实验也没有创建它。临时原始持久化目录保留用于复查。
- **【约定】** 实测、源码、待验分别标识。源码结论不算平台或模型请求实测；接口/产品行为约定不是已完成实现。握手、目录返回或退出码 0 均不能代替 prompt 成功。

复现命令在仓库根目录直接执行，不接 `node --test` 或管道：

```sh
npm ci --prefix scripts/deepseek-harness-p0 --cache /tmp/orbit-dsh-p0-npm-cache --no-audit --no-fund
node scripts/deepseek-harness-p0/reproduce.mjs /tmp/orbit-dsh-p0-evidence
```

脚本[说明](../scripts/deepseek-harness-p0/README.md)列出环境和产物。任何 spawn 失败、版本不匹配、场景失败/缺失都失败。脱敏替换路径、UUID、端口和合成 Key，保留关联关系、方法、错误及 Key 来源；回放文件不是可直接发送的输入，复现须重新运行脚本。

## 2. 启动、配置与凭据

**【实测】** 启动形式：绝对 dsh 路径 + `--profile acp --patch <绝对 patch 文件>`，cwd 为会话 checkout。stdin/stdout 是每行一个 JSON-RPC 2.0；诊断走 stderr。实验逐行核对 stdout，没有非协议行。`close` 只关闭 session；stdin EOF 和 SIGTERM 才结束进程，实测均退出 0。进程强杀记录为 SIGKILL、exit code 空值。

**【实测】** patch 是列表，可用 JSON（YAML 子集）生成，免除字符串手工转义。`llm-deepseek.config.baseURL` 覆盖 `DEEPSEEK_BASE_URL`。本实验用官方 API-key adapter：`POST /v1/messages`，`x-api-key` 头和 Anthropic 风格 SSE；不是 `/chat/completions`。地址只指向回环 mock。P0 没有完整出站监控，不能据此宣称 Harness 全部功能无外连。

**【实测 + 源码 S2】** 配置层低到高：bundle 顺序 → profile 的 `cordis.patch.yml` → `DSH_HOME/cordis.patch.yml` → 按 argv 顺序的 `--patch` → 遥测开关。后层更新某 row 的 `config` **替换整份 config**，不是字段合并。`configuration-layer-priority` 实测 overlay、home、profile 三层逐次胜出，完整 suffix 不累积。profile 根 `cordis.yml` 是启动器重写的空根，不应存放 Orbit 配置。

**【实测】** Key 优先级（`credential-precedence-and-missing-key`）：

| 高到低 | 实测结果 |
| --- | --- |
| 启动时进程环境 | `sk-p0-inherited` 胜过其他三层 |
| `DSH_HOME/.credentials.yaml` 的 `refs` | store 胜过项目和 Harness home `.env` |
| 启动 cwd 的 `.env` | project 胜过 Harness home `.env` |
| `DSH_HOME/.env` | home 是最后回退 |

**【源码 S3】** 环境快照在启动时冻结；受管理凭据可 watch 重载，空/无效 YAML 和 POSIX 过宽权限拒绝加载。`.credentials.yaml` 格式为 `version: 1; refs: {KEY_NAME: value}`，POSIX 必须仅用户可读。持久化 Key 不是 agent 的安全隔离边界，同 UID 工具可读文件。Windows 权限检查跳过，不能称为同等保护。

**【实测】** 没有 Key 仍能 initialize/new 和得到模型选项；第一轮 prompt 返回 `-32603`、`no API key`，mock 未收到请求。401 的 mock Key 验证错误也只在 prompt 出现。因此 P2 分开报告 `installed`、`credentialPresent`、`requestValidation=unknown/valid/invalid`，不能把 catalog 或 `authenticate` 当认证测试。

**【约定】** Orbit 不继承不相关凭据或真实 Harness profile。P2 建立 0700 的持久会话目录、0600 patch/凭据；使用现有授权派发解密后的会话 Key（解耦后即会话所选的 DeepSeek key），推荐专用引用名 `ORBIT_DSH_API_KEY` 并在 `llm-deepseek.config.apiKeyEnv` 明确选择。不要依赖项目 `.env`，Key 和 permission mode 在启动环境明确固定，baseURL 在 overlay 固定。专用引用名是安装接口约定；P0 实测的是默认引用的四级解析。

**【源码 S2】** 非空 `DSH_TELEMETRY_DISABLED=1` 禁用遥测 entry，acp bundle 禁用 HMR。**【实测】** 禁遥测仍会生成 `.anonymous-user-id`。**【待验】** 长时间运行、profile 插件变更及升级行为；不能推断所有后台联网或自更新行为已测尽。P2 将运行中进程钉在不可变版本目录，更新只给后续启动使用。

**【实测 + 源码】** `DSH_TELEMETRY_DISABLED=1` 不关闭请求扩展字段。默认 bundle 挂载的 `session-log-deepseek` 和 `plugin-package-inventory-deepseek` 会给每个模型请求加上 `dsh_session_log`（会话规范日志的未确认增量，含消息、工具输入输出和 cwd）与 `dsh_plugin_packages`（启用插件的 name/version），发往配置的 baseURL。两者的官方开关是各自 row 的 `config.enabled`。Orbit overlay 将两者都设为 `false`；关闭后真 dsh 发出的请求不再带这两个字段，会话日志里也不写 `delivery-accepted`。详见[会话环境](deepseek-harness-runtime-environment.md#随模型请求上传的会话日志)和 `docs/evidence/deepseek-harness/session-log-upload/`。

## 3. 系统提示、AGENTS 与 MCP

**【实测】** `initialize-new-text-thought` 的模型请求保留 Harness identity、工具指导和 cwd 模板，包含 Orbit suffix 与 workspace `AGENTS.md` 指令。workspace AGENTS 进入 `<system-reminder>`；这和 system-role 追加是两个不同渠道。

**【实测 + 源码 S4】** 固定、受控模板可以用 `system-prompt.config.personaSuffix`，必须重述要保留的 cwd suffix 和 personaPrefix。任意用户 `appendSystemPrompt` 推荐单独 additive section：[append-prompt.mjs](../scripts/deepseek-harness-p0/append-prompt.mjs)，通过 patch `insert` 加载绝对 `file:` URL，`inject=['systemPrompt']`，注册 `order:10201`、`interpolate:false`、独立 name。`literal-additive-system-prompt` 验证 `{{this_must_remain_literal}}` 原样进入模型 system，并保留默认 identity/工具指导。不要设置 `complete:true`。

**【源码 S4】** 外部插件最近的 `package.json` 若声明 name，必须同时有非空 version，否则官方 `dsh_plugin_packages` request extension 准备失败（Orbit overlay 已关闭该扩展，manifest 仍保留版本）。P4 把小插件与带版本的 manifest 一起置于专用会话配置目录，保留代码版本/哈希；不要直接将任意用户文本当作模板。

**【源码 S4，待验】** user-global AGENTS 根跟随 `DSH_HOME`，workspace AGENTS 按目录发现。skills 的完整发现、子目录覆盖和用户 allowlist 未在 P0 穷尽验证，由 P4 验收；不能因此称全部 Agent 设置已生效。

**【实测】** Orbit MCP 注入到 new/resume 的 `mcpServers`，stdio entry **没有 type 字段**：

```json
{
  "name": "orbit",
  "command": "/absolute/path/to/orbit",
  "args": ["mcp"],
  "env": [
    {"name": "ORBIT_SESSION_ID", "value": "<session>"},
    {"name": "ORBIT_AGENT_ID", "value": "<agent>"}
  ]
}
```

上例是未来 Orbit MCP argv/身份约定；P0 实际执行绝对 Node 路径 + [mock-mcp.mjs](../scripts/deepseek-harness-p0/mock-mcp.mjs)。`mcp-stdio-injection` 记录 initialize/tools-list/tools-call、注入 session 身份和确实发生的合成副作用。模型工具名是 `mcp__orbit__record`，原始 MCP 名是 `record`。resume 必须重新提供 MCP，连接不持久化。

**【实测】** stdio 相对 command 拒绝 `-32602`；初始 MCP 连接失败让 new 返回错误，随后其他会话可继续工作。**【源码 S5】** server names 会规范化，env/header 重名拒绝，stdio cwd 是 session canonical cwd；客户端声明 MCP 即授权启动其进程/env。

**【源码 + 握手实测，待验调用】** 上游宣称 Streamable HTTP MCP，schema 是 `{type:'http', name, url, headers:[{name,value}]}`。P0 没有 HTTP MCP 请求录制，不声明 Orbit 已支持该路径。**【实测差异】** SSE MCP 声明被 ACP SDK 1.4.0 入站 vector 容错解析丢弃：new 成功但工具未挂载。源码 handler 写着拒绝 SSE，与 wire 实测不同。Orbit 必须预校验 transport；不能信任 new 成功便认为 MCP 已注入。

## 4. 会话驱动及消息契约

以下均为 **【实测】**；在 summary 的对应场景和双向录制中可查。

| 操作 | 字段/结果 | 场景 |
| --- | --- | --- |
| initialize | `protocolVersion:1`；clientCapabilities 可空；返回 close/list/resume、http MCP；本 composition image=false、audio=false、embeddedContext=false；authMethods 空 | initialize-new-text-thought |
| session/new | absolute `cwd`, `mcpServers:[]`；返回 `sessionId`, `configOptions` | initialize-new-text-thought |
| session/prompt | `sessionId`, `prompt:[{type:'text',text}]`；response 直到工作与 ordered updates 结算 | second-turn、工具场景 |
| session/update | notification；`params.sessionId`, `params.update.sessionUpdate` | 全部输出场景 |
| session/set_config_option | `configId:'model'/'reasoning_effort'`, opaque `value`；返回完整 configOptions，并发出 config_option_update | model-and-reasoning-options |
| session/request_permission | server request，必须按 server RPC id 回复 `result.outcome` | permission-* |
| session/cancel | **notification**，只发 sessionId；未知 id 是无操作；当前 prompt 返回 cancelled | cancel-concurrent-prompt-and-selection-snapshot |
| $/cancel_request | **notification**，params 是 `{requestId:<prompt RPC id>}`；不能写成 `{id:...}` | jsonrpc-cancel-request-and-sigterm |
| session/close | request；result `{}`；活动 prompt 返回 cancelled；随后该 active id 不接受 prompt | list-resume-workspace-validation-and-close-during-prompt |
| session/list | 接受 `cwd`；实测 active 不出现、close 后 inactive 出现 | 同上 |
| session/resume | `sessionId,cwd,mcpServers`；保留同 runtime id，返回配置；不重放历史 updates；cwd 不匹配拒绝 | close-eof-resume、sigkill-* |

**【源码 S1】** new 在返回前 flush，持久化空会话；P0 恢复录制使用已有 prompt 的会话，没有独立验证空会话重启恢复。list 只选 persisted、inactive、root、resumable sessions，并可按 cwd 过滤；P0 没有构造 subagent 或跨 workspace list。`authenticate` 是 no-op；它不验证 Key。

**【实测】** 同 session 同时只允许一个 prompt；第二个直接报错，上游没有替 Orbit 排队。运行中 set_config_option 对下一轮生效：当前 hold 请求保留 max，cancel 后下一轮使用 low。model 值目前外形为 JSON 字符串 provider/model 元组，必须作为 opaque token 传回，不能由显示名重新拼接。此版默认目录含 flash alias 与 pro；P3 从响应读取，禁止静态写死模型表。

**【实测】** reasoning 提供 off/low/high/max；medium 拒绝。选择 pro 实际请求 `model=deepseek-v4-pro`；off 是 `thinking.type=disabled`，其余为 enabled + `output_config.effort`。这是 mock 下请求参数证据，真实服务对模型/强度的可用性仍待验。

**【实测】** 正文 `agent_message_chunk` 与思考 `agent_thought_chunk` 都带 `messageId`。三个 provider text deltas 合并为一个 `alpha-beta-gamma` 消息块，思考和正文按块顺序到达。**【源码 S1】** ACP 由 committed assistant messages 投影，不转发原始 token/retry delta。P3 累加到当前轮并按块呈现，不能模拟逐 token 动画或声称实时 token streaming。

**【实测】** `tool_call`：`toolCallId,title,kind:'other',status:'in_progress',rawInput`；`tool_call_update`：相同 id，`status:'completed'/'failed'`，`content` 是 ACP 嵌套内容。file write 副作用和 failed read 都有可关联事件。权限请求 `toolCall` 只有 id，必须先按此前的 tool_call 找名称/参数；源代码在发权限请求前 drain updates。

**【实测 + 源码 S1】** `usage_update {used,size}` 是当前上下文占用；本 mock 得到 size=1,000,000，used 并非本次 API 输入/输出简单和。不带费用、cache 或详细 token 分项。**【约定】** P3 上报上下文使用；无更新保留 unknown，不填 0。ACP 模型目录没有 contextWindow 字段，catalog 的窗口初值保持 unknown，收到 usage.size 后由 runtime 动态补齐；不要添加 model id 静态窗口表。

## 5. 权限、错误和退出

**【实测】** `DSH_PERMISSION_MODE=read-only` 先拒绝原生 write；模型同轮使用 `sandbox_permissions:'workspace-write'` + justification 申请一次扩大权限。`allow-once` 才创建文件；reject 不创建且工具 failed；审批中 session/cancel 返回 cancelled、工具 failed、无文件；审批中 EOF 退出 0、无文件且客户端收不到 prompt response。后一种情况下不能由 exit 0 判成功，也不能等待永远不会来的工具终态。**【源码 S2】** base bundle 默认 workspace-write + ask；环境值参与 sandbox/approval composition，必须在进程启动前固定。

**【实测】** MCP 工具即使声明 destructive/readOnly annotations，默认也不发 ACP permission request，仍产生副作用。workspace 内 write 默认不问批准。**【源码 S6】** Harness 文件沙箱不限制 MCP 进程、网络或同 UID 读取凭据；read-only + ask 允许用户同意后扩大权限，并非不可写的绝对保证。

**【约定】** 首版只声明经 P4 复测的文件策略及单次扩大权限审批。不得把它翻译为「所有工具都先批准」。Plan、Ask every tool、Strict read-only、Accept Edits 或 arbitrary allowedTools 不得根据名称假设可强制；P4 若没有实际 guard/禁用 composition 及副作用证据，服务端必须拒绝这些选项。项目已有 P4 负责此项，不以文档替代其验收。

| 结果 | 实测证据 | Orbit 驱动约定 |
| --- | --- | --- |
| `result.stopReason=end_turn` | 普通文本、多轮；工具 failed 后模型可继续 end_turn | 本轮协议成功候选；保留工具失败，不抹掉错误 |
| `max_tokens` | max-tokens-is-not-success | 不记成功，标输出上限 |
| `cancelled` | cancel、审批 Stop、close 活动 prompt | 中断；只有一处结算 |
| response `error` | missing key；mock 401/429/500 均 `-32603`，保留错误文字 | 失败；协议没有稳定 HTTP status 分类字段，不能仅从 code 猜认证/限流 |
| `-32602` | invalid cwd/config value、不可恢复 id | 拒绝请求，不能记成功 |
| `-32601` | load/set_mode/set_model | 不支持，拒绝功能 |
| EOF/SIGTERM 0，无 prompt response | permission-disconnect / graceful shutdown | 活动轮不是成功；按主动停止/异常断开分类 |
| SIGKILL，无 response | sigkill-while-mcp-in-flight-and-durable-recovery | 失败或显式中断，未终态工具由 Orbit 结算；副作用可能已发生 |

**【实测】** 每次 mock 401/429/500 失败后，下轮仍可在同进程成功，没有旧错误污染后续轮。实验配置 `retryPolicy={mode:'normal',maxRetries:0}`，没有掩盖故障。**【源码 S7】** 默认 normal 最多五次 retry；`mode:'none'` 不合法。P0 未测尽默认 backoff 和全部配置错误类型，health 应同时核对 session/new 和 stderr 的 startup diagnostics。

**【实测】** SIGKILL 时 MCP 先记录一次副作用、没有 terminal update；同 `DSH_HOME` 重启 resume 成功，已完成前轮上下文仍在，未完成用户轮也进入下一轮上下文，合成 MCP 副作用计数仍为 1。**【约定】** 恢复不自动重发原 prompt 或 tool；需要向用户保留「副作用可能发生」状态。这个实验不证明真实模型在续聊时不会自行重试，不能宣称 exactly-once 副作用。

**【约定】** P3 每 session 一个常驻进程，单个 prompt slot，以 local turn id + RPC id 关联事件。Orbit 在发送前持久化已接受用户消息，busy 消息在 Orbit 排队。取消/租约丢失的本地事实优先于晚到的 end_turn；所有结算原子且只一次。prompt response 是正常 updates 的屏障；退出先到且无 response 则结算未终态工具并保留恢复 id，不凭片段正文判成功。后续 P3 必须用自身确定性测试验证竞争条件，P0 没有实现这些产品保证。

## 6. 持久化与平台前提

**【实测】** `two-process-homes-and-credentials-isolation` 同时保持两个 dsh 进程、不同 DSH_HOME/Key/state；请求 Key 正确、上下文未串、另一个 DSH_HOME 不能 resume 对方 id。实验两进程同时存活，prompts 顺序发送；同一时间模型请求并发属于后续 P2/P6 待验。

**【实测】** 专用 DSH_HOME 内产生：

| 路径 | 用途/观察 |
| --- | --- |
| `profiles/acp/package.json`, `pnpm-workspace.yaml`, `cordis.patch.yml`, `cordis.yml` | composition 元数据及空根 |
| `sessions/<workspace-key>/<uuid>/session.v4.jsonl.zstd`, `session.lock` | 压缩持久化事件及锁；日志实测 0600 |
| `storages/session_projcache/sessions/<uuid>.json` | 投影 cache，实测 0600 |
| `.anonymous-user-id` | 即使禁遥测仍生成 |
| `.credentials.yaml`, `.env`, Orbit patch | 仅配置场景主动写入；不存在的 Key 不由启动自动补入 |

**【源码 S2/S6】** attachment store、jobs/spill、账户授权或诊断可能增加目录，不能只搬 session 文件。**【约定】** 保留整棵 DSH_HOME，并持久化安装版本、profile/patch 哈希、canonical cwd 和 runtimeSessionId。不能把 Orbit session id 当 runtime id，不能换目录后静默 new 替代 resume。profile/cwd/version 不匹配要准确报修复状态。

| 平台 | 安装/运行前提 | 本次判定 |
| --- | --- | --- |
| Linux x64 | Node/npm；Bash；npm 平台 native optional dependencies；文件沙箱需可用 bwrap 或 Landlock | **【实测】** Node26 下 npm 安装及全部场景通过；bwrap 未安装，官方 Landlock binary probe=full，真 bash 可运行 |
| Linux arm64/其他内核/Node22、24 | 同类依赖；LSM/namespace/ABI 决定可执行及 enforcement | **【源码 + 待验】** 有 Linux arm64 native 包；未在这些组合运行，不宣称支持 |
| macOS arm64/x64 | Node/npm、Bash；Seatbelt `sandbox-exec`；对应 native 包与进程权限 | **【源码 + 待验】** 源码有 runner；没有 macOS 安装、沙箱或 ACP 实测，不宣称平台支持 |
| Windows | Node/npm；解析到 PowerShell（优先 pwsh，fallback 5.1）；ACL restricted-token runner、native 库和 NTFS 权限 | **【源码 + 待验】** 报 partial enforcement（含 hard-link、unconfined-read、AppContainer ACL 限制）；没有 Windows 实测，不宣称支持/同等边界 |

**【源码】** 仓库 Node requirement 为 `^22.19.0 || >=24.0.0`；P2 以固定发行版和实测组合做准入。**【实测】** npm11 提示 node-pty/koffi 等安装脚本未批准，本机现有 prebuilt 仍通过这些 ACP/非 PTY 场景；这不证明其他平台可跳过 postinstall。**【源码 S6】** 缺失 native、runner 或不可用 LSM 应 fail closed `SANDBOX_UNAVAILABLE`，不能自动切 danger-full-access。**【待验】** 缺沙箱故障注入、partial enforcement 产品阻断，以及 PTY/外部原生命令完整生命周期。

## 7. ACP、SDK 和首版能力差异

SDK 以下来自固定源码 S8，**未在本次执行 SDK**。不能将 SDK 能力移植宣称为 ACP 支持。

| 能力 | ACP（本契约） | SDK 源码结论/首版决定 |
| --- | --- | --- |
| 接受 prompt/结算 | response 等当前工作 idle 及 updates，单 prompt slot【实测】 | SDK prompt 立即给 durable `messageId`，run wrapper 收集 whole-agent idle；不相同 |
| 数据面 | 标准 committed 正文/思考、generic 工具、上下文、配置【实测】 | SDK `session.event/status`、subagent lineage；不是 ACP session/update |
| 模型/强度 | configOptions、set_config_option【实测】 | SDK initialize 传 provider/model/reasoningEffort/maxTokens；不使用此方式驱动 ACP |
| 恢复 | list inactive/resume/close，不回放历史【实测】 | SDK 会话事件/handle 的恢复语义需另验，不借用 |
| shutdown | close session，进程靠 EOF/SIGTERM【实测】 | SDK `shutdown` 释放 root 后退出；ACP 不发送 SDK shutdown |
| UI/完整实时交互 | load/set_mode/set_model 为 -32601【实测】；bridge 仅提供一次审批等自动化接口【源码 S1】 | Web/plugin UI 不等于 SDK stdio 或 ACP；首版不接原生登录、逐 token、提问卡片、计划模式【约定】 |

**【待验】** 真实 DeepSeek API、真实 Orbit MCP 授权/工具守卫、图片、所有客户端、真实设备/跨平台、lease loss/race/崩溃子进程清理。当前仅原生文件/简单 bash/MCP 合成副作用和上列故障受录制支持。fork/delete/历史导入、additional directories 不进入首版。SDK 默认 stdio 也不能仅凭名称认定有逐 token 或 UI 卡片。

## 8. P2 与 P3 的最小接口约定

以下为 **【约定】**，尚未实现。P2 不驱动会话状态机；P3 可以先用 mock LaunchSpec，P2 可以用 P0 脚本验隔离，不等待产品适配器。

```go
// P2 输入：Orbit 已授权的配置，凭据只在既有派发链解密。
type DshLaunchInput struct {
    OrbitSessionID string
    ExecutionDir   string // 必须保留/核对 canonical cwd
    APIKey         string // 不写日志，不改真实 HOME
    BaseURL        string
    FileMode       string // 仅已声明可执行的模式；未知即拒绝
}

// P2 输出：P3 不自行选择版本、目录或从 ambient env 猜凭据。
type DshLaunchSpec struct {
    Executable string            // 不可变的固定版本绝对路径
    Args       []string          // --profile acp --patch <absolute file>
    Env        []string          // 白名单 env，真实 HOME，独立 DSH_HOME
    Cwd        string
    DshHome    string            // 持久路径，重启保持同一个
    Version    string            // 0.2.0-rc.2
    ConfigHash string            // profile/patch/bridge 版本的摘要
}
```

**【约定】** P2 `Prepare(input)` → LaunchSpec；`Health` → 安装版本/平台可用性、credentialPresent、requestValidation 独立状态、沙箱 enforcement 及诊断。无 Key 不借 ambient Key；目录冲突/版本不符不静默覆盖。P4 产生系统提示 bridge 和 MCP/工具 policy 配置，接入同一 overlay；本接口不预先扩成通用插件框架。

**【约定】** P3 `Start(spec)` → 进程与 initialize；`Open(runtimeId?, cwd, mcpServers)` → new 或 resume + opaque configOptions；`Configure(configId,value)`；`Prompt(localTurnId,content)`；`RespondPermission(serverRpcId,outcome)`；`Cancel()`；`Close()`（session）、`Dispose()`（进程）。单 reader、串行 writer、pending RPC map、一个 prompt slot；new/resume 失败即报错，不互相兜底。

**【约定】** P3 事件最小集为 TextBlock、ThoughtBlock、ToolStarted/ToolSettled、PermissionRequested、ConfigChanged、ContextUsage、TurnSettled、ProcessExited。每个事件保留 runtimeSessionId/localTurnId 和必要 wire id，工具 name/args 保存到 permission lookup。Open 后立即保存真实 runtimeSessionId，变更模型只用 live configOptions，恢复显示历史由 Orbit 自有 transcript 提供。允许 response settlement 之后才 dequeue 下一条用户消息；异常退出后先结算再由明确恢复流程重启。

**【约定】** session/request_permission 回复形状：

```json
{"jsonrpc":"2.0","id":"<server-request-id>","result":{"outcome":{"outcome":"selected","optionId":"allow-once"}}}
```

拒绝选 `reject-once`；撤回可用 `{outcome:'cancelled'}`。不能未知 option 默认放行。EOF/transport loss 时撤回 Orbit 审批卡、结算活动工具；迟到答案不能产生副作用。P3/P4 验收仍需覆盖去重、late response、租约丢失和真实 Orbit 工具限制。

## 9. P0 结论与证据边界

**【验收关联】** P0 服务项目第 10 条独立协议契约判据（key：`4olcMXhwL9a4aMVWOaguKB`），原文：「固定版本 DeepSeek Harness 的 ACP 核心协议、配置与持久化行为已有可复现的真 CLI 实验证据，形成供原生接入实现使用的运行时契约。」原第 1 条完整产品入口和 runner 链路继续由 P3a 及最终验收证明。

**【实测时间】** 本契约所引 24 场景、739 行录制来自 2026-10-04T06:53:55.386Z 开始的原始成功实验（时间取 summary.startedAt）。本次判据关联同步复用该实验、录制和原始成功检查，没有新增真 CLI 执行。

**【实测】** 核心 ACP 路径成立，固定版本可重复：24 个场景全部通过，提供安装锁、可执行复现、双向脱敏录制与结果索引。系统提示与 MCP 的最小注入方法已验证，P2/P3 可按上述接口分别开始。

**【明确缺口】** 上游广告与真实边界存在差异：SSE entry 静默消失；MCP annotations 不构成 approval gate；exit 0 不保证活动轮完成；ACP contextWindow 目录缺字段；crash 可能已产生未结算副作用。P1/P3/P4 必须按上文降级或拒绝能力，不能照 SDK/Web UI 文档扩大声明。

**【待验】** 真实授权 Key/模型、macOS、Windows、Linux其他组合、HTTP MCP、完整技能与严工具策略、P3 races/lease loss/真实子进程清理、Web/macOS/iOS 产品链由项目既有任务验收。P0 通过不代表项目第一条「通过新增入口创建的任务」已在产品满足，也不解锁部署/发布；本次完成声明限于第 10 条独立协议契约判据。

## 10. 固定源码定位

全部链接固定在同一发行标签，源码判断不依赖 master。

- **S1 ACP**：[index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/acp/acp/src/index.ts)、[session.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/acp/acp/src/session.ts)、[updates.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/acp/acp/src/updates.ts)、[codec.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/acp/acp/src/codec.ts)。
- **S2 启动 composition**：[profile-boot.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/apps/cli/src/profile-boot.ts)、[base bundle](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/bundle/base/cordis.patch.yml)、[acp bundle](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/bundle/acp-app/cordis.patch.yml)。
- **S3 凭据/模型**：[credentials-local](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/credentials/credentials-local/src/index.ts)、[API Key adapter](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/llm/llm-deepseek-api-key/src/index.ts)、[config](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/llm/llm-deepseek/src/config.ts)。
- **S4 指令**：[system-prompt](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/core/system-prompt/src/index.ts)、[agent-instructions](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/context/agent-instructions/src/index.ts)、[plugin-package-inventory-deepseek](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/llm/plugin-package-inventory-deepseek/src/index.ts)。
- **S5 MCP**：[ACP mcp.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/acp/acp/src/mcp.ts)；SDK 入站跳过无效 vector entry 的实现同时包含在锁定的 `@agentclientprotocol/sdk@1.4.0/dist/schema-deserialize.js` 中。
- **S6 权限/沙箱**：[user-approval](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/interaction/user-approval/src/index.ts)、[sandbox-local](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/sandbox/sandbox-local/README.md)、[bash-sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/shell/bash-sandbox/README.md)、[pwsh-local](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/shell/pwsh-local/README.md)。平台前提核对同时读取锁定的同版本 npm 包 README；本地 partial checkout 未物化部分 README，不把缺少工作树文件当上游文件不存在。
- **S7 Retry**：[retry-policy.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/llm/llm/src/retry-policy.ts)，同时核对固定发行包 `@deepseek-ai/dsh-llm/lib/index.js` 的 `RetryPolicySchema/resolveRetryPolicy`；实验明确 maxRetries=0。
- **S8 SDK**：[protocol](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/sdk/protocol/README.md)、[client](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/sdk/client/README.md)、[server](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/sdk/server/README.md)。
