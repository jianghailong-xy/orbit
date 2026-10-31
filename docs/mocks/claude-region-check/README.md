# Claude 地区检查 · 设计板（定稿）

所有者 2026-10-31：「Claude 在执行前判断下网络环境，识别到网络在受限区域需要触发拦截，拒绝执行，避免违反 Claude 的用户协议，请帮我设计方案和效果图」。

板子分四张（源文件 `01-board.html`）：

- [`01-design.png`](01-design.png)：依据、代码现状、怎么查谁来拦、判定举例、做不到的。
- [`02-web.png`](02-web.png)：Web 真实页面。
  - Machines & models 的 HPC 卡（今天 / 定稿）
  - 会话里被挂起的消息
  - 新建会话的提示和输入框的 Provider 菜单
- [`03-ios-terminal.png`](03-ios-terminal.png)：iPhone 会话页和机器页，`orbit doctor` 和 runner 日志。
- [`04-decisions.png`](04-decisions.png)：规则、已定、英文文案、改动范围。

界面文案全部英文，板上说明是中文。

## 已定（所有者 2026-10-31）

| 问题 | 定了 |
| --- | --- |
| ① 哪些回合要拦 | **只拦连到 Anthropic 的回合**：本机 Claude 登录、Anthropic key、Claude 池。Claude Code 接 DeepSeek / vLLM 等 key 的回合不查。 |
| ② 走代理怎么算 | **只看 Claude 的出口**。每次只发一个检查请求，走 Claude 访问 api.anthropic.com 时用的代理。 |
| ③ 查不到 | **沿用 24 小时内的结论，没有就按支持。** |
| ④ 跑到一半翻转 | **停掉**。连续两次判定后，停掉正在跑的、连 Anthropic 的 Claude 回合。 |
| ⑤ 没升级的旧 runner | **升级前不拦**。服务端不按心跳的来源地区兜底。 |
| ⑥ 其他引擎 | **只做 Claude。** |

按这些决定，第一版改过的地方：

- 会话的引擎建好就固定了，所以会话卡的主按钮是 `Use another provider`：同一个 Claude Code 换成 DeepSeek / vLLM 的 key。不是第一版的 `Use another engine`。
- Provider 菜单里只灰掉 Anthropic 的凭据。机器上还有别家的 key 时，新建会话的引擎列表里 Claude Code 不灰。
- 服务端只用 Cloudflare 的 `CF-IPCountry` / `cf-region-code`，不内置 GeoIP 库。没有 Cloudflare 的自建部署查不到，按 ③ 当作支持。

## 方案一句话

runner 在每个连 Anthropic 的 Claude 回合、每次 Claude 登录之前，走 Claude 用的代理请求一次 `GET /api/runner/region-check`。服务端按请求经 Cloudflare 带来的国家或地区，对照 `src/shared` 里的 Anthropic 支持名单判定。

不在名单上时：

- **runner**：这类回合不启动、不投递，不起 Claude 登录，也不读 Anthropic 用量。
- **服务端**：把这类会话挂在队列里，并写明原因。
- **客户端**：在会话卡、机器页和 Provider 菜单上说明原因，并给出路。

## 怎么做的

- **Web 帧是真实页面**：main `d6f363a6c` 的 `src/web` 和 `src/shared` 跑在 vite 上，接 `src/web/ui-migration` 的假 API，示例机群是 `../infrastructure-focus/capture/data.mjs`。
  - 原型补丁 [`prototype.patch`](prototype.patch) 渲染了三处：会话卡（`RunNeverStartedCard` 的新原因和三个按钮）、Provider 菜单和新建会话的提示（`sessionProviderChoices` 把 Anthropic 凭据标成 `Region not supported`，`NewSessionProviderHero` 的 Details）。
  - 补丁能直接 `git apply` 到 `d6f363a6c`，但只为出图，不是实现。地区结论在补丁里挂在 Claude 引擎的 health 上；实现时应该是 runner 级的字段。
  - 机器页、列表行和标题的状态词，是在真实页面上改字、改 class 做出来的（`capture/scenes.mjs` 里的 `inject*`）。
- **iPhone 帧是画的**：会话页照 `SessionRunStartCardView` 的结构画；机器页用 `../antigravity-accounts/kit.*`。
- **终端是画的**，格式照 `doctor.go` 的 `formatEngineLine` 和 `cmdDoctor`。

## 重新出图

kit 在 `/var/tmp/region-gate-mock/`，可能被清掉。重建办法：

1. `today/` 是 `git archive d6f363a6c src/web src/shared tsconfig.base.json package.json package-lock.json`，再加一份锁文件对得上的 `node_modules`（`cp -al`）。`new/` 是同样一棵树打上 `prototype.patch`。
2. 在每棵树里 `node_modules/.bin/tsc -p src/shared/tsconfig.json`，fixtures 要用 `src/shared/dist`。
3. 把 `../infrastructure-focus/capture/data.mjs` 拷成 `capture/data.mjs`，并把它的 `uuidToBase62` import 指到树里的 `src/shared/dist/index.js`。字体用 kit 的 `fonts.conf`（Inter、Noto Sans SC、JetBrains Mono）。
4. 截图：`unshare -n capture/run-ns.sh <tree> shoot.mjs <scene…>`。`mm-today` 跑在 `today` 上，其余（`mm-new`、`s-B`、`s-A`、`hero-new`、`prov-new`）跑在 `new` 上。
5. 裁图：用 PIL BOX 缩到显示宽度的 2 倍，放进 `shots/`。尺寸见 `01-board.html` 里各 `<img>` 的 width。
6. 出板：`FONTCONFIG_FILE=<fonts.conf> node capture/render-board.mjs 01-board.html . 2`。每个 `section.b-part` 出一张 PNG。

## 依据

- https://www.anthropic.com/supported-countries ："Any country or region not listed is unsupported."
- https://www.anthropic.com/legal/commercial-terms ：D.2（Supported Regions Policy）、M.8（出口管制）。
- https://code.claude.com/docs/en/legal-and-compliance ："Your use of Claude Code is subject to …"
- https://www.anthropic.com/news/updating-restrictions-of-sales-to-unsupported-regions （2025-09-05）

以上于 2026-10-31 抄录。
