# Gemini / Antigravity 入口验证

这套脚本用本分支构建的 apiserver 和 web 验证入口、修复按钮和 API 预检。
三个 runner 是带 `isolated-gemini-entry-fixture` 标签的模拟 heartbeat 客户端：
`build-box` 声明支持且已安装 agy；`HPC` 报告 Orbit runner 0.1.208、没有声明支持；
`workstation` 声明支持但没有安装 agy。它们不认领或执行会话。

## 复现

先构建 shared、apiserver、web，生成 Prisma client，并对独立 PostgreSQL 部署本分支迁移。
本次隔离容器名为 `orbit-gemini-entry-6rl1-pg`；脚本固定校验
`127.0.0.1:32927/gemini_entry`，数据库用户须为 `gemini_entry`。
在独立端口启动本分支 API，使用独立的 `JWT_SECRET` 和 `PROVIDER_SECRET_KEY`。
不要把脚本指向正在使用的部署。

下面的 API 端口是本次运行的示例，上传目录替换为当前证据会话目录：

```bash
export DATABASE_URL=postgres://gemini_entry:isolated_test_only@127.0.0.1:32927/gemini_entry
export API_ORIGIN=http://127.0.0.1:39731
export GEMINI_ENTRY_UPLOADS=/path/to/session/uploads
node docs/evidence/gemini-antigravity-entry/seed.mjs

EVIDENCE_DIR="$GEMINI_ENTRY_UPLOADS" \
CHROMIUM=/path/to/chromium \
node docs/evidence/gemini-antigravity-entry/screenshots.mjs
EVIDENCE_DIR="$GEMINI_ENTRY_UPLOADS" node docs/evidence/gemini-antigravity-entry/boards.mjs
```

[`seed.mjs`](seed.mjs) 创建测试用户、Gemini provider、四个 workspace 和三个历史修复会话；
通过 HTTP 断言内置 Antigravity 无 key 时返回 409、Gemini BYOK 和 workspace key 可以建会话，
并校验 runner readiness、workspace key map 和会话实际 runner 的 key map。
它可继续同一测试用户的未完成初始化。截图交互会切换会话 provider 和启动模拟安装 relay，
seed 会重置这三个历史会话及 runner 的模拟安装 relay，便于重新截图。

[`screenshots.mjs`](screenshots.mjs) 自行启动临时 web 静态服务和 Chromium，刷新模拟 runner
heartbeat，保存四种选择器、三种 runner 行、Gemini 状态和三种会话提示的 PNG。
它还验证不可用行定位到对应 Providers 行、Connect Gemini、同运行时 Switch to Gemini
和 Install 写入 relay。浏览器 PID 会记录在上传目录，只结束它自己启动的进程组。

上传目录中的 `gemini-entry-fixture.json` 仅包含测试访问 token、runner token 和 fixture 地址，
文件权限为 0600，不应提交到仓库。`gemini-entry-api-checks.json`、
`gemini-entry-browser-checks.json` 和 PNG 是可提交的检查记录。
所有 API key 都是 dummy 值；脚本不读取真实 Gemini key，也不调用 Gemini API 或运行 agy。
历史失败事件和 runner 安装状态由 fixture 模拟，截图来自实际构建的页面。
`boards.mjs` 仅将原始截图排版为选择器、Providers、会话提示三张图板，不重画页面。

本次本地验证：apiserver 4149 项、shared 376 项、web 相关 588 项通过；最终会话修复回归
125 项、选择器 16 项通过；OrbitKit 完整 `swift test` 2729 项、0 失败、5 项既有跳过。
隔离 API 25 项检查和浏览器 17 项交互断言通过，保存 12 张原始截图，无浏览器异常。
Linux 没有预装 Swift，因此使用已有 `swift:6.1` 容器编译并执行 OrbitKit 测试。
OrbitApp 的改动通过 Swift 语法解析及源码对照；macOS/iOS 的完整类型与平台构建需 Client CI。

## API 契约

- `GET /runners` 的 `antigravity` 包含 `supported`、`installed`、`version`、`envKeyAvailable`。
  `installed: null` 表示尚未上报，`envKeyAvailable` 只说明 runner 进程有没有 key。
- heartbeat 把 `X-Orbit-Supported-Providers` 保存为现有 `Runner.capabilities` 中的
  `provider:<slug>` 标记；每次替换，header 缺失时清除，保留其它协议 capability。
  支持状态依赖明确声明，新 API 尚未收到该 runner 的首次 heartbeat 时视为不支持。
- workspace 的 `antigravityKeyAvailableByRunner` 由服务端计算：非空 workspace key 或该 runner
  的 `auth=yes`。独立 workspace 接口覆盖所有同 owner runner；会话详情覆盖实际 assigned runner。
  值都是 boolean，公共 API 的 map key 和 `runner.id` 同为 base62，机器协议保留 UUID。
- 内置 Antigravity 仅在在线 runner 明确报告 `auth=no`、workspace 没 key 时走现有 409
  预检拒绝路径。带自己 key 的 Gemini provider 跳过该检查。
- `POST /runners/:id/install` 接受 `engine: "antigravity"`，复用现有 heartbeat 安装 relay。
  `InstallEngine` 扩展安装范围，`LoginEngine` 仍只有 Claude、Codex、Kimi。
