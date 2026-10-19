# 落地会话的各入口（web）· 证据截图

任务 `34bVVGk4SrMknliGplqbJ`。画面是**这个工作树里真实构建的 web 控制台**（`vite build` 的 dist），
外壳用仓库自带的 `src/web/ui-migration` fixtures，本项目自己的读口按每一帧覆盖。时钟冻结在
**2026-10-19 15:02 Asia/Shanghai**（`docs/mocks/landing-session/v4/06` c 的那一分钟），时区 Asia/Shanghai。

跑法：`bash kit/run.sh`（脚本见本目录 `kit/capture.mjs`；`kit/run.sh` 先构建 dist，再在私有 netns 里
截图）。每帧的 DOM 读回（链接文字与 href、卡片文字、Landings 组的行）写在跑出来的 `report.json` 里。

## 逐项对照 v4 效果图

### 04 项目 sessions 页

| 帧 | 效果图 | 本分支画出的 |
| --- | --- | --- |
| `landing-card-one` | 04 b1 · 一个作业的 Landing 卡 | 卡底一行 `Open landing › … All jobs ›`；整张卡仍是作业清单的按压 |
| `landing-card-many` | 04 b2 · 两个作业 | 每个作业行尾一个 `Open landing ›`；`Merge to main` 行写它的词、不放链接；作业行与链接是卡按钮的**兄弟** |
| `jobs-sheet` | 04 a2 · 作业清单 | 每行一个 `Open landing ›`（在 Retry 下方），合入作业的行只有它；行本身照旧去任务 |
| `merge-check` | 04 b4 · 合入检查行 | 整行（`a.landing-head-press`）打开这一轮合入的落地会话；≥2 个作业时卡底 `+1 job queued … All jobs ›` |
| `merge-confirmed` | 04 c2 · CONFIRMED 排队 | `Details ›  Open landing › … Cancel`；合入作业的头同样进这一轮 |
| `merge-cancelling` | 04 c3 · 取消中 | `Cancelling the merge…`、`Stops at the runner's next report…`、`Cancel requested`（不可按）、`Open landing ›` |
| `merge-check-timeout` | 04 c5 · 检查超时 | 整张琥珀；`Re-run the check` + `Abandon`；整行仍进这一轮 |
| `merge-timed-out` | 04 c6 · 合入超时 | 整张琥珀；只有 `Abandon`；推送一句 `may have been pushed` |
| `landings-group` | 04 c1 · Landings 组 | 在 Coordinator 下面、Today 上面；等决定的行说结局和谁拿着（`Checks failed · with the coordinator`）；更早的折成 `Earlier · 5 landed · 1 nothing to land ›`；在途的与已合入的合入轮不列 |

### 06 列表 / 协调会话 / 任务页 / 写代码的会话

| 帧 | 效果图 | 本分支画出的 |
| --- | --- | --- |
| `chat-xe5` | 06 c · X-E5 的 owner 卡 | 标题 `Now yours — no report from the runner for 25m`；`Abandon` 是领头的实心门，每扇门下一行后果（J12：`Nothing was pushed`）；`Open landing` 是看的门 |
| `chat-delivery` | 06 b · 协调会话的转录卡 | `Open the task ↗`、**保留**的 `Open the failed session ↗`、后面新加 `Open the landing ↗` |
| `source-session` | 06 e · 写代码的会话底部 | 派生标签 `Landing · checking ›`（蓝），指向这个任务段的落地会话 |
| `task-page` | 06 d · 任务页的 Landing 段 | 段末一个 `Open landing ›`（任务读口只给最新一代，一个链接） |

对比要点（与效果图一致的取舍）：

- Landing 卡与 Work overview 卡**整张按压不变**（打开作业清单），清单行仍去任务；Open landing 是另写出来的字。
- 合入作业领头时 Landing 卡不画，排在后面的作业由合入卡的 `+N job queued · All jobs ›` 留住（`merge-check`）。
- `BLOCKED` 的合入卡不加入口（单测 `LandingJobsSheet.test.tsx` 断言，画面不另出帧）。
- 旧服务端（没有 `landingSessionId`）那一格写灰色 `No landing page on this server yet`，不可点（单测）。
- 检查超时那一句：作业清单里的推送句沿用 main 的规则——`CHECK_PROMOTION` 不写推送句（效果图 c5 写
  `a check pushes nothing`；本分支按已有的 `landingJobLines` 省略该句，其余一字不差）。

## 文件

- `kit/capture.mjs`：截图脚本（dist + fixtures + 本项目读口的覆盖）。
- `kit/run.sh`：构建并截图。
- `kit/check-swift-pins.py --against HEAD`：把 OrbitKit 五个 copy-parity 测试钉住的 web 字面量在
  工作树与 `HEAD`（项目线 tip）各扫一遍，比较两边找不到的集合——两边都是 9 个（多行 TSX、含转义引号
  的字面量超出这个粗糙读取器的能力），**没有一个钉住的字面量移动**；本任务的 Swift 一行未改。
- `web/`：13 帧 × 浅色/深色 = 26 张 PNG，以及截图时读回的 `report.json`（每帧的链接文字与 href、
  卡片文字、Landings 组的行、未处理的 fixture 请求）。
