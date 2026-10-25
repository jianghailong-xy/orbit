# Cursor CLI engine · T0 设计板（Web + iOS，明暗两版）

项目「Cursor CLI 原生接入」的设计图。所有者确认后，P7a（Web）、P7b（macOS / iOS）、P7c（Android，跟 iOS 稿）才改界面。事实以 P0a 运行时契约 [`docs/cursor-runtime-contract.md`](../../cursor-runtime-contract.md)（固定版本 `2026.10.14-941492e`）为准。界面文案全部英文；板上的说明是中文。

每块板有 `-light.png` 和 `-dark.png` 两张。先看 `00-overview`。

| 板 | 内容 |
| --- | --- |
| [00-overview](00-overview-light.png) | 板索引、显示名与图标、D1 / D2 / D4 / D5 / D6、今天 vs 提议、规则表、将改动的文件、交协调会话的事项 |
| [web-1-new-session](web-1-new-session-light.png) | 新会话 engine 列表里的 Cursor CLI；跑不了的四种写法 |
| [web-2-infrastructure](web-2-infrastructure-light.png) | 概览卡片、机器卡片的 Cursor 行、账号与额度（Usage unavailable）、未安装 / 未登录 / runner 太旧 / 版本不符 |
| [web-3-add-account](web-3-add-account-light.png) | Add account（登录链接、剩余时间、过期重拿）、Re-sign in、Remove 与拒绝 |
| [web-4-api-key](web-4-api-key-light.png) | 厂商画廊的 Cursor 卡片、Connect Cursor 表单、无效 key / 连不上、表格里被拒的 key |
| [web-5-session](web-5-session-light.png) | 模型与变体（effort / context / fast）、排到下一轮的说明、Context「Unavailable」、额度卡 |
| [web-6-modes-and-switch](web-6-modes-and-switch-light.png) | 权限模式（D6 方案 A / B）、换账号（不能换 / 能换） |
| [ios-1-new-session](ios-1-new-session-light.png) | Engine 表、hero、跑不了的写法 |
| [ios-2-infrastructure](ios-2-infrastructure-light.png) | Infrastructure 概览、机器页、Cursor CLI 引擎页（账号与额度）、四种状态 |
| [ios-3-add-account](ios-3-add-account-light.png) | Add Account、Sign In Again、Remove |
| [ios-4-api-key](ios-4-api-key-light.png) | API keys 列表、Cursor key 页（检查通过 / 被拒）；iOS 不加表单 |
| [ios-5-session](ios-5-session-light.png) | 模型菜单与参数、托盘说明、Context 表、额度卡 |
| [ios-6-modes-and-switch](ios-6-modes-and-switch-light.png) | 模式菜单（D6 A / B）、Provider 子菜单（不能换 / 能换） |

## 待所有者定

1. **显示名与图标（D3）**：A「Cursor CLI」+ Cursor 立方体标（建议，板上按此画）；B「Cursor」；C「Cursor CLI」+ 中性字母标。
2. **D1 代码库索引**：A 默认关（`--disable-indexing`，建议）；B 沿用 Cursor 默认。
3. **D2 提交署名**：A 沿用 Cursor 默认（建议）；B 关掉。
4. **D4 账号隔离**：先由 P0c 补验方案 A（SHELL 包装）；A 不成立时在 B（真 HOME，接受副作用）和 D（只支持 Default 账号）之间选。
5. **D5 换账号**：验证跨账号续聊之前，只允许没说过话的会话换账号或换 key（建议，板上按此画）。
6. **D6 权限模式**：A Cursor 不提供 Default，新会话默认 Accept Edits（建议）；B Default 作为 Accept Edits 的别名并写明。

## 交协调会话

- 契约 §10 的模型变体里有 `fast`，P1 的说明写「不声明 fast」：板上把它画成 Cursor 模型的参数（Speed 行），首版不提供就去掉这一行。
- iOS 今天没有厂商画廊和 key 表单，本板 iOS 只画列表和 key 页。
- 在另一台设备上完成 Cursor 登录还没实测（契约 §9、§17.1 第 6 条），Web 3 / iOS 3 以它成立为前提。
- Auto 模式依赖 Orbit 自己的请求级分类器；做不出来时 Auto 也灰掉。

## 怎么做的

- **Web 的每一帧都是真实页面截图**：本分支的 `src/web` + `src/shared` 跑在 vite 上，接仓库自带的 `src/web/ui-migration` 假 API 和 `capture/data.mjs` 的示例数据（3 台机器、6 个 engine、几把 key）。「现在」是 main 上的页面；「改后」是同一页面加上 [`prototype.patch`](prototype.patch) 里的原型代码——只为出图，不是实现。截图和要标注的位置在 `shots/`（`shots/marks.js`），每块板按位置画虚线框和编号。
- **iOS** 按现有 SwiftUI（`RunnerEnginePage.swift`、`RunnerSignInView.swift`、`ComposerView.swift`、`AgentIdentity.swift` 等）画成 393×852 的手机，套 [`../antigravity-accounts/kit.css`](../antigravity-accounts/kit.css) 和 [`../provider-engine-decoupling/board.js`](../provider-engine-decoupling/board.js) 的构件；Cursor 的标取自 LobeHub icons（MIT），和 `src/web/src/lib/providerGlyphs.ts` 里其他厂商标同一来源。
- **重画**：`FONTCONFIG_FILE=<fonts.conf> node docs/mocks/cursor-engine/render.mjs [board ...]`（headless Chromium，`?theme=dark` 出暗色版）。重新截图用 `capture/` 里的脚本：`run-ns.sh <tree> scenes.mjs [scene ...]`，`today` 树是本分支的 web，`proposal` 树是同一份代码打上 `prototype.patch`；脚本里的路径按 `/var/tmp/cursor-engine-mock` 写。
