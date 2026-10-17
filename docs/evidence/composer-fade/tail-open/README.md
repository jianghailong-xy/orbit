# 长对话打开时落在末尾：验证记录

改动：打开一个长对话时，iPhone 和 Mac 的对话列表不再停在离末尾几十 pt 的地方，最后一行完整地在输入框上方的
渐隐之上。问题的样子见 `docs/mocks/composer-fade/`（02-ios.png、03-mac.png 的 ④ 行）。

## 原因（CI 上实测）

- 顶部「↑ Your question」条是 `TranscriptView.chrome` 里的 `.safeAreaInset(edge: .top)`，在第一次贴底之后才出现，
  并且带动画进场。动画的每一帧都把列表的顶部 inset 加大一点，同时把 offset 往下推同样多：iPhone 上 inset
  116 → 126.9 → 139.4 → 147.8 → 148，不修时 offset 从 724 被推到 692；Mac 上 inset 77 → 82.7 → 95.3 → 105 → 107。
- Mac 上行高先是估算值：贴底落在估算的末尾（offset 232，内容 788），屏幕上的行量出来后内容高了 44pt（832），
  offset 不动。
- 每一步留下的差都在 80pt 的贴底余量（`TailPinning.nearBottom`）以内，所以对话仍算贴底，「回到最新」按钮不出现；
  列表本身的高度没变，`ViewportResize` 也不会触发；空闲的会话没有下一次 publish 来重新贴底。

## 改法

- OrbitKit `TailPinning.followsGeometry`（纯规则，Linux 上有单元测试）：仍贴底、没有东西在移动列表（手指、惯性，
  或系统报告的动画滚动）、末尾离开了视野（大于 0.25pt，且在 80pt 余量以内），并且这一次读数里内容高度或顶部
  inset 变了、offset 只按 inset 推的量移动（容差 2pt）时，重新贴底。顶部条进场是一帧帧推的，所以每一帧都跟。
- `ScrollTracker` 的读数加上 `contentInsets.top`，每次读数都问这条规则；要跟时走 `repinAfterResize`，和视口变化
  用同一条不带动画的 held scroll。
- 读者往上翻时，offset 的移动超出几何变化能解释的部分就是滚动，从不跟随——包括 Mac 上翻动时刚露出的行在同一次
  读数里量出新高度的情况。离末尾超过 80pt 的读数也不跟随，原因见最后一节。

## CI 探测（`probe-harness/`，探测分支用后已删）

一次推送跑这些：三棵树各在 GitHub 的 macOS 26 上拍 iPhone 17 Pro 模拟器和 Mac 的真实界面——base 是当时的 main，
fix 是改后，diag 是改后再加上 `diag.py` 的日志（每次读数、滚动阶段、规则的判断）；另有 client.yml 的 macos
（OrbitKit `swift test` + OrbitApp `swift build`）和 ios（`src/ios` 模拟器构建）两道门。数据来自桩服务
`stub.py`，都是假的。「刚打开」那张图等到对话自己的顶部条出现才拍：`导出好了` 这几个字会先在会话列表的预览里
匹配上。

