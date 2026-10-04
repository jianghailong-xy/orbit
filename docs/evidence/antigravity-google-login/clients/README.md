# Antigravity Google 登录：web 与 macOS/iOS 客户端证据

任务 `34ZogkzPnQ44ODj72jrYb`，对应项目验收条目 2（`4q7GDYg6GzChkJE0bfhFGV`）。
当前复验分支：`orbit/web-macos-ios-antigravity-google-54a1c0`。
控制面契约来自第 3 步提交 `7cd0d809be5052ef1eadd2738a2217403767eeb9`，已以 `8725dd57d` 落在项目线上。

## 当前执行会话复核

本轮从项目基线 `80e7ad8fd` 复核既有实现，补回上一轮 `db37c8031` 的 workspace key 与失效 Google 登录兼容、旧 runner 升级提示、macOS env key 行的登录平台限制和缺 CLI 的状态优先级。另同步 web runner 页的旧 runner 行、行内提示与原生引擎详情页状态，并补充首次登录和重新登录粘贴授权码的提交测试。没有重放旧分支的上游历史，原控制面与 runner 改动仍保留。

本轮 Node 26 全量 web 验收、最终生产构建、当前分支 `client.yml` 链接与完整日志由本任务会话的最终证据信封记录。首次 web 全量发现本轮行内提示误用页脚 `.rd-hint` 类，导致 `RunnerDetailPage.layout.test.tsx` 的页脚检查失败；已改用既有 `.re-panel-hint` 并重新运行全量，未作为 main 既有失败豁免。

OrbitKit Swift 6.1 全量工具行 `bgj_3b6ea6f2b5d2`：退出码 0，2783 用例、5 个默认跳过的性能基线、0 失败，Antigravity 专项 9 项均实际执行并通过。生产路由的 1280px / 443px 各 8 场景与两张总览已重新生成，保留全部原图；选择器截图等待入场动画结束，取证检查浏览器异常与横向溢出。原图及原生测试日志通过 Orbit runner 附件接口保存，附件回执与最终 CI 的分支 / HEAD / job / step 状态由本任务会话提交。

## 2026-10-04 集成冲突后的复验

上一轮分支 `orbit/web-macos-ios-antigravity-google-b47365` 在集成时被退回。本轮从项目当前 HEAD `b0eb14060` 建立新分支，只重放三个客户端提交（原 `bf28fc0d9`、`e212ac862`、`af6b0f652`，现 `5141039a9`、`597b5c1cf`、`91da7f22b`）。Git 自动合并无遗留冲突；项目控制面、Google 会话与网络探测修复全部保留在祖先历史中，两个曾冲突文件保留已验收的客户端实现。没有重新 rebase 包含上游提交的旧分支。

| 当前基线检查 | 本任务本轮 Orbit 后台工具行 | 结果 |
| --- | --- | --- |
| `npm test -w @orbit/web` | `bgj_9de97c4efb8e` | 退出码 0；294 文件、3615 用例通过；没有需要豁免的 web 失败 |
| `npm run build -w @orbit/web` | `bgj_c29a11fe628a` | 退出码 0；TypeScript 与生产构建通过 |
| Swift 6.1 Docker 中 OrbitKit `swift test --jobs 2` | `bgj_a20f7e913859` | 退出码 0；2780 用例、5 跳过、0 失败；6 个 Antigravity 用例实际执行并通过 |
| 当前生产构建的 Chromium 截图 | `bgj_6a8e8e74e1aa` | 退出码 0；1280px / 443px 共 16 张；无浏览器异常或页面横向溢出 |
| 原始截图总览 | `bgj_c2c2641db991` | 退出码 0；桌面与手机各一张，展示对应 8 个状态 |

本轮对上述新分支重新 dispatch `client.yml`，须确认 macOS 的 `Test OrbitKit (macOS)`、`Build OrbitApp` 和 iOS 的 `Build for iOS Simulator` 真正运行并通过；新 HEAD 与 CI 链接由本轮证据信封记录。下方旧 CI 与工具行仅保留为上一轮历史。

本次实现复用粘贴授权码中继，为支持的 Linux runner 提供 Google 登录/重新登录、条款链接、Google 账号标记、各额度桶的剩余百分比和重置时间。macOS runner 与旧 runner 显示对应限制；保留 env key 和配置 Gemini key 的路径。新建会话选择器与未登录错误卡使用同一状态；`auth=unknown` 不宣称已登录，`auth=no` 会阻止 Google 账号选择。

## 上一轮已记录的检查

