#!/usr/bin/env bash
# Is the pilot's one screenshot difference between the trees noise? The difference is the panel's close icon in
# chromium-light-desktop's pilot-delete-confirm.png (x 1246-1247, y 28-39): both before-fix runs show one edge
# state, both final runs another, while chromium-dark-desktop shows two states at the same pixels within each tree.
# The pilot test that takes it ("fields, pickers and the panel header") runs five times on each tree in both desktop
# projects, after the given process (the final queue) has ended, one run at a time, each with at least 6 GB free on /:
#   final   the tree as it is (aed0a7bab's sources);
#   prefix  Overlay.tsx, Select.tsx and Menu.tsx from 0638f1944 in the working tree only, rebuilt; put back and
#           rebuilt afterwards (a run killed in between cannot do that itself, so the script puts them back first).
# Each run's screenshots go to /var/tmp/kw2-246921c8/pilot-repeat/<tree>-<n>; pilot-repeat.csv here gets, per run and
# project, the SHA-256 of the close icon's pixels (x 1240-1253, y 24-41) and of the whole image; the other files of
# the run are deleted. Usage: pilot-repeat.sh [<pid to wait for>]
# Since the rebase onto origin/main the three files at 0638f1944 are byte for byte those of the new base, c7efa24cb.
set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
out=/var/tmp/kw2-246921c8/pilot-repeat
cd "$root"
files='src/web/src/components/ui/Overlay.tsx src/web/src/components/ui/Select.tsx src/web/src/components/ui/Menu.tsx'
[ $# -gt 0 ] && while kill -0 "$1" 2>/dev/null; do sleep 30; done
git diff --quiet HEAD -- $files || { echo "putting back $files"; git checkout HEAD -- $files; }
gate() {
  while [ "$(df --output=avail -B1M / | tail -1 | tr -d ' ')" -lt 6144 ]; do
    echo "$(date -u +%FT%TZ) $1 waits for 6 GB free on /"; sleep 60
  done
}
build() { (cd src/web && nice -n 10 npm run build > /dev/null 2>&1) && echo "built $1: $(git status --porcelain -- src/web | tr '\n' ' ')"; }
mkdir -p "$out"
echo 'tree,run,project,exit,iconSha256,imageSha256' > "$here/pilot-repeat.csv"
for tree in final prefix; do
  if [ $tree = prefix ]; then
    trap 'git checkout HEAD -- $files; build restored' EXIT
    for f in $files; do git show 0638f1944:$f > $f; done
  fi
  build $tree
  for n in 1 2 3 4 5; do
    gate "$tree-$n"
    rm -rf "$out/$tree-$n" "$out/$tree-$n-results"
    unshare -n bash -c "ip link set lo up && cd src/web && P32_SNAPSHOTS=$out/$tree-$n P32_OUTPUT=$out/$tree-$n-results NO_COLOR=1 nice -n -10 npx playwright test -c ui-migration/pilot.config.mjs ui-migration/pilot.browser.mjs --project chromium-light-desktop --project chromium-dark-desktop --grep 'fields, pickers and the panel header' --update-snapshots=all" > "$out/$tree-$n.txt" 2>&1
    code=$?
    python3 -I - "$out/$tree-$n" "$tree" "$n" "$code" >> "$here/pilot-repeat.csv" <<'EOF'
import hashlib, sys
from PIL import Image
shots, tree, run, code = sys.argv[1:]
for project in ('chromium-light-desktop', 'chromium-dark-desktop'):
    image = Image.open(f'{shots}/{project}/pilot-delete-confirm.png').convert('RGB')
    icon = hashlib.sha256(image.crop((1240, 24, 1254, 42)).tobytes()).hexdigest()
    whole = hashlib.sha256(open(f'{shots}/{project}/pilot-delete-confirm.png', 'rb').read()).hexdigest()
    print(f'{tree},{run},{project},{code},{icon},{whole}')
EOF
    find "$out/$tree-$n" -type f ! -name 'pilot-delete-confirm.png' -delete
    rm -rf "$out/$tree-$n-results"
    echo "$tree-$n exit $code"
  done
  if [ $tree = prefix ]; then
    git checkout HEAD -- $files
    trap - EXIT
    build restored
  fi
done
cat "$here/pilot-repeat.csv"
