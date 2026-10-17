#!/usr/bin/env python3
"""D6 (task 34hTEJMR1drqjLq8TqKM3) verification driver for one isolated Docker-in-Docker host, after D3's kit.

    verify.py <env> <step> [args]

<env> is `on` (a fresh install with managed runners, gateway on host 127.0.0.1:16086) or `off` (a deployment
installed without them, as orbitd.io is, 127.0.0.1:15086): the dind container d6-<env>-dind, whose checkout is
/work/orbit (host /mnt/data/tmp/34hTEJMR1drqjLq8TqKM3/<env>/work/orbit). Every record goes to <work>/evidence.
Account passwords live in <work>/secrets.json (0600) and access tokens only in memory: neither is written to the
evidence, and neither is a channel token, a runner credential or a deployment secret.
"""

import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request

T = Path("/mnt/data/tmp/34hTEJMR1drqjLq8TqKM3")
PORTS = {"on": 16086, "off": 15086}
PLACEHOLDER_KEY = "sk-orbit-d6-placeholder-not-a-key"


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class Env:
    def __init__(self, name):
        self.name = name
        self.dind = f"d6-{name}-dind"
        self.base = f"http://127.0.0.1:{PORTS[name]}"
        self.work = T / name / "work"
        self.evidence = self.work / "evidence"
        self.evidence.mkdir(parents=True, exist_ok=True)
        self.secrets_file = self.work / "secrets.json"

    def record(self, entry, file="steps.jsonl"):
        entry = {"at": now(), **entry}
        with open(self.evidence / file, "a") as out:
            out.write(json.dumps(entry, sort_keys=True) + "\n")
        print(json.dumps(entry, sort_keys=True), flush=True)

    def sh(self, script, check=True, stdin=None, workdir=None, timeout=900):
        args = ["docker", "exec", "-i"] + (["-w", workdir] if workdir else []) + [self.dind, "sh", "-c", script]
        result = subprocess.run(args, input=stdin, capture_output=True, text=True, timeout=timeout)
        if check and result.returncode != 0:
            raise SystemExit(f"[{self.dind}] {script!r} exited {result.returncode}: {result.stderr.strip()[:2000]}")
        return result

    def psql(self, sql):
        return self.sh(f"docker exec orbit-postgres psql -U orbit -d orbit -AtF '\t' -c {json.dumps(sql)}").stdout

    def api(self, method, path, body=None, token=None):
        data = None if body is None else json.dumps(body).encode()
        headers = {"content-type": "application/json", "accept": "application/json"}
        if token:
            headers["authorization"] = f"Bearer {token}"
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                status, raw = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, raw = error.code, error.read()
        return status, (json.loads(raw) if raw else None)

    def account(self, key):
        stored = json.loads(self.secrets_file.read_text()) if self.secrets_file.exists() else {}
        if key not in stored:
            stored[key] = {"email": f"{key}@d6-{self.name}.test", "password": secrets.token_urlsafe(18)}
            self.secrets_file.write_text(json.dumps(stored))
            os.chmod(self.secrets_file, 0o600)
        return stored[key]

    def login(self, key):
        account = self.account(key)
        status, body = self.api("POST", "/api/auth/login", {"email": account["email"], "password": account["password"]})
        self.record({"step": "login", "account": key, "status": status})
        assert status in (200, 201), (status, body)
        return body["accessToken"]

    def status(self, token):
        status, body = self.api("GET", "/api/managed-runner", token=token)
        assert status == 200, (status, body)
        return body

    # ── what the host holds ──
    def mapping(self):
        row = self.psql("select m.id, m.runner_id, m.management_state, m.desired_state, m.generation, m.pvc_name, m.pvc_uid, "
                        "m.pod_name, m.pod_uid, m.revision, coalesce(m.reservation::text, '') from managed_runner m "
                        "join \"user\" u on u.id = m.owner_id where u.email = '" + self.account("admin")["email"] + "'").strip()
        keys = ["id", "runnerId", "managementState", "desiredState", "generation", "pvcName", "pvcUid", "podName", "podUid",
                "revision", "reservation"]
        values = dict(zip(keys, row.split("\t"))) if row else {}
        if values.get("reservation"):
            reservation = json.loads(values["reservation"])
            values["reservation"] = {"storage": bool(reservation.get("storage")), "compute": bool(reservation.get("compute")),
                                     "computeGeneration": (reservation.get("compute") or {}).get("generation")}
        return values

    def runner_row(self, runner_id):
        row = self.psql(f"select id, name, version, status, last_heartbeat_at from runner where id = '{runner_id}'").strip()
        return dict(zip(["id", "name", "version", "status", "lastHeartbeatAt"], row.split("\t"))) if row else {}

    def container(self, name):
        found = self.sh(f"docker inspect {name} --format '{{{{.Id}}}}\t{{{{.Image}}}}\t{{{{.State.Status}}}}\t{{{{.State.StartedAt}}}}"
                        f"\t{{{{.State.Pid}}}}\t{{{{index .Config.Labels \"orbit.managed-runner.generation\"}}}}"
                        f"\t{{{{index .Config.Labels \"orbit.managed-runner.uid\"}}}}'", check=False)
        if found.returncode != 0:
            return None
        keys = ["id", "image", "status", "startedAt", "pid", "generation", "instanceUid"]
        return dict(zip(keys, found.stdout.strip().split("\t")))

    def inventory(self, label):
        script = r'''
echo "== inventory $1 at $(date -u +%FT%TZ)"
echo "-- containers (docker ps -a)"; docker ps -a --format "{{.Names}}\t{{.Image}}\t{{.Status}}" | sort
echo "-- volumes (docker volume ls)"; docker volume ls --format "{{.Name}}\t{{.Labels}}" | sort
echo "-- networks (docker network ls)"; docker network ls --format "{{.Name}}\t{{.Driver}}" | sort
echo "-- images (docker images --all --no-trunc)"; docker images --all --no-trunc --format "{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}" | sort
echo "-- managed runner containers (label orbit.managed-runner.instance)"; docker ps -a --no-trunc --filter label=orbit.managed-runner.instance --format "{{.Names}}\t{{.Image}}\t{{.Status}}\tgeneration={{.Label \"orbit.managed-runner.generation\"}}\tuid={{.Label \"orbit.managed-runner.uid\"}}"
echo "-- managed runner volumes (label orbit.managed-runner.instance)"; docker volume ls --filter label=orbit.managed-runner.instance --format "{{.Name}}\t{{.Label \"orbit.managed-runner.kind\"}}\tuid={{.Label \"orbit.managed-runner.uid\"}}"
'''
        text = self.sh(f"set -- {label}; " + script).stdout
        (self.evidence / f"inventory-{label}.txt").write_text(text)
        print(text, flush=True)
        return text

    def config(self, label):
        """The effective configuration, secrets redacted: .env's lines, the managed runners' files but the token, the
        apiserver's switch and mounts, what the channel serves, and the Compose services."""
        script = r'''
cd /work/orbit
echo "== effective configuration $1 at $(date -u +%FT%TZ), checkout $(git rev-parse HEAD) ($(git symbolic-ref --short HEAD 2>/dev/null))"
echo "-- .env (mode $(stat -c %a .env), sha256 $(sha256sum .env | cut -c1-64); secrets redacted)"
sed -E 's/^((JWT_SECRET|PROVIDER_SECRET_KEY|[A-Z_]*(KEY|TOKEN|PASSWORD|SECRET)[A-Z_]*)=).+/\1<redacted>/' .env | grep -v -e '^#' -e '^$'
echo "-- data/ (two levels)"; find data -maxdepth 2 | sort
if [ -d data/managed-runners ]; then
  echo "-- data/managed-runners"; ls -la data/managed-runners
  for f in channel.json profile.json; do echo "-- $f (sha256 $(sha256sum data/managed-runners/$f | cut -c1-64))"; cat data/managed-runners/$f; done
else
  echo "-- data/managed-runners: (absent)"
fi
echo "-- apiserver: managed runner environment"; docker inspect orbit-apiserver --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^ORBIT_MANAGED' || echo "(none)"
echo "-- apiserver: container $(docker inspect orbit-apiserver --format '{{.Id}} image {{.Image}} started {{.State.StartedAt}}')"
echo "-- apiserver: what it said about managed runners"; docker logs orbit-apiserver 2>&1 | grep -i 'managed runners are' | tail -n 3 || echo "(nothing)"
if docker inspect orbit-docker-channel >/dev/null 2>&1; then
  echo "-- docker-channel: container $(docker inspect orbit-docker-channel --format '{{.Id}} image {{.Image}} started {{.State.StartedAt}}')"
  echo "-- docker-channel: what it serves"; docker logs orbit-docker-channel 2>&1 | grep 'serving on' | tail -n 2
else
  echo "-- docker-channel: (no container)"
fi
echo "-- docker compose ps"; docker compose ps --format '{{.Name}}\t{{.Image}}\t{{.Status}}'
'''
        text = self.sh(f"set -- {label}; " + script).stdout
        (self.evidence / f"config-{label}.txt").write_text(text)
        print(text, flush=True)


