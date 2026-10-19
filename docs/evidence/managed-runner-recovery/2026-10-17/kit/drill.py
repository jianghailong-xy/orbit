#!/usr/bin/env python3
"""D7 (task 34hXCW6iauoWaquGQj7DO) driver for the isolated test host d7-dind: a default deployment
(scripts/install-server.sh, no flags; then /upgrade to the D7 commit) whose gateway is published on host
127.0.0.1:17086. Adapted from D5's kit (docs/evidence/managed-runner-docker-security/2026-10-17/kit/drill.py).

    drill.py <step> [args]

Steps: accounts, inventory <label>, seed <account> <label> [big-MiB], verify <account> <label>, writer <account>,
writer-check <account> <label>, sleep|wake|retry <account>, follow <account> <label> <READY|SLEEPING|FAILED>,
docker-report <account> <label>, events, sample <file>, pool <label>, restart <graceful|powercut>,
held-wake <account>, lose-and-restore <account>, oom <account>, mapping <account>.

Records go to /mnt/data/tmp/34hXCW6iauoWaquGQj7DO/dind/work/evidence; account passwords stay in work/secrets.json
(0600) and access tokens only in memory. No secret is written to the evidence: the runner credentials, the channel
token and the placeholder key never appear in a record. No model is used (no DeepSeek key file was there): READY
comes from a placeholder Codex sign-in, as in D2, D3, D5 and D6.
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

T = Path("/mnt/data/tmp/34hXCW6iauoWaquGQj7DO")
WORK = T / "dind" / "work"
EVIDENCE = WORK / "evidence"
BASE = "http://127.0.0.1:17086"
DIND = "d7-dind"
PLACEHOLDER_KEY = "sk-orbit-d7-placeholder-not-a-key"
SCRIPT = "/work/orbit/scripts/managed-runner/volume-backup.sh"


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
    """A shell script inside the test host (its own Docker CLI, its checkout at /work/orbit)."""
    result = subprocess.run(["docker", "exec", "-i", "-w", "/work/orbit", DIND, "sh", "-c", script],
                            input=stdin, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode != 0:
        raise SystemExit(f"[{DIND}] {script[:200]!r} exited {result.returncode}: {result.stderr.strip()[:2000]}")
    return result


def psql(sql, wait=240):
    """One query. Postgres may still be starting after the test host restarts: wait for it rather than fail."""
    deadline = time.time() + wait
    while True:
        result = sh(f"docker exec orbit-postgres psql -U orbit -d orbit -AtF '\t' -c {shlex.quote(sql)}", check=False)
        if result.returncode == 0:
            return result.stdout.rstrip("\n")
        if time.time() > deadline:
            raise SystemExit(f"psql kept failing: {result.stderr.strip()[:500]}")
        time.sleep(3)


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
    except (urllib.error.URLError, ConnectionError, TimeoutError) as error:
        return 0, {"unreachable": str(error)[:200]}
    try:
        return status, (json.loads(raw) if raw else None)
    except ValueError:
        return status, {"nonJson": raw[:200].decode("utf-8", "replace")}


# ── accounts ─────────────────────────────────────────────────────────────────────────────────

def account(key):
    path = WORK / "secrets.json"
    stored = json.loads(path.read_text()) if path.exists() else {}
    if key not in stored:
        stored[key] = {"email": f"{key}@d7-drill.test", "password": secrets.token_urlsafe(18)}
        path.write_text(json.dumps(stored))
        os.chmod(path, 0o600)
    return stored[key]


def login(key):
    a = account(key)
    for _ in range(60):
        status, body = api("POST", "/api/auth/login", {"email": a["email"], "password": a["password"]})
        if status in (200, 201):
            return body["accessToken"]
        if status not in (0, 502, 503, 504):
            break
        time.sleep(5)
    raise SystemExit(f"login {key}: {status} {body}")


def status_of(token):
    for _ in range(60):
        status, body = api("GET", "/api/managed-runner", token=token)
        if status == 200:
            return body
        if status not in (0, 502, 503, 504):
            break
        time.sleep(5)
    raise SystemExit(f"status: {status} {body}")


def summarize(s):
    reason = s.get("reason") or {}
    return {k: s.get(k) for k in ("managementState", "desiredState", "heartbeatStatus", "usable", "initialProvider", "revision")} | {
        "reason": reason.get("code"), "reasonMessage": reason.get("message"),
        "canRetry": (s.get("actions") or {}).get("canRetry")}


def mapping(key):
    """The account's managed_runner row, as an operator reads it."""
    a = account(key)
    row = psql("select m.runner_id, m.management_state, m.desired_state, m.generation, m.pvc_name, m.pvc_uid, m.pod_name, "
               "m.pod_uid, m.attempt, coalesce(m.last_request_key, ''), coalesce(m.last_error::text, ''), "
               "coalesce(m.fencing_receipt::text, '') from managed_runner m "
               f"join \"user\" u on u.id = m.owner_id where u.email = '{a['email']}'")
    if not row:
        return None
    f = row.split("\t") + [""] * 12
    return {"runnerId": f[0], "state": f[1], "desired": f[2], "generation": int(f[3]), "volume": f[4], "volumeUid": f[5],
            "container": f[6] or None, "instanceUid": f[7] or None, "attempt": int(f[8]), "lastRequestKey": f[9] or None,
            "lastError": json.loads(f[10]) if f[10] else None, "fencingReceipt": json.loads(f[11]) if f[11] else None}


