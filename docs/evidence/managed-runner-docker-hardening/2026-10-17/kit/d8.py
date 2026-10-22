#!/usr/bin/env python3
"""D8 (task 34hXCWEWAgHqtrxZsMBOh) driver for the isolated test host d8-dind (kit/dind-up.sh): a deployment in
/work/orbit (a tmpfs) whose Docker data root is on /mnt/data, its gateway published on host 127.0.0.1:14886.

    d8.py <step> [args]

Steps:
  facts <label>                 disk_facts.sh: which disk the storage budget is measured on
  accounts <key>...             the administrator (the first key) set up, the others made by it; each signs in
  follow <key> <label> <until>  record the account's status until: started (a container made), waiting, ready, asleep
  tmp <key> <label>             runner_tmp_check.sh in the account's runner container, as its user
  cap <label> <n|none>          limits.maxContainers in channel.json, checked; docker-channel recreated, then the apiserver
  removal <label> <on|off>      allowVolumeRemoval in channel.json, likewise (the channel alone)
  chan <label> <METHOD> <path> [json]   one request to the channel as its token's holder (chan.py)
  probe-create <label>          as the token's holder: a volume, a credential and a container for a runner nobody has
  disable <key> <true|false>    the administrator disables or enables the account
  watch <key> <label> <until>   follow the account's mapping in the database: asleep or started (a disabled account cannot sign in)
  sleep <key>                   the account's owner puts its runner to sleep
  inventory <label>             containers, volumes, mappings and the pool
  snapshot <label>              the managed containers (name, ID, state, start, image, PID), compared with the previous snapshot

Records go to /mnt/data/tmp/34hXCWEWAgHqtrxZsMBOh/evidence (/evidence inside the test host). Account passwords stay in
/mnt/data/tmp/34hXCWEWAgHqtrxZsMBOh/secrets.json (0600) and access tokens in memory; the channel's token never
leaves the deployment's own file, and chan.py prints a credential as its length only.
"""

import json
import os
from pathlib import Path
import secrets
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

T = Path("/mnt/data/tmp/34hXCWEWAgHqtrxZsMBOh")
EVIDENCE = T / "evidence"
BASE = "http://127.0.0.1:14886"
DIND = "d8-dind"
KIT = Path(__file__).resolve().parent
MR = "data/managed-runners"


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def record(file, entry):
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    entry = {"at": now(), **entry}
    with open(EVIDENCE / file, "a") as out:
        out.write(json.dumps(entry, sort_keys=True) + "\n")
    print(json.dumps(entry, sort_keys=True), flush=True)
    return entry


