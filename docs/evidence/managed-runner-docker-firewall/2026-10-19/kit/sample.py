#!/usr/bin/env python3
"""D9: a timeline of the test host through a restart, sampled from the HPC host about once a second.

    sample.py <scenario> <label> <seconds>

Each sample: whether the test host's dockerd answers, whether the firewall's chains and jumps are on its iptables
(IPv4), the firewall service's container state and its status file's state, and every managed runner container with its
state and StartedAt. The question it answers: did a runner container ever run while the rules were not there?
Lines go to /mnt/data/tmp/34iSiGtPrJ0LWSqn17esR/evidence/<scenario>/timeline-<label>.jsonl.
"""

import json
from pathlib import Path
import subprocess
import sys
import time

SCRIPT = r'''
docker info >/dev/null 2>&1 && echo docker=up || echo docker=down
iptables -S ORBIT-MR-INPUT >/dev/null 2>&1 && echo chains=yes || echo chains=no
iptables -S INPUT 2>/dev/null | sed -n 2p | grep -q ORBIT-MR-INPUT && echo jump=first || echo jump=no
echo "firewall=$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' orbit-managed-runner-firewall 2>/dev/null || echo none)"
echo "status=$(sed -n 's/.*"state": "\([a-z]*\)".*/\1/p' /work/$1/data/managed-runners/firewall/status.json 2>/dev/null)"
docker ps -a --filter label=orbit.managed-runner.kind=runner --format 'runner={{.Names}} {{.State}}' 2>/dev/null
for c in $(docker ps -q --filter label=orbit.managed-runner.kind=runner 2>/dev/null); do echo "started=$(docker inspect -f '{{.Name}} {{.State.StartedAt}}' $c)"; done
'''


def main():
    scenario, label, seconds = sys.argv[1], sys.argv[2], float(sys.argv[3])
    out = Path("/mnt/data/tmp/34iSiGtPrJ0LWSqn17esR/evidence") / scenario / f"timeline-{label}.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    end = time.time() + seconds
    with open(out, "a") as log:
        while time.time() < end:
            at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            try:
                done = subprocess.run(["docker", "exec", "d9-dind", "sh", "-c", SCRIPT, "sh", scenario], capture_output=True,
                                      text=True, timeout=8)
                lines = done.stdout.splitlines() if done.returncode == 0 else []
            except subprocess.TimeoutExpired:
                lines = []
            sample = {"at": at, "host": "up" if lines else "down"}
            for line in lines:
                key, _, value = line.partition("=")
                if key in ("runner", "started"):
                    sample.setdefault(key, []).append(value)
                else:
                    sample[key] = value
            log.write(json.dumps(sample, sort_keys=True) + "\n")
            log.flush()
            time.sleep(1)


if __name__ == "__main__":
    main()
