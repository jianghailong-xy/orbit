# Settings → Machines → ＋ · 设计板

| 板 | 内容 |
| --- | --- |
| [`01.png`](01.png) | 今天：老用户（T1–T3）和新用户（N1–N3）点 ＋ 都会离开 Settings；首次登录的欢迎卡是对的 |
| [`02.png`](02.png) | 方案：`/settings/machines/new` 在 Settings 右栏打开注册指引；首次登录不变（P1–P6） |
| [`03.png`](03.png) | 待定 A/B（推荐都是 A）、不变的、落地 |

## 怎么做的

- 所有帧都是 HEAD 87c394579 的 `src/web` 真实页面（`vite build` + `src/web/ui-migration` fixtures + [`capture/`](capture/)）；方案帧来自打了 [`prototype.patch`](prototype.patch) 的同一棵树。
- 重拍：kit 在 `/mnt/data/tmp/machines-add-mock/`（`today/`、`proto/` 树，`dist-*`），`unshare -n ./run-ns.sh <dist> capture.mjs <today|proto> [scene…]`，`node render-board.mjs <board.html> <out>`。
- 示例用户 “Mia Chen” 和机器名都是虚构的。
