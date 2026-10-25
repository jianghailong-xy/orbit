#!/usr/bin/env bash
# Usage: register.sh <runs dir>   (run in the worktree whose accepted/ registry is written)
# The p0-drift/tools/register-accepted.cjs calls of this registration, one per difference text (the P3.2 precedent).
# Decision: the WebKit scroll-lock batch (34cBi0yt6bFcSmbJFgDPj), evidence revision 1, which the coordinator CONFIRMed
# (decision record fRJrSzK3CevsTPV4xEki6); its evidenceDigest as task_evidence_list returns it; document
# webkit-scroll-lock/README.md. Same-commit originals: before = 15b7b5609 (the batch start, parent of its first commit
# 78cae80d9), after = b2568f28d (the merge that landed the batch on the project line, the project tip at the start).
# webkit-dark-phone/profile-validation has P4.1's accepted entry: the tool moves it into `previous`.
set -euo pipefail
REPO=${REPO:-$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)}
R=$1
cd "$REPO"
common=(--task 34cBi0yt6bFcSmbJFgDPj --revision 1 --digest fdb19816d1e31af2dc3463fe3e359c68b7ba86084f284f24009f8b92dc468e7c --document webkit-scroll-lock/README.md
  --before-commit 15b7b56093139c7b502e6618e9700ef78c9cccba --before-dir "$R/before-15b7b5609/snapshots" --before-env "$R/before-15b7b5609/environment.json"
  --after-commit b2568f28d8bb87d12eec762d1f810562503ed2d9 --after-dir "$R/after-b2568f28d/snapshots" --after-env "$R/after-b2568f28d/environment.json")
fix='WebKit 对话框滚动锁一批给 lib/toast.tsx 的读屏 live region 加了 position: fixed。它挂在 body 末尾，原先按 absolute 的静态位置排在视口下缘之外，第一次出通知后文档比视口高 1px，Linux WebKit 因全站 8px 的 ::-webkit-scrollbar 给文档画出滚动条；修复后文档始终一个视口高。P0 的 settings-saved、profile-validation、notification-error 都在出通知后截图，after 相对 before 只有两件事：（1）文档滚动条消失：before 右侧 8px 是没有绘制的透明列（RGBA 0,0,0,0），(0,0) 多一个灰点（明色 217,217,217，暗色 74,74,77），after 两者都没有，右侧 8px 是页面本身；（2）桌面主区按 1280 排而不是 1272：居中内容右移 4px，靠右内容和通知列（ToastViewport 按视口宽度定位）右移 8px，左侧导航不变；手机布局视口始终是 390，内容和通知都不动。'
source='出处：webkit-scroll-lock/README.md「P0 的影响：12 张 WebKit 截图，9 张需要重登」逐张说明表中该截图一行；协调者对该批第 1 版证据的 CONFIRM（判定记录 fRJrSzK3CevsTPV4xEki6）把这 9 张接受为该批的迁移差异。该批 compare/p0-changed-webkit.json 的不同像素数与 shots/p0/classes.json 的逐像素归类（灰 = 文档滚动条，蓝 = 右移 4px，绿 = 右移 8px，红 = 其它），与本条 before → after 相同。'
register() { node docs/evidence/base-ui-migration/p0-drift/tools/register-accepted.cjs "${common[@]}" --difference "$1" "${@:2}"; }
register "${fix}本截图：文档滚动条消失；设置卡片列右移 4px；“Setting saved”胶囊随通知列右移 8px，与 Chromium 桌面的位置一致；归为其它的几个像素（明 4、暗 2 个）在右移内容的边缘，与 before 右移 4px 后各通道只差 1 级，是抗锯齿。${source}" \
  webkit-dark-desktop/settings-saved.png webkit-light-desktop/settings-saved.png
register "${fix}本截图：文档滚动条消失；资料卡片列右移 4px；“Name saved”胶囊随通知列右移 8px，与 Chromium 桌面的位置一致；归为其它的 3 个像素（明暗都在 x 584）在右移内容的边缘，与 before 右移 4px 后各通道差 8 级以内，是抗锯齿。${source}" \
  webkit-dark-desktop/profile-validation.png webkit-light-desktop/profile-validation.png
register "${fix}本截图：文档滚动条消失；会话页消息列与输入框宽 8px，错误卡片、靠右的用户气泡和输入框右侧的模型与发送键右移 8px；归为其它的像素（明 253、暗 326 个）是错误卡片右移后露出的标题文字与卡片阴影边。${source}" \
  webkit-dark-desktop/notification-error.png webkit-light-desktop/notification-error.png
register "${fix}本截图：只有文档滚动条消失，右侧 8px 由透明变为页面（含 .app-view 自己的滚动条），(0,0) 一点；内容与通知都不动。明色手机的同一张变化相同，按 P0 比较器低于阈值（透明列按白色比较），不登记。${source}" \
  webkit-dark-phone/notification-error.png webkit-dark-phone/settings-saved.png
register "${fix}本截图：只有文档滚动条消失，右侧 8px 由透明变为页面（含 .app-view 自己的滚动条），(0,0) 一点；P4.1 接受的“Name saved”胶囊位置（x 127，按 390 宽排版）、文字与卡片都不变。被替换的当前期望是 P4.1 的接受条目（before 与它逐字节相同），该条目移入 previous。明色手机的同一张变化相同，按 P0 比较器低于阈值，不登记，仍是 P4.1 的接受条目。${source}" \
  webkit-dark-phone/profile-validation.png
