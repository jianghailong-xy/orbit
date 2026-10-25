#!/usr/bin/env bash
# The project's merge check in the Orbit session worktree, on the root NVMe disk (coordinator, 2026-10-09: the copy
# on /mnt/data, an HDD, timed out in Vitest). usage: merge-check-nvme.sh <label>
# The same command and wrapper as queue.sh's merge-check step (own network namespace, nice -10); only the disk differs.
# The dependency overlay is laid down first and removed by hand afterwards; raw output goes to runs/<label>.
set -u
ORBIT=/root/.orbit/worktrees/99d0ce19-f5db-5601-9902-ce52eaa1f17a
B=/mnt/data/tmp/overlay-first-frame-34brok
label=$1
out=$B/runs/$label
[ -e "$out/meta.json" ] && { echo "$label recorded; skipped"; exit 0; }
mkdir -p "$out"
cmd='npm run build -w @orbit/web && npm run test -w @orbit/web'
cd "$ORBIT"
bash scripts/worktree-overlay.sh > "$out/overlay.txt" 2>&1 || { echo "overlay failed, see $out/overlay.txt"; exit 2; }
df -BM "$ORBIT" > "$out/disk.txt"
start=$(date -u +%FT%TZ); load=$(cut -d' ' -f1-3 /proc/loadavg)
echo "$start $label in $ORBIT: $cmd"
unshare -n bash -c "ip link set lo up && NO_COLOR=1 nice -n -10 bash -c \"$cmd\"" > "$out/output.txt" 2>&1
code=$?
python3 - "$out/meta.json" "$ORBIT" "$label" "$cmd" "$start" "$load" "$code" <<'EOF'
import datetime, hashlib, json, subprocess, sys
path, tree, label, command, start, load, code = sys.argv[1:]
git = lambda *a: subprocess.run(['git', '-C', tree, *a], capture_output=True, text=True).stdout.strip()
diff = subprocess.run(['git', '-C', tree, 'diff', 'HEAD', '--', 'src/web'], capture_output=True).stdout
json.dump({'label': label, 'step': 'merge-check', 'tree': tree, 'disk': 'root NVMe (/dev/nvme0n1p3)', 'command': command,
           'commit': git('rev-parse', 'HEAD'), 'webChanges': git('status', '--porcelain', '--', 'src/web').splitlines(),
           'webDiffSha256': hashlib.sha256(diff).hexdigest(), 'startedAt': start,
           'endedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
           'loadAverage': {'start': load, 'end': ' '.join(open('/proc/loadavg').read().split()[:3])}, 'exitCode': int(code)},
          open(path, 'w'), indent=1)
EOF
echo "$(date -u +%FT%TZ) $label exit $code"
exit $code
