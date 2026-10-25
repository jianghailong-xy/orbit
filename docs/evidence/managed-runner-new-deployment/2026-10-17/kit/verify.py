#!/usr/bin/env python3
"""D3 (task 34hJ7RbezzIdkzud1OBz2) verification driver for one isolated Docker-in-Docker host.

    verify.py <env> <step> [args]

<env> is fresh or upgrade: the dind container d3-<env>-dind, whose gateway is published on host
127.0.0.1:<port>, and whose checkout is /work/orbit (host /mnt/data/tmp/34hJ7RbezzIdkzud1OBz2/<env>/work/orbit).
Every record goes to <work>/evidence. Account passwords live in <work>/secrets.json (0600) and access
tokens only in memory: neither is written to the evidence.
"""

import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request

T = Path("/mnt/data/tmp/34hJ7RbezzIdkzud1OBz2")
PORTS = {"fresh": 12086, "upgrade": 13086}
PLACEHOLDER_KEY = "sk-orbit-d3-placeholder-not-a-key"


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class Env:
    def __init__(self, name):
        self.name = name
        self.dind = f"d3-{name}-dind"
        self.base = f"http://127.0.0.1:{PORTS[name]}"
        self.work = T / name / "work"
        self.evidence = self.work / "evidence"
        self.evidence.mkdir(parents=True, exist_ok=True)
        self.secrets_file = self.work / "secrets.json"

    # ── recording ──
    def record(self, file, entry):
        entry = {"at": now(), **entry}
        with open(self.evidence / file, "a") as out:
            out.write(json.dumps(entry, sort_keys=True) + "\n")
        print(json.dumps(entry, sort_keys=True), flush=True)

    # ── docker inside the dind ──
    def sh(self, script, check=True, stdin=None, workdir=None):
        args = ["docker", "exec", "-i"] + (["-w", workdir] if workdir else []) + [self.dind, "sh", "-c", script]
        result = subprocess.run(args, input=stdin, capture_output=True, text=True, timeout=900)
        if check and result.returncode != 0:
            raise SystemExit(f"[{self.dind}] {script!r} exited {result.returncode}: {result.stderr.strip()[:2000]}")
        return result

    def inventory(self, label):
        script = r'''
echo "== inventory $1 at $(date -u +%FT%TZ)"
echo "-- containers (docker ps -a)"; docker ps -a --format "{{.Names}}\t{{.Image}}\t{{.Status}}" | sort
echo "-- volumes (docker volume ls)"; docker volume ls --format "{{.Name}}\t{{.Labels}}" | sort
echo "-- networks (docker network ls)"; docker network ls --format "{{.Name}}\t{{.Driver}}" | sort
echo "-- images (docker images)"; docker images --format "{{.Repository}}:{{.Tag}}\t{{.ID}}" | sort
echo "-- managed runner containers (label orbit.managed-runner.instance)"; docker ps -a --filter label=orbit.managed-runner.instance --format "{{.Names}}\t{{.Status}}\t{{.Label \"orbit.managed-runner.instance\"}}\towner={{.Label \"orbit.managed-runner.owner\"}}\tgeneration={{.Label \"orbit.managed-runner.generation\"}}"
echo "-- managed runner volumes (label orbit.managed-runner.instance)"; docker volume ls --filter label=orbit.managed-runner.instance --format "{{.Name}}\t{{.Label \"orbit.managed-runner.kind\"}}\towner={{.Label \"orbit.managed-runner.owner\"}}"
'''
        text = self.sh(f"set -- {label}; " + script).stdout
        (self.evidence / f"inventory-{label}.txt").write_text(text)
        print(text, flush=True)
        return text

    def psql(self, sql):
        return self.sh(f"docker exec orbit-postgres psql -U orbit -d orbit -AtF '\t' -c {json.dumps(sql)}").stdout

    # ── the API through the gateway ──
    def api(self, method, path, body=None, token=None, ok=(200, 201, 202)):
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
        payload = json.loads(raw) if raw else None
        return status, payload

    def account(self, key):
        stored = json.loads(self.secrets_file.read_text()) if self.secrets_file.exists() else {}
        if key not in stored:
            stored[key] = {"email": f"{key}@d3-{self.name}.test", "password": secrets.token_urlsafe(18)}
            self.secrets_file.write_text(json.dumps(stored))
            os.chmod(self.secrets_file, 0o600)
        return stored[key]

    def login(self, key):
        account = self.account(key)
        status, body = self.api("POST", "/api/auth/login", {"email": account["email"], "password": account["password"]})
        self.record("steps.jsonl", {"step": "login", "account": key, "status": status})
        assert status in (200, 201), (status, body)
        return body["accessToken"]

    def status(self, token):
        status, body = self.api("GET", "/api/managed-runner", token=token)
        assert status == 200, (status, body)
        return body


