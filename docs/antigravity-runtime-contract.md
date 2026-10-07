# Antigravity CLI（`agy`）运行时契约（v1）

**状态**：项目「接入 Antigravity CLI 引擎」阶段 0 的产物。runner（阶段 1）和控制面/客户端（阶段 2）都按这份文件实现；
改这里的任何一条结论，要同时改依赖它的任务。

**实测版本**：**agy 1.2.15**。2026-10-03 在本机 runner（vmi3129740，linux/amd64，以 root 运行）上用官方脚本安装到
`/root/.local/bin/agy`，208,249,040 字节，sha512 前缀 `530bacc9a93610319695f4fd`。作业指导里 2026-10-02 在 1.2.14 上
得到的结论，这里在 1.2.15 上逐条重测过，差异见 §12。下文标【实测】的结论都来自 1.2.15；只来自官方文档、
本机没有复现的，标【文档】。

**方法**：真 agy 加本地 mock Gemini 服务 [`src/runner-go/testdata/mockgemini`](../src/runner-go/testdata/mockgemini)
（提示词里的 `mock:` 指令决定模型回什么），假 key。所有实验都用临时 HOME 和临时 gemini 目录，没有往任何人的
`~/.gemini` 写过东西。外连全部经 mock 的 HTTPS 代理记录并拒绝；遥测内容用自签 CA 加 TLS 拦截解开（§7）。
自升级的判断条件靠反汇编 agy 二进制确认（§6）。实验脚本在 [`docs/evidence/antigravity-cli-1.2.15/`](./evidence/antigravity-cli-1.2.15/)，
录下的 stream-json 样本在 [`src/runner-go/testdata/antigravity/`](../src/runner-go/testdata/antigravity/)。

**没做的**：runner 上没有真实 Gemini key，真实模型下的样本（真实思考、缓存命中、真实配额错误）还没录，待补项见 §11。
已经请 owner 提供 key（task 会话里 `ask_owner` 返回 403 `ASK_OWNER_COORDINATOR_ONLY`，改用了 notify）。

---

## 0. 一句话结论

1. **驱动**：每个会话一个常驻进程，`agy --gemini_dir=<会话目录> --print= --input-format stream-json --output-format stream-json --disable-slash-commands --print-timeout=0s …`，
   stdin 每行一条 `{"event":"user",…}`，每轮一个 `result`。（§1）
2. **配置隔离不用改 HOME**：隐藏 flag `--gemini_dir=<绝对路径>` 把整个 `~/.gemini`（settings、MCP、hooks、会话库）
   挪进 Orbit 自己的每会话目录。agent 跑的命令看到的仍是真 HOME，git/ssh 不受影响。（§3）
3. **自升级**：环境变量 `AGY_CLI_DISABLE_AUTO_UPDATE=true` 关掉，只认小写 `true`。不关的话，每次启动都会另起一个
   setsid 的 `agy --bg-updater`，**原地替换 agy 二进制**。（§6）
4. **数据收集**：settings.json 里写 `"enableTelemetry": false`。它只挡住错误报告；使用统计照样发往
   `play.googleapis.com/log`，在 1.2.15 里找不到能关掉它的设置。对话内容在两种模式下都没出现在上报里。（§7）
5. **轮次中插话**：一律排队，等当前轮 `result` 之后作为新一轮执行，不会打进当前轮；`queuedMessages` 在无头模式下无效。（§8）
6. **`result.status` 不能用来判成败**：会话里出过一次真实错误后，之后每一轮都报 `ERROR` 和那条旧错误。
   成败按本轮有没有 `error_message` 步骤、stderr 的 `AGY_ERROR`、进程退出码判断。（§2.4）
7. **会让进程退出的情况**：模型/接口错误（退出码 3）、CLI 自己处理的斜杠命令（2）、SIGINT/SIGTERM（1）。
   下一轮都用 `--conversation <id>` 重启续上。（§4）
8. **权限**：默认模式下，需要审批的操作被软拒绝，**整轮立即结束**，模型拿不到结果；deny 规则在
   `--dangerously-skip-permissions` 下仍然生效；PreToolUse hook 只在 skip 模式下才是唯一的闸门。（§5）
   阶段 3 起 Orbit 的 Default、Accept Edits 由 Orbit 自己的 PreToolUse hook 问人，agy 确认加载了 hook 才加 skip，否则拒绝启动。（§14）
9. **仓库里的 `.agents/hooks.json`、`.agents/mcp_config.json` 会被执行**，不管什么权限模式 → 受保护模式下应该拒绝启动，
   做法同 `guardKimiProjectMCP`。（§3.5）

---

## 1. 驱动命令

### 1.1 结论

**argv**（顺序无关；`--print=` 必须带等号）：

```text
agy --gemini_dir=<会话 gemini 目录，绝对路径>
    --print= --input-format stream-json --output-format stream-json
    --disable-slash-commands
    --print-timeout=0s
    [--conversation <conversation_id>]                       # 续会话（§4）
    [--model <基础名> --effort <low|medium|high> | --model <完整 slug>]   # §9，两种写法不能混用
    [--mode plan | --mode accept-edits | --dangerously-skip-permissions] # §5
```

**环境变量**：

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `GEMINI_API_KEY` | 用户的 key | settings 里 `modelProvider` 为 `gemini` 时必填，缺了启动就失败【文档】 |
| `GOOGLE_GEMINI_BASE_URL` | 可选 | 改模型端点；请求打到 `{base}/v1beta/models/{model}:streamGenerateContent?alt=sse`，key 走 `x-goog-api-key` 头【实测】 |
| `AGY_CLI_DISABLE_AUTO_UPDATE` | `true` | 关自升级（§6）。只认小写 `true` |
| `ORBIT_SESSION_ID` 等 | publicID | 原样传给 MCP 服务器、hook 和 agent 跑的命令【实测】 |
| `HOME` | **不改** | §3 |

工作目录 = 会话 checkout（execDir）。

**stdin**：每行一条 `{"event":"user","message":{"content":"…"}}`；`content` 也可以是 `[{"type":"text","text":"…"}]`【实测】。
只收文本，其他块类型会让会话以 `ERROR` 结束【文档】。不认识的 `event` 只在 stderr 警告一行【文档】。

**stdout**：每个进程开头一个 `init`，之后是 `step_update`，**每轮**结束一个 `result`（§2）。

**进程生命周期**【实测】：

| 退出方式 | 退出码 | 触发 |
| --- | --- | --- |
| 关闭 stdin | 0 | 当前轮跑完、发完 `result` 后退出 |
| SIGINT / SIGTERM | 1 | 中断（§4）。参数错误、`--model` 无效也是 1 |
| CLI 自己处理的斜杠命令、`control_request` | 2 | `/model` 等，Orbit 带 `--disable-slash-commands` 后不会出现（§10.1）；`--print` 后面直接跟 flag 也是 2；`control_request` 这一条是【文档】 |
| 模型或接口错误 | 3 | 无效 key、配额等（§2.4） |

### 1.2 实测（agy 1.2.15）

- 每轮一个 `result`、进程常驻、关 stdin 后退出 0：样本 `text-multiturn`，两轮两个 `result`，最后退出码 0。
- `--print --input-format …`（不带 `=`）：1.2.15 直接报错退出 2，
  `Error: --print took "--input-format" as its prompt, so the intended prompt was left as an argument and ignored.`
  （作业指导记录的 1.2.14 行为是下一个参数被当成提示词；1.2.15 改成了直接报错。）
- `--print-timeout`：help 写默认 `0s`（不限时），官方文档写 `5m`。实测让模型 315 秒后才回复，不带这个 flag
  也正常拿到 `SUCCESS`，没有超时。Orbit 仍显式传 `--print-timeout=0s`，防默认值以后变；这个写法实测可用。
- 启动耗时：页缓存热的时候，从 spawn 到 `init` 1–3 秒；本机第一次执行这个 208MB 的二进制用了约 12 秒。
- 完整推荐 argv（上面全部 flag 加 MCP、共享 bin 目录）跑两轮、一次命令、一次 MCP 调用全部正常（实验 `final`）。

---

## 2. 事件到 Orbit transcript 的映射

### 2.1 agy 的事件【实测】

```jsonc
{"event":"init","conversation_id":"…","init":{"cwd":"…","tools":[60 个工具名],"permission_mode":"request-review","model":"…"}}
{"event":"step_update","step_update":{"conversation_id":"…","step_index":N,"state":"ACTIVE|DONE|ERROR","step_type":"…", …}}
{"event":"result","result":{"conversation_id":"…","status":"SUCCESS|ERROR","response":"…","error":"…","duration_seconds":…,"num_turns":…,"usage":{…},"denied_actions":[…]}}
```

- `init` **每个进程只有一个**（Claude 是每轮一个）。`model` 只在传了 `--model` 时出现；`permission_mode` 是
  `request-review`、`always-proceed`（skip 模式或 `toolPermission: always-proceed`）或 `strict`。
- `init.tools` 列 60 个名字，但真正声明给模型的只有 15 个（`view_file`、`run_command`、`write_to_file`、
  `replace_file_content`、`read_url_content`、`search_web`、`ask_question`、子代理和任务类等），配了 MCP 再加
  `call_mcp_tool`、`list_resources`、`read_resource`。`list_dir`、`grep_search`、`find_by_name` 在 API key 模式下没有声明给模型。
- `step_index` 在整个会话里单调递增，换进程续会话也接着数。
- 见过的 `step_type`：`user_input`、`agent_response`、`tool`、`system_message`（续会话时注入）、`error_message`（真实错误）、
  `unknown`（`ask_question`）；官方文档还列了 `checkpoint`，mock 下没出现。
- `state`：`ACTIVE`、`DONE`，工具失败时是 `ERROR`。

### 2.2 映射表

| agy | Orbit（`types.go` 里的 ev*） |
| --- | --- |
| `init` | `evSystem {subtype:"init", sessionId: conversation_id, provider:"antigravity"}`；进程每次重启都会再来一次，要对比 id（§4.3） |
| `user_input` `DONE` | 不另发 transcript 事件（`evUser` 在写 stdin 时已经发过）；作为这条消息被 agy 收下的确认（`evUserDelivery` 的 `acknowledged`） |
| `agent_response` `ACTIVE` 带 `text_delta` | `evTextDelta {text}` |
| `agent_response` `DONE` 带 `text_delta` | 先 `evTextDelta`（最后一块），再 `evAssistant {text: 这个 step_index 所有 text_delta 拼起来}` |
| `agent_response` `DONE` 不带 `text_delta` | 不发 transcript 事件，只用它的 `usage` 更新上下文读数（这是一次函数调用的模型回复） |
| `tool` `ACTIVE` | `evToolUse {id: "<conversation_id>:<step_index>", name: 规范名, input: 规范化参数}`（§2.3） |
| `tool` `DONE` | `evToolResult {toolUseId, content: tool_info.output（没有就是空串）, isError:false}` |
| `tool` `ERROR` | `evToolResult {toolUseId, content: tool_info.error.message, isError:true}` |
| 被软拒绝的工具（§5.2：本轮 `result.response` 为空、`denied_actions` 非空、最后一个工具步骤既没有 output 也没有 error） | `evToolResult {isError:true, content:"需要审批的操作在当前权限模式下被拒绝：<权限>"}`，再发 `evError` 说明怎么放行 |
| 一轮结束时还没有结果的工具步骤（被中断、agy 退出或出错时正在跑的那个，永远走不到 `DONE`，§4.1） | 在 `evTurnEnd` 之前按调用顺序补 `evToolResult {isError:true, content:"Interrupted: the turn was stopped / failed while this tool was running."}`；不补的话，会话还开着时客户端会一直把这张卡片画成运行中 |
| `error_message` `DONE` | `evError {message: result.error，或 AGY_ERROR.short_error}` |
| `system_message`、`unknown`、`checkpoint` | 不发 transcript 事件，记日志（`logUnhandledStreamKind` 那一类） |
| `result` | `evTurnEnd {subtype, numTurns:1, costUsd:0, contextTokens, contextWindow}` 加 `TurnCompleteRequest`（§2.4、§9.3） |
| stderr 上的 `AGY_ERROR: {…}` | 解析出 `short_error`、`status`、`error_code`、`code_kind`、`retryable`、`error_id`，用来给错误分类（配额 → 限额重试那套，`API_KEY_INVALID` → 认证错误文案） |
| stderr 其他行 | `evSystem {stderr}`（同 OpenCode） |

**没有思考文本**：mock 每次都发了 `thought:true` 的 part，agy 也请求了 `includeThoughts:true`，但 stream-json 里
从来不出现思考内容，只有 `usage.thinking_tokens` 计数。所以不发 `evThinking`/`evThinkingDelta`。真实模型下待确认（§11）。

**正文分块**：agy 会合并上游的块（mock 两块 12 字的文本出来是一个 24 字的 `text_delta`），不要依赖分块边界。
最后一块总在 `DONE` 里；一段回复只有一块时，只有一个 `DONE`。

**工具参数是展示子集**【实测】：`run_command` 只给 `CommandLine`；`write_to_file`、`replace_file_content` 只给 `TargetFile`
（不给内容，也不给 diff）；`view_file` 只给 `AbsolutePath`；`call_mcp_tool` 给 `ServerName`、`ToolName`、`Arguments`；未知工具原样给全部参数。
文件改动靠 runner 自己的 worktree diff 展示。命令失败也是 `DONE`，**看不到退出码**，只有输出文本。
agy 的 functionCall id 在流里不出现，所以用 `conversation_id:step_index` 做 toolUseId，续会话后也唯一。

### 2.3 工具名规范化

和 `canonicalOpenCodeToolName` 同一个目的：让客户端现有的卡片能用。

| agy | Orbit 名 | input |
| --- | --- | --- |
| `run_command` | `Bash` | `{command: CommandLine}` |
| `view_file` | `Read` | `{file_path: AbsolutePath}` |
| `write_to_file` | `Write` | `{file_path: TargetFile}` |
| `replace_file_content`、`multi_replace_file_content` | `Edit` | `{file_path: TargetFile}` |
| `read_url_content` | `WebFetch` | `{url: Url}` |
| `search_web` | `WebSearch` | 原样 |
| `call_mcp_tool` | `mcp__<ServerName>__<ToolName>` | `Arguments` |
| 其他 | 原名 | 原样 |

