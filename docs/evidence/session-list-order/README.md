# Session list order: before / after on the iPhone

TEMPORARY evidence probe (client.yml dispatch with `list_order_probe`). It builds the iPhone app's
own `CompactShell` from the shared sources, points it at `probe-harness/stub.py`, and photographs the
workspace's session list twice per tree: as first served (`list-1`), then after activity only
(five running sessions stream: `lastTurnAt` and the preview line move, `listedAt` does not) on a fresh
launch (`list-2`). `before` is the tree without the change, `after` the branch head.
All data is made up.
