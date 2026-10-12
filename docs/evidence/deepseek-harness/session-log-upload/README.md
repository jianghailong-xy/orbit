# dsh 会话日志随模型请求上传：内容与开关

固定版本：`@deepseek-ai/dsh@0.2.0-rc.2`，源码 tag `dsh-v0.2.0-rc.2`，提交 `639ed015397290b3745d163aafe02ffee4aa3f84`。CLI sha256、npm integrity、锁文件 hash 见 [summary.json](summary.json)。运行环境为 Linux x64、Node v26.10.0。所有内容、Key 和路径都是合成数据。

## 上游依据（npm 包源码与仓库 README）

- `packages/session/session-log-deepseek`（npm `@deepseek-ai/dsh-session-log-deepseek`，Cordis 名 `session-log-deepseek`）：注册请求字段 `dsh_session_log`，发送上次确认水位之后的规范会话事件，事件内容原样不脱敏。配置 `enabled`（默认 `true`，volatile）和 `maxBytes`（默认 8 MiB，整个字段的 UTF-8 字节数上限）。HTTP 2xx 后追加 `session-log-deepseek/delivery-accepted`。上游 README 写明：`enabled: false` 时停止上传；重新打开后会补传关闭期间的事件。
- `packages/llm/plugin-package-inventory-deepseek`（Cordis 名 `plugin-package-inventory-deepseek`）：注册 `dsh_plugin_packages`，内容只有启用插件包的 `{name, version}`。配置 `enabled`（默认 `true`），为 `false` 时插件不登记该字段。
- `dsh-base/cordis.patch.yml` 在所有基于 base 的 profile（包括 `acp`）中挂载这两个插件。`dsh-llm-deepseek` 对每个请求调用 `deepseekLlmApiExtensions.prepare`，把这些字段并入请求体，发往配置的 baseURL。`DSH_TELEMETRY_DISABLED` 不参与这条路径。
- 凭据：`dsh-subprocess` 的 `scrubbedParentEnv` 从子进程环境中去掉名字匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量和全部 `DSH_*` 变量。

## 录制方法

`TestDshRealSessionLogUpload`（`src/runner-go/dsh_environment_test.go`）复用 P4 的真 dsh 测试框架，经生产准备器 `prepareDshAgentConfigAt` 启动，带 Orbit agent overlay、auto 权限，并在 runner 前放一个 mock Messages 端点，记录完整请求体和请求头。一个会话包含三轮：

1. 普通对话；
2. `read` 工作区文件，再 `write` 新文件；
3. `bash` 执行 `printf 标记; env | sort`。

会话 Key 和一个 runner 侧环境变量都设为合成凭据。

两个变体：

- `upstream-default`：Prepare 后从 `orbit.patch.json` 删掉两条关闭 row，等同于本次修改前的 Orbit 配置，也就是上游默认；
- `orbit-default`：Orbit 当前配置，不做改动。

证据只保留结构信息：字段是否出现、事件类型计数、字段路径与 JSON 类型、插件包标识，以及各合成标记出现在请求的哪个部分。录制脚本会断言证据文件里不含任何合成标记、Key 或临时路径原文。

复现：

```sh
node scripts/deepseek-harness-session-log/record.mjs docs/evidence/deepseek-harness/session-log-upload
```

## 预期与实测

| | 预期 | `upstream-default` 实测 | `orbit-default` 实测 |
|---|---|---|---|
| 带上传字段的请求 | 上游每次都带 / Orbit 为 0 | 6/6 | 0/6 |
| 会话日志中的 `delivery-accepted` | 上游有 / Orbit 为 0 | 6 | 0 |
| 三轮结算 | 均成功 | 成功 | 成功 |
| 请求体和非认证头中出现 API Key | 不出现 | 不出现 | 不出现 |
| 请求中出现 runner 侧合成凭据 | 不出现 | 不出现 | 不出现 |
| bash 输出中出现 Key | 不出现（scrub） | 不出现 | 不出现 |

`upstream-default` 下 `dsh_session_log` 携带的内容（见 [upstream-default.json](upstream-default.json) 的 `markerFoundIn` 和 `eventFieldPaths`）：

- 用户消息原文，包括 workspace `AGENTS.md`/skills 的注入段（`user/message`、`agent/inbox/spliced`）；
- system 消息全文，包括 Orbit 的追加提示词（`system/message`），以及 `request/header` 中的模型配置和全部工具定义；
- 助手消息及其流式块（`assistant/message`）；
- 工具调用参数（`tool/call.data.arguments`，其中有文件路径和要写入的内容）；
- 工具结果（`tool/result`）：读取文件的路径与逐行内容（`meta.path`、`meta.lines[].text`），以及 bash 输出，本例包括 `env` 打印出的 HOME、PATH、DSH_HOME 下的路径和工作区路径；
- 会话头 `session.cwd`，即工作区绝对路径；还有会话 id、创建时间、标题、审批策略、权限预设和沙箱模式。

第一次请求就带上了全部历史（本例约 184 KiB），之后每次只带增量。`dsh_plugin_packages` 列出 84 个包，其中 83 个是 `@deepseek-ai/*`，另一个是 Orbit 的 `orbit-dsh-append-system-prompt@1.0.0`。

`orbit-default` 下请求体顶层只剩模型字段（`max_tokens`、`messages`、`model`、`output_config`、`stream`、`system`、`thinking`、`tools`）。各标记只出现在模型输入里，这部分本来就要发给模型。

## 剩余限制

- 不受本开关控制的请求头：`user-agent`、`x-deepseek-harness-session-id`，以及 `x-deepseek-harness-user-id`（`DSH_HOME/.anonymous-user-id` 中的随机 UUID，Orbit 下每个会话一个）。固定版本没有关闭它们的配置。
- 模型输入本身（消息、文件内容、命令输出）照常发往端点。名字不匹配 scrub 模式、但值中带凭据的环境变量（例如带口令的代理 URL）会出现在 `env` 的输出里。
- 只录制了 Linux x64 / Node 26.10.0 和 mock 端点，没有接真实 api.deepseek.com。审批、MCP 和多轮行为由同一提交上复跑的 P3a、P3b、P4 验收覆盖。
- 压缩（compaction）和会话标题请求在源码中走同一条路径（README：normal agent、compaction、session-title 调用都带 live session id），但本次录制没有专门触发。

## 复跑与合并检查（合入 origin/main 后，提交 `1aac2c257` 加本说明）

| 命令 | 退出码 |
|---|---|
| `bash scripts/test-dsh-acp-driver.sh`（P3a，37 个具名场景） | 0 |
| `bash scripts/test-dsh-session-lifecycle.sh`（P3b 多轮/中断/恢复，37 个场景，race 36 个） | 0 |
| `bash scripts/test-dsh-mcp-approval.sh`（P4 审批/MCP，Go 39 个、TS 19 个，race 31 个） | 0 |
| `node scripts/deepseek-harness-session-log/record.mjs docs/evidence/deepseek-harness/session-log-upload` | 0 |
| `npm run build` | 0 |
| `npm test -w @orbit/shared` | 0 |
| `npm test -w @orbit/apiserver` | 0 |
| `npm test -w @orbit/web` | 0 |
| `(cd src/runner-go && go test ./...)` | 0 |
