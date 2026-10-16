# Cursor CLI（`agent acp`）运行时契约（P0a，Linux）

**状态**：项目「Cursor CLI 原生接入」（`34gyHIZv301nDWxKP9XkO`）P0a 的产物。P0b（macOS）、T0、P1–P6 按这份文件实现。
改这里的任何一条结论，要同时改依赖它的任务。已定的设计（作业指导里的所有者决定）不在这里重新论证。

**实测版本**：**Cursor CLI `2026.10.14-941492e`**，linux/x64，HPC（内核 `6.12.107+deb13-amd64`，24 核，root）。
- tarball：`https://downloads.cursor.com/lab/2026.10.14-941492e/linux/x64/agent-cli-package.tar.gz`，183,861,376 字节，
  SHA-256 `6f6bf39dd2df29dcd38643cdfab0155ce71699953889f732deec123f6562bb2d`。
- 2026-10-17 再取 `https://cursor.com/install`，脚本仍指向这个版本，没有更新的构建。**后续任务都固定用它。**
- 解包后 458 个文件，586,293,819 字节。`index.js` SHA-256 `27776c58…2113482`，启动脚本 `cursor-agent` SHA-256 `2ccc9a8e…a233`，
  自带 `node` SHA-256 `e0e46d3a…62a4`。全部文件哈希见 `/mnt/data/cursor-p0/dl/2026.10.14-941492e/files.sha256`。

**方法**：
- 真 CLI 加所有者的 Cursor User API Key，跑脚本 [`scripts/cursor-p0/reproduce.mjs`](../scripts/cursor-p0/reproduce.mjs)，结果在
  [`docs/evidence/cursor-cli/2026.10.14-941492e/`](evidence/cursor-cli/2026.10.14-941492e/)。
- 每个场景一个 `scenarios/<名>.json`（断言和数据）和一个 `protocol/<名>.ndjson`（双向 JSON-RPC 录制，已脱敏）。下文 `` `场景名` `` 指这些文件。
  回放样本在 [`src/runner-go/testdata/cursor/`](../src/runner-go/testdata/cursor/)。
- 所有 CLI 进程都用白名单环境和隔离目录（HOME、CURSOR_CONFIG_DIR、CURSOR_DATA_DIR、XDG_* 都指向 `/mnt/data/cursor-p0/runs/<runId>/<场景>/slots/<槽>/`）。
  每个场景前后核对 runner 用户真实的 `~/.cursor`、`~/.config/cursor`、`~/.local/share/cursor-agent`：起步不存在，结束仍不存在。
- 源码结论出自固定版本的打包文件，写成 `文件@字节偏移`。缩写：I = `index.js`，A = `6136.index.js`（ACP agent），
  S = `8096.index.js`（内置 `@agentclientprotocol/sdk` 0.14.1），P = `1623.index.js`，Q = `2496.index.js`，C = `7000.index.js`（只有对话模式加载），
  H = `190.index.js`（hooks）。
- 官方文档：<https://cursor.com/docs/cli/acp>、`/docs/cli/reference/{permissions,authentication,configuration}`（2026-10-17 读取）。

**标签**：【实测】本任务用固定版本真 CLI 测到；【源码】读打包文件得出，没运行验证；【文档】官方文档这么写；
【待验】没能验证（原因写在条目里），实现时不得当作已支持。

**真实 prompt**：一共 **20 次**，全部 Auto 模型（`default[]`），明细见 [`prompts-ledger.json`](evidence/cursor-cli/2026.10.14-941492e/prompts-ledger.json)。
第 20 次碰到所有者 Free 套餐的免费请求上限（§12、[事故记录](evidence/cursor-cli/2026.10.14-941492e/incidents/quota-exhausted/README.md)），
账期 2026-10-24 结束前这把 key 发不出能执行的 prompt。所以仓库配置的运行期效果、轮中断网、SHELL 包装隔离、远程登录续聊这几项**没做成**，标【待验】。

---

## 0. 一句话结论

1. **驱动**：每个 Orbit 会话一个常驻进程 `<固定版本>/cursor-agent acp`，stdio 上每行一条 JSON-RPC 2.0，stdout 只有协议行（§2）。
   **模型选择是进程级全局的**（改一个会话的模型，同进程所有会话一起变），所以虽然一个进程能同时跑多个会话的 prompt，也不要共用进程（§3.1）。
2. **凭据不经 `authenticate`**：进程环境里有 `CURSOR_API_KEY`（或 `--api-key`）、`CURSOR_AUTH_TOKEN`（或 `--auth-token`）、或已存的登录，`session/new` 直接成功。
   `authenticate(cursor_login)` 在无浏览器时立刻返回带登录链接的 `-32602`，不轮询，那个链接永远完成不了这次认证（§2.3）。
3. **退出**：stdin EOF **不会**让进程退出，进行中的一轮照常跑完。结束进程用 SIGTERM（退出码 143）或 SIGINT（130）。
   SIGKILL 后，它启动的 shell 命令成为孤儿继续运行，runner 必须自己杀掉整个进程树（§3.4）。
4. **一轮**：`session/prompt` 的结果只有 `stopReason`，只会是 `end_turn` 或 `cancelled`，**不带 usage**。
   轮中再发 `session/prompt` 会把当前轮在 6 ms 内以 `cancelled` 结束，再执行新的一条。所以 Orbit 必须自己排队，不发第二条（§3.2）。
   `session/cancel` 4 ms 内得到 `cancelled`，shell 子进程被杀，但**工具卡停在 `in_progress`，不会再有终态更新**（§3.3）。
5. **运行期错误不是 JSON-RPC 错误**：额度用尽、模型提供方拒答、轮中认证失效，都只是一条 `agent_message_chunk` 文本加 `end_turn`。
   分类只能靠文本，事故样本见 §12。建会话失败时，无效 key 和断网是同一个 `-32603 "Failed to initialize session services"`，
   要用 `agent models` 的退出信息区分（§12）。
6. **恢复**：会话库在 `<CURSOR_CONFIG_DIR>/acp-sessions/<id>/`（`store.db` + `meta.json`），第一次 prompt 时才建 `store.db`。
   `session/load` 先把整段历史作为 `session/update` 重放（`user_message_chunk`、合并后的正文和思考、`replay-<轮>-<步>` 工具卡），再返回结果。
   这个目录拷到另一个 CURSOR_CONFIG_DIR/HOME 后能 load 并带上下文续聊。崩溃时没完成的工具不重放，下一轮 CLI 会给它补一条
   "interrupted" 错误结果（§3.5）。
7. **权限**（§5）：
   - 默认白名单下，读文件、工作区内写文件**不问**；不在白名单的 shell（默认只有 `Shell(ls)`）、MCP 调用、web fetch **问**。
   - 选项是 `allow-once` / `allow-always` / `reject-once`。`allow-always` 写进**用户** `cli-config.json` 的 `permissions.allow`。
   - `--force`：全部不问。`--auto-review`：ACP 上无效，等于默认。
   - **plan 和 ask 模式都不是只读**：plan 挡住了写文件，但 shell 和 MCP 照常走权限请求；ask 写文件连问都不问。
8. **MCP**（§6）：
   - `session/new` 的 `mcpServers` 注入 stdio 服务器，不需要批准。工具经 `CallDynamicTool` 以「服务器名」命名空间出现，每次调用都问权限。
     ACP 上只看得到 `rawOutput: {success:true}`，看不到结果内容。`orbit mcp` 实测可用。
   - **`$HOME/.cursor/mcp.json` 里的服务器在 `session/new` 时就被拉起**，不需批准。仓库 `.cursor/mcp.json` 不经 `agent mcp enable` 不加载，
     `--approve-mcps` 在 ACP 上无效。
9. **目录与凭据**（§8）：
   - CURSOR_CONFIG_DIR 放配置、会话库、allow-always 规则、statsig 缓存；CURSOR_DATA_DIR 放 `projects/<slug>/`。
   - Linux 上 XDG_CONFIG_HOME 决定 `auth.json`；没设 CURSOR_CONFIG_DIR 时，也决定配置目录。
   - **只有 HOME 能移走** `agent-cli-state.json`、内置技能同步目录 `skills-cursor/`、AI 代码追踪库，以及对用户级 `mcp.json`、hooks、rules 的读取。
   - TMPDIR 决定调试日志和 worker socket。
   - `AGENT_CLI_CREDENTIAL_STORE=file`（Linux 默认）会把 **API key 本身**连同 access/refresh token 写进 `auth.json`；`memory` 不落盘。
10. **agent 跑的命令继承 CLI 的全部环境**，包括 `CURSOR_API_KEY`、`CURSOR_AUTH_TOKEN`、HOME、XDG_*、CURSOR_*，外加 `CURSOR_AGENT=1` 等。
    没有「只换 CLI、不换命令」的开关。D4 的事实和候选方案见 §8.4。
11. **登录**（§9）：`NO_OPEN_BROWSER=1 agent login` 立刻打印 `https://cursor.com/loginDeepControl?challenge=…&uuid=…&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true`，
    约 27 分钟后放弃，输出 "Login failed or timed out. Please try again."，退出码 1。`status` 只看已存的 token，API key 不算登录。`logout` 只删本地。
    在另一台设备上完成登录【待验】：所有者没有操作。
12. **模型**（§10）：
    - ACP 的 `model` 选项值是带参数的变体串，如 `gpt-5.5[context=272k,reasoning=medium,fast=false]`；Auto 是 `default[]`。
      未列出的变体和 `auto` 别名都返回 `-32602`。
    - 客户端声明 `_meta.parameterizedModelPicker` 后，变成「模型名 + effort/context/fast 独立选项」。
    - Auto 实际路由到哪个模型，只在会话库里看得到。
13. **额度**（§11）：
    - 用 API key 换来的 access token 调 `aiserver.v1.DashboardService`（Connect JSON），能读 `GetCurrentPeriodUsage`、`GetPlanInfo`、`GetHardLimit` 等。
      原始 API key 不能当 bearer。
    - **Free 套餐的请求上限不在这些接口里**：用尽时 `GetCurrentPeriodUsage` 仍显示 0%。
14. **外连**（§14）：
    - api2.cursor.sh：全部 RPC。agentn.global.api5.cursor.sh：agent 流，地址由服务端下发。
    - registry.npmjs.org：worker 跑 `npx -y typescript-language-server`，条件见 §14.3。repo42.cursor.sh：索引上传，只在隐私模式 4 时发生。
    - `NODE_USE_ENV_PROXY=1` 加 `HTTPS_PROXY` 后，所有连接都走代理。**ACP 路径没有自动更新检查。**
15. **隐藏的 agent-cli-local / `--authless`** 不能当测试替身：只有另行分发的 agent-cli-local 构建能开，ACP 不走它（§15）。

---

## 1. 版本、安装与升级（覆盖要求 12）

### 1.1 结论

- **固定安装**【实测 `install-and-version`】：
  - 两种装法都能得到同样的文件：校验 SHA-256 后解包官方 tarball（脚本 README 的做法），或用 CLI 自己的隐藏命令 `agent install <版本> [urlPrefix]`。
  - `install` 把文件放进 `$HOME/.local/share/cursor-agent/versions/<版本>/`，并把 `$HOME/.local/bin/agent` 软链过去；`index.js` 和 tarball 中的逐字节相同。
  - 默认 URL 前缀是 `https://anysphere-binaries.s3.amazonaws.com/lab/<版本>`【源码 I@1740744】。从 HPC 下载只有约 170 KB/s，600 s 超时没装完。
    前缀改成 `https://downloads.cursor.com/lab/<版本>` 后 5.8 s 装完。
  - **P3 的建议**：runner 自己下载 tarball、校验固定哈希、解包到不可变的版本目录，再用绝对路径启动 `<目录>/cursor-agent acp`。
    不要依赖 `~/.local/bin/agent`，也不要依赖 CLI 的安装器：它还会建 `~/.local/bin/cursor` 包装脚本、清理旧版本，只保留当前和最新两个【源码 2761@1877、2761@5637】。
    清理由一个脱离父进程的 `cursor-agent … cleanup-install-versions <版本>` 子进程完成：`install` 退出 40 分钟后它仍在运行（父进程是 init）【实测：两次 `install-and-version` 运行各留下一个，事后手工结束】。
