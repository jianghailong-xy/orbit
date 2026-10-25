#!/usr/bin/env bash
# Control runs for T05's key-supply change: undo one half of it in the source, run the pg specs,
# put the file back byte for byte. Usage: mutant.sh supply|seed OUT
set -uo pipefail
cd /root/.orbit/worktrees/81f2311f-0c74-56b8-b768-795edee3c95c
which=$1; out=$2
case "$which" in
  supply)
    file=src/apiserver/src/managed-runners/managed-runner-manager.ts
    from='    const initialProvider = runtime ?? (await managedKeySupply(this.prisma, mapping.ownerId, report));'
    to='    const initialProvider = runtime; void managedKeySupply;'
    specs="src/apiserver/src/managed-runners/managed-runner-sign-in.pg.spec.ts src/apiserver/src/managed-runners/docker-backend.pg.spec.ts" ;;
  seed)
    file=src/apiserver/src/workspaces/workspace-provider.ts
    from='    if (r.managed_owner_id && !recordedEngine(r.provider)) {'
    to='    if (r.managed_owner_id && !recordedEngine(r.provider) && (false as boolean)) {'
    specs="src/apiserver/src/managed-runners/managed-runner-sign-in.pg.spec.ts" ;;
  *) echo "usage: mutant.sh supply|seed OUT"; exit 2 ;;
esac
before=$(sha256sum "$file" | cut -d' ' -f1)
cp "$file" "/mnt/data/tmp/t05-34ZtjTxQ/$(basename "$file").orig"
python3 - "$file" "$from" "$to" <<'EOF'
import sys
path, old, new = sys.argv[1:4]
text = open(path).read()
assert text.count(old) == 1, 'the line to undo is not there exactly once'
open(path, 'w').write(text.replace(old, new))
EOF
echo "mutant $which: $(git diff --stat -- "$file" | tail -1)"
git diff -U0 -- "$file" | grep -a -E '^[-+] ' | head -4
systemd-run --scope --quiet -p MemoryMax=6G -- bash -c "echo 1000 > /proc/self/oom_score_adj; bash scripts/run-pg-spec.sh $specs" > "$out" 2>&1
rc=$?
cp "/mnt/data/tmp/t05-34ZtjTxQ/$(basename "$file").orig" "$file"
after=$(sha256sum "$file" | cut -d' ' -f1)
[ "$before" = "$after" ] && echo "restored: $file sha256 $after" || { echo "NOT RESTORED: $file"; exit 3; }
grep -a -E '^==== |^RED|not ok [0-9]+ - \(' "$out" | head -20
echo "spec exit with the mutant: $rc"
