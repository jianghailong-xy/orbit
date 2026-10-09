# 协调者停着时，证据卡排队等它 · Web（T2）证据

任务 [T2 Web：排队卡、原地展开判定、Sent to the coordinator](orbit-task:34cypw6DuqasugeIRwndb)，项目 [协调者停着时，证据卡排队等它](orbit-project:34cygPTQe5LPUT7tdUAzG)。设计图 `docs/mocks/evidence-waits-for-coordinator/`（`2-proposal.png`、`3-rules.png`，main c71302304）；线上契约与文案见项目作业指导。

## 截图怎么来的

真实页面：本分支 `src/web` 的 vite 开发服务器，`/api` 由仓库自带的 ui-migration REST 夹具（`src/web/ui-migration/fixtures.mjs`）应答，再叠上一个协调会话和它的 pending 读。Playwright 驱动 Chromium，1440×1120（2x），en-US、Asia/Shanghai，时钟冻结在夹具的 2026-09-28 20:00。脚本在 `rig/`（`unshare -n rig/run-ns.sh capture.mjs <输出目录>`，在私有网络命名空间里跑，免得 docker 网卡变动打断模块加载）。示意数据：项目 Orbit UI migration 的协调者 18:08 撞了 Claude 周额度（run FAILED，`retryAt` 排在 10-01 19:00），任务 Migrate shared controls 19:41 交了第 1 版证据；第三种状态里协调者已经回来，19:58 投给了它。

| 图 | 对照设计图 | 看什么 |
|---|---|---|
| `queued-light.png`、`queued-dark.png` | 2-proposal 第一栏，`phone-queued.png` | 灰卡画在原来证据卡的位置（对话末尾）：沙漏、`Waiting for the coordinator`，右边提交时间；任务标题；橙色停机行 `Coordinator paused · weekly limit · resets 10/1 07:00 PM`（原因取协调者会话自己的错误文本，和上面 Weekly limit reached 用同一个判断；时间取它的 `retryAt`）；灰字 `It goes to the coordinator when it’s back. You can still decide now.`；分隔线下 `Decide it myself ›`。会话头是 `Retrying`，没有 Waiting for approval；顶上没有 open question 条 |
| `opened-light.png`、`opened-dark.png` | 2-proposal 第二栏，`phone-sheet.png` | 点 Decide it myself 后原地展开成今天的证据卡：同一行数据，顶上橙框里先是停机行，下面 `It gets this when it’s back. Decide here only if you don’t want to wait.`，然后判据、缺口、检查、Confirm done 与 Chat about this（与今天一致）。它不占键盘：Confirm done 上没有 Enter 提示 |
| `sent-light.png`、`sent-dark.png` | 2-proposal 第三栏，`phone-back.png` | 协调者回来、这一版投出去以后，原来那张卡的位置收成一行 `→ Sent to the coordinator · 07:58 PM`（时间用回执的 `decisionReceiptTime`）；上面是投递消息，带 T1 加的那句 This revision was submitted at … while you were unavailable |

与设计图的出入：iPhone 的展开是弹出页，Web 按任务要求原地展开；设计图上胶囊带一个 `›`，Web 这一行不可点，所以没有画。

## 测试

都在本分支最终的工作树上跑（基线 364c424a8 加本任务的改动），作业号可在任务证据里核对：

- 截图：`bgj_ca78c7044ef7`，六张图，卡片完整落在视口里，页面没有未应答的 API 请求。
- 列出的 vitest 文件与 `src/web/src/copyLanguage.test.ts`：`bgj_49e305200019`，8 个文件 144 个用例通过。
- `npm test -w @orbit/web`：`bgj_bd097127b634`，380 个文件 4998 个用例通过。
- OrbitKit `swift test`（swift:6.1 docker，parity 测试读 Web 源码）：`bgj_31dd96d05a37`，基线与本分支都是 3588 个、0 失败。
- 新用例的反证：五处临时改坏（不按队列保留 Chat about this、展开卡占键盘、DecisionStrip 计入队列、页面不传会话、只排过队的版本留下旧卡），每处都有对应用例变红，改回后全绿。
