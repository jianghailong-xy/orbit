#!/usr/bin/env bash
# Usage: register-accepted8.sh <step>   (run in the worktree whose accepted/ registry is written: $B/wt/reg)
# The p0-drift/tools/register-accepted.cjs calls of batch 8, one per difference text, as batch 7's register-accepted7.sh.
# Accepted-layer rule 6, second case: X's tree already holds the page's accepted migration code, so the main drift layer is
# not updated; before = X's first-parent predecessor, after = X; each entry cites its original CONFIRM decision (read here
# from the registry entry that carries it, never retyped) and the tool moves the old entry into `previous`.
#  step a15: X = main 46e28aaa3 (Merge refs/heads/project/34d0oH4R6LErqqsox7wYv into refs/heads/main, which brings in
#            83671b995 feat(clients): the session list shows the server's recap, behind one account switch); before 56c21bdd2.
#  step a16: X = main e69765706 (Merge refs/heads/project/34ccMg4EoSorpVooMC4kg into refs/heads/main, which brings in T7:
#            3a3c58c1f and e2e5196f0, the task panel's Engine row); before 46e28aaa3.
#  step a17: X = main d2e295917 (feat(web): a worked-for row at the head of every turn, over its own output); before c26b69643.
# Ten screenshots get a first entry rather than a re-registration (as batch 7 did for three): their current expectation is a
# main drift reference plus a below-threshold difference the coordinator CONFIRMed with its batch but the tool could not take
# (P3.2: the dark phone task-action-menu, webkit-dark-phone's task-detail/hover/focus, WebKit desktop breakpoint-599/601-dialog;
# the WebKit scroll lock: the light-phone settings-saved). Every main tree with X carries that migration difference, so a main
# drift reference regenerated on X's tree would hold migration pixels; the main change is stacked on it here instead, citing
# the same decision.
set -euo pipefail
B=/mnt/data/tmp/34dI9lY63LC7ZEZHbJ4bG
REPO=$(git rev-parse --show-toplevel)
cd "$REPO"
E=docs/evidence/base-ui-migration
R=$B/runs
decision() {  # --task/--revision/--digest/--document of the registry entry for $1
  python3 - "$E/p0-drift/accepted/registry.json" "$1" <<'PY'
import json, sys
e = next(x for x in json.load(open(sys.argv[1]))['screenshots'] if x['screenshot'] == sys.argv[2])['decision']
assert e['verdict'] == 'CONFIRM'
print(f"--task {e['taskId']} --revision {e['evidenceRevision']} --digest {e['evidenceDigest']} --document {e['document']}")
PY
}
P32=$(decision chromium-light-desktop/task-share-dialog.png)
LOCK=$(decision webkit-dark-phone/settings-saved.png)
pair() {  # before/after runs
  echo --before-commit "$(git rev-parse "$1")" --before-dir "$R/full-$1/snapshots" --before-env "$R/full-$1/environment.json" \
       --after-commit "$(git rev-parse "$2")" --after-dir "$R/full-$2/snapshots" --after-env "$R/full-$2/environment.json"
}
src='归因证据（main 漂移规则 (a)–(c)）和逐张数据见 p0-drift-8/README.md「归因」与 attribution/attribution.json；同提交原件的运行见 p0-drift-8/attribution/runs/。'
LOCKD='原判定：WebKit 滚动锁一批第 1 版证据的 CONFIRM（判定记录 fRJrSzK3CevsTPV4xEki6）'
P32D='原判定：P3.2 第 2 版证据的 CONFIRM'
case "$1" in
a15)
  # shellcheck disable=SC2046
  set -- $(pair 56c21bdd2 46e28aaa3)
  side='叠在已接受差异上的 main 改动（已接受层第 6 条第二种情况）：main 46e28aaa3（Merge refs/heads/project/34d0oH4R6LErqqsox7wYv into refs/heads/main，经项目线 cb35d126a 吸收 main 进入，两者树相同）合入 83671b995（feat(clients): the session list shows the server'"'"'s recap, behind one account switch），设置页 Session defaults 卡片在 Suggested replies 下面多出一行 Session recaps 开关，其下的内容随之下移（桌面 80px）。X 的树已含该页面的迁移代码（P4.1 的设置页、WebKit 滚动锁修复），所以不更新 main 漂移层：before 是 X 的 first-parent 前驱 56c21bdd2，after 是 X 的树 46e28aaa3。'
  node $E/p0-drift/tools/register-accepted.cjs $LOCK "$@" --difference "${side}本截图：before 与当前已接受期望（第 7 批 A12 那一条的 after 原件）逐字节相同；before → after 只在设置卡片列和页面自己的滚动条（x 496–1279、y 408–899）变化：Session recaps 一行及其下的内容，以及页面变长后 .app-view 滚动条变短的滑块。侧栏、“Setting saved”胶囊与通知列的位置、文档滚动条的消失都不变。${LOCKD}，旧条目在 previous。${src}" \
    webkit-dark-desktop/settings-saved.png webkit-light-desktop/settings-saved.png
  node $E/p0-drift/tools/register-accepted.cjs $LOCK "$@" --difference "${side}本截图：before 与当前已接受期望（WebKit 滚动锁一批的 after 原件）逐字节相同；before → after 只在设置卡片列和页面自己的滚动条（x 16–389、y 353–843）变化：Session recaps 一行及其下的内容，以及页面变长后 .app-view 滚动条变短的滑块。“Setting saved”胶囊和文档滚动条的消失都不变。${LOCKD}，旧条目在 previous。${src}" \
    webkit-dark-phone/settings-saved.png
  node $E/p0-drift/tools/register-accepted.cjs $LOCK "$@" --difference "${side}本截图此前没有已接受条目：WebKit 滚动锁一批让 WebKit 明色手机的 settings-saved 只差文档滚动条那 8px 一列与 (0,0) 一点，低于 P0 比较器阈值，判定写明不登记（webkit-scroll-lock-accepted「未登记的截图」），含 46e28aaa3 的每一棵 main 树都带着它，在 X 的树上重新生成 main 漂移参考会把这部分迁移像素放进 main 漂移层，所以按同一判定叠在其上登记（第 7 批对 notification-error 的做法）。before 对照当前期望（第 5 批 A11 的 main 漂移参考）只差这一列和一点（6753 个像素，比较器通过）；before → after 只在设置卡片列和页面自己的滚动条（x 16–389、y 353–843）变化：Session recaps 一行及其下的内容，以及 .app-view 滚动条变短的滑块。${LOCKD}。${src}" \
    webkit-light-phone/settings-saved.png
  ;;
