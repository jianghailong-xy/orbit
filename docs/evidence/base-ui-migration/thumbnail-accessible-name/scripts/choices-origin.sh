#!/usr/bin/env bash
# choices-origin.sh RUN GREP: the choices cases the delivery's full matrix failed (GREP, a regular expression over their
# titles), in all eight environments, on four trees, into v1/RUN/choices-origin/: the delivery (del), the reference
# (ref = the delivery with the fix reverted = origin/main 9274d5242's tree), and the two sides of P5.3's business switch
# c868a02c2 (pre = its parent 10e9c2bbf, at = c868a02c2). The fix touches neither the choices fixture nor the Menu; the
# question is where the reds start. formal.sh's step rules (own network namespace, 6G scope, / must keep 2 GB).
set -u
RUN=${1:?run name}; GREP=${2:?title pattern}
T=/mnt/data/tmp/34dTUqxH5MjymjtUhs5C5
V=$T/v1
R=$V/$RUN/choices-origin
WT=/root/.orbit/worktrees/815e244b-5a5b-5984-96fb-3b42c31b28ff
export TMPDIR=$V/tmp
mkdir -p "$R" "$TMPDIR"
link_modules() {
  ln -sfn "$WT/node_modules" "$1/node_modules"
  mkdir -p "$1/src/web/node_modules"
  cp -a "$WT/src/web/node_modules/@orbit" "$WT/src/web/node_modules/@types" "$1/src/web/node_modules/"
}
for pair in pre:10e9c2bbf at:c868a02c2; do
  name=${pair%%:*}; commit=${pair#*:}
  [ -d "$V/$name" ] || git -C "$WT" worktree add -q --detach "$V/$name" "$commit"
  link_modules "$V/$name"
done
step() {
  local name=$1 tree=$2
  if [ -f "$R/$name.txt" ] && grep -q '^exit=' "$R/$name.txt"; then echo "== $name already done ($(grep '^exit=' "$R/$name.txt"))"; return 0; fi
  local a; a=$(df --output=avail -BM / | tail -1 | tr -dc '0-9')
  if [ "$a" -lt 2048 ]; then echo "== STOP: / has ${a}M available (< 2 GB)"; exit 3; fi
  { echo "argv: npx playwright test --config ui-migration/choices.config.mjs --grep '$GREP'"; echo "tree: $tree"; echo "head: $(git -C $tree rev-parse HEAD)"
    echo "uncommitted:"; git -C $tree status --short -- src/web; echo "load: $(cat /proc/loadavg)"; echo "mem: $(free -m | awk '/Mem:/{print $7}')M available"
    echo "started: $(date -u +%FT%TZ)"; echo; } > "$R/$name.txt"
  echo "== $name $(date -u +%T)"
  ( cd "$tree/src/web" && systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
      nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash npx playwright test --config ui-migration/choices.config.mjs --grep "$GREP" ) >> "$R/$name.txt" 2>&1
  local code=$?
  { echo "exit=$code"; echo "load: $(cat /proc/loadavg)"; echo "ended: $(date -u +%FT%TZ)"; } >> "$R/$name.txt"
  mkdir -p "$R/$name-out" && cp "$tree/src/web/.choices-results/report.json" "$R/$name-out/" 2>/dev/null
  grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)|^exit=" "$R/$name.txt"
}
step del "$V/del"
step ref "$V/ref"
step pre "$V/pre"
step at "$V/at"
