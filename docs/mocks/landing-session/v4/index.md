# 落地会话效果图 v4（2026-10-18，按 main 1c1c78d72）

供 owner 审阅。owner 批准之前不动工（10-08）。每张图是一个 `.html` 与渲染出的 `.png`（2x）。套件都在本目录，不引用 v3：`kit.css` / `kit.js` 是 iOS 与图板部件，`web.css` / `web.js` 是 web 外壳，`android.css` / `android.js` 是 Android 外壳；第 1–3 段从 v3 抄来，第 4 段是 v4 新增。字体取自 `/var/tmp/landing-mock-render/fonts`。

英文是上线文案，中文是说明。依据：契约 `docs/project-integration-line-contract.md` 修订 12（§2.9 LS1–LS8、J-T9、J-T10、J12、§7.2 V6、§4.6 X-E5）及其后的 13–22 号里碰到这些表面的条文（13：协调会话接手后不再按时钟交给 owner；16：超时的 CHECK_PROMOTION 走候选重检门；18：三端同一张待办卡）；设计 `docs/landing-session-design.md` §3。

## 为什么有 v4

v3 画在 main 2ba6765d9（10-08）上。之后 main 把落地在各端的样子改了，都是 owner 定的：

- **749d995c5（owner 10-11，`docs/mocks/project-landing-card`）**：在途的落地是进度卡下面自己的一张 **Landing 卡**，排在合入卡前面；灰色在途，服务端判 runner 沉默后变琥珀并带 Retry；Work overview 画同一张。
- **3b23aa163（owner 10-11，`docs/mocks/project-merge-check-row`）**：合入检查行和 Landing 卡穿「Merged into main」那一行的**头**：30pt 圆里的标记、词、右边活的时钟、下面一行；没有 chevron，整行就是按压。
- **22124bb0a**：作业清单（`ProjectLandingJobsSheet` / `LandingJobsSheet`）和 Work overview 也穿这个头，旧的 `LandingRow` 没了；没给按压的卡画成只读。
- **d321b88ee（owner 10-15）**：Automatic 合入遇到 main 动了就回到 CHECKING 重查；检查行下面一句 *Merges on its own when it passes.* / *Asks you when it passes.*
- **Android**（fafa3dab7 A11-11 等）：有了 sessions 页、Landing 卡与头、作业清单、带 *Blocked by* 的合入卡、NATIVE 截图测试。

## 图

- `04-project-sessions-page`：项目 sessions 页（iOS 与 web）。**现在**：Landing 卡（两个作业）、作业清单、合入检查行（d321b88ee 那一句）、超时的琥珀卡。**改后·方案 A**：一个作业的卡底 Open landing ›、两个作业每行一个、清单每行一个、合入检查行整行去这一轮合入的落地会话（≥2 个作业时 All jobs ›）；**方案 B** 一帧。**Landings 组**的位置与内容，合入卡的排队、取消中、交回、两种超时与已合入（回执里的 Open landing ›）。web 三帧，A 与 B 的比较表，入口表，待定。
- `05-landing-session-page`：落地会话页（iOS 十帧、web 一帧）。合入轮：检查中、main 动了回到检查、已合入、⋯ 菜单、检查超时（10-09 那一次）、合入作业超时；任务段：检查没过、⋯ 菜单、超时（LAND_TASK）、接管之后。页头的状态卡穿 main 的头。V6 活性图例，待定。
- `06-list-chat-task`：会话列表的项目行（现在与改后）、协调会话的转录卡（*Open the failed session ↗* 保留，加 *Open the landing ↗*）、X-E5 的 owner 卡（修订 18 的样子）、iOS 任务页新加的 Landing 段、写代码的会话底部的落地标签；web 的任务页与协调会话。
- `07-android`：Android。**现在**：sessions 页的 Landing 卡、作业清单、BLOCKED 合入卡、项目页 Work overview。**改后**：Open landing › 与 Landings 组、清单每行的入口、落地会话页（⋮ 菜单与超时）、任务页 Landing 段、待办卡的 Open landing 与 Abandon。

## 本组的答案：Open landing 放在哪（待定）