`read_url_content`、`search_web` 以及未声明给模型的那些工具，参数名只从函数声明里读到，没在 stream-json 里实际见过，
阶段 1 用真 key 样本确认后再定。

### 2.4 一轮的成败怎么判

`result.status` 不可信【实测，样本 `resume-after-error`】：会话里第一次真实错误之后，之后**每一轮**的 `result` 都是
`"status":"ERROR"`，`error` 字段是那条旧错误，换进程续会话也一样；但这些轮次 `response` 正常、没有 `error_message` 步骤、
进程也不退出。runner 按下面的顺序判：

1. Orbit 自己发了中断 → `INTERRUPTED`（agy 这时报 `ERROR` + `"interrupted"`，不是文档里的 `INTERRUPTED`）。
2. 本轮出现 `error_message` 步骤，或者进程在这个 `result` 之后以 3 退出 → `FAILED`，原因取 stderr 的 `AGY_ERROR.short_error`，
   没有就用 `result.error`。
3. 被软拒绝（§5.2）→ 建议按 `FAILED`、subtype `permission_denied` 上报，让人看到为什么什么都没做。
4. 其余 → `SUCCEEDED`，**不管** `status` 写的什么。

用量：`result.usage`、`num_turns`、`duration_seconds` 都是**会话累计**，而且续会话后会把以前进程的也算进来
（实测续会话后 `duration_seconds` 是 1499 秒，那是从会话创建算起的时间）。每轮的 `Usage` 取本轮所有 `agent_response`
步骤 `usage` 的和；`numTurns` 固定报 1（同 Kimi）；agy 不报费用，`costUsd` 报 0。
字段对应【实测】：agy 的 `output_tokens` **已经包含**思考 token（mock 回 `candidatesTokenCount` 14、`thoughtsTokenCount` 6，
agy 报 `output_tokens` 20、`thinking_tokens` 6），`total_tokens` = `input_tokens` + `output_tokens`。所以 `TokenUsage.OutputTokens`
直接取 `output_tokens`，不要再加 `thinking_tokens`；`CacheReadInputTokens` 取 `cache_read_tokens`。

### 2.5 实测（agy 1.2.15）

- 流式文本、两轮累计：样本 `text-multiturn`（第二轮 `num_turns:2`，`usage` 等于两轮之和）。
- 工具五种结局：样本 `tools-skip-permissions`。
- 真实错误：样本 `error-invalid-key`（`error_message` → `result` ERROR → stderr
  `AGY_ERROR: {"short_error":"…API key not valid…","status":"INVALID_ARGUMENT","error_code":400,"code_kind":"http","retryable":false,…}` → 退出 3）；
  样本 `error-quota-429`（RetryInfo 40s，不重试，`retryable:true`，退出 3）。
- 粘住的 ERROR：样本 `resume-after-error`（两轮回复 `A ok`、`B ok` 都正常，两个 `result` 都是旧的 400）。
- 中断后续会话的那一轮是 `SUCCESS`，中断不会粘住（实验 `t06c`）。

---

## 3. 配置隔离

### 3.1 结论

**用 `--gemini_dir=<绝对路径>`，HOME 不改。** 这个 flag 不在 `--help` 里，但它把 agy 解析 `~/.gemini` 的那一层整个换掉了：
settings.json、`config/mcp_config.json`、`config/hooks.json`、会话库、日志、更新器状态都落在这个目录下，真 HOME 一个文件都不碰。
（日志里能看到它的默认值是相对路径 `.gemini`，校验不过才回落到 `$HOME/.gemini`：
`Failed to resolve GeminiDir ".gemini": .gemini must be an absolute path … falling back to default`。）

每会话目录建议放在会话的 scratch 目录下（例如 `<scratchDir>/antigravity`），布局：

```text
<gd>/antigravity-cli/settings.json   Orbit 写：{"modelProvider":"gemini","enableTelemetry":false,"permissions":{…}}
<gd>/config/mcp_config.json          Orbit 写：{"mcpServers":{"orbit":{…}}}（格式同 Kimi 的 mcp.json）
<gd>/config/hooks.json               阶段 3 的审批闸门（§5.4）
<gd>/antigravity-cli/bin  ->  runner 共享目录    agy 每个新目录都会解出一个 17MB 的 webm_encoder；软链共享后只解一次
<gd>/antigravity-cli/{conversations,brain,log,…}   agy 自己写；续会话靠它们，会话存续期间不能删
```

- **续会话要用同一个目录**：会话库在 `<gd>/antigravity-cli/conversations/<id>.db` 和 `brain/<id>/`。
  换目录续会话 = id 找不到 = 悄悄开新会话（§4.3）。scratch 目录在会话恢复时会被重用（同 Kimi 覆盖层），满足这个要求。
- **不借用户自己的 `~/.gemini`**：用 API key 认证不需要任何登录状态，所以和 Kimi 覆盖层不同，这里**什么都不链回真目录**。
  用户在自己 `~/.gemini` 里配的 GEMINI.md、技能、插件、MCP 对 Orbit 会话不可见；这是有意的，原则同
  `writeKimiHomeMCPConfig`：会话看到的 MCP 配置就是 agent 配置的全部。
- **hooks 写进 `config/hooks.json`**。官方文档说也可以写在 CLI 的 settings.json 里；把和 hooks.json 相同的结构放进
  settings.json 的 `hooks` 键，1.2.15 不加载（文档没给 settings.json 里的具体写法，只试了这一种）。
- `ANTIGRAVITY_EXECUTABLE_DATA_DIR` **不是**配置入口：这是 agy 设置给 sidecar 的输出变量（二进制里的文档原文是
  "A sidecar can read the full path of its data/ subdirectory from the ANTIGRAVITY_EXECUTABLE_DATA_DIR environment variable"），
  设了它不会改变 agy 读配置的位置。
- 另一个隐藏 flag `--app_data_dir` 只接受相对于 gemini 目录的路径。传绝对路径会直接启动失败
  （`Failed to start: must not be absolute`），而且失败前已经往真 `~/.gemini` 里写了日志。**不要用。**

### 3.2 agent 跑的命令看到的环境【实测】

HOME 是真 HOME；`ORBIT_*` 原样传入；agy 另外加了 `ANTIGRAVITY_AGENT=1`、`ANTIGRAVITY_APP_DATA_DIR=<gd>/antigravity-cli`、
`ANTIGRAVITY_CONVERSATION_ID`、`ANTIGRAVITY_TRAJECTORY_ID`、`ANTIGRAVITY_PROJECT_ID`、`ANTIGRAVITY_SOURCE_METADATA`（本次工具调用的 JSON）、
`ANTIGRAVITY_LS_ADDRESS` 和 `ANTIGRAVITY_CSRF_TOKEN`（本机 language server 的地址和令牌）、`GIT_PAGER=cat`、`PAGER=cat`。
**`GEMINI_API_KEY` 对 agent 跑的每条命令都可见**（MCP 服务器和 hook 也是）。这和其他引擎通过环境变量注入 provider key
是同一类暴露，阶段 4 做 Gemini 预设时要在界面上说明。

hook 进程的工作目录是 hooks.json 所在目录，环境同上（`ORBIT_SESSION_ID`、`ANTIGRAVITY_CONVERSATION_ID` 都有）。

**Google 模式（§16.10）多两处不同，agent 跑的命令、MCP 服务器和 hook 都继承：**

- `DBUS_SESSION_BUS_ADDRESS` 指向会话 gemini 目录下一个不存在的 socket（`unix:path=<gd>/absent-dbus`），让 agy 只用会话目录里的凭据副本、不碰桌面钥匙串（§16.2）。headless 服务器上本来就没有 session bus，影响可以忽略；桌面 Linux runner 上，要用用户 session bus 的命令（`notify-send`、`secret-tool`、`gio` 等）在这类会话里连不上。
- key 类环境变量被去掉（`*_API_KEY`、`*_ACCESS_TOKEN`、`*_REFRESH_TOKEN`、`*_AUTH_TOKEN`、`*OAUTH*`、`GOOGLE_APPLICATION_CREDENTIALS`、`GOOGLE_GEMINI_BASE_URL` 等，规则同登录和状态探测，`antigravityCredentialEnvKey`），workspace 自定义环境里的也一样：这类会话里 agent 的命令看不到它们。

凭据副本 `<gd>/antigravity-cli/antigravity-oauth-token` 在 agy 运行期间存在，agent 的命令读得到（`ANTIGRAVITY_APP_DATA_DIR` 就是它所在的目录）。这和 agent 本来就能读 runner 主目录下的凭据目录是同一类暴露：agent 和 runner 是同一个系统用户。

### 3.3 万一只能改 HOME

`--gemini_dir` 是隐藏 flag，以后的版本可能拿掉，所以阶段 1 的契约测试必须断言它仍然有效（真 HOME 下零新文件，
settings 从 gemini 目录读到）。真被拿掉时的退路是给 agy 一个覆盖层 HOME，影响和对策：

- **git 跟 `$HOME`**【实测】：`HOME=<空目录> git config --global --list` 直接报读不到 `.gitconfig`，commit 会丢掉
  `user.name`/`user.email`。对策：覆盖层里把真 HOME 的每个顶层条目都软链进来（`.gitconfig`、`.config`、`.ssh`、`.npmrc`、`go` 等），
  只有 `.gemini` 是 Orbit 自己的目录。思路同 `prepareKimiHomeOverlay`，只是方向反过来：Kimi 是"私有目录借真目录的几项"，
  这里是"真 HOME 全借、只换 `.gemini`"。
- **ssh 不受影响**：OpenSSH 用 passwd 里的家目录找 `~/.ssh`，不看 `$HOME`（OpenSSH 的已知行为，本机没有实测）。
- 命令在覆盖层 HOME 顶层**新建**的文件会留在覆盖层里，会话结束就没了。
- Go、npm、pip 等缓存路径默认从 HOME 推导，软链后指回真目录，不会重复下载。

### 3.4 实测（agy 1.2.15）

- 假的"真 HOME"里预先放一份**没有** `modelProvider` 的 settings.json，Orbit 目录里放有 `modelProvider` 的那份，
  加 `--gemini_dir` 运行：用的是 API key（Orbit 那份生效），真 HOME 下零新文件（实验 `e7a`）。
- 之后几十次运行，驱动程序每次结束都检查 HOME 下的新文件，全部是 "new files under HOME: none"。
- 本机用户自己的 `/root/.gemini` 在整个任务期间没有变化（只有 2026-10-02 01:17 UTC 留下的两个 `projects.json.*.tmp`，早于本任务）。
- `bin/` 软链到共享目录：第一个会话解出 `webm_encoder`，第二个会话日志里没有 "Installing/updating embedded webm_encoder"，
  文件 mtime 不变（实验 `wb1`/`wb2`）。
- settings.json 里写 `{"hooks":{…}}`：`loaded 0 named hooks`，命令照样执行（实验 `h_settings`）；同样的内容写进
  `<gd>/config/hooks.json`：`loaded 1 named hooks`，拒绝生效（实验 `h_cfg`）。

### 3.5 仓库自带的 `.agents/` 配置【实测，安全】

agy 会加载工作区里的 `.agents/hooks.json` 和 `.agents/mcp_config.json`：hook 在每次工具调用前执行，MCP 服务器在启动时就被拉起。
**这和权限模式无关**，默认模式下也一样。查找位置是 cwd 所在 git 仓库的根目录，不在 git 仓库里就只看 cwd，不会往父目录找
（实验 `r1`/`r2`/`r3`）。无头模式没有"信任这个工作区吗"的对话框，等于默认信任。

**对策**：照 `guardKimiProjectMCP` 的做法，受保护模式（除 `auto`、`bypassPermissions` 外）在 `<git 根，否则 cwd>/.agents/`
下发现 `hooks.json` 或 `mcp_config.json` 就拒绝启动，并说明原因。`.agents/plugins.json` 和插件目录也能带 hook 和 MCP，
1.2.15 没实测，闸门应该一并按"存在即拒绝"处理。

---

## 4. 中断与恢复

### 4.1 中断

**结论**：向 agy 的 **PID**（不是进程组）发 SIGINT，等它自己退出；它会先杀掉正在跑的命令的进程组，再发一个
`{"status":"ERROR","error":"interrupted","response":"<已经流出的部分>"}` 的 `result`，然后以 1 退出。SIGTERM 的表现完全一样。
被中断那一轮已经流出的文本会留在会话历史里，下一轮模型能看到。

进程关系【实测】：

| 进程 | 进程组 | agy 收到 SIGINT 后 | agy 被 SIGKILL 后 |
| --- | --- | --- | --- |
| `run_command` 的 shell 及其子进程 | **自己的会话**（agy 给它 setsid） | 被 agy 杀掉 | **变成孤儿继续跑** |
| agent 用 `setsid` 主动脱离的进程 | 自己的会话 | 逃掉（同其他引擎） | 逃掉 |
| hook 进程 | agy 的进程组 | 随 agy 结束 | 按 agy 进程组杀能清掉 |
| MCP 服务器 | agy 的进程组 | 随 agy 结束 | stdin 收到 EOF 后自己退出；不退出的按 agy 进程组杀能清掉 |
| `agy --bg-updater` | 自己的会话 | 比 agy 活得久，自己结束 | 同左；关掉自升级就不会有它（§6） |

**runner 的中断步骤**：

1. 不往 stdin 写任何东西，向 agy PID 发 SIGINT。（1.2.16 更正：发给整个进程组，见 §13。）
2. 最多等 10 秒（实测 0.8–1.3 秒就退出）。
3. 还没退：先按父进程号快照 agy 的直接子进程，把它们各自的进程组号记下来，再 SIGKILL agy 的进程组和这些记下来的组。
   "只杀自己记录过 PID 的进程组"这个约束不变，命令的进程组是在快照时记录的。必须先快照再杀：agy 一死，命令进程就被
   init 收养，按父进程号再也找不到。
4. 下一轮用 `--conversation <id>` 起新进程。

### 4.2 恢复

