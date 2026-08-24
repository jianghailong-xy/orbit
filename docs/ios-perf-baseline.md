# iOS 性能测量基线(2026-08-21,模拟器补测 2026-08-22)

这是 iOS 优化项目所有任务的**改前基线**。后续每个优化任务的"改后"数字都直接对比本文件对应小节,
并把新数字追加进各节的「历次测量」表,不要另起文件。

**先看这里 —— 本次基线的完整度:6 项全部拿到了实测数字。** 第一轮(08-21,Linux 服务器)拿到了 4 项:
网络流量来自生产网关访问日志,存储/渲染来自在 docker 里真跑 OrbitKit 的 harness。第二轮(08-22,Mac mini
的 iOS 模拟器)补齐了剩下的 2 项(冷启动墙钟、进程内存),并顺带把 `?view=open` 的解压体积测了出来。
**仍然缺的只有真机数字**(jetsam 行为、A 系列芯片的绝对耗时、真机 APNs 唤醒),见
[§8 仍未测到的项](#8-仍未测到的项与补测步骤)。

每一节都标了 `实测(生产日志)` / `实测(Linux harness)` / `实测(模拟器)` / `未测` 以及数据来源。
**模拟器数字有它自己的可信边界,见 §1.5「模拟器测量宿主」,引用前先读那一节** —— 内存绝对值和冷启动绝对耗时都不能当真机结论。

---

## 1. 测量条件

### 1.1 客户端

| 项 | 值 | 来源 |
| --- | --- | --- |
| 客户端 | Orbit iOS,构建号 **1770**(旁证数据来自 1717) | UA `Orbit/1770 CFNetwork/3860.700.1 Darwin/25.6.0` |
| 系统 | Darwin 25.6.0(= iOS 26.x) | 同上 |
| **机型(生产日志那一侧)** | **未知** —— CFNetwork 的 UA 不含设备型号,只能确定 Darwin 25.6.0 | — |
| **机型(08-22 补测那一侧)** | **iPhone 17 Pro 模拟器 / iOS 26.5(23F77)** —— 见 §1.5 | `xcrun simctl list devices` |
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
**§2 / §4 里出自网关日志的"字节数"都是 `$body_bytes_sent`,即 gzip 之后的字节**,和设备实际下行量同量级
(CF 到设备那一跳会重新用 br/zstd 压)。已验证网关压缩确实生效:同一个 JS bundle 无压缩 1,874,604 B /
gzip 572,612 B。

**解压后的体积已在 08-22 测出(模拟器,`URLSessionTaskMetrics` 的
`countOfResponseBodyBytesReceived` / `…AfterDecoding`,即客户端自己看到的线上字节 vs 交给
`JSONDecoder` 的字节)**:

| 端点 | 线上(gzip) | 解压后 | 膨胀 |
| --- | --- | --- | --- |
| **`/api/sessions?view=open`(2,136 行)** | **376,862 – 377,445 B** | **4,598,365 B(4.39 MiB)** | **×12.2** |
| `/api/tasks/page?limit=200&status=RUNNABLE` | 16,814 B | 295,081 B | ×17.6 |
| `/api/task-lists` | 6,088 B | 64,611 B | ×10.6 |
| `/api/runners` | 6,180 B | 26,118 B | ×4.2 |
| `/api/agents` | 1,537 B | 7,248 B | ×4.7 |

两点:

- 客户端量到的 gzip 体积(376.9–377.4 KB)和 §4.1 里网关日志的中位 377,111 B **对得上**,两套互相独立的
  测量方法得出同一个数 —— 网关日志那批数字可以放心引用。
- 但**设备端真正要解析的是 4.39 MiB,不是 377 KB**。折合每个 session 行 **2,153 B 解压后**
  (对比 gzip 后的 176 B)。这才是 `JSONDecoder` 的 CPU 和内存峰值面对的量,冷启动 3 秒内要吃三遍(§2)。

### 1.4 离线测量宿主(§3.3 的 Linux 代理值、§6、§7 的数字来自这里)

`AMD EPYC(8 vCPU)/ 24 GB / Linux 6.12 / docker swift:6.1`,跑 `src/macos/OrbitKit` 的
`PerfBaselineTests`(见 §7)。**这是 x86 服务器,不是 A 系列芯片:绝对耗时只能当量级和"改前/改后"的
同环境标尺,不能当作真机耗时。**字节数是编码结果,与平台无关,可直接引用。

### 1.5 模拟器测量宿主(§2 / §3 / §5 的模拟器数字来自这里)

| 项 | 值 |
| --- | --- |
| 宿主 | Mac mini,Apple 芯片 `arm64 T8112`,macOS 26.6.2(25G83) |
| 工具链 | Xcode 26.6(17F113);`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`(该机 `xcode-select` 指向 CommandLineTools) |
| **模拟器机型** | **iPhone 17 Pro / iOS 26.5(23F77)**,UDID `5DC6920A-2A6D-45BA-84E4-EAAD1A637CD6` |
| 构建 | Debug,`xcodebuild -scheme Orbit -destination 'platform=iOS Simulator,name=iPhone 17 Pro'` |
| 账号 | 生产 orbitd.io,已登录,Open 视图 **2,136** 个 session(和 §1.2 的 2,137 一致) |
| 测量日期 | 2026-08-22 |

> **为什么不是 iPhone 16**:这台机器上装的 runtime 只有 iOS 17.0 和 iOS 26.5,可用机型是 iPhone 15 Pro /
> 15 Pro Max(17.0)与 iPhone 17 Pro / 17 Pro Max(26.5)。选 iPhone 17 Pro 是为了对齐生产日志里那台真机的
> 系统版本(Darwin 25.6.0 = iOS 26.x)。重测时如果换了机型/系统,**必须在表里注明**,否则内存和耗时不可比。

**模拟器数字能证明什么、不能证明什么**(项目 instructions 的口径,这里落到具体数字上):

| 本文里的数字 | 可信度 |
| --- | --- |
| 请求条数 / 时序 / 端点 / 线上与解压字节数(§1.3、§2、§5) | **可信**,是行为事实,与芯片无关 |
| "3 次 `?view=open`"的调用来源(§2) | **可信**,是代码路径事实 |
| 后台是否还发请求、轮询循环有没有被取消(§5) | **可信**(但见 §5 里关于"模拟器会挂起"的更正) |
| 每张图涨多少内存、缓存清掉后是否回落(§3.2) | **相对量可信**(增量 ≈ 解码位图,行为可复现);**绝对值不可当真机结论** |
| 常驻内存绝对值(§3.1、§3.3) | **不可信为真机值** —— 模拟器没有 jetsam,不会因超标被杀,分配器行为也不同 |
| 冷启动墙钟(§2) | **不可信为真机值** —— 模拟器跑在 Mac 的 CPU 上,远快于真机;只能当"改前/改后同环境标尺" |

内存读数用的是 **`task_vm_info.phys_footprint`**(Xcode 内存计和 jetsam 用的就是它),不是 `resident_size`:
模拟器进程的 RSS 里混着大量与宿主共享的框架页(实测 RSS 300–550 MB 而 footprint 只有 45–330 MB),
拿 RSS 当 iOS 常驻内存会高估两三倍。**本文所有"内存"都是 footprint。**

---

## 2. 冷启动 —— `实测(生产日志:网络)` + `实测(模拟器:墙钟 + 3 次重复拉取的成因)`

### 2.0 墙钟耗时(模拟器,5 次冷启动取中位数)

**方法**:已登录状态下 `simctl terminate` 杀进程 → `simctl launch`,每次采 5 个时间点,重复 5 次。
时间原点是**进程 fork**(`sysctl KERN_PROC` 读 `kinfo_proc.kp_proc.p_starttime`),所以包含 dyld / pre-main,
不是 `main()` 之后才开始算。"首帧"用 `CADisplayLink` 的第一次回调(渲染服务真的出了一帧),
不用 `CATransaction` 完成回调 —— SwiftUI 会在同一次 commit 里把它覆盖掉,实测拿不到。

| 段 | **中位数** | 5 次实测 |
| --- | --- | --- |
| 进程 fork → `OrbitiOSApp.init` | 286 ms | 277 / 279 / 286 / 286 / 292 |
| **进程 fork → 首帧** | **572 ms** | 559 / 566 / 572 / 586 / 846 |
| **首帧 → 列表有内容** | **2,225 ms** | 1,634 / 1,780 / 2,225 / 2,430 / 3,817 |
| └ 其中:首帧 → 快照进 model | 2,115 ms | 1,437 / 1,459 / 2,115 / 2,273 / 3,668 |
| └ 其中:快照进 model → 列表那一帧上屏 | 157 ms | 109 / 148 / 157 / 197 / 321 |
| **进程 fork → 列表有内容(合计)** | **2,790 ms** | 2,207 / 2,626 / 2,790 / 2,989 / 4,402 |

**这就是「session 列表冷启动本地缓存」那个任务的靶子:首帧之后还有 2.2 秒的空列表。**
这 2.2 秒里 95% 是等第一份 `?view=open` 回来 + 解析它(见下),渲染本身只占 157 ms。
**注意这是模拟器耗时,真机会更慢(尤其解析 4.39 MiB JSON 那一段),但"空列表 ≈ 2 秒"这个结构性结论成立。**

> 冷启动缓存能改善的是「首帧 → 列表有内容」这 2,225 ms,**不是**前面那 572 ms —— 那段是 dyld + SwiftUI 起首帧,
> 和列表数据无关,改缓存动不了它。

### 2.1 冷启动网络

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

**08-22 在模拟器上用客户端自己的 `URLSessionTaskMetrics` 复测了同一件事,两套方法互相印证:**

| 前 5 秒 | 生产网关日志(08-21) | 模拟器客户端侧(08-22) |
| --- | --- | --- |
| 响应数 | 23 | 17 |
| 线上字节(gzip) | 1,154,834 B | **1,161,864 B** |
| `?view=open` 次数 | **3** | **3** |
| `?view=open` 线上字节 | 1,130,778 B(98%) | **1,131,212 B(97.4%)** |
| **`?view=open` 解压后字节** | 未测 | **13,795,095 B = 13.16 MiB(占解压总量 97.2%)** |
| 解压后总下行 | 未测 | **14,188,164 B = 13.53 MiB** |

**冷启动真正的代价不是 1.1 MB,是 13.2 MiB 的 JSON 要被 `JSONDecoder` 走三遍。**

### 2.2 为什么 `?view=open` 在冷启动前 3 秒被拉了 3 次

08-21 的文档只记录了"是 3 次",没解释成因。08-22 在每个调用点打点跑了 5 次冷启动,结论是
**三个互相不知道对方存在的调用方,在登录后 0.5 秒内各发了一次,而 `loadSessions()` 没有任何在途去重**:

| # | 调用方 | 代码位置 | 中位触发时刻 |
| --- | --- | --- | --- |
| 1 | `AppModel.startPolling()` 的**第一个 tick**(循环体先 `loadSessions()` 再 sleep 4s) | `AppModel.swift:444`,fetch 在 `:453` | +660 ms |
| 2 | 控制面 SSE 连上后的 snapshot 重建:`runControlPlane()` 的 `case .connected` | `AppModel.swift:505` | +690 ms |
| 3 | `AgentsView` 进入时的首次列表加载 `AgentsModel.loadSessions(view: .open, reset: true)` | `AgentsView.swift:202` → `AgentsModel.swift:187` | +850 ms |

一次实测(run 2)的完整时序:

```
+636.7ms  loadSessions<-pollTick
+697.4ms  loadSessions<-controlPlane.connected
+815.6ms  listSessions<-AgentsModel view=open reset=true
+1947.0ms GET /api/sessions?view=open  200  4,595,933 B  (耗时 1309.7 ms)
+2109.3ms GET /api/sessions?view=open  200  4,595,933 B  (耗时 1411.1 ms)
+2111.1ms GET /api/sessions?view=open  200  4,595,933 B  (耗时 1294.4 ms)
```

三个请求的**耗时区间完全重叠** —— 它们是并发在途的,不是一个接一个重试。5 次冷启动全部复现,次数稳定为 3。

**这本身就是两个独立的 bug,不只是"冷启动慢":**

1. **`AppModel.loadSessions()` 没有在途去重(单飞)。** 三个调用方同时进来就是三个整包请求 + 三次
   4.39 MiB 的 JSON 解析 + 三次 `applySessionSnapshot`。这一条在**稳态**下同样成立:控制面事件驱动的
   `scheduleControlRefresh()`(500 ms 合并窗口,`AppModel.swift:653`)只在自己内部合并,和 4 秒 tick 之间
   不合并 —— 两者撞上就又是两份。
2. **`AgentsView` 那次 `.open` 拉取是纯多余的。** 该视图的 4 秒轮询循环已经为 `.open` 关掉了
   (`guard view != .open else { return }`,`AgentsView.swift:203`),理由正是"Open 由 `AppModel` 的共享
   快照供给"。但 `guard` 在 `await agents.loadSessions(…, reset: true)` **之后**,所以它只跳过了循环,
   没跳过首次那一发 —— 拉回来的是和 `AppModel` 手上一模一样的整包,narrow 完就丢。

对应的修法归属:第 1 条 → 「session 列表冷启动本地缓存」/「给 `?view=open` 加条件请求(ETag)」;
第 2 条 → 「合并 TasksView 的两个独立轮询」那一类清理(或单独一条),改动只有把那个 `guard` 提到 fetch 之前。
**只要去掉多余的 2 次,冷启动解压下行就从 13.2 MiB 掉到 4.4 MiB。**

---

## 3. 内存

> **本节所有内存都是 `phys_footprint`,来自模拟器,见 §1.5。** 绝对值不代表真机(没有 jetsam,分配器不同),
> 但"涨多少 / 涨完回不回落 / 是谁在持有"这三件事是行为事实,可以直接引用。

### 3.1 空闲常驻内存 —— `实测(模拟器)`

**方法**:冷启动进列表页,不做任何操作,1 Hz 采 `phys_footprint`,共 130 s。

| 时刻 | footprint |
| --- | --- |
| +0.6 s(`App.init`) | 13.9 MB |
| +4.7 s(列表已上屏) | 45.3 MB |
| +30 s | 44.5 MB |
| +60 s | **52.3 MB** |
| +120 s | 52.3 MB |
| 峰值(全程) | **53.8 MB**(t=54 s) |

要点:

- **静置 2 分钟不是稳态,是缓慢上台阶**:44.5 MB → 52.3 MB(+7.8 MB),之后在 50.6–53.6 MB 之间震荡。
  原因不是泄漏,是那个 4 秒 tick:每 ~5 秒解析一次 4.39 MiB 的 `?view=open`(§1.3),
  临时对象的分配/回收把 footprint 顶在一个更高的平台上。**「降低 4 s 全量列表轮询成本」会直接压掉这一段。**
- 同一时刻的 `resident_size` 是 300–310 MB —— 这就是为什么本文不用 RSS,见 §1.5。

### 3.2 连续浏览 20 张以上图片附件 —— `实测(语料与解码体积)` + `实测(模拟器内存,见 3.2.1)`

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

#### 3.2.1 实机验证(模拟器,24 张真实生产图片)—— `实测`

上面 139–311 MB 是算术推论。08-22 在模拟器上把它跑成了实测,**结论:推论成立,而且偏保守。**

**方法**:遍历账号里 2,320 个 session 的事件页(每个 session 取最早 200 条 + 最新 200 条),收集 user turn 上
`mime` 为 `image/*` 的真实附件;凑够 24 个就停止扫描(实际收到 27 个,渲染前 24 个)。然后依次走
**出货路径**(`AttachmentImageStore.load(id)` → `UIImage(data:)` → 交给一个 UIImageView 渲染出一帧)。关键设计:**同一时刻只挂 1 个 image view**,上一张渲染完就 `host.image = nil` 把"行"回收掉 ——
这样 footprint 的增长**只可能**来自 `AttachmentImageStore.cache`,不可能来自还活着的视图。
渲染完全部 24 张后静置 60 s,再调一次 `cache.removeAll()` 观察是否回落。

| 阶段 | footprint | 相对基线 |
| --- | --- | --- |
| 基线(列表页,尚未加载任何图) | 59.1 MB | — |
| 渲染完 **20 张** | 252.8 MB | **+193.7 MB** |
| 渲染完 **24 张** | **317.6 MB** | **+258.5 MB** |
| 全部视图回收后静置 60 s | 317.9 MB | **+258.8 MB(一点没回落)** |
| **`cache.removeAll()` 后 10 s** | **59.9 MB** | **+0.8 MB** |

逐张的增量(节选,`Δ` 是这一张带来的 footprint 增长,`W×H×4` 是解码位图的算术值):

| # | 像素 | W×H×4 | 实测 Δ | Δ / 算术值 |
| --- | --- | --- | --- | --- |
| 0 | 3200×2400 | 29.30 MB | 54.11 MB | 1.85 |
| 2 | 3346×800 | 10.21 MB | 10.52 MB | 1.03 |
| 5 | 1256×524 | 2.51 MB | 2.56 MB | 1.02 |
| 6 | 898×102 | 0.35 MB | 0.34 MB | 0.98 |
| 8 | 3442×396 | 5.20 MB | 5.20 MB | 1.00 |
| 17 | 1179×2556 | 11.50 MB | 12.23 MB | 1.06 |
| 18 | 1179×2556 | 11.50 MB | 11.94 MB | 1.04 |
| 20 | 1179×2556 | 11.50 MB | 12.42 MB | 1.08 |
| 22 | 1179×2556 | 11.50 MB | 11.84 MB | 1.03 |
| 23 | 1179×2556 | 11.50 MB | 12.33 MB | 1.07 |
| **24 张合计** | — | **179.7 MB** | **258.5 MB** | **1.44** |

**UIKit 实际的解码/驻留行为,和推算是否一致:**

1. **一致 —— 一张图的常驻成本就是它的解码位图,不是文件大小。** 中等尺寸那批的实测增量和 `W×H×4`
   吻合到 ±8%(1179×2556 的 iPhone 截屏反复出现 5 次,每次都是 11.8–12.4 MB,而文件只有一两百 KB)。
   "缩略图只显示 300×360 所以只占 300×360×4" 是错的:CoreAnimation 解的是全分辨率位图再缩放。
2. **一致 —— 永不淘汰。** 视图回收掉、静置 60 s,footprint 一个字节都没还回来。
   模拟器上也**没有**收到过内存警告(没有 jetsam),`AttachmentImageStore` 本身也没有
   `didReceiveMemoryWarning` 的清理路径(`AttachmentImageStore.swift:22` 就是一个裸 `Dictionary`)。
3. **是缓存在持有,不是 UIKit。** `cache.removeAll()` 之后 10 秒内 footprint 从 317.6 MB 掉回 59.9 MB,
   **99.7% 的增长被收回**。这条直接证明「AttachmentImageStore 改为有界图片缓存」这个任务改对了地方 ——
   给它一个上限,内存立刻就回来了。
4. **推算偏保守,实测更差(1.44×)。** 总增长比 `Σ W×H×4` 高 44%。大图尤其明显(3200×2400 那张
   29.3 MB 的位图带来 54.1 MB)。多出来的部分是解码时的临时缓冲、CG 的页对齐,以及 `UIImage` 还攥着的原始
   编码数据。所以**「20 张 ≈ 139–311 MB」这个区间是对的:实测 20 张 = +193.7 MB,落在 p50 估计(139 MB)和
   p90 估计(311 MB)之间。**

**仍未测(需要真机)**:真机 malloc/CA 的行为差异、内存警告下 UIKit 会不会主动丢弃位图(模拟器没有 jetsam,
触发不了),以及到底在多少 MB 上会被系统杀掉。见 §8。

> **口径提醒**:扫描是**凑够 24 张就停**的,不是全量遍历,所以"这个账号一共有几张图"本文没有回答。
> 顺带一个观察:前 1,400 个 session 只翻出 10 张,说明 user turn 上的图片附件分布很不均匀 ——
> §1.2 里"990 个 PNG / 333 MB"是整库 attachments 表的口径,包含另一个 owner 的、以及挂在长会话中段
> (超出首/尾 200 条窗口)的,两个数字不该直接相减。

### 3.3 依次打开 5 个以上长会话 —— `实测(Linux 代理值)` + `实测(模拟器内存,见 3.3.1)`

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
- 测量当时 `TranscriptReducer` 对 `state.items` **没有任何上限**(grep `prefix(|dropFirst|maxItems`
  全无命中),所以一个从头看到尾的长会话,items 会一直涨到会话结束 —— 取样会话的 8,519 事件展开成
  **4,490 items / 6.8 MB 快照**(§6),那是单个 console 的量级,不是 12 个的总和。
  **这一条已在 2026-08-24 修掉(`TranscriptReducer.trimOlder`,见 §3.3.2 / §6.1 / §7.1);上表的数字保留
  为改前基线。**

#### 3.3.1 实机验证(模拟器,依次打开 6 个最长的会话)—— `实测`

**方法**:先用 `eventPage(tail: 1)` 对 600 个 open session 各发一个最小请求,读回那一条事件的 `seq`
即该会话的 maxSeq;取最长的 6 个,用 `AppModel.route(to: .session(id))` 依次打开,每个停 12 秒让 tail 页
落地、reducer 展开、List 渲染完,再读 footprint。全部看完后退回列表,再观察 60 秒。

选中的 6 个会话 maxSeq:**128,969 / 66,103 / 38,760 / 36,191 / 30,997 / 28,844**
(第二个就是 §1.2 的取样会话 `01a00ea9-…`;全部远超"1000 条消息"的门槛)。

| 阶段 | footprint | 相对基线 |
| --- | --- | --- |
| 基线(列表页) | 49.9 MB | — |
| 打开第 1 个(maxSeq 128,969) | 86.0 MB | +36.2 MB |
| 打开第 2 个(66,103) | 96.5 MB | **+46.7 MB(峰值)** |
| 打开第 3 个(38,760) | 91.5 MB | +41.6 MB |
| 打开第 4 个(36,191) | 93.0 MB | +43.2 MB |
| 打开第 5 个(30,997) | 96.4 MB | +46.6 MB |
| 打开第 6 个(28,844) | 90.1 MB | +40.3 MB |
| 退回列表后 60 s | **92.0 MB** | **+42.2 MB(没有回落)** |

要点 —— **这里有一个对 Linux 代理值的重要修正**:

- **内存不随打开的会话数线性增长,第 2 个之后就到平台了(+40 ~ +47 MB 上下震荡)。**
  原因是打开一个会话只拉 **tail 200 条**(`ConsoleModel.swift:204` 的 `tailPage = 200`),
  不是整个 12 万条历史。所以"打开 5 个长会话"本身不是内存杀手。
- **真正让 items 无上限增长的是另外两种用法**:①盯着一个会话看它一直流式输出;②在长会话里往上翻页
  (`olderPage = 200` 一次次追加)。§6 里那个 8,519 事件 / 4,490 items / 6.8 MB 快照就是①的结果。
  「给 transcript items 设内存窗口上限」瞄的应该是这两条路径,**用"依次打开 5 个会话"来验收它是测不出来的**。
- 退出全部 console 后 60 秒内存**没有回落** —— 符合设计(`ConsoleRegistry` 的 LRU 容量 12,
  `ConsoleRegistry.swift:44`,6 个远没到淘汰线),但也意味着**离开会话不还内存**。
- Linux 代理值(12 console × 528 items = +13.6 MB)和这里的 6 个真实会话 ≈ +40 MB 不矛盾:
  前者只算 `TranscriptReducer` 的数据结构,后者还含 SwiftUI/UIKit 的行视图、attributed string、
  markdown 解析缓存等渲染侧开销。**两个数字口径不同,不要互相换算。**

#### 3.3.2 改后:窗口上限在模拟器上跑真实会话(2026-08-24)—— `实测`

**方法**:临时 `ORBIT_PERF=1` 打点(§9.1 的做法,测完已撤),在 iPhone 17 Pro 模拟器上对真实服务器的
最长 open 会话(`348bAdea2ysfIq6ZWEQv2`,maxSeq 66,103)走完整链路:打开 → 连续向上翻 14 页 →
回到 tail(触发裁剪)→ 再翻回去。

| 阶段 | items | oldestSeq | footprint |
| --- | --- | --- | --- |
| 打开(tail 200) | 94 | 63,843 | 69.4 MB |
| 向上翻 8 页 | 801 | 51,865 | 75.3 MB |
| 向上翻 14 页 | **1,321** | 44,164 | 78.0 MB |
| **回到 tail(裁剪)** | **1,000** | **48,231** | 77.5 MB |
| 再翻回被裁的那一段 | 1,349 | 43,949 | 77.7 MB |

**结论:`holes=0 dup_seqs=0 dup_ids=0 ordered=true`** —— 被裁掉的 seq 一条不少地翻了回来,没有重复气泡,
顺序正确。这是这个改动最关键的一条验收(空洞/重复是它唯一的致命失败模式)。

两点要如实说明:

- **footprint 几乎没动**(78.0 → 77.5 MB)。这与 §3.3.1 的结论一致:模拟器上的常驻大头是渲染侧
  (行视图、attributed string、markdown 缓存),`TranscriptReducer` 的数据结构只是其中一小块。
  **上限的收益主要在 §6(写放大)和 §7(主线程),内存是第三位的。** 真机 malloc 行为不同,仍需复测。
- **`ConsoleRegistry` 的 capacity 保持 12,没有改**。理由:§3.3.1 已经证明"打开 N 个会话"不线性涨内存
  (打开只拉 tail 200 条,第 2 个之后就到平台);上限落地后单个 console 的常驻量还多了一个天花板
  (≤ 1,200 items),12 个满载的最坏情况因此是**有界**的,而在此之前它是无界的。
  capacity 不是驱动因素,改它只会让会话切换更常走磁盘重水化 —— **为改而改**。

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

## 5. 后台网络 —— `实测(模拟器)` + 代码事实

### 5.0 实测:切后台后 2 分钟的网络(模拟器)

**方法**:冷启动进列表页,跑 20 秒确认 4 秒轮询正常在跑,然后用
`xcrun simctl launch <dev> com.apple.mobilesafari` 把 Safari 拉到前台(这会让 Orbit 走完整的
`.inactive → .background`),计时 2 分钟。所有请求由客户端自己在 `APIClient` 的出口打点记录,
同时有一个 1 Hz 的内存采样线程作为"进程还活着没有"的心跳。

**结果:后台 2 分钟内 0 个请求。** 完整时序(单位:进程启动后的秒):

```
 +21.1s  loadSessions<-pollTick            ← 前台最后一个 tick 发起
 +21.4s  scenePhase=background
 +21.8s  GET /api/sessions?view=open  200  4,597,979 B   ← 切后台前就在途的那一发,回来了
 +21.5s  最后一条 1 Hz 心跳
 ────────  此后 151.8 秒:零请求、零心跳、零日志 ────────
+180.3s  loadSessions<-pollTick            ← 回前台,进程解冻
+180.4s  scenePhase=inactive
+180.7s  scenePhase=active
```

**这个结果必须配着下面这条更正读,否则会得出错误结论:**

> **更正一条常见假设:iOS 26.5 的模拟器和真机一样会真正挂起后台 app,它不是一个"进程一直跑着"的环境。**
> 证据是那个 1 Hz 内存采样线程 —— 它只做 `Thread.sleep(1.0)` + 写一行文件,不碰网络、不依赖任何
> 系统服务,**它也停了 151.8 秒**。同期 `ps` 显示进程还在(`STAT Ss`),RunningBoard 里也还挂着
> `UIKitApplication:io.orbitd.app`,回前台后状态完好 —— 所以是被 SIGSTOP 冻住,不是被杀。
> 冻结发生在 `.background` 之后 **0.4–1.4 秒内**。
>
> 也就是说:**"后台 0 请求"这个观测,证明的是系统把进程冻住了,不能拿来证明"代码停了轮询"。**

### 5.1 那代码到底停没停轮询?—— 没停,而且有实测证据

两条独立证据:

1. **代码事实**:`.background` 分支只做 `persistAll()`(见 5.2),`pollTask` 从头到尾没有被 cancel。
2. **实测证据**:回前台的那一刻,`loadSessions<-pollTick` 在 **+180.3s** 打点,
   **早于** `scenePhase=inactive`(+180.4s)和 `.active`(+180.7s)。
   说明那个 4 秒循环里的 `Task.sleep` 一直挂在那儿等,进程一解冻它立刻就到期开跑 —— 循环是**被冻住的,
   不是被取消的**。如果代码真的在 `.background` 里停了轮询,解冻后第一个动作只可能来自 `.active` 分支
   的 `kickControlPlane()`,不可能是 pollTick。

**推论(这才是「app 进入后台时暂停所有轮询循环」那个任务真正要修的东西)**:
系统的挂起只是"恰好替代码收了场"。任何一次进程没被挂起的窗口 —— 后台音频/定位等其他 background mode、
静默推送唤醒、系统给的宽限期、以及**回前台的瞬间** —— 循环都会立刻按原节奏跑,一跑就是一次 4.39 MiB
的整包列表。实测的回前台代价:

| 回前台后 | 请求 |
| --- | --- |
| +0.0 ~ +3.3 s | **`?view=open` ×2**(pollTick 一次 + `controlPlane.connected` 一次)= **9.2 MiB 解压后** |
| 同窗口 | `/api/agents` `/api/runners` `/api/providers` `/api/task-lists` `/api/tasks/page` ×2 |

### 5.2 APNs 唤醒(模拟器实测,但有口径限制)

用 `xcrun simctl push` 在后台第 30 秒发了一个 `content-available: 1` 的静默推送,第 60 秒发了一个带
alert 的推送。**两者都没有把进程唤醒**:整个约 100 秒窗口里 perf 日志一行没多,进程始终冻结。

**这条不能当真机结论**:模拟器的 APNs 是本地模拟的,`simctl push` 走的不是真 APNs 通道,
唤醒策略(尤其是 `content-available` 的后台唤醒配额)在真机上由系统另行决定。
真机上"静默推送会不会把轮询唤醒、唤醒一次是不是就是一次 4.39 MiB"仍然**未测**,见 §8。

### 5.3 代码事实(与上面互相印证)

**代码事实**(可直接引用):

- `src/ios/Sources/OrbitiOSApp.swift:51` 的 `scenePhase` 处理里,`.background` 分支**只做**
  `model.consoleRegistry?.persistAll()`,**没有**取消/暂停 `pollTask`、TasksView 的两个循环、
  AgentsView 的循环,也没有断开控制面 SSE。
- `src/ios/Support/Info.plist` 的 `UIBackgroundModes` **只有 `remote-notification`**,没有 background
  fetch/processing。所以 app 没有申请任何后台执行权,进入后台后由 RunningBoard 直接挂起
  ——§5.0 实测到的挂起延迟是 `.background` 之后 **0.4–1.4 秒**。
  "2 分钟内还发不发请求"因此取决于系统何时挂起、以及期间有没有 APNs 静默推送把 app 唤醒
  (唤醒后循环会立刻再跑,每跑一 tick 就是一次 **4.39 MiB 解压后 / 377 KB 线上**的全量列表拉取)。

**日志旁证**:iOS 1770 那 9 分钟里出现过 26 s / 35 s / 44 s 的**完全静默**(期间零请求),
之后又恢复 5 s 节奏 —— 现在可以和 §5.0 的实测对上了:这正是"切后台被冻住 → 回前台立刻恢复 4 秒节奏"的形状。
(日志本身仍不能证明静默的原因就是切后台,但模拟器实测给出了同样的时序特征。)

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

**追加参考:同一个 harness 在 Mac mini 上原生跑一遍(2026-08-22,`swift test`,arm64,见 §1.5)。
上面那张表是基线,不要用下面的数字替换它 —— 改前/改后必须同机对比(§9)。**

| 事件数 | 快照文件字节(Linux) | 快照文件字节(**Mac**) | 编码 ms(Linux) | 编码 ms(**Mac**) | save ms(Mac) | load ms(Mac) |
| --- | --- | --- | --- | --- | --- | --- |
| 200 | 157,280 | **157,280**(相同) | 3.3–3.8 | **1.0** | 1.4 | 3.6 |
| 1,000 | 808,924 | **808,924**(相同) | 16.4–18.2 | **5.0** | 5.6 | 17.5 |
| 2,000 | 1,618,908 | **1,618,908**(相同) | 34.9–38.1 | **10.0** | 11.0 | 34.5 |
| 8,519 | 6,806,406 | **6,806,406**(相同) | 149–165 | **42.4** | 46.4 | 151.6 |

**字节数逐字节相同**,再次确认它与平台无关、可以跨机器引用;**耗时 Mac 快 3.5×**,所以任何"改后耗时"
都必须注明机器。

> **但字节数会随代码走(2026-08-24 补)。** 在第三台机器(Apple Silicon / Xcode 26)上把本仓库
> checkout 回基线那个 commit(`0e878151`)重跑,这张表的每一个字节数都**逐字节复现**
> (157,280 / 808,924 / 1,618,908 / 6,806,406,连 §3.3 的 779,311 / 3,944,052 / 9,387,149 也一样)。
> 所以"跨机器可比"是成立的,**"跨 commit 可比"不成立** —— 见 §6.2。

**一个会改变后续任务优先级的发现:`seen` 集合只占快照的 0.4–0.6%。**
`TranscriptReducer.seen: Set<Int>` 确实无上界,但它是每个 seq 一个整数(≈ 5 B),而 items 是全文;
即使是全库最长的会话(122,819 seq),`seen` 也只有 ~700 KB,而它的 items 会是几十 MB。
「给 seen 设上界」对**写放大**的收益很小,真正的写放大来源是 **items 无上限**。

### 6.1 改后:items 内存窗口上限落地(2026-08-24)—— `实测`

`TranscriptReducer.trimOlder(keeping:slack:)` 给 `state.items` 加了上限(1,000 条,slack 200 ⇒ 有效
天花板 1,200),`ConsoleModel` 在读者钉在 tail 时执行。harness 的 `shape=capped` 一行就是它,与同一次
运行里的 `opened` / `watched` 直接对比 —— **同机、同一次运行**,不需要跨机换算:

| 事件数 | shape | items | 快照文件字节 | encode ms | save ms |
| --- | --- | --- | --- | --- | --- |
| 8,519 | watched(改前) | 4,490 | **6,897,763** | 52.2 | 54.4 |
| 8,519 | **capped(改后)** | **1,000** | **1,527,866** | **12.1** | **15.2** |
| 2,000 | watched / capped | 1,055 | 1,640,368(相同) | 11.1 / 10.1 | — |
| 1,000 | watched / capped | 528 | 819,666(相同) | 5.3 / 5.2 | — |

- 长会话单次快照 **6.90 MB → 1.53 MB(4.5×)**,编码 **4.3×**;
- 流式写放大按同比例:**102 MB/分钟 → ≈ 23 MB/分钟**;
- **关键性质:2,000 / 1,000 事件两行改前改后字节完全相同** —— 上限只在超过天花板时生效,短会话一分钱不多花;
- 而且它**不再随会话总长度增长**:8,519 事件和 85,190 事件的快照现在一样大。

> 本节的**耗时**来自 2026-08-24 的 Mac(Apple Silicon / Xcode 26),不是 §1.4 那台 x86 —— 耗时不可跨机比,
> 但上表的改前/改后两行来自**同一次运行**,可以直接比。字节数可跨机比(见 §6 的补注),但**不可跨 commit 比**:
> 上面 uncapped 那一行是 6,897,763,而 §6 表里是 6,806,406,差的不是机器而是代码 —— 见 §6.2。

剩下的 23 MB/分钟由「减少 transcript 快照的写放大」继续处理(它依赖本任务)—— 那是**写入节奏和增量**
的问题,不再是单次体积的问题。

### 6.2 基线之后快照涨了 91 KB(不是测量误差)—— `实测`

做 §6.1 的对比时发现:同一份种子固定的语料,8,519 事件的快照在**当前 main** 上是 **6,897,762 B**,
而 §6 表里是 **6,806,406 B**。一开始怀疑是工具链,查下来不是 —— 在同一台机器上 checkout 回基线 commit
`0e878151` 重跑,6,806,406 **逐字节复现**。

差的是代码。基线之后 `Transcript/` 只被这几个 commit 动过(`git log 0e878151..529dcdd1 --
src/macos/OrbitKit/Sources/OrbitKit/Transcript/`),其中 `44971641` / `91f8e0dd`(把 tool_result 的
content 按 web 的方式读,并让卡片记住"结果里有图但服务端把 data 丢了")给 `ToolCard` 的持久化键加了
一个 `resultHasImage`:

```
基线: case id, name, input, result, resultImages, status, inputSeq, …
现在: case id, name, input, result, resultImages, resultHasImage, status, inputSeq, …
```

`"resultHasImage":false,` = 24 B,取样语料里约 3,900 张工具卡片 ⇒ ≈ 93.6 KB,和实测的
**+91,356 B(+1.34%)** 对得上。

**这不是 bug**,是一个正确性修复应付的代价(没有它,被服务端丢掉 data 的图片卡片会折叠起来再也不去要那张图)。
记在这里是为了两件事:

1. **「减少 transcript 快照的写放大」的改前基准是 6,897,762 B,不是 §6 表里的 6,806,406 B。**
   拿旧数字当基准会凭空多出 91 KB 的"收益"。
2. **快照字节数"可跨机引用"这条性质要加一个限定:同一个 commit 才可比。** 引用 §6 的绝对值时,
   要么说清是哪个 commit,要么在自己那棵树上重跑一遍 uncapped 作为基准 —— harness 现在每项都同时输出
   uncapped 和 capped 两行,就是为了让这件事零成本(§9.0)。

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

**追加参考:同一个 harness 在 Mac mini 上原生跑一遍(2026-08-22,arm64,见 §1.5)。上表是基线,不要替换。**

| 指标 | Linux(x86,基线) | **Mac(arm64,参考)** |
| --- | --- | --- |
| 一个流式 turn(200 delta / 529 items)总计 | 278.1 ms | **104.8 ms** |
| └ `TranscriptRows.build` | 251.5 ms(**90.4%**) | **100.2 ms(95.6%)** |
| └ markdown(split + parse) | 24.4 ms(8.8%) | **4.4 ms(4.2%)** |
| └ `TranscriptReducer.apply` | 2.1 ms(0.8%) | **0.3 ms(0.3%)** |
| 每个 delta | 1.39 ms | **0.52 ms** |
| rows 重建 @ 4,490 items | 13.63 ms | **4.19 ms** |
| markdown 每条 | 217 µs | **102.7 µs** |
| `splitStreamingMarkdown`(4,000 字符) | 0.614 ms | **0.174 ms** |

**换了 CPU 架构、快了 2.7 倍,`TranscriptRows.build` 的占比不降反升(90.4% → 95.6%)** ——
这条结论不是 x86 的偏差,是结构性的:rows 全量重建随窗口线性增长,而 markdown 有解析缓存兜着。
「缓存 transcript rows」仍然是流式掉帧的第一优先级。

> §3.3 的 Linux 代理值(`/proc/self/VmRSS`)**在 macOS 上跑不出来**(没有 `/proc`,harness 输出 `rss_mb=-1`)。
> 内存那一项的模拟器实测在 §3.3.1,口径和 harness 不同,见那一节的说明。

### 7.1 改后:窗口上限对 rows 重建的效果(2026-08-24)—— `实测`

同一次运行里的 `window=uncapped` / `window=capped` 两行(见 §6.1 的机器说明):

| 场景 | uncapped | **capped** | 倍数 |
| --- | --- | --- | --- |
| `rowsbuild` @ 8,519 事件 | 4,490 items / 1,039 rows / **4.59 ms** | **1,000 items / 234 rows / 1.00 ms** | **4.6×** |
| 流式 turn @ 8,519 事件窗口(200 delta) | rowsbuild 866.5 ms,总 872.1 ms,**每 delta 4.36 ms** | rowsbuild **193.8 ms**,总 **198.4 ms**,**每 delta 0.99 ms** | **4.4×** |
| `rowsbuild` @ 2,000 / 1,000 / 200 事件 | 1.02 / 0.51 / 0.11 ms | 完全相同(未触及天花板) | 1× |

**窗口大小是怎么定的**(任务要求写出依据):用 §7 那张表反推,`TranscriptRows.build` 随 items 线性 ——
528 → 1.22 ms、1,055 → 2.44 ms ⇒ ≈ 2.3 µs/item;4,490 → 13.63 ms ⇒ ≈ 3.0 µs/item(均为 x86 基线)。
取有效天花板 1,200 items ⇒ **≈ 2.8 ms(x86 口径)**,即 60fps 预算 16.7 ms 的 **17%**;实测这台 Mac 上
1,000 items 是 1.00 ms。选 1,000 而不是更小,是因为它同时是 **≈ 10 个 tail 页(200 事件/页)的即时回滚量**,
再往上才走网络 —— 而走网络本来就是今天翻页的常规路径。

把 §7 的 x86 基线按同一倍数折算:**13.63 ms → ≈ 2.97 ms**,和上面的反推吻合。更重要的是它**不再随会话
长度增长**:这才是「4,490 items」那一格消失的原因,而不是常数变小了。

「缓存 transcript rows」仍然值得做 —— 上限把**斜率**封住了,缓存要动的是**每帧都全量重建**这件事本身
(capped 之后 rows 重建仍占流式 turn 的 97.7%)。

---

## 8. 仍未测到的项与补测步骤

08-21 那一轮列出的 3 件事(冷启动墙钟、进程内存、后台网络)以及 2 个附带项(解压体积、机型)
**已在 08-22 于 iPhone 17 Pro 模拟器上全部补完**,分别回填在 §2.0/§2.2、§3.1/§3.2.1/§3.3.1、§5.0–5.2、
§1.3、§1.5。下面是**剩下的、只有真机才能给出的**项 —— 都不阻塞现有的优化任务,但会影响它们的**验收口径**。

1. **jetsam 门限与内存警告行为(§3.2.1 / §3.3.1)`未测`**。模拟器没有 jetsam,整个测量里
   **一次内存警告都没有收到**,所以"到多少 MB 会被系统杀"和"UIKit 在内存压力下会不会自己丢弃
   已解码位图"这两件事没法在模拟器上回答。做法:真机 + Instruments Allocations / 或
   `os_proc_available_memory()`,把 §3.2.1 那 24 张图重跑一遍,观察是否触发
   `didReceiveMemoryWarning` 以及触发后 footprint 是否下降。
   **对验收的影响**:「AttachmentImageStore 改为有界缓存」的收益在模拟器上已经能证明(§3.2.1 第 3 条),
   但"改完就不会被杀了"这句话必须真机才能说。
2. **真机 APNs 静默推送会不会唤醒轮询(§5.2)`未测`**。`simctl push` 走的不是真 APNs 通道,
   实测两种推送都没唤醒进程,这个结论**不能外推到真机**。做法:真机 + TestFlight 构建,
   切后台后由服务端发一条真实的 approval 推送,看 30 秒内有没有 `?view=open` 发出。
   **对验收的影响**:「app 进入后台时暂停所有轮询循环」的真实收益大小取决于这个答案 ——
   如果真机静默推送确实会唤醒,那每次唤醒就是一次 4.39 MiB。
3. **真机绝对耗时(§2.0 / §7)`未测`**。模拟器跑在 Mac 的 CPU 上。冷启动的 572 ms / 2,225 ms 和
   harness 的 ms 数都只能当"改前/改后同环境标尺"。做法:真机 Time Profiler,重点看
   `TranscriptRows.build` 的主线程占比是否仍在 90% 以上(§7 里 x86 与 arm64 都在 90%+,预期成立)。
4. **电量** `未测`,而且**不打算在模拟器上测** —— 模拟器给不出任何有意义的电量数字。
   需要真机 + Xcode Energy Log 或 MetricKit。

**已经不必再做的事**(避免后续任务重复劳动):

- ~~`?view=open` 解压后体积~~ → 已测,4,598,365 B / ×12.2,见 §1.3。不需要用户态 token:
  `URLSessionTaskMetrics` 从客户端内部就能同时读到线上与解压字节。
- ~~机型~~ → 见 §1.1 / §1.5。
- ~~"为什么是 3 次 `?view=open`"~~ → 已定位到三个调用方,见 §2.2。

---

## 9. 怎么复现这些数字

### 9.0 §3.3 / §6 / §7 的 harness 数字

harness 是 `src/macos/OrbitKit/Tests/OrbitKitTests/PerfBaselineTests.swift`,**默认跳过**,
只有 `ORBIT_PERF=1` 时才跑,所以 CI 不会为它付钱:

```bash
docker run --rm -e ORBIT_PERF=1 -v "$PWD:/src" -w /src/src/macos/OrbitKit swift:6.1 \
  swift test --filter PerfBaselineTests 2>&1 | grep 'PERF|'
```

语料是**种子固定的合成数据**,按 §1.2 的真实事件比例和 payload 尺寸分布生成(只有词是编的,形状和尺寸是
实测的),所以同一台机器上两次跑结果一致,可以直接做改前/改后对比。**对比时务必用同一台机器**——
本文的绝对值来自 §1.4 那台 x86。

自 2026-08-24 起,harness 每一项都同时输出**加上限前后两行**(`shape=capped` / `window=capped`,
镜像 `ConsoleModel.maxWindowItems` = 1,000、`windowTrimSlack` = 200),所以改前/改后**在同一次运行里**
就能比,不再依赖"上次是在哪台机器上跑的"。§6.1 / §7.1 的表就是这么来的。

§2.1 / §4 / §5.3 的网络数字来自生产网关访问日志(`docker logs orbit-gateway`),按 UA `Orbit/1770` 过滤;
该日志随容器重启滚动,本次窗口是 2026-08-21 13:44–15:26 UTC。要重测得在窗口还在时抓。

### 9.1 怎么复现 §2.0 / §2.2 / §3.1 / §3.2.1 / §3.3.1 / §5.0 的模拟器数字

这些数字是用**一次性的临时打点**测出来的,**打点代码已经从仓库里撤掉了**(测完即还原,不留在出货路径上)。
要重测,按下面的方式重新加一遍 —— 全部由 `ORBIT_PERF=1` 这个环境变量兜底,不加就完全不执行:

| 要测的东西 | 打点位置 | 取数方式 |
| --- | --- | --- |
| 进程 fork 时刻 | 任意 | `sysctl` 读 `kinfo_proc.kp_proc.p_starttime`(**别用 `main()` 起点**,会漏掉 dyld) |
| 首帧 | `OrbitiOSApp` 根视图 `.onAppear` | `CADisplayLink` 的**第一次**回调。`CATransaction.setCompletionBlock` 会被 SwiftUI 在同一次 commit 里覆盖掉,实测拿不到 |
| 列表有内容 | `AppModel.applySessionSnapshot` 首次 `!list.isEmpty` | 同上,再挂一次 `CADisplayLink` |
| 每个请求的解压字节 | `APIClient.rawSend` 的完成回调 | `data.count`(URLSession 已经解过 gzip 了) |
| 每个请求的线上字节 | 给 `URLSession.orbitREST` 装一个 `URLSessionTaskDelegate` | `URLSessionTaskMetrics` 的 `countOfResponseBodyBytesReceived` vs `…AfterDecoding` |
| `?view=open` 的调用来源 | `AppModel.swift:453` / `:505` / `:660`、`AgentsModel.swift:187` 各打一行 | 直接看打点顺序 |
| 内存 | 一个 1 Hz 后台线程 | `task_info(TASK_VM_INFO)` 的 **`phys_footprint`**,不要用 `resident_size`(§1.5) |

两个踩过的坑,重测时直接避开:

- **`print` 拿不到**。simctl 的管道是块缓冲的,app 一被 kill 就全丢;`--console-pty` 也没成功。
  改成往 `NSHomeDirectory()/Documents/perf.log` 写 `FileHandle`,再从宿主
  `xcrun simctl get_app_container <dev> io.orbitd.app data` 去读,稳定可靠。
- **这台 Mac 的 `xcode-select` 指向 CommandLineTools**,`xcodebuild`/`simctl` 直接跑会报错。
  不用 `sudo xcode-select -s`,加环境变量即可:`export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`。

跑法(以冷启动为例):

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
cd src/ios && xcodegen generate
xcodebuild -scheme Orbit -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath /tmp/orbit-dd build
S=<simulator-udid>
xcrun simctl install $S /tmp/orbit-dd/Build/Products/Debug-iphonesimulator/Orbit.app
DC=$(xcrun simctl get_app_container $S io.orbitd.app data)
for i in 1 2 3 4 5; do
  xcrun simctl terminate $S io.orbitd.app; sleep 3; rm -f "$DC/Documents/perf.log"
  SIMCTL_CHILD_ORBIT_PERF=1 xcrun simctl launch $S io.orbitd.app
  sleep 20; cp "$DC/Documents/perf.log" /tmp/cold$i.log
done
```

切后台(§5)用 `xcrun simctl launch $S com.apple.mobilesafari` 把别的 app 拉到前台,
这会走完整的 `.inactive → .background`;`simctl push $S io.orbitd.app <payload.apns>` 发推送。

**模拟器需要是已登录状态**。钥匙串按模拟器持久化,手动登一次之后反复冷启不用再登。

---

## 10. 给后续任务的靶子速查

| 任务 | 改前基线 | 出处 |
| --- | --- | --- |
| AttachmentImageStore 改有界缓存 | **24 张真图 = +258.5 MB footprint,60 s 不回落;清掉缓存立刻收回 99.7%**(前 20 张 = +193.7 MB);单张增量 ≈ W×H×4(总体 1.44×) | **§3.2.1** |
| 图片缩略图降采样 | 源图 p50 1179×962 / 180 KB 文件;一次真实下载 1.17 MB;**实测:即使只显示 300×360,常驻的仍是全分辨率位图**(1179×2556 的截屏每张 12 MB) | §3.2、**§3.2.1** |
| ~~收紧常驻 console 数 / items 上限~~ | **已做(2026-08-24)**:`trimOlder` 上限 1,000 items(slack 200)。快照 6.90 → 1.53 MB、rows 重建 4.59 → 1.00 ms,两者**不再随会话长度增长**;模拟器实测裁剪→翻回来 `holes=0 dup=0`。**capacity 保持 12 未改**,理由见 §3.3.2 | §3.3.2、**§6.1**、**§7.1** |
| session 列表冷启动本地缓存 | **首帧后还有 2,225 ms 空列表(中位,模拟器);进程 fork → 列表有内容 2,790 ms**;冷启前 3 s 拉 3 次 `?view=open` = 线上 1.13 MB / **解压 13.16 MiB**,占 98% | **§2.0**、§2.1 |
| **去掉冷启动重复的 2 次 `?view=open`** | **三个调用方并发各拉一次且无在途去重**:`startPolling` 首 tick(`AppModel.swift:453`)、控制面 `.connected`(`:505`)、`AgentsView` 首次加载(`AgentsView.swift:202`,那个 `guard view != .open` 在 fetch 之后)。去掉后冷启动解压下行 13.2 MiB → 4.4 MiB | **§2.2** |
| 后台暂停轮询 | `.background` 只 persist,不停任何循环;`UIBackgroundModes` 只有 remote-notification。**实测:后台 2 分钟 0 请求,但那是系统把进程冻住了(1 Hz 心跳线程也停了),不是代码停了 —— 回前台瞬间 pollTick 早于 `.active` 就开跑,并立刻拉 2 次 `?view=open` = 9.2 MiB** | **§5.0–5.1** |
| 降低 4 s 全量列表轮询成本 | 单次 **线上 377 KB / 解压 4.39 MiB(×12.2)**、0/427 命中 304、2 分钟 26–35 次 = 9–13 MB 线上;静置 2 分钟 footprint 因此从 44.5 MB 漂到 52.3 MB | §4、**§1.3**、**§3.1** |
| 合并 TasksView 两个轮询 | 两个独立循环,忙 5 s / 闲 15 s;2 分钟各 2 次,≈ 22 KB | §4.3 |
| 减少 transcript 快照写放大 | ~~长会话单次 save 6.8 MB~~ → **items 上限之后单次 1.53 MB / ≈ 23 MB/分钟**(§6.1)。剩下的是**写入节奏和增量**的问题,不再是单次体积。**改前基准用 6,897,762 B,不是 §6 的 6,806,406** —— 原因见 §6.2 | §6、**§6.1**、**§6.2** |
| 给 seen 设上界 | **只占快照 0.4–0.6%(41 KB / 6.8 MB)—— 优先级应下调** | §6 |
| 避免 rows 每次 body 全量重建 | 流式 turn 里占 **90.4%(x86)/ 95.6%(arm64)**;~~4,490 items 单次 13.63 ms~~ → items 上限后窗口封在 1,000 items / **1.00 ms**,但**占比不降(97.7%)**:上限封的是斜率,缓存要动的是"每帧全量重建"本身 | §7、**§7.1** |
| markdown 解析缓存改 LRU | 217 µs/条(x86)/ 102.7 µs(arm64);1.14 ms/千字符(x86);流式时占 8.8% / 4.2%;split 每 delta 0.614 / 0.174 ms | §7 |

**引用这张表时注意标注来源环境**:模拟器数字(§2.0、§3.x)只能支撑"方向 / 相对改善",
真机绝对值仍未测(§8)。
