# 思考行折叠时，贴底的对话是否仍粘在末尾：验证记录

问题（任务 [34dznDCmmTw2dX5VecnNw](orbit-task:34dznDCmmTw2dX5VecnNw)）：iOS 原生应用里，流式思考行折叠成一行「Thought for …」时对话面板会跳，
甚至中途停在底部之外（「回到最新」圆盘出现）。静态已确认折叠本身是即时完成的（`.animation(nil)`，160pt 有上限的流式框 →
一行摘要，MessageBubbles.swift:347-427），且折叠永远发生在末尾行（kimi runner 自 3c77c9460 起在 tool_use 之前持久化
thinking，src/runner-go/kimi_stream_order_session_test.go）。待证据回答的开放问题：**读者完全不碰列表时，视图仍可能在
一次思考折叠的当口离开末尾吗？**

## 结论

**粘住。读者一次都不碰，三次连续思考折叠的每一帧，bottomGap 都是 0.0** —— iPhone 模拟器浅色与深色、Mac 窗口，全部如此。
回合结束后的静止状态也停在末尾：「回到最新」圆盘不存在，最后一行在渐隐之上（iOS：行底 711.9，列表底 739，渐隐从 719 开始；
Mac：561 / 588 / 568）。任务列的两个嫌疑都没有被帧数据支持：

- **(a) follow 的 `scrollTo(bottomID, anchor: .bottom)` 落在懒加载 List 估算的 contentSize 上、停在估算的末尾** ——
  未观察到。三次折叠、每次折叠后的 publish 都跟着 `followScrollTo bottom`，而它落点精确（gap=0），包括折叠 + 工具卡片
  落在同一次 200ms publish 的组合（fold 1）。ConsoleView.swift:652-654 记录的「停在估算末尾」是**输入框长高顶起视口**的
  场景（视口 resize），不是行折叠；本次探测里它没有发生。
- **(b) 折叠 + 追卡在同一次 200ms publish 的组合** —— 不是问题。fold 1 正是这个组合：内容 −122（折叠）再 −172（工具卡收合），
  两帧都是 gap=0。
- **帧数据给出的机制（c）是 clamp（钳制）**：内容在贴底的视图下变短时，scroll view 把 offset 钳到新的 maxOffset，offset 的
  下落量与内容的收缩量**逐帧严格相等**（下表每行的 Δoff ≡ Δcontent），gap 恒为 0。`TailPinning.pinned` 甚至没有被要求做过
  一次艰难判定 —— 折叠周围没有任何一帧 gap 超过 0.25pt 的 subpixel 阈值，`followsGeometry` 的重贴（follow=true）只在回合前的
  顶部条进场那几帧出现过。131fc2448 的静态结论（折叠不能把未触碰的列表取消贴底）在真机上得到帧级确认。

## 探测（`probe-harness/`，跑法见其中的 README）