- **包内容**【实测】：
  - `cursor-agent` 是 bash 启动脚本，执行同目录的 `node`（Node v24.5.0）加 `index.js`。
  - 只要 `AGENT_CLI_CREDENTIAL_STORE` 不是 `file`，就加 `--use-system-ca`【源码 cursor-agent@781】。也就是说，file 存储模式**不用系统 CA**，
    走 TLS 检查代理时要靠 `NODE_EXTRA_CA_CERTS`【文档 configuration】。
  - 包里还有 `rg`、`cursorsandbox`、`crepectl`、SQLite 和 tree-sitter 原生模块、`cursor-agent-sea` 和 `cursor-agent-worker-sea`。
- **ACP 路径不做自动更新**：
  - 【实测 `startup-processes-and-network`】启动和 `session/new` 期间的全部 RPC 里没有 `GetCliDownloadUrl`，也没连下载主机。
  - 【源码】更新代码只在对话模式的分块里（C@712900：启动 2 s 后用不阻塞的定时器检查），ACP 加载的分块里没有。
  - 所以 `--disable-auto-update` 对 ACP 无意义；它也没有环境变量版本【源码 I@1688490】。
- **channel**【源码 I@3735688 + 文档】：
  - `cli-config.json` 的 `channel` 可取 `static|prod|lab|prod-stable-internal`，默认 `prod`。`static` 跳过更新检查【源码 903@9267】。
  - `AGENT_CLI_UPDATE_CHECK_URL` 可以替换更新查询地址【源码 903@6257】。
  - P3 若担心以后的版本把更新带进 ACP，可以在账号配置里写 `"channel":"static"`，这一点【待验】。
- **版本核对**【实测】：`agent --version` 输出 `2026.10.14-941492e`。`initialize` 不带 `agentInfo`（§2.2），**版本只能从 `--version` 或安装目录得到**。
  `agent about --format json` 联网给出 `latestVersion` 和 `latestStatus`（本次是 `up_to_date`）。

### 1.2 安装体积

tarball 183.9 MB，解包 586 MB。每个账号或会话目录都不需要再拷一份 CLI：CLI 只读自己的安装目录（实测安装目录设为只读后，全部场景照常运行）。

---

## 2. 启动与握手（覆盖要求 1）

### 2.1 启动

- **命令**【实测】：`<固定版本目录>/cursor-agent acp [选项]`，cwd 为会话 checkout。`acp` 不在 `--help` 里，但 `agent acp --help` 可用。
- **stdout 只有协议行**【实测：所有场景 `stdout/non-protocol` 计数为 0】。stderr 正常为空。
  CLI 另写一份调试日志到 `$TMPDIR/cursor-agent-logs-<uid>/`（§8.2），里面没有 key 和 token【实测 `debug-log-location`】。
- **ACP 路径认的选项**：
  - 【实测】`--force`、`--model`、`--api-key`、`--auth-token`、`--disable-indexing`、`--disable-codebase-ref`。
  - `--disable-project-configs`：【实测】它不影响启动时的 MCP 和 hooks；对 cli.json 的运行期效果【待验】。
  - 【源码】`-e/--endpoint`（`CURSOR_API_ENDPOINT`）、`--website-url`、`--agent-endpoint`、`-k`、`--debug`、`--workspace`【A@53243、A@82879、I@1691193】。
- **ACP 路径不认的选项**：
  - 【实测】`--auto-review`（§5）、`--approve-mcps`（§6）。
  - 【源码】`--yolo`、`--mode`/`--plan`、`-H`、`--sandbox`、`--disable-auto-update`、`--exclude-workspace-context`（不传给 ACP 的请求）【A 中零引用】。
    `--exclude-workspace-context` 的实际效果【待验】。
- **`--model` 的两种结果**【实测 `failure-shapes-without-prompt`】：
  - 未知模型：第一次 `session/new` 时进程直接 exit 1，stderr 列出可用模型名，`session/new` 收不到回复。
  - 旧式名（如 `gpt-5.5`）：解析成带参数的变体。
  - **Orbit 不要用 `--model`**，改用 `session/set_config_option`，失败时只拿到一个错误，进程不退。
- **项目 `.cursor/cli.json` 无效时，进程在回复 `initialize` 前 exit 1**【实测】，stderr 为 `Invalid project config at …: schema validation failed`。
  合法的 cli.json 只能有 `permissions`，而且 `allow`、`deny` 两个数组都得有【源码 I@3735328、I@3726634】。
  仓库能用一个坏文件让 Cursor 会话起不来，P5c 要么带 `--disable-project-configs`，要么先校验。
- **`session/new` 冷启动 8–11 s**【实测：8.0–11.1 s】，其间 CLI 调约十个 RPC（§14.1），之后还会拉起 worker 子进程（§14.3）。

### 2.2 `initialize`【实测 `signed-out-handshake`、`parameterized-model-picker`】

```jsonc
// 请求（建议形状）
{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,
 "_meta":{"subagents":true,"parameterizedModelPicker":true}},"clientInfo":{"name":"orbit","version":"<runner version>"}}
// 回复
{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"mcpCapabilities":{"http":true,"sse":true},
 "promptCapabilities":{"audio":false,"embeddedContext":false,"image":true},"sessionCapabilities":{"list":{},"subagents":{}}},
 "authMethods":[{"id":"cursor_login","name":"Cursor Login","description":"Authenticate using existing Cursor login credentials. Run 'agent login' first if not logged in."}]}
```

- 未登录也能 `initialize`。`protocolVersion` 恒为 1，不比较客户端的版本【源码 S@6057507】。
- **没有 `agentInfo`**。`sessionCapabilities.subagents` 只在客户端声明 `_meta.subagents`（或 `subagents`）时出现。
- `clientInfo` 会作为 `x-cursor-host-app-name` / `-version` 请求头发给 Cursor【源码 A@82138】。
- 客户端 fs 和 terminal 能力从不被调用【源码：A 中零引用】：CLI 自己读写文件、自己跑命令。

### 2.3 认证

| 状态 | `session/new`、`session/list` | 来源 |
| --- | --- | --- |
| 没有任何凭据 | `-32000 "Authentication required"`，`data.message`：`Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'.` | 【实测】 |
| 环境有 `CURSOR_API_KEY` 或参数 `--api-key` | 直接成功，不需要 `authenticate` | 【实测】 |
| `CURSOR_AUTH_TOKEN` 或 `--auth-token`（memory 存储） | 直接成功，什么都不落盘 | 【实测 `credential-stores`】 |
| key 无效 | `session/new` → `-32603`，`data.message` `Failed to initialize session services`；`session/list` 照常返回 `{"sessions":[]}` | 【实测】 |

- `authenticate {"methodId":"cursor_login"}`：设了 `NO_OPEN_BROWSER` 时，**立刻**返回
  `-32602`，`data.message` 为 `Failed to open browser for login. Please visit: https://cursor.com/loginDeepControl?…`【实测】。
  它不轮询，PKCE verifier 随即丢弃，有人打开这个链接也完成不了这次认证【源码 I@2221969、A@43767】。未知 methodId 也是 `-32602`。
  **runner 不用 ACP 的 `authenticate` 登录**，登录走独立的 `agent login` 进程（§9）。
- 有 browser 时 `authenticate` 会阻塞，最多轮询 150 次【源码 I@3716183】。runner 不走这条路。

---

## 3. 会话与轮次（覆盖要求 1）

### 3.1 方法一览【实测 `api-key-session-management`，另注明的除外】

| 方法 | 参数 | 结果 / 错误 |
| --- | --- | --- |
| `session/new` | `cwd`（绝对路径）、`mcpServers`（必填数组） | `{sessionId, modes, models, configOptions}`。缺 `mcpServers` 时返回 `-32603`，`data` 是 zod 问题数组。cwd 不存在也成功 |
| `session/load` | `sessionId, cwd, mcpServers` | 先重放历史，再返回 `{modes, models, configOptions}`（不含 sessionId）。没有 `store.db`（从没发过 prompt）或 id 不存在：`-32602 Session "<id>" not found` |
| `session/list` | 可选 `cwd`（必须绝对） | `{sessions:[{sessionId, cwd, title?, updatedAt}]}`，按 cwd 过滤。带 `cursor` 或用相对 cwd：`-32602`。**未发过 prompt 的会话也列出**，title 在第一轮后才有 |
| `session/prompt` | `sessionId, prompt:[{type:"text",text}]` | `{stopReason:"end_turn"\|"cancelled"}`，没有别的字段。未知会话：`-32603`，`data.details` `Session <id> not found` |
| `session/cancel` | 通知，`{sessionId}` | 当前 prompt 以 `cancelled` 返回。未知会话静默忽略 |
| `session/set_mode` | `sessionId, modeId` | `{}`，同时发 `current_mode_update`。未知模式：`-32603`，`data.details` `Invalid mode ID: … Valid modes: agent, plan, ask` |
| `session/set_config_option` | `sessionId, configId, value` | `{configOptions}`。非法值：`-32602 Invalid model value / Invalid mode value / Invalid value for <id> / Unknown config option` |
| `session/set_model` | `sessionId, modelId` | `{}`（转成 `model` 配置项） |
| `cursor/list_available_models` | `{}` | 扩展方法，`{models:[{value, name, configOptions}]}`（§10） |
| `session/close`、`session/resume`、`session/fork` | — | `-32601 "Method not found": <method>` |

- **一个进程可以有多个会话，也可以同时跑多个会话的 prompt**【实测 `plan-and-ask-modes-concurrent`：两个会话并发 prompt，各自 `end_turn`，更新按 `sessionId` 分开】。
- **模型选择是进程级全局的**【实测：会话 A 改模型后，会话 B 和之后新建的会话 C 都是这个模型；源码 A@40054】，而且会写进 `cli-config.json`
  的 `selectedModel`【源码 P@45513】。**P5a：每个 Orbit 会话一个进程**，模型只在本进程内设置。
- `available_commands_update` 在 `session/new` / `session/load` 之后由定时器发出（实测约 3 s 后），不用等 prompt。

### 3.2 一轮的语义【实测 `multi-turn-tools-default`、`prompt-while-busy`】

- 一轮的通知顺序：`session_info_update`（第一轮自动起名，约 1.5 s 时）→ `available_commands_update` → 大量 `agent_thought_chunk` / `agent_message_chunk`
  （逐 token 流式，没有 messageId）→ 工具卡更新 → 最后 `session/prompt` 的回复。
- **`session_info_update` 可能在 prompt 回复之后才到**【实测 `background-shell-and-commit`：回复后 1.2 s；源码 A@10254 不等待】。
  `available_commands_update` 也会在回复后到。它们都不是新的一轮。
- **轮中再发 prompt**：A 正在跑 `sleep 43`，发出 B。A 在 6 ms 内返回 `{"stopReason":"cancelled"}`，A 的 shell 子进程被杀；
  B 正常执行，1.9 s 后 `end_turn`。CLI 不替客户端排队。**P5b：轮中消息由 Orbit 排队，当前轮结算后再发**（与项目范围「不支持轮中插话」一致）。
- 第二轮记得第一轮【实测：第二轮正确复述第一轮读到的暗号】。
- **后台命令**：源码说后台 shell 和子代理的跟进步骤在同一个 prompt 请求里跑完，prompt 返回后不会自己开新的一轮【源码 A@15706、A@23155】。
  这一点【待验】：该场景撞上额度用尽，没跑成。

### 3.3 取消【实测 `cancel-mid-tool`】

- 在 `sleep 47` 运行中发 `session/cancel`，4 ms 后得到 `{"stopReason":"cancelled"}`，sleep 进程被杀，文件没写出。
- **被取消的工具卡停在 `pending → in_progress`，之后再没有 `tool_call_update`**。ACP 这里根本没有 `failed` 状态【源码 A@77469】。
  **P5b：取消、断开、崩溃后，Orbit 自己结算所有未终态的工具卡。**