**结论**：新进程加 `--conversation <id>`，**用同一个 gemini 目录**。表现【实测，样本 `resume/`】：

- `init.conversation_id` 不变，`step_index` 接着数。
- 新消息后面会多一个 `system_message` 步骤；agy 往模型上下文里注入了一条
  "[Notice] All your subagents and background tasks have been stopped due to server restart…"。
- `num_turns`、`usage`、`duration_seconds` 都包含以前的进程。
- 报错退出后续会话可以续上，失败那一轮的用户消息留在历史里，但之后的 `result.status` 永远是 `ERROR`（§2.4）。

### 4.3 续会话失败的识别

`--conversation` 给了一个当前 gemini 目录里没有的 id 时，agy 只在 stderr 打一行
`warning: conversation "<id>" not found`，然后**悄悄开一个新会话**，`init` 里是新 id，退出码 0（样本 `unknown-conversation`）。
runner 必须比较 `init.conversation_id` 和请求的 id：不一致就发一条 `evSystem` 说明"之前的上下文没有了，已开新会话"，
并保存新 id。

### 4.4 实测（agy 1.2.15）

- 流式中途 SIGINT：6.199 秒发信号，6.211 秒出 `result`，7.462 秒退出码 1（样本 `interrupt-sigint-streaming`，实验 `t06a`）。
- SIGTERM 同样得到 `ERROR`/`"interrupted"`、退出码 1（实验 `t06d`）。
- 命令运行中 SIGINT：命令 `sh -c 'sleep 60 & …; sleep 61'`，agy 0.8 秒后退出，两个 sleep 都没了（样本 `interrupt-sigint-tool`，实验 `t06b`）。
  这个工具步骤停在 `ACTIVE`，没有 `DONE` 也没有 `ERROR`，`result` 直接跟在后面；1.2.16 上一样，由契约测试
  `TestAntigravityContractInterruptedToolGetsResult` 兜底（runner 补的结果见 §2.2）。
- 用 PID 文件追踪的版本：SIGINT 后 shell 和前台子进程消失，`setsid` 的孙进程还在；SIGKILL 后三个全部活着，
  shell 被 init 收养，各自在自己的会话里（实验 `t06g`/`t06f`）。
- hook 进程的 pgid 等于 agy 的 pid（`hooks.log` 里每条都是）；MCP 服务器在 agy 的进程组里，SIGINT 和 SIGKILL 之后都不见了（实验 `v_mcpint`/`v_mcpkill`）。
- 中断后续会话：请求里能看到被中断的那段部分回复作为 model 消息留在历史里（实验 `t06c`）。

---

## 5. 权限模式映射

### 5.1 结论（第一期，approvalSupport 为 none）

阶段 3 起 Default、Accept Edits 改走 Orbit 的审批 hook（§14）；本节的表对 Plan、Don't Ask、Auto、Bypass 仍然成立。

| Orbit 模式 | agy 参数 | 说明 |
| --- | --- | --- |
| `default` | 不加 | 需要审批的操作被软拒绝（§5.2）；Orbit 已存的权限规则翻译成 `permissions.allow` |
| `dontAsk` | 同 `default` | agy 无头默认模式本来就是"不问，直接拒" |
| `acceptEdits` | `--mode accept-edits` | 工作区内写、改放行；命令、工作区外读写、网页仍被拒 |
| `plan` | `--mode plan` | 连工作区内写都被拒 |
| `auto`、`bypassPermissions` | `--dangerously-skip-permissions` | 全部放行；**`permissions.deny` 规则仍然生效**。以 root 运行没有问题（不同于 Claude） |

规则翻译（写进 `<gd>/antigravity-cli/settings.json` 的 `permissions.allow` / `permissions.deny`）：
`Bash(git:*)` → `command(git)`，`Read(<路径>)` → `read_file(<路径>)`，`Edit`/`Write(<路径>)` → `write_file(<路径>)`，
`WebFetch(domain:<域名>)` → `read_url(<域名>)`，`mcp__<s>__<t>` → `mcp(<s>/<t>)`，整个 server 用 `mcp(<s>/*)`。
不管用户存了什么规则，默认、`dontAsk`、`acceptEdits` 三种模式下都要加上 `mcp(orbit/*)`：MCP 调用默认需要审批，
不加的话 agent 连 Orbit 自己的工具都会被软拒绝（§10.3）。
语法【文档】：`command(<前缀>)` 按词元前缀匹配，`command(regex:<模式>)` 每个词元按锚定正则匹配，优先级 Deny > Ask > Allow。

### 5.2 默认模式下的"软拒绝"【实测】

需要审批而无头模式没法问人的操作：

- 工具步骤正常走完 `ACTIVE` → `DONE`（有时是 `ERROR`，消息是 `permission check failed for … user denied permission …`），没有输出；
- **这一轮立刻结束**，模型拿不到工具结果，`result.response` 为空、`status` 仍是 `SUCCESS`；
- `result.denied_actions` 是**整个会话累计、按动作去重的集合**（比如 `[{"action":"command","display_name":"RunCommand"}]`），
  同类动作第二次被拒时它不变，不能靠做差判断本轮有没有被拒；
- stderr 每轮一行 `jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. …`
  （列的也是累计的权限名）；
- 进程不退出，下一轮照常（样本 `denied-default`）。

所以 runner 按 §2.2 那一行判定"本轮被软拒绝"：`response` 为空、`denied_actions` 非空、本轮最后一个工具步骤既没有 output 也没有 error。

### 5.3 实测矩阵（agy 1.2.15）

每种设置一个进程，每轮只试一个工具（实验 `p_*`、`q_*`、`x_*`）。"拒" = 软拒绝、整轮结束：

| 设置 | 命令 | 工作区内写 | 工作区内改 | 工作区外写 | 工作区外读 | 工作区内读 | 网页 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 默认（`request-review`） | 拒 | 拒 | 拒 | 拒 | 拒 | **放行** | 拒 |
| 默认，工作区是 git 仓库 | 拒 | 拒 | — | — | — | — | — |
| `--mode accept-edits` | 拒 | 放行 | 放行 | 拒 | 拒 | — | 拒 |
| `--mode plan` | 拒 | 拒 | 拒 | 拒 | 拒 | — | 拒 |
| `--dangerously-skip-permissions` | 放行 | 放行 | 放行 | 放行 | 放行 | — | 放行 |
| settings `toolPermission:"always-proceed"` | 放行 | 放行 | 放行 | 放行 | 放行 | — | 放行 |
| settings `toolPermission:"strict"` | 拒 | 拒 | 拒 | 拒 | 拒 | — | 拒 |
| settings `allowNonWorkspaceAccess:true` | 拒 | 拒 | 拒 | 拒 | **放行** | — | 拒 |
| `artifactReviewPolicy:"always-proceed"` | 拒 | 拒 | — | — | — | — | — |

规则：

- `allow: ["command(echo)"]`：`echo hi` 放行，`echo hi > redir.txt` 仍被拒（官方文档说简单重定向照样按前缀匹配，实测不是）。
- `allow: ["write_file(<工作区绝对路径>)"]`：工作区内写放行。
- `allow: ["command(*)","write_file(*)","read_file(*)","read_url(*)","mcp(*)"]`：不加 skip 也全部放行，`permission_mode` 仍是 `request-review`。
- skip 模式加 `deny: ["command(rm)"]`：`rm -f a.txt`、`rm -f b.txt > /dev/null 2>&1`、`true && rm -f c.txt` **全部被拦**，
  工具 `ERROR`（`Permission denied for command(…). Matches user-configured deny rule`），模型继续；`regex:rm.*` 同样有效。
- skip 模式加 `deny: ["write_file(<文件>)"]`：被拦。
- 例外：skip 模式加 `deny: ["command(echo)"]` **没拦住** `echo hi > cmd-ran.txt`，看起来 agy 对 echo 有特殊处理。
  deny 规则对常规命令可靠，但不要把它当成对 shell 内建命令的安全边界。

### 5.4 第二期：PreToolUse hook 审批闸门【实测】

阶段 3 的实现，以及在 1.2.16 上补测的 hook 行为（哪些回答会放行、哪些工具不经过 hook、hooks.json 会被重读），见 §14。

- hook 写在 `<gd>/config/hooks.json`：`{"<名字>":{"PreToolUse":[{"matcher":"","hooks":[{"type":"command","command":"<绝对路径> …","timeout":600}]}]}}`。
  `matcher` 写 `""`、`".*"` 或者省略都匹配所有工具。
- 只有在 `--dangerously-skip-permissions` 下 hook 才是唯一闸门：
  - 回 `{"decision":"deny","reason":"…"}` → 工具 `ERROR`，消息是 `tool call denied by pre-tool hook: <reason>`，模型收到并继续（样本 `hook-deny`）；
  - 回 `allow` → 执行；
  - 超时被杀 → 工具 `ERROR`（`JSON hook "jsonhook__<名字>_PreToolUse_0_0" failed: command failed: signal: killed`），不执行（`timeout:3` 加 `sleep 10`，4.09 秒失败）。
- 默认模式下 hook 回 `allow` **越不过**软拒绝：hook 执行了，命令仍然没跑，本轮照样以空回复结束（实验 `h_allow_default`）。
- hook 收到的 stdin：`toolCall {name, args}`（`args` 是**完整**参数，比 stream-json 里的展示子集全）、`stepIdx`、`conversationId`、
  `workspacePaths`、`transcriptPath`、`artifactDirectoryPath`、`modelName`。
- **启动前校验**：`agy --gemini_dir=<gd> --print=/hooks --output-format json` 返回
  `command.data.hooks[]`，每项有 `name`、`enabled`、`source`（hooks.json 的绝对路径）、`actions[].event/command/timeout_seconds`。
  只有在列表里看到 Orbit 自己那条、并且来源是 Orbit 的 gemini 目录时，才加 `--dangerously-skip-permissions`。
- **运行中心跳**：`PreInvocation`（写法是 `{"<名字>":{"PreInvocation":[{"type":"command","command":"…"}]}}`，**没有** matcher/hooks 那层嵌套）
  在每次模型调用前触发一次，负载带 `invocationNum`；`PostInvocation` 对应调用后；`Stop` 在轮次结束时触发，负载带 `terminationReason`。
  把 PreInvocation 写成嵌套格式不会报错，但整个文件里的 hook 都不触发。
- 仓库里的 `.agents/hooks.json` 也会执行（§3.5）：闸门 hook 必须和"拒绝仓库 hook"一起上。

---

## 6. 自动升级策略

### 6.1 机制【实测】

- 每次启动（无头模式也一样），agy 在初始化完成时拉起子进程（日志 `auto_updater.go:334] Spawned background update process with PID …`）
  `agy --bg-updater --release_base_url=<发布服务器> --app_data_dir=antigravity-cli --gemini_dir=<gd>`。
  它**自己 setsid**，不在 agy 的进程组里，agy 退出后还会继续跑完。
- 它请求 `<base>/manifests/linux_amd64.json`（真实服务器 `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app`，
  内容是 `{"version","url","sha512"}`），版本更新就下载 tar.gz、校验 sha512，然后**原地替换正在运行的那个二进制**，
  旧文件改名成同目录下的 `agy.<随机数>.old` 留着。状态写进 `<gd>/antigravity-cli/updater/update_status.json`
  （`{"success":true,"message":"Update successful, restart CLI to use"}`），锁是同目录的 `update.lock`。
- 正在跑的会话不受影响，下一次 spawn 就是新版本。
- 有基于 `last_check.timestamp` 的检查间隔（代码里的 `ttlStillFresh`），但这个文件在 gemini 目录里；每会话一个目录时，
  每个新会话都会检查一次。

### 6.2 关闭

**`AGY_CLI_DISABLE_AUTO_UPDATE=true`，只认小写 `true`。** 反汇编 `updater.triggerUpdateShared` 看到的逻辑是
`os.Getenv("AGY_CLI_DISABLE_AUTO_UPDATE")` 长度为 4 且等于 `"true"` 才跳过；`1`、`TRUE`、`yes` 都无效。
函数第一个参数为真时整个检查被跳过。按调用关系推断，那是显式执行 `agy update` 的路径，也就是说 `agy update`
不受这个变量限制，正好用作受控升级（推断，未实测：本机已是最新版，`agy update` 不会有动作）。

### 6.3 固定版本

安装脚本和更新器都只认"最新版"的 manifest，没有按版本号安装的入口；tar.gz 的 URL 里带构建号
（`…/antigravity-cli/1.2.15-5434575321694208/linux-x64/cli_linux_x64.tar.gz`），猜不出别的版本。所以"固定版本"的办法是：

1. Orbit 起的每个 agy 都带 `AGY_CLI_DISABLE_AUTO_UPDATE=true`，二进制只在 Orbit 决定时才变；
2. 升级由 Orbit 发起：下载新版到旁边、跑契约测试（项目约束：升级 agy 前先跑契约测试），通过才替换。
   安装脚本发现目标位置已经有 `agy` 就直接退出（`Notice: 'agy' is already installed …`），重装得先删旧文件；
   `agy update` 也是一条路，但见 §6.2 的说明；
3. runner 把 `agy --version` 和二进制 sha512 上报（同模型目录一起），便于对照契约测试跑的是哪个版本。

注意：用户自己在终端里跑 agy 时没有这个变量，那次启动照样可能把同一个二进制升级掉。要完全固定，就把 Orbit 用的 agy
装在 runner 自己的目录里（安装脚本支持 `--dir`），不和用户的 `~/.local/bin/agy` 共用。

### 6.4 安装脚本的副作用（`engineinstall.go` 要知道）

- 官方脚本把二进制放到 `~/.local/bin/agy`（`--dir` 可改），然后执行 `agy install`。
- 在本机真实 HOME 下，`agy install` **往 `/root/.bashrc` 和 `/root/.profile` 各追加了一行** `export PATH="/root/.local/bin:$PATH"`
  （`.bashrc` 里本来就有一行等价的，追加的是重复行）。在没有 `.bashrc`/`.profile` 的临时 HOME 里试装时，它不会新建这两个文件，
  只在 PATH 里缺 `~/.local/bin` 时打印一句提示。
  这两行是本任务第 1 步按要求用官方脚本安装时留下的，**没有删**。
