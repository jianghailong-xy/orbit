# Cursor CLI（`agent acp`）运行时契约（P0a、P0c，Linux；P0b 及其跟进，macOS）

**状态**：项目「Cursor CLI 原生接入」（`34gyHIZv301nDWxKP9XkO`）P0a 的产物，P0c（`34h3xGGSqUnA6DTMj1iop`）补测后修订，P0b（macOS）补了 §18。T0、P1–P6 按这份文件实现。
文档收尾（`34hJAyWIuEl2rXy6q9HlL`，2026-10-19）补上实现任务交付说明里的实测结论和协调会话的裁定：P4b、P5b 跟进、P5c、P6a、P6b、P6b 跟进（§3.3、§3.4、§4、§5、§6、§9、§11–§13、§16、§17）。
D-P8-2 修复（`34iQUqxC9htJed8AY8vic`，2026-10-19）按 P8 的实测补了 §3.2（Cursor 怎么起标题）、§14.4（P8 录到的署名 trailer）和 §7.2、§16.4、§16.7。
D-P8-1 收尾（`34iSsJHzTeI5uzhcGSmlI`，2026-10-19）按 P8、P5c 的录制改正了 §5.2 被拒调用的形状，写明 Orbit 怎么结算被拒的调用，§4.1、§16.4 同步。
撤回的审批卡（`34iTwiTCaIxwfXdQlHvIR`，2026-10-19）：还没人应答、这一轮就结束的审批卡，它的调用按没有运行结算（§5.2），§3.3、§16.4 同步。
macOS runner 支持（`34lk6zafdNyu67SiAD3q9`，2026-10-25）：runner 固定 darwin/arm64 的 tarball，macOS 上也保留 Default 以外的账号，登录按平台取路径，
每个 CLI 进程都显式设凭据存储（§18.9）；§3.4、§11、§16.1–§16.3、§16.7、§17.1、§18 同步。
改这里的任何一条结论，要同时改依赖它的任务。已定的设计（作业指导里的所有者决定）不在这里重新论证。

**实测版本**：**Cursor CLI `2026.10.14-941492e`**，linux/x64，HPC（内核 `6.12.107+deb13-amd64`，24 核，root）。
- tarball：`https://downloads.cursor.com/lab/2026.10.14-941492e/linux/x64/agent-cli-package.tar.gz`，183,861,376 字节，
  SHA-256 `6f6bf39dd2df29dcd38643cdfab0155ce71699953889f732deec123f6562bb2d`。2026-10-17 01:40 UTC 重新下载，仍可取到，哈希不变。
- **后续任务都固定用它。** 官方安装脚本 `https://cursor.com/install` 在 2026-10-17 01:40 UTC 给的是 `2026.10.16-e3cb207`（官方 2026-10-16 发布），两版的差异见 §1.3。
- darwin/arm64，orbit-macos（macOS 27.0.1，Apple M2；P0b）。tarball：`…/darwin/arm64/agent-cli-package.tar.gz`，178,006,204 字节，
  SHA-256 `c6d9e2eaa1b1e24221517e0b4206b1f1593792e6f0d8a52e9b507bbe7ab0cc77`（2026-10-17 在 orbit-macos 上测得；2026-10-25 在 HPC 重新下载，大小和哈希不变）。
  runner 固定这两个平台的 tarball（`src/runner-go/cursor_install.go` 的 `cursorArtifacts`，§18.9）。macOS 结论见 §18。
- Linux 解包后 458 个文件，586,293,819 字节（macOS：450 个文件，596 MB，§18.1）。`index.js` SHA-256 `27776c58…2113482`，启动脚本 `cursor-agent` SHA-256 `2ccc9a8e…a233`，
  自带 `node` SHA-256 `e0e46d3a…62a4`。全部文件哈希见 `/mnt/data/cursor-p0/dl/2026.10.14-941492e/files.sha256`（Linux）与 macOS 证据目录（§18）。

**方法**：
- 真 CLI 加所有者的 Cursor User API Key，跑脚本 [`scripts/cursor-p0/reproduce.mjs`](../scripts/cursor-p0/reproduce.mjs)，结果在
  [`docs/evidence/cursor-cli/2026.10.14-941492e/`](evidence/cursor-cli/2026.10.14-941492e/)（P0a）和它下面的 [`p0c/`](evidence/cursor-cli/2026.10.14-941492e/p0c/README.md)（P0c），
  macOS 的结果在 [`docs/evidence/cursor-cli/macos-2026.10.14-941492e/`](evidence/cursor-cli/macos-2026.10.14-941492e/)（P0b）。
- 每个场景一个 `scenarios/<名>.json`（断言和数据）和一个 `protocol/<名>.ndjson`（双向 JSON-RPC 录制，已脱敏）。下文 `` `场景名` `` 指这些文件，
  P0c 跑的场景写成 `` `p0c/场景名` ``。回放样本在 [`src/runner-go/testdata/cursor/`](../src/runner-go/testdata/cursor/)，P0c 的在其下 `p0c/`。
- P5c（`34h05fsaJBXkS3SDQ2smK`）的场景是 **Orbit 自己的 runner**（启动参数、ACP 驱动、权限桥、Orbit MCP）在真 CLI 上跑的，写成 `` `p5c/场景名` ``：
  检查项和事实在 [`src/runner-go/testdata/cursor/p5c/<场景>/summary.json`](../src/runner-go/testdata/cursor/p5c/README.md)，双向录制在同一目录，
  录制脚本是 `src/runner-go/cursor_permissions_real_test.go`（build tag `cursor_real`）。
- 所有 CLI 进程都用白名单环境和隔离目录（HOME、CURSOR_CONFIG_DIR、CURSOR_DATA_DIR、XDG_* 都指向 `/mnt/data/cursor-p0/runs/<runId>/<场景>/slots/<槽>/`）。
  每个场景前后核对 runner 用户真实的 `~/.cursor`、`~/.config/cursor`、`~/.local/share/cursor-agent`：起步不存在，结束仍不存在。
- 源码结论出自固定版本的打包文件，写成 `文件@字节偏移`。缩写：I = `index.js`，A = `6136.index.js`（ACP agent），
  S = `8096.index.js`（内置 `@agentclientprotocol/sdk` 0.14.1），P = `1623.index.js`，Q = `2496.index.js`，C = `7000.index.js`（只有对话模式加载），
  H = `190.index.js`（hooks），R = `8192.index.js`（只在 `chat` 和 `sandbox-debug` 命令里加载）。`agent acp` 的入口加载 2240、8096、7923、190、1429、2496、1623、6136 这几个分块【源码 I@1740147】，
  它们都不引用 R。
- 官方文档：<https://cursor.com/docs/cli/acp>、`/docs/cli/reference/{permissions,authentication,configuration}`（2026-10-17 读取）。

**标签**：【实测】P0a、P0c 或 P5c 用固定版本真 CLI 测到；【源码】读打包文件得出，没运行验证；【文档】官方文档这么写；
【待验】没能验证（原因写在条目里），实现时不得当作已支持；【约定】Orbit 的实现或协调会话的裁定，条目里写明实现位置或裁定出处。

**真实 prompt**：全部 Auto 模型（`default[]`），各任务各记各的账：
- P0a **20 次**，账本 `/mnt/data/cursor-p0/ledger/prompts.jsonl`，明细见 [`prompts-ledger.json`](evidence/cursor-cli/2026.10.14-941492e/prompts-ledger.json)。
  第 20 次碰到所有者 Free 套餐的免费请求上限（§12、[事故记录](evidence/cursor-cli/2026.10.14-941492e/incidents/quota-exhausted/README.md)）。
- P0c **7 次**，账本 `/mnt/data/cursor-p0/ledger/p0c-prompts.jsonl`（上限 10），明细见 [`p0c/prompts-ledger.json`](evidence/cursor-cli/2026.10.14-941492e/p0c/prompts-ledger.json)。
  所有者 2026-10-17 已把同一个账号升级为付费套餐（`planName: "Premium"`），P0a 卡住的场景这次都跑完了；只有远程登录续聊（`login-account`）仍未做（§9）。
- P5c **16 次**（上限 30），账本 `/mnt/data/cursor-p0/ledger/p5c-prompts.jsonl`，副本 [`p5c/prompts-ledger.jsonl`](../src/runner-go/testdata/cursor/p5c/prompts-ledger.jsonl)。

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
5. **运行期错误不是 JSON-RPC 错误**：额度用尽、模型提供方拒答、轮中断网（P0c 实测）、轮中认证失效，都只是一条以 `"\n\n"` 开头的
   `agent_message_chunk` 加 `end_turn`。分类只能靠文本，样本见 §12。建会话失败时，无效 key 和断网是同一个 `-32603 "Failed to initialize session services"`，
   要用 `agent models` 的退出信息区分（§12）。
6. **恢复**：会话库在 `<CURSOR_CONFIG_DIR>/acp-sessions/<id>/`（`store.db` + `meta.json`），第一次 prompt 时才建 `store.db`。
   `session/load` 先把整段历史作为 `session/update` 重放（`user_message_chunk`、合并后的正文和思考、`replay-<轮>-<步>` 工具卡），再返回结果。
   这个目录拷到另一个 CURSOR_CONFIG_DIR/HOME 后能 load 并带上下文续聊。崩溃时没完成的工具不重放，下一轮 CLI 会给它补一条
   "interrupted" 错误结果（§3.5）。
7. **权限**（§5）：
   - 默认白名单下，读文件、工作区内写文件**不问**；不在白名单的 shell（默认只有 `Shell(ls)`）、MCP 调用、web fetch **问**。
     写工作区外的文件也问（`Write <路径>`），`/tmp/`、`/var/tmp/` 下的除外（P5c）。
   - 选项是 `allow-once` / `allow-always` / `reject-once`。`allow-always` 写进**用户** `cli-config.json` 的 `permissions.allow`，
     而且按程序整个放行（`git status` 总是允许后 `git push` 也不问），所以 Orbit 一律回 `allow-once`（P5c）。
   - `--force`：全部不问。`--auto-review`：ACP 上无效，等于默认。
   - **plan 和 ask 模式都不是只读**：plan 挡住了写文件，但 shell 和 MCP 照常走权限请求；ask 写文件连问都不问。
     模型还能用 `SwitchMode` 自己切出 plan，不问客户端，切走后写文件成功；Orbit 在 Plan 下看到切模式就终止这一轮（P5c 实测，§4.2）。
   - **仓库的 `.cursor/cli.json` 在运行期生效**，能放宽白名单；`--disable-project-configs` 让它失效（P0c 实测，§7.2）。
8. **MCP**（§6）：
   - `session/new` 的 `mcpServers` 注入 stdio 服务器，不需要批准。工具经 `CallDynamicTool` 以「服务器名」命名空间出现，每次调用都问权限。
     ACP 上只看得到 `rawOutput: {success:true}`，看不到结果内容。`orbit mcp` 实测可用。一次工具调用最多 60 s（源码，§6）。
   - **`$HOME/.cursor/mcp.json` 里的服务器在 `session/new` 时就被拉起**，不需批准。仓库 `.cursor/mcp.json` 不经 `agent mcp enable` 不加载，
     `--approve-mcps` 在 ACP 上无效。
9. **目录与凭据**（§8）：
   - CURSOR_CONFIG_DIR 放配置、会话库、allow-always 规则、statsig 缓存；CURSOR_DATA_DIR 放 `projects/<slug>/`。
   - Linux 上 XDG_CONFIG_HOME 决定 `auth.json`；没设 CURSOR_CONFIG_DIR 时，也决定配置目录。
   - **只有 HOME 能移走** `agent-cli-state.json`、内置技能同步目录 `skills-cursor/`、AI 代码追踪库，以及对用户级 `mcp.json`、hooks、rules 的读取。
   - TMPDIR 决定调试日志和 worker socket。
   - `AGENT_CLI_CREDENTIAL_STORE=file`（Linux 默认）会把 **API key 本身**连同 access/refresh token 写进 `auth.json`；`memory` 不落盘。
10. **agent 跑的命令继承 CLI 的全部环境**，包括 `CURSOR_API_KEY`、`CURSOR_AUTH_TOKEN`、HOME、XDG_*、CURSOR_*，外加 `CURSOR_AGENT=1` 等。
    没有「只换 CLI、不换命令」的开关，但 **D4 方案 A 成立**（P0c 实测）：CLI 用路径含 `bash` 的 `$SHELL` 跑环境快照和每条命令，
    P3 的 orbit-bash 让命令拿回真 HOME，看不到 key、token 和账号目录（§8.4）。
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
16. **macOS（§18）**：协议行为与 Linux 相同；差异在凭据——默认存储是 Keychain（条目 `cursor-user`/`cursor-*-token`，per-user 全局，多账号会互相覆盖，且 `/usr/bin/security` 按 `$HOME` 解析：账号 HOME 下保存会弹框或挂起）。所以 macOS 一律用 `file`（登录进程，`$HOME/.cursor/auth.json`）或 `memory`（会话注入），别碰 Keychain。quarantine 不影响 curl+tar 安装的启动。**D4 方案 A 在 macOS 实测成立**（P0b 跟进，§18.7）。
    runner 已支持 macOS（darwin/arm64，Default 以外的账号也支持），实现见 §18.9。

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
  `agent about --format json` 联网给出 `latestVersion` 和 `latestStatus`：P0a 时是 `up_to_date`，P0c（2026-10-17）时是
  `update_available`、`latestVersion: "2026.10.16-e3cb207"`【实测 `p0c/install-and-version`】。官方出新版是常态，P3 的健康检查只比 `--version`
  和固定版本，不看 `latestStatus`；`install-and-version` 也只记录它，不判失败。

### 1.2 安装体积

tarball 183.9 MB，解包 586 MB。每个账号或会话目录都不需要再拷一份 CLI：CLI 只读自己的安装目录（实测安装目录设为只读后，全部场景照常运行）。

### 1.3 和新版 `2026.10.16-e3cb207` 的对比（P0c，不花 prompt）

- **来源**【实测】：官方安装脚本在 2026-10-17 01:40 UTC 给的是 `2026.10.16-e3cb207`
  （`https://downloads.cursor.com/lab/2026.10.16-e3cb207/${OS}/${ARCH}/agent-cli-package.tar.gz`）。linux/x64 tarball 183,721,050 字节，
  SHA-256 `3aa3f48cd7a3909a98c9b3f2a4085f0c021088bf826690b22c61f424c843e552`（官方不公布哈希，这是下载时算的）；解包 460 个文件，585,824,095 字节。
  固定版本的 tarball 同一时刻仍能从 downloads.cursor.com 取到，哈希不变。
- **场景对比**【实测】：不花 prompt 的 14 个场景在两版上各跑一遍，固定版本的结果在 [`p0c/`](evidence/cursor-cli/2026.10.14-941492e/p0c/README.md)，
  新版的在 [`docs/evidence/cursor-cli/2026.10.16-e3cb207/p0c/`](evidence/cursor-cli/2026.10.16-e3cb207/p0c/README.md)，逐项对比是那里的 `comparison.json`。
  - 13 个场景的断言和记录都相同：握手、认证、会话管理（下面第 1 条除外）、模型目录（两版都是 46 个，记录到的样本和 Opus 5.5 的参数选项相同；Free 和付费套餐下也一样）、凭据存储、目录变量、
    失败形状（含 `--disable-project-configs` 下的无效 cli.json）、团队固定、MCP 和 hooks 的来源、启动时的进程与外连、登录链接、用量接口、信号、调试日志。
    各子命令的 `--help` 文本相同。
  - **不同 1**：`session/new` 不带 `mcpServers` 时，固定版本回 `-32603`、`data` 是 zod 3 的 issue 数组；新版回 `-32602 "Invalid params"`、
    `data` 是 zod 4 的格式 `{"_errors":[],"mcpServers":{"_errors":["Invalid input: expected array, received undefined"]}}`。
    原因是内置的 ACP SDK 0.14.1 改为依赖 zod 4.6.5（固定版本是 3.25.76）【源码 A】。Orbit 总带 `mcpServers`，不受影响；参数校验错误的 `data` 都不要解析。
  - **不同 2**：`session/new` 期间多调一个 `DashboardService/GetTeamReposOrEmptyIfNotInTeam`。
  - **不同 3**：列工作区文件的 `rg --files` 不再带 `--follow`，不跟软链接。
  - 其余差异是运行之间的噪音：statsig 缓存大小、worker socket 路径里的哈希、空闲时 `TrackEvents`、`GetUserPrivacyMode` 的次数。
- **包的变化**【实测文件对比；源码】：
  - 409 个文件不变，47 个变了；新增 `.npmrc`（`ignore-scripts=true`）、`7853.index.js`、`8044.index.js`、`9227.index.js`，去掉 `159.index.js`、`2496.index.js`。
    `node`、启动脚本 `cursor-agent` 不变；`package.json` 多了一份运行时依赖清单。
  - `agent acp` 加载的分块里 2496（Q）换成了 7853，其余相同。契约里 Q@ 的偏移只适用于固定版本。
  - ACP agent（A，`6136.index.js`）只多 37 字节：变量改名、zod 版本、`shell-exec` 模块路径、版本字符串，外加一个 `lastFramePath` 字段。
    ACP 方法和 `cursor/*` 扩展、§12 的固定句子、`$SHELL` 的选法（§8.3）都没变。
- **结论**：固定版本不变。新版没有 Orbit 需要的新行为。发 prompt 的场景没有在新版上跑，它在轮次上的表现【待验】；
  以后升级要先回归发 prompt 的场景，特别是 `shell-wrapper-env`（D4）和 `network-drop-mid-turn`（§12 的句子）。

---

## 2. 启动与握手（覆盖要求 1）

### 2.1 启动

- **命令**【实测】：`<固定版本目录>/cursor-agent acp [选项]`，cwd 为会话 checkout。`acp` 不在 `--help` 里，但 `agent acp --help` 可用。
- **stdout 只有协议行**【实测：所有场景 `stdout/non-protocol` 计数为 0】。stderr 正常为空。
  CLI 另写一份调试日志到 `$TMPDIR/cursor-agent-logs-<uid>/`（§8.2），里面没有 key 和 token【实测 `debug-log-location`】。
- **ACP 路径认的选项**：
  - 【实测】`--force`、`--model`、`--api-key`、`--auth-token`、`--disable-indexing`、`--disable-codebase-ref`。
  - `--disable-project-configs`：【实测 `p0c/repo-config-with-flags`】运行期让仓库 `.cursor/cli.json` 失效（它放行的 `touch` 重新要权限）；
    hooks、MCP、规则、技能、斜杠命令都不受影响（§7.2）。P0a 已测到它不影响启动时的 MCP 和 hooks。
  - 【源码】`-e/--endpoint`（`CURSOR_API_ENDPOINT`）、`--website-url`、`--agent-endpoint`、`-k`、`--debug`、`--workspace`【A@53243、A@82879、I@1691193】。
- **ACP 路径不认的选项**：
  - 【实测】`--auto-review`（§5）、`--approve-mcps`（§6）。
  - 【源码】`--yolo`、`--mode`/`--plan`、`-H`、`--sandbox`、`--disable-auto-update`【A 中零引用】。
  - `--exclude-workspace-context`：`agent acp` 接受它，但**没有可见效果**【实测 `p0c/repo-config-with-flags`】：带不带它，会话库存下的首轮上下文
    除了路径逐字相同，规则、AGENTS/CLAUDE、技能都还在。源码里 ACP 不把它放进请求【A 中零引用】。
- **`--model` 的两种结果**【实测 `failure-shapes-without-prompt`】：
  - 未知模型：第一次 `session/new` 时进程直接 exit 1，stderr 列出可用模型名，`session/new` 收不到回复。
  - 旧式名（如 `gpt-5.5`）：解析成带参数的变体。
  - **Orbit 不要用 `--model`**，改用 `session/set_config_option`，失败时只拿到一个错误，进程不退。