- 审批进行中（权限请求未答）时取消的行为【待验】。源码：权限请求没有超时（S@6078003），取消会让等待的请求以 "Cancelled" 拒绝（A@56902）。

### 3.4 进程生命周期【实测 `process-signals`、`signed-out-handshake`、`crash-recover-and-move`】

| 动作 | 结果 |
| --- | --- |
| 关闭 stdin（空闲） | 30 s 后仍在运行 |
| 关闭 stdin（轮中） | 8 s 后仍在跑这一轮，进程不退 |
| SIGINT | 退出码 130 |
| SIGTERM | 退出码 143（自己处理后 `process.exit`，不是被信号杀） |
| SIGHUP | 被信号杀（`signal: SIGHUP`） |
| SIGKILL（轮中） | 永远收不到 prompt 回复；**它跑的 `sleep 31` 仍在运行，成了孤儿** |

- **P5b**：
  - 结束会话进程用 SIGTERM，等它退出；超时再 SIGKILL。
  - 不要依赖关闭 stdin。
  - 杀进程后，按进程组或 cgroup 清理 CLI 启动的命令。CLI 跑命令用 detached 进程组【源码 I@7388762】，**单杀 CLI 的进程组也清不干净**，要按会话作用域清（例如每会话一个 systemd scope）。
- 团队切换（§13.2）后 CLI 会自己 exit 0。

### 3.5 恢复与重放【实测 `multi-turn-tools-default`、`crash-recover-and-move`、`crash-continue-and-shell-wrapper`】

- **会话库**：`<CURSOR_CONFIG_DIR>/acp-sessions/<sessionId>/` 下有：
  - `meta.json`：`{"schemaVersion":1,"cwd":…,"title":…}`
  - `store.db`（SQLite，WAL 模式），表 `blobs(id, data)` 和 `meta(key, value)`。`meta` 的值是十六进制 JSON
    `{agentId, latestRootBlobId, name, mode, isRunEverything, createdAt, blobEncryptionKey}`。
  - JSON blob 是系统提示、用户上下文、assistant/tool 消息；二进制 blob 用库里自带的 `blobEncryptionKey` 加密。
  - `store.db` 在第一次发 prompt 时才建，所以**没说过话的会话不能 `session/load`**（`-32602 not found`），但能出现在 `session/list` 里。
- **重放的形状**（新进程里 `session/load`）：
  - 每轮依次是 `user_message_chunk`（整段用户消息）、合并后的 `agent_thought_chunk` / `agent_message_chunk`、
    `tool_call`（`toolCallId` 为 `replay-<轮>-<步>`，`status:"pending"`）、`tool_call_update`（`completed`，带 rawOutput 或 diff）。
  - 全部重放完，才回 `session/load` 的结果；之后再来 `available_commands_update`。
  - **重放用的 id 和直播时的 id 不同**，Orbit 用自己的 transcript 显示历史，重放只用来核对，不能再写一遍。
- **崩溃后**：
  - 中断的那一轮只重放 user 消息和已提交的那段思考、正文；**进行中的工具调用不重放**。
  - 下一轮发出时，CLI 给那个调用补一条工具结果：`"Error: Shell command was interrupted before it completed. It may still be running."`（`isError: true`），
    见 [`analysis/crash-recover-and-move.json`](evidence/cursor-cli/2026.10.14-941492e/analysis/crash-recover-and-move.json)。
- **搬运**：把 `acp-sessions/<id>/` 整个拷到另一个 CURSOR_CONFIG_DIR、换一个 HOME，同一把 key 下能 load【实测两次】。
  其中一次的续聊准确复述了崩溃前那一轮的命令；另一次的续聊 prompt 被模型提供方拒答（§12），没能检查上下文。库里自带加密密钥，不依赖原目录的其他文件。
- 会话的 `cwd` 记在 `meta.json` 和库里。用别的 cwd load 的行为【待验】，Orbit 应保证 load 时 cwd 不变。

---

## 4. 事件（覆盖要求 2）

### 4.1 `session/update` 的种类【实测，另注明的除外】

| `sessionUpdate` | 字段 | 说明 |
| --- | --- | --- |
| `agent_message_chunk` | `content:{type:"text",text}` | 逐 token 流式，没有 messageId。**错误也走这里**（§12） |
| `agent_thought_chunk` | 同上 | 思考流式；条数通常多于正文 |
| `user_message_chunk` | 同上 | 只在 `session/load` 重放时出现 |
| `tool_call` | `toolCallId, title, kind, status:"pending", rawInput, locations?` | 首次出现时 title 可能是笼统的（`Edit File`、`MCP: tool`、`Web Fetch`），rawInput 可能为空 |
| `tool_call_update` | `toolCallId`，以及 `status`（`in_progress`/`completed`）、`title`、`rawInput`、`rawOutput`、`content`、`locations` 中的若干个 | 先补全 title/rawInput，再 `in_progress`，最后 `completed`。**没有 `failed`**，失败写在 rawOutput 里 |
| `plan` | `entries:[{content, priority, status}]` | 只在 plan 模式的 create_plan 流程里出现【实测：`{"content":"Add CONTRIBUTING md","priority":"high","status":"pending"}`】 |
| `subagent_spawned` | `subagentSessionId, name, task, capabilities, _meta.cursor{toolCallId, agentId, model}` | 需要客户端声明 subagents。子代理自己的更新用 `sessionId=<agentId>` 发来 |
| `subagent_state_update` | `subagentSessionId, state, _meta.cursor{…}` | 实测 `completed`；源码还有 `failed`/`cancelled`/`disconnected`（A@62640） |
| `session_info_update` | `title` | 服务端起的标题，如 `"Protocol Probe"`；可能晚于 prompt 回复 |
| `available_commands_update` | `availableCommands:[{name, description}]` | 实测是内置技能和全局命令（`copy-request-id`、`worktree`、`best-of-n`、`autopilot`……）；用户和仓库的命令、技能也会加进来【源码 A@6047】 |
| `current_mode_update` | `currentModeId` | 只在客户端 `set_mode` 后出现；模型自己切模式不发【源码 P@89140】 |
| `config_option_update` | — | **从不发送**【源码：A 中零引用】，以 `set_config_option` 的回复为准 |
| `usage_update` | — | **从不发送**【源码】，上下文用量显示为不可用（与项目范围一致） |

**工具 `kind` 和字段**【实测 + 源码 A@99481】：

| 操作 | kind | title | rawInput | rawOutput / content |
| --- | --- | --- | --- | --- |
| 读文件 | `read` | `Read README.md` | `{path}` | `{content}`；locations `[{path}]` |
| shell | `execute` | `` `ls -la` `` | `{command}` | `{exitCode, stdout, stderr}` |
| 写/改文件 | `edit` | 先 `Edit File`，后 ``Edit `<abs path>` `` | `{path}` | `content:[{type:"diff",path,oldText,newText}]`。**新建文件时 oldText 是 `"-- /dev/null"`，newText 带 `"++ b/<path>\n"` 前缀**，不是标准 ACP diff，要原样显示或自行剥前缀 |
| MCP | `other` | 先 `MCP: tool`，后 `<server>: <tool>` | `{providerIdentifier, toolName, args}` | `{success:true}`；被拒是 `{rejected:true}` |
| web fetch | `fetch` | `Web Fetch: <url>` | `{url}` | `{success:true}` |
| TodoWrite | `other` | `Update TODOs: …` | — | — |
| Task（子代理） | `other` | `Task: <description>` | — | — |
| create_plan | `other` | `Create Plan: <name>` | — | — |
| 删除 / grep / 搜索 / 切模式 | `delete` / `search` / `switch_mode` | — | — | 【源码】 |

- **`toolCallId` 由服务端生成，中间带换行**，如 `"call-<uuid>-3\nfc_<uuid>_0"` 或 `"call-<uuid>-12\nfc_p5V5TAN-6jKPYy-…-aws_ue1_0"`。只能当不透明字符串处理。
- 实测里模型调 MCP 前，常先用 `GetDynamicTools` 查一次工具 schema。这次查询不出现在 ACP 上。

### 4.2 Cursor 扩展消息（都是带 id 的 JSON-RPC **请求**）

| 方法 | 方向与 id | 参数 | 应答 | 依据 |
| --- | --- | --- | --- | --- |
| `cursor/update_todos` | agent→client，带 id（实测 0、2） | `{toolCallId, todos:[{id,content,status}], merge}` | 回任意 result（实测回 `{}`）。CLI 不等这个应答【源码 A@79843】 | 【实测 `subagent-and-todos`】。**文档写的是不需应答的通知，wire 上实际是请求** |
| `cursor/task` | 同上（实测 id 1） | `{toolCallId, description, prompt, subagentType:{custom:{unspecified:{}}}, model:"default", agentId, durationMs}` | 同上 | 【实测】 |
| `cursor/create_plan` | 带 id，**阻塞** | `{toolCallId, name, overview, plan, todos, isProject, phases}` | `{outcome:{outcome:"accepted", planUri?}}` 或 `{outcome:{outcome:"rejected", reason}}`。客户端报错或不给 planUri 时，CLI 自己写计划文件到 `~/.cursor/plans/`【源码 A@50270、P@93387】 | 【实测：plan 模式收到请求，回 accepted 后正常结束】 |
| `cursor/ask_question` | 带 id，**阻塞** | `{toolCallId, title, questions:[{id,prompt,options:[{id,label}],allowMultiple}]}` | `{outcome:{outcome:"answered", answers:[{questionId, selectedOptionIds}]}}`、`skipped` 或 `cancelled`。回 `-32601` 时退回到每个单选题一个 `session/request_permission`，选项是答案加 `__ask_question_skip__`【源码 A@46698】 | **【待验】**：ACP agent 模式下服务端没给模型 AskQuestion 工具，模型说没有这个工具，改用正文提问（[`analysis/ask-question.json`](evidence/cursor-cli/2026.10.14-941492e/analysis/ask-question.json)） |
| `cursor/generate_image` | 带 id | `{toolCallId, description, filePath, referenceImagePaths}` | 同 update_todos | 【源码 A@79662】 |

- **不应答的后果**：`create_plan`、`ask_question` 和权限请求一样没有超时，不应答这一轮就一直挂着【源码 S@6078003】。
  **P5c：这些请求必须应答，审批卡撤回时回 `cancelled`。**
- 子代理里的提问一律被拒（"Interactive questions are not supported in ACP subagent mode"）【源码 A@72944】。

---

## 5. 权限矩阵（覆盖要求 3）

### 5.1 实测矩阵

| 操作 | 默认白名单 | `--force` | `--auto-review` | plan 模式 | ask 模式 |
| --- | --- | --- | --- | --- | --- |
| 读工作区文件 | 不问 | 不问 | 不问 | 不问 | 不问 |
| 写工作区文件 | **不问，直接写** | 不问 | 不问 | 工具运行但**文件没写出** | **不问，直接写** |
| `ls` | 不问（默认白名单 `Shell(ls)`） | 不问 | — | — | — |
| 其他 shell（`echo`、`touch`、`env|sort`） | **问**，内容 `Not in allowlist: <命令列表>` | 不问 | 问 | 问，允许后执行 | 问，允许后执行 |
| MCP 工具 | 问 | 不问 | 问 | 问，允许后执行 | 问，允许后执行 |
| web fetch | 问（toolCallId `web_fetch_<n>`） | 不问 | 问 | — | — |

证据：`multi-turn-tools-default`；`permission-force`、`permission-auto-review` 的协议加
[`analysis/permission-force.json`](evidence/cursor-cli/2026.10.14-941492e/analysis/permission-force.json)、
[`analysis/permission-auto-review.json`](evidence/cursor-cli/2026.10.14-941492e/analysis/permission-auto-review.json)；
plan/ask 两列见 [`analysis/plan-and-ask-modes-concurrent.json`](evidence/cursor-cli/2026.10.14-941492e/analysis/plan-and-ask-modes-concurrent.json)。
这几个场景运行时的断言写错了，事后分析给出更正后的断言，见 §17.2。

