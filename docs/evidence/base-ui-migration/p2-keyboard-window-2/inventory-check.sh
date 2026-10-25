#!/usr/bin/env bash
# The inventory checks of inventory-delta/2026-10-07d.json on this branch, rebased onto origin/main. Usage: inventory-check.sh
# 1. The record's scan is the audit (--json) of the commit it names; that commit's audited sources must equal HEAD's.
#    In a scratch copy (git archive: those sources, and HEAD's audit script, P0.1 inventory and inventory-delta, with
#    .git/HEAD naming the scan commit, in /var/tmp/kw2-246921c8/scratch/inv-check), build-inventory-record.py rebuilds
#    the record byte for byte from that audit, and verify-record.mjs checks it.
# 2. Main brought 8 use points that have no owner yet; the coordinator gave all 8 to P4.2 (2026-10-07: two move with
#    P4.2, six are to be recorded in its 2026-10-07c.json). verify-record.mjs stops at its second check (no use point
#    without an owner) on them. To check the rest, the scratch copy then gets a stand-in record,
#    2026-10-07c-standin.json, that gives exactly those points the owner "P4.2 (stand-in)" and nothing else; it is
#    written there only and never committed. With it, verify-record.mjs must pass for 2026-10-07d.json.
# 3. On HEAD itself: --check-owners (the same 8 points), the audit's self-check and the P0.1 inventory check.
# Every command runs even when one before it fails; the steps expected to fail are marked, and the script exits
# non-zero only if one of the others does.
set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
scratch=/var/tmp/kw2-246921c8/scratch
dir=$scratch/inv-check
evidence=docs/evidence/base-ui-migration
record=$evidence/inventory-delta/2026-10-07d.json
failed=0
step() { echo "\$ $*"; "$@"; local code=$?; echo "exit $code"; [ $code -eq 0 ] || failed=1; return 0; }
expect_fail() { echo "\$ $* (expected to fail)"; "$@"; local code=$?; echo "exit $code"; [ $code -ne 0 ] || failed=1; return 0; }
cd "$root"
scan=$(python3 -c "import json, sys; print(json.load(open(sys.argv[1]))['scan']['commit'])" "$record")
echo "HEAD $(git rev-parse HEAD), record scan $scan, origin/main $(git rev-parse origin/main)"
step git diff --quiet "$scan" HEAD -- src/web/src src/web/package.json package-lock.json
rm -rf "$dir" && mkdir -p "$dir/.git"
git archive "$scan" src/web/src src/web/package.json package-lock.json | tar -x -C "$dir"
git archive HEAD src/web/scripts/audit-antd.mjs $evidence/audit-baseline.json $evidence/ownership.json \
  $evidence/css-ownership.json $evidence/routes-and-tests.md $evidence/inventory-delta | tar -x -C "$dir"
echo "$scan" > "$dir/.git/HEAD"
cd "$dir"
node src/web/scripts/audit-antd.mjs --json > "$scratch/inv-check-audit.json"
echo "scan audit $(sha256sum "$scratch/inv-check-audit.json" | cut -c1-64)"
step bash -c "python3 -B '$here/build-inventory-record.py' '$scratch/inv-check-audit.json' $evidence/inventory-delta/2026-10-07.json | cmp - $record"
expect_fail node $evidence/inventory-delta/verify-record.mjs "$scratch/inv-check-audit.json" 2026-10-07d.json
node src/web/scripts/audit-antd.mjs --check-owners > "$scratch/inv-check-owners.json"
python3 - "$scratch/inv-check-owners.json" "$evidence/inventory-delta/2026-10-07c-standin.json" <<'EOF'
import json, sys
owners, out = sys.argv[1:]
gaps = json.load(open(owners))['unowned']
reason = 'Stand-in for checking 2026-10-07d.json only; never committed. The coordinator gave these points to P4.2 (2026-10-07c.json).'
standin = {'schemaVersion': 1, 'kind': 'antd-inventory-delta', 'date': '2026-10-07', 'note': reason, 'files': {}, 'css': []}
for gap in gaps:
    if 'line' in gap:
        standin['css'].append({'path': gap['path'], 'kind': gap['kind'], 'text': gap['text'], 'count': 1, 'lines': [gap['line']],
                               'status': 'new', 'owner': 'P4.2 (stand-in)', 'reason': reason})
    else:
        standin['files'][gap['path']] = {'status': 'new', 'owner': 'P4.2 (stand-in)', 'reason': reason}
json.dump(standin, open(out, 'w'), indent=1, ensure_ascii=False)
print(f"stand-in record: {len(standin['files'])} files and {len(standin['css'])} index.css lines, owner P4.2 (stand-in):")
for path in standin['files']:
    print('  ', path)
for entry in standin['css']:
    print('  ', f"{entry['path']}:{entry['lines'][0]} {entry['kind']} {entry['text']}")
EOF
step node $evidence/inventory-delta/verify-record.mjs "$scratch/inv-check-audit.json" 2026-10-07d.json
cd "$root"
expect_fail node src/web/scripts/audit-antd.mjs --check-owners
step node src/web/scripts/audit-antd-selfcheck.mjs
step node src/web/scripts/verify-antd-inventory.mjs
rm -rf "$dir"
exit $failed
