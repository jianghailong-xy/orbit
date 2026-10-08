#!/usr/bin/env bash
# collect.sh DEST — copy a run's evidence out of the stack directory: every scenario's log and screenshots, the
# runners' and the fake Kimi's logs, the run summary, and SHA256SUMS. Never the files that hold credentials
# (accounts.json, secrets.env, fake-kimi-state.json) — the fake Kimi's request log names tokens by hash only.
set -euo pipefail
S=$(realpath -m "${KIMI_STACK_DIR:-/var/tmp/kimi-accounts-stack}")
DEST=${1:?destination directory}
mkdir -p "$DEST/logs"
cp -r "$S/shots/." "$DEST/"
for f in seed.log runner-hpc-kimi.log runner-old-kimi.log fake-kimi-hpc-kimi.jsonl fake-kimi-old-kimi.jsonl \
         fake-kimi-requests.jsonl runner-nocap.diff migrate.log; do
  [ -f "$S/logs/$f" ] && cp "$S/logs/$f" "$DEST/logs/"
done
for n in 1 2 3 4 5 6; do
  [ -f "$S/logs/run-scenario$n.out" ] && grep -v 'destroyOnClose\|Warning: \[antd' "$S/logs/run-scenario$n.out" > "$DEST/logs/run-scenario$n.out"
done
cp "$S/seed.json" "$DEST/logs/seed.json"
# nothing secret may leave the stack
! grep -rIl -e '"password":"[^<]' -e 'fk_at_' -e 'fk_rt_' -e 'JWT_SECRET' "$DEST" || { echo "collect.sh: a secret would be copied" >&2; exit 1; }
(cd "$DEST" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS)
echo "collected into $DEST: $(find "$DEST" -type f | wc -l) files, $(du -sh "$DEST" | cut -f1)"