- **`--force` 的记录**：会话库的 meta 记 `isRunEverything: true`；`--auto-review` 和默认模式都是 `mode:"default"`、`isRunEverything:false`。
- **`--auto-review` 在 ACP 上无效**：表现和默认白名单一模一样【实测】。源码里 ACP 不读这个选项【A 中零引用】。
- **plan 和 ask 都不是只读模式**：
  - ask 模式里模型写文件**连权限请求都没有**。
  - 两种模式下，shell 和 MCP 都只靠权限请求把关，Orbit 一允许就执行。
  - plan 模式挡住了写文件（模型说写被拦了，文件确实不存在），这是服务端行为，只观察到一次。

### 5.2 权限请求的形状与应答

```jsonc
// agent → client（id 从 0 起，按进程递增）
{"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":"…",
 "toolCall":{"toolCallId":"call-…\nfc_…","title":"`echo shell-ok > probe-shell.txt`","kind":"execute","status":"pending",
  "content":[{"type":"content","content":{"type":"text","text":"Not in allowlist: echo"}}]},
 "options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},
            {"optionId":"allow-always","name":"Allow always","kind":"allow_always"},
            {"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}}
// client → agent
{"jsonrpc":"2.0","id":0,"result":{"outcome":{"outcome":"selected","optionId":"allow-once"}}}
```

- **按什么关联**：
  - shell 的权限请求 `toolCallId` 等于工具卡 id。
  - MCP 的权限请求 title 是 `<server>-<tool>: <tool>`（如 `p0probe-record: record`），工具卡上是 `<server>: <tool>`。
  - **web fetch 的权限请求 id 是 `web_fetch_<n>`，和工具卡 id 不同**【实测；源码 A@19375】，只能按时间和 URL 关联。
  - MCP 请求的 content 是参数 JSON 的 markdown 代码块。
- **拒绝**：选 `reject-once` 后工具卡仍以 `completed` 结束，rawOutput `{rejected:true}`，没有副作用（MCP 副作用日志里没有这一条）【实测】。
- **allow-always**：
  - 写进 `<CURSOR_CONFIG_DIR>/cli-config.json` 的 `permissions.allow`。实测 `echo` 被允许后，内容变成 `["Shell(ls)","Shell(echo)"]`。
  - 同一会话下一轮 `echo again > again.txt` 不再问【实测】。
  - 规则按账号配置目录共享，不分会话。
  - 源码里 MCP 存成 `Mcp(<server>:<tool>)`，fetch 存成 `WebFetch(<domain>)`，写和读存成 `Write(<path>)`/`Read(<path>)`【A@58378–58694、A@19940】。
- **`cancelled` 应答**：当作拒绝（"Cancelled"）。**JSON-RPC 错误应答**：当作 "Request failed" 拒绝【源码 A@56902、A@57212】。
- **没有超时**：不应答这一轮就一直等着【源码 S@6078003；文档 acp："If the client does not answer, tool execution can block"】。

### 5.3 规则语法与优先级【源码 + 文档】

- 写法：`Shell(<cmd>)` 或 `Shell(<cmd>:<args glob>)`、`Read(<path glob>)`、`Write(<path glob>)`、`Mcp(<server>:<tool>)`、`WebFetch(<host>|*.<domain>|*)`、
  `WebSearch(<词>)`【I@4599617、I@4637731、I@3588695；文档 permissions】。
- deny 在 allow 和 Run Everything 之前生效，是硬拒绝，不弹请求【I@4630779、I@4633585】。这一点【待验】，Orbit 可以用它做强制。
- 写入工作区外、写受保护的配置文件（`**/.cursor/**/cli.json`、`.git/hooks/**`、`.vscode/**` 等）会问；`.cursorignore` 永远拒写【I@4607423、I@4607747、I@4605514】。
- `approvalMode` 可取 `allowlist|unrestricted|auto-review`（cli-config）。ACP 只区分 `unrestricted`（跳过写和 MCP 的请求）和其余（都按白名单）【Q@15998】。
  `unrestricted`【待验】。
- **团队管理员禁用 Run Everything**：`--force` 时，如果团队设置 `autoRunControls.enabled && !enableRunEverything`，ACP 只写一行日志，退回白名单模式继续，
  客户端收不到任何提示【源码 A@22362、Q@4101】。拿团队设置失败时照样放行【Q@4251】。没有团队账号，【待验】。
  **P5c：开了 `--force` 仍可能收到权限请求，Orbit 要照常应答，不能当作不会发生。**

### 5.4 对 Orbit 权限模式的含义（P5c 决定，本节只给事实）

| Orbit 模式 | 能否强制 | 依据 |
| --- | --- | --- |
| `bypassPermissions`、`auto` | 能：`--force`（团队否决时退回白名单，见上） | 【实测】 |
| `acceptEdits` | 能：默认白名单。工作区写不问，shell/MCP/fetch 由 Orbit 审批卡应答 | 【实测】 |
| `dontAsk` | 部分：默认白名单 + Orbit 对每个请求自动 `reject-once`。工作区写仍会发生 | 【实测】 |
| `default`（编辑前要问） | **不能**：工作区写永远不问，ACP 没有把它变成请求的开关（`promptWorkspaceWrites` 不经配置传入【源码 I@4607944】） | 【实测 + 源码】 |
| `plan` | 只能组合：`set_mode plan` 挡写文件（服务端，实测一次）+ Orbit 对每个请求自动拒绝 | 【实测】 |
| 只读 | 同 plan；或在账号 `cli-config.json` 写 deny 规则（如 `Write(**)`、`Shell(*)`） | deny 规则【源码，待验】 |

---

## 6. MCP（覆盖要求 4）

- **注入**【实测 `multi-turn-tools-default`、`mcp-and-hook-sources-at-startup`】：
  - `session/new`、`session/load` 的 `mcpServers` 接受 stdio 项 `{name, command, args, env:[{name,value}]}`。
  - 服务器在 `session/new` 时启动并完成 initialize（MCP 协议版本 `2025-11-25`，clientInfo `Cursor 1.0.0`，声明 `elicitation.form`）；
    `tools/list` 在第一轮时才调。`load` 时重新启动。
  - **不需要批准**。注入的服务器**只拿到 HOME、PATH 和它声明的 env**，没有 CURSOR_API_KEY，也没有 CLI 的其他变量。
  - 注入一个连不上的 http 服务器，`session/new` 照样成功（只是没有工具）。
- **工具怎么到模型那里**：
  - 【实测：会话库里的上下文】MCP 工具以动态工具命名空间出现：
    `<namespace name="p0probe" tools="record, echo" source="mcp" />`，模型用 `GetDynamicTools` 查 schema，再用 `CallDynamicTool` 调用。
  - Cursor 自己的工具也在动态命名空间 `cursor` 下：AwaitShell、CreateGoal、Delete、EditNotebook、FetchMcpResource、GenerateImage、ReadLints、SwitchMode、
    Task、TodoWrite、UpdateGoal、WebFetch、WebSearch。
  - 工具卡 title `<server>: <tool>`，rawInput `{providerIdentifier, toolName, args}`；结果在 ACP 上只有 `{success:true}`。
- **每次调用都问权限**（默认和 auto-review），`--force` 下不问【实测】。allow-always 存成 `Mcp(<server>:<tool>)`【源码】。
- **`orbit mcp`**【实测】：作为 stdio 服务器注入（command `/usr/local/bin/orbit`，args `["mcp"]`，env 里带 `ORBIT_SESSION_ID`、`ORBIT_AGENT_ID`、`ORBIT_TASK_ID`、`ORBIT_HOME`、
  `ORBIT_MCP_PERMISSION_PROMPT=0`）。`task_get` 先发权限请求（title `orbit-task_get: task_get`），允许后完成，rawOutput `{success:true}`
  （[`analysis/multi-turn-tools-default.json`](evidence/cursor-cli/2026.10.14-941492e/analysis/multi-turn-tools-default.json)）。
- **配置文件来源**【实测 `mcp-and-hook-sources-at-startup`】：

| 位置 | ACP 是否加载 |
| --- | --- |
| `$HOME/.cursor/mcp.json` | **加载，`session/new` 时就启动，不问** |
| 仓库 `.cursor/mcp.json` | 不加载（`agent mcp list` 显示 `repo-mcp: not loaded (needs approval)`），`--approve-mcps` 无效；`agent mcp enable <名>` 批准后加载 |
| `$CURSOR_CONFIG_DIR/mcp.json`、`<data>/projects/<slug>/.cursor/mcp.json` | 不读 |

- 批准记录写在 `<CURSOR_DATA_DIR>/projects/<slug>/mcp-approvals.json`，键里含配置内容的哈希，配置一改就失效【源码 I@4799810】。
  **注意**：`agent mcp enable` 会建这个 `projects/<slug>/` 目录，副作用见 §14.3。
- 团队后台配置的 MCP 在 ACP 下不支持【文档 acp】。
- **对 Orbit 的含义（P5c）**：
  - 用户自己的 `~/.cursor/mcp.json` 会进入 Orbit 会话，除非 CLI 的 HOME 不是真 HOME（§8.4）。
  - 仓库 MCP 默认不进来，除非有人对同一个数据目录执行过 `agent mcp enable`。

---

## 7. 仓库自带配置（覆盖要求 5）

### 7.1 已实测

- **`initialize` + `session/new` 阶段，没有任何 hook 被执行**：仓库 `.cursor/hooks.json`、`.claude/settings.json`、`$HOME/.cursor/hooks.json`、
  `$CURSOR_CONFIG_DIR/hooks.json`、`<data>/projects/<slug>/.cursor/hooks.json` 都挂了标记脚本，都没有运行。
  加 `--approve-mcps` 或 `--disable-project-configs` 时也一样【`mcp-and-hook-sources-at-startup`】。
- **`.cursor/worktrees.json`、`.cursor/environment.json` 在启动阶段不执行**【同上】。
- **`.envrc`**：只要祖先目录有 `.envrc`，CLI 启动时就执行 `direnv export json`。本机没装 direnv，执行失败；装了 direnv 的 runner 上会运行仓库代码
  （受 direnv 自己的 allow 列表约束）【实测：strace 记录到对 `direnv` 的 execve；源码 I@2211167；`DIRENV_DISABLE=1` 可关，I@2211319】。
  **P5c：启动环境里加 `DIRENV_DISABLE=1`。**
- **无效的 `.cursor/cli.json` 让进程启动即退出**（§2.1）。
- CLI 自己的 git 调用强制 `core.hooksPath=/dev/null`【源码 I@3954566】，所以 `git status` 这类上下文收集不会触发仓库的 git hook。

### 7.2 【待验】（额度用尽，没能运行；源码依据如下）

- **`.cursor/cli.json` 的运行期效果**：合法的 cli.json 和用户配置深度合并，**数组整体替换**【I@3726438】。仓库因此能整体换掉用户的 allow 和 deny，
  比如写 `Shell(*)` 放行所有命令。没有信任门槛，ACP 也加载【I@3723669】。`--disable-project-configs` 只关掉 cli.json，不影响 hooks、MCP、rules【I@1678628】。
  **P5c 的建议**：受保护模式一律加 `--disable-project-configs`。
- **hooks**：
  - ACP 读「项目」hooks 的位置是 `<data>/projects/<slug>/.cursor/hooks.json`，**不是仓库的 `.cursor/hooks.json`**【A@67933、A@69807】。
  - 用户级 `$HOME/.cursor/hooks.json`、Claude 格式的 `~/.claude/settings.json` 和 `<repo>/.claude/settings*.json` 的 hooks 在会话中运行，不需批准，
    不受 `--disable-project-configs` 影响，在沙箱外执行【H@74123、H@74367、H@73009】。
  - 事件在 prompt 和工具执行时触发（beforeShellExecution、afterFileEdit、stop……，共 21 种）【I@3957000】。
  - 夹具仓库（[`lib/fixture.mjs`](../scripts/cursor-p0/lib/fixture.mjs)）和场景 `repo-config-baseline` / `repo-config-with-flags` 已备好，额度恢复后补测。