- **项目 `.cursor/cli.json` 无效时，进程在回复 `initialize` 前 exit 1**【实测】，stderr 为 `Invalid project config at …: schema validation failed`。
  合法的 cli.json 只能有 `permissions`，而且 `allow`、`deny` 两个数组都得有【源码 I@3735328、I@3726634】。
  仓库能用一个坏文件让 Cursor 会话起不来。**带 `--disable-project-configs` 时同一个坏文件不再影响启动**，`initialize` 和 `session/new` 照常应答
  【实测 `p0c/failure-shapes-without-prompt`，新版 `2026.10.16-e3cb207` 相同】。P5c 的受保护模式本来就带这个参数；不带的模式（bypass/auto）要先校验，或者也带上它。
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
- **标题按对话收到的第一条 prompt 起**【源码 A@5219、A@9859；实测 P5c、P8】：
  - 每条 prompt，CLI 都把全部 text 块用换行连起来，交给服务端的 `nameAgent({userMessage})` 起名（A@5459）。
  - 对话已经有名字（会话库 `meta` 的 `name`）就不再起。所以一个对话只起一次名，依据是第一条 prompt 的全文。
    只有第一次起名失败，或进程在名字回来之前结束，才会按下一条 prompt 再起。
  - Orbit 新开的对话，第一条 prompt 前面是 Orbit 的指令（§7.2），名字就成了对指令的概括：
    - P5c 经 Orbit 的 runner 录的 11 个会话，10 个叫 "Orbit Agent Instructions"，1 个叫 "Agent Instructions"（`p5c/accept-edits-stop`）；
    - P8 不带标题新建的 key 会话，第一轮后被改名为 "Orbit Agent Instructions"（D-P8-2）。
    - 措辞会变，不能按字面过滤。Orbit 的做法见 §16.4。
  - load 的对话一般已经有名字，重放里也没有 `session_info_update`（`multi-turn-tools-default/load`、`crash-continue-and-shell-wrapper/continue`）。
- **轮中再发 prompt**：A 正在跑 `sleep 43`，发出 B。A 在 6 ms 内返回 `{"stopReason":"cancelled"}`，A 的 shell 子进程被杀；
  B 正常执行，1.9 s 后 `end_turn`。CLI 不替客户端排队。**P5b：轮中消息由 Orbit 排队，当前轮结算后再发**（与项目范围「不支持轮中插话」一致）。
- 第二轮记得第一轮【实测：第二轮正确复述第一轮读到的暗号】。
- **后台命令**【实测 `p0c/background-shell-and-commit`】：
  - 模型用 `Shell` 工具加 `block_until_ms: 0` 把命令放到后台（会话库里的工具参数；ACP 的 rawInput 只有 `{command}`）。
  - 批准后 14 ms，工具卡就以 `completed` 结束，rawOutput 是 `{exitCode: 0, stdout: "", stderr: ""}`，而命令还要跑约 20 s。
    给模型的工具结果是 `Background command started successfully. Shell ID: … PID: …`，输出写到 `<CURSOR_DATA_DIR>/projects/<slug>/terminals/<Shell ID>.txt`。
    **ACP 上看不出这张卡的命令还在跑**，`exitCode: 0` 不代表命令跑完或成功。
  - prompt 不等后台命令：`end_turn` 后 16.9 s 命令才写出文件。之后 40 s 内**没有任何 `session/update`**，后台命令结束也不开新的一轮。
    这和源码一致：后台 shell 和子代理的跟进步骤都在发起它的那个 prompt 请求里跑完【源码 A@15706、A@23155】。
  - 后台命令在轮次结束后照常运行【实测】。CLI 退出或被杀之后它们会怎样【待验】；Orbit 不依赖它：§3.4 的每会话进程作用域（P5b 跟进）
    在 CLI 结束时回收它启动的全部后代，后台命令也在其中。会话还在、只是轮次结束时，它们照常运行。
- **轮外更新**【实测：P0a 和 P0c 全部 27 轮的录制，[`p0c/analysis/turn-endings.json`](evidence/cursor-cli/2026.10.14-941492e/p0c/analysis/turn-endings.json)】：
  没有 prompt 在跑、也没在 `session/load` 重放时，来过的更新只有 `available_commands_update`、`current_mode_update`（客户端 `set_mode` 之后）和
  一条迟到的 `session_info_update`。没有正文、思考或工具更新，也就是**没有 Cursor 自己发起的轮次**。

### 3.3 取消【实测 `cancel-mid-tool`】

- 在 `sleep 47` 运行中发 `session/cancel`，4 ms 后得到 `{"stopReason":"cancelled"}`，sleep 进程被杀，文件没写出。
- **被取消的工具卡停在 `pending → in_progress`，之后再没有 `tool_call_update`**。ACP 这里根本没有 `failed` 状态【源码 A@77469】。
  **P5b：取消、断开、崩溃后，Orbit 自己结算所有未终态的工具卡。**
- **审批进行中（权限请求未答）时停止**【实测 `p5c/accept-edits-stop`，经 Orbit 的 runner】：Orbit 发 `session/cancel`，并对未答的请求回 `cancelled`，
  审批卡撤回；prompt 以 `{"stopReason":"cancelled"}` 返回，命令没有执行，工具卡同样停在 `in_progress`。Orbit 把这张卡结算为没有运行（§5.2）。
- **请求未答时 CLI 被 SIGKILL**【实测 `p5c/accept-edits-disconnect`】：命令没有执行，什么回复都没有；Orbit 撤回审批卡，这一轮按「CLI 在这一轮中退出」失败，
  这张卡结算为没有运行（§5.2）。
- 只发 `session/cancel`、不应答未答的请求时 CLI 自己怎么收尾【待验】：Orbit 总是应答（§4.2），不依赖它。
  源码：权限请求没有超时（S@6078003），取消会让等待的请求以 "Cancelled" 拒绝（A@56902）。

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
- **每会话进程作用域（P5b 跟进，已实现，`src/runner-go/session_scope*.go`）**：
  - **Linux**：CLI 跑在一个 keeper 进程下面。keeper 就是 runner 二进制本身（`/proc/self/exe session-scope`），先把自己设为
    child subreaper（`PR_SET_CHILD_SUBREAPER`），再启动 CLI。孤儿由最近的 subreaper 收养，不交给 init，所以会话起的进程不管换到
    哪个进程组或会话，都一直是 keeper 的后代。
    - CLI 一结束（Stop 后进程被结束、会话结束、崩溃、租约丢失、runner 停止），keeper 就杀掉并回收剩下的全部后代，然后按 CLI 的方式退出
      （同样的退出码，或死于同一个信号），runner 读到的退出状态和以前一样。
    - runner 没了（keeper 的控制 socket 断开）：keeper 替 runner 给 CLI 发 SIGTERM，10 s 后连同剩下的一起杀掉。
    - keeper 是 runner 的子进程，留在 runner 的 cgroup 里：systemd 下 runner 重启（`KillMode=mixed`）照样清掉残留进程，OOM 照样算在
      runner 的单元上（`OOMPolicy=stop`）。不需要 `Delegate=`、systemd scope、root 或额外部署步骤。
    - Stop 被 CLI 回答时进程不结束（Orbit 的中断约定）：Cursor 自己给正在跑的命令的进程组发 SIGTERM【源码 I@7372443、I@7371872】。
      命令从这个进程组再脱离出去的进程，等会话进程结束时由作用域回收。CLI 自己也起脱离的常驻进程（例如 code server，
      detached + unref【源码 `3548.index.js`@292811】），所以 Stop 时不能按“不在 CLI 的进程组里”去清。
      协调会话裁定不改：要在按 Stop 时就回收，得先定一条放过 CLI 自带脱离 helper 的规则，眼下没有需求。
    - 例外：keeper 本身被单独 SIGKILL（不是经 runner 的进程树清理）时，它的后代交给 init。
    - 另一个例外：非 root 的 runner 杀不掉经 sudo 等换了 uid 的进程，和以前一样。
    - 这两个例外是协调会话 2026-10-17 接受的已知限制（P5b 跟进 `34hCNZ8mDv8qDuJKP7JI8` 的裁定第 2 条）。
    - 依据【约定，假 CLI】：`src/runner-go/cursor_process_scope_test.go` 的 `TestCursorProcessScope`（9 个场景：几种 Stop、会话结束、
      CLI 被 SIGKILL、租约丢失、runner 消失）。每个场景旁边都跑着另一个 Cursor 会话、一个 bg_run job 和另一个 engine 的进程树，
      断言会话起的 7 个进程都在 keeper 下面、事后一个不剩、旁边的照常运行。另有 `TestSessionProcessScopeOtherEngines`（其他 engine 不进作用域）。
      `scripts/test-cursor-process-scope.mjs` 跑这些和原有的 `TestSessionProcessTree*`，共 16 个具名场景，最后查 /proc 无残留。
      真 CLI 在 Orbit runner 上的轮中 SIGKILL 复测（`sleep 31`）放到 P8。
  - **macOS 和其他非 Linux 平台**：没有 child subreaper，做不到同等保证，退回进程组清理（`session_scope_other.go`）：CLI 是自己进程组的组长，结束时杀这个进程组，
    再按父子关系杀还找得到的后代。CLI 崩溃后被 launchd 收养、又不在 CLI 进程组里的命令找不到，会留下来。
    - **macOS 为什么不另做一套**（macOS runner 支持任务核对，2026-10-25）：keeper 靠的两样都只有 Linux 有——`PR_SET_CHILD_SUBREAPER` 和 `/proc/self/exe`。
      macOS 上孤儿一律交给 launchd（pid 1），普通进程没有收养孤儿的办法，也没有 cgroup；CLI 每条命令都单开会话（detached），进程组和会话都圈不住它们。
      剩下的办法都是尽力而为：用 kqueue 的 `EVFILT_PROC` 盯 fork（子进程在挂上监听前就可能再 fork、退出），或按环境变量里的标记扫全机进程
      （命令能改自己的环境，还要读别的进程的环境）。两样都比不上 Linux 的保证，又会让 macOS 的清理和 Linux 走两套逻辑，所以 macOS 保持进程组清理。
      macOS 上残留的只有一种情况：命令脱离了 CLI 的进程组，而它的父进程在 runner 清理前已经退出。
      其他 engine 在 macOS 上一直是同样的进程组清理。这一条在 macOS 上没有用真 CLI 测过（`TestCursorProcessScope` 只在 Linux 跑）。
  - 其他 engine 不用作用域，仍是原来的进程组清理（`session_process_tree_unix.go`）。

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
| `tool_call_update` | `toolCallId`，以及 `status`（`in_progress`/`completed`）、`title`、`rawInput`、`rawOutput`、`content`、`locations` 中的若干个 | 先补全 title/rawInput，再 `in_progress`，最后 `completed`。**没有 `failed`**，失败写在 rawOutput 里；被拒的 shell 和编辑连 rawOutput 都没有（§5.2） |
| `plan` | `entries:[{content, priority, status}]` | 只在 plan 模式的 create_plan 流程里出现【实测：`{"content":"Add CONTRIBUTING md","priority":"high","status":"pending"}`】 |
| `subagent_spawned` | `subagentSessionId, name, task, capabilities, _meta.cursor{toolCallId, agentId, model}` | 需要客户端声明 subagents。子代理自己的更新用 `sessionId=<agentId>` 发来 |
| `subagent_state_update` | `subagentSessionId, state, _meta.cursor{…}` | 实测 `completed`；源码还有 `failed`/`cancelled`/`disconnected`（A@62640） |
| `session_info_update` | `title` | 服务端起的标题，如 `"Protocol Probe"`；可能晚于 prompt 回复 |
| `available_commands_update` | `availableCommands:[{name, description}]` | 实测是内置技能和全局命令（`copy-request-id`、`worktree`、`best-of-n`、`autopilot`……），**仓库的 `.cursor/commands/*.md` 和 `.cursor/skills/*` 也会加进来**【实测 `p0c/repo-config-baseline`：`p0cmd`、`p0skill`；源码 A@6047】 |
| `current_mode_update` | `currentModeId` | 只在客户端 `set_mode` 后出现；模型自己切模式不发【源码 P@89140；实测 `p5c/plan-switch-mode-raw`】 |
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
| 切模式（SwitchMode） | `switch_mode` | 先 `Switch Mode: unknown`，后 `Switch Mode: <目标模式>` | 先 `{}`，后 `{targetModeId, explanation}` | 没有 rawOutput，直接 `completed`【实测 `p5c/plan-switch-mode-raw`】 |
| 删除 / grep / 搜索 | `delete` / `search` | — | — | 【源码】 |

- **`toolCallId` 由服务端生成，中间带换行**，如 `"call-<uuid>-3\nfc_<uuid>_0"` 或 `"call-<uuid>-12\nfc_p5V5TAN-6jKPYy-…-aws_ue1_0"`。只能当不透明字符串处理。
- 实测里模型调 MCP 前，常先用 `GetDynamicTools` 查一次工具 schema。这次查询不出现在 ACP 上。

### 4.2 Cursor 扩展消息（都是带 id 的 JSON-RPC **请求**）

| 方法 | 方向与 id | 参数 | 应答 | 依据 |
| --- | --- | --- | --- | --- |
| `cursor/update_todos` | agent→client，带 id（实测 0、2） | `{toolCallId, todos:[{id,content,status}], merge}` | 回任意 result（实测回 `{}`）。CLI 不等这个应答【源码 A@79843】 | 【实测 `subagent-and-todos`】。**文档写的是不需应答的通知，wire 上实际是请求** |
| `cursor/task` | 同上（实测 id 1） | `{toolCallId, description, prompt, subagentType:{custom:{unspecified:{}}}, model:"default", agentId, durationMs}` | 同上 | 【实测】 |
| `cursor/create_plan` | 带 id，**阻塞** | `{toolCallId, name, overview, plan, todos, isProject, phases}` | `{outcome:{outcome:"accepted", planUri?}}` 或 `{outcome:{outcome:"rejected", reason}}`。客户端报错或不给 planUri 时，CLI 自己写计划文件到 `~/.cursor/plans/`【源码 A@50270、P@93387】 | 【实测：plan 模式收到请求，回 accepted 后正常结束】 |
| `cursor/ask_question` | 带 id，**阻塞** | `{toolCallId, title, questions:[{id,prompt,options:[{id,label}],allowMultiple}]}` | `{outcome:{outcome:"answered", answers:[{questionId, selectedOptionIds}]}}`、`skipped` 或 `cancelled`。回 `-32601` 时退回到每个单选题一个 `session/request_permission`，选项是答案加 `__ask_question_skip__`【源码 A@46698】 | **【实测】从没收到**：Free 套餐的 agent 模式（[`analysis/ask-question.json`](evidence/cursor-cli/2026.10.14-941492e/analysis/ask-question.json)）、付费套餐的 agent 模式和 plan 模式（`p0c/ask-question`、`p0c/ask-question-plan-mode`），服务端都没给模型 AskQuestion 工具，模型说没有这个工具。plan 模式的提示里明写 "All questions to the user should be asked using the AskQuestion tool"，工具仍然没有。请求形状、不应答和回退只有【源码】 |
| `cursor/generate_image` | 带 id | `{toolCallId, description, filePath, referenceImagePaths}` | 同 update_todos | 【源码 A@79662】 |

- **不应答的后果**：`create_plan`、`ask_question` 和权限请求一样没有超时，不应答这一轮就一直挂着【源码 S@6078003】。
  **P5c：这些请求必须应答，审批卡撤回时回 `cancelled`。**
  P5c 的应答规则【约定，`src/runner-go/cursor_permissions.go`】：
  - 每个请求（权限、`cursor/create_plan`、`cursor/ask_question`）只应答一次。
  - 权限请求的选项不是 `allow-once`、`allow-always`、`reject-once` 三个且各自 kind 对得上时，回 `cancelled`，不按 kind 猜：
    提问的回退把每个答案都作为 `allow_once` 选项给出【源码 A@46698】。
  - 没有轮次在跑时到达的请求，以及轮次结算、停止、断连、租约丢失时还开着的卡，一律回 `cancelled`；之后才到的人工答复送不到 CLI。
  - Don't Ask 下提问回 `skipped`、计划回 `rejected`，不出卡。
  - 依据：回放用例 `TestCursorExtensionRequests`、`TestCursorApprovalInterrupted`、`TestCursorPermissionBridge`；
    实测 `p5c/accept-edits-stop`（§3.3），`p5c/plan`（`cursor/create_plan` 出计划卡，被接受）。
- 子代理里的提问一律被拒（"Interactive questions are not supported in ACP subagent mode"）【源码 A@72944】。
- **模型自己切模式不问客户端**【源码；实测 `p5c/plan-switch-mode-raw`】：
  - 源码：主会话的交互查询里，提问、计划、web fetch、web search 各有处理，其余（含 `switchModeRequestQuery`）交给默认处理【A@13214】，
    默认处理直接回 `switchModeApproved`【P@89140】，客户端收不到任何请求，也没有 `current_mode_update`（§4.1）。客户端能看到的只有一张工具卡：
    kind `switch_mode`，title `Switch Mode: <目标模式>`【A@90395、A@99976】。子代理里的切换一律被拒（"Subagent mode switches require host approval"）。
    会话里 `cursor` 动态工具命名空间确实有 `SwitchMode`（"Switch between modes: Agent and Plan"）【实测：`p0c/repo-config-baseline` 的会话库上下文】。
  - 实测（不经 Orbit 的权限桥，客户端只看不答）：会话先 `set_mode plan`，再让模型切到 Agent 模式、建一个文件。模型调了 `SwitchMode`：
    工具卡 kind `switch_mode`，title 先是 `Switch Mode: unknown`、再是 `Switch Mode: agent`（rawInput `{targetModeId:"agent", explanation}`），然后 `in_progress`、`completed`。
    客户端没收到任何 `session/request_permission`，也没有 `current_mode_update`（录制里唯一一条是客户端 `set_mode plan` 的回显）。
    随后的编辑工具卡 `completed`，**文件写出**，这一轮 `end_turn`。所以 plan 模式挡写文件，挡不住会自己切模式的模型。
  - **Orbit 的处理**【约定：P5c 实现，协调会话 2026-10-17 裁定第 3 条】：
    - Plan 下看到主会话的 kind `switch_mode` 工具卡（子代理的不算），就发 `session/cancel` 停止这一轮。这一轮以失败结算，说明是
      "Cursor CLI switched itself out of Plan mode, so Orbit stopped the turn before anything could run outside Plan."（notice `cursor-plan-mode-left`）。
    - 任何模式下看到这张卡，下一轮发 prompt 前都先重新 `session/set_mode`。Plan 仍算做得到（honored=true），说明文案写明。
    - 实现：`src/runner-go/cursor_events.go` 的 `onSwitchMode`，`cursor_acp.go` 会话循环里的 `switched` 分支和每轮前的 `enterMode`。
    - 实测 `p5c/plan-switch-mode`（同样的请求经 runner，两轮）：两轮都在切模式时被停下，什么都没写，每轮前都 `set_mode plan`。
      回放用例 `TestCursorPlanModeSwitch/recorded`。

---

## 5. 权限矩阵（覆盖要求 3）

### 5.1 实测矩阵

| 操作 | 默认白名单 | `--force` | `--auto-review` | plan 模式 | ask 模式 |
| --- | --- | --- | --- | --- | --- |
| 读工作区文件 | 不问 | 不问 | 不问 | 不问 | 不问 |
| 写工作区文件 | **不问，直接写** | 不问 | 不问 | 工具运行但**文件没写出** | **不问，直接写** |
| 写工作区外的文件（不在 `/tmp/`、`/var/tmp/` 下） | **问**：`Write <路径>`，content 带 diff（P5c） | — | — | — | — |
| 写 `/tmp/`、`/var/tmp/` 下的文件 | 不问（源码，见 §5.3） | — | — | — | — |
| `ls` | 不问（默认白名单 `Shell(ls)`） | 不问 | — | — | — |
| 其他 shell（`echo`、`touch`、`env|sort`） | **问**，内容 `Not in allowlist: <命令列表>` | 不问 | 问 | 问，允许后执行 | 问，允许后执行 |
| MCP 工具 | 问 | 不问 | 问 | 问，允许后执行 | 问，允许后执行 |
| web fetch | 问（toolCallId `web_fetch_<n>`） | 不问 | 问 | — | — |