a16)
  # shellcheck disable=SC2046
  set -- $(pair 46e28aaa3 e69765706)
  side='叠在已接受差异上的 main 改动（已接受层第 6 条第二种情况）：main e69765706（Merge refs/heads/project/34ccMg4EoSorpVooMC4kg into refs/heads/main，经项目线 2fcd654d8 吸收 main c26b69643 进入）合入 T7 的 3a3c58c1f（feat(web): sessions, tasks and workspaces pick the engine, then a provider it runs）与 e2e5196f0（fix(web): the task pin lists account pools; the engine list fits its names），任务详情的 Details 在 Assignee 下面多出一行 Engine（灰字 Codex），原来写着 Codex 的 Provider 一行改为 Sign-in on Baseline runner，其下的内容随之下移约 32px。X 的树已含该页面的迁移代码（P3.2 的任务详情与分享对话框），所以不更新 main 漂移层：before 是 X 的 first-parent 前驱 46e28aaa3，after 是 X 的树 e69765706。'
  node $E/p0-drift/tools/register-accepted.cjs $P32 "$@" --difference "${side}本截图：before 与当前已接受期望（第 7 批 A12 那一条的 after 原件）逐字节相同；before → after 只在任务面板列（x 615–1279、y 291–842）变化：分享对话框的遮罩下，任务面板的 Details 多出 Engine 一行、其下内容下移。对话框本身和 P3.2 接受的焦点约定、Share… 行高差都不变。${P32D}，旧条目在 previous。${src}" \
    chromium-dark-desktop/task-share-dialog.png chromium-light-desktop/task-share-dialog.png webkit-dark-desktop/task-share-dialog.png webkit-light-desktop/task-share-dialog.png
  node $E/p0-drift/tools/register-accepted.cjs $P32 "$@" --difference "${side}本截图：before 与当前已接受期望（P3.2 的 after 原件）逐字节相同；before → after 只在底部对话框上方露出的任务面板（x 0–389、y 375–731）变化：Details 多出 Engine 一行、其下内容下移。对话框本身和 P3.2 接受的焦点约定都不变。${P32D}，旧条目在 previous。${src}" \
    chromium-dark-phone/task-share-dialog.png chromium-light-phone/task-share-dialog.png webkit-dark-phone/task-share-dialog.png webkit-light-phone/task-share-dialog.png
  node $E/p0-drift/tools/register-accepted.cjs $P32 "$@" --difference "${side}本截图：before 与当前已接受期望逐字节相同（桌面是第 7 批 A12 那一条的 after 原件，手机是 P3.2 的 after 原件）；before → after 只在 Details 区（桌面 x 615–1279、y 199–842，手机 x 0–389、y 278–731）变化：Engine 一行和其下下移的内容。More 菜单与 P3.2 接受的打开即聚焦约定不变。${P32D}，旧条目在 previous。${src}" \
    chromium-dark-desktop/task-action-menu.png chromium-light-desktop/task-action-menu.png webkit-dark-desktop/task-action-menu.png webkit-light-desktop/task-action-menu.png \
    chromium-light-phone/task-action-menu.png webkit-light-phone/task-action-menu.png
  node $E/p0-drift/tools/register-accepted.cjs $P32 "$@" --difference "${side}本截图此前没有已接受条目：P3.2 让深色 task-action-menu 的菜单变化低于 P0 比较器阈值（p3.2-accepted 逐张列出，登记工具不收），含 e69765706 的每一棵 main 树都带着它，在 X 的树上重新生成 main 漂移参考会把这部分迁移像素放进 main 漂移层，所以按同一判定叠在其上登记（第 7 批对深色桌面同一截图的做法）。before 对照当前期望（第 1 批 A4 的 main 漂移参考）只差 P3.2 记录的菜单像素（Chromium 627、WebKit 655 个，单通道差 45，比较器通过）；before → after 只在 Details 区（x 0–389、y 278–731）变化：Engine 一行和其下下移的内容。${P32D}。${src}" \
    chromium-dark-phone/task-action-menu.png webkit-dark-phone/task-action-menu.png
  node $E/p0-drift/tools/register-accepted.cjs $P32 "$@" --difference "${side}本截图此前没有已接受条目：P3.2 让 webkit-dark-phone 的任务详情变化低于 P0 比较器阈值（66 个像素、单通道差 1，在 x 338–349、y 246–290；p3.2-accepted 逐张列出，登记工具不收），含 e69765706 的每一棵 main 树都带着它，在 X 的树上重新生成 main 漂移参考会把这部分迁移像素放进 main 漂移层，所以按同一判定叠在其上登记。before 对照当前期望（第 1 批 A4 的 main 漂移参考）只差这 66 个像素（比较器通过）；before → after 只在 Details 区（x 0–389、y 278–731）变化：Engine 一行和其下下移的内容。${P32D}。${src}" \
    webkit-dark-phone/task-detail.png webkit-dark-phone/task-action-hover.png webkit-dark-phone/task-action-focus.png
  node $E/p0-drift/tools/register-accepted.cjs $P32 "$@" --difference "${side}本截图此前没有已接受条目：P3.2 让 WebKit 桌面 599/601px 分享对话框的截图变化低于 P0 比较器阈值（明色 8、暗色 11 个像素，单通道差 1；p3.2-accepted 逐张列出，登记工具不收），含 e69765706 的每一棵 main 树都带着它，在 X 的树上重新生成 main 漂移参考会把这部分迁移像素放进 main 漂移层，所以按同一判定叠在其上登记。before 对照当前期望（第 1 批 A4 的 main 漂移参考）只差这几个像素（比较器通过）；before → after 只在分享对话框遮罩下的任务面板（599px：x 0–598、y 251–814；601px：x 0–600、y 199–814）变化：Details 多出 Engine 一行、其下内容下移，对话框本身不变。${P32D}。${src}" \
    webkit-dark-desktop/breakpoint-599-dialog.png webkit-light-desktop/breakpoint-599-dialog.png webkit-dark-desktop/breakpoint-601-dialog.png webkit-light-desktop/breakpoint-601-dialog.png
  ;;