- **rules 和指令**：
  - 从工作区一直往上到 `/`，每层的 `.cursor/rules/`、`AGENTS.md`、`CLAUDE.md`、`CLAUDE.local.md` 都当作始终生效的规则加载，
    包括 HOME 和根目录【I@4359231、I@4359359】。
  - `.cursorrules` 只在 git 根目录加载【I@4358272】；仓库内的嵌套规则也会扫描【I@4343204】。
  - Orbit worktree 在 `/root/.orbit/worktrees/<id>` 下，`/root/AGENTS.md` 之类的文件也会被读进来。
  - 实测里看到 `<rules><user_rules>` 段中有服务端给的提交和 PR 规则（会话库上下文），说明规则段确实拼进了用户消息。
- **`--exclude-workspace-context`**：作为请求字段 `exclude_workspace_context` 发给服务端，裁剪在服务端做【I@5099680】。但 ACP 不把它传进请求【A 中零引用】，
  预计在 ACP 下无效。

---

## 8. 目录、凭据与隔离（覆盖要求 6）

### 8.1 哪个变量管哪个文件【实测 `directory-variables`，HOME 固定为槽目录】

| 文件 / 目录 | 决定它的变量（优先级从高到低） |
| --- | --- |
| `cli-config.json`（含 allow-always 规则、`selectedModel`、`privacyCache`）、`statsig-cache.json`（约 930 KB）、`acp-sessions/` | `CURSOR_CONFIG_DIR` > `$XDG_CONFIG_HOME/cursor` > `~/.cursor` |
| `auth.json`（Linux，file 存储） | `$XDG_CONFIG_HOME/cursor/auth.json` > `~/.config/cursor/auth.json`。**和 CURSOR_CONFIG_DIR 无关** |
| `projects/<slug>/`（worker.log、终端、agent-transcripts、MCP 批准） | `CURSOR_DATA_DIR` > `~/.cursor`；ACP 自己不建这个目录 |
| `agent-cli-state.json`、`skills-cursor/`（服务端下发的内置技能，每次启动同步）、`ai-tracking/ai-code-tracking.db`（第一轮后出现） | **只有 HOME** |
| 读取：用户 `mcp.json`、`hooks.json`、`rules`、`commands`、`plans`、`plugins`、`policy.json`、`sandbox.json`、`worktrees/` | **只有 HOME**【源码 I@3730071、H@74150 等】；`worktrees` 另可用 `CURSOR_WORKTREES_ROOT` |
| 调试日志 `cursor-agent-logs-<uid>/` | `TMPDIR` > `/tmp`【实测 `debug-log-location`】；`CURSOR_AGENT_DISABLE_DEBUG_LOG=1` 关掉 |
| 数据目录路径太长时的 worker socket `/tmp/.cursor/<slug 截断>-<hash>/worker.sock` | 实测设了 TMPDIR（一个长路径）后仍落在 `/tmp/.cursor/`【实测 `startup-processes-and-network`】；短 TMPDIR 的情况【待验】 |
| Node 编译缓存 | `NODE_COMPILE_CACHE` 默认 `$XDG_CACHE_HOME/cursor-compile-cache`（启动脚本设置） |
| `XDG_DATA_HOME` | 启动时什么都不写 |

### 8.2 凭据存储【实测 `credential-stores`】

| `AGENT_CLI_CREDENTIAL_STORE` | Linux 上的结果 |
| --- | --- |
| `file` | `$XDG_CONFIG_HOME/cursor/auth.json`（目录 0700，文件 0600），字段 `accessToken`、`refreshToken`、**`apiKey`**：用 API key 时 key 本身也落盘 |
| 不设（`default`） | Linux 上同 `file`（macOS 默认 Keychain，P0b 验证） |
| `memory` | 什么都不写；每次启动重新用 key 换 token |

- 用 API key 换来的 token：access 和 refresh 是同一个 JWT，claim 有 `apiKeyId, aud, exp, iss, randomness, scope, sub, time, type`。
- `agent logout` 只删本地 `auth.json`（"✓ Logout successful / Authentication tokens removed."），不调吊销接口【实测；源码 4760@1761】。
- `status` / `whoami` 只看已存的 token：只设了环境变量 key 时显示 `unauthenticated`；file 存储换过 token 后显示 `authenticated` 加用户信息【实测】。
- `CURSOR_AUTH_TOKEN` 在 file 存储下会被写成 access 和 refresh 两份，覆盖已存的登录【源码 I@1659323】。所以注入 token 时必须用 memory 存储。

### 8.3 agent 跑的命令看到的环境【实测 `multi-turn-tools-default`】

命令环境 = CLI 进程的全部环境，外加 CLI 给每条命令的补充【源码 I@7408434：`{...process.env, TERM:"dumb", NO_COLOR:"1", FORCE_COLOR:"0", _ZO_DOCTOR:"0", ...每条命令的变量}`】：

- **原样继承**：HOME、XDG_*、CURSOR_CONFIG_DIR、CURSOR_DATA_DIR、AGENT_CLI_CREDENTIAL_STORE、**CURSOR_API_KEY**、代理变量、Orbit 的变量（实测金丝雀变量原样出现）。
- **CLI 补充**：`CURSOR_AGENT=1`、`CURSOR_CONVERSATION_ID`、`CURSOR_REQUEST_ID`、`AGENT_TRANSCRIPTS=<data>/projects/<slug>/agent-transcripts`、
  `CURSOR_INVOKED_AS=cursor-agent`、`CURSOR_RIPGREP_PATH`、`__CURSOR_SANDBOX_ENV_RESTORE`、`NODE_COMPILE_CACHE`、`GLOBAL_AGENT_ENVIRONMENT_VARIABLE_NAMESPACE`。
  另外经过 `bash -ilc` 快照：PATH 被登录 shell 的 profile 改写。
- MCP 服务器例外：只拿到 HOME、PATH 和声明的 env（§6）。
- **CLI 怎么选 shell**：
  - `$SHELL` 的路径含 `bash` 才用它，否则从 PATH 找 bash。zsh 同理【源码 I@7385715、I@7424080】。
  - 每条命令先用这个 shell 跑一次 `-ilc` 拍环境快照，再 `-c` 执行【实测 strace：`bash -O extglob -ilc` 后 `bash -O extglob -c`】。

### 8.4 D4：按账号隔离而不改变 agent 命令的环境

**事实**：

1. 账号的**会话和配置**用 CURSOR_CONFIG_DIR 分开，**项目数据**用 CURSOR_DATA_DIR 分开【实测】。两者都会出现在命令环境里，但除了 Cursor 自己没人读它们。
2. **凭据**有两种做法，都不改 HOME/XDG：
   - API key：`CURSOR_API_KEY` + memory 存储【实测】。
   - 登录账号：登录时用账号自己的 `XDG_CONFIG_HOME` 跑 `agent login`（独立进程，没有 agent 命令），会话时读出那份 `auth.json` 的 accessToken，
     以 `CURSOR_AUTH_TOKEN` + memory 存储注入【实测：注入后 `session/new` 成功、不落盘】。
   - 两种情况下，凭据都在命令环境里可见。agent 和 runner 是同一个系统用户，本来也能读到磁盘上的凭据，这和其他引擎的 key 注入属于同一类暴露。
3. **但只要 CLI 的 HOME 是真 HOME，Cursor 就会**：
   - 写 runner 用户的 `~/.cursor/`：`agent-cli-state.json`、按账号下发的 `skills-cursor/`、`ai-tracking` 库；
   - 读 `~/.cursor/mcp.json`（并启动其中的服务器）、`hooks.json`、`rules`、`commands`；
   - 账号之间共享这些文件。

   这违反项目判据 4「不写 runner 用户真实的 Cursor 配置」。HOME 是唯一能移走它们的变量【源码：都直接用 `os.homedir()`】。
4. **登录 token 不刷新**：CLI 只会用 API key 重新换 token，没有用 refresh token 刷新的流程【源码 I@1661040】。
   浏览器登录的有效期等于 access token 的有效期，过期要重新登录。登录 token 的实际寿命【待验】：所有者没有完成登录。

**候选方案**（所有者选择；P4b 实现前要补验 A）：

- **A. CLI 用账号自己的 HOME，命令经 SHELL 包装拿回真 HOME。**
  - 包装脚本放在路径含 `bash` 的位置（例如 `<runner>/bin/orbit-bash`），内容是 `export HOME=<真 HOME>; unset CURSOR_API_KEY CURSOR_AUTH_TOKEN XDG_CONFIG_HOME CURSOR_CONFIG_DIR CURSOR_DATA_DIR; exec /bin/bash "$@"`，
    再把 `SHELL` 指向它。
  - 源码表明每条命令和环境快照都由这个 shell 执行，所以包装生效后，命令看到的 HOME 和环境都与普通会话相同。
  - **【待验】**：唯一一次实测用的包装名叫 `orbit-shell`，不含 `bash`，CLI 没用它，命令仍看到账号 HOME 和全部 Cursor 变量
    （[`analysis/crash-continue-and-shell-wrapper.json`](evidence/cursor-cli/2026.10.14-941492e/analysis/crash-continue-and-shell-wrapper.json)）。
    改名后的场景 `shell-wrapper-env` 已写好，额度恢复后一次 prompt 即可验证。
  - 风险：依赖 CLI 选 shell 的内部规则，每次升级版本都要回归。
- **B. 真 HOME + CURSOR_CONFIG_DIR/CURSOR_DATA_DIR + memory 存储 + 注入 key 或 token**：命令环境不变，凭据和会话分开。
  代价是第 3 条的副作用（写和读真 `~/.cursor`）。要选 B，所有者必须接受这一点，或者 runner 给 `~/.cursor` 做只读保护（没有验证）。
- **C. Linux mount namespace**：给 CLI 进程单独挂载账号目录到 `~/.cursor` 和 `~/.config/cursor`，命令环境不变。只有 root runner 能用，【待验】。
- **D. 该平台只支持 Default 账号**（作业指导的退路）。

**建议**：先在 P4b 用一次 prompt 补验 A。A 成立就用 A（Linux）。A 不成立，就请所有者在 B（接受副作用）和 D 之间选。

---

## 9. 登录、API key 与 token（覆盖要求 7）

- **登录链接**【实测 `login-link-and-logout` + 两次完整计时】：
  - `NO_OPEN_BROWSER=1 agent login` 在 0.3 s 内打印：

    ```text
    Starting login process...
    Authenticating with Cursor...
    Waiting for browser authentication...
    Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=<43 字符 base64url>&uuid=<uuid>&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true
    ```

    challenge 是 PKCE S256，verifier 只在本进程里【源码 I@3715277】。轮询 `GET ${api}/auth/poll?uuid=…&verifier=…`【I@3716301】需要 verifier，
    别人拿到链接也取不到 token。
  - 没人完成时，两次独立计时分别在 **1,632 s 和 1,636 s（约 27.2 分钟）**后打印 `Login failed or timed out. Please try again.`，退出码 1；期间不写任何凭据。
- **在另一台设备上完成登录**【待验】：2026-10-16 已把链接发给所有者（任务评论 + 通知），27 分钟内没有完成。
  源码表明成功后存 `accessToken`/`refreshToken`（不存 apiKey），打印 `Logged in as <email>`，再调 `GetMe` 写入 `authInfo`【3541@493、3541@3010】。
  **P4b 的登录中继**：把链接原样交给用户，最长等 27 分钟，成功与否看 `agent login` 的退出码；之后用 `status --format json` 核对。
- **`agent status --format json`**【实测】：
  - 未登录：`{"status":"unauthenticated","isAuthenticated":false,"hasAccessToken":false,"hasRefreshToken":false,"message":"Not logged in"}`
  - 已存 token：`status:"authenticated"`，外加 `userInfo{email,userId,firstName,lastName,createdAt}`
  - 另有 `partially-authenticated` 状态【源码 2576@1131】。
  - `agent about --format json` 给出 `cliVersion, latestStatus, latestVersion, model, subscriptionTier, osPlatform, osArch, userEmail, terminalProgram, shell, lastRequestId`。
