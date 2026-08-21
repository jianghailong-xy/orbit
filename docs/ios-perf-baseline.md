# iOS 性能测量基线(2026-08-21)

这是 iOS 优化项目所有任务的**改前基线**。后续每个优化任务的"改后"数字都直接对比本文件对应小节,
并把新数字追加进各节的「历次测量」表,不要另起文件。

**先看这里 —— 本次基线的完整度:6 项里 4 项拿到了实测数字,2 项(冷启动墙钟耗时、设备 RSS)没有拿到,
原因是本次执行环境没有 Mac/Xcode/真机,详见 [§8 未测到的项与补测步骤](#8-未测到的项与补测步骤)。**
每一节都标了 `实测` / `未测` 以及数据来源,不要把两类数字混着引用。

---

## 1. 测量条件

### 1.1 客户端

| 项 | 值 | 来源 |
| --- | --- | --- |
| 客户端 | Orbit iOS,构建号 **1770**(旁证数据来自 1717) | UA `Orbit/1770 CFNetwork/3860.700.1 Darwin/25.6.0` |
| 系统 | Darwin 25.6.0(= iOS 26.x) | 同上 |
| **机型** | **未知** —— CFNetwork 的 UA 不含设备型号 | — |
| 归属判定 | 该客户端在启动第 0 秒发了 `POST /api/push/register`,而这个调用**只存在于 `src/ios/Sources/Push.swift`**(`enablePush()`),macOS 壳没有任何调用点 → 确认是 iOS 壳 | `grep enablePush\|push/register src/macos src/ios` |
| 观测窗口 | 2026-08-21 15:17:24–15:26:40 UTC(577 次请求),另有 13:44–15:20 的 2,383 次请求作旁证 | 网关访问日志 |

> **一个必须写清的边界**:macOS 壳和 iOS 壳共用 `AppModel`/`ConsoleModel` 的全部轮询代码,UA 字符串
> 形状也完全一样(`Orbit/<构建号> CFNetwork/... Darwin/...`),除 `push/register` 外**没有任何端点能区分两者**。
> 本文用的 1770 数据集之所以能确定是 iOS:它以 `push/register` 开头,且 15:17 之后再没有其它构建号在轮询。

### 1.2 账号规模(生产库实测)

| 项 | 值 |
| --- | --- |
| session 总数 | 3,730(未删除 3,713) |
| **Open 视图内的 session(主账号)** | **2,137**(全库 2,147,分属 2 个 owner) |
| run_event 总行数 | ≈ 3,764,414 |
| 最长会话 | 112,665 条可渲染事件 / maxSeq 122,819 / 127 MB payload |
| 基线取样会话 `01a00ea9-…` | 8,519 条可渲染事件 / maxSeq 66,103 / 10 MB payload |
| 附件 | 1,093 个(其中 image/png 990 个,合计 333 MB) |

取样会话的事件构成(决定了下面合成语料的比例):
`tool_result 3,933 · tool_use 3,933 · assistant 540 · user 57 · turn_end 56`,
单条 payload 字节数 p50/p90:`tool_result 1,045/5,191` · `tool_use 184/313` · `assistant 305/519`。
正文长度(全库 400 个会话取样,字符数 p50/p90/p99):
`assistant 43/104/831` · `thinking 57/871/4,803` · `user 701/1,587/2,849`。

### 1.3 服务端与链路

生产 orbitd.io → Cloudflare → nginx 网关(`gateway/nginx.conf`,`gzip on; gzip_comp_level 5`,
`application/json` 在压缩列表内;`text/event-stream` 故意不压)→ apiserver。
**下文所有"字节数"都是网关 `$body_bytes_sent`,即 gzip 之后的字节**,和设备实际下行量同量级
(CF 到设备那一跳会重新用 br/zstd 压)。解压后的 JSON 体积本次没有测(拿不到用户态 token,见 §8)。
已验证网关压缩确实生效:同一个 JS bundle 无压缩 1,874,604 B / gzip 572,612 B。

### 1.4 离线测量宿主(§5、§6、§7 的数字来自这里)

`AMD EPYC(8 vCPU)/ 24 GB / Linux 6.12 / docker swift:6.1`,跑 `src/macos/OrbitKit` 的
`PerfBaselineTests`(见 §7)。**这是 x86 服务器,不是 A 系列芯片:绝对耗时只能当量级和"改前/改后"的
同环境标尺,不能当作真机耗时。**字节数是编码结果,与平台无关,可直接引用。

---

## 2. 冷启动 —— `实测(仅网络部分)` / `未测(墙钟)`

**方法**:从网关访问日志取 iOS 客户端 1770 的启动瞬间(`POST /api/push/register` 即启动标记),
统计前 5 秒内的请求与下行字节。日志时间戳精度 1 秒,记的是请求**结束**时刻。

**结果:启动后 5 秒内 23 个请求、1,154,834 B(1.10 MB)下行。**

| 相对时刻 | 请求 | 下行 |
| --- | --- | --- |
| +0s | `/api/agents` `/api/providers`(304) `/api/runners` `/api/users/me` `POST /api/push/register` | 8,023 B |
| +1s | `/api/session-tags` · **`/api/sessions?view=open` ×2** | 754,443 B |
| +2s | `/api/agents` · **`/api/sessions?view=open`** · `/api/task-lists`(304) · `/api/tasks/page` ×2(304) · `/api/providers`(304) `/api/runners`(304) | 378,522 B |
| +3s | 恢复上次会话:`/api/sessions/:id` ×2 · `/approvals` · `/background` · `/turns`(304) | 12,571 B |
| +4s | 用户动作(`POST …/approvals/:id/decision`),已不属于启动 | 1,275 B |

要点(可直接作为「session 列表冷启动本地缓存」任务的靶子):

- **前 3 秒里 `?view=open` 被完整拉了 3 次**:376,806 + 376,990 + 376,982 = **1,130,778 B,占冷启动下行的 98%**。
- 第一份列表在 **+1s** 才落地;在此之前列表**没有任何本地数据可显示**(客户端不缓存列表)。
- `/api/sessions/:id` 这类小请求全程 ≤ 4 KB,和列表比可以忽略。

**未测**:进程启动 → 列表出现内容的墙钟耗时(需要真机 os_signpost),见 §8。
上面的 +1s 只是"最早不可能早于"的网络下界,不含 pre-main、SwiftUI 首帧和 377 KB 响应的解码时间。

---

## 3. 内存

### 3.1 空闲常驻内存 —— `未测`

需要真机 / 模拟器上的 Instruments Allocations。见 §8。

### 3.2 连续浏览 20 张以上图片附件 —— `实测(语料与解码体积)` / `未测(设备 RSS)`

**方法**:(a) 生产库里 990 个 PNG 附件的文件大小与像素尺寸(直接从 bytea 的 IHDR 头解出宽高);
(b) 读 `AttachmentImageStore` 的缓存策略;(c) 网关日志里真实的一次附件下载。

| 指标 | p50 | p90 | max |
| --- | --- | --- | --- |
| PNG 文件字节 | 184,630(180 KB) | 886,539(866 KB) | 2,743,477(2.6 MB) |
| 像素尺寸 | 1179 × 962 | — | — |
| **解码位图字节(W×H×4)** | **6,959,808(6.6 MB)** | **15,543,936(14.8 MB)** | **77,875,200(74 MB)** |

日志里一次真实的附件下载:`GET /api/attachments/34B0M80dV5DU3cFQpNxH9` → **1,167,739 B**。

`AttachmentImageStore`(`src/macos/OrbitApp/Sources/OrbitApp/AttachmentImageStore.swift:22`)是
`private var cache: [String: PlatformImage]`,**无容量上限、无 LRU、无内存告警清理**,生命周期跟着
`ConsoleRegistry`(每个实例一个)。因此浏览 N 张图后常驻的解码位图约为 N × 上表:

- **20 张 @ p50 ≈ 139 MB;20 张 @ p90 ≈ 311 MB。**

**未测**:真机上的实际 RSS 峰值与是否回落。上面是"解码位图字节 = 宽×高×4"的算术推论,依据是实测的像素
尺寸分布和"缓存永不淘汰"的代码事实,**不是设备读数**;UIKit 何时真正解码/丢弃位图必须在设备上确认。

### 3.3 依次打开 5 个以上长会话 —— `实测(Linux 代理值)` / `未测(设备 RSS)`

**方法**:在 Linux harness 里按 `ConsoleRegistry` 的 LRU 容量(默认 12,`ConsoleRegistry.swift:44`)
持有 12 个各 1,000 事件窗口的 `TranscriptReducer`,读 `/proc/self/VmRSS`;同时记录每个 reducer 编码成
JSON 的字节数(内存留存量的下界代理)。

| 阶段 | 累计 items | 快照编码字节 | VmRSS | Δ | 峰值 VmHWM |
| --- | --- | --- | --- | --- | --- |
| 基线 | 0 | 0 | 33.6 MB | — | 34.2 MB |
| 1 个 console | 528 | 779,311 | 38.4 MB | +4.8 MB | 39.7 MB |
| 5 个 console | 2,640 | 3,944,052 | 41.2 MB | +7.6 MB | 43.3 MB |
| 12 个 console(满) | 6,336 | 9,387,149 | 47.1 MB | +13.6 MB | 49.3 MB |
| 全部释放后 | 0 | — | **47.1 MB** | **+13.6 MB(未回落)** | 49.3 MB |

要点:

- 一个 528 item 的 console 窗口 ≈ **1.1 MB RSS / 0.78 MB 编码字节**;12 个满载 ≈ **13.6 MB**。
- 释放后 RSS **没有回落**(Linux 分配器保留;真机 malloc 行为不同,需设备复测)。
- `TranscriptReducer` 对 `state.items` **没有任何上限**(grep `prefix(|dropFirst|maxItems` 全无命中),
  所以一个从头看到尾的长会话,items 会一直涨到会话结束 —— 取样会话的 8,519 事件展开成 **4,490 items /
  6.8 MB 快照**(§5),那是单个 console 的量级,不是 12 个的总和。

---

## 4. 前台空闲网络 —— `实测`

**方法**:网关访问日志,按 UA 与真实客户端 IP 切出 iOS 客户端的请求流,取 120 秒窗口统计请求数、
按端点分组、下行字节合计。

### 4.1 轮询节奏与单次体积

| 指标 | 值 |
| --- | --- |
| `?view=open` 相邻两次间隔 | **中位 5 s**(均值 4.2 s,p90 5 s;= 代码里 4 s sleep + ~1 s 请求耗时) |
| `?view=open` 单次下行(gzip) | **中位 377,111 B**(min 23,240 / max 378,066;n=427) |
| 该端点返回 304 的次数 | **0 / 427** —— 列表轮询完全没有条件请求,每次都是全量 200 |
| 折算每个 session 行 | 377,111 / 2,137 ≈ **176 B(gzip 后)** |

对照:全数据集里 877 次请求命中 304(`/api/providers` `/api/task-lists` `/api/tasks/page`
`/api/sessions/:id/turns` 等都有 ETag),**唯独最大的那个端点没有**。

### 4.2 两个真实 120 秒窗口

窗口 A(前台,列表 + 一个 console 打开,无导航动作):**137 请求 / 9,749,275 B(9.30 MB)**

| 次数 | 下行 | 端点 |
| --- | --- | --- |
| 26 | 9,043,219 B | `/api/sessions?view=open` |
| 41 | 70,045 B | `/api/sessions/:id` |
| 11 | 20,223 B | `/api/sessions/:id/events?sinceSeq=N` |
| 9 | 36,981 B | `/api/runners` |
| 12 / 12 / 8 | ≈ 1 KB | `/approvals` `/turns` `/background`(基本 304) |
| 9 | 0 B | `/api/providers`(全 304) |
| 2+2+2 | 22,000 B | `/api/agents` `/api/task-lists` `/api/tasks/page` |
| 1 | 555,876 B | `/api/sessions?view=completed` |

窗口 B(启动后头 120 秒,含用户操作与一次图片加载):**187 请求 / 14,602,536 B(13.9 MB)**,
其中 `?view=open` 35 次 = 13,187,641 B,`/api/attachments/:id` 1 次 = 1,167,739 B。

**结论:前台停在列表上,2 分钟稳定消耗 ≈ 130–190 个请求、9–14 MB 下行,其中 90%+ 是 `?view=open`。**

### 4.3 请求来自哪些循环(代码定位)

| 端点 | 循环 | 位置 |
| --- | --- | --- |
| `/api/sessions?view=open` | `AppModel.startPolling` 4 s 心跳(同时 flush 焦点 console 到磁盘) | `AppModel.swift:444`,sleep 在 `:461` |
| `/api/sessions/:id` | 同一个 tick 里的 `refreshFocusedSessionDetailIfNeeded()` | `AppModel.swift:672` |
| `/api/runners` `/api/providers` | 焦点 console 刷新时顺带拉的 runner/provider 快照 | `ConsoleModel.swift:738`、`:757` |
| `/api/tasks/page` `/api/task-lists` | TasksView 的**两个独立**循环(忙 5 s / 闲 15 s) | `TasksView.swift:314`(列表)、`:328`(导航) |
| `/api/sessions?view=completed` 等 | AgentsView 的 Completed/Trash 4 s 循环(Open 已并入共享快照) | `AgentsView.swift:206` |

---

## 5. 后台网络 —— `未测(需真机)`,以下为代码事实 + 日志旁证

**代码事实**(可直接引用):

- `src/ios/Sources/OrbitiOSApp.swift:51` 的 `scenePhase` 处理里,`.background` 分支**只做**
  `model.consoleRegistry?.persistAll()`,**没有**取消/暂停 `pollTask`、TasksView 的两个循环、
  AgentsView 的循环,也没有断开控制面 SSE。
- `src/ios/Support/Info.plist` 的 `UIBackgroundModes` **只有 `remote-notification`**,没有 background
  fetch/processing。所以进入后台后进程通常在数秒内被系统挂起,循环随之冻结 —— 也就是说"2 分钟内还发不发请求"
  取决于系统何时挂起、以及期间有没有 APNs 静默推送把 app 唤醒(唤醒后循环会立刻再跑,每跑一 tick 就是一次
  377 KB 的全量列表拉取)。

**日志旁证**(不足以定论):iOS 1770 那 9 分钟里出现过 26 s / 35 s / 44 s 的**完全静默**(期间零请求),
之后又恢复 5 s 节奏 —— 与"被挂起再被唤醒"一致,但日志无法证明静默的原因就是切后台,apiserver 也没有
推送发送日志可供对时。**必须在真机上按 §8 的步骤复测。**

---

## 6. 存储写放大 —— `实测`

**方法**:`PerfBaselineTests.testSnapshotWriteAmplification`。按 §1.2 的真实事件比例与 payload 尺寸分布
合成 N 条事件喂进 `TranscriptReducer`,再走真正的 `FileTranscriptStore.save`(即 `ConsoleRegistry.persist`
调用的那一个),计时并 stat 文件。两种形状:`opened` = 一次 `applyTailPage`(打开会话的路径),
`watched` = 逐条 `apply`(盯着会话跑的路径)。中位数取 5 次。

| 事件数 | items | 快照文件字节 | 编码 ms | save ms | load ms | `seen` 占比 |
| --- | --- | --- | --- | --- | --- | --- |
| 200(= 一页 tail) | 106 | **157,280** | 3.3–3.8 | 8.3–11.3 | 5.9–6.6 | 693 B(0.4%) |
| 1,000 | 528 | **808,924** | 16.4–18.2 | 28.7–28.9 | 31.0–32.6 | 3,894 B(0.5%) |
| 2,000 | 1,055 | **1,618,908** | 34.9–38.1 | 51.1–53.6 | 59.9–70.3 | 8,894 B(0.5%) |
| **8,519(取样长会话全量)** | **4,490** | **6,806,406** | **149–165** | **169–201** | **253** | 41,489 B(0.6%) |

写入节奏:`ConsoleRegistry.persist` 只在 `maxSeq` 前进时写(`ConsoleRegistry.swift:194` 的
`savedSeq` 短路),但**会话流式输出时每个 4 s tick 都满足这个条件**,所以:

- 打开一个 tail 页的会话流式跑着:157 KB × 15 次/分 ≈ **2.3 MB/分钟**;
- 一个已经看了 8,519 事件的长会话流式跑着:**6.8 MB × 15 次/分 ≈ 102 MB/分钟**,
  且每次编码在 x86 上要 150 ms(`Task.detached(priority: .utility)`,不占主线程,但占 CPU 和闪存写)。

**一个会改变后续任务优先级的发现:`seen` 集合只占快照的 0.4–0.6%。**
`TranscriptReducer.seen: Set<Int>` 确实无上界,但它是每个 seq 一个整数(≈ 5 B),而 items 是全文;
即使是全库最长的会话(122,819 seq),`seen` 也只有 ~700 KB,而它的 items 会是几十 MB。
「给 seen 设上界」对**写放大**的收益很小,真正的写放大来源是 **items 无上限**。

---

## 7. 流式渲染主线程成本 —— `实测(Linux 代理值)` / `未测(真机 Time Profiler)`

**方法**:`PerfBaselineTests.testStreamingTurnMainThreadCost` / `testRowsBuild` / `testMarkdownParse`。
模拟一个已经装着 1,000 事件窗口的 console 接收 200 个 `text_delta`,对每个 delta 依次执行
`reducer.apply` → `TranscriptRows.build`(SwiftUI body 求值会做的事)→
`splitStreamingMarkdown` + `parseMarkdownBlocks`(`StreamingProse` 会做的事),分别累计耗时。

**一个流式 turn(200 个 delta,窗口 529 items)总计 278.1 ms:**

| 阶段 | 耗时 | 占比 |
| --- | --- | --- |
| `TranscriptRows.build` | **251.5 ms** | **90.4%** |
| markdown(split + parse) | 24.4 ms | 8.8% |
| `TranscriptReducer.apply` | 2.1 ms | 0.8% |
| **每个 delta** | **1.39 ms** | — |

`TranscriptRows.build` 随窗口线性增长(每次都全量重建 + 一次 `Set<String>` 去重 + `groupToolRuns`):

| 窗口 | items | rows | build 耗时 |
| --- | --- | --- | --- |
| 200 事件 | 106 | 28 | 0.26 ms |
| 1,000 事件 | 528 | 125 | 1.22 ms |
| 2,000 事件 | 1,055 | 247 | 2.44 ms |
| 8,519 事件 | 4,490 | 1,039 | **13.63 ms** |

markdown 侧:518 条消息 / 98,799 字符 → 1,843 个 block,合计 **112.4 ms**
(**217 µs/条**,**1.14 ms / 千字符**);`splitStreamingMarkdown` 对一个 4,000 字符的未完成块单次
**0.614 ms**,而它**每个 delta 都要跑一遍整块**。

含义:在 x86 上一个 delta 就要 1.39 ms,4,490 items 的长会话里单次 rows 重建就 13.6 ms
(> 60 fps 的 16.7 ms 预算的 80%)。真机 CPU 更慢,**这就是流式时掉帧的主因,且瓶颈在 rows 重建而不是
markdown 解析**。真机 Time Profiler 的主线程占比仍需按 §8 复测确认。

---

## 8. 未测到的项与补测步骤

本次执行环境是 Linux 服务器(无 Mac / 无 Xcode / 无真机 / 无 Instruments),下面 3 件事必须在 Mac 上补,
补完直接回填本文件对应小节:

1. **冷启动墙钟(§2)**。`cd src/ios && xcodegen generate`,在 `OrbitiOSApp.init` 和
   `AppModel.applySessionSnapshot` 首次调用处各打一个 `os_signpost`(或最简单:`CFAbsoluteTimeGetCurrent()`
   打点 + `print`),已登录状态杀进程冷启 5 次,记录中位数。要分别记「进程启动→首帧」和「首帧→列表有内容」。
2. **内存 RSS(§3.1 / §3.2 / §3.3)**。Instruments → Allocations,三个场景:静置 60 s;连续滑过 ≥20 张
   图片附件;依次打开 ≥5 个 >1000 条消息的会话。每个场景记 persistent bytes 峰值 + 退出场景 60 s 后是否回落。
3. **后台网络(§5)**。设备连 Charles/Proxyman(或 macOS 上开 `rvictl` 抓包),切后台后计时 2 分钟,
   记录是否还有请求、分别是哪些端点、以及请求是否与 APNs 推送到达时刻对齐。

另外两个本次拿不到、但不阻塞优化的数据:

- **`?view=open` 解压后的 JSON 体积**(影响设备端 JSONDecoder 的 CPU 与内存峰值):需要一个用户态 token
  直接 `curl -H 'Accept-Encoding: identity'` 打一次。本次没有用户 token,只测到 gzip 后的 377 KB。
- **机型**:UA 不含型号,补测时顺手记一下。

---

## 9. 怎么复现 §3.3 / §6 / §7 的数字

harness 是 `src/macos/OrbitKit/Tests/OrbitKitTests/PerfBaselineTests.swift`,**默认跳过**,
只有 `ORBIT_PERF=1` 时才跑,所以 CI 不会为它付钱:

```bash
docker run --rm -e ORBIT_PERF=1 -v "$PWD:/src" -w /src/src/macos/OrbitKit swift:6.1 \
  swift test --filter PerfBaselineTests 2>&1 | grep 'PERF|'
```

语料是**种子固定的合成数据**,按 §1.2 的真实事件比例和 payload 尺寸分布生成(只有词是编的,形状和尺寸是
实测的),所以同一台机器上两次跑结果一致,可以直接做改前/改后对比。**对比时务必用同一台机器**——
本文的绝对值来自 §1.4 那台 x86。

§2 / §4 / §5 的网络数字来自生产网关访问日志(`docker logs orbit-gateway`),按 UA `Orbit/1770` 过滤;
该日志随容器重启滚动,本次窗口是 2026-08-21 13:44–15:26 UTC。要重测得在窗口还在时抓。

---

## 10. 给后续任务的靶子速查

| 任务 | 改前基线 | 出处 |
| --- | --- | --- |
| AttachmentImageStore 改有界缓存 | 缓存无上限;单张解码位图 p50 6.6 MB / p90 14.8 MB;20 张 ≈ 139–311 MB | §3.2 |
| 图片缩略图降采样 | 源图 p50 1179×962 / 180 KB 文件;一次真实下载 1.17 MB | §3.2 |
| 收紧常驻 console 数 / items 上限 | 12 console × 528 items = +13.6 MB RSS;items 无上限,长会话单个 4,490 items | §3.3、§6 |
| session 列表冷启动本地缓存 | 冷启前 3 s 拉 3 次 `?view=open` = 1.13 MB,占冷启动下行 98%;首份列表 +1s 才到 | §2 |
| 后台暂停轮询 | `.background` 只 persist,不停任何循环;`UIBackgroundModes` 只有 remote-notification | §5 |
| 降低 4 s 全量列表轮询成本 | 单次 377 KB(gzip)、0/427 命中 304、2 分钟 26–35 次 = 9–13 MB | §4 |
| 合并 TasksView 两个轮询 | 两个独立循环,忙 5 s / 闲 15 s;2 分钟各 2 次,≈ 22 KB | §4.3 |
| 减少 transcript 快照写放大 | 长会话单次 save 6.8 MB / 编码 150 ms;流式时 ≈ 102 MB/分钟 | §6 |
| 给 seen 设上界 | **只占快照 0.4–0.6%(41 KB / 6.8 MB)—— 优先级应下调** | §6 |
| 避免 rows 每次 body 全量重建 | 流式 turn 里占 90.4%(251.5/278.1 ms);4,490 items 单次 13.63 ms | §7 |
| markdown 解析缓存改 LRU | 217 µs/条、1.14 ms/千字符;流式时占 8.8%;split 每 delta 0.614 ms | §7 |
