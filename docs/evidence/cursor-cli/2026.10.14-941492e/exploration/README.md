# 写脚本之前的探索录制

- [`explore5-protocol.ndjson`](explore5-protocol.ndjson)：真实 prompt 账本第 1 条（2026-10-16 16:34 UTC）。用同一套 `lib/acp.mjs` + `lib/redact.mjs` 录制、脱敏。
  场景：默认白名单模式下一个 prompt 依次读文件、`ls -la`、写文件、`echo … > file`、调注入的 stdio MCP、web fetch，每个权限请求都答 allow-once；
  然后在新进程里 `session/load`。结论和后来脚本化的 `multi-turn-tools-default` 一致：读、`ls`、工作区内写不问权限；`echo`、MCP、fetch 问权限；
  fetch 的权限请求 toolCallId 是 `web_fetch_0`；load 先重放历史（user_message_chunk、合并后的正文/思考、`replay-0-N` 工具卡），再返回结果。
- 账本第 2、3 条（17:22 UTC）是 `--selftest` 的一个脚本缺陷造成的：ESM import 提升，标志在 harness 读取之后才设置，于是"自测"驱动了真 CLI。
  这两次 prompt 真的发出并完成了，但进程被中途杀掉，协议录制没写出。留在运行目录里的产物（工作区文件、MCP 副作用日志、strace、会话库）事后检查，
  和第 4、5 条（`multi-turn-tools-default` 正式录制）的结论一致。缺陷已修：标志改为调用时读取，self-test 模式下 `chargePrompt` 直接拒绝，
  `prompt()` 还会核对生成的进程是不是假 agent。