- **API key**：
  - 来源：`--api-key` 优先，其次 `CURSOR_API_KEY`。
  - CLI 先 `POST ${api}/auth/exchange_user_api_key` 换成 JWT，再用 JWT 当 bearer，key 本身不进 agent RPC【源码 I@3717254】。
  - 换 token 发生在 `session/new`，ACP 里 key 只放在进程内存【源码 A@53297】。
- **校验 key 的办法**【实测 `failure-shapes-without-prompt`】：
  - `agent models`：有效 key 退出码 0，第一行 `auto - Auto (default)`。
  - 无效 key：退出码 1，stderr `⚠ Warning: The provided API key is invalid.` 加 `The API key was loaded from the CURSOR_API_KEY environment variable.`。
  - 断网：退出码 1，stderr `✗ Failed to reach the Cursor API. If you are behind a corporate proxy, set the HTTPS_PROXY environment variable.`。
  - `status`、`about` 不换 token，不能用来校验。
  - **P2 的 key 状态检查用 `agent models`**（约 3.5 s，不花 prompt）。
- **token 过期**【源码】：剩余不足 300 s 就算过期【I@1660873】。API key 模式下过期就重新换；登录模式下没有刷新流程（§8.4）。
  过期后服务端报 `ERROR_NOT_LOGGED_IN` 一类错误。轮中过期时，ACP 上只有一段文本（`Please sign in to continue` 或 `Error: [unauthenticated] …`）加 `end_turn`【A@15087、A@15425】，
  这一点【待验】。原始 API key 直接当 bearer 时，dashboard 返回的 401 形状已实测（§11）。

---

## 10. 模型（覆盖要求 8）

- **默认的变体选择器**【实测 `api-key-session-management`】：
  - `configOptions` 只有 `mode` 和 `model` 两项。`model` 有 46 个选项，值是带参数的变体串，如 `claude-opus-5-5[context=300k,effort=medium,fast=false]`、
    `grok-4.7[context=256k,reasoning_effort=high,fast=true]`、`composer-2.5[fast=true]`。
  - **Auto 是 `default[]`**（name `Auto`），新会话默认用它。
  - 设置必须用列表里的原值：未列出的组合、`auto` 别名、未知模型都返回 `-32602 Invalid model value: …`。
  - 模型选择全进程生效（§3.1）。
- **参数化选择器**【实测 `parameterized-model-picker`】：
  - 客户端在 `clientCapabilities._meta` 里声明 `parameterizedModelPicker: true` 后，`model` 的值变成不带参数的模型名，Auto 是 `default`。
  - 选了模型后多出该模型的参数选项，例如 Opus 5.5：`context`（`model_config`：300k/1m）、`effort`（`thought_level`：low/medium/high/xhigh/max）、`fast`（`model_config`：false/true）。
  - 值非法返回 `-32602 Invalid value for <id>: <值>`。
  - **P5a 建议用参数化选择器**，它和 Orbit「模型 + 变体」的界面对得上。
- **`cursor/list_available_models`**【实测】：返回 46 个 `{value, name, configOptions}`，每个模型带自己的参数定义，可以不建会话就拿到目录。
- **`agent models` / `--list-models`**【实测】：输出另一套命名（如 `claude-opus-5-5-high-fast`），和 ACP 的值不同，**P3 的模型目录应以 ACP 为准**。
- **Auto 实际用了哪个模型**：ACP 上看不到。会话库里 assistant 消息的 `providerOptions.cursor.modelName` 记着，实测一次是 `cursor-grok-4.5-high`。
- 不同账号或 key 的模型目录是否不同【待验】：只有一个账号。源码里目录来自服务端 `GetUsableModels`、`AvailableModels`，按账号或团队下发【6436@5778、6436@5997】。
  **P3 应按账号读目录，不要共享缓存。**

---

## 11. 额度（覆盖要求 9）

**能读到**【实测 `usage-api`】：用 CLI 换来的 access token，按 Connect 协议发 JSON：

```text
POST https://api2.cursor.sh/aiserver.v1.DashboardService/<Method>
content-type: application/json
connect-protocol-version: 1
x-cursor-client-type: cli
authorization: Bearer <access token>
body: {}
```

| 方法 | 状态 | 实测返回的字段 |
| --- | --- | --- |
| `GetCurrentPeriodUsage` | 200 | `billingCycleStart/End`（毫秒时间戳字符串）、`planUsage{autoPercentUsed, apiPercentUsed, totalPercentUsed, remainingBonus, bonusTooltip}`、`spendLimitUsage{pooledLimit, pooledRemaining, individualLimit, limitType, overallLimit, overallRemaining}`、`displayThreshold`、`displayMessage`、`autoModelSelectedDisplayMessage`、`namedModelSelectedDisplayMessage`、`autoBucketModels` |
| `GetPlanInfo` | 200 | `planInfo{planName:"Free", price, billingCycleEnd}`、`nextUpgrade{tier, name, includedAmountCents, price, …}` |
| `GetHardLimit` | 200 | `noUsageBasedAllowed: true` |
| `GetUsageLimitPolicyStatus` / `GetUsageLimitStatusAndActiveGrants` | 200 | `canConfigureSpendLimit`、`canAdjustOnDemand`、`recommendedOnDemandLimitCents`… |
| `GetUserPrivacyMode` | 200 | `privacyMode: PRIVACY_MODE_USAGE_DATA_TRAINING_ALLOWED`（即 3） |
| `GetMe` | 200 | 身份字段（证据里只留字段名） |
| 原始 API key 当 bearer | **401** | `{"code":"unauthenticated", details:[{type:"aiserver.v1.ErrorDetails", debug:{error:"ERROR_NOT_LOGGED_IN", details:{title:"Authentication error", …, analyticsMetadata:{actionRequired:"login"}}}}]}` |

- 交互式 CLI 的 `/usage` 命令也是调 `GetCurrentPeriodUsage` + `GetHardLimit` + `GetPlanInfo`【源码 C@876991】。ACP 不调这些接口。
- **读不到的**：
  - **Free 套餐的请求上限**：第 20 次 prompt 碰到 "You've hit your free requests limit"（§12）时，`GetCurrentPeriodUsage` 仍是 `totalPercentUsed: 0`、
    `displayMessage: "You've used 0% of your included usage"`【实测】。这个上限的用量和剩余在这些接口里都没有。
  - 团队用量（`GetTeamSpend` 等）没有团队账号，【待验】。
- **P6a 的建议**：
  - 每个账号用自己的 token 读 `GetCurrentPeriodUsage` 和 `GetPlanInfo`。显示百分比和账期；Free 套餐的请求上限显示为不可用，不显示成 0。
  - 额度拦截以实际碰到的「额度用尽」轮次（§12）为准，按服务端给的重置日期（chatMessage 里有，只在 CLI 调试日志中可见）或账期结束时间解除。
  - 用 API key 的会话也能这样读（同一个换 token 流程）。

---

## 12. 错误形状（覆盖要求 10）

| 情形 | ACP 上看到的 | 来源 | Orbit 分类 |
| --- | --- | --- | --- |
| 没有凭据 | `session/new` / `session/list` → `-32000 "Authentication required"` | 【实测】 | 需要登录 |
| key 无效 | `session/new` → `-32603`，`data.message:"Failed to initialize session services"`；`session/list` 照常 | 【实测】 | 凭据无效（用 `agent models` 确认） |
| 启动时断网 | 同上，同一个 `-32603` | 【实测 `unshare -n`】 | 网络（用 `agent models` 确认：`Failed to reach the Cursor API`） |
| **额度用尽** | 一条 `agent_message_chunk` `"\n\nUpgrade your plan to continue"`，然后 `stopReason:"end_turn"`（0.58 s）；没有 JSON-RPC 错误 | **【实测】**（[事故记录](evidence/cursor-cli/2026.10.14-941492e/incidents/quota-exhausted/README.md)）：服务端 Connect `ResourceExhausted`，ErrorDetails `You've hit your usage limit`，`limitType:included_usage` | 额度用尽：可换账号或等重置 |
| 限流 | 预计同样是 `Upgrade your plan to continue`（动作 upgrade）或 `Error: <服务端标题>` | 【源码 I@7334425：FREE/PRO_USER_RATE_LIMIT_EXCEEDED、GENERIC_RATE_LIMIT_EXCEEDED、API_KEY_RATE_LIMIT…；I@3527512】，【待验】 | 限流 |
| 模型提供方拒答 | `agent_message_chunk` `"\n\nRequest blocked We are unable to complete this request because it was blocked under the model provider's usage guidelines. Try a less sensitive prompt."` + `end_turn` | **【实测】**（[事故记录](evidence/cursor-cli/2026.10.14-941492e/incidents/provider-refusal-after-crash/README.md)） | 内容被拒：不重试 |
| 轮中认证失效 | `Please sign in to continue` 或 `Error: [unauthenticated] …` + `end_turn` | 【源码 A@15087、A@15425】，【待验】 | 需要重新登录 |
| 模型不可用 | `set_config_option` → `-32602 Invalid model value: <值>`；`--model <未知>` → 进程 exit 1 | 【实测】 | 模型不可用 |
| 轮中断网 | 非可重试错误时为 `Error: …` 文本 + `end_turn`；传输层先按 `nal_agent_retries` 重试 | 【源码 A@15603；调试日志】，**【待验】**（场景 `network-drop-mid-turn` 已写好） | 网络 |
| 进程崩溃 | 收不到 prompt 回复，stdout 关闭 | 【实测】 | 进程异常：结算未终态工具，保留恢复 id |
| 团队已切换 | `-32603`，`message:"Your team has switched to <名>. Create a new session to continue."`，进程随后 exit 0 | 【实测 `team-pin`】 | 需要新会话或换账号 |
| 项目配置无效 | 进程在回复 `initialize` 前 exit 1，stderr `Invalid project config at …` | 【实测】 | 仓库配置错误 |
| 未知会话、方法不存在 | `-32603 details "Session <id> not found"` / `-32601` | 【实测】 | 编程错误 |

- **运行期错误一律是文本加 `end_turn`**【实测三类：额度、拒答、（源码）认证】。服务端的结构化信息（错误码、标题、重置时间）只出现在 CLI 调试日志里。
  **P5b：按上面三类固定句子分类，其余 `end_turn` 当作正常结束。**这些句子是英文固定文案，跟版本走，升级要回归。
- 调试日志里有服务端的结构化错误（ErrorDetails），但它是 CLI 的内部文件，格式不稳定，**不建议当接口用**。

---

## 13. 换账号与会话搬运（覆盖要求 11）

### 13.1 已实测

- **会话库可以搬**：
  - `acp-sessions/<id>/`（`store.db`、`-wal`、`-shm`、`meta.json`）拷到另一个 CURSOR_CONFIG_DIR、换一个 HOME 后，同一把 key 下能 load【实测两次】，
    并带上下文续聊【实测一次；另一次续聊被模型提供方拒答】。
  - 库里自带 `blobEncryptionKey`，不依赖原账号目录的其他文件。
  - 搬运时要连 WAL 一起拷，或者先让 CLI 退出：只拷 `store.db` 会读到空库【实测：脚本早期的缺陷就是这个原因】。
- **团队固定在进程上，不在会话上**：
  - ACP 进程在首次初始化服务时记下当前团队，之后每次 new/load/prompt 前重读 `cli-config.json` 的 `authInfo` 比较【源码 A@81906、A@87092】。
  - 实测把配置目录里的 `activeTeamId` 改掉后，下一个 `session/new` 返回 `-32603 "Your team has switched to P0 Probe Team. Create a new session to continue."`，进程 exit 0。

### 13.2 【待验】

- **换到另一个账号或另一把 key 后续聊**：只有一个账号。所有者的浏览器登录没完成，「API key 会话改用登录凭据续聊」也没做成（场景 `login-account` 已写好）。
  源码依据：load 时没有按会话校验账号（只有进程级团队比较），对话内容在本地库里，每轮由客户端发出，所以技术上很可能能续。
  服务端会不会因为账号不同而拒绝（如引用了服务端缓存的上下文）不得而知。
- 账号属于不同团队时：同一进程里不能换。新进程用新账号 load 旧会话会怎样，未知。

### 13.3 D5 的事实与建议