def sh(script, check=True, stdin=None, timeout=1800):
    """A shell script inside the test host, in the deployment's checkout."""
    result = subprocess.run(["docker", "exec", "-i", "-w", "/work/orbit", DIND, "sh", "-c", script],
                            input=stdin, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode != 0:
        raise SystemExit(f"[{DIND}] {script[:200]!r} exited {result.returncode}: {result.stderr.strip()[:2000]}")
    return result


def psql(sql):
    return sh(f"docker exec orbit-postgres psql -U orbit -d orbit -AtF '\t' -c {shlex.quote(sql)}").stdout.rstrip("\n")


def chan(method, path, body=None):
    args = ["python3", "/kit/chan.py", method, path] + ([json.dumps(body)] if body is not None else [])
    return json.loads(sh(" ".join(shlex.quote(a) for a in args)).stdout)


def api(method, path, body=None, token=None):
    data = None if body is None else json.dumps(body).encode()
    headers = {"content-type": "application/json", "accept": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    request = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    try:
        return status, (json.loads(raw) if raw else None)
    except ValueError:
        return status, {"nonJson": raw[:200].decode("utf-8", "replace")}


# ── accounts ─────────────────────────────────────────────────────────────────────────────────

def account(key):
    path = T / "secrets.json"
    stored = json.loads(path.read_text()) if path.exists() else {}
    if key not in stored:
        stored[key] = {"email": f"{key}@d8-drill.test", "password": secrets.token_urlsafe(18)}
        path.write_text(json.dumps(stored))
        os.chmod(path, 0o600)
    return stored[key]


def login(key):
    a = account(key)
    status, body = api("POST", "/api/auth/login", {"email": a["email"], "password": a["password"]})
    if status not in (200, 201):
        raise SystemExit(f"login {key}: {status} {body}")
    return body["accessToken"]


def status_of(token):
    status, body = api("GET", "/api/managed-runner", token=token)
    if status != 200:
        raise SystemExit(f"status: {status} {body}")
    return body


def summarize(s):
    reason = s.get("reason") or {}
    return {k: s.get(k) for k in ("managementState", "desiredState", "usable", "revision")} | {
        "reason": reason.get("code"), "reasonMessage": reason.get("message")}


def mapping(key):
    a = account(key)
    row = psql("select m.runner_id, m.management_state, m.desired_state, m.generation, m.pvc_name, m.pvc_uid, "
               "coalesce(m.pod_name, ''), coalesce(m.pod_uid::text, ''), coalesce(m.last_error::text, '') from managed_runner m "
               f"join \"user\" u on u.id = m.owner_id where u.email = '{a['email']}'")
    if not row:
        return None
    f = row.split("\t") + [""] * 9
    return {"runnerId": f[0], "state": f[1], "desired": f[2], "generation": int(f[3]), "volume": f[4], "volumeUid": f[5],
            "container": f[6] or None, "instanceUid": f[7] or None, "lastError": json.loads(f[8]) if f[8] else None}


def step_accounts(*keys):
    status, setup = api("GET", "/api/auth/setup-status")
    record("steps.jsonl", {"step": "setup-status", "status": status, "body": setup})
    admin_key = keys[0]
    if (setup or {}).get("needsSetup"):
        a = account(admin_key)
        status, body = api("POST", "/api/auth/bootstrap", {"email": a["email"], "name": f"D8 {admin_key}", "password": a["password"]})
        record("steps.jsonl", {"step": f"bootstrap: account {admin_key}, the administrator", "status": status})
        if status not in (200, 201):
            raise SystemExit(body)
    admin = login(admin_key)
    record("steps.jsonl", {"step": f"account {admin_key} signs in"})
    for key in keys[1:]:
        a = account(key)
        status, _ = api("POST", "/api/admin/users", {"email": a["email"], "name": f"D8 {key}", "password": a["password"]}, token=admin)
        record("steps.jsonl", {"step": f"the administrator makes account {key} (409: it exists already)", "status": status})
        login(key)
        record("steps.jsonl", {"step": f"account {key} signs in"})


UNTIL = {
    "started": lambda s, m: bool(m and m["container"]) or s.get("managementState") == "FAILED",
    "waiting": lambda s, m: s.get("managementState") in ("WAITING_CAPACITY", "FAILED"),
    "ready": lambda s, m: (s.get("managementState") == "READY" and s.get("usable")) or s.get("managementState") == "FAILED",
    "asleep": lambda s, m: s.get("managementState") in ("SLEEPING", "FAILED") and not (m and m["container"]),
}


def step_follow(key, label, until, limit="900"):
    token = login(key)
    last, started = None, time.time()
    while True:
        current = status_of(token)
        m = mapping(key)
        short = {**summarize(current), "generation": m and m["generation"], "container": m and m["container"]}
        if short != last:
            record("status-transitions.jsonl", {"account": key, "phase": label, **short})
            last = short
        if UNTIL[until](current, m):
            return record("steps.jsonl", {"step": f"{key}: {label} ({until})", **short, "mapping": m})
        if time.time() - started > int(limit):
            raise SystemExit(f"{key} {label}: gave up after {limit}s at {short}")
        time.sleep(3)


def step_watch(key, label, until, limit="900"):
    """Follow the account's mapping in the database, as an operator does: a disabled account cannot sign in."""
    last, started = None, time.time()
    while True:
        m = mapping(key)
        short = {k: m[k] for k in ("state", "desired", "generation", "container")} | {"lastError": (m["lastError"] or {}).get("code")}
        if short != last:
            record("status-transitions.jsonl", {"account": key, "phase": label, "source": "database", **short})
            last = short
        if ((until == "asleep" and m["state"] in ("SLEEPING", "FAILED") and not m["container"])
                or (until == "started" and (m["container"] or m["state"] == "FAILED"))):
            return record("steps.jsonl", {"step": f"{key}: {label} ({until})", "mapping": m})
        if time.time() - started > int(limit):
            raise SystemExit(f"{key} {label}: gave up after {limit}s at {short}")
        time.sleep(3)


def step_disable(key, value):
    admin = login("a")
    status, users = api("GET", "/api/admin/users", token=admin)
    items = users if isinstance(users, list) else (users or {}).get("items", [])
    target = next(u for u in items if u.get("email") == account(key)["email"])
    status, _ = api("PATCH", f"/api/admin/users/{target['id']}/disabled", {"disabled": value == "true"}, token=admin)
    record("steps.jsonl", {"step": f"the administrator sets {key} disabled={value}", "status": status, "mapping": mapping(key)})


def step_sleep(key):
    token = login(key)
    current = status_of(token)
    status, body = api("POST", "/api/managed-runner/sleep", {"idempotencyKey": f"d8-sleep-{secrets.token_hex(6)}",
                                                              "revision": current.get("revision")}, token=token)
    record("steps.jsonl", {"step": f"{key} asks its runner to sleep", "status": status,
                           "answer": summarize(body) if status in (200, 202) else body})


# ── the deployment ──────────────────────────────────────────────────────────────────────────

def step_facts(label):
    text = subprocess.run(["docker", "exec", "-i", DIND, "sh", "-s"], stdin=open(KIT / "disk_facts.sh"),
                          capture_output=True, text=True, timeout=600).stdout
    (EVIDENCE / f"disk-facts-{label}.txt").write_text(text)
    print(text, flush=True)


def step_tmp(key, label):
    m = mapping(key)
    out = subprocess.run(["docker", "exec", "-i", DIND, "docker", "exec", "-i", m["container"], "sh", "-s"],
                         stdin=open(KIT / "runner_tmp_check.sh"), capture_output=True, text=True, timeout=1200)
    text = f"== account {key}, container {m['container']} (generation {m['generation']})\n{out.stdout}{out.stderr}"
    (EVIDENCE / f"runner-tmp-{label}-{key}.txt").write_text(text)
    print(text, flush=True)


def edit_channel_config(change):
    """Edit channel.json as an operator does, the file replaced whole, and check it with the channel's own parser."""
    script = (f"python3 -c 'import json,sys; p=\"{MR}/channel.json\"; c=json.load(open(p)); exec(sys.argv[1]); "
              f"open(p + \".new\", \"w\").write(json.dumps(c, indent=2) + \"\\n\")' {shlex.quote(change)} && "
              f"chmod 600 {MR}/channel.json.new && mv {MR}/channel.json.new {MR}/channel.json && "
              "docker compose run --rm --no-deps docker-channel check-config --config /var/lib/orbit-managed-runners/channel.json")
    return sh(script).stdout.strip()


def recreate(*services):
    for service in services:
        out = sh(f"docker compose up -d --wait --no-deps --force-recreate {service} 2>&1 | tail -n 3")
        record("steps.jsonl", {"step": f"docker compose up -d --wait --no-deps --force-recreate {service}", "tail": out.stdout.strip().splitlines()})


def step_cap(label, value):
    change = "c['limits'].pop('maxContainers', None)" if value == "none" else f"c['limits']['maxContainers'] = {int(value)}"
    checked = edit_channel_config(change)
    record("steps.jsonl", {"step": f"{label}: channel.json limits.maxContainers := {value}", "checkConfig": checked})
    recreate("docker-channel", "apiserver")
    info = chan("GET", "/v1/info")
    record("cap.jsonl", {"label": label, "limits": info["body"]["limits"]})


def step_removal(label, value):
    checked = edit_channel_config(f"c['allowVolumeRemoval'] = {value == 'on'}" if value == "on" else "c.pop('allowVolumeRemoval', None)")
    record("steps.jsonl", {"step": f"{label}: channel.json allowVolumeRemoval := {value}", "checkConfig": checked})
    recreate("docker-channel")
    info = chan("GET", "/v1/info")
    record("removal.jsonl", {"label": label, "allowVolumeRemoval": info["body"]["allowVolumeRemoval"]})


def step_chan(label, method, path, body=None):
    answer = chan(method, path, json.loads(body) if body else None)
    return record("channel-requests.jsonl", {"label": label, **answer})


def containers_snapshot():
    """Every container on the test host: name, ID, state, start time, image, as Docker reports them."""
    out = sh("docker ps -aq | xargs -r docker inspect --format "
             "'{{.Name}}\t{{.Id}}\t{{.State.Status}}\t{{.State.StartedAt}}\t{{.Image}}\t{{.State.Pid}}'").stdout
    return sorted(line.split("\t") for line in out.strip().splitlines())


def step_probe_create(label):
    """The token's holder asks for one more container than the cap: a runner nobody has, its own volume and credential."""
    info = chan("GET", "/v1/info")["body"]
    runner, owner = str(uuid.uuid4()), str(uuid.uuid4())
    before = containers_snapshot()
    volume = step_chan(label, "PUT", f"/v1/volumes/mr-data-{runner}", json.dumps({"ownerId": owner, "runnerId": runner, "limitBytes": 2 ** 30}))
    step_chan(label, "PUT", f"/v1/credentials/{runner}", json.dumps({"ownerId": owner, "generation": 1, "token": secrets.token_hex(24)}))
    gateway = sh("docker network inspect orbit-managed-runners -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}'").stdout.split()[0]
    request = {"name": f"mr-{runner}", "image": info["image"], "ownerId": owner, "runnerId": runner, "generation": 1,
               "volume": {"name": f"mr-data-{runner}", "uid": volume["body"]["uid"]},
               "resources": {"cpuMillis": 500, "memoryBytes": 512 * 2 ** 20, "pids": 256, "tmpBytes": 64 * 2 ** 20},
               "runner": {"serverUrl": f"http://{gateway}:2086", "maxConcurrent": 1}}
    answer = step_chan(label, "POST", "/v1/containers", json.dumps(request))
    after = containers_snapshot()
    record("cap.jsonl", {"label": label, "probeRunner": runner, "status": answer["status"], "code": (answer["body"] or {}).get("code"),
                         "containersUnchanged": before == after, "before": before, "after": after})
    (T / "probe-runner.json").write_text(json.dumps({"runnerId": runner, "ownerId": owner, "volumeUid": volume["body"]["uid"]}))


def step_snapshot(label):
    """Every container on the test host as Docker reports it, compared with the previous snapshot."""
    snapshot = containers_snapshot()
    path = T / "last-snapshot.json"
    previous = json.loads(path.read_text()) if path.exists() else None
    managed = [c for c in snapshot if c[0].startswith("/mr-")]
    previous_managed = [c for c in previous["containers"] if c[0].startswith("/mr-")] if previous else None
    record("cap.jsonl", {"label": label, "managedContainers": managed, "previous": previous and previous["label"],
                         "managedUnchangedSincePrevious": previous_managed == managed if previous else None})
    path.write_text(json.dumps({"label": label, "containers": snapshot}))


def step_inventory(label):
    script = r'''
echo "== inventory $1 at $(date -u +%FT%TZ), checkout $(git rev-parse HEAD)"
echo "-- managed runner containers"; docker ps -a --filter label=orbit.managed-runner.instance --format '{{.Names}}\t{{.State}}\t{{.Status}}\tgeneration={{.Label "orbit.managed-runner.generation"}}\tuid={{.Label "orbit.managed-runner.uid"}}'
echo "-- managed runner volumes"; docker volume ls --filter label=orbit.managed-runner.instance --format '{{.Name}}\tkind={{.Label "orbit.managed-runner.kind"}}\tuid={{.Label "orbit.managed-runner.uid"}}'
echo "-- every volume"; docker volume ls --format '{{.Name}}\t{{.Driver}}\tanonymous={{.Label "com.docker.volume.anonymous"}}'
echo "-- stack"; docker ps -a --filter label=com.docker.compose.project=orbit --format '{{.Names}}\t{{.State}}\t{{.Status}}'
echo "-- managed_runner rows"; docker exec orbit-postgres psql -U orbit -d orbit -AtF ' | ' -c "select u.email, m.management_state, m.desired_state, m.generation, m.pvc_name, m.pod_name, m.last_error->>'code' from managed_runner m join \"user\" u on u.id = m.owner_id order by u.email" 2>&1
echo "-- capacity pool"; docker exec orbit-postgres psql -U orbit -d orbit -AtF ' | ' -c "select 'pods=' || pods, 'pods_reserved=' || pods_reserved, 'cpu_millis=' || cpu_millis, 'memory_bytes=' || memory_bytes, 'storage_usable_bytes=' || storage_usable_bytes, 'storage_headroom_bytes=' || storage_headroom_bytes, 'durable_bytes_reserved=' || durable_bytes_reserved from managed_runner_capacity" 2>&1
'''
    text = sh(f"set -- {shlex.quote(label)}; " + script, check=False).stdout
    (EVIDENCE / f"inventory-{label}.txt").write_text(text)
    print(text, flush=True)


STEPS = {"facts": step_facts, "accounts": step_accounts, "follow": step_follow, "tmp": step_tmp, "cap": step_cap,
         "removal": step_removal, "chan": step_chan, "probe-create": step_probe_create, "disable": step_disable,
         "sleep": step_sleep, "inventory": step_inventory, "snapshot": step_snapshot, "watch": step_watch}

if __name__ == "__main__":
    STEPS[sys.argv[1]](*sys.argv[2:])
