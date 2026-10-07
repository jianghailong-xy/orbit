#!/usr/bin/env bash
# Re-run the 2026-10-07 record's checks from the repository root and write their outputs beside this
# script. Exits non-zero when any check fails. The web build and Vitest run separately (README).
set -u
cd "$(dirname "$0")/../../../../.."
D=docs/evidence/base-ui-migration/inventory-delta
C=$D/checks
TIP=7732f14f82d4e6b4406d7d164c4b672f63aa0f56
T=$(mktemp -d /tmp/antd-delta-checks.XXXXXX)
BEFORE=src/web/scripts/.audit-antd-before.mjs
trap 'rm -rf "$T" "$BEFORE"' EXIT
status=0
run() { "$@" || { echo "FAILED: $*" >&2; status=1; }; }

run node src/web/scripts/audit-antd.mjs --json > "$C/antd-audit.json"
run node src/web/scripts/audit-antd.mjs --json > "$T/again.json"
same() { if cmp -s "$1" "$2"; then echo "$3" > "$4"; else echo "FAILED: $1 differs from $2" >&2; status=1; fi; }
same "$C/antd-audit.json" "$T/again.json" 'two audit --json runs are byte-identical' "$C/audit-repeat.txt"
run node src/web/scripts/audit-antd.mjs > "$C/audit-summary.txt"
run node src/web/scripts/audit-antd-selfcheck.mjs > "$C/selfcheck.txt" 2>&1
run node src/web/scripts/verify-antd-inventory.mjs > "$C/p01-verify.txt" 2>&1
run python3 "$D/build-record.py" "$C/antd-audit.json" 2026-10-07 > "$T/rebuilt.json"
same "$T/rebuilt.json" "$D/2026-10-07.json" 'build-record.py rebuilds 2026-10-07.json byte for byte' "$C/rebuild.txt"
run node "$D/verify-record.mjs" "$C/antd-audit.json" 2026-10-07.json > "$C/verify-record.txt" 2>&1
run node src/web/scripts/audit-antd.mjs --check-owners > "$C/check-owners.json"

# The audit's existing outputs, before (the script as of the scanned tip) and after this change.
git show "$TIP:src/web/scripts/audit-antd.mjs" > "$BEFORE"
{
  for args in '' '--json' '--check-retired' '--json --check-retired' '--bogus'; do
    node "$BEFORE" $args > "$T/before.out" 2> "$T/before.err"; b=$?
    node src/web/scripts/audit-antd.mjs $args > "$T/after.out" 2> "$T/after.err"; a=$?
    if cmp -s "$T/before.out" "$T/after.out" && cmp -s "$T/before.err" "$T/after.err" && [ "$b" = "$a" ]; then
      echo "same   [$args] exit=$a stdout=$(wc -c < "$T/after.out") bytes stderr=$(wc -c < "$T/after.err") bytes"
    else
      echo "DIFFER [$args] exit before=$b after=$a"; status=1
    fi
  done
  echo '--help, before -> after:'
  node "$BEFORE" --help > "$T/before.help"; node src/web/scripts/audit-antd.mjs --help > "$T/after.help"
  diff "$T/before.help" "$T/after.help"
} > "$C/outputs-unchanged.txt"

{
  echo "git diff --stat $TIP -- the P0.1 files (empty means unchanged):"
  git diff --stat "$TIP" -- docs/evidence/base-ui-migration/{audit-baseline.json,ownership.json,css-ownership.json,routes-and-tests.md,component-contracts.md,README.md}
  echo "last commits that touched them:"
  git log --format='%h %ad %s' --date=short -- docs/evidence/base-ui-migration/{audit-baseline.json,ownership.json,css-ownership.json}
  echo "git diff --stat $TIP -- src/web/src (empty means no source change):"
  git diff --stat "$TIP" -- src/web/src
} > "$C/p01-unchanged.txt"
git diff --quiet "$TIP" -- docs/evidence/base-ui-migration/{audit-baseline.json,ownership.json,css-ownership.json,routes-and-tests.md,component-contracts.md,README.md} src/web/src || status=1
echo "run-checks: exit $status"
exit $status