- **事实**：搬运机制可用（同一身份下实测）；会话本身不记账号或团队；跨账号续聊无实测。
- **建议**：
  - P6b 先实现「把 `acp-sessions/<id>/` 拷到目标账号的 CURSOR_CONFIG_DIR，然后 load」，用两个真实账号验证后再声明 `cursor-account-move/v1`。
  - 验证前按作业指导 D5 的退路处理：只允许没说过话的会话换账号；说过话的会话，控制面拒绝并说明。
  - 没说过话的会话（没有 `store.db`）换账号，就是在新账号下 `session/new`。

---

## 14. 外连、索引、遥测与提交署名（覆盖要求 13）

### 14.1 外连主机【实测 `startup-processes-and-network`、`multi-turn-tools-default`；路径由 `lib/netlog.cjs` 记录】

| 主机 | 何时 | 内容 |
| --- | --- | --- |
| `api2.cursor.sh` | `initialize` 起 | `AnalyticsService/BootstrapStatsig`（未登录也调，结果缓存进 `statsig-cache.json`）、`DashboardService/GetUserPrivacyMode`（反复调）、`ServerConfigService/GetServerConfig`、`DashboardService/GetManagedSkills`、`AnalyticsService/TrackEvents`、`DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam`、`AiService/AvailableModels`、`GetUsableModels`、`GetDefaultModelForCli`、`DashboardService/GetMe`、`GetGlobalCommands`；还有 API key 换 token（`/auth/exchange_user_api_key`，CLI 自带的 undici 发出，netlog 看不到）。源码里还有 `AnalyticsService/SubmitLogs` 和 OTLP traces，本次没观察到 |
| `agentn.global.api5.cursor.sh` | prompt 时 | agent 流（HTTP/2 双向流）；地址由服务端 `agentUrlConfig` 下发，隐私模式开时换 `agentUrl`【源码 I@2226086】。两轮约 300 KB 上行 |
| `registry.npmjs.org` | `session/new` 后（条件见 §14.3） | `GET /npm`、`/typescript-language-server`、`.tgz` 包、`POST /-/npm/v1/security/advisories/bulk` |
| `repo42.cursor.sh` | 索引同步 | 本账号（隐私模式 3）没有流量【实测】 |
| `cursor.com` | 登录链接 | 用户在浏览器里打开 |
| `api3.cursor.sh`（metrics）、Sentry | 只在对话模式 | 【源码】，ACP 不加载 |

- **代理**【实测】：只设 `HTTPS_PROXY` 时，大部分流量走代理，但每次运行仍有 3 条直连 api2：Node 内置的 fetch（BootstrapStatsig、TrackEvents 等）不认代理变量。
  加 `NODE_USE_ENV_PROXY=1` 后**全部**走代理【实测；文档 configuration 也这么写】。worker 的 npm 也走代理。
- statsig 本身不联网，只用 api2 引导下来的数据【源码 I@2189473】。

### 14.2 遥测【源码 + 实测】

- 事件经 `AnalyticsService/TrackEvents` 上报（实测 `session/new` 期间就有），含终端、shell、OS 等属性【I@2230367】；另有 `SubmitLogs` 和 OTLP traces（含主机名）【P@80210】。
- **没有关闭开关**：没有 DO_NOT_TRACK、CURSOR_DISABLE_TELEMETRY 之类的变量【源码，查无】。唯一的关法在 authless 模式里，这个构建用不了。
- CLI 调试日志写在本机（§8.1），不上传。

### 14.3 代码库索引与 worker（D1）

**实测**：

| 条件 | 结果 |
| --- | --- |
| 全新数据目录（`<CURSOR_DATA_DIR>/projects/<slug>/` 不存在） | `session/new` 拉起 `worker-server` 子进程，它写日志失败后立刻退出：没有 LSP，没有索引，没有 npm 流量 |
| 这个目录已存在（`agent mcp enable`、交互式 CLI 等都会建它） | worker 常驻，**立刻执行 `npx -y typescript-language-server --stdio`**：未经审批，从 registry.npmjs.org 下载 typescript-language-server 6.0.2 并运行。随后索引循环检查隐私模式，本账号（3）打印 `Skipping codebase telemetry sync`，repo42 无流量 |
| 加 `--disable-indexing` | worker 和 LSP 照常，`worker.log` 里没有索引相关行 |
| 加 `--disable-codebase-ref` | **worker 根本不启动**，也就没有 npx |
| 设 `TMPDIR` | worker socket 仍在 `/tmp/.cursor/<slug 截断>-<hash>/worker.sock`（数据目录路径太长时的回退位置，不跟 TMPDIR） |

**源码**：

- 索引只在隐私模式等于 `USAGE_CODEBASE_TRAINING_ALLOWED`（4）时运行【I@4795418】，每 5 分钟一次【I@4790588】，最多 1 万个文件建 merkle 树。
- 上传走 `RepositoryService/FastRepoInitHandshakeV2 → SyncMerkleSubtreeV2 → FastUpdateFileV2`，**上传完整文件内容**（每批 32 个），最后 `FastRepoSyncComplete`【I@3985611】。
- 路径用服务端下发的密钥加密，对 Cursor 不构成隐藏【I@2117683】。
- `--disable-indexing` 只关这条上传；`--disable-codebase-ref` 换成空的诊断和代码引用提供者【I@1689938】，对回答质量的影响【待验】。
- LSP 只在 PATH 上找得到 npx 时启动【I@4774213 一带】。

**D1 的事实**：本账号是隐私模式 3，上传量和耗时都是 0，测不出差别。隐私模式 4 的账号会每 5 分钟上传完整文件内容。
`--disable-indexing` 对功能没有可见影响：它不关 worker，也不关 LSP。

**建议**：
- **默认加 `--disable-indexing`**，所有者可以要求关掉。
- worker 的 npx 下载是另一件事，交给 P3/P5c 决定：要么加 `--disable-codebase-ref` 彻底不起 worker（代价待验），要么接受。
  Orbit 也可以不让 `<data>/projects/<slug>/` 存在，但这很脆弱：一旦有人对这个数据目录执行 `agent mcp enable`，就会出现。

### 14.4 提交署名（D2）

- **【待验】**：commit 场景撞上额度用尽，没有实测到 trailer 文本。
- **【源码】**：
  - `attribution.attributeCommitsToAgent`（默认 true）只让客户端在请求里带 `commitAttributionMessage:"enabled"`【I@4693233、I@4694065】，
    trailer 文本由服务端提示模型写，打包文件里找不到任何 trailer、git hook 或 GIT_* 变量。
  - 管理员可以关掉；拿团队设置失败时也按关掉处理【I@4773670】。
- **【文档】**："adds a trailer to agent commits"。
- **建议**：沿用默认（作业指导 D2 的默认）。所有者要求关闭时，在账号 `cli-config.json` 写 `"attribution":{"attributeCommitsToAgent":false,"attributePRsToAgent":false}`。
  P8 冒烟里核对一次实际的 trailer。

---

## 15. 隐藏的 agent-cli-local / `--authless`（覆盖要求 14）

- **结论：不能当测试替身。**
- **【实测】**：
  - `agent acp --authless`、`agent -p --authless` 都以退出码 2 结束，输出 `Error: --authless can only be used with agent-cli-local`。
  - `CURSOR_ENABLE_AUTHLESS=1`、`CURSOR_AGENT_CLI_AUTHLESS_MODE=true`、`CURSOR_LOCAL_AGENT_BASE_URL=…` 都不能免掉 ACP 的登录要求，`session/new` 仍是 `-32000`。
- **【源码】**：
  - 本地模式只有在入口注入 `localAgentRuntime` 对象时才存在【I@1677933】。这个构建的入口不注入【I@2068955】，ACP 也从不传它【I@1740525】。
  - 能开它的是另行分发的「Cursor Private Inference」包 `agent-cli-local`（`agent-local`）【2761@318】。
- **确定性测试的替身**：继续用录制回放的假 ACP agent（[`src/runner-go/testdata/cursor/`](../src/runner-go/testdata/cursor/)，做法同 `fake_kimi_acp_test.go`）。
  另一条路是假 Cursor 后端，它得实现 Connect/protobuf 的 `agent.v1.AgentService/Run`，工作量大，不建议。

---

## 16. 后续任务共用的接口约定（【约定】，尚未实现）

### 16.1 能力名

| 能力 | 含义 | 由谁实现 |
| --- | --- | --- |
| `provider:cursor` | runner 的 `runnerSupportedProviders` 加上 `cursor`，心跳持久化为 `provider:cursor`；旧 runner 没有这一项，就领不到 Cursor 会话 | P1 |
| `cursor-account-login/v1` | runner 能在控制面指定的账号目录里登录（独立 `agent login` 进程，转发链接，最长约 27 分钟） | P4b |
| `cursor-account-remove/v1` | runner 能删除指定的账号目录及记录，不碰其他账号；有会话在用时拒绝 | P4b |
| `cursor-account-move/v1` | runner 能把说过话的会话搬到另一账号（拷 `acp-sessions/<id>/` 后 load）。**跨账号验证前不声明**（§13.3） | P6b |

### 16.2 账号目录与派发变量

```text
<orbit home>/cursor/default/            Default 账号
<orbit home>/cursor-accounts/<id>/      新加的账号（命名同 antigravity-accounts）
  config/        CURSOR_CONFIG_DIR：cli-config.json（Orbit 写 attribution、channel 等）、acp-sessions/（会话库）
  data/          CURSOR_DATA_DIR：projects/<slug>/
  xdg-config/    只给 `agent login` 用的 XDG_CONFIG_HOME：cursor/auth.json（登录 token，0600）
  home/          只在 D4 选 A 时给 CLI 当 HOME
  tmp/           TMPDIR（调试日志），或者改为设 CURSOR_AGENT_DISABLE_DEBUG_LOG=1；worker socket 可能仍落在 /tmp/.cursor/（§8.1）
```

- 派发变量：`ORBIT_CURSOR_ACCOUNT_DIR=<账号目录>`，做法同 `ORBIT_ANTIGRAVITY_GOOGLE_DIR`。runner 读它，从 CLI 的环境里删掉。
- API key 凭据（P2）不建账号目录。会话用自己的 `config/`、`data/`（放在会话 scratch 下，续聊时复用），key 以 `CURSOR_API_KEY` 注入，用 memory 存储。

### 16.3 启动参数

```text
argv: <固定版本目录>/cursor-agent acp [--force] [--disable-indexing] [--disable-project-configs] [--disable-codebase-ref?]
cwd:  会话 execDir
env:  三层，后面的覆盖前面的（见下）：白名单（PATH、LANG、TERM、代理与 CA 变量）→ 会话的工作区环境变量 → 以下契约固定的变量与凭据
      CURSOR_CONFIG_DIR=<账号或会话>/config
      CURSOR_DATA_DIR=<账号或会话>/data
      AGENT_CLI_CREDENTIAL_STORE=memory
      CURSOR_API_KEY=<key>（API key 凭据） 或 CURSOR_AUTH_TOKEN=<账号 auth.json 的 accessToken>（账号凭据）
      NO_OPEN_BROWSER=1
      DIRENV_DISABLE=1
      CURSOR_AGENT_DISABLE_DEBUG_LOG=1（或 TMPDIR=<账号>/tmp）
      NODE_USE_ENV_PROXY=1（机器配了代理时）
      HOME：D4 方案决定（A：<账号>/home + SHELL=<runner>/bin/orbit-bash；B：真 HOME）
```

- **环境分三层，后面的覆盖前面的**【约定：协调会话 2026-10-16 裁定，P5a 实现于 `src/runner-go/cursor_launch.go`】：
  1. runner 自己环境的白名单（`cursorBaseEnv`）。白名单以外，runner 的变量一个都不传。
  2. 会话的 agent 环境（`job.Agent.Env`，即工作区环境变量），和其他 engine 一样传入。不传的只有：Orbit 的会话上下文变量、
     `ORBIT_HOME`、个人凭据（`ORBIT_USER_TOKEN` 等），以及只给 runner 读的派发变量 `ORBIT_CURSOR_API_KEY`、`ORBIT_CURSOR_ACCOUNT_DIR`。
  3. 契约固定的变量（HOME、SHELL、CURSOR_CONFIG_DIR、CURSOR_DATA_DIR、AGENT_CLI_CREDENTIAL_STORE=memory、NO_OPEN_BROWSER、DIRENV_DISABLE、
     CURSOR_AGENT_DISABLE_DEBUG_LOG、Orbit 的会话变量），以及 Orbit 选定的凭据。工作区设了同名变量也以这一层为准。
