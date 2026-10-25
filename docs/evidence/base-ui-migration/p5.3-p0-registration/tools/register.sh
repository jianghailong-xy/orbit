#!/usr/bin/env bash
# Usage: register.sh <runs dir>   (run in the worktree whose accepted/ registry is written)
# The p0-drift/tools/register-accepted.cjs calls of this registration, one per difference text (light desktops'
# session-attachment-staged, light phones' session-attachment-staged, phones' session-attachment-menu).
# Decision: P5.3 (34Za39Ov1yysHZaYL6wgJ), evidence revision 1, which the coordinator CONFIRMed (decision record
# 61sATHPY66znwxRZorvP8d); its evidenceDigest as task_evidence_list returns it; document p5.3/README.md.
# Same-commit originals, as P5.3 compared them: before = 8f94ddda9 (P5.3's reference: its delivery with only the
# business switch c868a02c2 reverted), after = b72da6eda (P5.3's delivery, landed on the project line by a167c2ff0).
set -euo pipefail
REPO=${REPO:-$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)}
R=$1
cd "$REPO"
register() { # <difference> <screenshot>...
  local difference=$1; shift
  node docs/evidence/base-ui-migration/p0-drift/tools/register-accepted.cjs \
    --task 34Za39Ov1yysHZaYL6wgJ --revision 1 --digest 6f0931ccd70e1d4f7d2b0920a9245931732498837a3cc9780c64b8cd928c01c2 --document p5.3/README.md \
    --before-commit 8f94ddda9069bc2301fefc87f276570b04f4c774 --before-dir "$R/before-8f94ddda9/snapshots" --before-env "$R/before-8f94ddda9/environment.json" \
    --after-commit b72da6eda7656645c343e97bc73111c1499fab32 --after-dir "$R/after-b72da6eda/snapshots" --after-env "$R/after-b72da6eda/environment.json" \
    --difference "$difference" "$@"
}
STAGED='P5.3 把会话工作区换成 Orbit 组件（业务切换 c868a02c2），输入框的 + 菜单换成 Orbit Menu。P0 session 场景从 + 菜单选 File 放进一个文件后截取 session-attachment-staged：Orbit 菜单关闭后把焦点还给发起的 + 按钮（已验收的焦点约定：选择、Esc 或对话框关闭后焦点回到发起的按钮，P2.1「逐层返回焦点」），+ 在输入框卡片里，卡片因 :focus-within 画出聚焦时较深的边框与阴影（index.css 的 .composer-box:focus-within）；被替换的 AntD Dropdown 把焦点丢到 body，卡片保持未聚焦的样子。卡片里面（附件 chip、两行文字、工具栏）逐像素相同，差异只在卡片 1px 边框一圈和它外面的阴影'
STAGED_DESKTOP="$STAGED：卡片边框盒 x 621–1259、y 736–883，边框上单通道差至多 53，全部差异在 x 592–1279、y 719–899 内，卡片内 0 个像素不同。暗色两个桌面环境同样的差异（单通道差至多 40）在 P0 比较器的颜色阈值以内，比较器判为相符，不登记。协调者判定接受：P5.3 第 1 版证据的 CONFIRM（判定记录 61sATHPY66znwxRZorvP8d）第 1 条，已验收焦点约定的可见结果。出处：p5.3/README.md「合并检查与 P0」中 P0 页面矩阵 session-attachment-staged 一条与「未消除的差异」第 1 条；P5.3 第 1 版证据 compare/p0-summary.json 中该截图的像素数与最大级数，与本条 before → after 相同。"
STAGED_PHONE="$STAGED：卡片边框盒 x 14–375、y 680–827，边框上单通道差至多 53，全部差异在 x 0–389、y 663–843 内；卡片内 WebKit 0 个像素不同，Chromium 有 7 个单通道差 ≤2 的抗锯齿像素。手机上这张排在 session-attachment-menu 之后，P5.3 的标准 P0 停在前一张，没有比较到它；判定说明要求登记时按比较器确认手机上的这一张，本登记在同提交原件上用 P0 比较器确认明色两个手机环境不相符，暗色两个手机环境同样的差异（单通道差至多 40）在阈值以内，不登记。P5.3 证据的 P0 页面矩阵把 8 个环境的 session-attachment-staged 都列为这一类。协调者判定接受：P5.3 第 1 版证据的 CONFIRM（判定记录 61sATHPY66znwxRZorvP8d）第 1 条，已验收焦点约定的可见结果。出处：p5.3/README.md「合并检查与 P0」中 P0 页面矩阵 session-attachment-staged 一条与「未消除的差异」第 1 条；P5.3 第 1 版证据 compare/p0-summary.json 中该截图的像素数与最大级数，与本条 before → after 相同。"
MENU='P5.3 把会话工作区换成 Orbit 组件（业务切换 c868a02c2），手机上输入框的 + 菜单是 Orbit Menu 的附件变体（P2.2 的 attachment 变体，ui/Floating.css：250px 宽、42.4px 行高、17px 字、26px 圆角）。P0 session 场景在手机上点开 + 菜单后截取 session-attachment-menu：5 个菜单项（File、Image、Shell、Skill、Command）的标签在 after 中是 17px，即 P2.2 任务指定的字号；被替换的 AntD 菜单实际画的是 14px（P5.3 记录的计算样式：font-size 14px → 17px，line-height 22px → 26.71px）。Shell 一行的终端图标因纵向取整上移约 1px（P5.3 记录的纵向取整带来的图标小数位移）。菜单的盒、分隔线和其余 4 个图标相同。超过 2 级的差异只在 5 个标签（x 81–158、y 565–755）和 Shell 图标（x 39–55、y 657–674）上，单通道差至多 224（明色）或 158（暗色）；其余是这些字形边缘的 ≤2 级像素，WebKit 另有菜单四个圆角处 21（明色）、29（暗色）个 ≤2 级像素。协调者判定接受：P5.3 第 1 版证据的 CONFIRM（判定记录 61sATHPY66znwxRZorvP8d）第 1 条，P2.2 任务指定的 17px 附件变体。出处：p5.3/README.md「合并检查与 P0」中 P0 页面矩阵 session-attachment-menu 一条、「对照结果」中「手机附件菜单的字号」一行与「未消除的差异」第 5 条；P5.3 第 1 版证据 compare/p0-summary.json 中该截图的像素数、最大级数与 styleDeltas 的字号，与本条 before → after 相同。'
register "$STAGED_DESKTOP" chromium-light-desktop/session-attachment-staged.png webkit-light-desktop/session-attachment-staged.png
register "$STAGED_PHONE" chromium-light-phone/session-attachment-staged.png webkit-light-phone/session-attachment-staged.png
register "$MENU" chromium-dark-phone/session-attachment-menu.png chromium-light-phone/session-attachment-menu.png webkit-dark-phone/session-attachment-menu.png webkit-light-phone/session-attachment-menu.png