| 检查 | Orbit 后台工具行 | 结果 |
| --- | --- | --- |
| `npm test -w @orbit/web` | `bgj_75709d9759c6` | 退出码 0；294 文件、3615 用例通过 |
| `npm run build -w @orbit/web` | `bgj_b9b147a609a5` | 退出码 0；TypeScript 与生产构建通过 |
| Swift 6.1 Docker 中 OrbitKit `swift test --jobs 2` | `bgj_ef99ff4e52d5` | 退出码 0；2779 用例、5 跳过、0 失败 |
| Google 登录及受影响的 OrbitKit 测试组 | `bgj_f0e40ed45d6d` | 退出码 0；143 用例通过 |
| 三个改动的 SwiftUI 文件 `swift -frontend -parse` | `bgj_62fbb3f12912` | 退出码 0；只证明语法，类型与平台编译须由 client CI 证明 |
| 浏览器取证 `node docs/evidence/antigravity-google-login/clients/capture.mjs` | `bgj_a0e5a6a68d27` | 退出码 0；16 张截图，检查了浏览器异常与横向溢出 |
| 原始截图总览 `node docs/evidence/antigravity-google-login/clients/contact-sheets.mjs` | `bgj_54121c744d84` | 退出码 0；两张总览 |
| `AccountPauseAPIClientTests`（包含 body stream 回归） | `bgj_947cd2fb277e` | 退出码 0；4 用例、0 失败 |

上一轮客户端 CI：[37176765769](https://github.com/jianghailong-xy/orbit/actions/runs/37176765769)，HEAD `af6b0f65208ce35f6b012e9c4ac0c864e9c73ca2` 的 macOS OrbitKit 测试、OrbitApp 编译与 iOS Simulator 编译全部实际运行并通过。该结果不代替本轮新基线 CI。

首次 [client CI](https://github.com/jianghailong-xy/orbit/actions/runs/37176072114) 在 `e212ac8625e1efca08a4dc99eab020ccd084dc60` 上：iOS Simulator 真编译通过；macOS OrbitKit 编译通过，但既有 `AccountPauseAPIClientTests.testPausesTheNamedRunnerSlot` 直接解包 nil `httpBody` 崩溃，OrbitApp 编译被跳过。main 上该测试相同：macOS URLSession 将请求体移到 `httpBodyStream`，测试没有读取流。本分支让测试 stub 在收到请求时读取流、保留请求体，再断言 duration 和显式 null；增加流式请求回归测试。这只修复测试取证，不改客户端网络行为。需对修复后的 SHA 重跑 client CI。

## 原生同源数据证明

`AntigravityGoogleClientTests.swift` 的 9 个测试使用此目录 `fixtures.json`，与 web 测试、截图共用脱敏控制面数据。覆盖 Google 身份、weekly/5h 剩余量（72%/18%）与重置时间、零额度、未知/失效认证、Linux/macOS/旧 runner 登录入口、选择器、两种 API key 路径、`awaiting_code` DTO 和 SwiftUI 接线。macOS 与 iOS 共享这些 OrbitKit / OrbitApp 源码。该测试在最终全量中实际执行并通过；不以语法检查代替 SwiftUI 编译。

## 既有失败的复验与同步

干净 `origin/main`（`6e5ba7544bd3bcf64ae544f606ebef7a929370de`）上，后台工具行 `bgj_a5e75edc5d17` 复现两个测试的三处失败断言：

- `CodexSignInCopyParityTests.testTheAccountsRowSaysWhatTheWebRowSays`：旧 NEXT 标记断言漏掉 main 已有的暂停账号过滤。
- `SharedPoolCopyParityTests.testThePickerAndTheComposerDrawASharedPoolAsTheWebDoes`：旧 `next: login.next` / `next: key.next` 断言漏掉 main 已有的暂停过滤。

为让本分支完整 `swift test` 和 client CI 通过，仅同步上述三处文案/接线断言，不改账号池产品行为。最终全量已无失败。web 全量没有需要豁免的失败。

## 浏览器截图

截图在真实生产路由 `/providers`、`/workspaces/:id/new`、`/sessions/:id` 上通过 Chromium 取证，viewport 分别为 1280px 与 443px，device scale 为 1。仅 REST/SSE 输入为合成脱敏 fixture；不是实际 Google 账号认证证据。每种宽度包括：未登录及条款、已登录及额度/重置、macOS 暂不支持、需要升级、env key、未知认证、展开的选择器、未登录错误卡。`capture-results.json` 保存每张截图的 viewport 和可见文本。

![1280px 桌面总览](screenshots/1280-overview.png)

![443px 手机总览](screenshots/443-overview.png)

总览按原尺寸排列 16 张原始截图，原图全部保留在 `screenshots/`。重跑取证需要已安装 Playwright/Chromium、共享包已构建，以及 `npm run dev -w @orbit/web -- --host 127.0.0.1 --port 4178 --strictPort`。

真实 Google 账号授权、实时额度和推送通知的端到端验证属于项目第 5 步，本证据没有宣称它们已经执行。
