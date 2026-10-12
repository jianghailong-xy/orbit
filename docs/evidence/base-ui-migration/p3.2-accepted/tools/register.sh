#!/usr/bin/env bash
# Usage: register.sh <runs dir>   (run in the worktree whose accepted/ registry is written)
# The three p0-drift/tools/register-accepted.cjs calls of this registration: one per difference text.
# Decision: P3.2 (34Za39ACSBoCkYKc80Md8), evidence revision 2, the latest, which the coordinator CONFIRMed;
# its evidenceDigest as task_evidence_list returns it; document p3.2/README.md. Same-commit originals:
# before = fffcdb532 (the project tip P3.2 landed on), after = 2925958ae (the project tip at the start).
set -euo pipefail
REPO=$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)
R=$1
cd "$REPO"
common=(--task 34Za39ACSBoCkYKc80Md8 --revision 2 --digest 302ca1f5051c1f3fd04abf89c1dff51c86cfbdcb9326fc3f7abf70e9ee9809bc --document p3.2/README.md
  --before-commit fffcdb532ef380d7b43ee87cbbd4e3316c5c24b8 --before-dir "$R/before-fffcdb532/snapshots" --before-env "$R/before-fffcdb532/environment.json"
  --after-commit 2925958aed739d386ac4c79d3bd766ac7e221999 --after-dir "$R/after-2925958ae/snapshots" --after-env "$R/after-2925958ae/environment.json")
menu='P3.2 把任务面板的 More 菜单换成 Orbit Menu（P2.2 约定：打开后焦点移入菜单）。旧菜单打开后焦点留在 More 按钮上，所以 before 的 More 按钮有焦点环；Orbit Menu 把焦点移入菜单，after 的 More 按钮没有焦点环。菜单本身的位置、尺寸与文字与旧组件一致。'
menuSource='出处：p3.2/README.md「P0 页面矩阵（同提交对照）」task-action-menu 行与「未消除的差异」第 6 条（焦点约定）；第 2 版证据 r2c-p0-task-compare.json 中该截图的像素数与最大级数，与本条 before → after 相同。'
node docs/evidence/base-ui-migration/p0-drift/tools/register-accepted.cjs "${common[@]}" \
  --difference 'P3.2 把分享对话框换成 Orbit Dialog（P2.1 约定：打开时聚焦对话框本身）。P0 task 场景打开分享对话框后按一次 Tab：旧对话框先聚焦 Close、Tab 到 Access；Orbit 先聚焦对话框、Tab 到 Close。截图上超过抗锯齿级的差异只有焦点环的位置：before 在 Access 按钮（Anyone with the link）上，after 在右上角的 Close 按钮上；其余是每通道不超过 2 级的抗锯齿级差异（Chromium 手机上遍及对话框区域）。出处：p3.2/README.md「P0 页面矩阵（同提交对照）」task-share-dialog 行与「未消除的差异」第 6 条（焦点约定）；第 2 版证据 r2c-p0-task-compare.json 中该截图的像素数与最大级数，与本条 before → after 相同。' \
  chromium-dark-desktop/task-share-dialog.png chromium-dark-phone/task-share-dialog.png chromium-light-desktop/task-share-dialog.png chromium-light-phone/task-share-dialog.png \
  webkit-dark-desktop/task-share-dialog.png webkit-dark-phone/task-share-dialog.png webkit-light-desktop/task-share-dialog.png webkit-light-phone/task-share-dialog.png
node docs/evidence/base-ui-migration/p0-drift/tools/register-accepted.cjs "${common[@]}" --difference "$menu$menuSource" \
  chromium-light-desktop/task-action-menu.png chromium-light-phone/task-action-menu.png
node docs/evidence/base-ui-migration/p0-drift/tools/register-accepted.cjs "${common[@]}" \
  --difference "${menu}WebKit 另有 “Share…” 菜单项地球图标底行约 30 像素的差异：Vite 的 CSS 压缩器把行高 1.5714285714285714 写成 1.57143，WebKit 偶尔多出 1/64px 行高（「未消除的差异」第 5 条）。$menuSource" \
  webkit-light-desktop/task-action-menu.png webkit-light-phone/task-action-menu.png
