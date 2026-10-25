#!/usr/bin/env bash
# keys-red-green.sh PATCH: the review fix for the Tasks page's keys, red then green. PATCH is the production half
# of the fix (Menu.tsx's openOnArrowKeys and TaskListView.tsx's Space keyup guard and the title's option); the
# new unit tests stay. Reverse it, run Menu.test.tsx and TaskListView.taskUrl.test.tsx (expected: the new tests
# fail), restore it, run them again (expected: all pass), and check the tree is back to HEAD. Exits 0 only when
# the run without the fix failed and the run with it passed.
set -u
patch=$1
cd "$(git rev-parse --show-toplevel)"
tests=(src/components/ui/Menu.test.tsx src/pages/TaskListView.taskUrl.test.tsx)
out=$(mktemp)
run() { (cd src/web && npx vitest run "${tests[@]}" > "$out" 2>&1); }
git apply -R "$patch" || exit 2
echo "== without the fix"
run; red=$?
sed 's/\x1b\[[0-9;]*m//g' "$out" | grep -E '✓|×|Tests |AssertionError|Expected|Received'
git apply "$patch" || exit 2
echo "== with the fix"
run; green=$?
sed 's/\x1b\[[0-9;]*m//g' "$out" | grep -E '×|Test Files|Tests '
rm -f "$out"
git diff --quiet HEAD -- src/web/src && echo "tree back to HEAD $(git rev-parse --short HEAD)"
echo "vitest exit without the fix: $red, with the fix: $green"
[ "$red" -ne 0 ] && [ "$green" -eq 0 ]
