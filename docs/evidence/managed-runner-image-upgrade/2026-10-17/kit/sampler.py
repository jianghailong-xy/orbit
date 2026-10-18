#!/usr/bin/env python3
"""Inside a D6 test host: every 250 ms, which containers refer to one managed runner's data volume.

    sampler.py <volume> <out.tsv>      (runs until <out.tsv>.stop exists)

Each line is `<UTC time>\t<count>\t<name image state, ...>`, written when the set changes and once a
minute otherwise; the last line is the summary, the largest count seen. Docker's own events for
containers go to <out.tsv>.events beside it (`docker events`, as JSON lines), for the lifecycle record.
"""
import datetime
import os
import subprocess
import sys
import time

volume, out = sys.argv[1], sys.argv[2]
events = subprocess.Popen(["docker", "events", "--filter", "type=container", "--format", "{{json .}}"],
                          stdout=open(out + ".events", "a"), stderr=subprocess.DEVNULL)
largest, samples, last, last_written = 0, 0, None, 0.0
with open(out, "a") as log:
    while not os.path.exists(out + ".stop"):
        found = subprocess.run(["docker", "ps", "-a", "--no-trunc", "--filter", f"volume={volume}",
                                "--format", "{{.Names}} {{.Image}} {{.State}}"], capture_output=True, text=True).stdout.split("\n")
        found = sorted(line for line in found if line)
        samples += 1
        largest = max(largest, len(found))
        now = time.time()
        if found != last or now - last_written > 60:
            stamp = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
            log.write(f"{stamp}\t{len(found)}\t{', '.join(found)}\n")
            log.flush()
            last, last_written = found, now
        time.sleep(0.25)
    log.write(f"# {samples} samples; at most {largest} container(s) referred to {volume} at once\n")
events.terminate()