def summarize(status):
    reason = status.get("reason") or {}
    return {k: status.get(k) for k in ("enabled", "managementState", "desiredState", "runnerId", "workspaceId",
                                       "heartbeatStatus", "usable", "initialProvider")} | {"reason": reason.get("code")}


def poll(env, token, label, until, limit=900, every=3, on_state=None):
    """Record every change of the status until `until(status)` holds; on_state may act on a status."""
    last = None
    started = time.time()
    while True:
        current = env.status(token)
        short = summarize(current)
        if short != last:
            env.record("status-transitions.jsonl", {"phase": label, **short})
            last = short
        if on_state:
            on_state(current)
        if until(current):
            return current
        if time.time() - started > limit:
            raise SystemExit(f"{label}: gave up after {limit}s at {short}")
        time.sleep(every)


def first_login(env):
    status, setup = env.api("GET", "/api/auth/setup-status")
    env.record("steps.jsonl", {"step": "setup-status", "status": status, "body": setup})
    status, caps = env.api("GET", "/api/auth/capabilities")
    env.record("steps.jsonl", {"step": "capabilities", "status": status, "managedRunners": (caps or {}).get("managedRunners")})
    admin = env.account("admin")
    status, body = env.api("POST", "/api/auth/bootstrap", {"email": admin["email"], "name": "D3 Admin", "password": admin["password"]})
    env.record("steps.jsonl", {"step": "bootstrap (first account, a sign-in)", "status": status,
                               "user": {k: (body or {}).get("user", {}).get(k) for k in ("id", "email", "role")}})
    assert status in (200, 201), (status, body)
    token = body["accessToken"]

    signed_in = {"done": False}

    def sign_in_codex(current):
        # An operator signs Codex in inside the runner's container with a placeholder key once it is up and
        # reporting without a runtime (MODEL_UNAVAILABLE): READY needs one, and this run has no model.
        reason = (current.get("reason") or {}).get("code")
        if signed_in["done"] or current.get("managementState") != "STARTING" or reason != "MODEL_UNAVAILABLE":
            return
        # The channel names a container by the runner's internal UUID, which the mapping records; the API's runnerId is
        # its public id.
        name = env.psql(f"select m.pod_name from managed_runner m join \"user\" u on u.id = m.owner_id where u.email = '{admin['email']}'").strip()
        result = env.sh(f"docker exec -i {name} sh -c 'codex login --with-api-key >/dev/null 2>&1; codex login status'",
                        check=False, stdin=PLACEHOLDER_KEY)
        env.record("steps.jsonl", {"step": "operator signs Codex in with a placeholder key", "container": name,
                                   "exit": result.returncode, "codexLoginStatus": result.stdout.strip()[-200:]})
        signed_in["done"] = True

    final = poll(env, token, "first-login",
                 lambda s: (s.get("managementState") == "READY" and s.get("usable")) or s.get("managementState") == "FAILED",
                 on_state=sign_in_codex)
    env.record("steps.jsonl", {"step": "first account's managed runner", **summarize(final)})
    status, runners = env.api("GET", "/api/runners", token=token)
    env.record("steps.jsonl", {"step": "runners", "status": status, "runners": [
        {k: r.get(k) for k in ("id", "name", "status", "lastHeartbeatAt", "managed", "kind")} for r in (runners or [])]})
    status, workspaces = env.api("GET", "/api/workspaces", token=token)
    env.record("steps.jsonl", {"step": "workspaces", "status": status, "workspaces": [
        {k: w.get(k) for k in ("id", "name", "runnerId", "path")} for w in (workspaces if isinstance(workspaces, list) else (workspaces or {}).get("items", []))]})
    env.record("steps.jsonl", {"step": "managed_runner rows", "rows": env.psql(
        "select owner_id, runner_id, backend, management_state, desired_state, generation, pvc_name, pod_name from managed_runner order by created_at").splitlines()})
    env.inventory("1-after-first-login")


