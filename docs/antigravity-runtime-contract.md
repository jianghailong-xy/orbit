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
