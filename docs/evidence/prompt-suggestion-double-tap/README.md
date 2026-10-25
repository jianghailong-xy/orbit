# 拍两下使用建议：验证记录

改动：触屏上空输入框里的建议不再有 Use 胶囊，在输入框那一行拍两下填进去（不发送）。设计见
`docs/prompt-suggestions-design.md` §4.1、§4.3、§9 补充二，效果图见 `docs/mocks/prompt-suggestion-double-tap/`。

## iPhone 真机界面（CI 模拟器）

`ios-real.png` 是 iPhone App 自己的 `CompactShell` / `ComposerView` 编译后，在 GitHub 的 macOS 26 模拟器
（iPhone 17 Pro，iOS 26）上由 XCUITest 实际点出来的截图，数据来自本地桩服务（`probe-harness/stub.py`），都是假的。

探测分支只用于验证，从不合并（`probe-harness/`，做法同 `docs/evidence/kimi-accounts-ios/probe-harness/`）。
一次推送跑三件事：

- shots：`run.sh` 起桩服务、用 XcodeGen 生成探测 App、跑 `UITests/DoubleTapTests.swift` 的 6 个用例；
- macos：OrbitKit `swift test` + OrbitApp `swift build`（Mac 分支的 `Use ⇥` 照旧编译）；
- ios：真 App（`src/ios`）的模拟器构建。

| 运行 | 代码 | shots（6 个 UI 用例） | macos | ios |
| --- | --- | --- | --- | --- |
| [37906844129](https://github.com/jianghailong-xy/orbit/actions/runs/37906844129) | 14e1a97c8 | 4 过 2 不过：检查写错（见下） | 通过 | 通过 |
| [37909757723](https://github.com/jianghailong-xy/orbit/actions/runs/37909757723) | cb5667e28 | 键盘已起来时拍两下 1 次没填进去，弹出 AutoFill 菜单 | 通过 | 通过 |
| [37912802209](https://github.com/jianghailong-xy/orbit/actions/runs/37912802209) | e4efecafc | 拍两下 4+3 轮全过；点两次不再出 Paste | 通过 | 通过 |
| [37915385001](https://github.com/jianghailong-xy/orbit/actions/runs/37915385001) | bc70113cc | **6 个全过** | 通过 | 通过 |

- 第一次的 2 个不过是检查写错了：「编辑菜单出现了吗」把对话里每条消息自带的 Copy 按钮也算成了菜单。改成只算手势之后
  新出现的菜单项。
- 第二次那 1 次是真问题：iOS 26 上输入框自己的单击是 `UITextMultiTapRecognizer`，不是 `UITapGestureRecognizer`，
  原先的「输入框的点按要等双击落空」漏了它，第二下有时被它抢走。探测 App 把编辑中输入框的手势列给桩服务记下
  （`ProbeArgs.reportGestures`），据此改成「类名含 Tap 的都等」（e4efecafc），键盘起来时连拍 4 轮、键盘没起来时
  3 轮都填进去且没有菜单。
- 代价是第三次看到的：被扣住的单击手势只管聚焦，不再开关编辑菜单。有建议、输入框为空时，粘贴改为长按
  （bc70113cc 写进代码注释、设计文档和效果图 ⑥），第四次验证长按出 Paste、AutoFill，输入框仍为空。

用例覆盖：

1. 空输入框显示建议和 Double-tap to use，键盘没起来；
2. 单点：键盘起来，输入框仍为空，建议还在；键盘起来后拍两下 4 轮（每轮删空再来）：都填入，没有编辑菜单；
3. 键盘没起来时拍两下：填入、键盘起来、没有编辑菜单；接着打 " now" 接在句尾；删空后建议回来，提示不再出现；
   再来 2 轮（点对话区没有收起键盘，这 2 轮实际是键盘起来时）；
4. 深色；
5. 长建议：截断显示，拍两下后整句填入；
6. 点一下、等键盘起来再点：没有菜单，输入框仍为空；长按：出 Paste、AutoFill，输入框仍为空。

## 本机检查（HPC）

- OrbitKit：`docker run --rm -v "$PWD":/src:ro … swift:6.1 swift test`，3552 个用例，5 个跳过（PerfBaseline），0 失败
  （14e1a97c8）；之后的 Swift 改动再跑 `--filter PromptSuggestionTests` 11 个全过，第四次探测的 macos 任务也在
  bc70113cc 上跑了 OrbitKit 全量测试和 OrbitApp 构建，都通过。`PromptSuggestionTests` 含新加的两个（源码接线、
  三端提示与读屏动作同一句话）。
- Web：`npx vitest run src/components/WorkspaceView.promptSuggestion.test.tsx src/lib/promptSuggestion.test.ts`，
  全过（会话页 9 个，其中新加的三个：拍两下且扣住空闲输入框的第一下、单点在双击窗口后才聚焦、已聚焦时第一下
  照常且时间或位置隔得远的两下不算）；把 `onTouchEnd` 去掉时拍两下那个用例变红。`tsc -b` 通过。
- Android：`gradlew test lintDebug assembleDebug`（与 `scripts/verify.sh` 同一组任务）通过：app 单元测试
  debug 864、release 864，core 117，0 失败；lint 0 个错误（cb5667e28）。之后改用 KTX `edit {}` 去掉一个新 UseKtx
  警告，composer 包 40 个用例重跑全过。新测试 `SuggestionDoubleTapTest` 5 个。

## 实现时偏离效果图的地方（已写进设计文档 §4.1、§4.3、§9 补充二）

1. 有建议时，第一下要等双击判定（约 0.3 秒）才起键盘。键盘若在第一下就起来，会把输入卡片顶上去，快速的第二下
   就落到键盘上（拼音键盘上是一个候选字）。iOS：输入框自己类名含 Tap 的手势都等双击手势落空；网页：没聚焦时
   扣住第一下，300 ms 后再 `focus()`；Android：没聚焦时输入框上盖一层只收点按的透明层。
2. iPhone 上有建议、输入框为空时，粘贴改为长按（见上，第三、四次运行）。
3. Android 没法在 Initial 阶段扣住第一下：输入框自己的选字手势不看 consume，第二下按下就会让它聚焦，所以改成透明层。