def ready(env):
    admin = env.account("admin")
    token = env.login("admin")
    env.record("steps.jsonl", {"step": "status at the second sign-in (the same mapping)", **summarize(env.status(token))})
    name = env.psql(f"select m.pod_name from managed_runner m join \"user\" u on u.id = m.owner_id where u.email = '{admin['email']}'").strip()
    result = env.sh(f"docker exec -i {name} sh -c 'codex login --with-api-key >/dev/null 2>&1; codex login status'",
                    check=False, stdin=PLACEHOLDER_KEY)
    env.record("steps.jsonl", {"step": "operator signs Codex in with a placeholder key", "container": name,
                               "exit": result.returncode, "codexLoginStatus": (result.stdout + result.stderr).strip()[-300:]})
    final = poll(env, token, "runtime-signed-in",
                 lambda s: (s.get("managementState") == "READY" and s.get("usable")) or s.get("managementState") == "FAILED",
                 limit=600)
    env.record("steps.jsonl", {"step": "first account's managed runner", **summarize(final)})
    status, runners = env.api("GET", "/api/runners", token=token)
    env.record("steps.jsonl", {"step": "runners", "status": status, "runners": [
        {k: r.get(k) for k in ("id", "name", "status", "lastHeartbeatAt", "managed", "kind")} for r in (runners or [])]})
    status, workspaces = env.api("GET", "/api/workspaces", token=token)
    env.record("steps.jsonl", {"step": "workspaces", "status": status, "workspaces": [
        {k: w.get(k) for k in ("id", "name", "runnerId", "path")} for w in (workspaces if isinstance(workspaces, list) else (workspaces or {}).get("items", []))]})
    env.record("steps.jsonl", {"step": "managed_runner rows", "rows": env.psql(
        "select owner_id, runner_id, backend, management_state, desired_state, generation, pvc_name, pod_name, initial_provider from managed_runner order by created_at").splitlines()})
    env.inventory("1-after-first-login")


def set_switch(env, value, label):
    # Only the switch line changes; the rest of .env stays byte for byte.
    env.sh(f"sed -i 's/^ORBIT_MANAGED_RUNNERS_ENABLED=.*/ORBIT_MANAGED_RUNNERS_ENABLED={value}/' .env && "
           "grep -n -e '^ORBIT_MANAGED_RUNNERS' -e '^COMPOSE_PROFILES' .env", workdir="/work/orbit")
    result = env.sh("docker compose up -d --wait apiserver 2>&1; docker compose ps --format '{{.Name}}\t{{.Status}}'",
                    workdir="/work/orbit")
    (env.evidence / f"compose-up-apiserver-{label}.log").write_text(result.stdout)
    env.record("steps.jsonl", {"step": f"ORBIT_MANAGED_RUNNERS_ENABLED={value}, docker compose up -d --wait apiserver",
                               "env": env.sh("grep -e '^ORBIT_MANAGED_RUNNERS' -e '^COMPOSE_PROFILES' .env", workdir="/work/orbit").stdout.splitlines(),
                               "container": env.sh("docker inspect orbit-apiserver --format '{{range .Config.Env}}{{println .}}{{end}}' | grep ^ORBIT_MANAGED").stdout.splitlines()})