证据：`multi-turn-tools-default`；`permission-force`、`permission-auto-review` 的协议加
[`analysis/permission-force.json`](evidence/cursor-cli/2026.10.14-941492e/analysis/permission-force.json)、
[`analysis/permission-auto-review.json`](evidence/cursor-cli/2026.10.14-941492e/analysis/permission-auto-review.json)；
plan/ask 两列见 [`analysis/plan-and-ask-modes-concurrent.json`](evidence/cursor-cli/2026.10.14-941492e/analysis/plan-and-ask-modes-concurrent.json)。
这几个场景运行时的断言写错了，事后分析给出更正后的断言，见 §17.2。
工作区外的两行是 P5c 补的：`p5c/accept-edits-allow-deny`（Accept Edits，即默认白名单）里两次写工作区外的目录，各发一个 `Write <路径>` 请求，
允许的写出、拒绝的没写；其他列没有测。

- **`--force` 的记录**：会话库的 meta 记 `isRunEverything: true`；`--auto-review` 和默认模式都是 `mode:"default"`、`isRunEverything:false`。
- **`--auto-review` 在 ACP 上无效**：表现和默认白名单一模一样【实测】。源码里 ACP 不读这个选项【A 中零引用】。
- **plan 和 ask 都不是只读模式**：
  - ask 模式里模型写文件**连权限请求都没有**。
  - 两种模式下，shell 和 MCP 都只靠权限请求把关，Orbit 一允许就执行。
  - plan 模式挡住了写文件（模型说写被拦了，文件确实不存在），这是服务端行为。P0a 观察到一次，P5c 经 Orbit 的 runner 又观察到一次（`p5c/plan`）。
  - 但模型能用 `SwitchMode` 自己切出 plan，之后写文件成功【实测 `p5c/plan-switch-mode-raw`，§4.2】。

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
  - 写工作区外文件的权限请求【实测 `p5c/accept-edits-allow-deny`】：title `Write <绝对路径>`，kind `edit`，content `[{type:"diff", path, oldText, newText}]`
    （新建文件时 oldText 是 `null`，不是工具卡上的 `"-- /dev/null"`）；`toolCallId` 等于先以 `Edit File` 出现的那张编辑工具卡的 id。
  - MCP 的权限请求 title 是 `<server>-<tool>: <tool>`（如 `p0probe-record: record`），工具卡上是 `<server>: <tool>`。
  - **web fetch 的权限请求 id 是 `web_fetch_<n>`，和工具卡 id 不同**【实测；源码 A@19375】，只能按时间和 URL 关联。
    P5c 的做法【约定，`src/runner-go/cursor_events.go` 的 `permissionAsk`】：对到这一轮里同一 URL、还没有请求认领的 fetch 卡；
    对不上时用这一轮专属的 id，免得别的轮次或进程的卡答了它。
  - MCP 请求的 content 是参数 JSON 的 markdown 代码块。
- **拒绝**【实测】：选 `reject-once` 后调用不执行，工具卡仍以 `completed` 结束，形状因工具而异：
  - MCP：rawOutput `{rejected:true}`，没有副作用，MCP 副作用日志里没有这一条（`multi-turn-tools-default`）。
  - shell 和编辑：只有 `{status:"completed"}`，没有 rawOutput，也没有 content，单看这条更新和一次成功而没有输出的调用分不出来。
    夹具：P8 经 Orbit 的 runner 录的 [`src/runner-go/testdata/cursor/p8/key-allow-reject`](../src/runner-go/testdata/cursor/p8/README.md)（被拒的 `date -u > notes-when.txt`），
    以及 `p5c/accept-edits-allow-deny`（被拒的 `touch cmd-denied.txt` 和工作区外的 `Write`）。
  - **Orbit 以自己回过的应答为准**【约定：D-P8-1、D-P8-1 收尾和撤回的审批卡（`34iTwiTCaIxwfXdQlHvIR`），协调会话 2026-10-19 裁定；`src/runner-go/cursor_permissions.go` 的 `mark`、`close`，`cursor_events.go` 的 `refuse`、`withdraw`、`cursorToolResult`、`settle`】：
    - 一轮进行中，runner 对权限请求回了 allow 以外的应答，就先给请求所指的工具卡做标记，再发应答。这包括人在卡上拒绝，Plan、Don't Ask 不问直接拒绝，
      Orbit 看不懂请求，以及没人能决定或选项不认识时回的 `cancelled`。
    - 被标记的卡结算为 `isError:true`、"Not run: the tool call was rejected."，不看 rawOutput。
    - Cursor 的 `completed` 还没到、这一轮就结束了（Stop、断连、进程退出或 EOF），也这样结算：CLI 拿到应答之前一直阻塞（下面「没有超时」），拒绝和 `cancelled` 都不执行。
    - **撤回的审批卡按没有运行结算**【实测 `p5c/accept-edits-stop`、`p5c/accept-edits-disconnect`：审批卡还没人应答时 Stop，或 CLI 被 SIGKILL，命令都没有执行（§3.3）】：
      - 审批卡还没人应答、这一轮就结束了（Stop、断连、进程退出或 EOF），桥撤回它时就给请求所指的工具卡做「撤回」标记（和上面拒绝的标记分开），赶在这一轮结算之前；
        请求随后回 `cancelled`，CLI 当作拒绝。
      - 这一轮正在结束时才到的权限请求（例如 Stop 已经发出、这一轮还没结算），不出卡，直接回 `cancelled`，同样做撤回标记（`answerClosed`）。
      - 带撤回标记的卡按这一轮的终态结算，`isError:true`：Stop（interrupted）为 "Not run: the turn was stopped before this tool call was approved."；
        其他终态（断连、进程退出、EOF、出错）为 "Not run: the turn ended before this tool call was approved."。结算之前 Cursor 补发了这张卡的 `completed`，也不当结果。
    - 不做标记的：被允许的调用，以及提问卡和计划卡（撤回时同样回 `cancelled`，§4.2）。它们没完成时仍按 §3.3 由 Orbit 结算，说明可能已经运行。
    - 例外只剩一种：这一轮没在发出它的进程里结算、之后按轮次账本补结算时（租约归了别的 runner，或 runner 中途重启；`cursor_acp.go` 的 `recoverTurn`），
      拒绝和撤回的标记都不进账本，没完成的卡仍说明可能已经运行。这两种情况协调会话都裁定不改（D-P8-1 收尾）。
    - 回放用例：`src/runner-go/cursor_permissions_test.go` 的 `TestCursorRefusedToolCards`、`TestCursorWithdrawnApprovals`；
      验收脚本 `scripts/test-cursor-rejected-tools.mjs`、`scripts/test-cursor-refusal-settle.mjs`、`scripts/test-cursor-withdrawn-approval.mjs`。
- **allow-always**：
  - 写进 `<CURSOR_CONFIG_DIR>/cli-config.json` 的 `permissions.allow`。实测 `echo` 被允许后，内容变成 `["Shell(ls)","Shell(echo)"]`。
  - 同一会话下一轮 `echo again > again.txt` 不再问【实测】。
  - 规则按账号配置目录共享，不分会话。
  - 源码里 MCP 存成 `Mcp(<server>:<tool>)`，fetch 存成 `WebFetch(<domain>)`，写和读存成 `Write(<path>)`/`Read(<path>)`【A@58378–58694、A@19940】。
  - **shell 按程序整个放行**【源码 A@58256 `persistAllowlistEntry`】：存的是请求里不在白名单的程序（`notAllowedCommands`，即 `Not in allowlist:` 后面列的名字），
    写成 `Shell(<程序>)`。所以对 `git status` 选 allow-always 之后，`git push` 也不再问。删除文件也存成 `Write(<path>)`。
  - **Orbit 从不选它**【约定：P5c，协调会话 2026-10-17 裁定第 1 条】：
    - 卡上的「总是允许」一律回 `allow-once`。「总是允许」由服务端的工作区规则承担（`src/apiserver/src/common/permission-rules.ts` 的 `SERVER_MATCHED_RUNTIMES` 含 cursor）。
    - 会话 cli-config 里决定「什么能不问就跑」的键每次启动都重置：`permissions` 回到 `{"allow":["Shell(ls)"],"deny":[]}`，`approvalMode: "allowlist"`，
      `autoAcceptWebSearch: false`（`src/runner-go/cursor_launch.go` 的 `writeCursorSessionConfig`）。
    - 实测 `p5c/allow-always`：卡上选「总是允许」，runner 回 `allow-once`；第二条 `echo` 仍发请求；会话 cli-config 的白名单仍是 `["Shell(ls)"]`；
      checkout 和 runner 用户的 HOME 里都没有 `.cursor`。
- **`cancelled` 应答**：当作拒绝（"Cancelled"）。**JSON-RPC 错误应答**：当作 "Request failed" 拒绝【源码 A@56902、A@57212】。
- **没有超时**：不应答这一轮就一直等着【源码 S@6078003；文档 acp："If the client does not answer, tool execution can block"】。

### 5.3 规则语法与优先级【源码 + 文档】

- 写法：`Shell(<cmd>)` 或 `Shell(<cmd>:<args glob>)`、`Read(<path glob>)`、`Write(<path glob>)`、`Mcp(<server>:<tool>)`、`WebFetch(<host>|*.<domain>|*)`、
  `WebSearch(<词>)`【I@4599617、I@4637731、I@3588695；文档 permissions】。
- deny 在 allow 和 Run Everything 之前生效，是硬拒绝，不弹请求【I@4630779、I@4633585】。这一点【待验】，Orbit 可以用它做强制。
- **仓库 `.cursor/cli.json` 的 allow 在运行期生效**【实测 `p0c/repo-config-baseline`：仓库写了 `Shell(touch)`，`touch` 不再发权限请求】，
  `--disable-project-configs` 让它失效【实测 `p0c/repo-config-with-flags`】。
- **`.claude/settings.json` 的 `permissions` 不进 ACP**【实测：只在仓库 `.claude/settings.json` 里放行的 `mkdir` 照样发权限请求；
  源码：读 Claude 权限的代码在 R（只有对话模式加载）R@32044】。
- 写入工作区外、写受保护的配置文件（`**/.cursor/**/cli.json`、`.git/hooks/**`、`.vscode/**` 等）会问；`.cursorignore` 永远拒写【I@4607423、I@4607747、I@4605514】。
  - 工作区外的写会问，P5c 已实测（`p5c/accept-edits-allow-deny`，形状见 §5.2）。
  - **临时目录例外**【源码 I@4599905 `bm`、I@4606992；P5c 交付说明】：路径在 `/tmp/`、`/var/tmp/`（以及 `/var/folders/`、`/private/tmp/`、`/private/var/folders/`）下，
    又不在 CLI 的 HOME 里时，算临时文件，写入不问。所以 P5c 的实测把「工作区外」的目录放在临时目录以外（`cursor_permissions_real_test.go` 的 `realOutside`）。
- `approvalMode` 可取 `allowlist|unrestricted|auto-review`（cli-config）。ACP 只区分 `unrestricted`（跳过写和 MCP 的请求）和其余（都按白名单）【Q@15998】。
  `unrestricted`【待验】。
- **团队管理员禁用 Run Everything**：`--force` 时，如果团队设置 `autoRunControls.enabled && !enableRunEverything`，ACP 只写一行日志，退回白名单模式继续，
  客户端收不到任何提示【源码 A@22362、Q@4101】。拿团队设置失败时照样放行【Q@4251】。没有团队账号，【待验】。
  **P5c：开了 `--force` 仍可能收到权限请求，Orbit 要照常应答，不能当作不会发生。**
  P5c 的做法【约定，协调会话 2026-10-17 裁定第 4 条】：Bypass 下来了请求就照常出卡问人，每个进程提示一次为什么问（notice `cursor-run-everything-off`，
  `cursor_permissions.go` 的 `noteBypass`）。只用回放验证（`TestCursorPermissionModes/bypass/team-veto-*`），真团队账号下的表现仍【待验】。

### 5.4 对 Orbit 权限模式的含义（本节给事实，P5c 的映射见 §16.5）

| Orbit 模式 | 能否强制 | 依据 |
| --- | --- | --- |
| `bypassPermissions` | 能：`--force`（团队否决时退回白名单，见上） | 【实测；`p5c/bypass`：没有任何权限请求】 |
| `auto` | 能：默认白名单 + Orbit 自己的请求级分类（P5c 不用 `--force`）：例行命令由 runner 直接允许，其余出卡 | 【实测 `p5c/auto`：`touch` 由 Orbit 的规则直接允许；`git push` 出卡，被拒】 |
| `acceptEdits` | 能：默认白名单。工作区写不问，shell/MCP/fetch 和工作区外的写由 Orbit 审批卡应答 | 【实测；`p5c/accept-edits-allow-deny`】 |
| `dontAsk` | 部分：默认白名单 + Orbit 对每个请求自动 `reject-once`。工作区写仍会发生 | 【实测；`p5c/dont-ask`：不出卡，命令被拒，工作区内写文件照样发生，Orbit 自己的工具照常】 |
| `default`（编辑前要问） | **不能**：工作区写永远不问，ACP 没有把它变成请求的开关（`promptWorkspaceWrites` 不经配置传入【源码 I@4607944】） | 【实测 + 源码】 |
| `plan` | 只能组合：`set_mode plan` 挡写文件（服务端）+ Orbit 对每个请求自动拒绝。**注意**：模型能用 `SwitchMode` 自己切回 agent 模式，CLI 不问客户端就批准，之后写文件成功（§4.2）。P5c 的做法：看到 kind `switch_mode` 的工具卡就终止这一轮，下一轮先重设 plan | 【实测：P0a、`p5c/plan`；切模式 `p5c/plan-switch-mode-raw`、`p5c/plan-switch-mode`】 |
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
- **一次工具调用最多 60 s**【源码，没有实测】：CLI 调 MCP 工具时不带自己的请求选项（I@4886999 `sendToolCall`；
  `setToolCallRequestOptions` 只有定义 I@4882330，没有调用方），于是用 MCP SDK 的默认 `timeout ?? 6e4`（I@4824634）。超过 60 s 的调用以超时结束。
- 团队后台配置的 MCP 在 ACP 下不支持【文档 acp】。
- **对 Orbit 的含义（P5c）**：
  - 用户自己的 `~/.cursor/mcp.json` 会进入 Orbit 会话，除非 CLI 的 HOME 不是真 HOME（§8.4）。
  - 仓库 MCP 默认不进来，除非有人对同一个数据目录执行过 `agent mcp enable`。
- **P5c 的做法**【约定，`src/runner-go/cursor_mcp.go`、`cursor_acp.go`】：
  - `session/new` 和每次 `session/load` 都先注入 `orbit`（runner 自己的可执行文件，`mcp` 模式，env 带会话身份，与 DSH 共用 `orbitMCPDeclaredEnv`），
    再注入 agent 配置的 stdio 服务器。远程服务器、不是绝对路径的命令、会让工具名串号的服务器名、改会话变量的 env，都在启动前拒绝（`cursorMCPServers`）。
  - `orbit mcp` 的 env 带 `ORBIT_MCP_CALL_TIMEOUT_SECONDS=60`（`cursorMCPToolCallTimeout`）：要等人的调用在 60 s 之前移交（`mcp.go` 的 `handOffOwnerWait`），
    不会在 CLI 那边先超时。
  - Orbit 自己的工具（`mcp__orbit__*`）每个模式都预先允许，不出卡。实测 `p5c/mcp-orbit`：`task_get` 的权限请求由 runner 直接允许，调用到达控制面，
    模型答出了任务标题；`p5c/dont-ask` 里同样允许。工具卡的结果写成 "Done. Cursor CLI does not pass an MCP tool's result on to Orbit."。
  - 启动前守卫（Bypass 除外，`guardCursorUserConfig`）：会话 HOME 下的 `.cursor/mcp.json`、`.cursor/hooks.json`、`.claude/settings*.json`，
    数据目录 `projects/*/` 下的 `mcp-approvals.json`、`.cursor/{hooks,mcp}.json`、`.claude/settings*.json`，只要存在（悬空链接也算），就以
    `CURSOR_CONFIG_UNSAFE` 拒绝启动。

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

### 7.2 运行期（P0c 实测）

场景 `p0c/repo-config-baseline`（不带参数）和 `p0c/repo-config-with-flags`（`--disable-project-configs --exclude-workspace-context`），各一轮。
夹具仓库（[`lib/fixture.mjs`](../scripts/cursor-p0/lib/fixture.mjs)）的每个配置文件都带暗号，每个能执行东西的位置都调用标记脚本；
槽目录（CLI 的 HOME、CURSOR_CONFIG_DIR、CURSOR_DATA_DIR）里也放了 hooks、MCP 和规则。这一轮让模型跑 `touch`、`mkdir`、改文件、读子目录文件，再报出它看到的暗号。
暗号是否进了上下文，看会话库存下的首轮消息，再对照模型的回答。

| 仓库或槽里的配置 | 运行期效果 | `--disable-project-configs` |
| --- | --- | --- |
| 仓库 `.cursor/cli.json`（`allow: Shell(ls), Shell(touch)`） | **生效**：`touch` 不发权限请求 | 失效：`touch` 发权限请求 |
| 仓库 `.claude/settings.json` 的 `permissions.allow`（`Bash(mkdir:*)`） | 不读：`mkdir` 照样发权限请求（§5.3） | 同左 |
| 仓库 `.cursor/hooks.json`、`.claude/settings.json` 的 hooks（SessionStart、PreToolUse、Stop） | 都没运行 | 同左 |
| `$HOME/.cursor/hooks.json`、`<CURSOR_DATA_DIR>/projects/<slug>/.cursor/hooks.json` | **运行**，不需批准：每个工具 `preToolUse`/`postToolUse`，每条 shell `beforeShellExecution`/`afterShellExecution`，每次读文件 `beforeReadFile`，每段思考 `afterAgentThought`。hook 拿到的是 CLI 自己的环境（HOME 是 CLI 的 HOME） | 不受影响 |
| `$CURSOR_CONFIG_DIR/hooks.json`、`$HOME/.cursor/projects/<slug>/.cursor/hooks.json` | 不读 | 同左 |
| `$HOME/.claude/settings.json` 的 hooks（只放了 SessionStart） | 没运行；ACP 一轮里根本没有 `sessionStart`、`stop`、`beforeSubmitPrompt`、`afterAgentResponse` 事件，所以这一条说明不了 Claude 格式的用户 hooks 读不读 | — |
| 仓库 `.cursor/mcp.json` | 不启动（没批准过） | 同左 |
| `$HOME/.cursor/mcp.json` | 启动 | 同左 |
| `$CURSOR_CONFIG_DIR/mcp.json`、`<data>/projects/<slug>/.cursor/mcp.json`、`$HOME/.cursor/projects/<slug>/.cursor/mcp.json` | 不读 | 同左 |
| 仓库 `.cursor/worktrees.json`、`.cursor/environment.json`、`.envrc` | 都没运行（`.envrc` 只触发 `direnv export json`，见 §7.1） | 同左 |
| 仓库 `AGENTS.md`、`CLAUDE.md`、`CLAUDE.local.md`、`.cursorrules`、`.cursor/rules/*.mdc`（`alwaysApply: true`） | **进首轮上下文**：`<rules><always_applied_workspace_rules>`，每条带文件绝对路径 | 不受影响 |
| `.cursor/rules/*.mdc`（只有 description） | 首轮上下文里只列路径和 description（`<agent_requestable_workspace_rules>`），模型需要时自己读（实测读了一次） | 不受影响 |
| `.cursor/rules/*.mdc`（只有 `globs: "*.py"`） | 不在首轮上下文，这一轮也没出现（模型用 shell 改了 `app.py`，没走编辑工具） | 同左 |
| 子目录 `sub/AGENTS.md` | 不在首轮上下文；模型读了 `sub/note.txt` 之后，回答里出现了它的暗号（两次都是） | 不受影响 |
| 仓库 `.cursor/skills/*/SKILL.md` | description 进首轮上下文（`<agent_skills>`），并成为斜杠命令 | 不受影响 |
| 仓库 `.cursor/commands/*.md` | 不进上下文，成为斜杠命令（`available_commands_update`） | 不受影响 |
| `$HOME/.cursor/rules/*.mdc`（`alwaysApply: true`）、`$HOME/AGENTS.md`、`$CURSOR_CONFIG_DIR/rules/*.mdc` | **都不进上下文**，模型也没报出它们的暗号 | — |