def container_of(key):
    m = mapping(key)
    return f"mr-{m['runnerId']}" if m else None


def follow(key, label, until, limit=900, every=2, sign_in=True):
    """Record each change of the account's status until `until(status)`; sign Codex in with a placeholder key once
    its runner is up without a runtime (READY needs one, and this run has no model)."""
    token = login(key)
    last, started, signed = None, time.time(), False
    while True:
        current = status_of(token)
        short = summarize(current)
        if short != last:
            record("status-transitions.jsonl", {"account": key, "phase": label, **short,
                                                "detail": ((mapping(key) or {}).get("lastError") or {}).get("detail")})
            last = short
        if (sign_in and not signed and current.get("managementState") == "STARTING"
                and (current.get("reason") or {}).get("code") == "MODEL_UNAVAILABLE"):
            name = container_of(key)
            result = sh(f"docker exec -i {name} sh -c 'codex login --with-api-key >/dev/null 2>&1; codex login status'",
                        check=False, stdin=PLACEHOLDER_KEY)
            record("steps.jsonl", {"step": f"operator signs Codex in for {key} with a placeholder key", "container": name,
                                   "exit": result.returncode, "codexLoginStatus": (result.stdout + result.stderr).strip()[-120:]})
            signed = True
        if until(current):
            return current
        if time.time() - started > limit:
            raise SystemExit(f"{key} {label}: gave up after {limit}s at {short}")
        time.sleep(every)


def ready(s):
    return (s.get("managementState") == "READY" and s.get("usable")) or s.get("managementState") == "FAILED"


TARGETS = {
    "READY": ready,
    "SLEEPING": lambda s: s.get("managementState") in ("SLEEPING", "FAILED"),
    "FAILED": lambda s: s.get("managementState") == "FAILED",
}


def step_follow(key, label, target):
    final = follow(key, label, TARGETS[target])
    return record("steps.jsonl", {"step": f"{key}: {label}", **summarize(final), "mapping": mapping(key), "pool": pool()})


def step_accounts():
    """Resumable: an account that already exists is signed in, not made again."""
    status, setup = api("GET", "/api/auth/setup-status")
    record("steps.jsonl", {"step": "setup-status", "status": status, "body": setup})
    a = account("a")
    if (setup or {}).get("needsSetup"):
        status, body = api("POST", "/api/auth/bootstrap", {"email": a["email"], "name": "D7 A", "password": a["password"]})
        record("steps.jsonl", {"step": "bootstrap: account a, the administrator", "status": status})
        if status not in (200, 201):
            raise SystemExit(body)
    admin = login("a")
    record("steps.jsonl", {"step": "account a signs in"})
    b = account("b")
    status, _ = api("POST", "/api/admin/users", {"email": b["email"], "name": "D7 B", "password": b["password"]}, token=admin)
    record("steps.jsonl", {"step": "admin creates account b (409: it exists already)", "status": status})
    login("b")
    record("steps.jsonl", {"step": "account b signs in"})
    for key in ("a", "b"):
        final = follow(key, "first sign-in", ready)
        record("steps.jsonl", {"step": f"{key}'s managed runner", **summarize(final), "mapping": mapping(key)})
    inventory("1-two-accounts-ready")