- `agy install` 支持 `--skip-path`（不改 shell 配置）、`--skip-aliases`。Orbit 自己装的时候：下载 manifest 和 tar.gz、
  校验 sha512、解出 `antigravity` 放到目标目录，跳过 `agy install` 或带 `--skip-path` 执行。

### 6.5 实测（agy 1.2.15）

- 用隐藏 flag `--release_base_url` 把更新器指向 mock，manifest 写一个假的 1.2.99：在 agy 的一份**副本**上跑一轮，
  副本从 208,249,040 字节被换成 2,238,250 字节的假二进制，旁边留下 `agy.1790999355499163734.old`（实验 `u1`）。
- 同样设置加 `AGY_CLI_DISABLE_AUTO_UPDATE=1`：照样被替换（实验 `u2`）。
- 加 `AGY_CLI_DISABLE_AUTO_UPDATE=true`：日志 `auto_updater.go:247] Auto-update disabled via environment variable AGY_CLI_DISABLE_AUTO_UPDATE`，
  没有 `updater/` 目录，mock 没收到 manifest 请求，二进制哈希不变（实验 `u3`）。
- 进程树快照里能看到 `--bg-updater` 子进程的 pgid 和 sid 都等于它自己的 pid。
- 真实发布服务器在 2026-10-03 返回的最新版本是 1.2.15（与已装版本相同）。

---

## 7. 交互数据收集

### 7.1 结论

owner 已决定 Orbit 起的会话默认关闭。做法：每会话的 settings.json 里写 `"enableTelemetry": false`。这是官方文档写明的开关，
也是唯一测到有效果的设置，但**它关不全**：

| 外发 | 默认 | `enableTelemetry:false` 之后 |
| --- | --- | --- |
| 错误报告（带 Go 堆栈的 `LS_ERROR`） | 发 | **不发** |
| 使用统计（Clearcut，`https://play.googleapis.com/log`） | 发，一轮会话约 200 KB | **照发**，约 197 KB |
| 功能开关（`antigravity-unleash.goog` 的 register 和 features） | 发 | 照发 |
| 自升级 manifest | 发 | 照发（要靠 §6 的变量关） |

使用统计里有：安装 ID、`machineId`、版本和平台、各类性能/事件指标、系统提示词的段落名和工具 schema、工作区路径、
trajectory/会话 ID、本次工具调用的 `toolSummary`/`toolAction`（模型写的那句动作描述）。**对话内容没出现**：
用户提示词、命令行、工具输出在开和关两种情况下都搜不到。

`~/.gemini/config/config.json` 里的 `telemetryEnabled:false` 没有任何效果。没找到能关掉 Clearcut 的环境变量或 flag。

在 API key 模式下，提示词和回复直接发给 Gemini API，按 Gemini API 的条款处理（免费层和付费层的数据使用规则不同，以 Google 当前条款为准），
这不受 agy 设置控制。

**如果要求一字节都不外发**，只能在网络层挡：agy 对这些主机连不上完全无所谓，本任务所有运行都拒了它们，功能不受影响。
但给 agy 设 `HTTPS_PROXY` 会传给 agent 跑的每条命令，等于把 agent 的网络也接管了；按主机名在 runner 机器上屏蔽
`play.googleapis.com`、`antigravity-unleash.goog` 是全机生效的。两种都需要 owner 决定，第一期默认只写 `enableTelemetry:false`。

### 7.2 实测（agy 1.2.15）

用自签 CA 加 `SSL_CERT_FILE` 让 agy 信任本地拦截代理（agy 认这个变量），代理全部本地应答、不外发，同一个剧本（一轮，含一次命令）跑四次（实验 `m1`–`m4`）。
发往 `play.googleapis.com/log` 的各次请求体大小：

| 运行 | 设置 | 请求体（字节） | 错误报告 | 工作区路径 |
| --- | --- | --- | --- | --- |
| `m1` | 都不设 | 201,890 / 2,995 / 883 / 142 | 有 | 有 |
| `m2` | settings `enableTelemetry:false` + config.json `telemetryEnabled:false` | 197,214 / 882 / 142 | 无 | 有 |
| `m3` | 只设 settings `enableTelemetry:false` | 197,217 / 882 / 142 | 无 | 有 |
| `m4` | 只设 config.json `telemetryEnabled:false` | 2,995 / 201,940 / 882 / 142 | 有 | 有 |

2,995 字节那一条是错误报告（`LS_ERROR`，内容是 "google mode unexpectedly requested in an external build" 加完整堆栈）。
另外，一轮拖了 5 分钟的会话里，agy 每约 5 秒重试一次上报，被拒了 100 多次也不影响回复。

---

## 8. 轮次中再发消息

### 8.1 结论

当前轮还没结束时往 stdin 再写一条 `user`，agy **排队**：等当前轮的 `result` 出来之后，把它作为独立的新一轮执行，
有自己的 `user_input` 步骤和自己的 `result`。它**不会**被注入正在进行的这一轮，也不会打断这一轮。
settings 里的 `"queuedMessages": "send-immediately"`（1.2.14 新加的 TUI 选项）在无头模式下**没有效果**。

Orbit 的做法：

- 不声明 steer 能力（`providerRuntime.steersMidTurn = false`），收到 `steer` 用 `refuseUnsupportedSteer` 拒绝，同 OpenCode、Kimi。
- 普通的下一条消息由 Orbit 自己排队，**等 `result` 之后再写进 stdin**。不要提前写：提前写进去的那条会在中断时随进程一起丢掉
  （中断 = SIGINT = 进程退出）。

### 8.2 实测（agy 1.2.15）

四种组合，结果相同（实验 `t07a`–`t07d`，样本 `midturn-message-queued`）：

| 第二条消息写入时 | `queuedMessages` | 结果 |
| --- | --- | --- |
| 模型调用进行中（mock 6 秒后才回复） | 默认 | 第一轮先 `result`，第二条再作为第二轮 |
| 模型调用进行中 | `send-immediately` | 同上 |
| 命令运行中（`sleep 6`） | 默认 | 同上 |
| 命令运行中 | `send-immediately` | 同上 |

mock 记录的请求体证实：第一轮在工具结果之后的那次模型请求里只有第一条消息；第二条消息只出现在第一轮结束之后的请求里。

---

## 9. 模型目录与用量

### 9.1 模型列表【实测】

`agy --gemini_dir=<gd> models`（gemini 目录里有 `modelProvider: gemini`、环境里有 key）离线可用，不需要联网，
stdout 是 TSV（`slug\t显示名`），stderr 有一行 `Fetching available models...`。1.2.15 的输出：

```text
gemini-3.8-flash-high	Gemini 3.8 Flash (High)
gemini-3.8-flash-medium	Gemini 3.8 Flash (Medium)
gemini-3.8-flash-low	Gemini 3.8 Flash (Low)
gemini-3.7-flash-high	Gemini 3.7 Flash (High)
gemini-3.7-flash-medium	Gemini 3.7 Flash (Medium)
gemini-3.7-flash-low	Gemini 3.7 Flash (Low)
gemini-3.6-flash-high	Gemini 3.6 Flash (High)
gemini-3.6-flash-medium	Gemini 3.6 Flash (Medium)
gemini-3.6-flash-low	Gemini 3.6 Flash (Low)
gemini-3.1-pro-high	Gemini 3.1 Pro (High)
gemini-3.1-pro-low	Gemini 3.1 Pro (Low)
```

没有 `modelProvider` 时它要求登录（`Please sign in to view available models`）。agy 不读 API 的 `GET /v1beta/models`。

### 9.2 slug 到请求的映射【实测】

| 传给 agy | 请求的 API 模型 | `thinkingConfig` |
| --- | --- | --- |
| `--model gemini-3.8-flash-high` | `gemini-3.8-flash` | `includeThoughts:true, thinkingBudget:-1` |
| `--model gemini-3.8-flash-medium` | `gemini-3.8-flash` | `thinkingBudget:4000` |
| `--model gemini-3.8-flash-low` | `gemini-3.8-flash` | `thinkingBudget:1000` |
| `--model gemini-3.1-pro-high` | `gemini-3.1-pro-preview` | `thinkingBudget:-1` |
| 不传 `--model`（标签 "Gemini 3.1 Pro (Low)"） | `gemini-3.1-pro-preview` | `thinkingBudget:1024` |
| `--model gemini-3.8-flash --effort high` | `gemini-3.8-flash` | `thinkingBudget:-1`，`init.model` 是 `gemini-3.8-flash` |
| `--model gemini-3.8-flash`（不带 effort） | — | 启动失败：`requires --effort (available: low, medium, high)` |
| `--model gemini-3.8-flash-medium --effort max` | — | 启动失败：两者冲突 |
| `--model gemini-9-ultra` | — | 启动失败，退出 1，错误里列出可用模型 |

会话标题另用 `gemini-3.1-flash-lite-preview` 生成，所以用户的 key 要能访问这个模型。

**Orbit 的做法**：runner 定期跑 `agy models`，把 slug 按最后一个 `-low|-medium|-high` 拆成"基础名 + 档位"，上报成一个模型
加一组 `reasoningLevels`（同 local-vllm 那种模型行）；会话时传 `--model <基础名> --effort <档位>`。没选模型时不传 `--model`，
界面上按 `gemini-3.1-pro` / `low` 显示。

### 9.3 上下文读数

agy 不报上下文窗口大小，按模型维护一张表（阶段 1 定值；真实 key 到位后可以从 API 的 `inputTokenLimit` 核对）。
（1.2.16 更正：`input_tokens` 不含缓存命中，读数要加上 `cache_read_tokens`，见 §13。）
占用读数取**最近一个** `agent_response` 步骤的 `usage.total_tokens`（= `input_tokens + output_tokens`；按官方文档的例子，
`cache_read_tokens` 包含在 `input_tokens` 里）。每个 `agent_response` 步骤的 `usage` 是那一次模型调用的量【实测】，可以随步骤更新读数（同 `contextPinger`）。

---

## 10. 其他实测要点

### 10.1 斜杠命令【实测】

- 流里出现 CLI 自己处理的命令（`/model`）：`result` 为 `ERROR`（`/model is answered by the CLI itself and is unavailable with --input-format stream-json`），
  **进程以 2 退出**，会话就此结束（样本 `slash-model-ends-session`）。
- 不认识的 `/xxx`：原样作为文本交给模型。
- 加 `--disable-slash-commands`：`/model` 也当普通文本发给模型，会话继续。

用户在 Orbit 里输入以 `/` 开头的消息很常见，所以**固定带 `--disable-slash-commands`**。代价是 agy 的技能不能用斜杠调用；第一期不需要。

### 10.2 `ask_question`【实测】

模型调用 `ask_question` 时，无头模式不会等人：stream-json 里只有一个 `step_type:"unknown"` 的 `DONE` 步骤，没有任何详情；
模型收到的结果是 `A1: User Skipped`（样本 `ask-question-headless`）。第一期在 transcript 里不展示。原先设想阶段 3 的
PreToolUse hook 能拿到完整问题再接 Orbit 的问答卡；1.2.16 实测 `ask_question` **不经过** PreToolUse hook（§14.2），这条路走不通。

### 10.3 MCP【实测，样本 `mcp-call`】

- 配置在 `<gd>/config/mcp_config.json` 的 `mcpServers`，格式同 Kimi 的 `mcp.json`（`command`、`args`、`env`）。
- MCP 服务器继承 agy 的环境（`ORBIT_SESSION_ID` 能传到，`GEMINI_API_KEY` 也会传过去），工作目录是 checkout。
- 握手：agy 先发 `server/discover`（`_meta` 里声明的协议版本是 `2026-07-28`），服务器回 `-32601` 后再走 `initialize`
  （`protocolVersion:"2025-11-25"`），然后 `tools/list`。`orbit mcp`（`mcp.go` 的 `handle`）对带 id 的未知方法正好回 `-32601`，
  `initialize` 回显客户端的协议版本，不用改。
- **服务器起不来时 agy 一声不吭**：stream-json 和日志里都没有报错，系统提示词里就是没有这个服务器（实验 `realmcp`：
  临时 HOME 下 `orbit mcp` 因为找不到 runner 配置立即退出，agy 照常跑完一轮）。`agy --gemini_dir=<gd> mcp list` 只列配置
  （`NAME TYPE STATUS COMMAND/URL`，STATUS 是 enabled/disabled），不反映连没连上；`/mcp` 在无头模式下不可用。
  `orbit mcp` 要读真 HOME 下的 runner 配置，这也是不改 HOME 的另一个理由。
- 工具是**按需加载**的：系统提示词里列出服务器和工具名，schema 写到 `<gd>/antigravity-cli/mcp/<server>/<tool>.json`，
  模型通过 `call_mcp_tool` 调用；`tools/call` 的 `_meta` 里带 `antigravity.google/conversation_id`。
- 默认模式下 MCP 调用需要审批：被软拒绝，`denied_actions` 是 `{"action":"mcp","display_name":"CallMcpTool"}`，本轮结束（实验 `mc_default`）。
  `permissions.allow` 里加 `mcp(orbit/*)` 就放行（实验 `mc_allow`，`--mode accept-edits` 下同样有效，实验 `mc_allow_accept`）；skip 模式下直接执行。所以 Orbit 在默认模式下要把
  自己的 MCP 服务器写进 allow，否则 agent 连 Orbit 工具都用不了。

### 10.4 其他外连

启动时 agy 会去 `antigravity-unleash.goog` 注册并拉取功能开关；连不上不影响运行。

---

## 11. 真实 key 待补项

runner 上没有真实 Gemini key。owner 把 key 写进 runner 上的 `/root/.config/orbit/gemini-api-key` 后，用同一套脚本
（去掉 `GOOGLE_GEMINI_BASE_URL`，`GEMINI_API_KEY` 只从这个文件读，不进日志、评论和提交）补这些，并把样本加进
`src/runner-go/testdata/antigravity/`：

1. 真实模型的思考：stream-json 里到底有没有思考文本（mock 下没有）。
2. `cache_read_tokens` 在多轮里的实际值，确认 §9.3 的读数取法。
3. 真实的 429、配额耗尽、无效 key、模型无权限时的 `AGY_ERROR` 文本，用来写错误分类。
4. 真实工具调用里 `read_url_content`、`search_web` 等的展示参数（§2.3）。
5. API 的 `GET /v1beta/models` 里各模型的 `inputTokenLimit`，填 §9.3 的窗口表。

