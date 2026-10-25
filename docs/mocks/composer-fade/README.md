# 输入框上方的线 → 渐隐（Web · iPhone · Mac）

输入框上方那条横线是第一版平框输入框留下的。现在输入框是带描边和阴影的卡片，有自己的边，那条线成了紧贴在它上方的第二条边。这次三端一起把线去掉。原来线底下藏着一个硬切口：往上翻时，对话会在线的上方被横着切断。现在改成在输入框上沿 20pt 内渐隐。

| 图 | 内容 |
| --- | --- |
| [01-web.png](01-web.png) | 真实会话页（vite 构建 + `src/web/ui-migration` fixtures），桌面和手机、浅色和深色，改前改后滚到同一位置 |
| [02-ios.png](02-ios.png) | iPhone App 真实界面：CI（GitHub macOS 26，iPhone 17 Pro 模拟器）上用 XCUITest 拍摄，接示例数据的假 API |
| [03-mac.png](03-mac.png) | Mac App 真实界面，同上 |

改前是 main `cbe6a6635`，改后是 `acef63c60`。对话内容都是示例数据。

## 怎么做的

- **Web**（`src/web/src/index.css`）：`.workspace-composer` 去掉 `border-top` 和上方 20px 的间距。对话滚动区（`.workspace-scroll-wrap > .workspace-sessions`）底部留出 20px，再用 mask 在这 20px 里渐隐。停在最新处时，这 20px 是空的，什么都不会被淡掉。桌面上那根常显的 8px 滚动条不参与渐隐，滑块的圆头保留。回到最新的按钮、加载更新的提示一起上移 20px，位置不变。
- **iPhone / Mac**（`ComposerView.swift`、`ConsoleView.swift`、`AgentsView.swift`）：`ComposerBand` 去掉 Divider 和上方 20pt。对话列表的末行自带 20pt 的高度。这 20pt 写在行的内容里，而不是写成 inset：写成 inset 时，跳到最新也露不出来，最后一行一直压在渐隐里。列表在这 20pt 上渐隐（`fadesIntoComposerBand`），右侧 16pt 的滚动条那一列不参与。回到最新的按钮同步上移 20pt，位置不变。新会话页的 hero 位置不变；/status 卡片滚动到一个同样留了 20pt 的尾部。

## 发现的旧问题（这次没修）

iPhone 和 Mac 上刚打开一个长对话时，列表没有贴到底：

- **iPhone**：每次都差 32pt。顶部「↑ Your question」条出现时，内容被往下推，之后没有重新滚到底。实测 contentOffset 是 692，底部是 724。
- **Mac**：差几十 pt，每次不一样。原因是行高一开始是估算的。

改前，最后一行藏在线下面，看不出来；改后，它会在渐隐里露出一半。往下滑一下，或点「回到最新」，就恢复正常。

我试过在顶部条出现时重新滚到底，但不起作用：内容被推下去发生在重新滚动之后。这个改动已经撤掉。正确的修法是在列表的 inset 或内容高度变化时重新滚到底，需要单独做，并配上测试。