def disable(env):
    before = env.psql("select count(*) from managed_runner")
    set_switch(env, "false", "disabled")
    status, caps = env.api("GET", "/api/auth/capabilities")
    env.record("steps.jsonl", {"step": "capabilities after switching off", "status": status, "managedRunners": (caps or {}).get("managedRunners")})
    admin_token = env.login("admin")
    second = env.account("second")
    status, body = env.api("POST", "/api/admin/users", {"email": second["email"], "name": "D3 Second", "password": second["password"]}, token=admin_token)
    env.record("steps.jsonl", {"step": "admin creates a second account", "status": status})
    token = env.login("second")
    env.record("steps.jsonl", {"step": "second account's status after its sign-in", **summarize(env.status(token))})
    status, body = env.api("POST", "/api/managed-runner/ensure", {"idempotencyKey": "d3-disabled-ensure"}, token=token)
    env.record("steps.jsonl", {"step": "second account asks for one (ensure)", "status": status, "reason": body})
    env.record("steps.jsonl", {"step": "first account's status", **summarize(env.status(admin_token))})
    time.sleep(45)  # several manager poll intervals: nothing may start for the new sign-in
    env.record("steps.jsonl", {"step": "managed_runner rows after the switch is off", "before": before.strip(),
                               "rows": env.psql("select owner_id, runner_id, management_state, desired_state, generation from managed_runner order by created_at").splitlines()})
    env.inventory("2-after-switching-off")


def config(env, label):
    """The effective configuration, secrets redacted: .env's lines (values of the two secrets and any key replaced),
    the managed runners' files but the token, the containers' switch, mounts and network, and the apiserver's word."""
    script = r'''
cd /work/orbit
echo "== effective configuration $1 at $(date -u +%FT%TZ), checkout $(git rev-parse HEAD)"
echo "-- .env (mode $(stat -c %a .env); secrets redacted)"
sed -E 's/^((JWT_SECRET|PROVIDER_SECRET_KEY|[A-Z_]*(KEY|TOKEN|PASSWORD)[A-Z_]*)=).+/\1<redacted>/' .env | grep -v -e '^#' -e '^$'
echo "-- data/managed-runners"
if [ -d data/managed-runners ]; then
  stat -c '%A %U %n' data/managed-runners data/managed-runners/* data/managed-runners/state 2>/dev/null
  echo "-- channel.json"; cat data/managed-runners/channel.json
  echo "-- profile.json"; cat data/managed-runners/profile.json
else
  echo "(absent)"
fi
echo "-- apiserver: managed runner environment"; docker inspect orbit-apiserver --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^ORBIT_MANAGED' || echo "(none)"
echo "-- apiserver: mounts"; docker inspect orbit-apiserver --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}} rw={{.RW}}{{println}}{{end}}'
echo "-- apiserver: what it said about managed runners at start"; docker logs orbit-apiserver 2>&1 | grep -i 'managed runners' | tail -n 5 || echo "(nothing)"
if docker inspect orbit-docker-channel >/dev/null 2>&1; then
  echo "-- docker-channel: network mode, mounts, user"; docker inspect orbit-docker-channel --format 'network={{.HostConfig.NetworkMode}} user={{.Config.User}} image={{.Image}}{{println}}{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}} rw={{.RW}}{{println}}{{end}}'
  echo "-- docker-channel: its log"; docker logs orbit-docker-channel 2>&1 | tail -n 8
else
  echo "-- docker-channel: (no container)"
fi
if docker network inspect orbit-managed-runners >/dev/null 2>&1; then
  echo "-- network orbit-managed-runners"; docker network inspect orbit-managed-runners --format 'driver={{.Driver}} internal={{.Internal}} options={{json .Options}} ipam={{json .IPAM.Config}}'
else
  echo "-- network orbit-managed-runners: (absent)"
fi
echo "-- docker compose ps"; docker compose ps --format '{{.Name}}\t{{.Image}}\t{{.Status}}'
'''
    text = env.sh(f"set -- {label}; " + script).stdout
    (env.evidence / f"config-{label}.txt").write_text(text)
    print(text, flush=True)


def caps(env, token, label):
    status, body = env.api("GET", "/api/auth/capabilities", token=token)
    env.record("steps.jsonl", {"step": f"capabilities (authenticated) {label}", "status": status,
                               "managedRunners": (body or {}).get("managedRunners")})


def rows(env, label):
    env.record("steps.jsonl", {"step": f"managed_runner rows {label}", "rows": env.psql(
        "select u.email, m.runner_id, m.backend, m.management_state, m.desired_state, m.generation, m.pvc_name, m.pod_name "
        "from managed_runner m join \"user\" u on u.id = m.owner_id order by m.created_at").splitlines()})


