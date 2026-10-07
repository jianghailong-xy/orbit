# 证据勘误

本文件记录已提交证据中的错误及更正。规则：
- 原证据文件保持原样，不改写；读者以本表为准。
- 每条写明原文位置（文件、行号、写入提交）、原文、核对依据和更正后的表述。
- 核对结果与报告者的说法不符时，照实写出核对结果，不硬改。

首批三条来自 [P3.3 试点检查](orbit-task:34Za39Br6OaoCg0nc1ipA) 的缺口 G6（报告见该任务评论），由 [P2/P3 补强](orbit-task:34blRfxvNoD5uIuXNTiEJ) 于 2026-10-07 逐条核对。三条都与 P3.3 的说法相符。三条都只影响证据的可读性，不改变原结论。

| 编号 | 原文位置 | 错误 | 核对结果 |
| --- | --- | --- | --- |
| E1 | [p2.3-b1/README.md](p2.3-b1/README.md) 第 134 行（`294b25b43`） | 两组耗时标签互换 | 相符 |
| E2 | [p2.3-b1/README.md](p2.3-b1/README.md) 第 14 行（`294b25b43`） | 「逐像素相同」说得过强 | 相符 |
| E3 | [p2-select-keys/summarize-select-keys.py](p2-select-keys/summarize-select-keys.py) 第 17 行（`f7a91822e`），并写入 [select-keys-summary.json](p2-select-keys/select-keys-summary.json) 第 4304 行 | 修复后的 repeat 次数 6 写成了 5 | 相符 |

## E1：B1 终版入场时间的 tip / 终版标签互换

**原文**（第 134 行）：

> WebKit 四个项目各重复 8 次的对照里，第一次出现在弹层内的时间中位数为（tip / 终版）：115.5 / 119.5、121.5 / 126.0、111.0 / 113.5、112.0 / 111.5 ms；终版 32/32 通过，tip 31/32

**核对**：数据见 [p2.3-b1/checks/ab-entrance-v2/entrance-timing.json](p2.3-b1/checks/ab-entrance-v2/entrance-timing.json)。
- 两组运行：
  - `tip-1` 在未改动的 tip `77233e226` 上运行；
  - `fixab-1` 在终版 `86db4c886` 上运行（见两次运行 `command-output.txt` 开头的 `# tree` 行）。
- 四个中位数按 JSON 中的顺序（深色桌面、深色手机、浅色桌面、浅色手机）排列，各用 8 次执行重算，与文件一致：

  | 项目 | tip | 终版 |
  | --- | ---: | ---: |
  | webkit-dark-desktop | 119.5 | 115.5 |
  | webkit-dark-phone | 126.0 | 121.5 |
  | webkit-light-desktop | 113.5 | 111.0 |
  | webkit-light-phone | 111.5 | 112.0 |

- 原文在「tip」的位置上写的是终版的数，两组标签互换了。
- 通过数无误：终版 32/32，tip 31/32。tip 在 webkit-dark-desktop 失败 1 次，见 `tally.json`。
- 同段第 131 行的 v1 对照（tip / v1：113.5 / 121、120.5 / 153.5、134 / 156）也对照 [checks/ab-transfer-v1/entrance-timing.json](p2.3-b1/checks/ab-transfer-v1/entrance-timing.json) 核对过，标签正确。

**更正后的表述**：

> WebKit 四个项目各重复 8 次的对照里，第一次出现在弹层内的时间中位数为（tip / 终版）：深色桌面 119.5 / 115.5、深色手机 126.0 / 121.5、浅色桌面 113.5 / 111.0、浅色手机 111.5 / 112.0 ms；终版 32/32 通过，tip 31/32

更正后：
- 终版在三个项目上比 tip 早 2.5–4.5 ms，在浅色手机上晚 0.5 ms；
- 结论不变（终版去掉切层时的两步后，这一帧不再推迟），实际数据比原文写的更有利于修复。

## E2：真实 tip + 修复上 profile-validation 的通知框不是「逐像素相同」

**原文**（第 14 行，结论表「P0 截图（B1 部分）」）：

> 真实 tip + 修复：settings-saved 8/8 一致；profile-validation 在真实 tip 上被 `profile.png` 挡住，比较不到，它的通知框与 B1 前逐像素相同。

