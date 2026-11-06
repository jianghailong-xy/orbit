# Android 打开时的默认行为（第二版，2026-11-04）

owner 11-02（手机截图）问：Android 打开时的默认行为是否符合预期。回答是不符合：iOS 和 Web 打开就是工作区的会话列表，Android 停在一页工作区名字上。owner 接着说「先出效果图」，看了第一版后说「需要考虑和 iOS 的一致性」。这是第二版：按 iOS 的代码逐项对过。

**owner 11-04 定了：「A，按建议」。** 打开时的行为和这一页都跟 iOS，实现见同一分支。

iOS 那张是 iPhone 探针截图（10-21）。Android 都是 `emulator-5554`（API 36，1080×2400）上的真截图：今天的版本和原型，样例数据，名字都是编的，行数和大小按 11-02 量到的 owner 账号。英文是上线文案，中文是说明。

| 图 | 内容 |
|---|---|
| `01-open.png` | ① 打开之后看到什么：iOS · a 今天 · b 建议第一屏 · c 读完之后 |
| `02-audit.png` | ② 逐项对照 iOS：打开时的行为、这一页的样子、还不一样的 |
| `03-states.png` | ③ 建议版的其他状态：≡ 菜单、长按、往下读、Completed 读取中、没存过、读不到、断网、断网的抽屉 |
| `04-decisions.png` | ④ 待定、落地、还没验证 |

## 定了

**这一页整页跟 iOS（A）**，就是第 1 张的 b、c。

第一版的四项也按 iOS 定了：落到上次用的工作区；手机存工作区和 Open 列表；读取中什么都不显示；`New session` 不灰。

## 和 iOS 有意不同的地方

- 停在 Completed 或 Trash 时，iOS 每 4 秒重读；这里切过去和下拉时才读，这个账号的 Completed 有 18 MB。
- 行的左滑、抽屉的样子、事件只改一行和增量读取：这次不做，各单开一项。
- 系统返回、Material 的菜单和外观：项目定的平台差异。

## 怎么来的

- `prototype.patch`：原型相对 main 的改动，只用来出图，不是要合的代码。
- `capture/`：截图工具。`capture2.sh` 建原型 APK 并跑各段流程；每个测试是一次独立的 `am instrument`，所以每段都是真的冷启动，读真的缓存；没有用 compose test rule，转圈才会真的转。服务器是进程内的 MockWebServer，靠闸门卡住列表来停在某一刻。`today-LandingBoardShotsTest.kt` 是截今天版本用的，`prototype-LandingBoardShotsTest.kt` 是截原型用的。
- `numbers.txt`：板子上的数字和它们的来源。
- 渲染：`node capture/render.mjs <本目录>` 按 `.board[data-png]` 截 2x PNG（截之前调 `window.drawMarks()` 画标号），`capture/squeeze.py` 压到 256 色。