- 首轮上下文里的 `<user_rules>` 是服务端给的规则（git 提交、PR 的写法），不是本机文件。
- `--exclude-workspace-context` 没有可见效果：两次运行存下的首轮上下文除了路径逐字相同（§2.1）。
- 源码依据：cli.json 和用户配置深度合并、数组整体替换【I@3726438】，没有信任门槛【I@3723669】（实测只验证了仓库的 allow 会生效，
  仓库能不能借整体替换去掉用户的条目没有单独测）；ACP 读「项目」hooks 的位置是 `<data>/projects/<slug>/.cursor/hooks.json`【A@67933、A@69807】，
  Claude 格式的项目 hooks 按同一个项目目录找 `.claude/settings*.json`【H@74185、H@74307】，和实测吻合。
- 从工作区往上到 `/` 每层的 `AGENTS.md`、`CLAUDE.md`、`.cursor/rules/` 都会读【源码 I@4359231、I@4359359】。夹具的上层目录没有这些文件，所以没有测到；
  Orbit worktree 在 `/root/.orbit/worktrees/<id>` 下，`/root/AGENTS.md` 之类的文件会进上下文，这一点【待验】。

**对 P5c 的含义**：
- 加 `--disable-project-configs`，仓库就不能用 cli.json 放行命令（P5c 让每种模式都加，§16.5）。仓库的 hooks.json、mcp.json、Claude 格式的 hooks 和权限在 ACP 上本来就不生效。
- P5c 经 Orbit 的 runner 实测【`p5c/malicious-repo`，Accept Edits，审批一律拒绝】：夹具仓库（`src/runner-go/testdata/cursor/p5c/fixtures/malicious-repo`）里每个能执行东西的配置都调用标记脚本。
  仓库 cli.json 放行的 `touch` 仍发请求（被拒），仓库规则要求的命令没有执行；hooks.json、mcp.json、`.claude/settings.json`、`.envrc`、environment/worktrees、
  植入的 `node_modules/typescript` 一个都没运行。CLI 下面只出现过它自己、`orbit mcp` 和 `worker-server`。
- 能在 ACP 上执行东西的 hooks 和 MCP 只来自 CLI 的 HOME 和 CURSOR_DATA_DIR。P3 让这两个都是会话自己的目录，仓库碰不到；不要往里放用户的 hooks 或 MCP。
- 仓库的规则、AGENTS/CLAUDE、技能和斜杠命令总会到模型那里，没有开关能挡（它们是指令，不执行东西）。
- Orbit 的 agent 指令**不能**放在会话目录的用户级 rules 里（`$HOME/.cursor/rules`、`$HOME/AGENTS.md` 都不读），只能走首轮 prompt 前缀（P5c 规则 7）。
  P5c 的实现【约定，`cursor_acp.go`】：新会话的第一轮 prompt 前面加 `<orbit-agent-instructions>…</orbit-agent-instructions>`，load 回来的会话不加
  （回放用例 `TestCursorAgentInstructions`）。
  副作用：Cursor 按第一条 prompt 起标题，这样的对话会被叫成 "Orbit Agent Instructions" 之类。runner 不上报这种标题（§3.2、§16.4，D-P8-2）。

---

## 8. 目录、凭据与隔离（覆盖要求 6）

### 8.1 哪个变量管哪个文件【实测 `directory-variables`，HOME 固定为槽目录】

| 文件 / 目录 | 决定它的变量（优先级从高到低） |
| --- | --- |
| `cli-config.json`（含 allow-always 规则、`selectedModel`、`privacyCache`）、`statsig-cache.json`（约 930 KB）、`acp-sessions/` | `CURSOR_CONFIG_DIR` > `$XDG_CONFIG_HOME/cursor` > `~/.cursor` |
| `auth.json`（file 存储） | Linux：`$XDG_CONFIG_HOME/cursor/auth.json` > `~/.config/cursor/auth.json`，**和 CURSOR_CONFIG_DIR 无关**。macOS：恒为 `$HOME/.cursor/auth.json`（§18.3） |
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
| 不设（`default`） | Linux 上同 `file`。**macOS 上是 Keychain**：条目 `cursor-user` / `cursor-access-token`、`cursor-refresh-token`、`cursor-api-key`，per-user 全局、多账号会互相覆盖（§18.4） |
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
  - `$SHELL` 的路径含 `bash` 才用它，否则从 PATH 找 bash。zsh 同理，而且**先比 zsh**：路径里同时有 `zsh` 和 `bash` 时按 zsh 处理【源码 I@7385715、I@7424080】。
  - 每条命令先用这个 shell 跑一次 `-ilc` 拍环境快照，再 `-c` 执行【实测 strace：`bash -O extglob -ilc` 后 `bash -O extglob -c`】。
    P0c 用包装脚本作 `$SHELL` 时，快照和每条命令都经过它【实测 `p0c/shell-wrapper-env`】。
  - 快照是登录 shell，读的是**它看到的 HOME** 下的 profile；命令的 PATH 等变量来自这个快照（实测 PATH 被 `/etc/profile` 改写，profile 里 export 的变量命令也看得到）。
  - `__CURSOR_SANDBOX_ENV_RESTORE` 只是一段 `unset`/`export` CURSOR_CONVERSATION_ID、CURSOR_REQUEST_ID 的 shell 代码，不带别的变量【实测】。

### 8.4 D4：按账号隔离而不改变 agent 命令的环境

**事实**：

1. 账号的**会话和配置**用 CURSOR_CONFIG_DIR 分开，**项目数据**用 CURSOR_DATA_DIR 分开【实测】。两者都会出现在命令环境里，但除了 Cursor 自己没人读它们。
2. **凭据**有两种做法，都不改 HOME/XDG：
   - API key：`CURSOR_API_KEY` + memory 存储【实测】。
   - 登录账号：登录时用账号自己的 `XDG_CONFIG_HOME` 跑 `agent login`（独立进程，没有 agent 命令），会话时读出那份 `auth.json` 的 accessToken，
     以 `CURSOR_AUTH_TOKEN` + memory 存储注入【实测：注入后 `session/new` 成功、不落盘】。
   - 不加包装时，凭据在命令环境里可见。agent 和 runner 是同一个系统用户，本来也能读到磁盘上的凭据，这和其他引擎的 key 注入属于同一类暴露。
     用方案 A 时命令看不到它们（见下）。
3. **但只要 CLI 的 HOME 是真 HOME，Cursor 就会**：
   - 写 runner 用户的 `~/.cursor/`：`agent-cli-state.json`、按账号下发的 `skills-cursor/`、`ai-tracking` 库；
   - 读 `~/.cursor/mcp.json`（并启动其中的服务器）、`hooks.json`、`rules`、`commands`；
   - 账号之间共享这些文件。

   这违反项目判据 4「不写 runner 用户真实的 Cursor 配置」。HOME 是唯一能移走它们的变量【源码：都直接用 `os.homedir()`】。
4. **登录 token 不刷新**：CLI 只会用 API key 重新换 token，没有用 refresh token 刷新的流程【源码 I@1661040】。
   浏览器登录的有效期等于 access token 的有效期，过期要重新登录。登录 token 的实际寿命【待验】：所有者没有完成登录。

**方案 A 成立（Linux，P0c 实测）**：CLI 用账号自己的 HOME，命令经 SHELL 包装拿回真 HOME。

- **做法**（P3 实现，P4b 按 P0c 的两处调整改为每个会话一份，`src/runner-go/cursor_launch.go` 的 `writeCursorShellWrapper`）：
  `<会话目录>/cursor/bin/orbit-bash` 是一个 `#!/bin/sh` 脚本，CLI 的 `SHELL` 指向它。内容依次是：
  `HOME=<真 HOME>; export HOME`；`unset` CLI 的凭据和目录（`CURSOR_API_KEY CURSOR_AUTH_TOKEN CURSOR_CONFIG_DIR CURSOR_DATA_DIR`）以及下面要还原的变量；
  再把要还原的变量逐个写回「其他引擎的会话里命令看到的值」（工作区设了就用工作区的，否则用 runner 自己的，两边都没有就保持未设）；最后 `exec /bin/bash "$@"`。
  P3 原来是所有会话共用 `<orbit home>/cursor/bin/orbit-bash`，内容固定为 `HOME=<真 HOME>; export HOME; unset CURSOR_API_KEY CURSOR_AUTH_TOKEN XDG_CONFIG_HOME CURSOR_CONFIG_DIR CURSOR_DATA_DIR; exec /bin/bash "$@"`。
- **实测**（`p0c/shell-wrapper-env`：同样的包装脚本，放在 `<RUN>/bin/orbit-bash`；CLI 的环境按 P3 的固定层设置，同时带 `CURSOR_API_KEY` 和
  用这把 key 换来的 `CURSOR_AUTH_TOKEN`；一轮跑两条命令）：
  - CLI 用包装脚本跑环境快照和每条命令：strace 依次是 `orbit-bash -O extglob -ilc` → `/bin/bash -O extglob -ilc`、`orbit-bash -O extglob -c` → `/bin/bash -O extglob -c`。
  - 命令看到的 HOME 是包装脚本写的真 HOME，登录快照读的也是真 HOME 的 profile（真 HOME 的 `.bash_profile` 里 export 的变量出现在命令环境里，账号 HOME 的没有）。
  - 命令环境里**没有** `CURSOR_API_KEY`、`CURSOR_AUTH_TOKEN`、`CURSOR_CONFIG_DIR`、`CURSOR_DATA_DIR`（`XDG_CONFIG_HOME` P3 本来就不设）。工作区变量照常可见。
  - CLI 自己仍跑在账号 HOME 上（`agent-cli-state.json` 写在账号 HOME）；这一轮之后真 HOME 里只有原来的 `.bash_profile`，没有 `.cursor`、`.config/cursor`。
- **命令仍看得到的 Cursor 和 Orbit 变量**：Orbit 固定层的 `AGENT_CLI_CREDENTIAL_STORE=memory`、`NO_OPEN_BROWSER=1`、`DIRENV_DISABLE=1`、
  `CURSOR_AGENT_DISABLE_DEBUG_LOG=1`、`SHELL=<orbit-bash>`；CLI 给每条命令补的 `CURSOR_AGENT`、`CURSOR_CONVERSATION_ID`、`CURSOR_REQUEST_ID`、
  `CURSOR_INVOKED_AS`、`CURSOR_RIPGREP_PATH`、`AGENT_TRANSCRIPTS`（指向账号数据目录）、`NODE_COMPILE_CACHE`（指向账号 HOME 的缓存）、
  `GLOBAL_AGENT_ENVIRONMENT_VARIABLE_NAMESPACE`、`__CURSOR_SANDBOX_ENV_RESTORE`、`NO_COLOR`、`FORCE_COLOR`、`_ZO_DOCTOR`。
- **和普通会话的差别，P4b 的处理**（【约定】P4b 实现；用假 CLI 验证，`TestCursorSessionBorrowsItsAccountAndCommandsKeepTheirEnvironment`）：
  - **还原**：所有 `XDG_*`（XDG 基础目录 7 个，加上 runner 或工作区设了的其他 `XDG_*`）、`DIRENV_DISABLE`、`NODE_COMPILE_CACHE`、`AGENT_CLI_CREDENTIAL_STORE`、
    `NO_OPEN_BROWSER`、`CURSOR_AGENT_DISABLE_DEBUG_LOG`。它们在 CLI 的环境里是给 CLI 用的（固定层，或启动脚本把编译缓存指向 CLI 的 HOME），
    命令拿回的是其他引擎的会话里的值。于是 gh、git 按真 HOME 和原来的 `XDG_CONFIG_HOME` 找配置，direnv hook 照常，node 的编译缓存不写进会话目录。
  - **保留**：`SHELL` 仍指向 orbit-bash。命令里再起 `$SHELL` 得到的还是这份还原后的环境；换回用户自己的 SHELL 没有实测过（CLI 用自己进程的 SHELL 选 shell）。
  - **还不一样的**：P3 白名单以外的 runner 变量（例如 `SSH_AUTH_SOCK`、`EDITOR`），命令看不到，除非登录 profile 自己设；工作区设了 `HOME` 时命令仍拿到 runner 用户的真 HOME；
    Cursor 自己给每条命令加的变量（`CURSOR_AGENT`、`TERM=dumb` 等，§8.3）任何 Cursor 会话都有。
    前两条是协调会话 2026-10-17 接受的已知差异（P4b 交付说明第 2 项的裁定），orbit-bash 每会话一份同时获准。
- **路径断言**：CLI 用 `includes("zsh")` 先判 zsh、再用 `includes("bash")` 判 bash，看的是整条路径【源码 I@7424080、I@7385715】。
  包装的路径（含 Orbit 的 home）里有 `zsh` 或没有 `bash` 时，runner 拒绝启动会话（`CURSOR_CONFIG_CONFLICT`），不让 CLI 换一个 bash、在 CLI 自己的 HOME 上带着凭据跑命令。
- **hooks 不经过包装**：CLI 直接 exec hook 命令（strace：`mark.sh <参数>`，不经 `sh -c`，也不经 `$SHELL`），hook 拿到的 HOME、XDG_CONFIG_HOME、
  CURSOR_CONFIG_DIR 都是 CLI 自己的【实测 `p0c/repo-config-baseline`；凭据在不在 hook 的环境里没有记录】。ACP 只从 CLI 的 HOME 和 CURSOR_DATA_DIR
  读 hooks（§7.2），P3 让两者都是会话自己的目录（P4b 的账号会话也一样，只借用账号的登录，§16.2），仓库放不进 hook。
- **依赖与风险**：CLI 只在 `$SHELL` 的路径含 `bash`、不含 `zsh` 时用它（§8.3）。新版 `2026.10.16-e3cb207` 的这段代码不变（§1.3）。
  每次升级都要回归 `shell-wrapper-env`。
- macOS 上的表现：P0b 跟进已实测（`macos/shell-wrapper-env`，§18.7），结论与 Linux 相同。

**其他方案**（A 不成立时的退路，Linux 上不再需要）：

- **B. 真 HOME + CURSOR_CONFIG_DIR/CURSOR_DATA_DIR + memory 存储 + 注入 key 或 token**：命令环境不变，凭据和会话分开。
  代价是第 3 条的副作用（写和读真 `~/.cursor`）。
- **C. Linux mount namespace**：给 CLI 进程单独挂载账号目录到 `~/.cursor` 和 `~/.config/cursor`。只有 root runner 能用，【待验】。
- **D. 该平台只支持 Default 账号**（作业指导的退路）。

**建议**：Linux 用 A（P4b）。A 在 macOS 上不成立时，再请所有者为 macOS 在 B 和 D 之间选。

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
    P4b 2026-10-17 又测两次：链接分别在启动后 5.9 s、2.8 s 打印（机器负载高），之后 **1,543 s 和 1,562 s（约 26 分钟）**放弃。
  - **为什么会变**【源码 I@3715823 `waitForResult`】：CLI 最多轮询 150 次，每次之间停 `min(1 s × 1.2^n, 10 s)`，光停顿就是 1,418 s（23.6 分钟），
    再加 150 次请求各自的往返时间，所以链接能用多久取决于网络。连续 3 次轮询失败（非 404 或网络错误）也会提前放弃，打印的是同一句 `Login failed or timed out`。
  - **P4b 的做法**【约定】：上报的 `expiresAt` 是链接打印时刻加 23 分钟（`cursorLoginLinkLifetime`，不超过源码下限，界面的倒计时不会多报）；
    打印这句时距链接已超过 23 分钟的，上报为 `reason: expired`（"The sign-in link expired before anyone signed in with it."），更早的算轮询失败，另给说明；
    中继自己最多等 29 分钟（`cursorLoginRelayTimeout`，长于实测的 1,636 s、短于控制面 30 分钟的清扫），到点结束 CLI 的进程树，也报 `expired`。
    - 依据：协调会话 2026-10-17 对 P4b 交付说明第 1 项的裁定，同意按 23 分钟算（P4b 当天两次实测在 1,543 s、1,562 s 放弃，宁可少报剩余时间）。
    - 实现：`src/runner-go/cursor_account_slot.go` 的 `cursorLoginLinkLifetime`（上报 `expiresAt`）、`cursorLoginGaveUp`（CLI 那句话）、
      `cursorLoginRelayTimeout` 和 `cursorLoginExpiredMessage`。
    - **过期原因的判定**（`cursorLoginOutcome`）：CLI 打印 `Login failed or timed out` 时，距链接打印已满 23 分钟的报 `reason: expired`；
      不满 23 分钟的算连续 3 次轮询失败，报普通的登录失败（不带 reason），说明 CLI 没能向 Cursor 确认有没有人登录；中继到 29 分钟结束 CLI 时也报 `expired`。
- **在另一台设备上完成登录**【待验】：2026-10-16 已把链接发给所有者（任务评论 + 通知），27 分钟内没有完成；P4b 2026-10-17 03:25 UTC、03:51 UTC 又各发一次，都没有人用。
  协调会话裁定放到 P8 一起补验：P8 冒烟要所有者登录 Default 和第二个账号，HPC 没有界面，只能在另一台设备的浏览器里完成。
  源码表明成功后存 `accessToken`/`refreshToken`（不存 apiKey），打印 `Logged in as <email>`，再调 `GetMe` 写入 `authInfo`【3541@493、3541@3010】。
  **P4b 的登录中继**：把链接原样交给用户，最长等 29 分钟，成功与否看 `agent login` 的退出码；退出码 0 之后读回账号目录里存下的登录（有 accessToken、没过期）核对，
  和会话借用时读的是同一份。`status --format json` 读的也只是这份已存的 token（§8.2），所以不再另起一个 CLI 去问。
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
- **会话里怎么写 context 和 fast**【约定，Context/Speed 跟进（`34iDjteT5qGcwXKjAUKj1`）实现】：
  - 会话没有放 context 的字段；`fastMode` 是引擎级的快速模式开关，Cursor CLI 不声明它（P1）。所以这两个参数都写进会话的 model 值，用 Cursor 自己的变体写法：
    `<模型>[<id>=<值>,…]`，例如 `claude-opus-5-5[context=1m,fast=true]`。
    - id 和值都用目录里该模型 `parameters` 的原值，例如 `context`：`300k`/`1m`；`fast`：`false`/`true`。
    - effort 照旧放在会话的 `effort` 字段。Auto 不带参数，就是 `default`。
  - 编码和解码用 `src/shared/src/cursorModels.ts` 的 `encodeCursorModel` / `decodeCursorModel`。runner 在 `cursor_models.go` 里有同样读法的 `decodeCursorModel`。
    - 参数按 id 排序写出（`context` 在 `fast` 前，和 Cursor 自己的变体串同序）。
    - 等于模型默认值的参数不写，所以全是默认值的模型就是不带括号的模型名。`encodeCursorModel` 传入该模型的目录行时按它的 `default` 去掉。
    - 方括号里至少要有一个参数才算变体。其余的值都当作原样的模型名，不读里面的参数，原样交给 Cursor CLI，和有变体之前一样。例如空方括号（`default[]`、`no-such-model[]`）、Claude Code 的 `claude-opus-5[1m]`、空模型名、写坏或重复的参数。
  - **runner**（`configure`）的顺序：
    1. 用不带参数的模型名调 `session/set_config_option` 设 model。
    2. 对模型有的 `context`、`fast` 各定一个值：值里写了就用它，没写就用 runner 模型目录里该模型的 `default`；和当前值不同才调。
       没写的也要设回默认值：模型选择是进程级的，还会写进 `cli-config.json`（§3.1），进程可能停在之前选的参数上。目录还没有（首次读取前、Default 账号未登录）时，没写的参数保持进程当前的值。
    3. 设 effort。
    - 模型没有这个参数，或不提供这个值，就留模型自己的值并记日志，做法同 effort。
    - 其他 id（`effort`、`mode` 等）不从 model 值里设，只记日志。
    - Auto 不设任何参数。
    - 回放测试：`cursor_model_variants_test.go`，用 `parameterized-model-picker` 的录制。
  - **服务端**：变体按它的模型判断是否下架，目录里有这个模型就不算下架；effort 档位也读这个模型那一行。
    对应 `retiredPin`、`runtimeCatalogReasoningLevels` 和 shared 的 `runnerCatalogRow`。目录里原样列着的值仍按原样认。
  - **客户端**：
    - 目录里带 `context`、`fast` 参数的模型，模型菜单在 Effort 下面加 Context、Speed 两行，取值来自目录。Context 的名字用目录给的（300K、1M）；Speed 和其他 engine 的 Speed 行一样写 Standard / Fast，Fast 是目录给的名字。
    - chip 写「模型 Effort · Context · Speed」：context 只在不是模型默认值时写，`fast=true` 时写目录给的名字「Fast」，例如「Claude Opus 5.5 High · 1M · Fast」。
    - 换模型时参数不跟过去，新模型从它自己的默认值开始。
    - Web 已经实现；iOS（P7b）、Android（P7c）按同样的约定做。
