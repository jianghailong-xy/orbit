#!/usr/bin/env bash
# ro-loop-variants.sh OUTDIR: choices.browser.mjs's "multiple labels search, toggle, collapse, remove and clear" case, the
# test itself (the delivery's spec file, its config, --repeat-each 5) in both WebKit phone projects, on four choices
# fixtures: the delivery and the base as they are, the delivery with a stand-in for the "Open legacy Modal" button the
# base still draws above the regions (same label, nothing behind it), and the base without that button. Scratch
# checkouts (v1/exp-del, v1/exp-base, ro-loop-pair.sh's), the edits undone after each variant; each run alone in a
# memory-capped scope and its own network namespace.
set -u
OUT=${1:?outdir}
V=/mnt/data/tmp/34Za39RS6A28G7xPqMD0p/v1
F=src/web/src/components/ui/__fixtures__/ChoicesFixture.tsx
S=src/web/ui-migration/choices.browser.mjs
export TMPDIR=$V/tmp
mkdir -p "$OUT"
for dir in $V/exp-del $V/exp-base; do git -C $dir checkout -q -- src/web; done
cp $V/exp-del/$S $V/exp-base/$S
variant() {
  local name=$1 dir=$2
  for i in $(seq 1 60); do [ "$(free -m | awk '/Mem:/{print $7}')" -ge 4608 ] && break; sleep 30; done
  { echo "tree: $dir ($(git -C $dir rev-parse --short HEAD))"; echo "edits:"; git -C $dir diff --stat -- src/web | sed 's/^/  /'; echo "load: $(cat /proc/loadavg)"; echo; } > "$OUT/$name.txt"
  ( cd $dir/src/web && rm -rf .choices-results && systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
      unshare -n bash -c 'ip link set lo up && exec "$@"' bash npx playwright test --config ui-migration/choices.config.mjs \
      --project webkit-light-phone --project webkit-dark-phone -g "multiple labels search, toggle, collapse, remove and clear" --repeat-each 5 ) >> "$OUT/$name.txt" 2>&1
  echo "exit=$?" >> "$OUT/$name.txt"
  cp $dir/src/web/.choices-results/report.json "$OUT/$name.report.json" 2>/dev/null
  echo "== $name: $(grep -E '^\s+[0-9]+ (passed|failed|flaky)' "$OUT/$name.txt" | tr -s ' ' | tr '\n' ' ') $(grep -c 'ResizeObserver loop' "$OUT/$name.txt") ResizeObserver lines"
}
variant delivery $V/exp-del
sed -i 's|        <Button onClick={() => setDialog(true)}>Open Dialog</Button>|&\n        <Button>Open legacy Modal</Button>|' $V/exp-del/$F
variant delivery-with-button $V/exp-del
git -C $V/exp-del checkout -q -- $F
variant base $V/exp-base
sed -i '/<Button onClick={() => setLegacy(true)}>Open legacy Modal<\/Button>/d' $V/exp-base/$F
variant base-without-button $V/exp-base
for dir in $V/exp-del $V/exp-base; do git -C $dir checkout -q -- src/web; done
echo "scratch trees restored: [$(git -C $V/exp-del status --short -- src/web | tr '\n' ' ')] [$(git -C $V/exp-base status --short -- src/web | tr '\n' ' ')]"