推荐**方案 A**：main 的每一个按压都保留——Landing 卡、Work overview 的卡整张打开作业清单，清单的行打开任务——Open landing › 另外明写：一个作业时卡底一个，几个作业时每行一个（合入作业那一行不放，它的入口在合入卡上），清单每行一个。合入检查行（以及合并中卡里合入作业的头）整行打开**这一轮合入**的落地会话；清单只在 ≥2 个作业时由 *All jobs ›* 进；「已合入」行仍打开回执，回执底部加 Open landing ›。**方案 B**：只有一个作业时整张 Landing 卡直接打开它的落地会话，≥2 个时打开清单。两方案在合入检查行与清单上相同。

## 相对 v3 的改动

- **现在列全部重画**：照 main 1c1c78d72 的 Landing 卡、头、清单、合入卡、Android sessions 页；v3 的「进度卡里的一行落地」与 `LandingRow` 已不在 main 上。数据换成 10-11 定稿图里的项目（`34bmzOkov3xN2yLPrnsCk`，Wiki 服务端执行与 System model）。
- **入口**：v3 的合入卡 Watch › 拿掉——main 把检查行定成一个整行按压，v4 让这一个按压去这一轮合入的落地会话（方案 A，待定）。Landing 卡新加 Open landing ›（A）或整张进落地会话（B）。清单每行的 Open landing › 照 owner 10-08，不变。
- **Landings 组**：行改穿同一个头（标记说结局），位置照旧在 Coordinator 下面、Today 上面；在途的从不列；停下的落地（v3 待定 2 说的那张「停下落地卡」main 没有做）放在这里。
- **合入卡**：照 main 的四种形态，加上修订 12 的「取消中」（服务端给 `cancelRequested` / `pushBoundaryPassed`）与两种超时：CHECK_PROMOTION 超时有 **Re-run the check**（修订 16 的候选重检门）与 Abandon；LAND_PROMOTION 超时只有 Abandon。超时的合入卡照 Landing 卡的规则整张变琥珀。BLOCKED 照 main 不加入口：这一轮在等决定，入口在 Landings 组（LS6 只要求 CHECKING / CONFIRMED / RECHECKING 时链落地会话）。Abandon 只在落地会话页头、合入卡与 X-E5 待办三处（LS6），不上 Landing 卡与清单。
- **main 的一个空**：Landing 卡把排着的合入作业也列一行，但 `taskTitle` 为空，只剩 *queued*；改后写它的词 *Merge to main* / *Merge check*。合入作业领头时 Landing 卡不画，排在后面的落地任务只在清单里看得到——改后用 *+N job queued · All jobs ›* 留住这条路。
- **落地会话页**：页头的状态卡穿 main 的头，下面接 V6；合入轮按作业分段，画出 d321b88ee 的「main 动了，回到检查」与「第几次自动合入」；检查超时用 10-09 的真事（候选 `EgpMcrpirt5G2yVGJimfS`）。协调会话拿着的待办不再写 *goes to you in …*（修订 13）。J-T11（runner 停机交还，10-17 上线）记进时间线。
- **X-E5 卡**：照修订 18 的三端同一张卡：第一行是契约给的 `requiredAction`（*The runner stopped reporting; abandon this landing, or wait for the runner to come back.*），ABANDON 领头（契约定它是这一格的 `primaryAction`），每扇门下面一行后果；Open landing 是看的门。INTEGRATION_* 的卡也加 Open landing，追加在门的末尾，不改领头的门。
- **任务页**：iOS 与 Android 都新加 Landing 段（今天都不读 `landTask`），web 加链接。
- **Android**：v3 只画了 Work overview 的一行；v4 的现在列照 main 的 sessions 页、清单（Retry 是 OutlinedButton）、合入卡与 Work overview，改后加落地会话页（⋮ 是 `DropdownMenu`）、任务页与待办卡。

## 待定（详见各图的待定框）