# ── inventories ─────────────────────────────────────────────────────────────────────────────

def pool():
    row = psql("select cpu_millis_reserved, memory_bytes_reserved, pods_reserved, active_users_reserved, durable_bytes_reserved "
               "from managed_runner_capacity")
    keys = ("cpuMillisReserved", "memoryBytesReserved", "podsReserved", "activeUsersReserved", "durableBytesReserved")
    return dict(zip(keys, (int(v) for v in row.split("\t")))) if row else None


def inventory(label):
    script = r'''
echo "== inventory $1 at $(date -u +%FT%TZ), checkout $(git rev-parse HEAD)"
echo "-- managed runner containers"; docker ps -a --no-trunc --filter label=orbit.managed-runner.kind=runner --format '{{.Names}}\t{{.State}}\t{{.Status}}\tgeneration={{.Label "orbit.managed-runner.generation"}}\tuid={{.Label "orbit.managed-runner.uid"}}\t{{.Mounts}}'
echo "-- managed runner volumes"; docker volume ls --filter label=orbit.managed-runner.instance --format '{{.Name}}\tkind={{.Label "orbit.managed-runner.kind"}}\towner={{.Label "orbit.managed-runner.owner"}}\tuid={{.Label "orbit.managed-runner.uid"}}'
echo "-- stack"; docker ps -a --filter label=com.docker.compose.project=orbit --format '{{.Names}}\t{{.State}}\t{{.Status}}'
echo "-- managed_runner rows"; docker exec orbit-postgres psql -U orbit -d orbit -AtF ' | ' -c "select u.email, m.management_state, m.desired_state, m.generation, m.attempt, m.pvc_name, m.pvc_uid, m.pod_uid, m.last_error->>'code' from managed_runner m join \"user\" u on u.id = m.owner_id order by u.email"
echo "-- capacity pool (reserved)"; docker exec orbit-postgres psql -U orbit -d orbit -AtF ' | ' -c "select cpu_millis, cpu_millis_reserved, memory_bytes, memory_bytes_reserved, pods, pods_reserved, storage_usable_bytes, durable_bytes_reserved from managed_runner_capacity"
'''
    text = sh(f"set -- {label}; " + script).stdout
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE / f"inventory-{label}.txt").write_text(text)
    print(text, flush=True)


# ── data in a runner's volume ───────────────────────────────────────────────────────────────

SEED = r'''
set -e
mkdir -p /var/lib/orbit/home/d7-drill && cd /var/lib/orbit/home/d7-drill
[ -e blob-1 ] || head -c 8388608 /dev/urandom > blob-1
[ -e note.txt ] || echo "D7 drill note, written $(date -u +%FT%TZ)" > note.txt
if [ "${BIG_MIB:-0}" -gt 0 ] && [ ! -e big.bin ]; then head -c $((BIG_MIB * 1048576)) /dev/urandom > big.bin; fi
python3 - <<'PY'
import sqlite3
c = sqlite3.connect("drill.sqlite")
c.execute("pragma journal_mode=wal")
c.execute("create table if not exists t(id integer primary key, v text)")
if c.execute("select count(*) from t").fetchone()[0] == 0:
    c.executemany("insert into t(v) values (?)", [(f"row-{i}-" + "x" * 50,) for i in range(5000)])
    c.commit()
c.close()
PY
if [ ! -d repo/.git ]; then git init -q repo && cd repo && echo hello > README && git add README && git -c user.name=d7 -c user.email=d7@drill.invalid commit -q -m init && cd ..; fi
'''

VERIFY = r'''
cd /var/lib/orbit/home/d7-drill
echo "files:"; find . -path ./repo/.git -prune -o -type f ! -name 'writer*' ! -name '*-wal' ! -name '*-shm' -print0 | sort -z | xargs -0 sha256sum
echo "repo:"; git -C repo rev-parse HEAD; git -C repo fsck --no-progress 2>&1 | tail -n 2; echo "fsck-exit=$?"
echo "sqlite:"; sqlite3 drill.sqlite 'pragma integrity_check; select count(*), sum(length(v)) from t;'
echo "dump:"; sqlite3 drill.sqlite .dump | sha256sum
echo "identity:"; python3 -c 'import json; c=json.load(open("/var/lib/orbit/home/.orbit/config.json")); print(c["runnerId"], c["serverUrl"], c["workDir"])'
'''


