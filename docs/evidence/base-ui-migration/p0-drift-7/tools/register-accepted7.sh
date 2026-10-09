#!/usr/bin/env bash
# Usage: register-accepted7.sh <step>   (run in the worktree whose accepted/ registry is written: $B/wt/reg)
# The p0-drift/tools/register-accepted.cjs calls of batch 7, one per difference text, as webkit-scroll-lock-accepted's
# tools/register.sh. Accepted-layer rule 6, second case: X's tree already holds the page's accepted migration code, so
# the main drift layer is not updated; before = X's first-parent predecessor, after = X; each entry cites its original
# CONFIRM decision (read here from the registry entry that carries it, never retyped) and the tool moves the old entry
# into `previous`.
#  step a12: X = main cbe6a6635 (Merge refs/heads/project/34aithLozDanSv6nq0IAi into refs/heads/main, which brings in
#            33e0e2e09 feat(web): Runners and Providers become one Infrastructure page); before fce12bc2a.
#  step a13: X = main 3960c19c2 (feat(web): copy · time under each finished turn's reply); before d976df772.
# Three screenshots get a first entry rather than a re-registration: their current expectation is a main drift
# reference or the P0.2 original plus a below-threshold difference the coordinator CONFIRMed with its batch but the
# tool could not take (P3.2: the dark task-action-menu; the WebKit scroll lock: the light-phone notification-error).
# Every main tree with X carries that migration difference, so a main drift reference regenerated on X's tree would
# hold migration pixels; the main change is stacked on it here instead, citing the same decision.
set -euo pipefail
B=/mnt/data/tmp/34cswWfvNasFTq8kDM0Q4
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
LOCK=$(decision webkit-dark-phone/notification-error.png)
src='归因证据（main 漂移规则 (a)–(c)）和逐张数据见 p0-drift-7/README.md「归因」与 attribution/attribution.json；同提交原件的运行见 p0-drift-7/attribution/runs/。'
case "$1" in
a12)
  pair=(--before-commit "$(git rev-parse fce12bc2a)" --before-dir "$R/full-fce12bc2a/snapshots" --before-env "$R/full-fce12bc2a/environment.json"
        --after-commit "$(git rev-parse cbe6a6635)" --after-dir "$R/full-cbe6a6635/snapshots" --after-env "$R/full-cbe6a6635/environment.json")
  side='叠在已接受差异上的 main 改动（已接受层第 6 条第二种情况）：main cbe6a6635（Merge refs/heads/project/34aithLozDanSv6nq0IAi into refs/heads/main，项目线 first-parent 上的提交）合入 33e0e2e09（feat(web): Runners and Providers become one Infrastructure page），桌面侧栏的 Runners、Providers 两行合成一行 Infrastructure，其下各段上移一行（36px）。X 的树已含该页面的迁移代码，所以不更新 main 漂移层：before 是 X 的 first-parent 前驱 fce12bc2a，after 是 X 的树 cbe6a6635。'
  # shellcheck disable=SC2086
  node $E/p0-drift/tools/register-accepted.cjs $P32 "${pair[@]}" --difference "${side}本截图：before 与当前已接受期望（P3.2 的 after 原件）逐字节相同；before → after 只在侧栏列（x 16–262、y 172–391）变化，分享对话框的遮罩下侧栏同样变化，对话框本身和 P3.2 接受的焦点约定、Share… 行高差都不变。原判定：P3.2 第 2 版证据的 CONFIRM，旧条目在 previous。${src}" \
    chromium-dark-desktop/task-share-dialog.png chromium-light-desktop/task-share-dialog.png webkit-dark-desktop/task-share-dialog.png webkit-light-desktop/task-share-dialog.png
  node $E/p0-drift/tools/register-accepted.cjs $P32 "${pair[@]}" --difference "${side}本截图：before 与当前已接受期望（P3.2 的 after 原件）逐字节相同；before → after 只在侧栏列（x 16–262、y 172–391）变化，More 菜单与 P3.2 接受的打开即聚焦约定不变。原判定：P3.2 第 2 版证据的 CONFIRM，旧条目在 previous。${src}" \
    chromium-light-desktop/task-action-menu.png webkit-light-desktop/task-action-menu.png
  node $E/p0-drift/tools/register-accepted.cjs $P32 "${pair[@]}" --difference "${side}本截图此前没有已接受条目：P3.2 让深色 task-action-menu 的菜单变化低于 P0 比较器阈值（p3.2-accepted 逐张列出，登记工具不收），含 cbe6a6635 的每一棵 main 树都带着它，在 X 的树上重新生成 main 漂移参考会把这部分迁移像素放进 main 漂移层，所以按同一判定叠在其上登记。before 对照当前期望（第 1 批 A4 的 main 漂移参考）只差 P3.2 记录的菜单像素（Chromium 466、WebKit 489 个，单通道差 45，比较器通过）；before → after 只在侧栏列（x 16–262、y 172–391）变化。原判定：P3.2 第 2 版证据的 CONFIRM。${src}" \
    chromium-dark-desktop/task-action-menu.png webkit-dark-desktop/task-action-menu.png
  node $E/p0-drift/tools/register-accepted.cjs $LOCK "${pair[@]}" --difference "${side}本截图：before 与当前已接受期望（WebKit 滚动锁一批的 after 原件）逐字节相同；before → after 只在侧栏列（x 16–262、y 172–391）变化，设置卡片列、胶囊与通知列的位置，以及文档滚动条的消失都不变。原判定：WebKit 滚动锁一批第 1 版证据的 CONFIRM（判定记录 fRJrSzK3CevsTPV4xEki6），旧条目在 previous。${src}" \
    webkit-dark-desktop/settings-saved.png webkit-light-desktop/settings-saved.png
  node $E/p0-drift/tools/register-accepted.cjs $LOCK "${pair[@]}" --difference "${side}本截图：before 与当前已接受期望（WebKit 滚动锁一批的 after 原件）逐字节相同；before → after 只在侧栏列（x 16–262、y 172–391）变化，资料卡片列、“Name saved”胶囊和文档滚动条的消失都不变。原判定：WebKit 滚动锁一批第 1 版证据的 CONFIRM（判定记录 fRJrSzK3CevsTPV4xEki6），旧条目在 previous。${src}" \
    webkit-dark-desktop/profile-validation.png webkit-light-desktop/profile-validation.png
  node $E/p0-drift/tools/register-accepted.cjs $LOCK "${pair[@]}" --difference "${side}本截图：before 与当前已接受期望（WebKit 滚动锁一批的 after 原件）逐字节相同；before → after 只在侧栏列（x 8–270、y 172–391）变化：会话页侧栏里选中的工作区一行随之上移，所以比其它页面多出这一行。消息列、错误卡片与文档滚动条的消失都不变。原判定：WebKit 滚动锁一批第 1 版证据的 CONFIRM（判定记录 fRJrSzK3CevsTPV4xEki6），旧条目在 previous。${src}" \
    webkit-dark-desktop/notification-error.png webkit-light-desktop/notification-error.png
  ;;
