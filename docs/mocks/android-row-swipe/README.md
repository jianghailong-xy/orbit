# Android 会话行的左滑、右滑（对照 iOS，2026-11-06）

任务 34sMy8CUJcIBDoJ1SumKg：Android 的会话行目前只有长按，iOS 还能左右滑。这块板按 iOS 的代码（`SessionRowActions.swift`、`RowSwipeActions.swift`、`RowSwipeGeometry.swift`、`SessionProjectPage.swift`、`CompactShell.swift`）逐项对照，给 owner 看过再写产品代码。

**owner 11-06 定了：都按推荐。** 按板子做；长按菜单里的 *Move to Trash* 改成 *Delete*（会话页 ⋯ 不动）；系统区外 18 dp 留给抽屉；iOS 别的有滑动的列表另开一项（34sYVKxYkXFb7s5fEdBHw）。

iPhone 是 iOS 26 模拟器上的真截图，来自 10-02 的滑动探针（`probe/swipe-circles` 分支的 CI 产物 `swipe-shots-ios`，iPhone 402 pt 宽，样例数据），最下面探针自己的日志栏已裁掉。Android 是 `emulator-5554`（API 36，1080×2400，420 dpi）上原型的真截图：滑动是注入系统输入的真触摸事件，系统边缘手势用的是 `input touchscreen swipe`。原型的代码不在主线上。英文是上线文案，中文是说明。

| 图 | 内容 |
|---|---|
| `01-swipe.png` | ① Open 里的一行：左滑、右滑、滑到底、不能 Complete、浅色 |
| `02-lists.png` | ② Completed、Trash、项目行、项目里的成员、长按菜单（今天和建议） |
| `03-gestures.png` | ③ 右滑、抽屉、系统返回怎么分开；按钮画成什么样；手感的数字 |
| `04-audit.png` | ④ 逐项对照 iOS |
| `05-decide.png` | ⑤ 待定（要 owner 拍板）、落地、还没验证 |

## 怎么来的

- `prototype.patch`：原型相对 main 的改动，只用来出图和跑测试，不是要合的代码。
- `capture/`：`build-proto.sh` 建原型的 APK；`walk.sh` 在设备锁里装 APK、设深色或浅色和导航方式（手势、三键）、开演示状态栏，跑 `RowSwipeDeviceTest`（出图时在 `prototype.patch` 里；落地后在产品代码里，由 `src/android/scripts/row-swipe-device-test.sh` 跑），拉回截图，最后把设备设置放回原样；`prep.py` 挑出板上用的帧（680 px 宽，256 色）；`render.mjs` 按 `.board[data-png]` 截 2x PNG。
- 量到的数：会话行高 165 px = 63 dp（iOS 75.3 pt）；手势导航时系统的边缘区每边 78 px = 30 dp，三键导航为 0。