def step_seed(key, label, big_mib="0"):
    name = container_of(key)
    sh(f"docker exec -i -e BIG_MIB={int(big_mib)} {name} sh -s", stdin=SEED)
    return step_verify(key, label)


def step_verify(key, label):
    name = container_of(key)
    out = sh(f"docker exec -i {name} sh -s", stdin=VERIFY, check=False)
    return record("data.jsonl", {"account": key, "label": label, "container": name, "exit": out.returncode,
                                 "report": out.stdout.strip().splitlines(), "stderr": out.stderr.strip()[-300:]})


WRITER = r'''
import os, sqlite3, time
c = sqlite3.connect("/var/lib/orbit/home/d7-drill/writer.sqlite")
c.execute("pragma journal_mode=wal")
c.execute("pragma synchronous=full")
c.execute("create table if not exists w(id integer primary key, at real, pad text)")
log = open("/var/lib/orbit/home/d7-drill/writer.log", "a")
while True:
    c.execute("insert into w(at, pad) values (?, ?)", (time.time(), "p" * 200))
    c.commit()
    n = c.execute("select max(id) from w").fetchone()[0]
    log.write(f"{n}\n"); log.flush(); os.fsync(log.fileno())
    time.sleep(0.05)
'''


def step_writer(key):
    name = container_of(key)
    sh(f"docker exec -i {name} sh -c 'cat > /tmp/d7-writer.py'", stdin=WRITER)
    sh(f"docker exec -d {name} python3 /tmp/d7-writer.py")
    time.sleep(3)
    out = sh(f"docker exec {name} sh -c 'tail -n 1 /var/lib/orbit/home/d7-drill/writer.log; pgrep -f d7-writer.py | head -1'", check=False)
    record("steps.jsonl", {"step": f"a SQLite writer runs in {key}'s container (commit, then log the committed id, fsync)",
                           "container": name, "lastLoggedAndProcess": out.stdout.split()})


def step_writer_check(key, label):
    name = container_of(key)
    out = sh(f"docker exec {name} sh -c \"cd /var/lib/orbit/home/d7-drill && echo logged=\\$(tail -n 1 writer.log) && "
             f"sqlite3 writer.sqlite 'pragma integrity_check; select max(id), count(*) from w;'\"", check=False)
    return record("data.jsonl", {"account": key, "label": label, "writer": out.stdout.strip().splitlines(), "exit": out.returncode})


# ── the owner's actions ─────────────────────────────────────────────────────────────────────

def owner_action(key, action):
    token = login(key)
    current = status_of(token)
    status, body = api("POST", f"/api/managed-runner/{action}", {"idempotencyKey": f"d7-{action}-{secrets.token_hex(6)}",
                                                                 "revision": current.get("revision")}, token=token)
    record("steps.jsonl", {"step": f"{key} asks to {action}", "status": status,
                           "answer": summarize(body) if status in (200, 202) else body, "mapping": mapping(key)})
    return status


def docker_report(key, label):
    m = mapping(key)
    name = f"mr-{m['runnerId']}"
    out = sh(f"docker inspect {name} --format '{{{{json .State}}}}' 2>/dev/null; docker inspect {name} --format "
             f"'{{{{index .Config.Labels \"orbit.managed-runner.generation\"}}}} {{{{index .Config.Labels \"orbit.managed-runner.uid\"}}}}' 2>/dev/null",
             check=False)
    lines = out.stdout.strip().splitlines()
    state = json.loads(lines[0]) if lines else None
    record("docker-reports.jsonl", {"account": key, "label": label, "container": name,
                                    "state": {k: state.get(k) for k in ("Status", "ExitCode", "OOMKilled", "Error", "StartedAt", "FinishedAt")} if state else None,
                                    "generationAndUid": lines[1] if len(lines) > 1 else None,
                                    "mapping": {k: m[k] for k in ("state", "desired", "generation", "attempt", "instanceUid", "lastError", "fencingReceipt")}})


def apiserver_log(since, pattern="managed runner"):
    out = sh(f"docker logs --since {since} orbit-apiserver 2>&1 | grep -E '{pattern}' | sed 's/\\x1b\\[[0-9;]*m//g' | tail -n 60", check=False)
    return out.stdout.strip().splitlines()