def summarize(status):
    reason = status.get("reason") or {}
    return {k: status.get(k) for k in ("enabled", "managementState", "desiredState", "runnerId", "workspaceId",
                                       "heartbeatStatus", "usable", "initialProvider", "revision")} | {"reason": reason.get("code")}


def poll(env, token, label, until, limit=900, every=3, on_state=None):
    last, started = None, time.time()
    while True:
        current = env.status(token)
        short = summarize(current)
        if short != last:
            env.record({"phase": label, **short}, "status-transitions.jsonl")
            last = short
        if on_state:
            on_state(current)
        if until(current):
            return current
        if time.time() - started > limit:
            raise SystemExit(f"{label}: gave up after {limit}s at {short}")
        time.sleep(every)


def sign_in_codex(env, name, why):
    # An operator signs Codex in inside the runner's container with a placeholder key: READY needs a runtime signed
    # in, and this run has no model (the DeepSeek key file the owner provides is not there).
    result = env.sh(f"docker exec -i {name} sh -c 'codex login --with-api-key >/dev/null 2>&1; codex login status'",
                    check=False, stdin=PLACEHOLDER_KEY)
    env.record({"step": f"operator signs Codex in with a placeholder key ({why})", "container": name, "exit": result.returncode,
                "codexLoginStatus": (result.stdout + result.stderr).strip()[-200:]})


