# P0 真 DeepSeek Harness ACP 复现

固定 `@deepseek-ai/dsh@0.2.0-rc.2`；完整依赖和 integrity 在 `package-lock.json`。
实验使用官方 npm 可执行文件、本地 Messages SSE mock、真实 stdio MCP 子进程，不替换 dsh/ACP 实现。
本脚本的可执行验收范围是 Linux；macOS/Windows 只做源码前提核对。

在仓库根目录执行：

```sh
npm ci --prefix scripts/deepseek-harness-p0 --cache /tmp/orbit-dsh-p0-npm-cache --no-audit --no-fund
node scripts/deepseek-harness-p0/reproduce.mjs /tmp/orbit-dsh-p0-evidence
```

已有独立安装时可以指定可执行文件，但脚本仍强制核对版本：

```sh
P0_DSH_BIN=/tmp/orbit-dsh-p0-install/node_modules/.bin/dsh node scripts/deepseek-harness-p0/reproduce.mjs /tmp/orbit-dsh-p0-evidence
```

需要允许回环端口、子进程和本机文件沙箱。Codex 执行环境中的 EPERM 属于执行环境限制；不能当作 dsh 的结果。
脚本检查 spawn 错误、版本、全部 24 个场景及真实 `~/.dsh` 指纹；任何失败、启动失败、缺场景均退出非零。
这是直接 Node 程序，不使用 `node --test`，不接管道，不把握手或进程退出 0 当作 prompt 成功。

每次实验创建 `/tmp/orbit-dsh-p0-run-*`，为不同会话创建独立 `DSH_HOME`。保留真实 HOME，子进程仅继承 PATH/HOME，所有 Key 和模型内容均为合成数据。
禁用遥测；不复制真实凭据、profile 或用户 `.env`。MCP 和文件副作用限于该临时树。
临时目录有意保留，便于检查压缩会话日志；原始实验不写入真实 Harness 配置。

输出包含 `protocol.ndjson`（双向 ACP、模型请求/SSE、MCP、stderr、退出及检查结果）、`summary.json`（每场景 seq 范围和断言结果）、`manifest.json`（录制 SHA-256）。
脱敏仅替换安装/脚本/临时路径、UUID、合成 Key，保留方法、字段、错误、关联关系及凭据来源标签。
端口是占位符；录制不可直接发回进程，重新运行脚本才是复现。

24 个场景覆盖协议、消息块、字面追加系统提示、配置选择、工具、MCP、允许/拒绝/Stop/断开、错误/上限、两进程隔离、配置与凭据层、EOF/SIGTERM/SIGKILL 和恢复。
已提交录制在 [`docs/evidence/deepseek-harness/dsh-v0.2.0-rc.2/`](../../docs/evidence/deepseek-harness/dsh-v0.2.0-rc.2/)，支持范围和接口约定以[运行时契约](../../docs/deepseek-harness-runtime-contract.md)为准。