def identity(m):
    return {k: m[k] for k in ("runnerId", "volume", "volumeUid", "generation", "attempt", "lastRequestKey")}


# ── observers ───────────────────────────────────────────────────────────────────────────────

def step_sample(path):
    """Every half second, every container on the test host and the managed data volumes it refers to (names in full),
    whatever its labels; a sample that cannot be taken (the test host is down or slow) says why, and sampling goes on."""
    with open(path, "a") as out:
        while True:
            at = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int(time.time() % 1 * 1000):03d}Z"
            try:
                result = subprocess.run(["docker", "exec", DIND, "docker", "ps", "-a", "--no-trunc",
                                         "--format", "{{.Names}}|{{.State}}|{{.Mounts}}"], capture_output=True, text=True, timeout=20)
                rows = [line.split("|") for line in result.stdout.split("\n") if line] if result.returncode == 0 else None
                why = None if rows is not None else result.stderr.strip()[:120]
            except subprocess.TimeoutExpired:
                rows, why = None, "timed out"
            per_volume = {}
            for name, state, mounts in rows or []:
                for volume in mounts.split(","):
                    if volume.startswith("mr-data-"):
                        per_volume.setdefault(volume, []).append([name, state])
            out.write(json.dumps({"at": at, "up": rows is not None, **({"why": why} if why else {}), "perVolume": per_volume}) + "\n")
            out.flush()
            time.sleep(0.5)


def step_events():
    """Docker's own events of this instance's containers and volumes, and of the helper containers, appended to
    evidence/docker-events.jsonl by a recorder that runs detached inside the test host (its pid in /run, which a
    restart of the test host clears). Start it again after the test host restarts: it dies with it."""
    subprocess.run(["docker", "exec", DIND, "sh", "-c", "[ -s /run/d7-events.pid ] && kill \"$(cat /run/d7-events.pid)\" 2>/dev/null; true"],
                   capture_output=True, timeout=30)
    subprocess.run(["docker", "exec", "-d", DIND, "sh", "-c",
                    "echo $$ > /run/d7-events.pid; exec docker events --filter type=container --filter type=volume "
                    "--format '{{json .}}' >> /work/evidence/docker-events.jsonl 2>&1"], check=True, timeout=30)
    time.sleep(1)
    alive = subprocess.run(["docker", "exec", DIND, "sh", "-c", "kill -0 \"$(cat /run/d7-events.pid)\" && echo recording"],
                           capture_output=True, text=True, timeout=30).stdout.strip()
    record("steps.jsonl", {"step": "Docker events recorder (re)started in the test host", "state": alive or "NOT RUNNING"})


def step_pool(label):
    record("pool.jsonl", {"label": label, "pool": pool(), "a": (mapping("a") or {}).get("state"), "b": (mapping("b") or {}).get("state")})


# ── the test host's restart: its own dockerd and everything in it ────────────────────────────

