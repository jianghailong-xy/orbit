# 落地会话效果图 v3（2026-10-08，按 main 2ba6765d9）

供 owner 审阅。owner 批准 v3 之前不动工。每张图是一个 `.html` 与渲染出的 `.png`（2x）。套件都在本目录，不引用 v2：`kit.css` / `kit.js` 是 iOS 与图板部件，`web.css` / `web.js` 是 web 外壳，`android.css` / `android.js` 是 Android 外壳。字体取自 `/var/tmp/landing-mock-render/fonts`。

## 图

- `04-project-sessions-page`：项目 sessions 页。第一行对照「一行 + 作业清单」：现在（main）与改后。改后清单每行加 Open landing ›，推送那一句按 J12。第二行是合入卡：checking、排队、取消中、交回、超时、已合入。Watch 只在 CHECKING / CONFIRMED / RECHECKING。另有 web 的两帧、入口表、待定。
- `05-landing-session-page`：落地会话页。合入轮：重查中、已合入、⋯ 菜单。任务段：检查没过、⋯ 菜单、超时（LAND_TASK）、超时（Merge to main）、接管之后。另有 web 一帧，以及 V6 活性五态。
- `06-list-chat-task`：会话列表的项目行（现在与改后）、协调会话（转录卡与合入行）、协调会话里的 X-E5 卡、任务页 Landing 段、写代码的会话，以及 web 的任务页与协调会话。
- `07-android`：Android。Work overview 的行（现在与改后）、作业清单、落地会话页（检查中与超时）、任务页 Landing 段、协调会话里的待办卡。

## 相对 v2 的改动

- **入口**：照 owner 10-08，保留 main 的「一行 + 作业清单」。作业清单每行加 Open landing ›；旧服务端没有 `landingSessionId` 时不可点，并写明原因。Landings 组只列等决定的、24 小时内结案的，不列在途的。入口表加上作业清单，一次在途落地不再出现三次。契约的「最多 3 行」让位。
- **04「现在」改照 main**：行打开 “N jobs in flight”；超时写 *Timed out · No report for Nm · limit Nm*，LAND_TASK 带 Retry；*Update unavailable* 只表示读不到服务端。合入作业领头时，进度卡不画落地行（`isMergeJob`）。v2 把两处画在同一时刻，main 上不会出现。
- **05e 超时**：用词照 main，推送那一句按 J12（旧版 runner 的领取一律写 *may have been pushed*）。按钮改成 Retry（只 LAND_TASK）与 Abandon（三种作业）。分成 LAND_TASK（e1）和 Merge to main（e2）两个例子。
- **04d 交回**：BLOCKED 的合入卡去掉 Watch。另加合入作业超时的一帧（卡上 Abandon），以及排队形态（*Merge into main queued*）。
- **05d 菜单**：按设计 §3。任务段：Open Task、Open Source Session、Open Coordinator，按条件出现 Stop Landing。合入轮：Review Card、Open Coordinator，按条件出现 Cancel Merge。租约过期后出现 Abandon。去掉 Open Project 与 Copy Link。
- **06b**：转录卡保留 *Open the failed session ↗*，后面加 *Open the landing ↗*。Chat about this 从链接行挪回 main 的位置：待办卡上，iOS 在按钮后面，web 在按钮下面单独一行。合入行用 `promotionPageTitle` 的词。待办标题照服务端原文 *Checks failed on the combined tree: …*。
- **06c**：任务页徽标照 `LandTaskStatus`（*Landing checks failed*），不用 *not landed yet*。
- **06a**：项目行超时照 main 写 *Timed out · no report for …*。超过 10 分钟就不是 SILENT 的 *no word from runner*。
- **外观**：页头用 main 的网格按钮（Open Project），不用 ⋯。去掉 main 没有的 *Project ›* 链接。项目已启动，所以没有启动行。*usually ~18m* 只在改后列，标为 V6 的方案。
- **状态卡（V6）**：加 *claim N · round M*、*Taken over … · first started …*（05-f）和活性五态。
- **新增**：每张图加 web 帧；新增 07 Android；05 加合入轮的菜单和接管。
- **runner 名**：写服务端的 `workstation-gpu`，不写 HPC。

## 待定（详见各图的待定框）

1. 合入卡 checking 时有两个按压目标（行打开清单，Watch 进落地会话），要不要只留一个（04）。
2. 进度卡下面只放一张卡：本组的合入卡，对项目 `34bVlqVqH9cWacqlQpNjy` 的 merge-conflict-landing-card 停下落地卡。两份提案并存时，同一次停下的落地会出现两次（04）。
3. 「最近结案」的窗口，本组取 24 小时（04）。
4. 旧服务端时清单那一格的原文（04）。
5. 租约过期时 Stop 还留不留在菜单里（05）。
6. 菜单要不要 Copy Link：t4web 任务原文与设计 §3 不同（05）。
7. Android 协调会话里旧式的 *Merge to main* 卡要不要加 Watch（07）。
8. Android 清单里 Retry 的按钮样式（07）。
