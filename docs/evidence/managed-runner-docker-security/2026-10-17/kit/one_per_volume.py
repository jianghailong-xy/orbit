#!/usr/bin/env python3
"""D5: did any managed data volume ever have two containers? From the 0.5 s samples of every container on the test host
(evidence/volume-samples.jsonl) and from Docker's own events of this instance's containers (evidence/docker-events.jsonl):
for each runner, every container's life from create to destroy, and whether two lives on the same volume overlap."""
import json, sys
from collections import defaultdict
E = "/mnt/data/tmp/34hJ7S9C3isVnzIDDfSHD/dind/work/evidence"
samples = [json.loads(l) for l in open(f"{E}/volume-samples.jsonl")]
up = [s for s in samples if s["up"]]
most_any = max((len(v), vol, s["at"]) for s in up for vol, v in s["perVolume"].items())
most_running = max((sum(1 for _, st in v if st == "running"), vol, s["at"]) for s in up for vol, v in s["perVolume"].items())
down = [s for s in samples if not s["up"]]
spans, start = [], None
for s in samples:
    if not s["up"] and start is None: start = s["at"]
    if s["up"] and start is not None: spans.append([start, s["at"]]); start = None
events = []
for line in open(f"{E}/docker-events.jsonl"):
    try: events.append(json.loads(line))
    except ValueError: pass
lives = defaultdict(list)  # runner -> [ [create, destroy, generation] ]
for e in events:
    if e.get("Type") != "container": continue
    attrs = e.get("Actor", {}).get("Attributes", {})
    runner, action = attrs.get("orbit.managed-runner.runner"), e.get("Action")
    t = e.get("timeNano", 0) / 1e9
    if action == "create": lives[runner].append([t, None, attrs.get("orbit.managed-runner.generation")])
    elif action == "destroy":
        open_lives = [l for l in lives[runner] if l[1] is None]
        if open_lives: open_lives[-1][1] = t
overlaps = []
for runner, ls in lives.items():
    ls.sort()
    for x, y in zip(ls, ls[1:]):
        if x[1] is None or y[0] < x[1]: overlaps.append((runner, x[2], y[2]))
print(json.dumps({
    "samples": len(samples), "from": samples[0]["at"], "to": samples[-1]["at"], "testHostUp": len(up), "testHostDown": len(down),
    "downSpans": spans,
    "mostContainersReferringToOneVolume": most_any[0], "mostRunningOnOneVolume": most_running[0],
    "events": len(events), "eventsFrom": events[0]["time"] if events else None, "eventsTo": events[-1]["time"] if events else None,
    "containerLivesPerRunner": {r[:13] + "…": [[g, round(c, 1), round(d, 1) if d else None] for c, d, g in sorted(ls)] for r, ls in lives.items()},
    "overlappingLivesOnOneVolume": overlaps,
}, indent=1))
