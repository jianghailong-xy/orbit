# 固定版本 ACP 实验录制

本目录是 P0 的 Linux 实测产物，支持范围见[运行时契约](../../../deepseek-harness-runtime-contract.md)。

- 开始时间：`2026-10-04T06:53:55.386Z`。
- CLI：`@deepseek-ai/dsh@0.2.0-rc.2`，Node `v26.10.0`，`linux/x64`。
- 对照源码：`dsh-v0.2.0-rc.2` / `639ed015397290b3745d163aafe02ffee4aa3f84`。
- 最终运行：锁文件全新安装后直接执行复现程序，24 场景全部通过；20 个真 CLI 进程、739 行录制。
- `stdoutProtocolClean=true`；真实 `~/.dsh` 起步不存在，前后状态相同。
- 录制 SHA-256：`e11a58e0e3c7d176f93dcae30ec1387673383ff44a86c26b4e3464ae04250858`。CLI、锁文件 hash 和 npm integrity 在 summary 中。

[protocol.ndjson](protocol.ndjson) 是双向 ACP、mock Messages 请求/SSE、MCP 入站/副作用、进程与检查结果。
[summary.json](summary.json) 按场景列出断言结果和 seq 区间；seq 等于 NDJSON 行号。
[manifest.json](manifest.json) 校验录制字节。最后的进程清理记录可以出现在最后一个检查区间之后。

复现使用[脚本与说明](../../../../scripts/deepseek-harness-p0/README.md)：

```sh
npm ci --prefix scripts/deepseek-harness-p0 --cache /tmp/orbit-dsh-p0-npm-cache --no-audit --no-fund
node scripts/deepseek-harness-p0/reproduce.mjs /tmp/orbit-dsh-p0-evidence
```

所有模型内容、API Key、MCP 身份和副作用都是合成数据；路径、端口、UUID、Key 已替换为关联占位符。
mock 返回多段 SSE，但 ACP 正文/思考按已提交消息块到达。审批断开没有 prompt response，即使进程退出 0 也不是本轮成功。
SIGKILL 恢复保留历史和未完成用户轮；观察到的副作用计数为 1，不证明真实模型续聊时不会重试工具。

macOS/Windows、其他 Linux/Node 组合、HTTP MCP、真实 Key/模型及 Orbit 产品链没有由这份录制确立。
源码判断与首版接口/降级属于契约里的独立标签，不能当作本次实测通过。
