#!/usr/bin/env python3
"""D5 (task 34hJ7S9C3isVnzIDDfSHD) driver for the isolated test host d5-dind: a default deployment
(scripts/install-server.sh, no flags) whose gateway is published on host 127.0.0.1:14086.

    drill.py <step> [args]

Steps: accounts, inventory <label>, review, limits <account>, seed <account> <label>, verify <account> <label>,
backup <account>, restore-check <account>, lose-and-restore <account>, writer <account>, writer-check <account> <label>,
sleep <account>, wake <account>, retry <account>, follow <account> <label>, sample <file>, events, docker-report <account> <label>,
pool <label>, channel-down, apiserver-down.

Records go to /mnt/data/tmp/34hJ7S9C3isVnzIDDfSHD/dind/work/evidence; account passwords stay in work/secrets.json (0600)
and access tokens only in memory. No secret is written to the evidence: the runner credentials, the channel token and
the placeholder key never appear in a record.
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

T = Path("/mnt/data/tmp/34hJ7S9C3isVnzIDDfSHD")
WORK = T / "dind" / "work"
EVIDENCE = WORK / "evidence"
BACKUPS = WORK / "backups"  # /work/backups inside the test host
BASE = "http://127.0.0.1:14086"
DIND = "d5-dind"
PLACEHOLDER_KEY = "sk-orbit-d5-placeholder-not-a-key"
KIT = Path(__file__).resolve().parent


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


def psql(sql, wait=180):
    """One query. Postgres may still be starting after the test host restarts: wait for it rather than fail."""
    deadline = time.time() + wait
    while True:
        result = sh(f"docker exec orbit-postgres psql -U orbit -d orbit -AtF '\t' -c {shlex.quote(sql)}", check=False)
        if result.returncode == 0:
            # Only the line ends: a row's trailing empty fields are tabs that strip() would take away.
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
    try:
        return status, (json.loads(raw) if raw else None)
    except ValueError:
        return status, {"nonJson": raw[:200].decode("utf-8", "replace")}


# ── accounts ─────────────────────────────────────────────────────────────────────────────────

def account(key):
    path = WORK / "secrets.json"
    stored = json.loads(path.read_text()) if path.exists() else {}
    if key not in stored:
        stored[key] = {"email": f"{key}@d5-drill.test", "password": secrets.token_urlsafe(18)}
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
    return {k: s.get(k) for k in ("managementState", "desiredState", "heartbeatStatus", "usable", "initialProvider", "revision")} | {
        "reason": reason.get("code")}


def mapping(key):
    """The account's managed_runner row, as an operator reads it."""
    a = account(key)
    row = psql("select m.runner_id, m.management_state, m.desired_state, m.generation, m.pvc_name, m.pvc_uid, m.pod_name, "
               "m.pod_uid, coalesce(m.last_error::text, ''), coalesce(m.fencing_receipt::text, '') from managed_runner m "
               f"join \"user\" u on u.id = m.owner_id where u.email = '{a['email']}'")
    if not row:
        return None
    f = row.split("\t") + [""] * 10
    return {"runnerId": f[0], "state": f[1], "desired": f[2], "generation": int(f[3]), "volume": f[4], "volumeUid": f[5],
            "container": f[6] or None, "instanceUid": f[7] or None, "lastError": json.loads(f[8]) if f[8] else None,
            "fencingReceipt": json.loads(f[9]) if f[9] else None}


def container_of(key):
    m = mapping(key)
    return f"mr-{m['runnerId']}" if m else None


def follow(key, label, until, limit=900, every=3, sign_in=True):
    """Record each change of the account's status until `until(status)`; sign Codex in with a placeholder key once
    its runner is up without a runtime (READY needs one, and this run has no model)."""
    token = login(key)
    last, started, signed = None, time.time(), False
    while True:
        current = status_of(token)
        short = summarize(current)
        if short != last:
            record("status-transitions.jsonl", {"account": key, "phase": label, **short})
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


