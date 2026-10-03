# mockgemini — 驱动真 agy 的离线 Gemini 服务

`agy`（Antigravity CLI）在 API key 模式下只跟 Gemini 原生 API 说话。这个程序冒充那个 API，
让契约测试能离线驱动**真的** agy：不需要真 key，也不花钱，回复完全由测试决定。
实测结论见 [`docs/antigravity-runtime-contract.md`](../../../../docs/antigravity-runtime-contract.md)；
用它在 agy 1.2.15 上录下的 stream-json 样本在 [`../antigravity/`](../antigravity/)。

只依赖标准库，测试里 `go build ./testdata/mockgemini` 就能编出来（`./...` 不会扫到 testdata）。

## 起服务

```sh
go build -o /tmp/mockgemini ./testdata/mockgemini
/tmp/mockgemini -log /tmp/requests.jsonl -url-file /tmp/mock.url &
# stdout 第一行：MOCKGEMINI_URL=http://127.0.0.1:<port>
```

| flag | 默认 | 作用 |
| --- | --- | --- |
| `-addr` | `127.0.0.1:0` | 监听地址 |
| `-log` | 无 | 每个请求追加一行 JSON（方法、路径、key 来源和长度、完整请求体、回了什么）。**不记 key 本身** |
| `-url-file` | 无 | 监听后把基地址写进这个文件 |
| `-models` | agy 1.2.15 实际请求的 5 个 API 模型 id | `GET /v1beta/models` 列出的模型（agy 1.2.15 实测不读它） |
| `-chunk-runes` / `-chunk-delay` | `12` / `15ms` | 流式文本每块多少字、块间隔多久 |
| `-want-key` | 无 | 设了之后，key 不等于它就回 Gemini 的 `API_KEY_INVALID`（400） |
| `-tunnel` | 关 | 作为 HTTPS 代理时真的连出去；默认只记录主机名然后拒绝 |
| `-static` | 无 | 没匹配 Gemini 路由的 GET 从这个目录取文件（给 agy 的 `--release_base_url` 喂假的自升级 manifest） |

路由：`GET /v1beta/models`、`GET /v1beta/models/{m}`、`POST …/{m}:streamGenerateContent`（`alt=sse` 回 SSE，
否则回 JSON 数组）、`POST …/{m}:generateContent`、`POST …/{m}:countTokens`。其余回 Gemini 形状的 404。

## 让 agy 连到它

```sh
GD=$(mktemp -d)                      # Orbit 的每会话 gemini 目录，见契约 §3
mkdir -p "$GD/antigravity-cli"
echo '{"modelProvider":"gemini","enableTelemetry":false}' > "$GD/antigravity-cli/settings.json"

env -i PATH="$PATH" HOME="$(mktemp -d)" \
  GEMINI_API_KEY=mock-key \
  GOOGLE_GEMINI_BASE_URL="$(cat /tmp/mock.url)" \
  HTTPS_PROXY="$(cat /tmp/mock.url)" \
  AGY_CLI_DISABLE_AUTO_UPDATE=true \
  agy --gemini_dir="$GD" --print= --input-format stream-json --output-format stream-json
```

- `HTTPS_PROXY` 指向同一个服务：agy 想连的每个外部主机（功能开关、遥测、自升级）都会以一行
  `CONNECT` 记进日志并被拒，测试保持离线，也能断言"没有往外连"。Go 对 `127.0.0.1` 本来就不走代理，
  所以模型请求照样直达。
- `settings.json` 里没有 `"modelProvider": "gemini"` 时 agy 会要求登录 Google 账号；只设 `GEMINI_API_KEY` 没用。

## 用提示词写剧本

最近一条带 `mock:` 行的用户消息就是剧本。每一行是一个动作，按顺序组成一次次模型回复：

| 行 | 效果 |
| --- | --- |
| `mock:text <文字>` | 当前回复加一段正文（分块流式发出；`\n` 表示换行） |
| `mock:think <文字>` | 当前回复加一段思考（`thought: true` 的 part） |
| `mock:tool <name> <JSON 参数>` | 当前回复以一个 functionCall 结束（附带 `thoughtSignature`） |
| `mock:error <状态码> <STATUS> [retryDelay=40s] <消息>` | 这次回复是一个 HTTP 错误，Gemini 的错误体形状 |
| `mock:finish <REASON>` | 当前回复的 finishReason（默认 `STOP`） |
| `mock:sleep <时长>` | 回复前先等，Go duration 写法（如 `6s`） |
| `mock:usage <输入> <输出> [<思考> [<缓存>]]` | 覆盖当前回复的 usageMetadata（默认按请求体和回复长度估算） |
| `mock:hang` | 发完已有部分后挂住流，直到客户端断开（测中断用） |

第几次回复由剧本消息之后有几个模型轮次决定：工具结果回来后发下一个，重试同一个请求拿到同一个回复，
剧本用完回 `mock: script finished`。以 `mock:tool` 结尾的剧本会自动补一个正文回复 `mock: tool result received`。

没有声明工具的请求（标题生成等旁路调用）永远不走剧本，只回 `mock reply: <首行>`，免得剧本漏进去。

例：一轮里先跑命令，再给结论。

```text
修一下构建
mock:think 先看看报错
mock:tool run_command {"CommandLine":"make","Cwd":"/work","WaitMsBeforeAsync":60000,"toolSummary":"Build","toolAction":"Running build"}
mock:text 构建通过了。
```

MCP 调用走通用工具：`mock:tool call_mcp_tool {"ServerName":"orbit","ToolName":"task_get","Arguments":{},"toolSummary":"…","toolAction":"…"}`。

## agy 1.2.15 请求的几个特点（写断言时会用到）

- 主模型调用带 `tools`（`functionDeclarations`），标题生成走 `gemini-3.1-flash-lite-preview`、没有 `tools`。
- 工具结果以 `functionResponse` part 发回，但**放在 role `"model"` 的 content 里**，不是 `"user"`。
- 用户消息被包成 `<USER_REQUEST>…</USER_REQUEST>`，后面跟 `<ADDITIONAL_METADATA>` 等块。
- key 走 `x-goog-api-key` 请求头。
