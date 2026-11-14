# Machine page · CPU / memory / disk · 设计板

| 板 | 内容 |
| --- | --- |
| [`01.png`](01.png) | 今天 vs 方案：页头下加 Resources 一节（CPU / Memory / Disk 三张卡 + 最近一小时折线），Disk 从 Capacity 搬出 |
| [`02.png`](02.png) | 状态：占用高、离线、旧 runner、窄屏 |
| [`03.png`](03.png) | 规则、数据从哪来、待你定 1–5（推荐都是 A） |

## 怎么做的

- 所有帧都是 HEAD 5cc046b01 的 `src/web` 真实页面（`vite build` + `src/web/ui-migration` fixtures），方案部分由 [`capture/inject.mjs`](capture/inject.mjs) 注入原型 DOM；读数是假数据。
- 重拍：kit 在 `/mnt/data/tmp/runner-res-mock/`，`unshare -n ./run-ns.sh <dist> capture.mjs [today live warn offline old phone]`，`node render-board.mjs <board.html> <out>`。
- 机器名 studio、用户 Mia 都是虚构的。

## 已实现

[`implemented/`](implemented/)：实现后的真实页面（`capture/impl.mjs`，假的 `GET /runners/:id/resources`），在线、内存满、离线、旧 runner、窄屏五帧。