def step_accounts():
    """Resumable: an account that already exists is signed in, not made again."""
    status, setup = api("GET", "/api/auth/setup-status")
    record("steps.jsonl", {"step": "setup-status", "status": status, "body": setup})
    a = account("a")
    if (setup or {}).get("needsSetup"):
        status, body = api("POST", "/api/auth/bootstrap", {"email": a["email"], "name": "D5 A", "password": a["password"]})
        record("steps.jsonl", {"step": "bootstrap: account a, the administrator", "status": status})
        if status not in (200, 201):
            raise SystemExit(body)
    admin = login("a")
    record("steps.jsonl", {"step": "account a signs in"})
    b = account("b")
    status, _ = api("POST", "/api/admin/users", {"email": b["email"], "name": "D5 B", "password": b["password"]}, token=admin)
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
echo "-- managed runner containers"; docker ps -a --filter label=orbit.managed-runner.kind=runner --format '{{.Names}}\t{{.State}}\t{{.Status}}\tgeneration={{.Label "orbit.managed-runner.generation"}}\tuid={{.Label "orbit.managed-runner.uid"}}\t{{.Mounts}}'
echo "-- managed runner volumes"; docker volume ls --filter label=orbit.managed-runner.instance --format '{{.Name}}\tkind={{.Label "orbit.managed-runner.kind"}}\towner={{.Label "orbit.managed-runner.owner"}}\tuid={{.Label "orbit.managed-runner.uid"}}'
echo "-- stack"; docker ps -a --filter label=com.docker.compose.project=orbit --format '{{.Names}}\t{{.State}}\t{{.Status}}'
echo "-- managed_runner rows"; docker exec orbit-postgres psql -U orbit -d orbit -AtF ' | ' -c "select u.email, m.management_state, m.desired_state, m.generation, m.pvc_name, m.pod_name, m.pod_uid, m.last_error->>'code' from managed_runner m join \"user\" u on u.id = m.owner_id order by u.email"
echo "-- capacity pool (reserved)"; docker exec orbit-postgres psql -U orbit -d orbit -AtF ' | ' -c "select cpu_millis, cpu_millis_reserved, memory_bytes, memory_bytes_reserved, pods, pods_reserved, storage_usable_bytes, durable_bytes_reserved from managed_runner_capacity"
'''
    text = sh(f"set -- {label}; " + script).stdout
    (EVIDENCE / f"inventory-{label}.txt").write_text(text)
    print(text, flush=True)


# ── data in a runner's volume ───────────────────────────────────────────────────────────────

SEED = r'''
set -e
mkdir -p /var/lib/orbit/home/d5-drill && cd /var/lib/orbit/home/d5-drill
[ -e blob-1 ] || head -c 8388608 /dev/urandom > blob-1
[ -e blob-2 ] || head -c 8388608 /dev/urandom > blob-2
[ -e note.txt ] || echo "D5 drill note, written $(date -u +%FT%TZ)" > note.txt
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
if [ ! -d repo/.git ]; then git init -q repo && cd repo && echo hello > README && git add README && git -c user.name=d5 -c user.email=d5@drill.invalid commit -q -m init && cd ..; fi
'''

VERIFY = r'''
cd /var/lib/orbit/home/d5-drill
echo "files:"; find . -path ./repo/.git -prune -o -type f ! -name 'writer*' -print0 | sort -z | xargs -0 sha256sum
echo "repo:"; git -C repo rev-parse HEAD; git -C repo fsck --no-progress 2>&1 | tail -n 2; echo "fsck-exit=$?"
echo "sqlite:"; sqlite3 drill.sqlite 'pragma integrity_check; select count(*), sum(length(v)) from t;'
echo "dump:"; sqlite3 drill.sqlite .dump | sha256sum
echo "identity:"; python3 -c 'import json; c=json.load(open("/var/lib/orbit/home/.orbit/config.json")); print(c["runnerId"], c["serverUrl"], c["workDir"])'
'''


def step_seed(key, label):
    name = container_of(key)
    sh(f"docker exec -i {name} sh -s", stdin=SEED)
    return step_verify(key, label)


def step_verify(key, label):
    name = container_of(key)
    out = sh(f"docker exec -i {name} sh -s", stdin=VERIFY, check=False)
    return record("data.jsonl", {"account": key, "label": label, "container": name, "exit": out.returncode,
                                 "report": out.stdout.strip().splitlines(), "stderr": out.stderr.strip()[-300:]})


WRITER = r'''
import os, sqlite3, time
c = sqlite3.connect("/var/lib/orbit/home/d5-drill/writer.sqlite")
c.execute("pragma journal_mode=wal")
c.execute("pragma synchronous=full")
c.execute("create table if not exists w(id integer primary key, at real, pad text)")
log = open("/var/lib/orbit/home/d5-drill/writer.log", "a")
while True:
    c.execute("insert into w(at, pad) values (?, ?)", (time.time(), "p" * 200))
    c.commit()
    n = c.execute("select max(id) from w").fetchone()[0]
    log.write(f"{n}\n"); log.flush(); os.fsync(log.fileno())
    time.sleep(0.05)