- **凭据的选法**，依次：
  1. 派发的 key（P2：`ORBIT_CURSOR_API_KEY`，以 `CURSOR_API_KEY` 交给 CLI）；之后的账号 token（P4b）也在这一档。
     Orbit 选了凭据时，工作区带来的 `CURSOR_API_KEY`、`CURSOR_AUTH_TOKEN` 都换掉。
  2. 工作区环境变量里的 `CURSOR_API_KEY` 或 `CURSOR_AUTH_TOKEN`，原样经第 2 层传入。这与 server 的登录预检（`CREDENTIAL_ENV_KEYS.cursor`）
     和 `OWN_CREDENTIAL_KEYS.cursor` 一致，runner 的 `hasInjectedCredentials(cursor)` 读的也是这三个变量。
  3. 都没有时，用 Default 账号已存的登录（`<orbit home>/cursor/default/xdg-config/cursor/auth.json` 的 accessToken，以 `CURSOR_AUTH_TOKEN` 注入；
     剩余不足 300 s 算过期，不用）。
  4. 一个都没有：不启动 CLI，会话以「需要登录」（`Failed to authenticate: …`）结束。
- agent 跑的命令经 orbit-bash（SHELL）执行：还原真 HOME，unset `CURSOR_API_KEY`、`CURSOR_AUTH_TOKEN`、`XDG_CONFIG_HOME`、`CURSOR_CONFIG_DIR`、
  `CURSOR_DATA_DIR`；工作区的其他变量照常可见。
- `initialize` 用 §2.2 的请求。`session/new` 或 `session/load` 一律带上 `mcpServers`（Orbit MCP 等），load 时重新给。
- 模型用 `set_config_option`（参数化选择器），不用 `--model`。新会话默认 Auto（`default` / `default[]`）。
- 健康检查（P3）：`--version` 等于固定版本；`agent models` 退出码 0，说明凭据有效、能联网。不要用 `status`（它不认 API key）。

### 16.4 事件映射（P5a）

| ACP | Orbit |
| --- | --- |
| `agent_message_chunk` | 正文增量（按轮累加；先过 §12 的错误句子匹配） |
| `agent_thought_chunk` | 思考增量 |
| `tool_call` / `tool_call_update` | 工具开始和进度；`completed` 是终态，rawOutput 带 `rejected`、`exitCode≠0` 或 `error` 时标为失败或被拒；取消、断开、崩溃后 Orbit 自己结算 `in_progress` 的卡 |
| `plan`、`cursor/create_plan` | 计划展示；create_plan 要应答 |
| `cursor/update_todos` | 待办列表（请求，回 `{}`） |
| `subagent_spawned` / `subagent_state_update` + 子会话的更新 | 子代理卡（需要 `_meta.subagents`）；`cursor/task` 回 `{}` |
| `session_info_update` | 会话自动标题（可能晚于轮次结束） |
| `available_commands_update` | 斜杠命令列表 |
| `current_mode_update` | 模式变更回显 |
| `session/request_permission` | 审批卡；按 §5.2 关联工具卡 |
| `cursor/ask_question` | 提问卡（【待验】，没有就当作不会发生，但必须能应答） |
| `session/prompt` 回复 | 轮次结算：`end_turn`（先检查错误句子）/ `cancelled` |
| 上下文用量 | 不可用（ACP 不上报） |

### 16.5 权限模式映射（P5c，按 §5.4 的事实）

| Orbit 模式 | 启动参数 | Orbit 对权限请求的处理 |
| --- | --- | --- |
| `bypassPermissions`、`auto` | `--force` | 照常应答（团队否决时仍会来请求） |
| `acceptEdits` | 默认 | 审批卡 |
| `dontAsk` | 默认 | 一律 `reject-once`（工作区写不受控，界面要说明） |
| `plan` | 默认 + `set_mode plan` | 一律 `reject-once` |
| `default` | — | **不提供**（编辑前要问做不到），或作为 `acceptEdits` 的别名明确告诉用户 |

受保护模式（除 bypass/auto 外）一律加 `--disable-project-configs` 和 `DIRENV_DISABLE=1`。用户级 `~/.cursor` 配置的处理取决于 D4。

### 16.6 错误分类（P5b）

见 §12 表的最后一列。实现要点：

1. JSON-RPC 错误只出现在建会话或设置阶段。
2. 轮内错误按固定句子匹配：`Upgrade your plan to continue` 是额度或限流；`Request blocked … usage guidelines` 是内容被拒；
   `Please sign in to continue` 或 `[unauthenticated]` 是认证。
3. 收不到回复、stdout 关闭，是进程异常。
4. `-32603 "Failed to initialize session services"` 用 `agent models` 二次判定是凭据还是网络。

### 16.7 D1–D5 小结

| 待定项 | 事实 | 建议 |
| --- | --- | --- |
| D1 索引 | §14.3：只在隐私模式 4 时上传完整文件内容；本账号 0 字节；`--disable-indexing` 不影响功能 | 默认加 `--disable-indexing`；worker 的 npx 下载另行决定 |
| D2 署名 | §14.4：客户端只发开关，文本由服务端定；没测到实际 trailer | 沿用默认；要关就写账号 cli-config |
| D3 显示名 | CLI 自称 "Cursor Agent" / "Cursor CLI"（`about` 标题 "About Cursor CLI"） | 采用 "Cursor CLI"，内部名 `cursor` |
| D4 隔离 | §8.4：只有 HOME 能挪走 `~/.cursor`，命令环境继承一切；凭据可以用环境变量注入 | 先补验 A（SHELL 包装）；不成立就请所有者在 B 和 D 之间选 |
| D5 换账号 | §13：同一身份下搬运加续聊实测可行；团队固定在进程上；跨账号没测 | 验证前只允许没说过话的会话换账号 |

---

## 17. 待验清单与证据边界

### 17.1 待验（实现不得当作已支持）

1. 仓库配置的运行期效果：cli.json 放宽白名单、hooks 在 prompt 和工具执行时的触发来源、rules/AGENTS/CLAUDE 进入上下文、`--disable-project-configs` 和 `--exclude-workspace-context` 的运行期效果。
   场景 `repo-config-baseline`、`repo-config-with-flags` 已写好（额度用尽）。
2. 轮中断网的形状（场景 `network-drop-mid-turn`）。
3. D4 方案 A：SHELL 包装（场景 `shell-wrapper-env`）。
4. `cursor/ask_question` 的实际触发和不应答表现（服务端在 agent 模式不给 AskQuestion）。
5. 提交署名的 trailer 文本；后台命令结束后是否开新一轮（场景 `background-shell-and-commit` 撞上额度用尽）。
6. 远程设备完成登录；浏览器登录 token 的寿命和过期表现；`agent logout` 对登录账号的效果（场景 `login-account`）。
7. 跨账号或跨团队续聊（D5），以及不同账号的模型目录差异。
8. 团队管理员否决 Run Everything（没有团队账号）；限流的形状；轮中认证失效的形状。
9. deny 规则的强制力；`approvalMode: unrestricted`；`channel: static`；`--disable-codebase-ref` 对回答质量的影响；用别的 cwd load 会话。
10. 审批进行中取消、审批中断开连接的行为。
11. macOS（P0b）、Linux arm64、其他发行版。

额度在 2026-10-24 重置（或换一个付费账号的 key），然后执行：

```sh
node scripts/cursor-p0/reproduce.mjs --only repo-config-baseline,repo-config-with-flags,network-drop-mid-turn,shell-wrapper-env,background-shell-and-commit,ask-question
```

需要 6 次 prompt。所有者完成登录后，再加 `login-account`（1 次）。

### 17.2 运行期断言写错的场景（事后分析）

下列场景录制完整，但运行时的断言有误，原因分两类：一是脚本缺陷，读会话库时没拷 WAL，场景在 prompt 完成后抛错；二是预期被真 CLI 推翻。
[`scripts/cursor-p0/analyze.mjs`](../scripts/cursor-p0/analyze.mjs) 只读已提交的协议录制和运行目录里的产物，重新计算更正后的断言，结果写在 `analysis/<场景>.json`。
它不启动 CLI，也不发 prompt。场景脚本也已改成更正后的断言，以后重跑会直接得到这些结果。

| 场景 | 原因 | 更正后的断言 |
| --- | --- | --- |
| `multi-turn-tools-default` | 断言要求模型复述 orbit 返回的任务标题，ACP 本来就不带 MCP 结果内容 | 2/2 成立 |
| `permission-force`、`permission-auto-review` | 读会话库没拷 WAL，抛错 | 5/5、5/5 成立 |
| `plan-and-ask-modes-concurrent` | 预期 plan/ask 只读，实测不是 | 7/7 成立 |
| `ask-question` | 预期模型调用 AskQuestion，服务端没给这个工具 | 2/2 成立 |
| `background-shell-and-commit` | 撞上额度用尽，记成额度用尽样本 | 3/3 成立 |
| `crash-recover-and-move` | 在 load 后立刻找补出的工具结果，实际要到下一轮才写 | 1/1 成立 |
| `crash-continue-and-shell-wrapper` | 包装脚本名不含 `bash`，CLI 没用它（本身就是一条实测结论） | 2/2 成立 |

`crash-continue-and-shell-wrapper` 是旧的场景定义（现拆成 `crash-continue` 和 `shell-wrapper-env`），`summary.json` 里标 `current:false`。

### 17.3 证据边界

- 所有【实测】都来自一个 Free 套餐的个人账号（不属于任何团队，隐私模式 3），一把 User API Key，Auto 模型。付费套餐、团队账号、其他隐私模式的表现可能不同。
- Auto 会路由到不同的模型，正文措辞每次不同。断言只看 CLI 的行为（权限请求、工具卡、文件、副作用日志），不看模型说了什么，例外都注明了。
- 本次的真实 prompt 账本：20 次。第 2、3 次是脚本缺陷造成的（`--selftest` 驱动了真 CLI），它们的协议录制丢失，产物事后检查过（见 [exploration/README.md](evidence/cursor-cli/2026.10.14-941492e/exploration/README.md)）。

---

## 附录：证据索引

| 文件 | 内容 |
| --- | --- |
| [`summary.json`](evidence/cursor-cli/2026.10.14-941492e/summary.json) | 版本、哈希、平台、Orbit 提交、每个场景的结论、事后分析、真实 `~/.cursor` 前后状态 |
| [`scenarios/`](evidence/cursor-cli/2026.10.14-941492e/scenarios/) | 每个场景的断言和数据 |
| [`protocol/`](evidence/cursor-cli/2026.10.14-941492e/protocol/) | 双向录制（脱敏）：`client->agent`、`agent->client`、`stderr`、`spawn`、`exit`、`signal`、`cli` |
| [`analysis/`](evidence/cursor-cli/2026.10.14-941492e/analysis/) | §17.2 的事后分析 |
| [`incidents/`](evidence/cursor-cli/2026.10.14-941492e/incidents/) | 额度用尽、模型拒答两份真实错误样本 |
| [`exploration/`](evidence/cursor-cli/2026.10.14-941492e/exploration/) | 写脚本之前的第一次真实 prompt |
| [`prompts-ledger.json`](evidence/cursor-cli/2026.10.14-941492e/prompts-ledger.json) | 真实 prompt 账本 |
| [`manifest.json`](evidence/cursor-cli/2026.10.14-941492e/manifest.json) | 上述文件的 SHA-256 |
| [`src/runner-go/testdata/cursor/`](../src/runner-go/testdata/cursor/) | 单进程回放样本（README、INDEX） |

复现命令见 [`scripts/cursor-p0/README.md`](../scripts/cursor-p0/README.md)。
