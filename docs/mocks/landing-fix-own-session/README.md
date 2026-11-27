# 落地：agent 动手，平台守门（2026-11-20）

契约修订 42（草稿）的效果图：`docs/project-integration-line-contract.md` §12，待 owner 裁决附录 A 的 Q30–Q37。目录名是第一部分起的，合并后没有改。

部件照 `../landing-session/v4/` 与 `../landings-one-window/`（main 上的落地窗口）。英文是上线文案，中文是说明；项目与任务名是示例数据。先只画了 iPhone；2026-11-22 补了 web（④，下表 04–06）。

| 图 | 内容 |
|---|---|
| `00-overview.png` | ⓪ 合起来的一张：一条任务从完成到落地，三处改动（落地失败先交写它的会话；落不落地由平台量、不贴标签；进项目分支前跑什么由协调者定）与两道不变的门 |
| `01-path.png` | ① 一次落地冲突走的路：现在（三个会话、两次裁决）与改后（一个会话、不重新裁决） |
| `02-iphone.png` | ② a 现在的落地窗口 · b 任务自己的会话里收到的卡 · c 落地窗口的 Fixing 状态与记录 · d 它修不了，交回协调会话 |
| `03-decisions.png` | ③ 待定的四条 |
| `04-web-session.png` | ④ web a · 任务自己的会话里收到的卡 |
| `05-web-landing.png` | ④ web b · 落地窗口 Fixing，两行新记录 · c · 交回协调会话，带它最后说的话与 `Returned to the coordinator: <reason>` |
| `06-web-project.png` | ④ web d · 项目页 Open items 的 `Being fixed by its session` · e · 任务行 `Landing · fixing` |

渲染：`board.html` 的每个 `section[data-png]` 用 playwright-core 与 chromium 截成 2x PNG，字体取自 `/var/tmp/landing-mock-render/fonts`。

## 裁决

2026-11-22（owner，12:03Z，经协调会话转达）：

| 图 | 文件 | 裁决 |
|---|---|---|
| iPhone a–d | `02-iphone.png` | **Approve as drawn** |
| web a–e | `04-web-session.png`、`05-web-landing.png`、`06-web-project.png` | **Approve as drawn** |

没有要改的地方；三端客户端照这些图做。