def first_login(env):
    status, caps = env.api("GET", "/api/auth/capabilities")
    env.record({"step": "capabilities", "status": status, "managedRunners": (caps or {}).get("managedRunners")})
    admin = env.account("admin")
    status, body = env.api("POST", "/api/auth/bootstrap", {"email": admin["email"], "name": "D6 Admin", "password": admin["password"]})
    env.record({"step": "bootstrap (first account, a sign-in)", "status": status})
    assert status in (200, 201), (status, body)
    token = body["accessToken"]
    signed = {"done": False}

    def on_state(current):
        if signed["done"] or current.get("managementState") != "STARTING" or (current.get("reason") or {}).get("code") != "MODEL_UNAVAILABLE":
            return
        sign_in_codex(env, env.mapping()["podName"], "the first container")
        signed["done"] = True

    final = poll(env, token, "first-login", lambda s: (s.get("managementState") == "READY" and s.get("usable"))
                 or s.get("managementState") == "FAILED", on_state=on_state)
    env.record({"step": "first account's managed runner", **summarize(final), "mapping": env.mapping()})
    env.inventory("1-first-runner-ready")


MARK = r'''
set -e
mkdir -p /var/lib/orbit/d6
head -c 1048576 /dev/urandom > /var/lib/orbit/d6/marker.bin
python3 - <<'PY'
import sqlite3
db = sqlite3.connect('/var/lib/orbit/d6/state.sqlite')
db.execute('create table if not exists rows (id integer primary key, value text)')
db.executemany('insert into rows (value) values (?)', [(f'row-{i}',) for i in range(1000)])
db.commit()
PY
nohup sh -c 'while :; do date -u +%s >> /var/lib/orbit/d6/alive.log; sleep 1; done' >/dev/null 2>&1 &
'''

CHECK = r'''
set -e
cd /var/lib/orbit/d6
echo "marker.bin sha256 $(sha256sum marker.bin | cut -c1-64)"
python3 - <<'PY'
import sqlite3
db = sqlite3.connect('/var/lib/orbit/d6/state.sqlite')
print('state.sqlite integrity_check', db.execute('pragma integrity_check').fetchone()[0], 'rows', db.execute('select count(*) from rows').fetchone()[0])
PY
echo "orbit runner id $(python3 -c "import json; print(json.load(open('/var/lib/orbit/home/.orbit/config.json')).get('runnerId'))" 2>/dev/null || echo '?')"
echo "orbit $(orbit --version 2>/dev/null | head -1)"
echo "image sourceSha $(python3 -c "import json; print(json.load(open('/usr/local/share/orbit/tool-versions.json'))['sourceSha'])")"
'''