这些不改变本文的六项结论，只补映射细节；项目里的端到端验证任务也会用真实 key 再走一遍。

---

## 12. 与作业指导初稿（agy 1.2.14）的差异

| 项 | 初稿 | 1.2.15 实测 |
| --- | --- | --- |
| 驱动参数 | `--print= --input-format stream-json --output-format stream-json …` | 另加 `--gemini_dir`、`--disable-slash-commands`、`--print-timeout=0s`；`--print` 不带等号现在直接报错 |
| 事件 | `init`、`step_update`、`result` | 另有 `error_message`、`system_message`、`unknown` 步骤；`result.status` 会粘住；`denied_actions` 是累计去重集合；工具参数是展示子集；没有思考文本 |
| 恢复 | `--conversation` 历史完整 | 确认；另有：id 不存在时悄悄开新会话；报错后的 ERROR 粘住；要用同一个 gemini 目录 |
| 中断 | SIGINT → ERROR "interrupted"，进程退出；hook 子进程会成孤儿 | 确认（退出码 1，SIGTERM 相同）。命令进程组由 agy 自己杀；hook 和 MCP 在 agy 进程组里；只有 SIGKILL agy 时命令进程会变孤儿 |
| MCP | `~/.gemini/config/mcp_config.json`，继承环境，`call_mcp_tool` | 确认，位置换成 `<gd>/config/mcp_config.json`；先发 `server/discover`；工具按需加载 |
| 权限 | 默认拒、`permissions.allow` 有效、hook allow 越不过拒绝、skip 下 hook 是唯一闸门 | 全部确认；另有：默认模式下工作区内写也被拒；被拒时整轮结束；deny 规则在 skip 下仍生效；settings.json 里的 hooks 不加载；仓库 `.agents/` 的 hook 和 MCP 会执行 |
| 模型 | `agy models` 输出内置列表，档位编在 slug 里 | 确认；另有"基础名 + `--effort`"写法和各档的 `thinkingBudget` |
| 自动升级 | 后台自升级，待定 | `AGY_CLI_DISABLE_AUTO_UPDATE=true`；机制见 §6 |
| 数据收集 | 设置里可关，待确认 | `enableTelemetry:false` 只关错误报告，使用统计关不掉（§7） |
| 配置隔离 | 待定，优先不改 HOME | `--gemini_dir`，不改 HOME（§3） |

---

## 13. agy 1.2.16 补充（阶段 1）

阶段 1 的 runner 引擎和契约测试是在 runner workstation 上、**agy 1.2.16** 上做的（这台机器原先没有 agy，2026-10-03
用官方脚本装到 `/root/.local/bin/agy`）。上文的结论由 `src/runner-go/antigravity_contract_test.go` 的
`TestAntigravityContract*` 在 1.2.16 上重新验证过；下面是不同的或上文没覆盖的【实测】：

| 项 | 1.2.16 实测 | runner 的做法 |
| --- | --- | --- |
| 用量 | mock 回 prompt 1200（其中缓存 300）、candidates 40、thoughts 7：agy 报 `input_tokens` 900、`cache_read_tokens` 300、`output_tokens` 47、`total_tokens` 947。`input_tokens` 不含缓存命中，`total_tokens` 也不含 | 更正 §9.3：上下文读数取 `input_tokens + cache_read_tokens + output_tokens`（这里 1247），不取 `total_tokens`；`TokenUsage` 一一对应（同 claude 的拆法）。§2.4 的"`output_tokens` 已含思考"不变 |
| 中断 | 只向 agy 的 PID 发 SIGINT：照样写 `interrupted` 的 `result`、退出 1，但 PreToolUse hook 起的子进程（在 agy 进程组里）成孤儿活下来；向整个进程组发 SIGINT：一起结束 | 更正 §4.1 第 1 步：向进程组发 SIGINT（`interruptSessionProcessGroup`），agy 退出后再按进程组 SIGKILL 兜底 |
| `--effort` | help 列出 `low\|medium\|high\|xhigh\|max`，但每个模型只收自己的档位（`gemini-3.1-pro` 只有 low/high）；档位不对时 `result` 的 `error` 为 `invalid model selection …`、`conversation_id` 为空、退出 1，没有 `init` | 只传模型目录里该模型有的档位，否则用它的默认档（有 high 就 high）。没选模型时 `--model`、`--effort` 都不传 |
| 全局规则 | `<gd>/GEMINI.md`、`<gd>/AGENTS.md`、`<gd>/config/GEMINI.md`、`<gd>/config/AGENTS.md` 都作为用户全局规则进系统指令（"user-defined rules that you MUST ALWAYS FOLLOW"） | agy 没有 system prompt 参数：agent 的 systemPrompt / appendSystemPrompt 和 Orbit 自己的说明写进 `<gd>/GEMINI.md` |
| `.agents/` | changelog：skills.json、rules.json 等清单改为从工作目录到项目根之间每一级 `.agents/` 加载 | §3.5 的闸门检查会话目录到仓库根之间的每一级 `.agents/` |
| `bin/` 共享 | 两个新 gemini 目录同时启动、`bin/` 软链到同一个新的共享目录：两个都正常，解出的 webm_encoder 与单独解出的逐字节相同 | 按 §3.1 链到 `<ORBIT_HOME>/antigravity/bin` |
| `agy --version` | 不写 HOME，不拉起 `--bg-updater` | 引擎探针照常每 5 分钟跑一次 |
| `agy update` | 无人值守可用（已是最新时打印 `You are already on the latest version.`、退出 0）；带 `--gemini_dir=<目录>` 时更新器状态只写进该目录，目录不存在会自建 | 引擎更新命令是 `agy --gemini_dir=<ORBIT_HOME>/antigravity/updater update`；`agy models` 同样在 `<ORBIT_HOME>/antigravity/catalog` 里跑，用占位 key（它不调 API） |
| 安装脚本 | 与 §6.4 相同：`agy install` 往 `~/.bashrc`、`~/.profile` 各追加一行 PATH | 这次安装留下的两行没有删 |

## 14. 阶段 3：人工审批（agy 1.2.16）

### 14.1 结论

| Orbit 模式 | agy 参数 | 谁决定没被批准的操作 |
| --- | --- | --- |
| Default | `--dangerously-skip-permissions` + Orbit 的 hook | 下面的规则先放行或拒绝，其余出 Orbit 的审批卡片，人来批 |
| Accept Edits | 同上 | 同上，另外工作区内的写、改直接放行 |
| Plan | `--mode plan`（不变） | agy 自己拒（§5.2） |
| Don't Ask | 不加（不变） | agy 自己拒（§5.2） |
| Auto、Bypass | `--dangerously-skip-permissions`（不变），不装 hook | 全部放行 |

**hooks.json**：问人的两种模式下，runner 每次起 agy 前写 `<gd>/config/hooks.json`：

```json
{"orbit-approval": {
  "PreToolUse": [{"matcher": "", "hooks": [{"type": "command", "timeout": 86400,
    "command": "'<orbit>' hook antigravity-approval '<gd>/orbit/approval-policy.json' <策略文件的 sha256>"}]}],
  "PreInvocation": [{"type": "command", "timeout": 30,
    "command": "'<orbit>' hook antigravity-heartbeat '<gd>/orbit/heartbeat' <每个进程一个随机 token>"}]
}}
```

其他模式下删掉这个文件（只删 Orbit 自己的那份）：在 Plan、Don't Ask 里 hook 只会给 agy 本来就拒的调用出卡片，在 Auto、Bypass 里它会去问不该问的人。

**`orbit hook antigravity-approval`**（`src/runner-go/antigravity_approval.go`）从 stdin 读一次工具调用，按会话的策略判断，顺序是：

1. 子代理（`invoke_subagent`、`define_subagent`）→ 拒：子代理自己的工具调用不经过任何 hook（§14.2）；
2. 写 gemini 目录里 artifact 目录以外的地方（hooks.json、策略文件、settings.json…）→ 拒，有允许规则也拒；
3. 工作区的 deny 规则 → 拒。shell 规则按词匹配整行任何位置（`Bash(rm:*)` 也拒 `true && rm -f x`）：agy 自己那份 `permissions.deny` 在 skip 下照样生效，没必要先问人；
4. Orbit 自己的 MCP 服务（`call_mcp_tool`、`list_resources`、`read_resource` 且 `ServerName` 为 `orbit`）→ 放行；
5. 允许规则，按 Kimi 桥的匹配方式（`kimiToolMatchesRule`），**不**认命令前缀 → 放行；
6. agy 自己的记账：`schedule`、`manage_subagents`、`ask_question`、`manage_task` 的 list/status/kill → 放行（`send_input` 是往运行中的命令里打字，要问）；
7. 读工作区、会话上传目录、本会话的 artifact 目录（`<gd>/antigravity-cli/brain/<conversation>/`，同 agy 自己默认模式）→ 放行；
8. 写 artifact 目录（任何模式，同 agy 自己默认模式）、Accept Edits 下写工作区 → 放行，但工作区里任何 `.agents/` 目录下的文件不放行
   （agy 会在运行中加载它，§14.2）；路径先解析软链接，指向不存在目标的软链接不算在内；
9. 其余 → 审批卡片：和 Kimi 桥一样 `createApproval` + `awaitApprovalDecision`。卡片的 `toolName`/`input` 用 claude 的叫法（`Bash {command, cwd}`、`Write {file_path, content}`、`Edit {file_path, old_string, new_string}`、`mcp__<server>__<tool>`…），
   `toolUseId` 是 `<conversation>:<step>`，和 transcript 里这次 tool_use 的 id 相同。批准 → `allow`；拒绝 → `deny`，理由
   "The user denied this call[: <批注>]"；到点（hook 超时减一分钟）没人答 → `deny`，理由 "Nobody answered the approval request for this call within …"。

命令前缀规则（包括会话中途点的 "Always allow"）由控制面在建卡时按工作区规则回答（`permission-rules.ts` 的 `SERVER_MATCHED_RUNTIMES`，同 Kimi、Codex），不出卡片。

hook **每次都只打印一个决定**；写不出来就以非零退出（agy 把它当拒绝）。策略文件的 sha256 写在 hook 自己的命令行里，对不上就全部拒绝。

**闸门**：skip 只在两项检查都通过时才有：

1. 启动前：`agy --gemini_dir=<gd> --print=/hooks --output-format json`（会话的环境变量和工作目录）列出的必须**恰好**是 Orbit 那两条、来源是 Orbit 写的 hooks.json。agy 出错、少一条、命令或超时不对、多出别的 hook（包括仓库的 `.agents/hooks.json`）都不启动，错误写进 transcript；
2. 运行中：agy 每发一个步骤，hooks.json 都得还是 Orbit 写的那些字节，工作区（到仓库根为止）的 `.agents/` 里也不能冒出 hooks.json、
   mcp_config.json、plugins.json 或 plugins/（同 §3.5 启动前的检查）；agy 每答一次模型调用（`agent_response` 步骤）之前都得有本进程 token
   的心跳。任何一项不满足：当前轮以 FAILED 结束、向 agy 进程组发 SIGINT（agy 会杀掉正在跑的命令）、会话结束。

### 14.2 实测（agy 1.2.16）

PreToolUse hook 的回答（skip 模式，命令是 `echo … > 文件`）：

| hook 的 stdout / 退出码 | 结果 |
| --- | --- |
| `{"decision":"allow"}`（带 reason、stderr 有输出、末尾多空行都一样） | 执行 |
| **空**（退出 0）、只有换行 | **执行** |
| **`{"decision":"ask"}`** | **执行** |
| `{}` | 拒，`tool call denied by pre-tool hook:`（理由为空） |
| `{"decision":"deny","reason":"…"}` / `{"decision":"deny"}` | 拒，模型收到 `tool call denied by pre-tool hook: …`，接着往下走 |
| `maybe`、`ALLOW`、`block` | 拒，`unsupported hook decision: …` |
| 多一个未知字段、不是 JSON、两个对象 | 拒，`failed to unmarshal result from hook …` |
| 非零退出（即使 stdout 是 allow） | 拒，`JSON hook "…" failed: command failed: exit status N` |

所以 Orbit 的 hook 绝不输出空，也绝不输出 `ask`。

哪些调用经过 PreToolUse（skip 模式，hook 记录每次调用并放行）：API key 模式下声明给模型的 13 个工具是 `view_file`、`run_command`、
`manage_task`、`send_message`、`schedule`、`invoke_subagent`、`define_subagent`、`manage_subagents`、`write_to_file`、
`replace_file_content`、`read_url_content`、`search_web`、`ask_question`，配了 MCP 再加 `call_mcp_tool`、`list_resources`、`read_resource`。
逐个试过：除 `ask_question` 外都经过 hook（`send_message`、`read_resource` 没单独试）。`ask_question` 不经过 hook，照旧是 `unknown` 步骤和
"User Skipped"，它什么都不执行。

**子代理自己的工具调用完全不经过 hook**：`define_subagent`（`enable_write_tools: true`）后 `invoke_subagent`，子代理的提示里让它
`run_command` 写文件：文件写出来了，hook 日志里没有子代理的 PreToolUse，也没有它的 PreInvocation；父会话的流里只有一个 `subagent` 步骤。
所以问人的模式下 Orbit 的 hook 拒绝子代理。

`schedule`：定时器的提示词在同一轮里到达（`schedule` 这个工具步骤一直等到定时器触发），它引出的工具调用照样经过 hook。

PreInvocation：每次模型调用之前触发，**同步**（hook 睡 2 秒，模型回复就晚 2 秒）；负载有 `artifactDirectoryPath`、`conversationId`、
`initialNumSteps`、`invocationNum`（每轮从 0 数起）、`modelName`、`transcriptPath`、`workspacePaths`；它的退出码和输出不影响这次调用
（退出 1、输出空、输出 deny，模型照样被调用）。父会话的每次调用都有（包括工具结果和定时器之后的调用），子代理的没有。
一次调用对应一个 `agent_response` 步骤。