- **`cursor/list_available_models`**【实测】：返回 46 个 `{value, name, configOptions}`，每个模型带自己的参数定义，可以不建会话就拿到目录。
- **`agent models` / `--list-models`**【实测】：输出另一套命名（如 `claude-opus-5-5-high-fast`），和 ACP 的值不同，**P3 的模型目录应以 ACP 为准**。
- **Auto 实际用了哪个模型**：ACP 上看不到。会话库里 assistant 消息的 `providerOptions.cursor.modelName` 记着，实测一次是 `cursor-grok-4.5-high`。
- 不同账号或 key 的模型目录是否不同【待验】：只有一个账号。同一个账号从 Free 升到付费套餐后，目录仍是同样的 46 个模型【实测 `p0c/api-key-session-management`】。源码里目录来自服务端 `GetUsableModels`、`AvailableModels`，按账号或团队下发【6436@5778、6436@5997】。
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
| `GetPlanInfo` | 200 | Free：`planInfo{planName:"Free", price, billingCycleEnd}`、`nextUpgrade{tier, name, includedAmountCents, price, …}`。付费（P0c）：`planInfo{planName:"Premium", price:"", billingCycleEnd, includedUsagePeriod:"INCLUDED_USAGE_PERIOD_WEEKLY", includedUsageResetsAt}`、`nextUpgrade{tier:"super", …}`、`isMerged:true` |
| `GetHardLimit` | 200 | Free：`noUsageBasedAllowed: true`；付费：`hardLimit: 2147483647` |
| `GetUsageLimitPolicyStatus` / `GetUsageLimitStatusAndActiveGrants` | 200 | `canConfigureSpendLimit`、`canAdjustOnDemand`、`recommendedOnDemandLimitCents`… |
| `GetUserPrivacyMode` | 200 | `privacyMode: PRIVACY_MODE_USAGE_DATA_TRAINING_ALLOWED`（即 3） |
| `GetMe` | 200 | 身份字段（证据里只留字段名） |
| 原始 API key 当 bearer | **401** | `{"code":"unauthenticated", details:[{type:"aiserver.v1.ErrorDetails", debug:{error:"ERROR_NOT_LOGGED_IN", details:{title:"Authentication error", …, analyticsMetadata:{actionRequired:"login"}}}}]}` |

- 交互式 CLI 的 `/usage` 命令也是调 `GetCurrentPeriodUsage` + `GetHardLimit` + `GetPlanInfo`【源码 C@876991】。ACP 不调这些接口。
- **付费套餐下的读数**【实测 `p0c/usage-api` 和 [`p0c/analysis/usage-before-prompts.json`](evidence/cursor-cli/2026.10.14-941492e/p0c/analysis/usage-before-prompts.json)】：
  - 包含用量按周算：`GetCurrentPeriodUsage` 的 `billingCycleStart/End` 是这一周（2026-10-17 01:32 到 10-24 01:32 UTC），等于 `GetPlanInfo` 的
    `includedUsageResetsAt`；`planInfo.billingCycleEnd` 是月度账期（11-17）。`spendLimitUsage` 只剩 `{limitType:"user"}`。
  - 发 7 次 Auto prompt 前后，`autoPercentUsed`、`apiPercentUsed`、`totalPercentUsed` 都是 0，`displayMessage` 都是 "You've used 0% of your included usage"。
    这些是整数百分比；Auto 用量是不计入，还是太小被舍成 0，分不出来（只允许用 Auto，没测其他模型）。
  - 所以**付费套餐上读到 0% 也不能当作没用过**。
- **读不到的**：
  - **Free 套餐的请求上限**：第 20 次 prompt 碰到 "You've hit your free requests limit"（§12）时，`GetCurrentPeriodUsage` 仍是 `totalPercentUsed: 0`、
    `displayMessage: "You've used 0% of your included usage"`【实测】。这个上限的用量和剩余在这些接口里都没有。
  - 团队用量（`GetTeamSpend` 等）没有团队账号，【待验】。
- **P0a 给 P6a 的建议**：
  - 每个账号用自己的 token 读 `GetCurrentPeriodUsage` 和 `GetPlanInfo`。显示服务端给的百分比和周期（付费套餐按周，用 `includedUsageResetsAt`）；
    Free 套餐的请求上限显示为不可用，不显示成 0。百分比是 0 时不要据此判断「没用过」或排序选账号。
  - 额度拦截以实际碰到的「额度用尽」轮次（§12）为准，按服务端给的重置日期（chatMessage 里有，只在 CLI 调试日志中可见）或账期结束时间解除。
  - 用 API key 的会话也能这样读（同一个换 token 流程）。P6a 没有做这一条，见下。
- **P6a 的实现**【约定：P6a `34h05fvbe5p9bsToxiAG1` 及协调会话 2026-10-17 的裁定；runner `src/runner-go/cursor_usage.go`，shared `src/shared/src/planUsage.ts`，
  apiserver `src/apiserver/src/runner-api/runner-api.controller.ts`；验收 `scripts/test-cursor-quota.mjs`，交付时 55 个具名场景】：
  - **读法**：runner 按账号读（Default 和每个加进来的账号槽），用这个账号自己存下的登录（Linux 是 `xdg-config/cursor/auth.json`、macOS 是 `home/.cursor/auth.json` 的 accessToken，`cursorStoredLoginPath`，也就是会话借用的 token），
    调 `GetCurrentPeriodUsage` 和 `GetPlanInfo`，请求头同上，body `{}`。从不刷新 token；剩余不足 5 分钟的不发；Cursor 回过 401 的不再发（只记它的哈希）；
    两个调用有一个失败，就保留上一次的完整读数。
  - **快照**：放在心跳的 `planUsage.cursor`，Default 的是它本身，其他账号按槽 id 放在 `accounts` 下。字段是 `planName` 和
    `includedUsage{period, startsAt, resetsAt, percentUsed, limitReachedAt}`（`src/shared/src/dto.ts` 的 `PlanUsageIncludedUsage`）。
    - `resetsAt`：Cursor 给了 `includedUsageResetsAt`（付费套餐的周）就用它，否则用 `GetCurrentPeriodUsage` 的 `billingCycleEnd`，从不用 `planInfo.billingCycleEnd`（`parseCursorPlanUsage`）。
    - `percentUsed` 只在 `totalPercentUsed` 大于 0 时才有：**0% 不算读数**，界面显示为读不到，也不拿它排序选账号。Cursor 没给的字段一律不写，不写成 0。
  - **额度用尽的标记**：一轮以 P5b 的额度用尽句子结束时，runner 给这个会话花的账号记下时间：点名的账号，或 Default；用 key 的会话不记
    （`cursorSessionAccount`、`noteCursorTurn`）。标记存在 `<orbit home>/cursor/usage-limits.json`，重启不丢。
    这个账号之后有一轮正常结束、或者进入下一个周期（标记早于 `startsAt`），标记就作废。
  - **怎么算**（shared `cursorWindows`）：碰过额度的账号到 `resetsAt` 之前都算用尽。读数从不让账号算用尽（100% 也不算：付费套餐超出后还能按量付费），
    只用来排序：快满的放后面，先到期的先用，余量多的优先。账号的快照要有 `resetsAt` 才算有额度数据（`planUsageReported`）。
  - **Automatic / NEXT** 跳过用尽的账号；**任务额度闸门**挡到 `resetsAt`，不知道重置时间时按没有额度数据的办法刹车。
  - **额度重试**：turn-complete 碰到 Cursor 额度用尽时，按这个账号的 `resetsAt` 排重试（shared `usageLimitResetsAt`，apiserver 的 `quotaRetryAt`）；
    扫描在账号仍用尽时压住重试，重置后再发。读不到重置时间就不排，卡片上只留手动 Retry。
  - **限流和额度用尽共用一句话**（§12）：限流同样会把账号挡到重置时间，或者等它有一轮正常结束；手动 Retry 一直在。协调会话接受（裁定第 5 条），P8 冒烟碰到限流时记下实际表现。
  - **哪个账号花了额度**：点名了 Default 以外账号的会话，算在那个账号上，工作区带了 `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` 也一样（和 §16.3 的凭据顺序一致）；
    没点名（或点名 Default）、靠工作区 key 或 token 跑的会话不花任何账号（shared `accountOfEnv`）。
  - **不读 Orbit 里保存的 Cursor API key 的额度**：首版不做，key 不参与 Automatic / NEXT 选账号（裁定第 4 条）。
  - **实测读数**（0 次 prompt）：固定版本 CLI 用所有者的 key 换出 token 后，runner 读到 `Premium / weekly / 2026-10-17T01:32:16.338Z → 2026-10-24T01:32:16.338Z`，
    没有 `percentUsed`（Cursor 报的是 0%）。月度付费套餐（"Pro"）的样本是合成的，没有录制（`src/shared/src/cursor-plan-usage.fixture.json` 的 `about` 写明）。

---

## 12. 错误形状（覆盖要求 10）

| 情形 | ACP 上看到的 | 来源 | Orbit 分类 |
| --- | --- | --- | --- |
| 没有凭据 | `session/new` / `session/list` → `-32000 "Authentication required"` | 【实测】 | 需要登录 |
| key 无效 | `session/new` → `-32603`，`data.message:"Failed to initialize session services"`；`session/list` 照常 | 【实测】 | 凭据无效（用 `agent models` 确认） |
| 启动时断网 | 同上，同一个 `-32603` | 【实测 `unshare -n`】 | 网络（用 `agent models` 确认：`Failed to reach the Cursor API`） |
| **额度用尽** | 一条 `agent_message_chunk` `"\n\nUpgrade your plan to continue"`，然后 `stopReason:"end_turn"`（0.58 s）；没有 JSON-RPC 错误 | **【实测】**（[事故记录](evidence/cursor-cli/2026.10.14-941492e/incidents/quota-exhausted/README.md)）：服务端 Connect `ResourceExhausted`，ErrorDetails `You've hit your usage limit`，`limitType:included_usage` | 额度用尽：可换账号或等重置 |
| 限流 | 预计同样是 `Upgrade your plan to continue`（动作 upgrade）或 `Error: <服务端标题>` | 【源码 I@7334425：FREE/PRO_USER_RATE_LIMIT_EXCEEDED、GENERIC_RATE_LIMIT_EXCEEDED、API_KEY_RATE_LIMIT…；I@3527512】，【待验】 | 限流。分不出来：P5b 把这句一律按额度用尽结算（`You've hit your usage limit on Cursor. …`），P6a 据此把账号挡到重置时间（§11） |
| 模型提供方拒答 | `agent_message_chunk` `"\n\nRequest blocked We are unable to complete this request because it was blocked under the model provider's usage guidelines. Try a less sensitive prompt."` + `end_turn` | **【实测】**（[事故记录](evidence/cursor-cli/2026.10.14-941492e/incidents/provider-refusal-after-crash/README.md)） | 内容被拒：不重试 |
| 轮中认证失效 | `Please sign in to continue` 或 `Error: [unauthenticated] …` + `end_turn` | 【源码 A@15087、A@15425】，【待验】 | 需要重新登录 |
| 模型不可用 | `set_config_option` → `-32602 Invalid model value: <值>`；`--model <未知>` → 进程 exit 1 | 【实测】 | 模型不可用 |
| 轮中断网 | 断网 6 ms 后，一条 `agent_message_chunk` `"\n\nError: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)"`，然后 `stopReason:"end_turn"`。之前已流出的正文照常保留。CLI 不重试（调试日志：`Stream ended without turnEnded — connection likely dropped mid-stream`、`decision=THROW RetriableError`、`willRetry:false`、`transportFailureKind: socket_reset`），网络恢复后也不续上；进程不退，下一个请求照常应答 | **【实测 `p0c/network-drop-mid-turn`】**（代理切断全部连接、拒绝新连接）；源码 A@15603 | 网络。CLI 自己把它叫 RetriableError，但这一轮不再重试；要不要自动重发由 Orbit 定（轮中可能已经执行过工具）。P5b 现在按一般的 `Error: …` 报失败（"Cursor CLI failed this turn: …"），建议把 `Error: RetriableError:` 开头的归为网络故障 |
| 进程崩溃 | 收不到 prompt 回复，stdout 关闭 | 【实测】 | 进程异常：结算未终态工具，保留恢复 id |
| 团队已切换 | `-32603`，`message:"Your team has switched to <名>. Create a new session to continue."`，进程随后 exit 0 | 【实测 `team-pin`】 | 需要新会话或换账号 |
| 项目配置无效 | 进程在回复 `initialize` 前 exit 1，stderr `Invalid project config at …` | 【实测】 | 仓库配置错误 |
| 未知会话、方法不存在 | `-32603 details "Session <id> not found"` / `-32601` | 【实测】 | 编程错误 |

- **运行期错误一律是文本加 `end_turn`**【实测三类：额度、拒答、断网；认证只有源码】。服务端的结构化信息（错误码、标题、重置时间）只出现在 CLI 调试日志里。
  **P5b：按上面的固定句子分类，其余 `end_turn` 当作正常结束。**这些句子是英文固定文案，跟版本走，升级要回归。
- **有没有误判**【实测 [`p0c/analysis/turn-endings.json`](evidence/cursor-cli/2026.10.14-941492e/p0c/analysis/turn-endings.json)】：P0a 和 P0c 录下的 27 轮里，
  以 `"\n\n"` 开头的正文块只出现在额度用尽、断网、模型拒答这 3 轮，而且都是最后一块。用 P5b 的 `cursorTurnFailure` 判每轮最后一块，
  只有这 3 轮判为失败，另外 24 轮（正常结束、取消、崩溃、未知会话被拒）都不是；这 24 轮里也没有一个正文块以 `"\n\n"` 开头。
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

### 13.3 D5 的事实与 P6b 的做法

- **事实**：搬运机制可用（同一身份下实测）；会话本身不记账号或团队；跨账号续聊无实测。
- **P0a 当时的建议**：
  - P6b 先实现「把 `acp-sessions/<id>/` 拷到目标账号的 CURSOR_CONFIG_DIR，然后 load」，用两个真实账号验证后再声明 `cursor-account-move/v1`。
  - 验证前按作业指导 D5 的退路处理：只允许没说过话的会话换账号；说过话的会话，控制面拒绝并说明。
  - 没说过话的会话（没有 `store.db`）换账号，就是在新账号下 `session/new`。
- **P6b 的实现**【约定：P6b `34h05fxSQi9F7Uh42a07S`，所有者 2026-10-17 定 D5 用方案 A；`src/apiserver/src/providers/account-move-capability.ts`、
  `src/apiserver/src/sessions/sessions.service.ts`；验收 `scripts/test-cursor-account-move.mjs`】：
  - **不用拷**：P4b 起，会话库总在会话自己的 `cursor/config/acp-sessions/` 里，从不在账号目录里（`cursor_launch.go`），会话只借用账号的登录或一把 key。
    所以两个真实身份验证过跨身份续聊之后，runner 只要声明 `cursor-account-move/v1` 就够了，控制面已经按它放行。
  - **「说过话」的判定**（`cursorConversationStarted`）：`numTurns > 0 || runtimeSessionId != null || 正在生成`。
    有一轮已结算；或者 Cursor 已开了对话（runner 在第一条 prompt 之前上报 `runtimeSessionId`）；或者正有一轮在跑（切换要等这一轮结束才生效）。
  - **拒绝**（`cursorMoveRefusal`）：说过话的会话，只要它的 runner 没声明 `cursor-account-move/v1`，三个入口一律 409 拒绝、什么都不写，文案是
    `CURSOR_CONVERSATION_MOVE_REFUSAL`："Cursor CLI can't carry a conversation to another account or key yet. Start a new session to use a different one."
    - `PATCH /sessions/:id/config`（`updateConfig`）：key ↔ runner 登录、key ↔ key、点名账号的切换；
    - `POST /sessions/:id/resume` 带 provider（`resume`）：在另一个凭据上复活已结束的会话，失败卡片的 Retry 也走这里；
    - `PATCH /sessions/:id/account`（`switchAccount`）：账号 ↔ 账号。
    - 没说过话的会话（PENDING，或在 Cursor 开对话之前就结束了）在任何 runner 上都能换。
  - **现在没有 runner 声明 `cursor-account-move/v1`**：`src/runner-go/cursor_account_slot_test.go` 的 `TestCursorRunnerDoesNotDeclareAccountMove` 钉住这一点。
  - Cursor 会话的工作区移动目前整个拒绝（`session-move.ts` 的 `sessionMoveVerdict`）。`accountsAfterMove` 另外保证同一 runner 上的移动不改它的账号（同 Kimi），
    换 runner 时清掉账号列。
  - 客户端灰掉 Provider 菜单用同一条规则（`numTurns > 0 || runtimeSessionId != null || generating`，runner 声明了能力时除外），请求到了服务端被拒时显示 409 的文案。
  - 跟着工作区账号或工作区 key 走的会话（会话自己没选账号）没有入口可拦，由 runner 的身份固定兜住（§13.4）。

### 13.4 说过话的会话固定在开局身份上（P6b 跟进）

【约定：P6b 跟进 `34hKm7V7ACTBffmFbgpPZ` 及协调会话 2026-10-17 的裁定；`src/runner-go/cursor_identity_pin.go`、`session.go`；验收 `scripts/test-cursor-identity-pin.mjs`，交付时 39 个具名场景】

- **固定在哪**：只在 runner 的会话记录里，即 `meta.json` 的 `cursorIdentity`，不加控制面的列。它守护的对话就在同一个目录里（`<runs>/<session>/cursor/config/acp-sessions/`），两者同生共死。
- **取值**（`cursorCredentialIdentity`，顺序同 `cursorLaunchCredential`）：
  - 派发的 key：`key:<指纹>`；
  - 借用的 runner 账号（含 Default）：`account:<账号 id>`；
  - 否则是工作区自带的 key 和 token：`key:<指纹>`、`token:<指纹>`，两个都有时用 `+` 连起来（两个都在时 CLI 用哪一个没有实测）。
  - 指纹是 P2 的 `cursorKeyFingerprint`：去掉首尾空白后 SHA-256 的前 16 个十六进制字符。key 和 token 本身从不写下。
- **写入时机**：CLI 打开或 load 对话之后（`writeCursorSessionMeta`）。其他写会话记录的地方都保留原值；别的 engine 的记录从不带这个字段。
- **何时拒绝**（`cursorIdentityRefusal`，在每次启动 CLI 都要经过的 `runCursorSessionProcess` 里、准备启动和校验 key 之前检查）：
  派发里带着要 load 的对话（有 `runtimeSessionId`，而且不是从没发过 prompt 的那种），记录里固定的身份和这次不同，这台 runner 又没声明 `cursor-account-move/v1`。
  这次运行以 `CURSOR_CONVERSATION_MOVE_REFUSAL` 的原文失败（和控制面的文案一字不差，`providers/cursor-identity-pin.spec.ts` 读 Go 源码核对），
  不启动 CLI、不开新对话、记录不动。这句话不属于任何自动重试的类别，所以不会循环。用户可以把工作区改回去，或者新开会话。
- **照常运行的情况**：还没有对话；开过对话但从没发过 prompt（只跑过 shell 轮，Cursor 没东西可 load，驱动本来就新开一个）；身份相同（例如同一个账号重新登录换了 token）；
  这个字段出现之前写的记录；runner 声明了 `cursor-account-move/v1`（对话继续，固定的身份改成新的）。
