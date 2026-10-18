#!/usr/bin/env bash
# regen-record.sh: rebuild record 2026-10-09c from the audit of the delivery's comparison-spec commit (HEAD~1, src/web as
# delivered) and amend the record commit (HEAD): the audit, the record, the generator's and README's commit references
# and the commit message follow the current hashes. Checks: regenerates byte for byte; verify-record for 09c and 09b.
set -euo pipefail
T=/mnt/data/tmp/34Za39J4QY3kDa5p2Wsau
WT=/root/.orbit/worktrees/a8fc02e5-256c-58d5-bafe-dbd063f08987
E=docs/evidence/base-ui-migration
cd "$WT"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "tracked changes in the worktree"; exit 1; }
spec=$(git rev-parse --short=9 HEAD~1); switch=$(git rev-parse --short=9 HEAD~2)
git -C "$T/rec09c" checkout -q --detach "$spec"
(cd "$T/rec09c" && node src/web/scripts/audit-antd.mjs --json > "$T/record-09c-audit.json")
python3 - "$spec" "$switch" <<'PY'
import re, sys
spec, switch = sys.argv[1:3]
for path, pattern, repl in (
  ('docs/evidence/base-ui-migration/inventory-delta/build-record-09c.py', r"P4\.4's delivery \([0-9a-f]{9}: its business switch [0-9a-f]{9}", f"P4.4's delivery ({spec}: its business switch {switch}"),
  ('docs/evidence/base-ui-migration/inventory-delta/README.md', r"由 P4\.4 在业务切换 `[0-9a-f]{9}` 里去掉包裹", f"由 P4.4 在业务切换 `{switch}` 里去掉包裹"),
  ('docs/evidence/base-ui-migration/inventory-delta/README.md', r"从交付 `[0-9a-f]{9}` 的审计", f"从交付 `{spec}` 的审计"),
):
    text = open(path).read()
    new, n = re.subn(pattern, repl, text)
    assert n == 1, (path, pattern, n)
    open(path, 'w').write(new)
PY
cp "$T/record-09c-audit.json" $E/p4.4/checks/record-09c-audit.json
python3 -I $E/inventory-delta/build-record-09c.py $E/p4.4/checks/record-09c-audit.json > "$T/2026-10-09c.json"
cp "$T/2026-10-09c.json" $E/inventory-delta/2026-10-09c.json
python3 -I $E/inventory-delta/build-record-09c.py $E/p4.4/checks/record-09c-audit.json | cmp - $E/inventory-delta/2026-10-09c.json
echo "regenerates byte-identically"
node $E/inventory-delta/verify-record.mjs $E/p4.4/checks/record-09c-audit.json 2026-10-09c.json
node $E/inventory-delta/verify-record.mjs $E/p4.3a/checks/record-09b-audit.json 2026-10-09b.json | tail -1
git log -1 --format=%B HEAD | sed -E -e "s/in the business switch \([0-9a-f]{9}\)/in the business switch ($switch)/" \
  -e "s/the audit of the delivery [0-9a-f]{9}/the audit of the delivery $spec/" > "$T/msgs/record.txt"
grep -q "business switch ($switch)" "$T/msgs/record.txt" && grep -q "the delivery $spec" "$T/msgs/record.txt"
git add $E/inventory-delta/2026-10-09c.json $E/inventory-delta/README.md $E/inventory-delta/build-record-09c.py $E/p4.4/checks/record-09c-audit.json
git commit -q --amend -F "$T/msgs/record.txt"
git log --format='%h %s' -1
grep -n '"commit"' $E/inventory-delta/2026-10-09c.json | head -1