def step_restart(mode):
    """`graceful`: docker restart -t 300 d7-dind (its dockerd stops every container, then starts again). `powercut`:
    docker kill d7-dind, then docker start. Account a is READY with a SQLite writer running; b has just been put to
    sleep. Nobody presses Retry: a is followed until it is READY again by itself."""
    label = f"restart-{mode}"
    before = mapping("a")
    record("restarts.jsonl", {"drill": label, "phase": "before", "a": before, "b": mapping("b"), "pool": pool()})
    step_writer_check("a", f"{label}: the writer just before")
    started = now()
    t0 = time.time()
    if mode == "graceful":
        command = ["docker", "restart", "-t", "300", DIND]
        subprocess.run(command, check=True, timeout=900)
    else:
        command = ["docker", "kill", DIND]
        subprocess.run(command, check=True, timeout=120)
        subprocess.run(["docker", "start", DIND], check=True, timeout=120)
        command += ["&&", "docker", "start", DIND]
    record("restarts.jsonl", {"drill": label, "phase": "the test host restarted", "command": " ".join(command), "from": started, "to": now()})
    for _ in range(180):
        if subprocess.run(["docker", "exec", DIND, "docker", "info"], capture_output=True).returncode == 0:
            break
        time.sleep(1)
    record("restarts.jsonl", {"drill": label, "phase": "its dockerd answers", "seconds": round(time.time() - t0),
                              "stack": sh("docker ps -a --format '{{.Names}} {{.State}} {{.Status}}' | sort").stdout.splitlines()})
    step_events()
    docker_report("a", f"{label}: a's container as Docker reports it after the restart")
    for _ in range(120):
        if api("GET", "/api/auth/setup-status")[0] == 200:
            break
        time.sleep(3)
    record("restarts.jsonl", {"drill": label, "phase": "the API answers again", "seconds": round(time.time() - t0),
                              "stack": sh("docker ps -a --format '{{.Names}} {{.State}} {{.Status}}' | sort").stdout.splitlines()})
    final = follow("a", f"{label}: a after the restart, nobody pressing Retry", ready)
    after = mapping("a")
    record("restarts.jsonl", {"drill": label, "phase": "a READY again by itself" if final.get("managementState") == "READY" else "a FAILED",
                              "seconds": round(time.time() - t0), "status": summarize(final), "a": after, "pool": pool(),
                              "sameIdentity": {"runnerId": before["runnerId"] == after["runnerId"], "volume": before["volume"] == after["volume"],
                                               "volumeUid": before["volumeUid"] == after["volumeUid"], "nextGeneration": after["generation"] == before["generation"] + 1,
                                               "noOwnerRequest": before["lastRequestKey"] == after["lastRequestKey"]},
                              "apiserverLog": apiserver_log(started, "POD_TERMINATED|generation .* retired|VOLUME_IN_USE")})
    step_verify("a", f"{label}: a's data after")
    step_writer_check("a", f"{label}: the writer's database after")
    record("restarts.jsonl", {"drill": label, "phase": "b, asleep through it", "b": mapping("b"), "pool": pool()})
    owner_action("b", "wake")
    step_follow("b", f"{label}: b woken after the restart", "READY")
    step_verify("b", f"{label}: b's data after")
    record("restarts.jsonl", {"drill": label, "phase": "after", "a": mapping("a"), "b": mapping("b"), "pool": pool()})
    inventory(f"{label}-after")


# ── a backup's helper container holds the volume while the runner is woken ──────────────────

def step_held_wake(key):
    """`key` asleep; scripts/managed-runner/volume-backup.sh backup of its volume, as the runbook gives it, started in the
    background; once its helper container refers to the volume the owner wakes the runner. It waits (VOLUME_IN_USE) and,
    once the backup's helper is gone, starts by itself: nobody presses Retry."""
    m = mapping(key)
    if m["state"] != "SLEEPING" or m["container"]:
        raise SystemExit(f"{key} must be asleep with no container: {m}")
    directory = f"/work/backups/held-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
    sh(f"mkdir -p {directory}; nohup bash {SCRIPT} backup {m['volume']} {directory} > {directory}.log 2>&1 &")
    record("held-wake.jsonl", {"step": "the runbook's backup started in the background", "account": key, "volume": m["volume"], "directory": directory})
    for _ in range(120):
        holders = sh(f"docker ps -a --no-trunc --filter volume={m['volume']} --format '{{{{.Names}}}} {{{{.Image}}}} {{{{.State}}}}'").stdout.split("\n")
        holders = [h for h in holders if h]
        if holders:
            break
        time.sleep(0.5)
    record("held-wake.jsonl", {"step": "the backup's helper container refers to the volume", "holders": holders})
    t0 = time.time()
    owner_action(key, "wake")
    seen_wait, done_at = None, None
    token = login(key)
    last = None
    while time.time() - t0 < 900:
        s = summarize(status_of(token))
        holders = [h for h in sh(f"docker ps -a --no-trunc --filter volume={m['volume']} --format '{{{{.Names}}}} {{{{.State}}}}'").stdout.split("\n") if h]
        row = mapping(key)
        snapshot = {**s, "holders": holders, "attempt": row["attempt"], "generation": row["generation"],
                    "detail": (row.get("lastError") or {}).get("detail")}
        if snapshot != last:
            record("held-wake.jsonl", {"step": "watching", "seconds": round(time.time() - t0, 1), **snapshot})
            last = snapshot
        if s["reason"] == "VOLUME_IN_USE" and seen_wait is None:
            seen_wait = round(time.time() - t0, 1)
        # [.] keeps pgrep from matching the shell that runs it (the run of 17:32Z had a plain '.', matched itself,
        # and recorded no end: Docker's events give it, the helper's die at 17:33:00.4).
        if done_at is None and not sh(f"pgrep -f 'volume-backup[.]sh backup {m['volume']}' || true").stdout.strip():
            done_at = round(time.time() - t0, 1)
            record("held-wake.jsonl", {"step": "the backup finished", "seconds": done_at,
                                       "log": sh(f"cat {directory}.log", check=False).stdout.strip().splitlines()[-4:],
                                       "files": sh(f"ls -l {directory}", check=False).stdout.strip().splitlines()})
        if s["managementState"] == "READY" and s["usable"] or s["managementState"] == "FAILED":
            break
        time.sleep(1)
    final = mapping(key)
    record("held-wake.jsonl", {"step": "the end", "account": key, "seconds": round(time.time() - t0, 1), "waitSeenAt": seen_wait,
                               "backupDoneAt": done_at, "status": summarize(status_of(token)), "mapping": final,
                               "sameVolume": final["volumeUid"] == m["volumeUid"], "ownerActions": ["wake"],
                               "apiserverLog": apiserver_log(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t0 - 5)), "VOLUME_IN_USE|waking|POD_TERMINATED")})