`SessionStart`：在进程收到第一条消息之后才触发，不是进程启动时，没法拿来在第一条消息之前确认 hook。

**hooks.json 会被重读**：两轮之间把 hooks.json 改成只剩 PreInvocation，不重启进程，下一轮的 `run_command` 就不经过 hook 直接执行了。
这是运行中要盯 hooks.json 字节的原因。工作区的 `.agents/hooks.json` 也一样：两轮之间在工作区里新建一个，下一轮它的命令就在每次工具调用前
执行了；工作区里的 `.gemini/hooks.json`、`.gemini/config/hooks.json` 不会被加载（场景 `s_wshooks`）。

超时：`timeout: 86400` 时 `/hooks` 报 `timeout_seconds: 86400`；hook 等 660 秒后回 allow，命令照常执行（没有 600 秒上限）。
hook 等待期间，这个工具步骤的 `ACTIVE` 已经流出来了，所以 transcript 里能看到正在等批的调用；`DONE` 在决定之后。

hook 进程：命令经 shell 执行（带引号的参数按 shell 规则拆分），工作目录是 `<gd>/config`，在 agy 的进程组里。

artifact：agy 自己的默认模式（不加参数）下往 `<gd>/antigravity-cli/brain/<conversation>/…` 写文件不用批准（带不带 `ArtifactMetadata` 都一样）；
带 `ArtifactMetadata` 写别处会被当成参数错误。

`--print=/hooks`：settings 里 `modelProvider` 是 `gemini` 时也要 `GEMINI_API_KEY`，否则退出 1；hooks.json 不存在、为空、不是 JSON 或是个
目录时都是 `hooks: []`、退出 0；仓库的 `.agents/hooks.json` 也列出来，`source` 是它自己的路径；写成嵌套格式的 PreInvocation 照样列出，但没有
`command`；PreToolUse 的 `matcher` 只在非空时出现。settings.json 里写 `enableJsonHooks: false` 关不掉 hook。

### 14.3 为什么不会 fail open

- skip 参数只在拿到确认过的闸门时才加（`antigravityPermissionArgs(mode, gated)`）；没有闸门时 Default、Accept Edits 退回 agy 自己的拒绝，
  而实际运行中这种情况根本不启动 agy。
- hook 的每种失败都是拒绝：非零退出、被 agy 超时杀掉、策略文件读不出或被改过、调用读不出、控制面连不上、没人答。
- 运行中的检查在下一个流出的步骤上生效。命令改了 hooks.json：在这个命令自己的 `DONE` 步骤上就会发现（实测比下一次模型调用早），
  agy 被中断。一个从启动起就没加载 hook 的进程，要到它第一次回答模型调用时才会被发现，同一个回答里的工具调用可能已经开始了——挡在这之前的
  是启动前的 `/hooks` 检查。

契约测试：`TestAntigravityContractApproval{Allowed,Denied,TimesOut,HookNotLoaded}`（`src/runner-go/antigravity_approval_contract_test.go`），
`HookNotLoaded` 分 `listing`（agy 列不出 hook，不启动）、`heartbeat`（agy 不跑 hook，第一次回答就停）、`rewritten`（运行中改了 hooks.json，
下一个步骤就停，命令没执行）、`checkout hook`（运行中工作区冒出 `.agents/hooks.json`，同样停下，它的命令和后面的命令都没执行）。实验脚本在 [`docs/evidence/antigravity-cli-1.2.16/`](./evidence/antigravity-cli-1.2.16/)。

## 15. Gemini 预设借 agy（阶段 4，agy 1.2.16）

Providers 里的 Gemini 预设改借 Antigravity 运行时，迁移 `0372_gemini_antigravity_runtime` 把已存的行改过来。控制面把
provider 的 key 和端点作为 `GEMINI_API_KEY`、`GOOGLE_GEMINI_BASE_URL` 注入会话环境（`custom-provider.ts`），runner 照内置引擎
的方式起 agy；模型列表跟 runner 上报的 `agy models` 走（预设的 `modelsFromRuntime`）。2026-10-03 在 runner workstation 上【实测】：

| 项 | 结果 | 用在哪 |
| --- | --- | --- |
| slug 到 API 模型（mock 记下的请求路径） | `gemini-3.8-flash`、`gemini-3.7-flash`、`gemini-3.6-flash` 各档都请求同名模型；`gemini-3.1-pro` 低档请求 `gemini-3.1-pro-preview`，高档请求 `gemini-3.1-pro-preview-customtools`；标题照旧用 `gemini-3.1-flash-lite-preview` | 连接测试按这个映射探测 `POST {base}/v1beta/models/{API 模型}:generateContent`，key 放 `x-goog-api-key` 头 |
| 真实 key 的 `GET /v1beta/models` | 上面这些 API 模型都在，`inputTokenLimit` 都是 1,048,576 | 与 runner 的窗口表（`antigravityContextWindows`）一致，补上 §11 第 5 项 |
| 无效 key（直接请求 API） | `generateContent` 回 400 `INVALID_ARGUMENT`，`details[].reason` 为 `API_KEY_INVALID`，不是 401/403 | 连接测试显示 `HTTP 400 — API key not valid…` |
| 预付额度用完 | 每个模型都回 402 `RESOURCE_EXHAUSTED`（"Your prepayment credits are depleted…"）；Orbit 会话里的错误是 `agent executor error: generating and executing: Error 402, Message: …` | §11 第 3 项的一种；连接测试原样显示 Google 的说明 |

§3.2 的"key 对 agent 跑的命令可见"和 §7 的"使用统计关不掉"，写在了连接 Gemini 的表单上（API key 一栏下面）。

## 16. Google 账号登录（agy 1.2.16，2026-10-04）

**推荐暂不把个人 Google 登录额度接入 Orbit。** 技术上已完成 owner 本人浏览器 OAuth、隔离文件凭据、一轮真实无 TTY 对话、同账号三会话各三轮并发、过期后的自动续期，以及模型/额度查询。初次登录需要 PTY；不同账号、跨平台凭据隔离和真实限流仍有证据缺口。当前 Google 条款明确限制第三方软件使用个人登录（§16.8），官方 headless 支持不能作为 Orbit 获准的证据。本节不取代前文 Gemini API key 契约。

**本任务没有满足全部验收。** 一次工具结果曾包含 PTY 分段回显的可拼接授权码碎片；提交录制已按整个输入区间脱敏，但原会话工具记录不能精确撤回，故不主张满足“授权码没有进入对话/日志”的要求。没有输出 token 或账号邮箱。

本次官方安装脚本 `--dir <TMP>/bin` 安装 **agy 1.2.16**，209,625,296 字节，SHA512：
`fa4de3267ad38d4baaa217010757d9cadce9b4bd94ab995b81b34399ca1577758067bc9892ce498ce76345671142e3a6c949df38b07f1b3d4e2cf4cf46cf3044`。
每个实验在空目录运行，独立 HOME/XDG 和 `--gemini_dir`，不继承 API key/账号环境变量；`AGY_CLI_DISABLE_AUTO_UPDATE=true`、`--log-file=/dev/null`，D-Bus 指向私有目录中不存在的 socket，不能连接已有钥匙串。推理实验设 `useG1Credits=false`，只发送要求原样回复的无关紧要提示词，没有项目代码或工具调用。
方法和录制索引见 [`google-auth-README.md`](./evidence/antigravity-cli-1.2.16/google-auth-README.md)、[环境记录](./evidence/antigravity-cli-1.2.16/google-auth-environment.json)。以下区分【实测】、【二进制推断】、【官方文档】和【未确立】。

### 16.1 无头登录

**普通无 TTY 管道不能初次登录；私有 PTY 可在无 GUI 环境完成 SSH OAuth，登录后普通管道可运行。**【实测，1.2.16】

| 启动方式 | 输出与结果 | 依据 |
| --- | --- | --- |
| `agy --gemini_dir=<gd>`，无控制终端，stdin/stdout 为管道 | stdout：`CLI error: bubbletea: error opening TTY: bubbletea: could not open TTY: open /dev/tty: no such device or address`；**退出 0** | [普通管道](./evidence/antigravity-cli-1.2.16/google-auth-no-tty-real.json) |
| 同上，设非空 `SSH_CONNECTION` / `SSH_TTY` | 同样 TTY 错误，退出 0；保持 stdin 开启也不行 | [SSH 管道](./evidence/antigravity-cli-1.2.16/google-auth-ssh-no-tty-real.json)、[保持 stdin](./evidence/antigravity-cli-1.2.16/google-auth-held-ssh.json) |
| 未登录，`--print= --input-format stream-json --output-format stream-json` | 不给 URL；要求先交互登录，`result ERROR`，退出 1 | [stream-json](./evidence/antigravity-cli-1.2.16/google-auth-held-stream.json) |
| 私有 PTY，加非空 `SSH_CONNECTION`，不设 `modelProvider` | 选 `1. Google OAuth`，Enter 后显示链接/输入框；owner 浏览器授权后回填，保存凭据 | [登录录制](./evidence/antigravity-cli-1.2.16/google-auth-owner-login-final.json) |
| 已登录文件凭据，无 TTY `--print=<短提示> --output-format stream-json` | `init` → `step_update` → `result SUCCESS`，回复 `orbit-ok`，退出 0 | [真实一轮](./evidence/antigravity-cli-1.2.16/google-auth-real-one-turn.json) |

授权界面的确切文案（去 ANSI 后）：

```text
Open the URL below in your browser:
https://accounts.google.com/o/oauth2/auth?<AUTH_QUERY_REDACTED>
Copy and paste the URL or click on the link below:
→ Click here to authenticate
After authenticating, copy the code displayed in the browser and paste it below:
authorization code...
```

CLI 不打印设备码；**授权码由 owner 在浏览器登录后取得**。URL 使用 PKCE，`response_type=code`、`access_type=offline`，回调 `https://antigravity.google/oauth-callback`。动态查询串不入录制。URL 会随终端宽度换行，也有 OSC 8 超链接，不能直接逐行正则截取。非空 `SSH_CLIENT` / `SSH_TTY` / `SSH_CONNECTION` 触发不打开浏览器的分支【二进制推断】，其中 `SSH_CONNECTION` 已实测。

通知已送达；owner 把返回码写入 0600 私有文件，在本会话仅回复“已写入”。驱动读后清空文件，写入 PTY，再发送 Enter，成功保存凭据。**TUI 会分段、带退格回显输入**，应在写码前停录该输入区间，不能只对完整字符串作替换。本次原执行记录的脱敏缺口已在开头披露。

**拒码文案已实测（2026-10-04，Linux，官方 agy 1.2.16）**：在隔离 PTY 中选 Google OAuth，提交一个故意错误的占位码，不使用 Google 账号。固定错误为：

```text
oauth2: "invalid_grant" "Malformed auth code."
```

拒码后进程仍存活。runner 识别该固定标记，恢复 `awaiting_code` 并保留原授权链接，让用户重新粘贴；错误响应和输入渲染都不透传。夹具见 [`google-auth-invalid-code.json`](../src/runner-go/testdata/antigravity/google-auth-invalid-code.json)，整个授权输入渲染区间已删除，只保留固定拒码错误。Google 授权码有效期、agy 整体登录超时仍【未确立】；runner 使用自己的 `loginRelayTimeout`（10 分钟），不将其描述为 agy 的超时。

菜单、首次主题/数据选项/目录信任可能挡在正常 prompt 前，也可能在 OAuth 保存 token 后出现（现有登录完成录制即为后一种）。runner 在私有 Linux PTY 中设非空 `SSH_CONNECTION`、`TERM=xterm-256color`、4096 列，取 OSC 8 的完整目标（支持 BEL 和 ST 终止），等授权码提示后才上报链接。主题按 Enter；Terms 页仅在 `[x]` 时取消勾选，再 Tab、Tab、Enter 选 Done；信任的仅为空私有 cwd。写码前永久关闭这次 PTY 的公开输出，拒码重试也不重新打开；只在私有内存中识别固定页面/拒码标记。

