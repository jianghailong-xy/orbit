"""watch_runs.py <repo> <branch>...: print each GitHub Actions run on these branches as its state changes, and exit
when every run has finished (a run dispatched after the start is picked up too). Polls `gh run list` every 60 s."""
import json
import subprocess
import sys
import time

repo, branches = sys.argv[1], sys.argv[2:]
seen = {}
quiet_since = time.time()
while True:
    runs = []
    for branch in branches:
        out = subprocess.run(["gh", "run", "list", "-R", repo, "--branch", branch, "--limit", "8", "--json",
                              "databaseId,name,status,conclusion,headSha,event,createdAt"],
                             capture_output=True, text=True, timeout=60)
        if out.returncode == 0:
            runs += [dict(r, branch=branch) for r in json.loads(out.stdout)]
    for r in runs:
        state = (r["status"], r["conclusion"])
        if seen.get(r["databaseId"]) != state:
            seen[r["databaseId"]] = state
            print(f'{time.strftime("%H:%M:%S")} {r["branch"]} {r["name"]} #{r["databaseId"]} ({r["event"]}, '
                  f'{r["headSha"][:9]}): {r["status"]} {r["conclusion"] or ""}', flush=True)
    live = [r for r in runs if r["status"] != "completed"]
    if runs and not live and time.time() - quiet_since > 120:
        print("all finished", flush=True)
        break
    if live:
        quiet_since = time.time()
    time.sleep(60)