- **协调裁定**：
  - 同一个 provider 原地换了一把新 key，算换身份，说过话的会话被拒（符合 D5 的保守做法）。
  - P6b 的入口把「开过对话但没发过 prompt」算作说过话，runner 却允许它换身份新开对话。两边不一致，但没有可携带的对话，可以接受；界面按入口的规则灰掉。
- **已知限制**：账号槽重新登录成另一个 Cursor 用户时检测不到。账号按槽 id 识别（P4b 的约定），runner 不知道登录的是谁。
- **代价**：控制面不知道固定的身份，客户端显示不了；拒绝以启动失败的形式到达，不是入口上的 409；比这更早的 runner 不执行这条（P9「先升级 runner」的顺序覆盖它）。
- 依据（假 CLI 和 PG）：`TestCursorIdentityPinRefusesAnotherAccount`、`TestCursorIdentityPinRefusesAnotherKey`、`TestCursorIdentityPinFollowsAnUnspokenSession`、
  `TestCursorIdentityPinContinuesOnTheSameIdentity`、`TestCursorIdentityPinMovesOnARunnerThatCarriesIt`、`TestCursorIdentityPinLeavesOtherEnginesAlone`。

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
- **P5c 的结论**【实测：P5c 的 15 个真实会话（`src/runner-go/testdata/cursor/p5c/README.md`）；约定：协调会话 2026-10-17 裁定第 6 条】：
  `worker-server` 和 `rg --files` 在轮中启动，但没有一次出现 `npx`、`typescript-language-server` 或任何来自仓库的进程，
  `p5c/malicious-repo` 的夹具带着 tsconfig、`.ts` 文件和植入的 `node_modules/typescript` 也没有。上面那条 npx 行为没有复现，
  `--disable-codebase-ref` 的代价又不知道，所以**不加**。P8 在真 runner 的冒烟里继续留意 npx 子进程，出现了再加。

### 14.4 提交署名（D2）

**结论：提交带不带 trailer，因模型而异。** 依据是 P8 的录制：默认设置、同样选 Auto，P0c 那次的提交没有 trailer，
P8 的两次提交（Auto 路由到 `grok-4.7-high`）都有。

- **【实测 `p0c/background-shell-and-commit`】没有 trailer**：默认设置（`attributeCommitsToAgent` 没改，客户端照常发 `commitAttributionMessage:"enabled"`）下，
  agent 用 `git commit -m "$(cat <<'EOF' … EOF)"` 提交，提交信息只有 `p0 attribution probe`，没有任何 trailer。
  会话库存下的提示里也没有 trailer 的要求：服务端给的 `<user_rules>` 里 `committing-changes-with-git` 一节只要求用 HEREDOC 传提交信息，
  示例在正文后留了一个空行，全文没有 trailer、Co-authored-by、Made-with 之类的字样。只测了一次（Auto 模型，个人账号），Auto 选了哪个模型没有记录。
- **【实测 P8（`34h05gNODW63XwtyJ4Lno`），2026-10-19】有 trailer**：
  - 环境：HPC 真 runner，固定版本 CLI，Orbit 中保存的 Cursor API key，默认设置，Auto。
  - agent 自己在提交命令里加了 trailer：`git commit --trailer "Co-authored-by: Cursor <cursoragent@cursor.com>" -m "$(cat <<'EOF' … EOF)"`。
    P8 的两轮录制里都有这条命令。
  - 两次提交的信息都以 `Co-authored-by: Cursor <cursoragent@cursor.com>` 结尾：
    - `5c4e79a`：`p8: add key session note`，key 会话里改文件并提交的那一轮；
    - `030410d`：`Add mul() next to add() so products can be computed.`，钉在 cursor 和 key 上的 EXECUTABLE 任务。
  - P8 的报告记下这两轮的 Auto 路由到 `grok-4.7-high`。
  - trailer 是模型写进 shell 命令的参数，不是 CLI 或 git hook 加的，与下面的源码结论一致。
- **【源码】**：
  - `attribution.attributeCommitsToAgent`（默认 true）只让客户端在请求里带 `commitAttributionMessage:"enabled"`【I@4693233、I@4694065】，
    trailer 文本由服务端提示模型写，打包文件里找不到任何 trailer、git hook 或 GIT_* 变量。
  - 管理员可以关掉；拿团队设置失败时也按关掉处理【I@4773670】。
- **【文档】**："adds a trailer to agent commits"。
- **建议**：沿用默认（作业指导 D2，不变）。署名有没有由模型决定，Orbit 左右不了。
  界面和文档仍不承诺提交里会出现 Cursor 的署名，也不承诺不出现。所有者要求关闭时，在账号 `cli-config.json` 写
  `"attribution":{"attributeCommitsToAgent":false,"attributePRsToAgent":false}`。

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

## 16. 后续任务共用的接口约定（【约定】，P1–P6 已按此实现，实现位置写在各条里）

### 16.1 能力名

| 能力 | 含义 | 由谁实现 |
| --- | --- | --- |
| `provider:cursor` | runner 的 `runnerSupportedProviders` 加上 `cursor`，心跳持久化为 `provider:cursor`；旧 runner 没有这一项，就领不到 Cursor 会话 | P1 |
| `cursor-account-login/v1` | runner 能在控制面指定的账号目录里登录（独立 `agent login` 进程，转发链接；上报的剩余时间按 23 分钟算，中继最多等 29 分钟，§9）。在 Linux 和 macOS 上声明（macOS 自 macOS runner 支持起，§18.9） | P4b |
| `cursor-account-remove/v1` | runner 能删除指定的账号目录及记录，不碰其他账号；有会话在用时拒绝。在 Linux 和 macOS 上声明（同上） | P4b |
| `cursor-key-check/v1` | runner 能替控制面检查一把 Cursor key（连接时校验、Check Again）：用固定版本 CLI 跑 `agent models`，临时 HOME、memory 存储，从不走 ACP 握手，15 s 内回 `VALID`、`INVALID` 或 `UNREACHABLE`（`src/runner-go/cursor_key_check.go`） | P2 跟进 |
| `cursor-account-move/v1` | runner 允许说过话的会话在另一个账号或 key 上续聊。会话库总在会话自己的目录里，换身份不用拷（§13.3）；控制面的三个入口和 runner 的身份固定（§13.4）都看它。**跨身份验证前不声明**，现在没有 runner 声明 | P6b |

### 16.2 账号目录与派发变量

```text
<orbit home>/cursor/default/            Default 账号
<orbit home>/cursor-accounts/<id>/      新加的账号（命名同 antigravity-accounts）
  config/        CURSOR_CONFIG_DIR：cli-config.json（Orbit 写 attribution、channel 等）、acp-sessions/（会话库）
  data/          CURSOR_DATA_DIR：projects/<slug>/
  xdg-config/    只给 `agent login` 用的 XDG_CONFIG_HOME：Linux 的登录存在这里，cursor/auth.json（登录 token，0600）
  home/          只在 D4 选 A 时给 CLI 当 HOME；macOS 的登录存在这里，.cursor/auth.json（0700/0600，XDG_CONFIG_HOME 对它无效，§18.3）
  tmp/           TMPDIR（调试日志），或者改为设 CURSOR_AGENT_DISABLE_DEBUG_LOG=1；worker socket 可能仍落在 /tmp/.cursor/（§8.1）
```

- 派发变量：`ORBIT_CURSOR_ACCOUNT_DIR=<账号目录>`，做法同 `ORBIT_ANTIGRAVITY_GOOGLE_DIR`。runner 读它，从 CLI 的环境里删掉。
- **P4b 的实现**（`src/runner-go/cursor_account_slot.go`）：账号目录里只有 `agent login` 用的 `home/`、`config/`、`xdg-config/`（HOME、CURSOR_CONFIG_DIR、
  XDG_CONFIG_HOME，凭据存 file），登录存在哪里按平台取（`cursor_health.go` 的 `cursorStoredLoginPath`）：Linux 是 `xdg-config/cursor/auth.json`，
  macOS 是 `home/.cursor/auth.json`（§18.3）。读登录的地方都经过它：登录状态、会话借用、过期判断、额度、模型目录、健康检查。会话不在账号目录里跑：P3 起每个会话的 `config/`、`data/`、`home/` 都在会话自己的目录里，
  会话只借用账号的登录，读出 accessToken 以 `CURSOR_AUTH_TOKEN` 加 memory 存储交给 CLI，什么都不写回账号目录。
  会话的记录（`meta.json` 的 `cursorAccountDir`）写下借用的账号，移除时据此拒绝；同一份记录的 `cursorIdentity` 固定对话开局时的身份（P6b 跟进，§13.4）。
  runner 只读已存的登录，从不刷新（§8.4 第 4 条）。
  Linux 和 macOS 上保留 Default 以外的账号（D4 方案 A，§8.4、§18.7；`cursorAccountsSupported`）；其他平台不声明 `cursor-account-login/v1`、`cursor-account-remove/v1`，
  只有 Default（方案 D）。macOS 是 P0b 跟进（2026-10-25）实测方案 A 成立之后，由 macOS runner 支持任务按 §18.7 的两条差异实现并声明的（§18.9）。
- API key 凭据（P2）不建账号目录。会话用自己的 `config/`、`data/`（放在会话 scratch 下，续聊时复用），key 以 `CURSOR_API_KEY` 注入，用 memory 存储。

### 16.3 启动参数

