# 协调者提问卡：答完以后留下的记录 · 证据

任务 34ceRLXU8u4QA1DrQF74A；设计图 `docs/mocks/coordinator-question-answered/`（方案 A）；合同修订 14（§4.8、§5.2 R10、R12）。
图里的问题、选项和时间都是示意数据，照设计图那两问写：Asia/Shanghai，08:10 提问，08:29 答复（「文章重写」那一问是前一天 22:05 答的）。

## iOS（iPhone 模拟器）

用的是真实的 iOS 壳 `CompactShell` 和 OrbitApp 共享源码，只换了入口，指向一个假的控制面（probe 分支 `probe/coordinator-question-answered` 里的 `.cqa-probe/stub.py`），打开协调会话。XCUITest 每张图前都断言该出现的字，缺一个就算失败。

- 代码：本任务分支的 d6094e712；probe 提交：a3472edd9（分支 `probe/coordinator-question-answered`，不合入）；GitHub Actions run [37873022151](https://github.com/jianghailong-xy/orbit/actions/runs/37873022151)，结果在分支 `probe/coordinator-question-answered-results`
- 同一次 run：OrbitApp 在 macOS 上 `swift build` 通过，OrbitKit 在 macOS 上 `swift test` 通过，iOS app 的 Simulator build 通过；7 个 UI 测试全部通过。

| 图 | 对照设计 | 看什么 |
|---|---|---|
| `ios-01-two-answered.png` | `phone-new.png`、2-proposal 第一栏 | 两问答完：标题 Answered 和时间，问题开头两行（灰），蓝勾 + 选项名，按回答先后排 |
| `ios-02-sheet.png` | `phone-new-sheet.png` | 详情：FROM COORDINATOR、asked 08:10、问题全文按 Markdown 排；三个选项原样，Recommended 在推荐项上，选中项蓝勾淡蓝底；底栏 Answered by you · 08:29 / Delivered to the current coordinator |
| `ios-03-note.png`、`ios-03b-note-sheet.png` | 3 ①、`phone-new-sheet-note.png` | 选了一项还写了补充：卡上补充另起一行加引号；详情里补充放在选中项里，标 Your note |
| `ios-04-other.png`、`ios-04b-other-sheet.png` | 3 ② | 选 Other：卡上是原话加引号；详情里 Other 行打勾，下面是原话 |
| `ios-05-no-options.png`、`ios-05b-no-options-sheet.png` | 3 ③ | 没有选项的问题：原话加引号，不是当天答的带日期；详情里一个只读的 Your answer 框 |
| `ios-06-waiting.png`、`ios-06b-waiting-sheet.png` | 3 ④ | 答时没有协调者：卡上多一行橙字，详情底栏第二行同一句 |
| `ios-07-withdrawn.png`、`ios-07b-withdrawn-sheet.png` | 3 ⑤ | 撤回：标题 Withdrawn、灰色图标、The coordinator withdrew it 加理由；详情照样回放问题和选项，没有勾，底栏 Withdrawn by the coordinator · 08:40 |
| `ios-08-open-question.png` → `ios-08c-answered-sheet.png` → `ios-08d-answered-card.png` | 第 4 点「顶着」 | 在详情里选第二项按 Send answer：同一个 sheet 当场变成这条答复的记录，关掉后对话里是记录卡，提问卡没了 |
| `ios-09-after-relaunch.png` | 「重启后还在」 | 杀掉 app、清掉本地缓存再开：记录卡从服务端读回来，位置不变 |

## Web（协调会话）

vite 开发服务器跑本分支的 `src/web`，`/api` 指向一个假的控制面（同一套示意数据），headless Chrome，zh-CN、Asia/Shanghai，2560×1720（2x）。图已压成 256 色 PNG。

| 图 | 看什么 |
|---|---|
| `web-01-two-answered.png`、`web-01-two-answered-review.png` | 两张记录卡按回答先后画在两条消息之间；View details 打开的详情与 iOS 同一套字 |
| `web-03-note*.png` | 选项加补充：卡上补充另起一行；详情里 Your note 在选中项里 |
| `web-04-other*.png` | Other：原话加引号；详情里 Other 行打勾 |
| `web-05-no-options*.png` | 无选项：原话；详情里 Your answer 框；前一天答的带日期 |
| `web-06-waiting*.png` | 等下一个协调者：橙字一行，详情底栏同一句 |
| `web-07-withdrawn*.png` | 撤回：Withdrawn、灰色图标、理由；详情没有勾，底栏 Withdrawn by the coordinator |
| `web-08-open-question.png` → `web-08b-answered.png` → `web-09-after-reload.png` | 页面上按 Send answer：提问卡换成记录卡；刷新页面后记录还在原处 |

## 测试

- 服务端：`scripts/run-pg-spec.sh` 跑 `open-item-closed-questions.pg.spec.ts`（七种情形：只选选项、选项加补充、只写文字、无选项问题、答时没有协调者、撤回、排序与 50 条上限；8/8）和受影响的 `open-item-*.pg.spec.ts`、`blocking-request-replies.pg.spec.ts`，全部通过；同一个新 spec 放到 main 的代码上，七种情形全红（读口没有这一组）。apiserver 单测 4990/4990。
- OrbitKit：`swift test`（Linux，swift:6.1）3497 个，0 失败（5 个 PerfBaseline 照旧跳过）；`CoordinatorQuestionRecordTests` 覆盖卡上每一行、详情底栏、排序、解码和放置，`OwnerItemCardsTests` 把每一句和 web 的声明逐字对照。
- Web：全量 vitest 4824/4824；`CoordinatorQuestionCard.test.tsx`、`CoordinatorQuestionRecord.test.tsx` 覆盖各种结局、按回答时刻放置、按下 Send answer 到读口刷新之间用本机那份顶着。
