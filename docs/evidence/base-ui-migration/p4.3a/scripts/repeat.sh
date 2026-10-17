#!/usr/bin/env bash
# repeat.sh: three more runs, on each tree of round 5 (base 5b794d643), of the two P4.3a tests whose results needed
# telling apart from run noise (output kept in v1/repeat-r5 after round 5; round 6 has no repeat runs):
#  - the project header test: in round 4 (3369ee1e0) and in the round-5 attempt on bcf8c7fff the delivery's WebKit light
#    desktop run failed after its last step on WebKit console errors ("Fetch API cannot load ... due to access control
#    checks", which Playwright's WebKit backend reports as page errors) for background reads the test's own page.reload()
#    cancelled; in the bcf8c7fff attempt the reference's WebKit light phone run did not see the "Recorded as done"
#    notification within 15 s; on WebKit light phone the delete-refused shot can differ by the 8px scrollbar (the WebKit
#    phone 382/390 mechanism);
#  - the keys test: in round 4 the delivery's WebKit light desktop shot had the list 8px higher up, in round 5 its WebKit
#    dark desktop one; its runs failed after their last step on WebKit's "ResizeObserver loop completed with undelivered
#    notifications" (also reported as a page error): in the a5c99e27f attempt the delivery's WebKit light phone, in
#    round 5 the reference's WebKit light and dark phone and the delivery's WebKit light desktop.
# WebKit light and dark desktop and phone; each run in its own network namespace, writing its own screenshots and report
# under v1/repeat/<tree>-<n>. Resumable: a finished run is not run again.
set -u
V=/mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1
export TMPDIR=$V/tmp
for n in 1 2 3; do
  for tree in ref del; do
    out=$V/repeat/$tree-$n
    [ -f "$out/done" ] && continue
    mkdir -p "$out"
    { echo "tree: $tree $(git -C "$V/$tree" rev-parse HEAD)"; echo "load: $(cat /proc/loadavg)"; echo "started: $(date -u +%FT%TZ)"; } > "$out/run.txt"
    ( cd "$V/$tree/src/web" && nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash env P43A_SNAPSHOTS="$out/shots" P43A_OUTPUT="$out/out" \
        npx playwright test --config ui-migration/p43a.config.mjs --update-snapshots=all \
        --project webkit-light-desktop --project webkit-light-phone --project webkit-dark-desktop --project webkit-dark-phone \
        -g "the header: status questions|keys with a task open" ) >> "$out/run.txt" 2>&1
    echo "exit=$?" >> "$out/run.txt"
    touch "$out/done"
    echo "== $tree $n: $(grep -E '^\s+[0-9]+ (passed|failed|flaky)' "$out/run.txt" | tr -s ' ' | tr '\n' ' ')"
  done
done