# ── a volume lost while its runner sleeps, then restored by the runbook ─────────────────────

def run_script(action, volume, directory=""):
    out = sh(f"bash {SCRIPT} {action} {volume} {directory}", check=False)
    return {"command": f"scripts/managed-runner/volume-backup.sh {action} {volume} {directory}".strip(), "exit": out.returncode,
            "output": out.stdout.strip().splitlines(), "stderr": out.stderr.strip().splitlines()[-6:]}


def step_lose_and_restore(key):
    """`key` asleep: back its volume up, lose it (docker volume rm), wake it (PVC_MISSING, not retryable), restore it with
    the runbook's script (the same labels, so the same UID), and let the manager notice (PVC_RESTORED); then the owner's
    Retry starts the runner on it."""
    m = mapping(key)
    if m["state"] != "SLEEPING" or m["container"]:
        raise SystemExit(f"{key} must be asleep with no container: {m}")
    directory = f"/work/backups/lost-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
    sh(f"mkdir -p {directory}")
    record("lost-volume.jsonl", {"step": "backup", "account": key, "mapping": identity(m), **run_script("backup", m["volume"], directory)})
    sh(f"docker volume rm {m['volume']}")
    record("lost-volume.jsonl", {"step": "the volume is lost (docker volume rm)", "volume": m["volume"],
                                 "exists": sh(f"docker volume inspect {m['volume']} >/dev/null 2>&1 && echo yes || echo no").stdout.strip()})
    owner_action(key, "wake")
    failed = follow(key, "woken with its volume gone", TARGETS["FAILED"], limit=300)
    record("lost-volume.jsonl", {"step": "the wake fails", "status": summarize(failed), "mapping": mapping(key), "pool": pool()})
    status = owner_action(key, "retry")
    record("lost-volume.jsonl", {"step": "the owner's Retry is refused while the volume is missing", "httpStatus": status})
    # The restore runs in the background (the 17:35Z run at fb93b9403 ran it in the foreground and looked only after it):
    # the owner's status and what holds the volume are recorded every second until the manager offers the retry, beside
    # the moment the script ends.
    started = now()
    sh(f"nohup sh -c 'bash {SCRIPT} restore {m['volume']} {directory}; echo exit=$?' > {directory}.restore.log 2>&1 &")
    t0 = time.time()
    token = login(key)
    last, ended_at = None, None
    while time.time() - t0 < 300:
        s = summarize(status_of(token))
        holders = [h for h in sh(f"docker ps -a --no-trunc --filter volume={m['volume']} --format '{{{{.Names}}}} {{{{.State}}}}'").stdout.split("\n") if h]
        if ended_at is None and "exit=" in sh(f"cat {directory}.restore.log", check=False).stdout:
            ended_at = round(time.time() - t0, 1)
            record("lost-volume.jsonl", {"step": "the restore script ended", "seconds": ended_at,
                                         "log": sh(f"cat {directory}.restore.log", check=False).stdout.strip().splitlines()})
        snapshot = {"reason": s["reason"], "canRetry": s["canRetry"], "holders": holders, "detail": ((mapping(key) or {}).get("lastError") or {}).get("detail")}
        if snapshot != last:
            record("lost-volume.jsonl", {"step": "watching the restore", "seconds": round(time.time() - t0, 1), **snapshot})
            last = snapshot
        if s["reason"] == "PVC_RESTORED" and ended_at is not None:
            break
        time.sleep(1)
    record("lost-volume.jsonl", {"step": "the manager finds the recorded volume back", "seconds": round(time.time() - t0, 1), "restoreEndedAt": ended_at,
                                 "status": s, "mapping": mapping(key), "apiserverLog": apiserver_log(started, "PVC_RESTORED|PVC_MISSING")})
    status = owner_action(key, "retry")
    final = follow(key, "after the owner's Retry", ready)
    after = mapping(key)
    record("lost-volume.jsonl", {"step": "READY on the restored volume", "retryHttpStatus": status, "status": summarize(final), "mapping": after,
                                 "sameIdentity": {"runnerId": after["runnerId"] == m["runnerId"], "volumeUid": after["volumeUid"] == m["volumeUid"]}})
    step_verify(key, "after the volume was restored and the runner retried")


