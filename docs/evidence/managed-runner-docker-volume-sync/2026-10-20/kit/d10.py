#!/usr/bin/env python3
"""D10 (task 34ilx9dqVOKBeYZObuIjI) driver, on the HPC host, for the isolated test host d10-dind: one default
deployment (scripts/install-server.sh, no flags) in its checkout /work/orbit, the gateway published on host
127.0.0.1:15086, and nine accounts: `probe` (the administrator, whose runner sleeps once its probe session exists) and
u1..u8, whose runners carry the load.

    d10.py <step> [args]

Setup steps: resources, accounts, keys, ready, probe-session, pg-setup, cycle <variant> (every u-runner to sleep and
awake again, onto the variant's image), images (which image each runner container runs).
A round:  round <label> <variant> <runners> <load seconds> <cycles> <files> <think ms> [<commit every n turns, 0: never; 1>
          [<stagger seconds; 0>]]
  1. The HPC host's disk under the test host (/dev/sdb) must be quiet: over 15 s, at most 1 MB/s written and 1 MB/s
     read by anything but the test host and the disk's journal, and at most 15% utilisation; recorded either way.
  2. Probes for the whole round: a sampler (once a second: /proc/diskstats, /proc/stat, /proc/pressure/io,
     /proc/meminfo, the test host's and its containers' cgroups), an ftrace instance on syncfs(2), an API prober
     (8 requests a second as the probe account: three reads and a write), and pgbench in the deployment's Postgres
     (10 transactions a second: a one-row INSERT, which is a commit, and a read).
  3. 15 s idle, then the load: each of u1..u<runners> runs one session, turn after turn until the load window ends.
     Staggered, the runners start at random moments of a ramp before the window and their turns' think times vary.
     A turn is a FAKE-LOOP (fake-model.py): <cycles> times an edit, a `git commit` and a build writing <files> files,
     then an edit left for the runner, which the driver asks the runner to commit once the turn is answered (after
     every turn, or every n-th, or never).
  4. Records under evidence/rounds/<label>/; `report <label>...` summarises them (summarize.py).

Account passwords stay in /mnt/data/tmp/34ilx9dqVOKBeYZObuIjI/secrets.json (0600), access tokens only in memory, and
no secret is recorded: not the runner credentials, the channel's token or the placeholder model key.
"""

import http.client
import json
import os
from pathlib import Path
import random
import re
import secrets
import shlex
import subprocess
import sys
import threading
import time
import uuid

T = Path("/mnt/data/tmp/34ilx9dqVOKBeYZObuIjI")
EVIDENCE = T / "evidence"
HOST, PORT = "127.0.0.1", 15086
DIND = "d10-dind"
CHECKOUT = "/work/orbit"
FAKE_KEY = "sk-d10-fake-model-not-a-key"
MODEL_URL = "http://10.77.0.2:18080/anthropic"
LOADED = [f"u{i}" for i in range(1, 9)]
ACCOUNTS = ["probe"] + LOADED
TRACE = Path("/sys/kernel/tracing/instances/d10")
SDB = "sdb"


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def stamp():
    return {"wall": round(time.time(), 3), "mono": round(time.monotonic(), 3)}


def append(path, entry):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a") as out:
        out.write(json.dumps(entry, sort_keys=True) + "\n")


def record(file, entry):
    entry = {"at": now(), **entry}
    append(EVIDENCE / file, entry)
    print(json.dumps(entry, sort_keys=True), flush=True)
    return entry


