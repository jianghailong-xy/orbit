#!/usr/bin/env python3
"""D5 (task 34hJ7S9C3isVnzIDDfSHD): make, read, stop and remove managed runner containers through the host-level
channel that host-up.sh started (instance d5-host), as the apiserver's Docker backend would.

    host_runner.py create <key> <cpuMillis> <memoryBytes> <pids> <tmpBytes> <volumeLimitBytes>
    host_runner.py view|stop|remove|forget <key>
    host_runner.py exec <key> <script file>      (runs the script in the container as its runner user, sh -s)

Each runner gets a random runner id and owner id, a data volume and a credential that is a random string (no Orbit server
knows it), and runner.serverUrl names a closed port on the network's gateway, so the runner keeps retrying its server and
the container stays up for the probes. Records go to /mnt/data/tmp/34hJ7S9C3isVnzIDDfSHD/host/evidence/host-channel.jsonl;
no token is recorded.
"""

import http.client
import json
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import uuid

T = Path("/mnt/data/tmp/34hJ7S9C3isVnzIDDfSHD/host")
STATE = T / "runners.json"
EVIDENCE = T / "evidence"


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost", timeout=120)
        self.unix_path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.unix_path)


def call(method, path, body=None, note=None):
    token = (T / "mr" / "token").read_text().strip()
    connection = UnixHTTPConnection(str(T / "mr" / "channel.sock"))
    headers = {"Authorization": f"Bearer {token}"}
    payload = None
    if body is not None:
        payload = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    connection.request(method, path, body=payload, headers=headers)
    response = connection.getresponse()
    status, data = response.status, response.read()
    connection.close()
    answer = json.loads(data) if data else None
    record({"request": {"method": method, "path": path, "body": note if note is not None else body}, "status": status,
            "answer": {k: v for k, v in (answer or {}).items() if k != "token"} if isinstance(answer, dict) else answer})
    return status, answer


def record(entry):
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    entry = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **entry}
    with open(EVIDENCE / "host-channel.jsonl", "a") as out:
        out.write(json.dumps(entry, sort_keys=True) + "\n")
    print(json.dumps(entry, sort_keys=True), flush=True)


def runners():
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def save(value):
    STATE.write_text(json.dumps(value, indent=2))


def gateway():
    out = subprocess.run(["docker", "network", "inspect", "orbit-mr-d5", "--format", "{{range .IPAM.Config}}{{.Gateway}} {{end}}"],
                         capture_output=True, text=True, check=True).stdout.split()
    return next(a for a in out if "." in a)


def create(key, cpu, memory, pids, tmp, volume_limit):
    config = json.loads((T / "mr" / "channel.json").read_text())
    known = runners()
    runner = known.get(key, {}).get("runner") or str(uuid.uuid4())
    owner = known.get(key, {}).get("owner") or str(uuid.uuid4())
    status, volume = call("PUT", f"/v1/volumes/mr-data-{runner}", {"ownerId": owner, "runnerId": runner, "limitBytes": int(volume_limit)})
    generation = known.get(key, {}).get("generation", 0) + 1
    call("PUT", f"/v1/credentials/{runner}", {"ownerId": owner, "generation": generation, "token": secrets.token_urlsafe(36)},
         note={"ownerId": owner, "generation": generation, "token": "<random>"})
    body = {
        "name": f"mr-{runner}", "image": config["image"], "ownerId": owner, "runnerId": runner, "generation": generation,
        "volume": {"name": f"mr-data-{runner}", "uid": volume["uid"]},
        "resources": {"cpuMillis": int(cpu), "memoryBytes": int(memory), "pids": int(pids), "tmpBytes": int(tmp)},
        "runner": {"serverUrl": f"http://{gateway()}:9", "maxConcurrent": 1},
    }
    status, view = call("POST", "/v1/containers", body)
    known[key] = {"runner": runner, "owner": owner, "volumeUid": volume["uid"], "generation": generation,
                  "instanceUid": (view or {}).get("uid"), "name": f"mr-{runner}"}
    save(known)


def main():
    action, key = sys.argv[1], sys.argv[2]
    if action == "create":
        create(key, *sys.argv[3:8])
        return
    r = runners()[key]
    if action == "view":
        call("GET", f"/v1/containers/{r['name']}")
    elif action == "stop":
        call("POST", f"/v1/containers/{r['name']}/stop?uid={r['instanceUid']}")
    elif action == "remove":
        call("DELETE", f"/v1/containers/{r['name']}?uid={r['instanceUid']}")
        status, credential = call("GET", f"/v1/credentials/{r['runner']}")
        if status == 200:
            call("DELETE", f"/v1/credentials/{r['runner']}?uid={credential['uid']}")
    elif action == "forget":
        call("DELETE", f"/v1/volumes/mr-data-{r['runner']}?uid={r['volumeUid']}")
        known = runners()
        known.pop(key)
        save(known)
    elif action == "exec":
        script = Path(sys.argv[3]).read_text()
        result = subprocess.run(["docker", "exec", "-i", r["name"], "sh", "-s"], input=script, capture_output=True, text=True, timeout=900)
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        sys.exit(result.returncode)


if __name__ == "__main__":
    main()
