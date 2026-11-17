# 条件触发 · 设计板

满足外部条件时开始的工作：Task 的 **Starts when**（只触发一次）和定时任务的 **When** 规则（每次越线触发一次）。起因是 HPC 上的一次 Ceph 会话：“等第三个 OSD 再改 3 副本”今天只能记进 Agent 的私有备忘。

已定（2026-11-17）：一个条件概念挂在 Task 和定时任务两处；触发后先提方案、批准再动手；先做 runner 上的轮询探针，外部事件推送放后面。P1–P4 同日都按 A 定了。设计文档：[`docs/condition-triggers-design.md`](../../condition-triggers-design.md)。

| 图 | 内容 |
| --- | --- |
| [`01-board.png`](01-board.png) | 整板 |
| [`01-board-1.png`](01-board-1.png) | ① 今天 ② Task 的创建卡（Starts when）③ 定时任务的创建卡（When 规则） |
| [`01-board-2.png`](01-board-2.png) | ④ Scheduled 页的“等条件”分组 ⑤ 触发后先提方案 ⑥ 读不到数、详情里的 Condition 块 |
| [`01-board-3.png`](01-board-3.png) | 模型、已定（含 P1–P4）、落地顺序 |

## 怎么做的

- 手绘 HTML（`01-board.html`），iOS 为准；样式取自 [`../scheduled-tasks/02-agent-first.html`](../scheduled-tasks/02-agent-first.html)，新增的类都带 `ct-` 前缀。
- 渲染：[`render.mjs`](render.mjs)，`node render.mjs "$PWD/01-board.html" "$PWD"`。它写整板和三张分图，并打印手机框里被横向截断的文字（应为 `[]`）。字体靠 `FONTCONFIG_FILE`（Inter、Noto Sans SC、JetBrains Mono）。
- 界面文案英文，注释中文；读数、时间、快照数量都是演示数据。