桩 `stub.py` 先 serving 六轮已结束的对话（够长、贴底），随后由测试逐步（`POST /__step`）放出**一个脚本化的实时回合**：
user → 三段 thinking（每段 14 行，足以顶满 160pt 的流式框）依次折叠，中间两次工具调用（kimi 顺序：`thinking` 持久化在
`tool_use` 之前），最后正文与 turn_end。fold 1 是同-publish 变体（工具卡与折叠同一步发出，被客户端 200ms 合并成一次
publish）；fold 2、3 各自单独 publish，fold 3 之后只剩正文 —— 即症状报告的静止场景。`diag.py` 在构建前给
TranscriptView 装上逐帧记录：每次滚动几何变化（offset / contentHeight / insets / 可视带）、每次滚动相位跃迁、每次读数的
pin/follow 判定、每次 publish 与每次请求的滚动，全部以 `systemUptime` 打点 —— 与测试照片标记同一时钟。
`FoldShotTests` 从启动到回合结束**不滚动、不点击列表**：每段拍流式框顶满的时刻，每次折叠后立刻拍（+0s、+0.35s、落定）。
运行：[CI 38137833070](https://github.com/jianghailong-xy/orbit/actions/runs/38137833070)（macos-26，iPhone 17 Pro 模拟器 +
Mac 应用，树 = main@a5499eaf7 + bba5d7b34 之后）。`metrics/` 是原始日志，`shots/` 是关键照片，`analysis/` 是生成下表的脚本。

## iPhone（浅色）逐帧几何：三次折叠

每行是一次 `onScrollGeometryChange` 读数（`.onScrollPhaseChange` 全程 `idle`，`scrolling=false reader=false`，
`pinned=true` —— 见 metrics/ios-metrics.log）。折叠行 = 内容收缩的那几帧；Δoff ≡ Δcontent 就是 clamp。

**fold 1（折叠 + 工具卡同一次 publish）**，box 顶满时 content=1753.7 / off=1014.7 / gap=0：

| t（app 时钟） | off | content | gap |
| --- | --- | --- | --- |
| 953.687 | publish rev=9 → followScrollTo bottom | | |
| 953.786 | 1014.7 → 892.7（−122.0） | 1753.7 → 1631.7（−122.0） | **0.0** |
| 953.970 | 892.7 → 720.7（−172.0） | 1631.7 → 1459.7（−172.0） | **0.0** |
| 954.328 | 720.7 → 737.7（+17.0） | 1459.7 → 1476.7（+17.0） | **0.0** |

**fold 2（折叠单独 publish）**，box 顶满时 content=1653.3 / off=914.3 / gap=0：

| t | off | content | gap |
| --- | --- | --- | --- |
| 965.695 | 914.3 → 765.3（−149.0） | 1653.3 → 1504.3（−149.0） | **0.0** |
| 965.767 | 765.3 → 568.3（−197.0） | 1504.3 → 1307.3（−197.0） | **0.0** |

**fold 3（折叠单独 publish，其后只剩正文）**，box 顶满时 content=1528.0 / off=789.0 / gap=0：

| t | off | content | gap |
| --- | --- | --- | --- |
| 975.403 | 789.0 → 640.0（−149.0） | 1528.0 → 1379.0（−149.0） | **0.0** |
| 975.440 | 640.0 → 523.0（−117.0） | 1379.0 → 1262.0（−117.0） | **0.0** |

每段 box 在流式期间的每一次长高（+36/+52/+62/+114.7…）也同样是 Δoff ≡ Δcontent、gap=0 —— iOS 上 follow 的 scrollTo
与布局同帧生效。深色运行的三次折叠与浅色逐数字一致（1013.555/1013.723、1021.167/1021.313、1031.808/1031.867，
见 metrics/ios-metrics.log 与 analysis/folds_table.py 的输出）。

## Mac（顺带的，同一脚本）

折叠本身与 iOS 相同：每帧 Δoff ≡ Δcontent、gap=0（fold 1：1562→1396，−166 一步；fold 2：1607→1441；fold 3：1679→1513）。
两点差异，都不是折叠的问题：

- **流式增长滞后一帧**：正文/思考框长高的那一帧先报 content +40（gap=40），下一帧 offset 跟上（gap=0）—— 程序滚动
  晚一帧上报，TailPinning 注释里写过；40 ≤ 80 的余量，pin 不动，下一帧闭环。全部出现在流式阶段，不是折叠。
- **内容震荡是探针自己的产物**：fold 落定后日志里有 content −638/+638、−700/+700 的来回（offset 逐位跟随，gap 恒 0），
  时刻与测试的整树元素查询（`waitFoldCount`）对齐 —— XCUITest 的 `.any` 查询逼 Mac 的 NSTableView 把行高重新量了一遍。
  即便如此视图也没有离开末尾。

一个探针瑕疵要认：Mac 上 `waitFoldCount` 查的是 accessibility label，而 Mac 的静态文本词在 value 里 —— 三次折叠在 Mac 上
都被记成 "the fold never showed"（照片名 `-missing`），但几何日志和照片都证明折叠按时发生（`mac-3c-fold1-settled-light.png`
里就是折好的一行）。iOS 没有这个问题。

## 日志里仅有的非零 gap（都不是折叠）

- 回合开始前顶部「↑ Your question」条逐帧进场，把 offset 相对末尾推开 0.7–13pt：每一帧 `follow=true` +
  `repinAfterResize` 在 ~30ms 内闭环 —— 正是 tail-open 修复（merge 9d1a9f1c3，TailPinning.followsGeometry）覆盖的场景。
- Mac 流式阶段的一帧滞后（≤60，见上）。

## 边界

模拟器而非真机（但 clamp 是 UICollectionView 的布局行为，与硬件无关）；桩在 localhost（真网上的 delta 时序更乱，然而机制
是布局本地的：任何打开的 gap ≤200ms 后都有下一次 publish 的 follow；>80 或读者驱动的移动按设计不被拉回）。探测树含
9d1a9f1c3 之后的全部 main。

**答任务的开放问题**：无读者触摸时，视图不会在一次思考折叠的当口停在底部之外。如果真机上仍出现「中途停在底部之外 + 圆盘」，
原因应去别处找 —— 帧数据排除了 scrollTo 落在估算值上（a）与折叠+追卡同 publish（b）这两条路径；嫌疑剩下读者触摸以外的
视口变化（键盘、输入框）、或 `atBottom` 被其它路径翻成 false。