| 轮次 | 运行 | 改后 | base | 结果 |
| --- | --- | --- | --- | --- |
| 1 | [37941828093](https://github.com/jianghailong-xy/orbit/actions/runs/37941828093) | aa998888a | main ab1ef1657 | 全部通过。改后两端打开都在末尾。diag 看到 Mac 深色那次顶部条最后一帧只推了 2pt（274 / 276），规则当时把 2pt 以内算作在末尾，没有跟；也看到列表的动画跳转不报 animating 阶段。两处都改了（第二个提交） |
| 2 | [37945965301](https://github.com/jianghailong-xy/orbit/actions/runs/37945965301) | 10c6c6af0 | main 87351bf9a | **全部通过**：macos、ios 两道门，base 与 fix 的 iPhone、Mac 用例。diag iPhone 的 test1 有一次截图超时（见下） |

表里的提交号是探测时的：两个修复提交之后会随 main 重新排，提交号会变，内容就是第 2 轮测的这两个
（10c6c6af0 和它的父提交），之后只把 `ScrollTracker` 上方的一段注释重新折了行。

第 2 轮，刚打开时（`1-rest-*` 与 test3 的 `6-opened-light`；offset / 最大 offset 取自每张图对应的 metrics.log，
最后一行的位置取自 `notes/`）：

| | 改前 main 87351bf9a | 改后 10c6c6af0 |
| --- | --- | --- |
| iPhone 浅色 | 691.7 / 724；最后一行底边 743.9，超出列表下沿 738.9 | **724 / 724**；最后一行底边 711.5，渐隐从 719 开始 |
| iPhone 深色 | 692 / 724；743.5，超出下沿 739 | **724 / 724**；711.5 |
| iPhone test3 | 692.3 / 724 | **724 / 724** |
| Mac 浅色 | 247 / 276；最后一行底边 590，超出下沿 588 | **682 / 682**；最后一行底边 561，渐隐从 568 开始 |
| Mac 深色 | 651 / 682；592，超出下沿 588 | **682 / 682**；561 |
| Mac test3 | 679 / 682 | **682 / 682** |

读者往上翻不会被拉回（改后，`test3ReaderStaysUp`：新启动，翻之前不读整棵元素树，所以 Mac 上翻到的行是边翻边量的）：

| | 翻 150pt | 4 秒后 | 再翻 90pt | 4 秒后 | 回到末尾后点顶部条跳上去 | 4 秒后 |
| --- | --- | --- | --- | --- | --- | --- |
| iPhone | 587.7 | 587.7 | 512.7 | 512.7 | 650 | 650 |
| Mac | 532 | 532 | 442 | 442 | 539 | 539 |

`test1Console` 里两次上翻也停在原处（iPhone 587.7、512.7；Mac 532、442）；iPhone 之后点「回到最新」回到 724
（Mac 上这个按钮 XCUITest 点不到，没拍）。

`board.png` 是第 2 轮的截图拼板：① ② iPhone、③ ④ Mac 刚打开时的改前改后；⑤ ⑥ 改后往上翻、4 秒后；⑦ ⑧ 改后
点顶部条跳上去、4 秒后。`metrics/` 是第 2 轮三棵树两端的 metrics.log（diag 的还带 `scroll` 行：每次读数、阶段和
`follow=` 判断），`notes/` 是用例记下的最后一行位置和按钮。

diag 记录里看到的：

- 两轮 diag 一共 47 次 `follow=true`（顶部条进场的每一帧，Mac 上量出行高 +44pt 的那次），读数上都是
  `scrolling=false reader=false`（阶段一直是 idle），每一次的下一个读数都回到了末尾。
- 列表的动画跳转（「回到最新」、顶部条）全程读到 `idle`，开头几步很小（1.6、4.7、7.7pt；顶部条那次第一步 0.7pt）。
- 第 2 轮 diag iPhone 的 test1 一次截图超时（"Timed out while requesting screenshot"）：diag 每帧都往桩服务发一行，
  界面较忙。test3 通过；base 与 fix 的用例都通过。

## 本机检查（HPC）

OrbitKit：`docker run --rm -v "$PWD":/repo:ro … swift:6.1 swift test`，10c6c6af0 上 3566 个用例，5 个跳过
（PerfBaseline，Linux 上总是跳过），0 失败；其中 `TailPinningTests` 29 个、`TailPinningWiringTests` 10 个。

## 发现的旧问题（这次没修，已建任务 34czDD182kGHf5x953FYq）

iOS 上点顶部「↑ Your question」条时，代码先取消贴底（`atBottom = false`），但列表的动画跳转第一次读数只离末尾
0.7pt，落在 80pt 余量里，`TailPinning.pinned` 又把它算成贴底，之后整段跳转都保持贴底（第 2 轮 diag：跳到 650，
离末尾 74pt，全程 `pinned=true`）。若问题离末尾超过 80pt，跳过去以后对话仍算贴底，下一次 publish 会把读者拉回
末尾——这是推断，探测的会话没有新消息，还没实测。`followsGeometry` 因此只在 80pt 以内跟随，不会在这种时候把读者
拉回去。Mac 在同一次探测里按几何推断，过了 80pt 就取消贴底了。