1. **Open landing 放在哪：方案 A 还是 B**（04；本组推荐 A）。
2. **合入检查行的整行去这一轮合入的落地会话**，清单只在 ≥2 个作业时由 All jobs › 进（04 b4）。任务原文是「只在 main 没有别的去处时才替换回执 / 清单」，本组读成「清单与回执都不能因此到不了」；若要检查行照旧开清单，入口就只剩清单里那一行。
3. **「最近结案」的窗口**：本组取 24 小时（v3 第 3 条）。
4. **Landings 组收不收已合入的合入轮**：时间线已有「Merged into main」行（04）。
5. **旧服务端时 Open landing 那一格**：灰色 *No landing page on this server yet*（v3 第 4 条）。
6. **合入卡超时时整张变琥珀**（04 c5、c6）。
7. **租约过期时 Stop / Cancel 还留不留在菜单里**（v3 第 5 条；05）。
8. **菜单要不要 Copy Link**（v3 第 6 条；05）。
9. **检查作业超时的推送句**：J12 按领取协议判，legacy 领取一律 *may have been pushed*，但 CHECK_PROMOTION 从不推送（05 e）。
10. **「第几次自动合入」写不写**：d321b88ee 三次都撞上 main 动了才交给 owner，main 哪里都不显示这个数（05 b）。
11. **X-E5 卡的标题**：ESCALATED 的现成公式取「升级时刻 − 开始等待」，X-E5 开出即升级，会写成 *Now yours — no one acted on this for 1s*；本组给 *Now yours — no report from the runner for 27m*（06、07）。
12. **Abandon 画成实心红色**的领头门（06、07）。
13. **会话列表里超时的写法**：*Merge to main · timed out · no report for 23m*，琥珀字，不点橙点（06）。

## v3 的待定里 main 已经定了的（不再列）

- **合入卡 checking 时两个按压目标**（v3 第 1 条）：3b23aa163 把合入检查行定成一个整行按压，没有 chevron，也就放不下 Watch ›；剩下的只是「这一个按压去哪」（上面第 2 条）。
- **进度卡下面只放哪张卡**（v3 第 2 条）：749d995c5 定为在途的 Landing 卡、排在合入卡前面，只在有作业在途时画（`SessionProjectLanding` 的 `live`）；另一组提的「停下落地卡」main 上没有，停下的落地在 v4 的 Landings 组里。
- **Android 协调会话里旧式的 Merge to main 卡要不要加 Watch**（v3 第 7 条）：Android 已改成每个时刻一行（`PromotionEventLine`），那张卡没有了。
- **Android 清单里 Retry 的样子**（v3 第 8 条）：fafa3dab7 定为清单里 `OutlinedButton`、卡上实心 `Button`。

## 画面依据与没能核实的（UNVERIFIED）

- **web**：照 `ProjectLandingCard.tsx`、`LandingJobsSheet.tsx`、`ProjectPanoramaHeader.tsx`（`LandingHead`）、`ProjectMergeStrip.tsx`、`WorkspaceView.tsx` 与 `index.css` 的取值画，并对过 `docs/evidence/project-merge-check-row/web/` 的真控制台截图（10-11）。d321b88ee 那一句（10-15）之后没有新的截图。
- **iOS / macOS**：照 `ProjectLandingCard.swift`、`ProjectLandingRow.swift`（`ProjectLandingHead`）、`ProjectLandingJobsSheet.swift`、`SessionProjectPage.swift`、`ApprovalCards.swift`（`OwnerItemCardView`）的代码和 10-11 两张定稿图画。本机没有 Mac，main 的 iOS 现状没有真机截图可对（project-merge-check-row 的证据也这样写），字号与间距按代码里的 SwiftUI 字体档换算，像素未核实。
- **Android**：照 `ProjectLanding.kt`、`SessionProjectPage.kt`、`ProjectMergeViews.kt`、`ProjectsScreen.kt`（`LandingJobsSheet`、Work overview）、`ExceptionCardView.kt` 与 `OrbitTheme` 画。NATIVE 截图测试（`ProjectLandingCardViewTest`）的图没有提交进仓库，本组没有跑模拟器，像素未核实。
- **改后列**全是提案：落地会话、`landingSessionId`、OPEN_LANDING / ABANDON 门、X-E5、v2 回报（每 30 秒、PUSH 前同步回报）在 main 上都还没有实现；J-T11 的交还（10-17）已上线。