```text
argv: <固定版本目录>/cursor-agent acp --disable-auto-update --disable-indexing [--force] --disable-project-configs
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

- **参数**【约定：P3、P5c 实现，协调会话 2026-10-17 裁定】：每个进程都带 `--disable-auto-update` 和 `--disable-indexing`（D1）（`cursor_launch.go` 的 `cursorACPArgs`）。
  固定版本的 ACP 不读前一个，本来也不做更新检查（§1.1、§2.1），带上是防以后的版本把更新带进 ACP。每种权限模式都再加 `--disable-project-configs`，Bypass 另加 `--force`
  （`permission_modes.go` 的 `cursorPermissionArgs`）。不加 `--disable-codebase-ref`（§14.3）。参数是进程的：改模式改到了参数（进出 Bypass）就换一个进程，
  否则只改 Cursor 模式。【实测：`p5c/*/summary.json` 的 `args`】
- **环境分三层，后面的覆盖前面的**【约定：协调会话 2026-10-16 裁定，P5a 实现于 `src/runner-go/cursor_launch.go`】：
  1. runner 自己环境的白名单（`cursorBaseEnv`）。白名单以外，runner 的变量一个都不传。
  2. 会话的 agent 环境（`job.Agent.Env`，即工作区环境变量），和其他 engine 一样传入。不传的只有：Orbit 的会话上下文变量、
     `ORBIT_HOME`、个人凭据（`ORBIT_USER_TOKEN` 等），以及只给 runner 读的派发变量 `ORBIT_CURSOR_API_KEY`、`ORBIT_CURSOR_ACCOUNT_DIR`。
  3. 契约固定的变量（HOME、SHELL、CURSOR_CONFIG_DIR、CURSOR_DATA_DIR、AGENT_CLI_CREDENTIAL_STORE=memory、NO_OPEN_BROWSER、DIRENV_DISABLE、
     CURSOR_AGENT_DISABLE_DEBUG_LOG、Orbit 的会话变量），以及 Orbit 选定的凭据。工作区设了同名变量也以这一层为准。
- **凭据的选法**，依次：
  1. 派发的 key（P2：`ORBIT_CURSOR_API_KEY`，以 `CURSOR_API_KEY` 交给 CLI）；其次是派发的账号（P4b：`ORBIT_CURSOR_ACCOUNT_DIR` 指向 Default 以外的账号）
     已存登录的 accessToken，以 `CURSOR_AUTH_TOKEN` 交给 CLI。这个账号没登录、登录已过期（剩余不足 300 s 也算），或者不是这台 runner 的账号时，会话以
     `Failed to authenticate: …` 拒绝，不退回 Default 或工作区的凭据。Orbit 选了凭据时，工作区带来的 `CURSOR_API_KEY`、`CURSOR_AUTH_TOKEN` 都换掉。
     点名的账号优先于工作区自带的 key 和 token，是协调会话 2026-10-17 的裁定（P4b 交付说明第 3 项：显式选择优先）。点名 Default 算没点名：
     工作区的凭据照常优先于 Default 的登录。额度按同一顺序记账（P6a，§11）。实现：`src/runner-go/cursor_launch.go` 的 `cursorLaunchCredential`。
  2. 工作区环境变量里的 `CURSOR_API_KEY` 或 `CURSOR_AUTH_TOKEN`，原样经第 2 层传入。这与 server 的登录预检（`CREDENTIAL_ENV_KEYS.cursor`）
     和 `OWN_CREDENTIAL_KEYS.cursor` 一致，runner 的 `hasInjectedCredentials(cursor)` 读的也是这三个变量。
  3. 都没有时，用 Default 账号已存的登录（`<orbit home>/cursor/default/` 下按平台取的 `auth.json`：Linux `xdg-config/cursor/auth.json`，
     macOS `home/.cursor/auth.json`；accessToken 以 `CURSOR_AUTH_TOKEN` 注入；
     剩余不足 300 s 算过期，不用）。
  4. 一个都没有：不启动 CLI，会话以「需要登录」（`Failed to authenticate: …`）结束。
- **每个 CLI 进程都显式设 `AGENT_CLI_CREDENTIAL_STORE`**【约定：macOS runner 支持，§18.4、§18.9】：`agent login` 是 `file`，其余都是 `memory`——
  会话（上面的固定层）、版本探测、`agent models`（登录状态、key 校验）、模型目录（`cursorProbeEnv`）。从不落到默认存储：macOS 的默认存储是 Keychain。
  手动登录的提示（`cursorLoginHintFor`）也带 `AGENT_CLI_CREDENTIAL_STORE=file`。哪些地方启动 CLI 由 `TestCursorEveryCLIStartNamesItsCredentialStore` 的普查从源码里点名，
  新加的启动点不设存储就过不了。
- agent 跑的命令经会话自己的 orbit-bash（SHELL）执行：还原真 HOME，unset `CURSOR_API_KEY`、`CURSOR_AUTH_TOKEN`、`CURSOR_CONFIG_DIR`、`CURSOR_DATA_DIR`，
  把 `XDG_*` 和 Orbit 只给 CLI 设的变量还原成其他引擎会话里的值（P4b，§8.4）；工作区的其他变量照常可见。【实测 `p0c/shell-wrapper-env`，§8.4；hooks 不经过它】
- `initialize` 用 §2.2 的请求。`session/new` 或 `session/load` 一律带上 `mcpServers`（Orbit MCP 等），load 时重新给。
- 模型用 `set_config_option`（参数化选择器），不用 `--model`。新会话默认 Auto（`default` / `default[]`）。
- 健康检查（P3）：`--version` 等于固定版本；`agent models` 退出码 0，说明凭据有效、能联网。不要用 `status`（它不认 API key）。

### 16.4 事件映射（P5a）

| ACP | Orbit |
| --- | --- |
| `agent_message_chunk` | 正文增量（按轮累加；先过 §12 的错误句子匹配） |
| `agent_thought_chunk` | 思考增量 |
| `tool_call` / `tool_call_update` | 工具开始和进度；`completed` 是终态，rawOutput 带 `exitCode≠0` 或 `error` 时标为失败，带 `rejected`（只有 MCP 被拒时有）时标为被拒。shell 和编辑被拒时 Cursor 只发 `{status:"completed"}`【实测 `src/runner-go/testdata/cursor/p8/key-allow-reject`】，所以被拒以 Orbit 自己回过的应答为准：回过 allow 以外应答的卡结算为 "Not run: the tool call was rejected."（`isError:true`），Cursor 的 `completed` 没到这一轮就结束也一样（§5.2，D-P8-1 及其收尾）；审批卡还没人应答这一轮就结束的，撤回时做标记，结算为没有运行（`isError:true`，§5.2）；取消、断开、崩溃后 Orbit 自己结算其余 `in_progress` 的卡（§3.3） |
| `plan`、`cursor/create_plan` | 计划展示；create_plan 要应答（P5c：计划卡，Don't Ask 下回 `rejected`） |
| `cursor/update_todos` | 待办列表（请求，回 `{}`） |
| `subagent_spawned` / `subagent_state_update` + 子会话的更新 | 子代理卡（需要 `_meta.subagents`）；`cursor/task` 回 `{}` |
| `session_info_update` | 会话自动标题（可能晚于轮次结束），只在领取带 `naming` 时上报（P5a 跟进）。本进程 `session/new` 开的对话一律不报：它的第一条 prompt 前面是 Orbit 的指令，标题是对指令的概括（§3.2），会话保留从用户第一条消息截取的标题（D-P8-2，`cursor_acp.go`）。`session/load` 的对话照旧上报 |
| `available_commands_update` | 斜杠命令列表 |
| `current_mode_update` | 模式变更回显 |
| `session/request_permission` | 按模式应答（§16.5）：审批卡、Orbit 的规则直接允许，或直接拒绝；按 §5.2 关联工具卡；只应答一次，从不选 `allow-always` |
| `cursor/ask_question` | 提问卡（Don't Ask 下回 `skipped`）。agent 和 plan 模式下都没收到过（§4.2 实测），但必须能应答 |
| kind `switch_mode` 的工具卡 | 模型自己切了模式，CLI 已自行批准（§4.2，实测）。P5c：Plan 下停止这一轮并说明（notice `cursor-plan-mode-left`）；任何模式下一轮发 prompt 前都重设模式 |
| `session/prompt` 回复 | 轮次结算：`end_turn`（先检查错误句子）/ `cancelled` |
| 上下文用量 | 不可用（ACP 不上报） |

### 16.5 权限模式映射（P5c 实现，按 §5.4 的事实）

【约定：P5c 实现（`src/runner-go/cursor_permissions.go` 的 `cursorPermissionPolicyFor`，`permission_modes.go` 的 `cursorPermissionArgs`，shared `CURSOR_PERMISSION_MODES`），
协调会话 2026-10-17 裁定；验收 `scripts/test-cursor-permissions.mjs`，交付时 67 个 runner 场景加 28 个 shared / API server 场景】

| Orbit 模式 | 启动参数（`acp --disable-auto-update --disable-indexing` 之后） | Cursor 模式 | Orbit 对权限请求的处理 | 实测 |
| --- | --- | --- | --- | --- |
| `acceptEdits`（没指定模式时的默认，D6） | `--disable-project-configs` | agent | 审批卡；卡上的「总是允许」回 `allow-once`（§5.2） | `p5c/accept-edits-allow-deny`、`p5c/allow-always` |
| `auto` | 同上，**不用** `--force` | agent | Orbit 自己的请求级分类：例行命令由 runner 直接 `allow-once`，其余出卡。例行指：按 Codex Auto 的规则是例行的（`codexAutoApproval`：不 push、fetch、install，没有远程 shell、内联解释器、密钥文件、递归删除），不作用于别的系统（DSH 的工具闸 `dshToolGateMatch`），不起容器，路径不出工作区和临时目录（`cursorAutoAllows`） | `p5c/auto` |
| `plan` | 同上 | plan，每轮发 prompt 前核对 | 一律 `reject-once`，不出卡；提问和计划照常出卡；看到 `switch_mode` 工具卡就终止这一轮（§4.2） | `p5c/plan`、`p5c/plan-switch-mode` |
| `dontAsk` | 同上 | agent | 一律 `reject-once`，不出卡；提问回 `skipped`，计划回 `rejected`；工作区内的写照样发生，模式说明如实写明 | `p5c/dont-ask` |
| `bypassPermissions` | `--force --disable-project-configs` | agent | 不会来请求；团队否决 Run Everything 时来了就出卡问人，每个进程提示一次（§5.3） | `p5c/bypass`；团队否决只有回放 |
| `default` | — | — | **不提供**（编辑前要问做不到，D6），服务端和 runner 都拒绝 | — |

- 每种模式都带 `--disable-project-configs`：P0c 实测它让仓库 cli.json 失效，坏的 cli.json 也不再让启动失败（§2.1、§7.2）。这是协调会话 2026-10-17 给 P5c 的补充第 2 条。
  `DIRENV_DISABLE=1` 在固定的环境层里（§16.3），每种模式都有。
- 所有模式：Orbit 自己的 MCP 工具（`mcp__orbit__*`）预先允许，不出卡（§6）；每个请求只应答一次（§4.2）；`disallowedTools` 非空时拒绝启动
  （Cursor 读文件、在工作区里写文件都不问，挡不住，`cursorToolPolicyError`）；没写模式的按 Accept Edits；账号默认设成 Auto 的，新 Cursor 会话就是 Auto（裁定第 2 条）。
- 除 Bypass 外，启动前守卫会话 HOME 和数据目录里会被 Cursor 不问就执行的配置（§6 的 `guardCursorUserConfig`）。
- 用户级 `~/.cursor` 配置不会进来：D4 用 A，CLI 的 HOME 是会话或账号自己的目录（§8.4）。

### 16.6 错误分类（P5b）

见 §12 表的最后一列。实现要点：

1. JSON-RPC 错误只出现在建会话或设置阶段。
2. 轮内错误按固定句子匹配：`Upgrade your plan to continue` 是额度或限流；`Request blocked … usage guidelines` 是内容被拒；
   `Please sign in to continue` 或 `[unauthenticated]` 是认证；`Error: RetriableError: …`（实测轮中断网，§12）是网络故障，要不要自动重发见 §12。
3. 收不到回复、stdout 关闭，是进程异常。
4. `-32603 "Failed to initialize session services"` 用 `agent models` 二次判定是凭据还是网络。

### 16.7 D1–D5 小结

| 待定项 | 事实 | 建议 |
| --- | --- | --- |
| D1 索引 | §14.3：只在隐私模式 4 时上传完整文件内容；本账号 0 字节；`--disable-indexing` 不影响功能 | 默认加 `--disable-indexing`（所有者已定，P3 已实现）；worker 的 npx：P5c 的 15 个真实会话都没出现，不加 `--disable-codebase-ref`（§14.3） |
| D2 署名 | §14.4：客户端只发开关，文本由服务端定；实测带不带 trailer 因模型而异（P0c 没有；P8 的 `grok-4.7-high` 自己加了 `Co-authored-by: Cursor <cursoragent@cursor.com>`） | 沿用默认；不承诺提交里有署名；要关就写账号 cli-config |
| D3 显示名 | CLI 自称 "Cursor Agent" / "Cursor CLI"（`about` 标题 "About Cursor CLI"） | 采用 "Cursor CLI"，内部名 `cursor` |
| D4 隔离 | §8.4：只有 HOME 能挪走 `~/.cursor`；方案 A（SHELL 包装）在 Linux 实测成立：命令拿回真 HOME，看不到 key 和 token | Linux 用 A；macOS：P0b 跟进实测 A 同样成立（§18.7），不用在 B 和 D 之间选；macOS runner 已按 A 实现（§18.9） |
| D5 换账号 | §13：同一身份下搬运加续聊实测可行；团队固定在进程上；跨账号没测 | 验证前只允许没说过话的会话换账号（所有者 2026-10-17 定方案 A；P6b 和它的跟进已实现：说过话的会话三个入口拒绝，runner 固定开局身份，§13.3、§13.4） |

---

## 17. 待验清单与证据边界

### 17.1 待验（实现不得当作已支持）

P0c（2026-10-17，付费套餐，7 次 prompt）已补完 P0a 卡住的场景：仓库配置的运行期效果和两个参数（§7.2、§2.1）、轮中断网（§12）、
D4 方案 A（§8.4）、`cursor/ask_question`（§4.2）、提交署名和后台命令（§14.4、§3.2）。
P5c（2026-10-17，经 Orbit 的 runner，16 次 prompt）又做完第 7 条和第 5 条的主要部分。还没验证的（编号保持不变，做完的条目写明）：

1. 远程设备完成登录；浏览器登录 token 的寿命和过期表现；`agent logout` 对登录账号的效果（场景 `login-account`，要所有者亲自登录一次，1 次 prompt）。
   P4b（2026-10-17）又请所有者登录两次，两次的链接都没人用，分别在 1,543 s、1,562 s 后过期（§9）。协调会话把这一条放到 P8 一起补验。
2. 跨账号或跨团队续聊（D5），以及不同账号的模型目录差异。验证之前，P6b 按 D5 方案 A 拒绝说过话的会话换身份，runner 不声明 `cursor-account-move/v1`（§13.3、§13.4）。
3. 团队管理员否决 Run Everything（没有团队账号；P5c 的处理只用回放验证，§5.3）；限流的形状（P5b、P6a 按额度用尽处理，§11、§12，P8 冒烟碰到时记下）；
   轮中认证失效的形状；断网以外的网络故障（DNS 失败、代理报错、慢网）会不会被重试（§12）。
4. deny 规则的强制力；`approvalMode: unrestricted`；`channel: static`；`--disable-codebase-ref` 对回答质量的影响；用别的 cwd load 会话。
5. **审批进行中停止、请求未答时 CLI 被杀：P5c 已实测**（`p5c/accept-edits-stop`、`p5c/accept-edits-disconnect`，§3.3）。
   剩下：只发 `session/cancel`、不应答未答的请求时 CLI 怎么收尾（Orbit 总是应答，不依赖它）。
6. `cursor/ask_question` 真来时的形状、不应答和回退（agent、plan 模式都没触发过，只有源码，§4.2）。
7. **P5c 已实测，不再待验**：模型自己用 `SwitchMode` 切出 plan，CLI 不问客户端、不发 `current_mode_update`，随后的写文件成功（`p5c/plan-switch-mode-raw`）；
   Orbit 在 Plan 下看到 `switch_mode` 工具卡就终止这一轮（`p5c/plan-switch-mode`，§4.2、§5.4）。
8. 仓库能不能借 cli.json 数组整体替换去掉用户的 allow 条目；工作区上层目录（例如 Orbit worktree 上面的 `/root`）的 `AGENTS.md`、`CLAUDE.md`、
   `.cursor/rules/` 是否进上下文；Claude 格式的用户 hooks（`$HOME/.claude/settings.json`）在 ACP 的工具事件上会不会运行（§7.2）。
9. 后台命令在 CLI 退出或被杀之后的去向（§3.2）。Orbit 不依赖它：每会话进程作用域在 CLI 结束时回收全部后代（§3.4，假 CLI 验证），真 CLI 上的复测放到 P8。
10. 付费套餐下非 Auto 模型会不会推动用量百分比（§11）。
11. **macOS：P0b 跟进已补完（2026-10-25，§18.8）**：P0b 交付了 §18 的无需凭据部分；跟进任务用所有者的 Premium key 跑完了带凭据的场景
    （4 次 Auto prompt，账本 p0bm 4/10，§18.8），**D4 方案 A 在 macOS 成立**（§18.7）。macOS 上仍待验的：远程设备完成登录（与 Linux 同一条，随 P8 做）；
    Keychain 默认存储不稳定行为的触发条件仍未定位，但结论不变（任何路径显式设 `AGENT_CLI_CREDENTIAL_STORE`，§18.4）。Linux arm64、其他发行版。
    **macOS runner 已支持**（2026-10-25，§18.9）：darwin/arm64 固定版本、Default 以外的账号、按 macOS 布局读写登录、所有 CLI 进程显式设凭据存储，
    用假 CLI 和平台替身验证。还没在 Mac 上用真 CLI 跑过的：runner 自己的安装（下载、解包、quarantine）、两个账号的登录和并发会话——
    由 `TestCursorRealAccounts`（§18.9）在 orbit-macos 上做，所有者登录两个账号，协调会话另开任务。Intel Mac（darwin/amd64）没测过，照旧报 `CURSOR_PLATFORM_UNSUPPORTED`。

P0c 跑过的命令（固定版本，P0c 账本）：

```sh
node scripts/cursor-p0/reproduce.mjs --only shell-wrapper-env,repo-config-baseline,repo-config-with-flags,network-drop-mid-turn,background-shell-and-commit,ask-question,ask-question-plan-mode
```

剩下要花 prompt 的：所有者完成登录后的 `login-account`（1 次，随 P8 做）。第 7 条已由 P5c 做完（`p5c/plan-switch-mode-raw`，记在 P5c 账本）。

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

P0c 的 21 个场景运行期断言全部成立，没有事后分析。P0c 改过的场景定义：`install-and-version` 不再断言固定版本就是最新版，只记录
`latestVersion`、`latestStatus`，并结束安装器留下的 `cleanup-install-versions` 进程；`shell-wrapper-env` 改用 P3 的 orbit-bash 原文和 P3 的固定层环境，
同时带 key 和 token；`repo-config-*` 多了 `mkdir` 一步（只有 `.claude/settings.json` 放行它）和槽目录里的用户级规则；`ask-question` 记录会话库给出的工具，
另有 plan 模式的版本；`network-drop-mid-turn` 记录断网后的每个正文块和 CLI 调试日志里的失败原因；`failure-shapes-without-prompt` 加了
「`--disable-project-configs` 下无效的 cli.json」一项。

### 17.3 证据边界

- P0a 的【实测】来自一个 Free 套餐的个人账号（不属于任何团队，隐私模式 3），一把 User API Key，Auto 模型。
  P0c 的【实测】来自同一个账号升级后的付费套餐（`Premium`，用量按周计），同一把 key，Auto 模型。团队账号、其他隐私模式的表现可能不同。
- Auto 会路由到不同的模型，正文措辞每次不同。断言只看 CLI 的行为（权限请求、工具卡、文件、副作用日志），不看模型说了什么，例外都注明了。
- P0a 的真实 prompt 账本：20 次。第 2、3 次是脚本缺陷造成的（`--selftest` 驱动了真 CLI），它们的协议录制丢失，产物事后检查过（见 [exploration/README.md](evidence/cursor-cli/2026.10.14-941492e/exploration/README.md)）。
- P0c 的真实 prompt 账本：7 次，每次对应一个场景，录制都在 `p0c/protocol/`。
- P0b 跟进（macOS，2026-10-25）的真实 prompt 账本：4 次（cap 10，账本 `p0bm`，`Auto (default[])`），Premium 套餐（`usage-api` 录制里
  `GetPlanInfo.planName=Premium`），录制在 `macos-2026.10.14-941492e/protocol/`。
- P5c 的【实测】来自同一个账号的付费套餐和同一把 key，Auto 模型，CLI 由 Orbit 的 runner 启动和驱动（P0a、P0c 是 P0 的工具包直接驱动）。
  真实 prompt 账本 16 次，其中第 1、3、10 次的场景第一版被重跑替换，录制不保留（[`p5c/README.md`](../src/runner-go/testdata/cursor/p5c/README.md)）。
- 实现任务的其余结论（P4b、P5b 跟进、P6a、P6b 及其跟进）用假 CLI、回放和 PG 用例验证，条目里标【约定】并写明用例或验收脚本；
  P6a 的额度读数用真 CLI 换 token，不花 prompt（§11）。

---

## 18. macOS（P0b 及其跟进，darwin/arm64，macOS 27.0.1 / Apple M2）

平台：orbit-macos（8 GB，GUI 登录会话 `long`）。CLI 版本与 Linux 相同（`2026.10.14-941492e`），tarball 哈希见页首。
证据：`docs/evidence/cursor-cli/macos-2026.10.14-941492e/`，复现命令同 README（macOS 无 strace/unshare，相关断言以「skipped」记录）。
没有与 Linux 不同的行为就不重复，本节只写差异和新增结论。

### 18.1 安装体积与签名

- tarball 178,006,204 字节，解包 **596 MB / 450 个文件**（【实测 `install-and-version`】）。每个账号/会话不用再拷一份。
- 包内文件**都没有 quarantine 属性**（curl 下载只有 `com.apple.provenance`，tar 解包也不加）。签名：`node` 是 Node.js Foundation 的
  Developer ID 签名（TeamIdentifier `HX7739G8FX`）；`rg`、`cursorsandbox`、`crepectl` 是 Anysphere 签名（`DCNK4UB866`）；
  **`cursor-agent-sea` 未签名**（它不进 ACP 路径，且自己以 137 退出，见下）。
- `agent install <版本> <prefix>` 在 macOS 同样可用，装出的 `index.js` 与 tarball 逐字节相同【实测】。
- `about --format json`：`latestStatus` 报 `update_available`、`latestVersion: "2026.10.16-e3cb207"`——与 P0c 在 Linux 上的观测一致，见 §1.3 的两版对比【实测】。

### 18.2 quarantine 对启动的影响【实测 `macos-quarantine`】

| 情形 | 结果 |
| --- | --- |
| curl 下载 + tar 解包（runner 的安装路径） | 任何文件都没有 `com.apple.quarantine`，只有 `com.apple.provenance` |
| 给 `cursor-agent`（bash 脚本）和 `node`（签名）都打上 quarantine 后启动 | `--version` 正常，exit 0。脚本本身不被 Gatekeeper 评估，node 有 Developer ID 签名 |
| 给一个自编译的**未签名**裸 Mach-O 打上 quarantine 后 exec | **照样运行**（macOS 27 对裸可执行文件不做 exec 级 Gatekeeper 拦截；拦截的是 .app 与安装包）。反复测试均即时运行；只有一次（本机冷启动后第一个被评估的二进制）挂起 2.5 分钟直到被杀——像是 syspolicyd 的首次冷评估，未复现 |

- **结论**：runner 的 curl+tar 安装路径天然没有 quarantine；即便用户用浏览器下载 zip 解包（Safari 会给解出的每个文件打 quarantine），
  CLI 的启动路径（脚本 + 签名的 node）也不受影响。未签名的 `cursor-agent-sea` / worker 不进 ACP 路径，且它们被 exec 时的 exit 137 与 quarantine 无关（无 quarantine 时同样 137）。

### 18.3 目录差异（对照 §8.1）【实测（探针，见 evidence/probe/）+ 源码】

| 文件 / 目录 | macOS 上决定它的变量 |
| --- | --- |
| `auth.json`（file 存储） | **恒为 `$HOME/.cursor/auth.json`**（目录 0700，文件 0600）。XDG_CONFIG_HOME、CURSOR_CONFIG_DIR 都无关【源码 `cli-credentials/dist/index.js` 的 darwin 分支 + 实测】。Linux 是 `$XDG_CONFIG_HOME/cursor/auth.json`，**runner 按平台取路径**（`cursorStoredLoginPath`，§18.9） |
| `cli-config.json`、`statsig-cache.json`、`acp-sessions/` | `CURSOR_CONFIG_DIR` > `$XDG_CONFIG_HOME/cursor` > `~/.cursor`（**与 Linux 相同**）【源码 `cursor-config/dist/paths.js` 无平台分支 + 实测】 |
| `projects/<slug>/` | `CURSOR_DATA_DIR` > `~/.cursor`（同 Linux） |
| `agent-cli-state.json`、`skills-cursor/`、`ai-tracking/` | 只有 HOME（同 Linux） |
| Node 编译缓存 | **`$HOME/Library/Caches/cursor-compile-cache`**（macOS 惯例；XDG_CACHE_HOME 无关）【实测】 |
| 调试日志 | `/tmp/cursor-agent-logs-<uid>/`，TMPDIR 可移，`CURSOR_AGENT_DISABLE_DEBUG_LOG=1` 可关（同 Linux）【实测 `debug-log-location`】 |
| XDG_DATA_HOME | 启动时什么都不写（同 Linux） |

- 真实 HOME 下即使只跑 `--version` 也会写 `~/.cursor/cli-config.json`（和联网时 `statsig-cache.json`）【实测】——§8.4 事实 3 在 macOS 同样成立。
- worker socket 的长路径回退公式与 Linux 相同（`/tmp/.cursor/<slug>-<hash>/`）【源码 `paths.js` 同段代码】。

### 18.4 凭据存储（对照 §8.2）【实测 `macos-keychain-store`、`credential-stores`、`directory-variables`、探针（evidence/probe/）+ 源码】

| `AGENT_CLI_CREDENTIAL_STORE` | macOS 上的结果 |
| --- | --- |
| `file` | `$HOME/.cursor/auth.json`（0700/0600），字段 `accessToken`、`refreshToken`、`apiKey`，**key 本身也落盘**（同 Linux 语义，路径按 §18.3） |
| `memory` | 什么都不写 |
| 不设（`default`） | **Keychain**。实现是 shell out 到 `/usr/bin/security` 的 generic password【源码 `keychain/dist/index.js`】。条目：**acct `cursor-user`，svce `cursor-access-token`、`cursor-refresh-token`、`cursor-api-key`**（另有 `cursor-bedrock-*` 三个） |

- **条目名是常量**【源码 + 实测 `macos-keychain-store`】：credential manager 以 `domain:"cursor"` 构造（`jo({domain:"cursor",store})`，`index.js` 主入口），
  名字与 HOME、CURSOR_CONFIG_DIR、XDG_CONFIG_HOME 都无关。实测（有效 key、default 存储、真 HOME，两轮分别带不同 CURSOR_CONFIG_DIR / XDG_CONFIG_HOME 布局）：
  `session/new` 后钥匙串出现且只出现三个条目，acct 一律 `cursor-user`，svce `cursor-access-token` / `cursor-refresh-token` / `cursor-api-key`——
  **key 本身也写进 Keychain**（与 Linux file 存储把 key 写进 auth.json 同语义）；不写 auth.json；`status --format json` 能读到已存登录（`isAuthenticated:true`）。
  场景在跑完后删除全部条目并恢复真实 `~/.cursor`（before/added/after 快照见证据目录）。
- **Keychain 是 per-user 全局的**：同机多个 Cursor 账号共享同一组条目，后保存的覆盖先前的。**多账号隔离不能用默认 Keychain 存储**，必须 `file`（按账号 HOME 分目录）或 `memory`（注入，不落盘）。
- **`/usr/bin/security` 按 `$HOME` 解析用户钥匙串**【实测矩阵】：
  - 真 HOME：写条目即时成功，无对话框（GUI 登录会话、钥匙串已解锁时）。
  - **外来 HOME（D4 方案 A 的账号 home）：写条目弹出 SecurityAgent 确认框（Aqua 会话）或挂死（无人应答）**。
  - CLI 自己的钥匙串调用有 30 s 超时【源码 `timeoutMs??3e4`】，超时后打印一次
    `⚠ Cursor couldn't save your credentials. This session continues with the credentials it already has.` 并继续（凭据留在内存）【源码 `credential-store` 错误处理】。
- **默认存储的行为在无头 + 外来 HOME 环境下不稳定**【实测，多轮控制变量 A/B；同一变量集合、同一 HOME 的相邻两次运行可得到不同结果，未定位到稳定触发条件】：
  - 模式一（快，约 0.4–1.4 s）：**不调钥匙串**（进程树里没有 `security` 子进程），把 token 写进 `$HOME/.cursor/auth.json`——行为等同 file 存储。
  - 模式二（initialize 卡 **30 s**，什么都不落盘）：走钥匙串保存 → 超时 → 打印
    `⚠ Cursor couldn't save your credentials. This session continues with the credentials it already has.` 加
    `Error: Cursor couldn't save your login to the macOS keychain. The keychain item is stuck. Delete it and sign in again: security delete-generic-password -s cursor-access-token -a cursor-user` + `agent login`。
  - 模式三（卡 30 s + 打印上述警告 + 仍写出 `auth.json`）：也观察到过。
  - 三种模式都对 runner 不可接受（卡 30 s，或把凭据写到预期之外的位置）。**结论：任何路径都显式设 `AGENT_CLI_CREDENTIAL_STORE`（会话 `memory`、登录 `file`），绝不依赖 default。** 触发条件（疑似钥匙串守护进程状态或服务端下发配置）留给 macOS 跟进任务再测。
- **跟进重测（2026-10-25，真实 key，GUI 会话，`keychain-default-mode-probe`，证据 probe/）**：外来 HOME + default 存储下连续 3 次
  `initialize → session/new` 全部一致地走钥匙串路径——`security add-generic-password -a cursor-user -s cursor-access-token` 弹框挂起，
  CLI 打印 `Error: Cursor couldn't save your login to the macOS keychain. The keychain item is stuck. …`，**不写 auth.json**；
  对话框没被关掉的 45 s 内 `session/new` 一直不应答（P0b 观察到的快速回落和 auth.json 混写两种模式只在无效 token 的运行里出现过，真实凭据下未复现）。
  触发条件仍未定位，但真实凭据的形态是稳定的：就是「挂起」这一种。`CURSOR_ASSUME_SSH=1` 时启动探针 3 s 失败 exit 1（同 §18.4 的启动探针段）。
- **保存时的 token 在命令行上**：CLI 调 `/usr/bin/security add-generic-password … -w <access token>`，同机同用户的其他进程在保存期间
  用 `ps` 能看到该 token（实测进程树观察）。凭据敏感度上，default 存储的 macOS 与 Linux 的 file 存储没有本质区别。
- **启动探针**（只在「判定为 SSH 会话 + darwin + default 存储 + 非 CI」时）【源码 `keychain-check.ts`、`credential-store.ts`】：
  - SSH 判定：`SSH_CONNECTION`/`SSH_CLIENT`/`SSH_TTY`/`SSH2_*`、`MOSH_*`、`VSCODE_SSH_*`、`TERM` 含 mosh 任一即算；
    `CURSOR_*_ASSUME_SSH`/`CURSOR_*_FORCE_SSH`（真值）可强制。
  - 探针 = `security add-generic-password -a cursor-keychain-probe -s cursor-keychain-probe -w probe -U`（3 s 超时）后删除。
  - 探针失败 → `Error: Your macOS login keychain is locked. Run security unlock-keychain and try again.`，**exit 1**。
  - 实测：真 HOME → 探针通过，CLI 正常；外来 HOME → 探针 3 s 超时 → exit 1（shell 与 launchd Aqua 会话一致，§18.6）。
  - 非 SSH 环境（runner 直接 spawn、环境里没有 SSH_*）跳过探针；钥匙串的失败推迟到真正保存凭据时（上面的 30 s 超时警告）。
- `agent logout` 删本地（file 删 `auth.json`【实测】；Keychain 存储下删条目的路径【源码】，未实测到有登录的机器上跑通）。
- `status`/`whoami` 只认已存 token 的语义同 Linux。

### 18.5 登录（对照 §9）【实测 `login-link-and-logout` + 完整计时】

- `NO_OPEN_BROWSER=1 agent login` 立刻打印与 Linux 相同形状的 `loginDeepControl` 链接（challenge/uuid 换新）【实测两次，file 与 default 存储各一】。
- 无人完成时约 27 分钟超时。macOS 完整计时（file 存储，隔离 HOME）：**1,532 s（约 25.5 分钟）**后打印
  `Login failed or timed out. Please try again.`，exit 1（Linux 参考值 1,632 s / 1,636 s）；
  记录见 [`evidence/…/macos-2026.10.14-941492e/login-timing/`](evidence/cursor-cli/macos-2026.10.14-941492e/login-timing/)。期间不写任何凭据【实测】。
- 远程设备完成登录【待验】——与 Linux 相同，所有者没有操作。P4b 的登录中继在 macOS 上**必须**用 `AGENT_CLI_CREDENTIAL_STORE=file`（否则登录完成的 token 会按 default 写 Keychain：headless 挂 30 s，GUI 弹框，见 §18.4），
  并给登录进程设账号自己的 HOME，token 落在 `<账号 home>/.cursor/auth.json`。macOS runner 支持已照此实现（`cursorLoginEnv`，§18.9）。

### 18.6 launchd 会话里的 Keychain【实测 `macos-launchd-keychain`】

runner 以 launchd 服务运行时（本机 orbit runner 就运行在 `gui/501` 登录会话里），Keychain 行为与普通 shell **完全一致**：

| 环境 | `security` 写条目 | CLI 启动探针（SSH 判定 + default 存储） |
| --- | --- | --- |
| launchd Aqua 会话（默认 LaunchAgent）+ 真 HOME | 即时成功 | 通过，`--version` exit 0 |
| 同上 + 外来 HOME | **弹 SecurityAgent 确认框，无人应答就一直挂着**（8 s 采样被 kill） | 3 s 超时 → `Error: Your macOS login keychain is locked.` exit 1 |

- 弹框发生在 GUI 控制台（本机有登录会话时用户在屏幕上能看到；无 GUI 登录的 Mac 上则直接失败）。
- `LimitLoadToSessionType=Background` 的 agent 在新版 macOS 上无法 bootstrap（EIO），没有这个会话类型可测；SSH 环境变量路径与 ASSUME_SSH 路径实测行为相同。

### 18.7 D4：macOS 上的账号隔离

**事实**（macOS 新增的，其余同 §8.4）：

1. **SHELL 选择规则与 Linux 相同**【源码 darwin 包同一段代码 + 实测 `shell-wrapper-env`】：`$SHELL` 路径含 `bash` 就用它，否则从 PATH 找 bash；每条命令先 `-ilc` 快照环境再执行。
   macOS 实测（P0b 跟进，1 次 Auto prompt，11/11 断言）与 Linux 的 P0c 结果一致：
   - CLI 用 orbit-bash 跑登录快照和每条命令（darwin 无 strace，包装脚本自记日志证明 `-ilc` 和 `-c` 两条路径都经过它）；
   - agent 命令看到的 HOME 是包装还原的真 HOME，登录快照读的也是真 HOME 的 profile（真 HOME 的 `.bash_profile` 里 export 的变量出现，账号 HOME 的没有）；
   - 命令环境里**没有** `CURSOR_API_KEY`、`CURSOR_AUTH_TOKEN`、`CURSOR_CONFIG_DIR`、`CURSOR_DATA_DIR`、`XDG_CONFIG_HOME`；工作区变量照常可见；
   - CLI 自己仍跑在账号 HOME 上（`agent-cli-state.json` 写在账号 HOME）；真 HOME 里没有新增 `.cursor`、`.config/cursor`。
2. **方案 A 的「CLI 用账号 HOME」与默认 Keychain 存储冲突**：`/usr/bin/security` 按 HOME 解析钥匙串，账号 HOME 下保存凭据会弹框或挂起（§18.4；2026-10-25 用真实 key 重测仍是稳定挂起）。但这不影响 §16.3 的既定设计——契约本来就固定 `AGENT_CLI_CREDENTIAL_STORE=memory` 加注入 token/key，根本不碰 Keychain。
3. **Keychain 不能用于多账号隔离**（条目 per-user 全局，§18.4）。macOS 上三种凭据的落盘方案：
   - API key：`CURSOR_API_KEY` + memory 存储（同 Linux）。
   - 登录账号：登录进程用账号 HOME + `AGENT_CLI_CREDENTIAL_STORE=file`（token 落 `<账号 home>/.cursor/auth.json`，0600）；会话运行时读出 accessToken 以 `CURSOR_AUTH_TOKEN` + memory 注入（同 Linux §8.4）。
   - Default 账号同理。**macOS 布局与 §16.2 的差异只有一条：auth.json 跟随 HOME（`<账号>/home/.cursor/auth.json`），`xdg-config/` 在 macOS 上对 auth.json 无效。**
4. 命令环境继承同 Linux（§8.3；wrapper 生效性已实测，见上）。

**D4 结论（P0b 跟进实测，2026-10-25）**：**方案 A 在 macOS 上成立**。macOS runner 与 Linux 用同一套方案（账号 HOME + orbit-bash 包装还原真 HOME、会话 `memory` + 注入、登录进程 `file`）。
macOS runner 支持（2026-10-25）按这两条差异实现，其余与 Linux 相同（实现与用例见 §18.9）：
1. 登录进程的 `auth.json` 恒为 `<账号 home>/.cursor/auth.json`（0700/0600；`XDG_CONFIG_HOME`、`CURSOR_CONFIG_DIR` 对 macOS 的 auth.json 无效，§18.3）——读账号登录、过期判断的路径按平台取。
2. 任何路径都显式设 `AGENT_CLI_CREDENTIAL_STORE`（会话 `memory`、登录 `file`），绝不依赖 default（Keychain，§18.4）；default 存储还多一个把 token 放在 `security` 命令行 `-w` 参数上、同机同用户进程可见的风险点。

若某天 A 被推翻需要选 B（真 HOME），macOS 的副作用与 Linux 相同（写读真 `~/.cursor`），且同样别用 Keychain。

### 18.8 macOS 复现的核心场景

P0b（无需凭据，8/8）与 P0b 跟进（有效 key，12/12 场景通过）都已跑完，证据在目录同名 `scenarios/*.json`：

- P0b：initialize 与未登录握手（`signed-out-handshake` 12/12）、进程信号（`process-signals`）、调试日志（`debug-log-location`）、
  登录链接与未完成登录（`login-link-and-logout`，完整超时 §18.5）、失败形状（`failure-shapes-without-prompt`：无效 key 的 `-32603`/`agent models` 报错、
  坏 cli.json 启动即退、`--authless` 拒绝；断网项 Linux-only 跳过）、安装与版本（`install-and-version`）、quarantine（`macos-quarantine`）、
  launchd 里的 Keychain（`macos-launchd-keychain`）。
- P0b 跟进零 prompt（2026-10-25，所有者的 Premium key；`usage-api` 的录制里 `GetPlanInfo.planName=Premium`）：
  `credential-stores`（10/10：file 落 `$HOME/.cursor/auth.json` 且含 apiKey 字段、memory 不落盘、logout 语义同 Linux）、
  `directory-variables`（9/9：§18.3 的目录规则）、`api-key-session-management`（32/32）、`parameterized-model-picker`（7/7）、
  `usage-api`（5/5：用量与套餐读数同 Linux）、`team-pin`（4/4）、`mcp-and-hook-sources-at-startup`（8/8：MCP 源、注入服务器的环境、
  `agent mcp enable` 审批与 hooks 行为同 Linux，§6/§7）、`startup-processes-and-network`（12/12）、
  `macos-keychain-store`（13/13：三条目写入、条目名不变性、场景内清理，§18.4）。
- P0b 跟进真实 prompt（4 次 Auto，账本 p0bm 4/10）：
  `multi-turn-tools-default`（24/24，2 次：initialize → new → 两轮 prompt → load；read/execute/edit/fetch/MCP 各出现，权限请求、
  allow-always 落 cli-config、被拒 MCP 不执行、orbit MCP 的 `task_get`、load 重放与标题同 Linux）、
  `cancel-mid-tool`（5/5，1 次：`session/cancel` 3 ms 内回 `cancelled`，sleep 进程被杀、工具卡停在 in_progress）、
  `shell-wrapper-env`（11/11，1 次：D4 方案 A 的实测，§18.7）。

复现命令见 README；macOS 上的证据目录属于账本 `p0bm`（`prompts-ledger.json`），回放样本在 `CURSOR_P0_ROOT/macos-fixtures/`（不进仓库，P0b 约定）。

### 18.9 macOS runner 的实现【约定：macOS runner 支持 `34lk6zafdNyu67SiAD3q9`，2026-10-25】

按 §18.7 的结论实现，其余与 Linux 共用同一份代码。下面每条写明实现位置；用例都在 `src/runner-go/`，验收脚本 `scripts/test-cursor-macos-runner.mjs` 按名字跑。

- **固定版本**（`cursor_install.go` 的 `cursorArtifacts`）：darwin/arm64 用 `https://downloads.cursor.com/lab/2026.10.14-941492e/darwin/arm64/agent-cli-package.tar.gz`，
  178,006,204 字节，SHA-256 `c6d9e2ea…cc77`（P0b 的 `install-and-version`；2026-10-25 在 HPC 重新下载核对，大小和哈希一致）。
  Intel Mac（darwin/amd64）和 Linux arm64 没测过，照旧报 `CURSOR_PLATFORM_UNSUPPORTED`，不声明 `provider:cursor`。
  用例 `TestCursorPinnedBuildPerPlatform`、`TestCursorMacRunnerDeclaresCursor`。
- **解包**（`unpackCursorTarball`，与 Linux 同一段）：2026-10-25 列出官方 darwin tarball，`dist-package/` 下 452 个普通文件、125 个目录，没有链接和其他类型，
  权限只有 0644、0755，runner 原样接受。P0b 的 `install-and-version` 数的是 P0 自己解包出来的目录，记的是 450 个文件；差的两个没有追查。
  只有两个文件带扩展属性：tree-sitter-bash 的 linux-x64、win32-x64 预编译件，Apple 签名放在 `com.apple.cs.*` 扩展属性里。
  runner 的解包不还原扩展属性；这两个文件 macOS 从不加载，Mach-O 的签名嵌在文件里，逐字节写出就保留。
- **quarantine**（§18.2）：runner 用 Go 自己下载、解包，不经 LaunchServices，不会打 `com.apple.quarantine`；就算有，启动路径（脚本 + 签名的 node）也不受影响。
  真 CLI 工具在 Mac 上核对装出来的版本目录（`xattr -r`，见下）。
- **账号与能力**（`cursor_account_slot.go` 的 `cursorAccountsSupported`、`cursorAccountCapabilities`）：Linux 和 macOS 都声明
  `cursor-account-login/v1`、`cursor-account-remove/v1`，其他平台只有 Default（方案 D），拒绝的说明改成 "more accounts work on Linux and macOS runners for now"。
  控制面按 `cursor-account-login/v1` 派 Cursor CLI 的登录（`runners.service.ts` 的 `startLogin`，Default 的也一样），Web、Apple、Android 按同一能力显示 Add account，
  都不看平台，所以 macOS runner 从此能登录 Default，也能加账号。用例 `TestCursorAccountsAreKeptOnLinuxAndMacOS`。
- **登录的位置**（`cursor_health.go` 的 `cursorStoredLoginPath`）：macOS 是 `<账号>/home/.cursor/auth.json`，Linux 照旧 `<账号>/xdg-config/cursor/auth.json`。
  登录进程的环境两个平台一样（账号的 HOME、CURSOR_CONFIG_DIR、XDG_CONFIG_HOME，`file` 存储，`cursorLoginEnv`）；XDG_CONFIG_HOME 在 macOS 上对 auth.json 无效，留着无害。
  读登录的地方全经过它：登录结束后的核对（`cursorLoginOutcome`）、登录状态（`cursorSlotLoginStatus`）、会话借用（`cursorAccountLogin`、`cursorLaunchCredential`）、
  过期判断（同一个 300 s 规则）、额度（`cursorUsageRead.fetch`）、模型目录（`fetchCursorModelCatalog`）、健康检查（`cursorLoginState`）。移除删的是整个账号目录，登录随之删除。
  在 macOS 上，存在 Linux 位置的登录不算登录，反过来也一样。
  用例 `TestCursorMacSignInSavesUnderHome`、`TestCursorMacLoginStatusFollowsTheLayout`、`TestCursorMacSessionBorrowsItsAccountsLogin`、
  `TestCursorMacAccountRemoval`、`TestCursorMacUsageAndCatalogueReadTheHomeLogin`。
- **凭据存储**（§16.3）：每个启动 CLI 的地方都显式设 `AGENT_CLI_CREDENTIAL_STORE`，登录 `file`，其余 `memory`；手动登录的提示也带上 `file`，
  免得有人照着提示在 macOS 上把登录存进 Keychain。`TestCursorEveryCLIStartNamesItsCredentialStore` 分三部分：
  - 普查：从 runner 源码里找出所有启动 Cursor CLI 的地方（`cursorCLIStarts`：版本探测、`agent models`、模型目录、会话、`agent login`），名单对不上就失败；
  - linux、darwin 两个子用例：各自把每个启动点都跑一遍，核对每个进程的存储，确认假 CLI 在 macOS 模式下一次 Keychain 都没写过；
  - 反证：不设存储时，假 CLI 在 macOS 模式下确实会记一次 Keychain 写入。
- **每会话进程作用域**：macOS 退回进程组清理，理由见 §3.4。
- **orbit-bash**：同一个每会话包装（`writeCursorShellWrapper`）。`#!/bin/sh` 加 `exec /bin/bash`，macOS 自带两者（bash 3.2）。
  P0b 跟进用 P3 的包装实测了 `-ilc` 快照和每条命令（§18.7）；P4b 加的还原 `XDG_*` 等只是 POSIX 的 `unset`/`export`。
- **测试替身**：`useCursorPlatform(t, goos, arch)` 替换 runner 判断平台用的 `cursorOS`、`cursorArch`（安装哪个 tarball、保留账号、登录位置都看它们）。
  假 CLI 的 macOS 模式（`fakeCursorRelease.onMac`）照 §18.3、§18.4 落盘：`file` 存储写 `$HOME/.cursor/auth.json`（不管 XDG_CONFIG_HOME），编译缓存写 `$HOME/Library/Caches`，
  不设存储就当作写 Keychain，记进 `keychain.jsonl`。
- **真 CLI 工具**（`src/runner-go/cursor_accounts_real_test.go` 的 `TestCursorRealAccounts`，build tag `cursor_real`，Linux 和 macOS 都编译）：
  - 在测试自己的 Orbit home 里用 runner 的代码完成全部步骤：安装固定版本（从 downloads.cursor.com 下载）；用账号槽代码加两个账号；经登录中继各跑一次 `agent login`，
    把两个链接打印出来，等人分别用两个不同的 Cursor 账号登录；再经 `runCursorSession` 和桩控制面同时跑两个会话，各发一条 Auto prompt，发之前记账，上限 10 次。
  - 核对的项目：每个账号的 auth.json 只在自己的目录里（Orbit home 里没有别的登录，会话目录里也没有）；每个会话的 CLI 用的是自己账号的 token、memory 存储；
    Cursor 的 `GetMe`（额度接口的身份调用）对两个会话报出不同的用户，各自与账号登录的用户一致；两个会话确实同时在跑；
    runner 用户真实的 `~/.cursor`、`~/.config/cursor`、安装目录和编译缓存前后不变，macOS 上登录 Keychain 里 Cursor 的条目前后不变（只读属性，不读密码）；
    macOS 上装出来的版本目录没有 `com.apple.quarantine`。
  - 产出：`<OUT>/accounts/summary.json`，脱敏后写入，写之前确认里面没有 token、key、邮箱。
  - 跑法：`ORBIT_CURSOR_REAL_LEDGER=<账本> ORBIT_CURSOR_REAL_OUT=<目录> go test -tags cursor_real -count=1 -timeout 75m -run '^TestCursorRealAccounts$' -v .`。
  - 本任务只要求它在两个平台上编译、`go vet` 通过，没有实跑。Mac 上的实测由协调会话另开任务。

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
| [`p0c/`](evidence/cursor-cli/2026.10.14-941492e/p0c/README.md) | P0c：同样结构的场景结果、录制、`summary.json`、`prompts-ledger.json`（P0c 账本），以及 `analysis/turn-endings.json`、`analysis/usage-before-prompts.json` |
| [`src/runner-go/testdata/cursor/p0c/`](../src/runner-go/testdata/cursor/p0c/INDEX.md) | P0c 发真实 prompt 的场景的回放样本 |
| [`src/runner-go/testdata/cursor/p5c/`](../src/runner-go/testdata/cursor/p5c/README.md) | P5c：Orbit 的 runner 在真 CLI 上的 12 个场景（每个一份 `summary.json` 加双向录制）、恶意夹具仓库、手工构造的 `synthetic/` 样本、P5c 账本副本 |
| [`src/runner-go/testdata/cursor/p8/`](../src/runner-go/testdata/cursor/p8/README.md) | P8：Orbit 的 runner 在真 CLI 上用 strace 截下的线上录制 `key-allow-reject`，被拒的 shell 调用只有 `{status:"completed"}`（§5.2） |
| [`docs/evidence/cursor-cli/2026.10.16-e3cb207/p0c/`](evidence/cursor-cli/2026.10.16-e3cb207/p0c/README.md) | 新版 `2026.10.16-e3cb207` 的不花 prompt 场景，以及和固定版本的对比 `comparison.json`（§1.3） |
| [`evidence/cursor-cli/macos-2026.10.14-941492e/`](evidence/cursor-cli/macos-2026.10.14-941492e/) | P0b 及其跟进的 macOS 证据：自己的 `summary.json`、`scenarios/`、`protocol/`、`prompts-ledger.json`（账本 `p0bm`）、`login-timing/`、`probe/` |

复现命令见 [`scripts/cursor-p0/README.md`](../scripts/cursor-p0/README.md)。