def create_and_sign_in(env, admin_token, key, name):
    account = env.account(key)
    status, _ = env.api("POST", "/api/admin/users", {"email": account["email"], "name": name, "password": account["password"]}, token=admin_token)
    env.record("steps.jsonl", {"step": f"admin creates account {key}", "status": status})
    token = env.login(key)
    env.record("steps.jsonl", {"step": f"{key}'s status after its sign-in", **summarize(env.status(token))})
    return token


def old_accounts(env):
    status, setup = env.api("GET", "/api/auth/setup-status")
    env.record("steps.jsonl", {"step": "setup-status", "status": status, "body": setup})
    admin = env.account("admin")
    status, body = env.api("POST", "/api/auth/bootstrap", {"email": admin["email"], "name": "D3 Admin", "password": admin["password"]})
    env.record("steps.jsonl", {"step": "bootstrap (first account, a sign-in)", "status": status})
    assert status in (200, 201), (status, body)
    token = body["accessToken"]
    caps(env, token, "on the previous version")
    env.record("steps.jsonl", {"step": "admin's status after its sign-in", **summarize(env.status(token))})
    create_and_sign_in(env, token, "second", "D3 Second")
    rows(env, "on the previous version")
    env.inventory("1-previous-version-with-accounts")


def after_upgrade(env):
    token = env.login("admin")
    caps(env, token, "after the upgrade")
    env.record("steps.jsonl", {"step": "admin's status after a sign-in", **summarize(env.status(token))})
    second = env.login("second")
    env.record("steps.jsonl", {"step": "second's status after a sign-in", **summarize(env.status(second))})
    third = create_and_sign_in(env, token, "third", "D3 Third")
    status, body = env.api("POST", "/api/managed-runner/ensure", {"idempotencyKey": "d3-upgrade-ensure"}, token=third)
    env.record("steps.jsonl", {"step": "third asks for one (ensure)", "status": status, "reason": body})
    time.sleep(45)  # several of what would be the manager's poll intervals
    rows(env, "after the upgrade and three sign-ins")
    env.inventory("3-after-upgrade-and-sign-ins")


def follow_to_ready(env, key, label):
    """Sign `key` in; once its runner's container is up and reporting MODEL_UNAVAILABLE, an operator signs Codex in
    there with a placeholder key (the run has no model); follow the status to READY."""
    account = env.account(key)
    token = env.login(key)
    done = {"signed": False}

    def sign_in(current):
        if done["signed"] or current.get("managementState") != "STARTING" or (current.get("reason") or {}).get("code") != "MODEL_UNAVAILABLE":
            return
        name = env.psql(f"select m.pod_name from managed_runner m join \"user\" u on u.id = m.owner_id where u.email = '{account['email']}'").strip()
        result = env.sh(f"docker exec -i {name} sh -c 'codex login --with-api-key >/dev/null 2>&1; codex login status'",
                        check=False, stdin=PLACEHOLDER_KEY)
        env.record("steps.jsonl", {"step": f"operator signs Codex in for {key} with a placeholder key", "container": name,
                                   "exit": result.returncode, "codexLoginStatus": (result.stdout + result.stderr).strip()[-300:]})
        done["signed"] = True

    final = poll(env, token, label, lambda s: (s.get("managementState") == "READY" and s.get("usable")) or s.get("managementState") == "FAILED",
                 on_state=sign_in, limit=900)
    env.record("steps.jsonl", {"step": f"{key}'s managed runner", **summarize(final)})
    return token


def enable_check(env):
    follow_to_ready(env, "admin", "after-explicit-enable-admin")
    token = env.login("admin")
    caps(env, token, "after the explicit enable")
    rows(env, "after the explicit enable and the admin's sign-in")
    env.inventory("4-after-explicit-enable")


def main():
    env = Env(sys.argv[1])
    step = sys.argv[2]
    if step == "inventory":
        env.inventory(sys.argv[3])
    elif step == "config":
        config(env, sys.argv[3])
    elif step == "first-login":
        first_login(env)
    elif step == "ready":
        ready(env)
    elif step == "old-accounts":
        old_accounts(env)
    elif step == "after-upgrade":
        after_upgrade(env)
    elif step == "enable-check":
        enable_check(env)
    elif step == "disable":
        disable(env)
    else:
        raise SystemExit(f"unknown step {step}")


if __name__ == "__main__":
    main()