当前 runner 的成功条件是：本次 token 文件出现、完成首次设置并看到普通输入框、独立 `--print=/usage --output-format stream-json` 返回 `result.status=SUCCESS`。退出 0 不算成功。换号时旧 token 暂存在同目录的 0600 私有备份，失败或取消恢复，确认成功后删除；新尝试等待旧尝试清理完毕再启动。取消仅 SIGKILL 本次记录 PID 的进程组，不搜索其他 agy 进程。非 Linux 直接返回「Antigravity 的 Google 登录暂时只支持 Linux runner」。
现有 `login.go` 的 pipe relay 不能原样复用；需要 PTY、菜单/提示符识别、ANSI/OSC 8 解析、受保护回填、取消及成功后独立 probe。退出 0 不能当登录成功。与[官方 headless 说明](https://antigravity.google/docs/cli/headless/)要求先交互登录再使用缓存凭据一致。

### 16.2 凭据存储与隔离

**本机无头 Linux/SSH 在没有 Secret Service 的情况下成功回落到隔离文件。**【实测，1.2.16】凭据在 `<gd>/antigravity-cli/antigravity-oauth-token`（JSON，无 `.json` 后缀），权限 **0600**，包含 token、refresh token、expiry、ID token；只记录字段类型，见[凭据文件观测](./evidence/antigravity-cli-1.2.16/google-auth-credential-file.json)。隔离 HOME 中零文件，用户 `/root/.gemini` 始终不存在。复制该文件到新的私有 `--gemini_dir` 后能无 TTY 对话并自动续期。

未登录 SSH 的 `strace` 看到：

```text
openat(..., "<gd>/antigravity-cli/antigravity-oauth-token", O_RDONLY|O_CLOEXEC) = -1 ENOENT
```

该次跟踪无 `/root/.gemini` 路径、无 Secret Service 连接；写入在临时目录，见[隔离跟踪](./evidence/antigravity-cli-1.2.16/google-auth-isolation-trace.json)。所有进程的 D-Bus 地址不可达，且没有 DISPLAY/桌面环境，未往用户或系统钥匙串试写。

【二进制推断，1.2.16】Linux Secret Service D-Bus 服务是 `org.freedesktop.secrets`；应用搜索属性固定 **service=`gemini`、username=`antigravity`**。`--gemini_dir` 不改变这对键，HOME/XDG 也不能自动隔离同一钥匙串的账号。SSH/容器/无 D-Bus 检测和操作失败有文件回落分支；回落标记为 `<gd>/antigravity-cli/cache/antigravity-keyring-unavailable`。详见[二进制分析](./evidence/antigravity-cli-1.2.16/google-auth-binary-analysis.md)。

【未确立】只改 `--gemini_dir` 而保留 agent 真 HOME 是否足够、桌面 Linux/macOS 如何稳定强制文件模式。当前不能承诺跨平台隔离。可研究“持久私有凭据目录 + 每会话凭据副本”，但文件非原子写入和 refresh/登出一致性还需验证。

### 16.3 多账号

**同账号三个隔离会话并发已实测；两个不同账号仍未确立。**【实测，1.2.16】同一 owner 授权文件复制到三个私有 `--gemini_dir`，进程运行时间重叠，每个按 `result` 逐轮送 stdin NDJSON。九轮全部 SUCCESS，各退出 0。见[会话 1](./evidence/antigravity-cli-1.2.16/google-auth-concurrency-1.json)、[会话 2](./evidence/antigravity-cli-1.2.16/google-auth-concurrency-2.json)、[会话 3](./evidence/antigravity-cli-1.2.16/google-auth-concurrency-3.json)。

没有第二份 owner 本人授权的账号；复制同一 token 不是多账号登录，也没有验证三个进程同时刷新。固定 keyring 属性存在串账号风险。后续需分别验证 A/B 凭据、同时对话/续期、登出 A 后 B 仍可用。不能让会话共用整个 `--gemini_dir`，那里还有 MCP、hooks、rules、conversation DB、brain，共用会破坏会话和审批隔离。

### 16.4 令牌生命周期与“已登出”

**自动续期已实测；未验证自然到期、服务端撤销或运行中认证失效。**【实测，1.2.16】将私有副本 expiry 改为 `2000-01-01T00:00:00Z`，保留真实 refresh token。启动后 access token 改变、expiry 更新并写回；对话返回 `orbit-token-ok` / SUCCESS / 退出 0，见[强制过期续期](./evidence/antigravity-cli-1.2.16/google-auth-forced-expiry.json)。这验证真实刷新服务，不代表跨进程同时刷新安全。

另将副本 access/refresh token 换为无效占位值并设过去 expiry，启动输出与无凭据一样，见[无效刷新凭据](./evidence/antigravity-cli-1.2.16/google-auth-invalid-refresh.json)：

```json
{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}
```

stderr 为 `Error: authentication required. Run 'agy' to log in, then retry.`，随后 `error: authentication failed or timed out`；退出 **1**，无 `init`、`step_update`、`AGY_ERROR`。无凭据且 stdin 保持开启也是如此，见[录制](./evidence/antigravity-cli-1.2.16/google-auth-held-stream.json)。**占位刷新凭据不是服务器撤销真实 grant**；本次未要求 owner 撤销可能影响其他 Google 登录的 app grant，故缺真正 revoked 的样本。

【二进制推断】刷新 token source 有进程内 mutex，但文件写入未见跨进程锁/原子 rename；验证有内部 `credentials rejected` 分支，不能当作已观察到的流事件，见[分析](./evidence/antigravity-cli-1.2.16/google-auth-binary-analysis.md)。runner 可针对上述确定的启动错误组合提示登录；仅凭 `authentication failed or timed out`、退出 1、旧的 `result.status=ERROR`，不足以一律判“已登出”。网络、钥匙串不可用、服务端撤销的细分样本仍缺，doctor 应保留 `unknown`。

**网络失败与被拒在输出上分不开，只有 agy 自己的日志能分。**【实测，2026-10-04，官方 agy 1.2.16，Linux，无账号】会话 argv（§1.1）加占位凭据：字段形状同[凭据文件观测](./evidence/antigravity-cli-1.2.16/google-auth-credential-file.json)，值全是占位，`auth_method` 为 `consumer`、expiry 已过期。agy 拿 refresh token 去 Google 刷新，Google 回 `invalid_grant`，输出与上面的无效刷新凭据录制逐字节相同。同一凭据，`HTTPS_PROXY` 指向拒绝连接的端口、或代理主机名解析不了，stdout、stderr、退出码**也逐字节相同**（约 0.1 秒）。区别只在 `--log-file` 写出的日志：被拒是 `token refresh failed: oauth2: "invalid_grant" …` 和 `keyringAuth: saved token invalid: …`；网络失败是 `token refresh failed due to network error: …` 和 `token validation failed due to network error (token may still be valid): …`。见[录制](../src/runner-go/testdata/antigravity/google-session-auth-failures.json)。`auth_method` 必须是 agy 认得的值：试过的其他值（`oauth`、`google`、`google_oauth`、`business`、`sso` 等）在联网前就被拒（日志 `Unknown auth method`），输出同样一致。所以 runner 判 Google 模式会话的登出，在上面的组合之外还读 agy 日志：有 `due to network error` 就是网络错误，不算登出（§16.10）。状态探测（§16.5）也读单次调用的临时私有日志：原判 `no` 的组合遇到网络日志时改报 `unknown`，不附额度，日志随临时目录在 cleanup 时删除；此前断网误报 `no` 的缺口已修复。

### 16.5 状态探测与登出

**没有专门的已验证账号/邮箱子命令；独立 `--print=/usage` 可验证同一隔离凭据能读取账号额度。**【实测，1.2.16】[`--help`](./evidence/antigravity-cli-1.2.16/google-auth-help.txt) 不列 login/status/logout/auth。`agy models` 未登录退出 1，登录后成功。`--print=/usage --output-format stream-json` 返回 `command_result` 和 `result SUCCESS`（`num_turns=0`），没有模型推理，也不返回邮箱；网络失败仍需与认证失败区分。不能用 API 模式 `models` 成功当 Google 已登录。

补测（2026-10-04，无凭据）：`exec.Cmd.Stdin=nil` 使用 `/dev/null` 字符设备，agy 会显示授权链接并等待认证；`--print-timeout` 不能使它立即返回上述错误。真正的 stdin 管道（保持开启或立即 EOF）则在约 0.4–0.5 秒内返回认证错误 / 退出 1，未给授权链接、未写 token。因此独立 `/usage` 探测明确使用管道 EOF。真实未登录契约测试驱动官方 agy 的该探测，断言 `no`；另断言无 token、无环境 key 的正常健康检查为 `no`。有 token 时 `result SUCCESS` 为 `yes`；退出 1、无 `init`、stderr 同时有 `authentication required` 和 `authentication failed or timed out` 为 `no`；其他错误/网络/超时为 `unknown`。无 token 时正常健康检查沿用 `GEMINI_API_KEY` 的有/无判定，不启动 `/usage`。

审批闸门的检查（§14，`--print=/hooks --output-format json`）在 Google 模式也先查登录【实测，2026-10-04】：stdin 为 `/dev/null` 时打印授权链接并一直等（到闸门的一分钟超时）；改用管道 EOF 后约 0.4 秒以 §16.4 的组合结束（stdout 是一个 `result` 对象，没有 `init` 一说）。runner 对它同样用管道、同一份日志和同一套判定（§16.10）。

runner 登录、探测及后续 Google 模型目录共用 `antigravityGoogleCommand`，`--gemini_dir=<machineHome>/antigravity/google/`（已存在也校正 0700），token 校正 0600；独立空 cwd、HOME/XDG 用临时私有目录，不继承 API key/OAuth 环境变量、关闭自升级，登录中继与模型目录保持 `--log-file=/dev/null`，仅 `/usage` 探测写临时私有日志并在 cleanup 时删除，D-Bus 指向不存在的私有 socket，Google settings 不设 `modelProvider`、`useG1Credits=false`。额度随现有五分钟引擎健康缓存刷新，`loginDone` 沿已有路径立即刷新并发送 heartbeat。

【二进制推断】隐藏 `AGY_CLI_CDE_AUTH_ACTION=check|login` 仅无任何 argv 参数时生效，传 `--gemini_dir` 即不走该分支；其默认文件 `$HOME/.gemini/jetski-standalone-oauth-token` 与普通 CLI 不同，不能直接用于 doctor。本任务未绕过隔离参数运行该入口。正常文件的 ID token 可提供账号 claims，但解码本地缓存不是有效登录的证明，邮箱也不应进入 heartbeat/日志。

[官方认证文档](https://antigravity.google/docs/cli/install/)的登出是正常 CLI prompt 中 `/logout`。【实测】`--print=/logout --output-format stream-json` **拒绝执行，退出 2**：`/logout is not available in print mode (it clears stored credentials, an effect that outlives the run)`，见[print 拒绝](./evidence/antigravity-cli-1.2.16/google-auth-print-logout.json)。加 `--disable-slash-commands` 会把它作为字面提示词交给模型，不能用于登出。

PTY 必须先完成首次主题设置/数据选项/空目录信任，看到普通输入框后才写 `/logout` + Enter。Terms 页 checkbox 焦点上 Enter 是切换，取消数据收集勾选后应 Tab、Tab、Enter 选 Done。成功不一定有固定提示；以 token 文件删除和新无 TTY 启动要求认证判断，登出/清理记录见[README](./evidence/antigravity-cli-1.2.16/google-auth-README.md)。本地登出不等于远端 OAuth grant 撤销【二进制推断】。

### 16.6 额度与限流

**测试账号为 Google AI Pro；额度可非交互查询，三会话九轮未限流。**【实测，1.2.16】TUI header 显示 `<EMAIL_REDACTED> (Google AI Pro)`，见[PTY 录制](./evidence/antigravity-cli-1.2.16/google-auth-logout-real-one-turn.json)。

`agy --gemini_dir=<gd> --print=/usage --output-format stream-json` 返回 `command_result.command` 和 `result.command`，`command.name=usage`；`data.groups[].buckets[]` 含 `id`、`window`、`remaining_fraction`、`reset_time`。Gemini 和 Claude/GPT 各有 weekly、5h bucket；`result.num_turns=0`、usage 全零、退出 0，见[查询](./evidence/antigravity-cli-1.2.16/google-auth-print-usage.json)。三会话九轮及续期实验后 Gemini weekly 约剩 99.39%、5h 约 98.90%，见[实验后](./evidence/antigravity-cli-1.2.16/google-auth-usage-after-concurrency.json)。比例不能反推出绝对请求/token 上限。

`--print=/credits` 同样返回结构化 `remaining_credits=0` 和升级链接，见[credits](./evidence/antigravity-cli-1.2.16/google-auth-print-credits.json)。所有推理设 `useG1Credits=false`。九轮无 429/重试提示，没有为了取得错误而耗尽近乎全部账号额度，因此真正限流时的错误内容、事件、退出码和自动重试仍【未确立】。API key 429 mock 不能替代此证据。

runner 健康上报字段（第一版，每台 Linux runner 一个账号，不进入账号池）：

| 字段 | 含义 |
| --- | --- |
| `engines[].auth` | `yes` / `no` / `unknown`，来源选择后对应的认证状态。 |
| `engines[].authSource` | `google`：存在 Google token，优先于环境 key；`env_key`：无 token 且 runner 有 `GEMINI_API_KEY`；均无则省略。Google 认证失败不回退到 key。 |
| `engines[].planUsage` | 仅成功 Google `/usage` 探测的额度快照，复用 `PlanUsage`；未知或未登录时省略。 |
| `planUsage.provider` / `planUsage.fetchedAt` | `antigravity` / 这次探测完成时间（UTC RFC3339）。 |
| `planUsage.buckets[].id` / `.window` | CLI bucket 标识 / `weekly`、`5h` 等窗口；扁平汇总 `data.groups[].buckets[]`，不上传分组描述。 |
| `planUsage.buckets[].remainingFraction` | `remaining_fraction` 的原始剩余比例（0–1），不是已使用百分比，不推算绝对额度。零值保留。 |
| `planUsage.buckets[].resetTime` | `reset_time`，UTC RFC3339；CLI 未提供则省略。 |

只上传上述白名单字段，不包含 token、邮箱、ID token claims、原始 PTY/CLI 文本或额度描述。此额度挂在 Antigravity 的引擎健康行，heartbeat 顶层 Claude/Codex `planUsage` 的兼容结构保持不变。能力名为 `antigravity-google-login/v1`；登录取消命令 `action=cancel` 使用同一 `engine` / `attempt`，旧 attempt 的取消与授权码忽略。

【官方文档，2026-10-04】[Plans](https://antigravity.google/docs/plans)说明 Free 每周刷新，Pro/Ultra 每五小时刷新且有周限制，额度随计划/工作量/容量变化；没有固定并发保证。Pro/Ultra 可启用 AI credits 超额消耗，因此“账号模式绝不另收费”不成立。[`/usage` / `/quota`](https://antigravity.google/docs/cli/commands/usage/)和[`/credits`](https://antigravity.google/docs/cli/commands/credits/)有交互面板，独立 print 查询亦受[headless 文档](https://antigravity.google/docs/cli/headless/)支持；不能把 slash 命令塞进禁用 slash 的常驻会话查询。超额开关见[`useG1Credits`](https://antigravity.google/docs/cli/credits/)。

### 16.7 模型列表

**本账号 Google 模式 18 行，API key 模式 11 行。**【实测，1.2.16】未登录 Google 模式 `agy models` 返回 `Error: Please sign in to view available models. Launch the CLI without arguments to sign in.`，退出 1，见[未登录](./evidence/antigravity-cli-1.2.16/google-auth-google-models.json)。

API 模式 settings `modelProvider=gemini` + 无效占位 key，无需账号登录，退出 0：Gemini 3.8/3.7/3.6 Flash 各 high/medium/low、Gemini 3.1 Pro high/low，共 11 行 TSV，见[API 列表](./evidence/antigravity-cli-1.2.16/google-auth-api-models.json)。不是一次真实 API 推理。
登录后多出 Claude Opus 5.5、Claude Sonnet 5.5 各 low/medium/high，以及 GPT-OSS 120B medium，见[账号列表](./evidence/antigravity-cli-1.2.16/google-auth-signedin-models.json)。目录出现不等于每个模型已跑通；本次实跑默认 Gemini。[官方模型页](https://antigravity.google/docs/models)有计划权益，不能用其列表替代固定版本的账号实测。

runner 的做法（§16.10）：凭据目录有 token 时，用 `antigravityGoogleCommand` 跑 `agy models`（stdin 用管道 EOF），上报账号目录，18 行折成 7 个模型；被拒和断网都只显示上面那句 `Please sign in…`（§16.4 同理），这时回落到 API 模式的目录，让填 key 的 Gemini provider 会话的模型列表不跟着消失。没有 token 时照旧只读 API 模式目录。

### 16.8 使用条款与数据使用

**当前没有 Orbit 使用个人额度的明确许可，且存在直接第三方限制。**【官方原文，2026-10-04】[附加条款](https://antigravity.google/terms) §6 原文“Using third party software, tools, or services to access the Service”，将此类访问视为违约，举 OpenClaw + Antigravity OAuth 为例，可能暂停或终止账号。[官方 FAQ](https://antigravity.google/docs/faq#why-cant-i-use-third-party-software-such-as-claude-code-openclaw-or-opencode-with-my-antigravity-login)也限制第三方软件，建议第三方 coding agent 使用 Gemini Enterprise 或 Google AI Studio API key。

条款 §4 承认服务内部的 agent 编排，[官方 headless](https://antigravity.google/docs/cli/headless/)支持脚本/CI/程序驱动。**推断**：这不证明 Orbit 包装官方 `agy` 后获 §6 豁免；未查到对应例外。获得 Google 明确许可前不推荐上线个人 OAuth 模式，也不通过提取 token、改 endpoint、多账号轮换规避限制。

Free 与个人 Pro/Ultra 同受 §3/§5 的交互数据收集、人工审阅和产品/模型改进规则约束，可在设置退出；没有找到“付费个人订阅自动免训练”的保证，参见[Account / Enable Telemetry](https://antigravity.google/docs/settings/#data-collection-settings)。Enterprise 在条款开头另列合同路径；不能把 Gemini API/Enterprise 的承诺套到个人订阅。前文 API 模式遥测实测也不能保证账号模式关闭全部云端数据使用。

### 16.9 实现建议与推荐

**推荐暂不实现个人额度接入，保留 Gemini API key 路径。** 先取得 Google 对第三方包装官方 CLI 的明确许可，再补不同账号、跨平台强制文件隔离、并发续期、真正撤销/限流与不泄露输入的录制。真实对话成功不能解除条款和隔离问题。

| 层 | 获准后必要改动 |
| --- | --- |
| runner `login.go` | PTY 登录、菜单/首次设置处理、ANSI/OSC 8 URL 截取、回填/取消/拒码；写码期间禁止录制或输出输入区间，退出后探测。90 秒 URL/10 分钟总超时需和实际行为校对。 |
| runner `doctor.go` | 内置引擎改为账号 probe，可研究独立 `/usage`，保留 yes/no/unknown、区分网络/认证错误；不上传邮箱/token。配置 Gemini provider 仍按注入 key 判断。 |
| runner `antigravity_home.go` / 账号槽位 | 按认证来源决定 `modelProvider=gemini`；持久凭据和每会话配置分开，MCP/hooks/rules/会话库保持隔离。只在验证文件模式后使用私有目录，不能借固定系统 keyring 键或共用整个目录。登录、doctor、spawn、登出统一槽位选择，移除账户前清理所有凭据副本。 |
| runner 事件/模型/额度 | 按真实结构化认证/限流错误分类；按认证模式/账号权益读模型。独立解析 `/usage` 的 `command_result` bucket 比例/reset，不当作 agent turn；token usage 不是账号剩余额度。 |
| shared / apiserver | 扩大当前仅 Claude/Codex/Kimi 的 LoginEngine 校验、登录命令、签出 preflight，增加 runner 能力门槛；区分内置账号引擎与 BYOK provider。多账号选择和派发目录不能沿用“非 Claude 就 CODEX_HOME”；token 留在 runner。 |
| web | 扩充 `RunnerSignIn` 名称/入口，去掉 Antigravity 不显示认证状态、忽略 `auth=no`、固定 API key 错误文案的特判；显示真实模型、登录恢复和账号额度。 |
| macOS / iOS | 同步 OrbitKit EngineAuth / SessionProviderChoices 和共享 RunnerSignIn。iOS 复用 macOS SwiftUI/OrbitKit 源码，不需要另一套登录协议。 |

风险包括条款/封号、个人数据收集、闭源隐藏参数变动、钥匙串键串账号、凭据副本续期/登出不一致、共享配置破坏审批隔离、登录输入回显泄露、credits 额外消耗和并发重试风暴。当前证据没有证明这些风险都已解决。

### 16.10 runner 的 Google 模式会话

项目「Antigravity 支持 Google 账号登录」第 2 步落地的行为（`antigravity_google_session.go`）。§1–15 的 API key 路径不变。

- **认证来源**，每次 spawn 重新判定，并在 runner 日志记一行 `starting agy, auth source <来源>`，不含任何凭据内容：会话自带 `GEMINI_API_KEY`（填了 key 的 Gemini provider，或 workspace 环境）→ `session_key`，一律 API key 模式，不看凭据目录；否则凭据目录有 token → `google`；否则 runner 环境有 `GEMINI_API_KEY` → `env_key`（即原来的行为）；都没有 → `none`。
- **会话目录**：仍是每会话自己的 `--gemini_dir`（§3.1）。Google 模式的 settings 不设 `modelProvider`、设 `useG1Credits: false`，其余（`enableTelemetry: false`、权限规则、hooks、MCP、GEMINI.md）与 API key 模式相同。spawn 前把凭据目录的 token 复制到会话目录的同一相对路径 `antigravity-cli/antigravity-oauth-token`（0600，独立文件，不共用目录、不做软链）；这个 agy 进程退出后由回收它的 goroutine 删掉副本。每次 spawn 先删掉上次留下的副本（不论哪种模式），runner 启动时清掉所有会话目录里的副本，覆盖中断、崩溃、runner 重启。
- **进程**：Google 模式的 agy（含审批闸门的 `--print=/hooks` 检查）用 §3.2 的 D-Bus 地址、去掉 key 类环境变量，另加 `--log-file=<gd>/antigravity-cli/orbit-google.log`（每次启动截断），只用于下一条的判定。
- **未登录识别**：agy 以 §16.4 的组合结束（退出 1、没有 `init`、stderr 同时有 `authentication required` 和 `authentication failed or timed out`），且日志里没有 `due to network error`，判登出：按 claude/codex「引擎已登出」的路径上报——当前轮次（没有轮次时是会话）以 `Failed to authenticate: …` 失败，web 据此给出带登录按钮的错误卡；会话以 FAILED 结束；runner 立即重跑一次引擎状态探测并发 heartbeat，让 `engines[].auth` 由 yes 变 no 马上可见——控制面就是按这个变化发「引擎已登出」通知的（Antigravity 进 `LOGIN_ENGINES` 由第 3 步接上）。agy 那句 `Run 'agy' to log in` 不进 transcript。日志说是网络错误时只让当前轮次失败（不是 `Failed to authenticate`），会话继续，下一轮重试。
- **preflight**：凭据目录有 token 时，`engineAuthPreflight` 不再先跑 `/usage`，交给会话自己的 agy 判定（它能分清网络和登出，且省掉每次开会话前的一次联网）。
- **settings 被 agy 重写**【实测，2026-10-04，1.2.16，两种模式都一样】：agy 启动时会按它自己的结构重写 `settings.json`，`enableTelemetry` 和值为 false 的 `useG1Credits` 都会消失（`useG1Credits` 在 agy 里是 `omitempty` 的 bool，缺省即 false；`theme`、`modelProvider` 这类非零值保留）。Orbit 每次 spawn 前重写这份文件，所以每个 agy 启动时读到的是 Orbit 的值；agy 运行中会不会重读这份文件【未确立】。

### 16.11 多个 Google 账号（2026-10-06）

§16.6 的「每台 Linux runner 一个账号」到此为止：Antigravity 和 Claude Code、Codex 一样按账号槽位管理（`src/runner-go/antigravity_account_slot.go`，存储本身是 `account_slot.go`）。

- **一个账号就是一个 Gemini 目录。** Default 是原来那份登录，`<orbit home>/antigravity/google`，升级后原样保留；「+ Account」加的账号在 `<orbit home>/antigravity-accounts/<8 位十六进制>`，旁边一份记录存名字。登录、`/usage` 探测、模型目录都用 `antigravityGoogleCommand`，只是 `--gemini_dir` 换成那个账号的目录；§16.5 的隔离（临时 HOME/XDG、不可达 D-Bus、去掉凭据变量）一样不少。
- **会话怎么落到账号上。** agy 没有指定目录的环境变量，所以控制面派发时注入 Orbit 自己的 `ORBIT_ANTIGRAVITY_GOOGLE_DIR`（同 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 的位置），runner 只认 Default 或自己的槽位目录，据此复制令牌（§16.10），并且不把这个变量交给 agy。会话的对话库在会话自己的 Gemini 目录里，不在账号目录里，所以换账号只是下一次 spawn 换一份令牌，不需要「搬对话」的能力；能否在不同账号间续同一个 `--conversation` 【未实测】。
- **没有 key 回退。** 加的账号没登录就是没登录，会话以 `Failed to authenticate` 失败（`antigravityAccountSignedOutMessage`），不会悄悄用 runner 的 `GEMINI_API_KEY`；只有 Default 保留原来的 key 回退。
- **上报。** `engines[antigravity].accounts` 与 Claude/Codex 同形（id、name、home、auth）。Default 的 `auth` 只说 Google 登录：靠 key 跑的 runner 上引擎是 `yes / env_key`，Default 账号是 `no`。各账号额度同一次 `/usage` 读出，放在 `engines[antigravity].planUsage.accounts.<id>`（Default 的仍是 `buckets`），控制面按账号挑选、预检时用 `withEnginePlanUsage` 并进来比较，bucket 的剩余比例换算成已用比例。
- **能力。** `antigravity-account-login/v1`、`antigravity-account-remove/v1`。旧 runner 不声明，控制面不给它派加账号/删账号。
- **条款。** §16.8 的风险不因多账号消失，反而更显眼：Google 的条款限制第三方工具使用个人账号登录，§16.9 也不建议用多账号轮换规避限额。页面把 Google 条款放在每次登录的入口旁；是否开启自动换号由使用者决定。

## 附录：实测记录索引

全部在 2026-10-03、agy 1.2.15、本机 runner 上进行。"样本"一栏指 `src/runner-go/testdata/antigravity/` 下的目录；
没有样本的实验，原始输出在本机 `/var/tmp/agy-c0/runs/<编号>/`（不入库），做法可以用 `docs/evidence/antigravity-cli-1.2.15/drive.py` 复现。

| 编号 | 做了什么 | 结果 | 样本 |
| --- | --- | --- | --- |
| `s01` | 第一次运行，纯文本一轮 | 冷启动约 12 秒；思考不出现；看到三类外连 | — |
| `e7a` | `--gemini_dir` 加假的真 HOME | 生效，真 HOME 零写入 | — |
| `e7b` | `--app_data_dir` 绝对路径 | 启动失败，且往真 `~/.gemini` 写了日志 | — |
| `t01`/`t02` | 工具：默认模式 / skip 模式 | 默认软拒绝、整轮结束；skip 下五种结局 | `denied-default`、`tools-skip-permissions` |
| `t03` | 一个进程两轮 | 累计的 `num_turns`/`usage` | `text-multiturn` |
| `t04a`/`t04b` | 400 无效 key / 429 RetryInfo 40s | `error_message`、`AGY_ERROR`、退出 3、不重试 | `error-invalid-key`、`error-quota-429` |
| `t05a`–`t05g` | 恢复：正常 / 报错后 / id 不存在 / 报错后两轮 | 续上；`system_message`；悄悄开新会话；ERROR 粘住 | `resume/`、`resume-after-error/`、`unknown-conversation` |
| `t06a`–`t06g` | SIGINT、SIGTERM、SIGKILL × 流式 / 命令运行中 | §4.1 的进程表 | `interrupt-sigint-streaming`、`interrupt-sigint-tool` |
| `t07a`–`t07d` | 轮次中插话 × `queuedMessages` | 一律排队成下一轮 | `midturn-message-queued` |
| `t08`、`t08b`–`t08d`、`m1`–`m4` | 遥测开关，TLS 拦截 | §7 的表 | — |
| `u1`–`u3` | 自升级：放行 / `=1` / `=true` | 原地替换 / 照样替换 / 关掉 | — |
| `p_*`、`q_*`、`x_*` | 权限矩阵和规则 | §5.3 的表 | — |
| `mc_probe`、`mc_default`、`mc_allow`、`mc_allow_accept` | MCP：skip 模式 / 默认模式 / 默认模式加 `mcp(orbit/*)` / accept-edits 加同一条 | 调通、环境继承 / 软拒绝 / 放行 / 放行 | `mcp-call` |
| `h_*`、`r1`–`r3` | hook 位置、默认模式 allow、超时、各类事件、仓库 `.agents/` | §5.4、§3.5 | `hook-deny` |
| `sl_*` | 斜杠命令 | `/model` 让进程退出 2；`--disable-slash-commands` 有效 | `slash-model-ends-session` |
| `mo_*` | 模型 slug 和 effort | §9.2 的表 | — |
| `aq_*` | `ask_question` | `unknown` 步骤、"User Skipped" | `ask-question-headless` |
| `envp` | 命令和 hook 看到的环境 | §3.2 | — |
| `wb1`/`wb2` | `bin/` 软链共享 | webm_encoder 只解一次 | — |
| `pt_default` | 模型 315 秒才回复 | 不超时 | — |
| `v_*` | `--print` 不带等号、文本块数组、MCP 进程组 | 退出 2 并提示；可用；在 agy 进程组 | — |
| `final` | 完整推荐 argv 和目录布局 | 两轮、命令、MCP 全部正常 | — |
| `realmcp` | 真的 `orbit mcp`，临时 HOME | 起不来（没有 runner 配置），agy 不报错照常运行 | — |