def sh(script, check=True, stdin=None, timeout=1800, workdir=CHECKOUT):
    """A shell script inside the test host, in the deployment's checkout."""
    argv = ["docker", "exec", "-i", "-w", workdir, DIND, "sh", "-c", script]
    result = subprocess.run(argv, input=stdin, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode != 0:
        raise SystemExit(f"[{DIND}] {script[:200]!r} exited {result.returncode}: {result.stderr.strip()[:2000]}")
    return result


def psql(sql, db="orbit"):
    result = sh(f"docker exec orbit-postgres psql -U orbit -d {db} -AtqX -F '\t' -c {shlex.quote(sql)}", check=False)
    if result.returncode != 0:
        raise SystemExit(f"psql: {result.stderr.strip()[:500]}")
    return [line.split("\t") for line in result.stdout.splitlines()]


class Sql:
    """One psql session in the deployment's Postgres, kept open: a poll is one query, not a process."""

    def __init__(self):
        self.proc = subprocess.Popen(["docker", "exec", "-i", DIND, "docker", "exec", "-i", "orbit-postgres", "psql", "-U", "orbit",
                                      "-d", "orbit", "-AtqX", "-F", "\t"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, text=True, bufsize=1)
        self.lock = threading.Lock()

    def query(self, sql):
        with self.lock:
            self.proc.stdin.write(sql.rstrip().rstrip(";") + ";\n\\echo __D10_END__\n")
            self.proc.stdin.flush()
            rows = []
            for line in self.proc.stdout:
                line = line.rstrip("\n")
                if line == "__D10_END__":
                    return rows
                if line.startswith(("ERROR:", "psql:")):
                    raise RuntimeError(line)
                rows.append(line.split("\t"))
            raise RuntimeError("psql ended")

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(10)
        except Exception:
            self.proc.kill()


class Api:
    """HTTP to the deployment's gateway on one kept-alive connection."""

    def __init__(self, timeout=60):
        self.timeout = timeout
        self.conn = None

    def call(self, method, path, body=None, token=None):
        data = None if body is None else json.dumps(body).encode()
        headers = {"content-type": "application/json", "accept": "application/json", "user-agent": "d10-driver"}
        if token:
            headers["authorization"] = f"Bearer {token}"
        for attempt in (1, 2):
            if self.conn is None:
                self.conn = http.client.HTTPConnection(HOST, PORT, timeout=self.timeout)
            try:
                self.conn.request(method, path, body=data, headers=headers)
                response = self.conn.getresponse()
                raw = response.read()
                status = response.status
                break
            except (http.client.HTTPException, OSError) as error:
                self.conn.close()
                self.conn = None
                if attempt == 2:
                    return 0, {"error": str(error)}
        try:
            return status, (json.loads(raw) if raw else None)
        except ValueError:
            return status, {"nonJson": raw[:200].decode("utf-8", "replace")}


API = Api()


# ── accounts ───────────────────────────────────────────────────────────────────────────────────

def account(key):
    path = T / "secrets.json"
    stored = json.loads(path.read_text()) if path.exists() else {}
    if key not in stored:
        stored[key] = {"email": f"{key}@d10-volume-sync.test", "password": secrets.token_urlsafe(18)}
        path.write_text(json.dumps(stored))
        os.chmod(path, 0o600)
    return stored[key]


TOKENS = {}


def login(key, api=None, fresh=False, wait=300):
    if key in TOKENS and not fresh:
        return TOKENS[key]
    a, deadline = account(key), time.time() + wait
    while True:
        status, body = (api or Api()).call("POST", "/api/auth/login", {"email": a["email"], "password": a["password"]})
        if status in (200, 201):
            TOKENS[key] = body["accessToken"]
            return TOKENS[key]
        if time.time() > deadline:
            raise SystemExit(f"login {key}: {status} {body}")
        time.sleep(3)


def authed(key, method, path, body=None, api=None):
    api = api or Api()
    status, answer = api.call(method, path, body, token=login(key, api))
    if status == 401:
        status, answer = api.call(method, path, body, token=login(key, api, fresh=True))
    return status, answer


def status_of(key, api=None):
    status, body = authed(key, "GET", "/api/managed-runner", api=api)
    return body if status == 200 else {"httpStatus": status, "body": body}


def summarize(s):
    reason = s.get("reason") or {}
    return {k: s.get(k) for k in ("managementState", "desiredState", "heartbeatStatus", "usable", "revision")} | {
        "reason": reason.get("code"), "httpStatus": s.get("httpStatus")}


def mapping(key):
    a = account(key)
    rows = psql("select m.runner_id, m.management_state, m.generation, coalesce(m.pod_name, ''), m.default_workspace_id "
                f"from managed_runner m join \"user\" u on u.id = m.owner_id where u.email = '{a['email']}'")
    if not rows:
        return None
    f = rows[0]
    return {"runnerId": f[0], "state": f[1], "generation": int(f[2]), "container": f[3] or None, "workspaceId": f[4] or None}


def follow(key, label, until, limit=900, every=3):
    last, started = None, time.time()
    while True:
        current = status_of(key)
        short = summarize(current)
        if short != last:
            record("status-transitions.jsonl", {"account": key, "phase": label, **short})
            last = short
        if until(current):
            return current
        if time.time() - started > limit:
            raise SystemExit(f"{key} {label}: gave up after {limit}s at {short}")
        time.sleep(every)


def ready(s):
    return s.get("managementState") == "READY" and s.get("usable")


def step_resources():
    """Runners of 1 CPU and 1 GiB, so that eight fit the test host's budget (the default is 2 CPUs and 4 GiB)."""
    script = r'''
import json, os
path = "data/managed-runners/profile.json"
info = os.stat(path)
profile = json.load(open(path))
before = dict(profile["runner"]["resources"])
profile["runner"]["resources"].update(cpu="1", memory="1Gi")
temporary = path + ".d10"
open(temporary, "w").write(json.dumps(profile, indent=2) + "\n")
os.chmod(temporary, info.st_mode & 0o7777); os.chown(temporary, info.st_uid, info.st_gid); os.replace(temporary, path)
print(json.dumps({"before": before, "after": profile["runner"]["resources"], "tmpSizeLimit": profile["runner"].get("tmpSizeLimit"),
                  "storage": profile.get("storage"), "capacity": profile.get("capacity")}))
'''
    out = sh("python3 - && docker compose up -d --no-deps --force-recreate apiserver >/dev/null 2>&1", stdin=script).stdout
    record("steps.jsonl", {"step": "runner resources in profile.json, the apiserver recreated", "profile": json.loads(out.splitlines()[0])})


def step_accounts():
    status, setup = API.call("GET", "/api/auth/setup-status")
    record("steps.jsonl", {"step": "setup-status", "status": status, "body": setup})
    a = account("probe")
    if (setup or {}).get("needsSetup"):
        status, body = API.call("POST", "/api/auth/bootstrap", {"email": a["email"], "name": "D10 probe", "password": a["password"]})
        record("steps.jsonl", {"step": "bootstrap: the probe account, the administrator", "status": status})
        if status not in (200, 201):
            raise SystemExit(body)
    for key in LOADED:
        b = account(key)
        status, _ = authed("probe", "POST", "/api/admin/users", {"email": b["email"], "name": f"D10 {key}", "password": b["password"]})
        record("steps.jsonl", {"step": f"the administrator creates account {key} (409: it exists already)", "status": status})
    for key in ACCOUNTS:
        login(key, fresh=True)
        record("steps.jsonl", {"step": f"{key} signs in"})


def step_keys():
    slugs_path = T / "keys.json"
    slugs = json.loads(slugs_path.read_text()) if slugs_path.exists() else {}
    for key in ACCOUNTS:
        if key in slugs:
            continue
        body = {"label": "FAKE model (D10, not a model)", "presetSlug": "deepseek", "baseUrl": MODEL_URL, "apiKey": FAKE_KEY}
        status, answer = authed(key, "POST", "/api/providers/mine", body)
        record("steps.jsonl", {"step": f"{key}: a DeepSeek-preset key whose endpoint is the fake model", "status": status,
                               "slug": (answer or {}).get("slug") if isinstance(answer, dict) else None})
        if status not in (200, 201):
            raise SystemExit(answer)
        slugs[key] = answer["slug"]
        slugs_path.write_text(json.dumps(slugs))


def step_ready(keys=None):
    threads, errors = [], []

    def one(key):
        try:
            final = follow(key, "ready", ready)
            record("steps.jsonl", {"step": f"{key}'s managed runner", **summarize(final), "mapping": mapping(key)})
        except BaseException as error:  # noqa: BLE001 - reported below
            errors.append(f"{key}: {error}")
    for key in keys or ACCOUNTS:
        threads.append(threading.Thread(target=one, args=(key,)))
        threads[-1].start()
    for thread in threads:
        thread.join()
    if errors:
        raise SystemExit("; ".join(errors))


TURN_ENDED = ("ANSWERED", "FAILED", "INTERRUPTED", "CANCELLED", "ERROR")


def turn_of(sql, session_uuid):
    rows = sql.query(f"select seq, status, extract(epoch from created_at), coalesce(extract(epoch from answered_at)::text, '') "
                     f"from conversation_turn where session_id = '{session_uuid}' order by seq desc limit 1")
    if not rows:
        return None
    seq, status, created, answered = rows[0]
    return {"seq": int(seq), "status": status, "createdAt": float(created), "answeredAt": float(answered) if answered else None}


def session_uuid_by_title(sql, title, wait=30):
    deadline = time.time() + wait
    while True:
        rows = sql.query(f"select id from session where title = '{title}' order by created_at desc limit 1")
        if rows:
            return rows[0][0]
        if time.time() > deadline:
            raise RuntimeError(f"no session titled {title}")
        time.sleep(0.2)


def step_probe_session():
    """The probe account's session, which the API prober reads and renames; its runner then sleeps for good."""
    st = status_of("probe")
    slug = json.loads((T / "keys.json").read_text())["probe"]
    title = "d10 probe session"
    status, answer = authed("probe", "POST", "/api/sessions", {"workspaceId": st["workspaceId"], "prompt": "D10-PROBE hello",
                                                             "title": title, "provider": slug})
    if status not in (200, 201):
        raise SystemExit(f"probe session: {status} {answer}")
    sql = Sql()
    suuid = session_uuid_by_title(sql, title)
    deadline = time.time() + 300
    while True:
        turn = turn_of(sql, suuid)
        if turn and turn["status"] in TURN_ENDED:
            break
        if time.time() > deadline:
            raise SystemExit(f"probe session's turn: {turn}")
        time.sleep(1)
    sql.close()
    (T / "probe-session.json").write_text(json.dumps({"id": answer["id"], "uuid": suuid, "workspaceId": st["workspaceId"]}))
    record("steps.jsonl", {"step": "the probe session", "session": answer["id"], "turn": turn})
    # An open session keeps its runner awake (the sleep is refused 409); an ended one is still read and renamed.
    status, _ = authed("probe", "POST", f"/api/sessions/{answer['id']}/end", {})
    record("steps.jsonl", {"step": "the probe session ends", "status": status})
    sleep_runner("probe")


def sleep_runner(key):
    current = status_of(key)
    status, answer = authed(key, "POST", "/api/managed-runner/sleep", {"idempotencyKey": f"d10-sleep-{secrets.token_hex(4)}",
                                                                     "revision": current.get("revision")})
    record("steps.jsonl", {"step": f"{key} asks its runner to sleep", "status": status, "answer": summarize(answer or {})})
    if status not in (200, 201, 202):
        raise SystemExit(f"{key}: the sleep was refused: {status} {answer}")
    follow(key, "sleep", lambda s: s.get("managementState") == "SLEEPING", limit=600)


def wake_runner(key):
    status, answer = authed(key, "POST", "/api/managed-runner/wake", {"idempotencyKey": f"d10-wake-{secrets.token_hex(4)}"})
    record("steps.jsonl", {"step": f"{key} wakes its runner", "status": status, "answer": summarize(answer or {})})
    follow(key, "wake", ready, limit=900)


def images():
    """Which image each managed runner container runs, and the image the channel is configured with."""
    out = sh("ids=$(docker ps -q --filter label=orbit.managed-runner.kind=runner); "
             "[ -z \"$ids\" ] || docker inspect -f '{{slice .Name 1}} {{.Image}}' $ids; "
             "python3 -c 'import json; print(\"configured\", json.load(open(\"data/managed-runners/channel.json\"))[\"image\"])'").stdout
    found, configured = {}, None
    for line in out.splitlines():
        name, image, *_ = line.split()
        if name == "configured":
            configured = image
        else:
            found[name] = image
    return found, configured


def variant_image(variant):
    out = sh(f"docker image inspect -f '{{{{.Id}}}}' orbit-managed-runner:d10-{variant}", check=False).stdout.strip()
    return out or None


def step_cycle(variant):
    """Every loaded runner to sleep and awake again, so that its next container runs the variant's image."""
    wanted = variant_image(variant)
    _, configured = images()
    if not wanted or wanted != configured:
        raise SystemExit(f"the channel is configured with {configured}, not d10-{variant} ({wanted}): run image.sh first")
    errors = []

    def one(key):
        try:
            sleep_runner(key)
            wake_runner(key)
        except BaseException as error:  # noqa: BLE001
            errors.append(f"{key}: {error}")
    threads = [threading.Thread(target=one, args=(key,)) for key in LOADED]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    running, _ = images()
    by_account = {key: running.get(f"mr-{mapping(key)['runnerId']}") for key in LOADED}
    record("steps.jsonl", {"step": f"every loaded runner slept and woke onto d10-{variant}", "image": wanted, "containers": by_account,
                           "errors": errors})
    if errors or any(image != wanted for image in by_account.values()):
        raise SystemExit(f"not every runner runs d10-{variant}: {by_account} {errors}")


def step_pg_setup():
    psql("create extension if not exists pg_stat_statements")
    if not psql("select 1 from pg_database where datname = 'd10probe'"):
        psql("create database d10probe")
    psql("create table if not exists probe (id bigserial primary key, at timestamptz not null, pad text not null)", db="d10probe")
    sh("docker exec -i orbit-postgres sh -c 'cat > /tmp/d10-write.sql'",
       stdin="INSERT INTO probe (at, pad) VALUES (clock_timestamp(), repeat('x', 200));\n")
    sh("docker exec -i orbit-postgres sh -c 'cat > /tmp/d10-read.sql'",
       stdin="SELECT count(*) FROM (SELECT id FROM probe ORDER BY id DESC LIMIT 50) recent;\n")
    record("steps.jsonl", {"step": "pg_stat_statements, the d10probe database and pgbench's two scripts",
                           "postgres": psql("select version()")[0][0]})


# ── probes ─────────────────────────────────────────────────────────────────────────────────────

def read(path):
    try:
        return Path(path).read_text()
    except OSError:
        return ""


def dind_cgroup():
    cid = subprocess.run(["docker", "inspect", "-f", "{{.Id}}", DIND], capture_output=True, text=True, check=True).stdout.strip()
    path = Path(f"/sys/fs/cgroup/system.slice/docker-{cid}.scope")
    if not path.is_dir():
        raise SystemExit(f"no cgroup at {path}")
    return path


def container_cgroups():
    """The test host's containers' cgroups, by container name: the runners', Postgres's and the apiserver's."""
    root = dind_cgroup()
    out = sh("docker ps --no-trunc --format '{{.ID}} {{.Names}}'").stdout
    found = {}
    for line in out.splitlines():
        cid, name = line.split()
        if not (name.startswith("mr-") or name in ("orbit-postgres", "orbit-apiserver", "orbit-gateway")):
            continue
        for candidate in root.rglob(f"*{cid}*"):
            if candidate.is_dir():
                found[name] = str(candidate)
                break
    return found


def cgroup_counters(path):
    path = Path(path)
    out = {}
    for line in read(path / "io.stat").splitlines():
        fields = line.split()
        if fields and fields[0] == "8:16":
            out["io"] = {k: int(v) for k, v in (f.split("=") for f in fields[1:])}
    for line in read(path / "io.pressure").splitlines():
        kind, *rest = line.split()
        out[f"ioPressure{kind.title()}"] = int(dict(f.split("=") for f in rest)["total"])
    cpu = dict(line.split() for line in read(path / "cpu.stat").splitlines() if line)
    out["cpu"] = {k: int(cpu[k]) for k in ("usage_usec", "throttled_usec", "nr_throttled") if k in cpu}
    mem = dict(line.split() for line in read(path / "memory.stat").splitlines() if line)
    out["mem"] = {k: int(mem[k]) for k in ("file_dirty", "file_writeback", "file", "workingset_refault_file", "pgmajfault") if k in mem}
    current = read(path / "memory.current").strip()
    if current:
        out["mem"]["current"] = int(current)
    return out


def jbd2_pid():
    for proc in Path("/proc").iterdir():
        if proc.name.isdigit() and read(proc / "comm").strip() == f"jbd2/{SDB}-8":
            return proc.name
    return None


class Sampler(threading.Thread):
    """Once a second: the raw counters; summarize.py turns them into rates."""

    def __init__(self, out, cgroups):
        super().__init__(daemon=True)
        self.out, self.cgroups, self.stop = out, cgroups, threading.Event()
        self.jbd2 = jbd2_pid()

    def run(self):
        while not self.stop.is_set():
            sample = stamp()
            for line in read("/proc/diskstats").splitlines():
                f = line.split()
                if f[2] in (SDB, "nvme0n1"):
                    sample[f[2]] = [int(x) for x in f[3:]]
            cpu = read("/proc/stat").splitlines()[0].split()
            sample["cpu"] = [int(x) for x in cpu[1:]]
            for line in read("/proc/pressure/io").splitlines():
                kind, *rest = line.split()
                sample[f"ioPressure{kind.title()}"] = int(dict(f.split("=") for f in rest)["total"])
            mem = dict(line.split(":", 1) for line in read("/proc/meminfo").splitlines())
            sample["dirtyKb"] = int(mem["Dirty"].split()[0])
            sample["memAvailableKb"] = int(mem["MemAvailable"].split()[0])
            sample["writebackKb"] = int(mem["Writeback"].split()[0])
            if self.jbd2:
                io = dict(line.split(": ") for line in read(f"/proc/{self.jbd2}/io").splitlines() if ": " in line)
                sample["jbd2WriteBytes"] = int(io.get("write_bytes", 0))
            sample["load"] = read("/proc/loadavg").split()[:3]
            sample["cgroups"] = {name: cgroup_counters(path) for name, path in self.cgroups.items()}
            append(self.out, sample)
            self.stop.wait(1.0)


TRACE_LINE = re.compile(r"^\s*(?P<comm>.+)-(?P<tid>\d+)\s+\[\d+\]\s+\S+\s+(?P<ts>\d+\.\d+): sys_syncfs(?P<rest>.*)$")


class SyncfsTrace(threading.Thread):
    """syncfs(2) on the whole HPC host, through an ftrace instance of its own (mono clock): every call, its thread, the
    container it ran in and how long it took."""

    def __init__(self, out):
        super().__init__(daemon=True)
        self.out, self.stop, self.cgroup_of, self.open = out, threading.Event(), {}, {}

    def arm(self):
        TRACE.mkdir(exist_ok=True)
        (TRACE / "tracing_on").write_text("0")
        (TRACE / "trace_clock").write_text("mono")
        (TRACE / "buffer_size_kb").write_text("8192")
        (TRACE / "trace").write_text("")
        for event in ("sys_enter_syncfs", "sys_exit_syncfs"):
            (TRACE / "events/syscalls" / event / "enable").write_text("1")
        (TRACE / "tracing_on").write_text("1")

    def disarm(self):
        self.stop.set()
        (TRACE / "trace_marker").write_text("d10 trace stop\n")
        time.sleep(0.5)
        (TRACE / "tracing_on").write_text("0")
        for event in ("sys_enter_syncfs", "sys_exit_syncfs"):
            (TRACE / "events/syscalls" / event / "enable").write_text("0")

    def run(self):
        with open(TRACE / "trace_pipe") as pipe:
            for line in pipe:
                match = TRACE_LINE.match(line)
                if match:
                    tid, ts, rest = match["tid"], float(match["ts"]), match["rest"]
                    if tid not in self.cgroup_of:
                        self.cgroup_of[tid] = read(f"/proc/{tid}/cgroup").strip()
                    if rest.startswith("("):
                        self.open[tid] = ts
                    elif tid in self.open:
                        started = self.open.pop(tid)
                        append(self.out, {"tid": int(tid), "comm": match["comm"].strip(), "start": started, "end": ts,
                                          "ms": round((ts - started) * 1000, 3), "ret": rest.split("->")[-1].strip(),
                                          "cgroup": self.cgroup_of[tid]})
                if self.stop.is_set() and "d10 trace stop" in line:
                    return


class Prober(threading.Thread):
    """The probe account's API traffic, eight requests a second on one kept-alive connection: its runner's status, its
    session, its session list, and a rename of the session (a write)."""

    def __init__(self, out, session):
        super().__init__(daemon=True)
        self.out, self.session, self.stop, self.api = out, session, threading.Event(), Api(timeout=30)

    def run(self):
        token, n = login("probe", self.api, fresh=True), 0
        endpoints = [("status", "GET", "/api/managed-runner"), ("session", "GET", f"/api/sessions/{self.session}"),
                     ("list", "GET", "/api/sessions?view=open&limit=20"), ("rename", "PATCH", f"/api/sessions/{self.session}")]
        next_at = time.monotonic()
        while not self.stop.is_set():
            name, method, path = endpoints[n % len(endpoints)]
            body = {"title": f"d10 probe session {n}"} if method == "PATCH" else None
            started, wall = time.monotonic(), time.time()
            status, _ = self.api.call(method, path, body, token=token)
            took = time.monotonic() - started
            if status == 401:
                token = login("probe", self.api, fresh=True)
            append(self.out, {"wall": round(wall, 3), "mono": round(started, 3), "ep": name, "status": status, "ms": round(took * 1000, 2)})
            n += 1
            next_at += 0.125
            self.stop.wait(max(0.0, next_at - time.monotonic()))


# ── the load ───────────────────────────────────────────────────────────────────────────────────

class Worker(threading.Thread):
    """One account's session: a FAKE-LOOP turn, then the runner's commit of what it left, turn after turn until the
    load window ends."""

    def __init__(self, key, tag, deadline, cycles, files, think_ms, out, commit_every=1, start_delay=0.0, jitter=0.0, seed=None):
        super().__init__(daemon=True)
        self.key, self.tag, self.deadline, self.commit_every = key, tag, deadline, commit_every
        self.cycles, self.files, self.think_ms, self.out = cycles, files, think_ms, out
        self.start_delay, self.jitter, self.random = start_delay, jitter, random.Random(seed)
        self.error = None

    def prompt(self, k):
        """A turn's message. With jitter, each turn's think time is drawn from think ms x (1 +- jitter), so that runners
        started apart do not fall into step again."""
        word = f"{self.key}{self.tag}t{k}"
        think = round(self.think_ms * self.random.uniform(1 - self.jitter, 1 + self.jitter))
        return word, f"D10-{self.key.upper()}-{self.tag.upper()}-T{k} a turn of work. FAKE-LOOP {self.cycles} {self.files} {think} {word}"

    def run(self):
        sql, api = Sql(), Api(timeout=150)
        try:
            self.work(sql, api)
        except BaseException as error:  # noqa: BLE001 - recorded
            self.error = repr(error)
            append(self.out / "errors.jsonl", {"account": self.key, "error": self.error, **stamp()})
        finally:
            sql.close()

    def work(self, sql, api):
        time.sleep(self.start_delay)
        st = status_of(self.key, api)
        slug = json.loads((T / "keys.json").read_text())[self.key]
        title = f"d10 {self.tag} {self.key}"
        word, text = self.prompt(0)
        sent = stamp()
        status, answer = authed(self.key, "POST", "/api/sessions", {"workspaceId": st["workspaceId"], "prompt": text, "title": title,
                                                                    "provider": slug}, api=api)
        if status not in (200, 201):
            raise RuntimeError(f"session: {status} {answer}")
        session, suuid, k = answer["id"], session_uuid_by_title(sql, title), 0
        while True:
            turn = self.wait_turn(sql, suuid, k)
            append(self.out / "turns.jsonl", {"account": self.key, "k": k, "word": word, "session": session, "sent": sent, **turn})
            if turn["status"] != "ANSWERED":
                raise RuntimeError(f"turn {k} ended {turn['status']}")
            if self.commit_every and (k + 1) % self.commit_every == 0:
                self.commit(sql, api, session, suuid, k)
            if time.monotonic() >= self.deadline:
                break
            k += 1
            word, text = self.prompt(k)
            sent = stamp()
            status, answer = authed(self.key, "POST", f"/api/sessions/{session}/turns", {"clientTurnId": str(uuid.uuid4()), "content": text}, api=api)
            if status not in (200, 201):
                raise RuntimeError(f"turn {k}: {status} {answer}")
        status, _ = authed(self.key, "POST", f"/api/sessions/{session}/end", {}, api=api)
        append(self.out / "sessions.jsonl", {"account": self.key, "session": session, "uuid": suuid, "turns": k + 1, "endStatus": status})

    def wait_turn(self, sql, suuid, k, limit=600):
        deadline, seen_seq = time.monotonic() + limit, None
        while True:
            turn = turn_of(sql, suuid)
            if turn and turn["seq"] >= k and turn["status"] in TURN_ENDED:
                return {**turn, "observed": stamp()}
            if time.monotonic() > deadline:
                return {**(turn or {}), "status": "TIMEOUT", "observed": stamp()}
            time.sleep(0.25)

    def commit(self, sql, api, session, suuid, k):
        attempts = []
        for attempt in range(1, 11):
            asked = stamp()
            status, answer = authed(self.key, "POST", f"/api/sessions/{session}/commit", {}, api=api)
            deadline = time.monotonic() + 120
            while True:
                rows = sql.query(f"select coalesce(commit_status, ''), coalesce(left(commit_result_message, 160), ''), "
                                 f"coalesce(left(commit_error, 160), '') from session where id = '{suuid}'")
                state = rows[0] if rows else ["", "", ""]
                if state[0] not in ("pending",) or time.monotonic() > deadline:
                    break
                time.sleep(0.05)
            done = stamp()
            attempts.append({"attempt": attempt, "asked": asked, "done": done, "httpStatus": status, "commitStatus": state[0],
                             "message": state[1], "error": state[2], "ms": round((done["mono"] - asked["mono"]) * 1000, 1)})
            if state[0] == "committed" or "nothing to commit" in (state[1] + state[2]).lower():
                break
            time.sleep(1)
        append(self.out / "commits.jsonl", {"account": self.key, "k": k, "session": session, "attempts": attempts,
                                            "final": attempts[-1]["commitStatus"], "ms": attempts[-1]["ms"]})


# ── a round ────────────────────────────────────────────────────────────────────────────────────

def disk_quiet(seconds=15):
    """What the HPC host's disk under the test host does without a round: all of it, and what is not the test host's
    own (sdb less the test host's cgroup and the journal thread)."""
    dind, jbd2 = dind_cgroup(), jbd2_pid()

    def snap():
        disk = next([int(x) for x in line.split()[3:]] for line in read("/proc/diskstats").splitlines() if line.split()[2] == SDB)
        own = cgroup_counters(dind).get("io", {})
        journal = dict(l.split(": ") for l in read(f"/proc/{jbd2}/io").splitlines() if ": " in l) if jbd2 else {}
        return disk, own, int(journal.get("write_bytes", 0))
    (a, own_a, j_a), t0 = snap(), time.monotonic()
    time.sleep(seconds)
    (b, own_b, j_b), t1 = snap(), time.monotonic()
    dt = t1 - t0
    written, read_ = (b[6] - a[6]) * 512 / dt / 1e6, (b[2] - a[2]) * 512 / dt / 1e6
    own_w = (own_b.get("wbytes", 0) - own_a.get("wbytes", 0)) / dt / 1e6
    own_r = (own_b.get("rbytes", 0) - own_a.get("rbytes", 0)) / dt / 1e6
    journal = (j_b - j_a) / dt / 1e6
    return {"seconds": seconds, "utilPercent": round((b[9] - a[9]) / (dt * 1000) * 100, 2), "writeMBps": round(written, 3),
            "readMBps": round(read_, 3), "testHostWriteMBps": round(own_w, 3), "testHostReadMBps": round(own_r, 3),
            "journalWriteMBps": round(journal, 3), "othersWriteMBps": round(max(0.0, written - own_w - journal), 3),
            "othersReadMBps": round(max(0.0, read_ - own_r), 3), "load": read("/proc/loadavg").split()[:3],
            "memAvailableMiB": int(dict(line.split(":", 1) for line in read("/proc/meminfo").splitlines())["MemAvailable"].split()[0]) // 1024,
            "qemu": subprocess.run(["pgrep", "-c", "qemu"], capture_output=True, text=True).stdout.strip()}


def step_round(label, variant, runners, load_seconds, cycles, files, think_ms, tag, commit_every=1, stagger=0):
    out = EVIDENCE / "rounds" / label
    if out.exists():
        raise SystemExit(f"{out} exists: a round's label is used once")
    out.mkdir(parents=True)
    wanted = variant_image(variant)
    running, configured = images()
    loaded = LOADED[:runners]
    by_account = {key: running.get(f"mr-{mapping(key)['runnerId']}") for key in LOADED}
    if configured != wanted or any(by_account[key] != wanted for key in loaded):
        raise SystemExit(f"round {label}: not every loaded runner runs d10-{variant} ({wanted}): {by_account}")
    states = {key: summarize(status_of(key)) for key in loaded}
    if not all(s["managementState"] == "READY" for s in states.values()):
        raise SystemExit(f"round {label}: not every loaded runner is READY: {states}")
    quiet = disk_quiet()
    for _ in range(20):
        if quiet["othersWriteMBps"] <= 1 and quiet["othersReadMBps"] <= 1 and quiet["utilPercent"] <= 15:
            break
        append(out / "quiet.jsonl", {"waiting": quiet, **stamp()})
        time.sleep(30)
        quiet = disk_quiet()
    else:
        raise SystemExit(f"round {label}: the disk did not go quiet: {quiet}")
    probe = json.loads((T / "probe-session.json").read_text())
    cgroups = container_cgroups()
    meta = {"label": label, "variant": variant, "image": wanted, "runners": runners, "loaded": loaded, "loadSeconds": load_seconds,
            "cycles": cycles, "files": files, "thinkMs": think_ms, "commitEvery": commit_every, "staggerSeconds": stagger,
            "thinkJitter": 0.5 if stagger else 0.0, "tag": tag, "quietBefore": quiet, "states": states,
            "containers": {key: f"mr-{mapping(key)['runnerId']}" for key in LOADED}, "cgroups": cgroups, "started": now(), **stamp()}
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps({"round": label, "quiet": quiet, "loaded": loaded}), flush=True)

    sh("docker exec orbit-postgres psql -U orbit -d orbit -AtqX -c 'select pg_stat_statements_reset()' >/dev/null; "
       "docker exec orbit-postgres psql -U orbit -d orbit -AtqX -c \"select pg_stat_reset_shared('wal')\" >/dev/null")
    gateway_since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 2))  # the test host shares the HPC host's clock
    idle_seconds, tail_seconds = 15, 10
    pg_seconds = idle_seconds + load_seconds + 240
    pgbench = subprocess.Popen(["docker", "exec", DIND, "docker", "exec", "-w", "/tmp", "orbit-postgres", "sh", "-c",
                                f"rm -f d10pgb-{tag}.*; exec pgbench -U orbit -n -c 1 -j 1 -R 10 -T {pg_seconds} "
                                f"-f /tmp/d10-write.sql@1 -f /tmp/d10-read.sql@1 -l --log-prefix=d10pgb-{tag} d10probe"],
                               stdout=open(out / "pgbench.txt", "w"), stderr=subprocess.STDOUT)
    sampler, tracer, prober = Sampler(out / "samples.jsonl", {"dind": str(dind_cgroup()), **cgroups}), SyncfsTrace(out / "syncfs.jsonl"), \
        Prober(out / "api-probe.jsonl", probe["id"])
    tracer.arm()
    for thread in (sampler, tracer, prober):
        thread.start()
    phases = {"probesStarted": stamp()}
    time.sleep(idle_seconds)
    # Staggered: each runner starts at its own moment within the ramp and its turns think 0.5 to 1.5 times think ms, so
    # the runners are out of step when the measured window opens, as different people's sessions are. Unstaggered (plans
    # 1 to 3): every runner starts at once and every turn is alike, so the runners stay in step.
    rng = random.Random(label)
    delays = {key: (rng.uniform(0, stagger) if stagger else 0.0) for key in loaded}
    phases["rampStarted"] = stamp()
    deadline = time.monotonic() + stagger + load_seconds
    workers = [Worker(key, tag, deadline, cycles, files, think_ms, out, commit_every, delays[key], 0.5 if stagger else 0.0,
                      f"{label}/{key}") for key in loaded]
    for worker in workers:
        worker.start()
    time.sleep(stagger)
    phases["loadStarted"] = stamp()
    meta["startDelays"] = {key: round(delay, 2) for key, delay in delays.items()}
    time.sleep(load_seconds)
    phases["loadEnded"] = stamp()
    for worker in workers:
        worker.join(timeout=max(1, 300 - (time.monotonic() - deadline)))
    phases["drained"] = stamp()
    time.sleep(tail_seconds)
    phases["probesStopped"] = stamp()
    prober.stop.set()
    sampler.stop.set()
    tracer.disarm()
    for thread in (prober, sampler):
        thread.join(30)
    tracer.join(10)
    pgbench.terminate()
    sh(f"docker exec orbit-postgres sh -c 'pkill -INT pgbench; sleep 1; cat /tmp/d10pgb-{tag}.*' > /dev/null 2>&1 || true", check=False)
    pg_log = sh(f"docker exec orbit-postgres sh -c 'cat /tmp/d10pgb-{tag}.* 2>/dev/null; rm -f /tmp/d10pgb-{tag}.*'", check=False).stdout
    (out / "pgbench-transactions.txt").write_text(pg_log)
    statements = sh("docker exec orbit-postgres psql -U orbit -d orbit -AtqX -F '\t' -c \"select calls, round(total_exec_time::numeric, 3), "
                    "round(mean_exec_time::numeric, 3), round(max_exec_time::numeric, 3), round(stddev_exec_time::numeric, 3), "
                    "regexp_replace(left(query, 140), '\\s+', ' ', 'g') from pg_stat_statements order by total_exec_time desc limit 40\"",
                    check=False).stdout
    (out / "pg-stat-statements.tsv").write_text(statements)
    wal = sh("docker exec orbit-postgres psql -U orbit -d orbit -AtqX -F '\t' -c 'select * from pg_stat_wal'", check=False).stdout
    (out / "pg-stat-wal.tsv").write_text(wal)
    gateway = sh(f"docker logs --since {gateway_since} orbit-gateway 2>&1", check=False).stdout
    (out / "gateway.log").write_text(gateway)
    meta.update(phases=phases, ended=now(), workerErrors={w.key: w.error for w in workers if w.error},
                workersStillRunning=[w.key for w in workers if w.is_alive()], tracedThreads=len(tracer.cgroup_of))
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    record("steps.jsonl", {"step": f"round {label}", "variant": variant, "runners": runners, "phases": phases,
                           "workerErrors": meta["workerErrors"], "stillRunning": meta["workersStillRunning"]})


def main(argv):
    step, rest = argv[0], argv[1:]
    if step == "resources":
        step_resources()
    elif step == "accounts":
        step_accounts()
    elif step == "keys":
        step_keys()
    elif step == "ready":
        step_ready(rest or None)
    elif step == "probe-session":
        step_probe_session()
    elif step == "pg-setup":
        step_pg_setup()
    elif step == "cycle":
        step_cycle(rest[0])
    elif step == "images":
        print(json.dumps(images(), indent=2))
    elif step == "sleep":
        sleep_runner(rest[0])
    elif step == "wake":
        wake_runner(rest[0])
    elif step == "quiet":
        print(json.dumps(disk_quiet(int(rest[0]) if rest else 15)))
    elif step == "round":
        label, variant, runners, load_seconds, cycles, files, think_ms = rest[:7]
        commit_every = int(rest[7]) if len(rest) > 7 else 1
        stagger = int(rest[8]) if len(rest) > 8 else 0
        tag = re.sub(r"[^a-z0-9]", "", label.lower())[-6:]
        step_round(label, variant, int(runners), int(load_seconds), int(cycles), int(files), int(think_ms), tag, commit_every, stagger)
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