**核对**：
- **像素**：B1 前 `e361ee373` 对真实 tip + 修复 `86db4c886`（诊断运行 `diag-e361ee373` → `diag-fix-v2`），数据见 [root-cause/toast-box-e361ee373-to-fix-v2.json](p2.3-b1/root-cause/toast-box-e361ee373-to-fix-v2.json)。「通知框」是卡片和通知列矩形外扩 34px（同 README 第 59 行）。profile-validation 8 张截图的框内差异像素：

  | 项目 | 框内差异像素 | 最大单通道差 |
  | --- | ---: | ---: |
  | chromium-light-desktop / chromium-dark-desktop | 0 / 0 | 0 |
  | chromium-light-phone / chromium-dark-phone | 4911 / 15076 | 224 / 223 |
  | webkit-light-desktop / webkit-dark-desktop | 777 / 852 | 33 / 35 |
  | webkit-light-phone / webkit-dark-phone | 4906 / 14659 | 224 / 223 |

  只有 2/8 逐像素相同。
- **差异来源**：
  - 其余 6 张的框内差异，与 B1 提交 `57f792135` 对未修复 tip `77233e226` 在同一框内的差异逐张同量（[root-cause/toast-box-57f792135-to-tip.json](p2.3-b1/root-cause/toast-box-57f792135-to-tip.json)：4911、15076、777、852、4915、14659）。webkit-light-phone 的 4915 对 4906 差 9 px：未修复 tip 上通知列宽 358，框也宽 8px。
  - 这两棵树的通知都带 B1，所以这部分差异来自 B1 之后页面本身的变化，即 README 第 143 行所说「页面有新的 main 漂移」，不是通知的绘制。
- **几何**：几何恢复成立。[root-cause/table.md](p2.3-b1/root-cause/table.md) 中，`fix-v2-86db4c886` 的通知列宽与胶囊 x 在 8 个项目都与 `e361ee373` 相同。例如 WebKit 手机为 350 / 123.141，未修复 tip 为 358 / 127.141。
- 第 144 行写的是「列宽和胶囊位置回到 B1 前」，与上述核对一致。第 14 行的「逐像素相同」超出了这一范围。

**更正后的表述**：

> 真实 tip + 修复：settings-saved 8/8 一致；profile-validation 在真实 tip 上被 `profile.png` 挡住，P0 比较器比较不到。对照 B1 前 `e361ee373`，通知列宽与胶囊位置 8/8 回到 B1 前（WebKit 手机 350 / 123.141）。通知框内，Chromium 桌面 2 张逐像素相同；其余 6 张的差异与 B1 提交到未修复 tip 之间同一框内的差异同量，来自页面的 main 漂移，不来自通知本身。（漂移验证树 + 修复上，框内 6/8 为 0 px，两张 Chromium 手机各 8 px、单通道差 1，见第 144 行。）

## E3：修复后 r8 重复探针的 repeat 次数

**原文**（`summarize-select-keys.py` 第 17 行，`STUDIES` 中修复后的说明）：

```python
'after-repeat': ('r8', 'fixed tree, r8 select-keys-repeat probe unchanged, --repeat-each 5: 200 samples per target'),
```

**核对**：
- **实际命令**：修复后运行的命令是 `--repeat-each 6`，见 [checks/after-repeat.json](p2-select-keys/checks/after-repeat.json) 的 `command`。同目录 README 第 48 行也写明「修复前用 `--repeat-each 5`，修复后用 `--repeat-each 6`」。
- **样本数**：[select-keys-summary.json](p2-select-keys/select-keys-summary.json) 中 after-repeat 的样本数为 240 / 240 / 238。Playwright 计数为期望 718、意外 2，共 720 = 3 个目标 × 40 × 6。
- **修复前一行**：第 14 行修复前的说明 `--repeat-each 5: 200 samples per target` 正确，共 600 = 3 × 40 × 5。其中 Sample choice 有 2 个测试没有产生样本，实为 198，与 README 的表一致。
- **影响**：脚本把这段说明原样写进生成的汇总，所以 `select-keys-summary.json` 第 4304 行（after-repeat 的 `scope`）带着同一错误。各样本计数由运行记录算出，没有受影响。

**更正后的表述**（第 17 行与 `select-keys-summary.json:4304` 的 `scope` 相同）：

```python
'after-repeat': ('r8', 'fixed tree, r8 select-keys-repeat probe unchanged, --repeat-each 6: 240 samples per target'),
```