a17)
  # shellcheck disable=SC2046
  set -- $(pair c26b69643 d2e295917)
  head='叠在已接受差异上的 main 改动（已接受层第 6 条第二种情况）：main d2e295917（feat(web): a worked-for row at the head of every turn, over its own output，main first-parent 上的单个提交，经项目线 d354b64c5 吸收 main 9498167b9 进入）在每个结束的回合上方、助手回复之前加一行“Worked for 1s”，其下的内容随之下移。X 的树已含该页面的迁移代码（WebKit 滚动锁修复），所以不更新 main 漂移层：before 是 X 的 first-parent 前驱 c26b69643，after 是 X 的树 d2e295917。'
  node $E/p0-drift/tools/register-accepted.cjs $LOCK "$@" --difference "${head}本截图：before 复现当前已接受期望（第 7 批 A13 那一条的 after 原件；之间只差第 7 批记录的 A14 低于阈值的渐隐）；before → after 只在消息列（x 633–1259、y 183–519）变化：Worked for 一行和其下下移的回复、脚注与错误卡片。侧栏、输入框与文档滚动条的消失都不变。${LOCKD}，旧条目在 previous。${src}" \
    webkit-dark-desktop/notification-error.png webkit-light-desktop/notification-error.png
  node $E/p0-drift/tools/register-accepted.cjs $LOCK "$@" --difference "${head}本截图：before 复现当前已接受期望（第 7 批 A13 那一条的 after 原件；之间只差第 7 批记录的 A14 低于阈值的渐隐）；before → after 只在消息列（x 26–375、y 222–576）变化：Worked for 一行和其下下移的回复、脚注与错误卡片。输入框与文档滚动条的消失都不变。${LOCKD}，旧条目在 previous。${src}" \
    webkit-dark-phone/notification-error.png webkit-light-phone/notification-error.png
  ;;
*) echo "usage: $0 a15|a16|a17"; exit 2 ;;
esac