a13)
  pair=(--before-commit "$(git rev-parse d976df772)" --before-dir "$R/full-d976df772/snapshots" --before-env "$R/full-d976df772/environment.json"
        --after-commit "$(git rev-parse 3960c19c2)" --after-dir "$R/full-3960c19c2/snapshots" --after-env "$R/full-3960c19c2/environment.json")
  foot='叠在已接受差异上的 main 改动（已接受层第 6 条第二种情况）：main 3960c19c2（feat(web): copy · time under each finished turn'"'"'s reply，main first-parent 上的单个提交，经项目线 17980cb7c 吸收 main 87351bf9a 进入）在每个结束的回合下面加一行复制键和结束时间（12:00 PM），取代原来 12px 的空白分隔，其下的内容随之下移。X 的树已含该页面的迁移代码（WebKit 滚动锁修复），所以不更新 main 漂移层：before 是 X 的 first-parent 前驱 d976df772，after 是 X 的树 3960c19c2。之后的 main 9d3751ec2（输入框上方的分隔线改为渐隐）对本截图的变化低于 P0 比较器阈值，登记工具不收，记在 p0-drift-7。'
  node $E/p0-drift/tools/register-accepted.cjs $LOCK "${pair[@]}" --difference "${foot}本截图：before 复现当前已接受期望（第 7 批 A12 那一条的 after 原件）；before → after 只在消息列（x ≥ 621）变化，侧栏、错误卡片的位置与文档滚动条的消失都不变。原判定：WebKit 滚动锁一批第 1 版证据的 CONFIRM（判定记录 fRJrSzK3CevsTPV4xEki6），旧条目在 previous。${src}" \
    webkit-dark-desktop/notification-error.png webkit-light-desktop/notification-error.png
  node $E/p0-drift/tools/register-accepted.cjs $LOCK "${pair[@]}" --difference "${foot}本截图：before 与当前已接受期望（WebKit 滚动锁一批的 after 原件）逐字节相同或只在噪声范围内；before → after 只在消息列变化，文档滚动条的消失不变。原判定：WebKit 滚动锁一批第 1 版证据的 CONFIRM（判定记录 fRJrSzK3CevsTPV4xEki6），旧条目在 previous。${src}" \
    webkit-dark-phone/notification-error.png
  node $E/p0-drift/tools/register-accepted.cjs $LOCK "${pair[@]}" --difference "${foot}本截图此前没有已接受条目：WebKit 滚动锁一批让 WebKit 明色手机的 notification-error 只差文档滚动条那 8px 一列与 (0,0) 一点，低于 P0 比较器阈值，判定写明不登记（webkit-scroll-lock-accepted「未登记的截图」），含 3960c19c2 的每一棵 main 树都带着它，在 X 的树上生成 main 漂移参考会把这部分迁移像素放进 main 漂移层，所以按同一判定叠在其上登记。before 对照当前期望（P0.2 原图）只差这一列和一点（比较器通过）；before → after 在消息列变化。原判定：WebKit 滚动锁一批第 1 版证据的 CONFIRM（判定记录 fRJrSzK3CevsTPV4xEki6）。${src}" \
    webkit-light-phone/notification-error.png
  ;;
*) echo "usage: $0 a12|a13"; exit 2 ;;
esac
