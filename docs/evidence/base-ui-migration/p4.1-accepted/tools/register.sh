#!/usr/bin/env bash
# Usage: register.sh <runs dir>   (run in the worktree whose accepted/ registry is written)
# The p0-drift/tools/register-accepted.cjs call of this registration: both screenshots share one difference text.
# Decision: P4.1 (34Za39Do3N6tkmIMP0GBP), evidence revision 1, which the coordinator CONFIRMed (decision record
# 6sLVdUrgEbiS5PlOAN8QoZ); its evidenceDigest as task_evidence_list returns it; document p4.1/README.md.
# Same-commit originals: before = a84bc61e7 (P4.1's start, the parent of its first delivered commit),
# after = 3aa26fb97 (the landed P4.1 delivery, the project tip when this registration started).
set -euo pipefail
REPO=${REPO:-$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)}
R=$1
cd "$REPO"
node docs/evidence/base-ui-migration/p0-drift/tools/register-accepted.cjs \
  --task 34Za39Do3N6tkmIMP0GBP --revision 1 --digest 9477611a4499f613621b9dcc7e7c99a7dce050f1caca7ffa22fd95ca60467d57 --document p4.1/README.md \
  --before-commit a84bc61e7913b1ecae26c0a5a74d4c4887454e99 --before-dir "$R/before-a84bc61e7/snapshots" --before-env "$R/before-a84bc61e7/environment.json" \
  --after-commit 3aa26fb97644f24551dc9c70149021f7f7f9453f --after-dir "$R/after-3aa26fb97/snapshots" --after-env "$R/after-3aa26fb97/environment.json" \
  --difference 'P4.1 把资料页的表单换成 Orbit 字段组件和原生表单。P0 profile 场景保存名字后截取 profile-validation：顶部“Name saved”通知胶囊在 after 中比 before 右移 4px（通知列宽 358 对 350，胶囊 x 127.14 对 123.14），差异只在胶囊及其阴影的区域。根因：lib/toast 第一次提示时往 body 末尾加读屏 live region，资料页文档从 844px 变成 845px；Linux WebKit 手机模拟里，全局 8px ::-webkit-scrollbar 让溢出之后才排版的固定定位元素按 382 宽排，之前排好的保持 390（P2.3-B1 复现过的现象）。before 的 AntD 表单在 live region 与通知列插入之间读了 4 个 .ant-form-item 的 offsetParent，这次同步布局先看到了溢出，通知列按 382 排；Orbit 的 Field 不读布局，通知列按溢出前的 390 排，与 Chromium 手机、与设置页“Setting saved”的位置一致。由测试注入一次布局读取后，after 与 P0 期望（即 before）逐像素一致。真机 iOS 用覆盖式滚动条，不受影响。协调者判定接受为本批的迁移差异，不为测试环境复刻那次布局读取。出处：p4.1/README.md「P0 页面矩阵（同提交）」profile-validation 行与「WebKit 手机 profile-validation：根因与隔离」；P4.1 第 1 版证据 compare/f-p0-compare.json 中该截图的像素数与最大级数，与本条 before → after 相同。' \
  webkit-dark-phone/profile-validation.png webkit-light-phone/profile-validation.png
