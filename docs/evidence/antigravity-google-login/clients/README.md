# Antigravity Google 登录：web 与 macOS/iOS 客户端证据

任务 `34ZogkzPnQ44ODj72jrYb`，对应项目验收条目 2（`4q7GDYg6GzChkJE0bfhFGV`）。
本轮分支：`orbit/web-macos-ios-antigravity-google-284433`。
重放基线：`bd688174c2eba84fc0922118172eafc1c50fe222`，父提交为 `ec23262944e9e353099940770c0881433e90c4a1`。
控制面契约来自第 3 步提交 `7cd0d809be5052ef1eadd2738a2217403767eeb9`，已以 `8725dd57d` 落地。

## 最新 main 上的冲突处理

只重放客户端实现及取证文件，保留最新 main 的控制面和 runner 改动。

- `SessionProviderChoices.swift` 保留 main 的 `claude / codex / antigravity / kimi` 顺序，加入 Google 账号选择、失效登录判断和 workspace Gemini key 回退。
- `RunnerEngines.tsx` 保留 main 的账号菜单和布局；Antigravity 使用同一引擎行、额度组件和菜单，已登录后的换号入口位于 `More actions → Re-sign in`，交互测试实际提交粘贴的授权码。
- `AccountPauseAPIClientTests.swift`、`CodexSignInCopyParityTests.swift` 及 `SharedPoolCopyParityTests.swift` 保留 main 的修复，与基线逐字一致。

未登录的 Linux runner 提供 Google 登录及条款提示；已登录时显示 Google 账号、每周 / 5 小时剩余额度与重置时间。macOS 和旧 runner 显示限制，env key 路径保留。选择器、未登录错误卡和共享原生源码同步这些状态；未知认证不显示成已登录，缺 CLI 优先显示未安装。

## 本轮测试

| 检查 | 本任务会话的 Orbit 后台工具行 | 结果 |
| --- | --- | --- |
| Google 登录及 runner 账号菜单、选择器、错误卡回归 | `bgj_e9464c9b9eeb` | 退出码 0；13 文件、225 用例通过 |
| `npm test -w @orbit/web` | `bgj_5802cb7b0efe` | 退出码 1；3646 通过、30 失败，296 文件 |
| 干净 `bd688174c` 的 web 全量对照 | `bgj_8b4d04dacc81` | 退出码 1；3631 通过、同样 30 失败，295 文件 |
| `npm run build -w @orbit/web` | `bgj_2e8b71a666e0` | 退出码 0；TypeScript 与生产构建通过 |
| Swift 6.1 Docker 的 OrbitKit `swift test --jobs 2` | `bgj_9243e4215fcb` | 退出码 0；2823 用例、5 个默认跳过的性能基线、0 失败 |
| 生产构建的 Chromium 截图及原图总览 | `bgj_26c36e0b5189` | 退出码 0；1280px / 443px 共 16 张原图和 2 张总览，无浏览器异常或页面横向溢出 |
| 原图及总览的 Orbit 附件上传 | `bgj_c5073ed1f127` | 退出码 0；18 个附件均返回保存回执 |

### main 既有的 web 失败

两次全量运行的 30 个失败名称及断言内容逐项一致。只移除终端 ANSI 转义并统一两个 checkout 的绝对路径后比较，没有新增失败。[web-main-comparison.json](web-main-comparison.json) 点名全部 30 个用例并记录对应工具行和失败内容哈希。

| 失败文件（均在 `src/web/src/components/`） | 用例数 |
| --- | ---: |
| `CriteriaDecisionCard.receipt.test.tsx` | 2 |
| `CriteriaDecisionCard.sessionSwitch.test.tsx` | 2 |
| `WorkspaceView.acceptanceConfirmationCard.test.tsx` | 8 |
| `WorkspaceView.criteriaDecisionCard.test.tsx` | 3 |
| `WorkspaceView.promotionPlacement.test.tsx` | 6 |
| `WorkspaceView.settlementPointer.test.tsx` | 9 |

### OrbitKit 过时断言的复验

干净 main 上 `bgj_fa7d1b3bcc6f` 实际执行 1 个测试并复现 `OrbitLinkCopyParityTests.testTheStalledLineIsTheProjectsOwnSentence` 的唯一失败：项目页已经由 main 改为手动就绪提示，旧测试仍要求它携带 link card 的 stalled 文案。
本分支仅将该测试改为检查 web / Swift link card 实际共用的文案，保留四个有效断言，未改项目页行为。最终 OrbitKit 全量无失败。

## macOS/iOS 同源数据证明与编译

`AntigravityGoogleClientTests.swift` 的 9 个测试使用此目录 `fixtures.json`，与 web 测试和截图共用脱敏控制面数据。覆盖 Google 身份、weekly / 5h 剩余量（72% / 18%）及重置时间、零额度、未知 / 失效认证、Linux / macOS / 旧 runner 登录入口、选择器、两种 API key 路径、`awaiting_code` DTO、条款和共享 SwiftUI 接线。
9 个测试在本轮最终全量中全部实际执行并通过，作为任务允许的 macOS/iOS 截图替代证据。

HPC 没有 `gh`。本轮需由协调会话在上述分支的最终 HEAD 重新 dispatch `client.yml`，确认 macOS `Test OrbitKit (macOS)`、`Build OrbitApp` 和 iOS `Build for iOS Simulator` 真正运行成功。确切 HEAD、CI 链接与 job / step 回执记录在本任务会话的新证据信封；历史分支的 CI 不作为本轮编译证据。

## 浏览器截图

真实生产路由 `/providers`、`/workspaces/:id/new`、`/sessions/:id` 通过 Chromium 取证，viewport 分别为 1280px 和 443px，device scale 为 1。仅 REST/SSE 输入为合成脱敏 fixture。每种宽度包含：未登录及条款、Google 账号及额度 / 重置、macOS 暂不支持、需要升级、env key、未知认证、展开的选择器、未登录错误卡。
`capture-results.json` 保存每张原图的 viewport 和可见文本；取证脚本同时核对登录按钮、条款链接、两条重置时间、Google 账号选择器与不支持平台的无登录入口。

![1280px 桌面总览](screenshots/1280-overview.png)

![443px 手机总览](screenshots/443-overview.png)

总览按原尺寸排列原图，全部原图保留在 `screenshots/` 并已上传 Orbit。复跑需安装 Playwright / Chromium，先构建 shared 和 web，再启动 `npm run preview -w @orbit/web -- --host 127.0.0.1 --port 4184 --strictPort`，运行 `ORBIT_EVIDENCE_WEB_URL=http://127.0.0.1:4184 node docs/evidence/antigravity-google-login/clients/capture.mjs` 和 `contact-sheets.mjs`。

真实 Google 账号授权、实时额度和推送通知的端到端验证由项目第 5 步持有；本客户端证据没有宣称这些实验已经执行。
