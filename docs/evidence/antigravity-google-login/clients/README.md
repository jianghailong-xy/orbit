# Antigravity Google 登录：web 与 macOS/iOS 客户端证据

任务 `34ZogkzPnQ44ODj72jrYb`，对应项目验收条目 2（`4q7GDYg6GzChkJE0bfhFGV`）。
分支：`orbit/web-macos-ios-antigravity-google-b47365`。
控制面契约来自第 3 步提交 `7cd0d809be5052ef1eadd2738a2217403767eeb9`；本分支以项目线上的 `8725dd57d` 为起点。

本次实现复用粘贴授权码中继，为支持的 Linux runner 提供 Google 登录/重新登录、条款链接、Google 账号标记、各额度桶的剩余百分比和重置时间。macOS runner 与旧 runner 显示对应限制；保留 env key 和配置 Gemini key 的路径。新建会话选择器与未登录错误卡使用同一状态；`auth=unknown` 不宣称已登录，`auth=no` 会阻止 Google 账号选择。

## 本会话已记录的检查

| 检查 | Orbit 后台工具行 | 结果 |
| --- | --- | --- |
| `npm test -w @orbit/web` | `bgj_75709d9759c6` | 退出码 0；294 文件、3615 用例通过 |
| `npm run build -w @orbit/web` | `bgj_b9b147a609a5` | 退出码 0；TypeScript 与生产构建通过 |
| Swift 6.1 Docker 中 OrbitKit `swift test --jobs 2` | `bgj_ef99ff4e52d5` | 退出码 0；2779 用例、5 跳过、0 失败 |
| Google 登录及受影响的 OrbitKit 测试组 | `bgj_f0e40ed45d6d` | 退出码 0；143 用例通过 |
| 三个改动的 SwiftUI 文件 `swift -frontend -parse` | `bgj_62fbb3f12912` | 退出码 0；只证明语法，类型与平台编译须由 client CI 证明 |
| 浏览器取证 `node docs/evidence/antigravity-google-login/clients/capture.mjs` | `bgj_a0e5a6a68d27` | 退出码 0；16 张截图，检查了浏览器异常与横向溢出 |
| 原始截图总览 `node docs/evidence/antigravity-google-login/clients/contact-sheets.mjs` | `bgj_54121c744d84` | 退出码 0；两张总览 |

客户端 CI：由协调会话对上述分支 dispatch `.github/workflows/client.yml`，必须确认 macOS 的 `Test OrbitKit`、`Build OrbitApp` 和 iOS 的 `Build for iOS Simulator` 真正运行并通过。最终 CI 链接记入任务的证据信封。

## 原生同源数据证明

`AntigravityGoogleClientTests.swift` 的 6 个测试读取此目录 `fixtures.json`，与 web 测试、截图共用脱敏控制面数据。覆盖 Google 身份、weekly/5h 剩余量（72%/18%）与重置时间、零额度、未知/失效认证、Linux/macOS/旧 runner 登录入口、选择器、两种 API key 路径、`awaiting_code` DTO 和 SwiftUI 接线。macOS 与 iOS 共享这些 OrbitKit / OrbitApp 源码。该测试在最终全量中实际执行并通过；不以语法检查代替 SwiftUI 编译。

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
