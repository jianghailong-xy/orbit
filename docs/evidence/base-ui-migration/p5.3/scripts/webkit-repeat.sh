#!/usr/bin/env bash
# webkit-repeat.sh TREE OUT REPEAT GREP PROJECTS...: the named P5.3 cases, each REPEAT times, in the given environments
# of one tree (ref = v1/dev-ref with the worktree's spec copied in, del = the task worktree). For the WebKit focus race.
set -u
T=/mnt/data/tmp/34Za39Ov1yysHZaYL6wgJ/v1
WT=/root/.orbit/worktrees/4071e471-3592-5308-a8bb-f597b81ac833
tree=$1; out=$2; repeat=$3; grep=$4; shift 4
export TMPDIR=$T/tmp
if [ "$tree" = ref ]; then dir=$T/dev-ref; for f in p53.browser.mjs p53-fixtures.mjs p53.config.mjs playwright.config.mjs; do cp "$WT/src/web/ui-migration/$f" "$dir/src/web/ui-migration/$f"; done; else dir=$WT; fi
rm -rf "$out"; mkdir -p "$out"
args=(--config ui-migration/p53.config.mjs --update-snapshots=all --repeat-each "$repeat" --grep "$grep" --workers 1)
for p in "$@"; do args+=(--project "$p"); done
port=4373; [ "$tree" = ref ] && port=4374
cd "$dir/src/web"
systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
  unshare -n bash -c 'ip link set lo up && exec "$@"' bash \
  env P53_PORT=$port P53_SNAPSHOTS="$out/shots" P53_OUTPUT="$out/out" npx playwright test "${args[@]}" > "$out/log.txt" 2>&1
echo "exit=$?"
grep -E "✘|passed|failed|flaky|Error:" "$out/log.txt" | head -30