# ── a real out-of-memory kill of the runner ─────────────────────────────────────────────────

def step_oom(key, limit="24m"):
    """The runner's container's memory limit lowered below what it uses (docker update, an operator's test action), so
    the kernel kills its largest process, the runner: Docker reports exit 137 and OOMKilled. The manager logs it, says
    it to the owner and starts the next generation, with the profile's own limit, by itself."""
    m = mapping(key)
    name = f"mr-{m['runnerId']}"
    usage = sh(f"docker stats --no-stream --format '{{{{.MemUsage}}}}' {name}", check=False).stdout.strip()
    started = now()
    t0 = time.time()
    out = sh(f"docker update --memory {limit} --memory-swap {limit} {name}", check=False)
    record("oom.jsonl", {"step": f"docker update --memory {limit} --memory-swap {limit}", "account": key, "before": identity(m), "usage": usage,
                         "exit": out.returncode, "stderr": out.stderr.strip()[-300:]})
    for _ in range(60):
        state = sh(f"docker inspect {name} --format '{{{{.State.Status}}}} {{{{.State.ExitCode}}}} {{{{.State.OOMKilled}}}}' 2>/dev/null", check=False).stdout.strip()
        if state and not state.startswith("running"):
            break
        time.sleep(1)
    docker_report(key, "after the memory limit was lowered")
    final = follow(key, "after the out-of-memory kill, nobody pressing Retry", ready)
    after = mapping(key)
    record("oom.jsonl", {"step": "the end", "seconds": round(time.time() - t0, 1), "dockerState": state, "status": summarize(final), "after": identity(after),
                         "apiserverLog": apiserver_log(started, "POD_TERMINATED|retired")})


def step_until_generation(key, label, generation):
    """Follow the account until its runner is READY and usable at `generation` or later: after a stop, the status reads
    READY until the manager's next pass sees it, so READY alone says nothing about the restart."""
    wanted = int(generation)

    def restarted(s):
        return s.get("managementState") == "FAILED" or (ready(s) and (mapping(key) or {}).get("generation", 0) >= wanted)
    final = follow(key, label, restarted)
    return record("steps.jsonl", {"step": f"{key}: {label}", **summarize(final), "mapping": mapping(key), "pool": pool()})


def main():
    step, args = sys.argv[1], sys.argv[2:]
    steps = {
        "accounts": step_accounts, "inventory": inventory, "seed": step_seed, "verify": step_verify, "writer": step_writer,
        "writer-check": step_writer_check, "follow": step_follow, "docker-report": docker_report, "sample": step_sample,
        "events": step_events, "pool": step_pool, "restart": step_restart, "held-wake": step_held_wake,
        "lose-and-restore": step_lose_and_restore, "oom": step_oom, "until-generation": step_until_generation,
        "mapping": lambda key: print(json.dumps(mapping(key), indent=2)),
        "sleep": lambda key: owner_action(key, "sleep"), "wake": lambda key: owner_action(key, "wake"),
        "retry": lambda key: owner_action(key, "retry"),
    }
    if step not in steps:
        raise SystemExit(f"unknown step {step}")
    steps[step](*args)


if __name__ == "__main__":
    main()
