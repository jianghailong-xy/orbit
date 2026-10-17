#!/usr/bin/env python3
"""How Docker's Engine API takes an executable /tmp, measured inside the D8 test host (no runner involved).

For each way of asking — the mount API's tmpfs with TmpfsOptions.Options [["exec"]] at API 1.44 (what the channel
speaks) and at 1.46, and the older HostConfig.Tmpfs option string at 1.44 — it creates an alpine container with a
read-only root and /tmp as a 64 MiB tmpfs, runs it as UID 10001 with every capability dropped, and records what
Docker answered, what inspect shows, the mount options the kernel reports for /tmp, and whether a program copied
there runs. Every container is removed afterwards. Run: python3 tmpfs_api_probe.py > tmpfs-api-probe.json
"""
import http.client
import json
import socket
import time

SOCKET = "/var/run/docker.sock"
IMAGE = "alpine:3"
SCRIPT = ("grep ' /tmp ' /proc/mounts; cp /bin/busybox /tmp/true && /tmp/true; echo exec-exit=$?; "
          "printf '#!/bin/sh\\necho script-ran\\n' > /tmp/s.sh && chmod +x /tmp/s.sh && /tmp/s.sh; echo script-exit=$?")


class Unix(http.client.HTTPConnection):
    def __init__(self):
        super().__init__("localhost", timeout=120)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(SOCKET)


def call(method, path, body=None):
    c = Unix()
    c.request(method, path, body=json.dumps(body).encode() if body is not None else None,
              headers={"Content-Type": "application/json"} if body is not None else {})
    r = c.getresponse()
    data = r.read()
    c.close()
    try:
        return r.status, json.loads(data) if data else None
    except ValueError:
        return r.status, data.decode("utf-8", "replace")


def spec(host_extra):
    return {"Image": IMAGE, "Cmd": ["sh", "-c", SCRIPT], "User": "10001:10001",
            "Labels": {"orbit.test": "d8-34hXCWEWAgHqtrxZsMBOh"},
            "HostConfig": {"ReadonlyRootfs": True, "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges:true"],
                           "NetworkMode": "none", **host_extra}}


CASES = {
    "mounts-api-1.44-options-exec": ("/v1.44", {"Mounts": [{"Type": "tmpfs", "Target": "/tmp", "TmpfsOptions": {
        "SizeBytes": 64 * 2 ** 20, "Mode": 0o1777, "Options": [["exec"]]}}]}),
    "mounts-api-1.46-options-exec": ("/v1.46", {"Mounts": [{"Type": "tmpfs", "Target": "/tmp", "TmpfsOptions": {
        "SizeBytes": 64 * 2 ** 20, "Mode": 0o1777, "Options": [["exec"]]}}]}),
    "mounts-api-1.44-no-options": ("/v1.44", {"Mounts": [{"Type": "tmpfs", "Target": "/tmp", "TmpfsOptions": {
        "SizeBytes": 64 * 2 ** 20, "Mode": 0o1777}}]}),
    "hostconfig-tmpfs-1.44-exec": ("/v1.44", {"Tmpfs": {"/tmp": "rw,exec,nosuid,nodev,size=67108864,mode=1777"}}),
}
# Which other options the mount API takes: what a template that asked for more could get.
for option in (["suid"], ["dev"], ["noexec"], ["size", "1g"], ["nr_inodes", "1000"]):
    CASES["mounts-api-1.44-options-" + "-".join(option)] = ("/v1.44", {"Mounts": [{"Type": "tmpfs", "Target": "/tmp", "TmpfsOptions": {
        "SizeBytes": 64 * 2 ** 20, "Mode": 0o1777, "Options": [["exec"], option]}}]})

results = {}
for name, (api, extra) in CASES.items():
    cname = f"d8-tmpfs-probe-{name}"
    call("DELETE", f"/v1.44/containers/{cname}?force=1")
    status, answer = call("POST", f"{api}/containers/create?name={cname}", spec(extra))
    entry = {"api": api, "request": extra, "create": {"status": status, "answer": answer}}
    if status == 201:
        _, inspected = call("GET", f"{api}/containers/{cname}/json")
        entry["inspect"] = {"HostConfig.Mounts": inspected["HostConfig"].get("Mounts"),
                            "HostConfig.Tmpfs": inspected["HostConfig"].get("Tmpfs"),
                            "Mounts": [{k: m.get(k) for k in ("Type", "Destination", "Mode", "RW")} for m in inspected.get("Mounts") or []]}
        call("POST", f"/v1.44/containers/{cname}/start")
        for _ in range(60):
            _, state = call("GET", f"/v1.44/containers/{cname}/json")
            if state["State"]["Status"] == "exited":
                break
            time.sleep(0.5)
        c = Unix()
        c.request("GET", f"/v1.44/containers/{cname}/logs?stdout=1&stderr=1")
        raw = c.getresponse().read()
        c.close()
        lines, i = [], 0
        while i + 8 <= len(raw):  # the multiplexed log stream: an 8-byte header per frame
            size = int.from_bytes(raw[i + 4:i + 8], "big")
            lines.append(raw[i + 8:i + 8 + size].decode("utf-8", "replace"))
            i += 8 + size
        entry["output"] = "".join(lines).splitlines()
        call("DELETE", f"/v1.44/containers/{cname}?force=1")
    results[name] = entry

print(json.dumps(results, indent=2, sort_keys=True))