'''


def step_writer(key):
    name = container_of(key)
    sh(f"docker exec -i {name} sh -c 'cat > /tmp/d5-writer.py'", stdin=WRITER)
    sh(f"docker exec -d {name} python3 /tmp/d5-writer.py")
    time.sleep(3)
    out = sh(f"docker exec {name} sh -c 'tail -n 1 /var/lib/orbit/home/d5-drill/writer.log; pgrep -f d5-writer.py | head -1'", check=False)
    record("steps.jsonl", {"step": f"a SQLite writer runs in {key}'s container (commit, then log the committed id, fsync)",
                           "container": name, "lastLoggedAndProcess": out.stdout.split()})


def step_writer_check(key, label):
    name = container_of(key)
    out = sh(f"docker exec {name} sh -c \"cd /var/lib/orbit/home/d5-drill && echo logged=\\$(tail -n 1 writer.log) && "
             f"sqlite3 writer.sqlite 'pragma integrity_check; select max(id), count(*) from w;'\"", check=False)
    record("data.jsonl", {"account": key, "label": label, "writer": out.stdout.strip().splitlines(), "exit": out.returncode})


# ── the owner's actions ─────────────────────────────────────────────────────────────────────

def owner_action(key, action):
    token = login(key)
    current = status_of(token)
    status, body = api("POST", f"/api/managed-runner/{action}", {"idempotencyKey": f"d5-{action}-{secrets.token_hex(6)}",
                                                                 "revision": current.get("revision")}, token=token)
    record("steps.jsonl", {"step": f"{key} asks to {action}", "status": status,
                           "answer": summarize(body) if status in (200, 202) else body, "mapping": mapping(key)})
    return status


def step_disable(key, value):
    """The administrator (account a) disables or enables an account: a disabled owner's runner is never woken."""
    admin = login("a")
    status, users = api("GET", "/api/admin/users", token=admin)
    items = users if isinstance(users, list) else (users or {}).get("items", [])
    target = next(u for u in items if u.get("email") == account(key)["email"])
    status, _ = api("PATCH", f"/api/admin/users/{target['id']}/disabled", {"disabled": value == "true"}, token=admin)
    record("steps.jsonl", {"step": f"administrator sets {key} disabled={value}", "status": status, "mapping": mapping(key)})


def step_hold(key, seconds):
    """A helper container that refers to the account's volume (as a backup's would) for `seconds`."""
    m = mapping(key)
    sh(f"docker rm -f d5-helper >/dev/null 2>&1; docker run -d --name d5-helper --network none -v {m['volume']}:/data:ro alpine:3 sleep {seconds} >/dev/null")
    record("steps.jsonl", {"step": f"a helper container holds {key}'s volume for {seconds} s", "volume": m["volume"],
                           "holders": sh(f"docker ps -a --filter volume={m['volume']} --format '{{{{.Names}}}} {{{{.State}}}}'").stdout.split("\n")})


def step_release():
    sh("docker rm -f d5-helper >/dev/null 2>&1", check=False)
    record("steps.jsonl", {"step": "the helper container is removed"})


def step_watch(key, label, seconds):
    """Record the account's status every 3 s for `seconds`, whatever it does."""
    token = login(key)
    last, end = None, time.time() + int(seconds)
    while time.time() < end:
        short = summarize(status_of(token))
        if short != last:
            record("status-transitions.jsonl", {"account": key, "phase": label, **short,
                                                "detail": ((mapping(key) or {}).get("lastError") or {}).get("detail")})
            last = short
        time.sleep(3)


def step_follow(key, label, target):
    wanted = {"READY": ready, "SLEEPING": lambda s: s.get("managementState") in ("SLEEPING", "FAILED"),
              "FAILED": lambda s: s.get("managementState") == "FAILED"}[target]
    final = follow(key, label, wanted)
    record("steps.jsonl", {"step": f"{key}: {label}", **summarize(final), "mapping": mapping(key), "pool": pool()})


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
                                    "mapping": {k: m[k] for k in ("state", "desired", "generation", "instanceUid", "lastError", "fencingReceipt")}})


# ── backup and restore with scripts/managed-runner/volume-backup.sh, as the runbook gives them ──────

SCRIPT = "/work/kit/volume-backup.sh"  # the file committed as scripts/managed-runner/volume-backup.sh (same sha256)


def run_script(action, volume, directory):
    out = sh(f"bash {SCRIPT} {action} {volume} {directory}", check=False)
    return {"command": f"scripts/managed-runner/volume-backup.sh {action} {volume} {directory}", "exit": out.returncode,
            "output": out.stdout.strip().splitlines(), "stderr": out.stderr.strip().splitlines()[-6:]}


def step_backup(key):
    m = mapping(key)
    directory = f"/work/backups/{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
    result = run_script("backup", m["volume"], directory)
    (WORK / "last-backup").write_text(directory)
    record("backup-restore.jsonl", {"step": "backup", "account": key, "mapping": {k: m[k] for k in ("state", "generation", "container", "volume", "volumeUid")},
                                    **result, "files": sh(f"ls -l {directory}", check=False).stdout.strip().splitlines(),
                                    "labels": sh(f"cat {directory}/{m['volume']}.labels", check=False).stdout.strip()})


def step_restore_check(key):
    m = mapping(key)
    directory = (WORK / "last-backup").read_text().strip()
    record("backup-restore.jsonl", {"step": "check: unpack into a scratch volume and compare", "account": key,
                                    **run_script("check", m["volume"], directory),
                                    "scratchVolumesLeft": sh("docker volume ls -q --filter name=orbit-restore-check", check=False).stdout.split()})


def step_lose_and_restore(key):
    m = mapping(key)
    if m["state"] != "SLEEPING" or m["container"]:
        raise SystemExit(f"{key} must be asleep with no container: {m}")
    directory = (WORK / "last-backup").read_text().strip()
    before = json.loads(sh(f"docker volume inspect {m['volume']} --format '{{{{json .Labels}}}}'").stdout)
    record("backup-restore.jsonl", {"step": "restore refuses a volume that exists", "account": key, **run_script("restore", m["volume"], directory)})
    sh(f"docker volume rm {m['volume']}")
    record("backup-restore.jsonl", {"step": "the volume is lost (docker volume rm)", "account": key, "volume": m["volume"],
                                    "exists": sh(f"docker volume inspect {m['volume']} >/dev/null 2>&1 && echo yes || echo no").stdout.strip()})
    result = run_script("restore", m["volume"], directory)
    after = json.loads(sh(f"docker volume inspect {m['volume']} --format '{{{{json .Labels}}}}'").stdout)
    record("backup-restore.jsonl", {"step": "restore: recreated with its labels, unpacked and compared", "account": key, **result,
                                    "labelsAsBefore": before == after, "mapping": mapping(key)})


# ── the restart drill's observers ──────────────────────────────────────────────────────────

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
    """Docker's own events of this instance's containers and volumes, appended to evidence/docker-events.jsonl by a
    recorder that runs detached inside the test host (its pid in /run, which a restart of the test host clears). Start
    it again after the test host restarts: it dies with it."""
    subprocess.run(["docker", "exec", DIND, "sh", "-c", "[ -s /run/d5-events.pid ] && kill \"$(cat /run/d5-events.pid)\" 2>/dev/null; true"],
                   capture_output=True, timeout=30)
    subprocess.run(["docker", "exec", "-d", DIND, "sh", "-c",
                    "echo $$ > /run/d5-events.pid; exec docker events --filter label=orbit.managed-runner.instance "
                    "--format '{{json .}}' >> /work/evidence/docker-events.jsonl 2>&1"], check=True, timeout=30)
    time.sleep(1)
    alive = subprocess.run(["docker", "exec", DIND, "sh", "-c", "kill -0 \"$(cat /run/d5-events.pid)\" && echo recording"],
                           capture_output=True, text=True, timeout=30).stdout.strip()
    record("steps.jsonl", {"step": "Docker events recorder (re)started in the test host", "state": alive or "NOT RUNNING"})


def step_pool(label):
    record("pool.jsonl", {"label": label, "pool": pool(), "a": (mapping("a") or {}).get("state"), "b": (mapping("b") or {}).get("state")})


# ── the test host's restart: its own dockerd and everything in it ────────────────────────────

def apiserver_log(since, pattern="managed runner"):
    out = sh(f"docker logs --since {since} orbit-apiserver 2>&1 | grep -E '{pattern}' | sed 's/\\x1b\\[[0-9;]*m//g' | tail -n 40", check=False)
    return out.stdout.strip().splitlines()


def step_restart(mode):
    """`graceful`: docker restart -t 300 d5-dind (its dockerd stops every container, then starts again). `powercut`:
    docker kill d5-dind, then docker start. Account a is READY with a SQLite writer running; b has just been put to
    sleep. Records Docker's report, the stop proof the manager kept, the states, the pool, the data, before and after."""
    label = f"restart-{mode}"
    record("restarts.jsonl", {"drill": label, "phase": "before", "a": mapping("a"), "b": mapping("b"), "pool": pool()})
    step_writer_check("a", f"{label}: the writer just before")
    started = now()
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
    record("restarts.jsonl", {"drill": label, "phase": "its dockerd answers", "stack": sh("docker ps -a --format '{{.Names}} {{.State}} {{.Status}}' | sort").stdout.splitlines()})
    step_events()
    docker_report("a", f"{label}: a's container as Docker reports it after the restart")
    for _ in range(120):
        if api("GET", "/api/auth/setup-status")[0] == 200:
            break
        time.sleep(5)
    record("restarts.jsonl", {"drill": label, "phase": "the API answers again", "stack": sh("docker ps -a --format '{{.Names}} {{.State}} {{.Status}}' | sort").stdout.splitlines()})
    step_follow("a", f"{label}: a after the restart", "FAILED")
    record("restarts.jsonl", {"drill": label, "phase": "a failed on Docker's report", "a": mapping("a"), "b": mapping("b"), "pool": pool(),
                              "apiserverLog": apiserver_log(started)})
    docker_report("a", f"{label}: a's container while a is FAILED (not yet removed)")
    owner_action("a", "retry")
    step_follow("a", f"{label}: a after its owner's retry", "READY")
    record("restarts.jsonl", {"drill": label, "phase": "a READY again", "a": mapping("a"), "pool": pool()})
    step_verify("a", f"{label}: a's data after")
    step_writer_check("a", f"{label}: the writer's database after")
    record("restarts.jsonl", {"drill": label, "phase": "b, asleep through it", "b": mapping("b"), "pool": pool()})
    owner_action("b", "wake")
    step_follow("b", f"{label}: b woken after the restart", "READY")
    step_verify("b", f"{label}: b's data after")
    record("restarts.jsonl", {"drill": label, "phase": "after", "a": mapping("a"), "b": mapping("b"), "pool": pool()})
    inventory(f"{label}-after")


# ── outages ───────────────────────────────────────────────────────────────────────────────

def step_channel_down():
    record("steps.jsonl", {"step": "channel down: before", "a": mapping("a"), "b": mapping("b")})
    sh("docker stop orbit-docker-channel >/dev/null")
    record("steps.jsonl", {"step": "docker stop orbit-docker-channel"})
    owner_action("b", "wake")
    for _ in range(12):
        time.sleep(5)
        record("steps.jsonl", {"step": "channel down", "a": summarize(status_of(login("a"))), "b": summarize(status_of(login("b"))),
                               "bAttempt": psql("select attempt, last_error->>'code' from managed_runner m join \"user\" u on u.id = m.owner_id where u.email = 'b@d5-drill.test'")})
    sh("docker start orbit-docker-channel >/dev/null")
    record("steps.jsonl", {"step": "docker start orbit-docker-channel"})
    step_follow("b", "wake once the channel is back", "READY")
    step_follow("a", "a after the channel outage", "READY")
    logs = sh("docker logs --since 10m orbit-apiserver 2>&1 | grep -E 'did not answer|TRANSIENT|managed runner pass failed|waking' | tail -n 12", check=False)
    record("steps.jsonl", {"step": "apiserver's log during the outage", "lines": logs.stdout.strip().splitlines()})


def step_apiserver_down():
    a = mapping("a")
    record("steps.jsonl", {"step": "apiserver down: before", "a": a})
    sh("docker stop orbit-apiserver >/dev/null")
    record("steps.jsonl", {"step": "docker stop orbit-apiserver"})
    time.sleep(60)
    state = sh(f"docker inspect mr-{a['runnerId']} --format '{{{{.State.Status}}}} {{{{.State.StartedAt}}}}'").stdout.strip()
    record("steps.jsonl", {"step": "60 s later, the apiserver still down: the runner's container", "state": state})
    sh("docker start orbit-apiserver >/dev/null")
    record("steps.jsonl", {"step": "docker start orbit-apiserver"})
    for _ in range(60):
        if api("GET", "/api/auth/setup-status")[0] == 200:
            break
        time.sleep(5)
    step_follow("a", "a after the apiserver outage", "READY")
    record("steps.jsonl", {"step": "apiserver down: after", "a": mapping("a")})


def main():
    step, args = sys.argv[1], sys.argv[2:]
    if step == "accounts":
        step_accounts()
    elif step == "inventory":
        inventory(args[0])
    elif step == "seed":
        step_seed(*args)
    elif step == "verify":
        step_verify(*args)
    elif step == "writer":
        step_writer(*args)
    elif step == "writer-check":
        step_writer_check(*args)
    elif step in ("sleep", "wake", "retry"):
        owner_action(args[0], step)
    elif step == "follow":
        step_follow(*args)
    elif step == "docker-report":
        docker_report(*args)
    elif step == "backup":
        step_backup(*args)
    elif step == "restore-check":
        step_restore_check(*args)
    elif step == "lose-and-restore":
        step_lose_and_restore(*args)
    elif step == "sample":
        step_sample(args[0])
    elif step == "events":
        step_events()
    elif step == "pool":
        step_pool(args[0])
    elif step == "channel-down":
        step_channel_down()
    elif step == "apiserver-down":
        step_apiserver_down()
    elif step == "mapping":
        print(json.dumps(mapping(args[0]), indent=2))
    elif step == "disable":
        step_disable(*args)
    elif step == "hold":
        step_hold(*args)
    elif step == "release":
        step_release()
    elif step == "watch":
        step_watch(*args)
    elif step == "restart":
        step_restart(*args)
    else:
        raise SystemExit(f"unknown step {step}")


if __name__ == "__main__":
    main()
