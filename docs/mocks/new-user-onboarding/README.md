# 新用户第一次登录的引导 · 设计板

| 板 | 内容 |
| --- | --- |
| [`01.png`](01.png) | 今天：开了托管 runner（A1–A3）和没开（B1–B2）两条路的真实页面，问题归纳 |
| [`02.png`](02.png) | 方案：新会话页里的一张欢迎卡，三步（电脑 → 模型 → 第一条消息），P1 托管 / P2 就绪 / P3 自己的电脑 |
| [`03.png`](03.png) | 待定 A/B（推荐都是 A）、规则、落地分期 |

## 怎么做的

- 所有帧都是 HEAD 7cce83664 的 `src/web` 真实页面（vite + `src/web/ui-migration` fixtures + [`capture/data.mjs`](capture/data.mjs)）。托管 runner 的状态取自 `src/shared/src/managed-runner-states.fixture.json`。
- 方案帧（`p-*`）是在同一页面上用 DOM 注入欢迎卡（[`capture/proposal.mjs`](capture/proposal.mjs)），只用已上线的 `.msc` / `.rsi` 类名，外加少量 `ob-*` 样式（示例按钮、命令框）。
- 重拍：kit 在 `/var/tmp/onboard-mock/`（`today/` 树，`node_modules` 用 `cp -al`），`unshare -n ./run-ns.sh <tree> capture.mjs` 和 `… proposal.mjs`；`node render-board.mjs board.html <out>` 出 01–03。
- 示例用户 “Mia Chen” 和示例消息都是虚构的。