def mark(env):
    """Data on the runner's volume to find again after the switch, and a process that writes every second, which a
    stopped or restarted container would interrupt."""
    m = env.mapping()
    env.sh(f"docker exec -i -u 10001 {m['podName']} sh -s", stdin=MARK)
    check(env, "before the upgrade")


def check(env, label):
    m = env.mapping()
    found = env.sh(f"docker exec -i -u 10001 {m['podName']} sh -s", check=False, stdin=CHECK)
    env.record({"step": f"state of the runner {label}", "mapping": m, "runner": env.runner_row(m["runnerId"]),
                "container": env.container(m["podName"]), "volumeData": found.stdout.strip().splitlines(),
                "error": found.stderr.strip()[-300:] if found.returncode else None})


def alive(env, label):
    """The writer's seconds: the longest gap tells whether the container ever stopped while it ran. Read through the
    runner's own container, whichever it is now: no other container ever mounts its volume."""
    m = env.mapping()
    found = env.sh(f"docker exec -u 10001 {m['podName']} cat /var/lib/orbit/d6/alive.log", check=False)
    stamps = [int(line) for line in found.stdout.split() if line.isdigit()]
    gaps = [b - a for a, b in zip(stamps, stamps[1:])]
    env.record({"step": f"the writer in the first container, {label}", "lines": len(stamps),
                "first": stamps[0] if stamps else None, "last": stamps[-1] if stamps else None,
                "longestGapSeconds": max(gaps) if gaps else None})


def sleep(env):
    token = env.login("admin")
    current = env.status(token)
    status, body = env.api("POST", "/api/managed-runner/sleep", {"idempotencyKey": f"d6-sleep-{int(time.time())}",
                                                                  "revision": current["revision"]}, token=token)
    env.record({"step": "the owner asks the runner to sleep (POST /api/managed-runner/sleep)", "status": status,
                "answer": summarize(body or {}) if status < 300 else body})
    assert status in (200, 202), (status, body)
    final = poll(env, token, "sleep", lambda s: s.get("managementState") in ("SLEEPING", "FAILED"), limit=900)
    env.record({"step": "asleep", **summarize(final), "mapping": env.mapping()})


def wake(env):
    token = env.login("admin")
    status, body = env.api("POST", "/api/managed-runner/wake", {"idempotencyKey": f"d6-wake-{int(time.time())}"}, token=token)
    env.record({"step": "the owner wakes it (POST /api/managed-runner/wake)", "status": status,
                "answer": summarize(body or {}) if status < 300 else body})
    assert status in (200, 202), (status, body)
    final = poll(env, token, "wake", lambda s: (s.get("managementState") == "READY" and s.get("usable"))
                 or s.get("managementState") == "FAILED", limit=900)
    env.record({"step": "awake", **summarize(final), "mapping": env.mapping()})
    check(env, "after the wake")


def retry(env):
    """The owner's retry of a FAILED runner, as after a restart of its host: the next generation on the same volume."""
    token = env.login("admin")
    current = env.status(token)
    status, body = env.api("POST", "/api/managed-runner/retry", {"idempotencyKey": f"d6-retry-{int(time.time())}",
                                                                  "revision": current["revision"]}, token=token)
    env.record({"step": "the owner retries it (POST /api/managed-runner/retry)", "from": summarize(current), "status": status,
                "answer": summarize(body or {}) if status < 300 else body})
    assert status in (200, 202), (status, body)
    final = poll(env, token, "retry", lambda s: (s.get("managementState") == "READY" and s.get("usable"))
                 or s.get("managementState") == "FAILED" and s.get("revision") != current["revision"], limit=900)
    env.record({"step": "retried", **summarize(final), "mapping": env.mapping()})
    check(env, "after the retry")


def main():
    env = Env(sys.argv[1])
    step = sys.argv[2]
    if step == "inventory":
        env.inventory(sys.argv[3])
    elif step == "config":
        env.config(sys.argv[3])
    elif step == "first-login":
        first_login(env)
    elif step == "mark":
        mark(env)
    elif step == "check":
        check(env, sys.argv[3])
    elif step == "alive":
        alive(env, sys.argv[3])
    elif step == "sleep":
        sleep(env)
    elif step == "wake":
        wake(env)
    elif step == "retry":
        retry(env)
    else:
        raise SystemExit(f"unknown step {step}")


if __name__ == "__main__":
    main()
