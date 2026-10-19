#!/usr/bin/env python3
"""D9 (task 34iSiGtPrJ0LWSqn17esR) driver for the isolated test host d9-dind: one deployment at a time, in the test
host's checkout /work/<scenario>, its gateway published on host 127.0.0.1:14986.

    d9.py <step> <scenario> [args]

Steps: addresses, accounts, key, follow <label> <READY|SLEEPING|STOPPED-OR-READY> [limit], probe <label>, session <label>
[timeout], rules <label>, inventory <label>, facts, sleep, wake, gate <label> (the channel's and the firewall's logs
of the gate), install-log <label> <file> (copy a log the test host wrote into the evidence, gzipped).

Records go to /mnt/data/tmp/34iSiGtPrJ0LWSqn17esR/evidence/<scenario>; the account's password stays in
/mnt/data/tmp/34iSiGtPrJ0LWSqn17esR/secrets.json (0600) and access tokens only in memory. Nothing secret is recorded:
not the runner credential, the channel's token or the placeholder model key.
"""

import gzip
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

T = Path("/mnt/data/tmp/34iSiGtPrJ0LWSqn17esR")
EVIDENCE = T / "evidence"
BASE = "http://127.0.0.1:14986"
DIND = "d9-dind"
KIT = Path(__file__).resolve().parent
FAKE_KEY = "sk-d9-fake-model-not-a-key"
MODEL_URL = "http://10.77.0.2:18080/anthropic"


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def record(scenario, file, entry):
    folder = EVIDENCE / scenario
    folder.mkdir(parents=True, exist_ok=True)
    entry = {"at": now(), **entry}
    with open(folder / file, "a") as out:
        out.write(json.dumps(entry, sort_keys=True) + "\n")
    print(json.dumps(entry, sort_keys=True), flush=True)
    return entry


def sh(script, check=True, stdin=None, timeout=1800, workdir=None):
    """A shell script inside the test host."""
    argv = ["docker", "exec", "-i", *(["-w", workdir] if workdir else []), DIND, "sh", "-c", script]
    result = subprocess.run(argv, input=stdin, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode != 0:
        raise SystemExit(f"[{DIND}] {script[:200]!r} exited {result.returncode}: {result.stderr.strip()[:2000]}")
    return result


def psql(sql, wait=180):
    deadline = time.time() + wait
    while True:
        result = sh(f"docker exec orbit-postgres psql -U orbit -d orbit -AtF '\t' -c {shlex.quote(sql)}", check=False)
        if result.returncode == 0:
            return result.stdout.rstrip("\n")
        if time.time() > deadline:
            raise SystemExit(f"psql kept failing: {result.stderr.strip()[:500]}")
        time.sleep(3)


def api(method, path, body=None, token=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    headers = {"content-type": "application/json", "accept": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    request = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    except (urllib.error.URLError, ConnectionError, TimeoutError) as error:
        return 0, {"error": str(error)}
    try:
        return status, (json.loads(raw) if raw else None)
    except ValueError:
        return status, {"nonJson": raw[:200].decode("utf-8", "replace")}


# ── the account ─────────────────────────────────────────────────────────────────────────────

def account(scenario):
    path = T / "secrets.json"
    stored = json.loads(path.read_text()) if path.exists() else {}
    if scenario not in stored:
        stored[scenario] = {"email": f"admin-{scenario}@d9-firewall.test", "password": secrets.token_urlsafe(18)}
        path.write_text(json.dumps(stored))
        os.chmod(path, 0o600)
    return stored[scenario]


def login(scenario, wait=600):
    a, deadline = account(scenario), time.time() + wait
    while True:
        status, body = api("POST", "/api/auth/login", {"email": a["email"], "password": a["password"]})
        if status in (200, 201):
            return body["accessToken"]
        if time.time() > deadline:
            raise SystemExit(f"login: {status} {body}")
        time.sleep(3)


def status_of(token):
    status, body = api("GET", "/api/managed-runner", token=token)
    return body if status == 200 else {"httpStatus": status, "body": body}


def summarize(s):
    reason = s.get("reason") or {}
    return {k: s.get(k) for k in ("managementState", "desiredState", "heartbeatStatus", "usable", "initialProvider", "revision")} | {
        "reason": reason.get("code"), "httpStatus": s.get("httpStatus")}


def mapping(scenario):
    a = account(scenario)
    row = psql("select m.runner_id, m.management_state, m.generation, m.pod_name, coalesce(m.last_error->>'code', ''), "
               f"m.default_workspace_id from managed_runner m join \"user\" u on u.id = m.owner_id where u.email = '{a['email']}'")
    if not row:
        return None
    f = row.split("\t")
    return {"runnerId": f[0], "state": f[1], "generation": int(f[2]), "container": f[3] or None, "lastError": f[4] or None,
            "workspaceId": f[5] or None}


def step_accounts(scenario):
    status, setup = api("GET", "/api/auth/setup-status")
    record(scenario, "steps.jsonl", {"step": "setup-status", "status": status, "body": setup})
    a = account(scenario)
    if (setup or {}).get("needsSetup"):
        status, body = api("POST", "/api/auth/bootstrap", {"email": a["email"], "name": "D9 admin", "password": a["password"]})
        record(scenario, "steps.jsonl", {"step": "bootstrap: the administrator", "status": status})
        if status not in (200, 201):
            raise SystemExit(body)
    login(scenario)
    record(scenario, "steps.jsonl", {"step": "the administrator signs in"})
    follow(scenario, "first sign-in", lambda s: s.get("managementState") in ("READY", "FAILED")
           or (s.get("reason") or {}).get("code") == "MODEL_UNAVAILABLE", limit=900)


def step_key(scenario):
    token = login(scenario)
    body = {"label": "FAKE model on the private network (D9, not a model)", "presetSlug": "deepseek", "baseUrl": MODEL_URL,
            "apiKey": FAKE_KEY}
    status, answer = api("POST", "/api/providers/mine", body, token=token)
    record(scenario, "steps.jsonl", {"step": "a DeepSeek-preset key whose endpoint is the internal model endpoint", "status": status,
                                     "answer": {k: answer.get(k) for k in ("id", "slug", "presetSlug", "runtime", "baseUrl", "enabled")}
                                     if isinstance(answer, dict) else answer})
    if status not in (200, 201):
        raise SystemExit(answer)
    (T / f"key-{scenario}.slug").write_text(answer["slug"])
    follow(scenario, "after the key", lambda s: s.get("managementState") in ("READY", "FAILED") and s.get("usable") is not None, limit=900)


def follow(scenario, label, until, limit=900, every=3):
    token, last, started = login(scenario), None, time.time()
    while True:
        current = status_of(token)
        if current.get("httpStatus") == 401:
            token = login(scenario)
            continue
        short = summarize(current)
        if short != last:
            record(scenario, "status-transitions.jsonl", {"phase": label, **short})
            last = short
        if until(current):
            return current
        if time.time() - started > limit:
            raise SystemExit(f"{label}: gave up after {limit}s at {short}")
        time.sleep(every)


UNTIL = {
    "READY": lambda s: s.get("managementState") == "READY" and s.get("usable"),
    "SLEEPING": lambda s: s.get("managementState") == "SLEEPING",
    "FAILED": lambda s: s.get("managementState") == "FAILED",
}


# ── what the runner reaches ─────────────────────────────────────────────────────────────────

def addresses():
    script = r'''
gw="$(docker network inspect orbit-managed-runners -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' 2>/dev/null | awk '{print $1}')"
stack="$(docker inspect orbit-gateway -f '{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}' 2>/dev/null | awk '{print $1}')"
d0="$(ip -4 -o addr show docker0 | awk '{print $4}' | cut -d/ -f1)"
e0="$(ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1)"
hg="$(ip route | awk '/^default/ {print $3; exit}')"
echo "{\"managedGateway\": \"$gw\", \"stackGateway\": \"$stack\", \"docker0\": \"$d0\", \"eth0\": \"$e0\", \"hostGateway\": \"$hg\"}"
'''
    return json.loads(sh(script).stdout)


def targets(addr):
    gw = addr["managedGateway"]
    return [
        {"name": "the gateway's published port 2086, the designed way to the apiserver", "kind": "tcp", "host": gw, "port": 2086},
        {"name": "a host service on every address (2222), at the network's gateway", "kind": "tcp", "host": gw, "port": 2222},
        {"name": "the same service at the test host's docker0 address", "kind": "tcp", "host": addr["docker0"], "port": 2222},
        {"name": "the same service at the stack network's gateway", "kind": "tcp", "host": addr["stackGateway"], "port": 2222},
        {"name": "a host service bound to the test host's eth0 address only (2224)", "kind": "tcp", "host": addr["eth0"], "port": 2224},
        {"name": "a UDP echo of the host on every address (2226), at the network's gateway", "kind": "udp", "host": gw, "port": 2226},
        {"name": "a port of the host where nothing listens (1), at the network's gateway", "kind": "tcp", "host": gw, "port": 1},
        {"name": "HPC's sshd at its LAN address", "kind": "tcp", "host": "192.168.1.12", "port": 22},
        {"name": "HPC's vLLM port 8000 at its LAN address (vLLM listens on HPC's loopback)", "kind": "tcp", "host": "192.168.1.12", "port": 8000},
        {"name": "HPC's sshd at the test host's default gateway (HPC's docker0)", "kind": "tcp", "host": addr["hostGateway"], "port": 22},
        {"name": "the LAN's DNS resolver over TCP, from the container's own namespace", "kind": "tcp", "host": "192.168.1.254", "port": 53},
        {"name": "the internal model endpoint on the private network behind the host", "kind": "tcp", "host": "10.77.0.2", "port": 18080},
        {"name": "the cloud metadata address", "kind": "tcp", "host": "169.254.169.254", "port": 80},
        {"name": "an address in 10.0.0.0/8", "kind": "tcp", "host": "10.255.255.1", "port": 80},
        {"name": "an address in 100.64.0.0/10", "kind": "tcp", "host": "100.64.0.1", "port": 80},
        {"name": "DNS: a Git host (github.com)", "kind": "dns", "host": "github.com"},
        {"name": "DNS: the DeepSeek endpoint (api.deepseek.com)", "kind": "dns", "host": "api.deepseek.com"},
        {"name": "public HTTPS: a Git host", "kind": "https", "url": "https://github.com/"},
        {"name": "public HTTPS: the DeepSeek endpoint", "kind": "https", "url": "https://api.deepseek.com/"},
    ]


def verdict(result):
    if result in ("CONNECTED", "ECHOED") or result.startswith(("HTTP ", "RESOLVED")):
        return "reached"
    if result in ("EHOSTUNREACH", "ENETUNREACH", "EACCES", "EPERM"):
        return "refused by a firewall"
    if result == "ECONNREFUSED":
        return "refused by the target (reached its host)"
    return "blocked (" + result + ")"


def step_probe(scenario, label):
    m = mapping(scenario)
    if not m or not m["container"]:
        raise SystemExit(f"no runner container for {scenario}: {m}")
    addr = addresses()
    out = sh(f"docker exec -i -u 10001 {m['container']} python3 - {shlex.quote(json.dumps(targets(addr)))}",
             stdin=(KIT / "probe.py").read_text(), check=False, timeout=300)
    lines = [json.loads(line) for line in out.stdout.splitlines() if line.startswith("{")]
    facts = next((line["facts"] for line in lines if "facts" in line), None)
    results = [dict(line, verdict=verdict(line["result"])) for line in lines if "facts" not in line]
    entry = record(scenario, "probes.jsonl", {"label": label, "container": m["container"], "generation": m["generation"],
                                              "addresses": addr, "results": results, "containerFacts": facts,
                                              "exit": out.returncode, "stderr": out.stderr.strip()[-300:]})
    for r in results:
        print(f"  {r['verdict']:<42} {r['result']:<28} {r['name']}")
    return entry


# ── a session on the fake model ─────────────────────────────────────────────────────────────

def step_session(scenario, label, timeout=240):
    token = login(scenario)
    m = mapping(scenario)
    slug = (T / f"key-{scenario}.slug").read_text().strip()
    marker = f"D9-{scenario.upper()}-{label.upper()}-{secrets.token_hex(3)}"
    lines_before = model_lines()
    status, answer = api("POST", "/api/sessions", {"workspaceId": m["workspaceId"], "prompt": f"Say hello. {marker}",
                                                   "title": f"d9 {scenario} {label}", "provider": slug}, token=token)
    if status not in (200, 201):
        raise SystemExit(f"session: {status} {answer}")
    session, deadline, seen, events = answer["id"], time.monotonic() + timeout, [], []
    while True:
        code, view = api("GET", f"/api/sessions/{session}", token=token)
        short = {k: view.get(k) for k in ("status", "runStatus", "provider", "engine", "model", "assignedRunnerId", "endReason", "error")} \
            if code == 200 else {"http": code}
        if not seen or seen[-1][1] != short:
            seen.append((now(), short))
        page = api("GET", f"/api/sessions/{session}/events/page?after=0&limit=200", token=token)[1]
        events = page.get("events", []) if isinstance(page, dict) else []
        answered = [e for e in events if "FAKE MODEL reply" in json.dumps(e)]
        # Settled: the turn ran and ended, answered or not (a model it cannot reach ends it with the engine's error).
        settled = short.get("runStatus") not in ("PENDING", "RUNNING", "QUEUED", None) or short.get("status") in ("FAILED",)
        if (settled and len(seen) > 1) or (answered and settled) or time.monotonic() > deadline:
            break
        time.sleep(3)
    requests = [line for line in model_lines()[len(lines_before):] if marker in line]
    errors = [e for e in events if e.get("type") in ("error", "system") or "error" in json.dumps(e).lower()][-3:]
    return record(scenario, "sessions.jsonl", {
        "label": label, "session": session, "marker": marker, "timeline": seen, "answered": bool(answered),
        "answer": next((a for a in (json.dumps(e) for e in events) if "FAKE MODEL reply" in a), "")[:300],
        "modelRequestsWithMarker": len(requests), "events": len(events),
        "lastErrorEvents": [json.dumps(e)[:400] for e in errors] if not answered else []})


def model_lines():
    out = sh("cat /evidence/fake-model.jsonl 2>/dev/null || true", check=False)
    return out.stdout.splitlines()


# ── the host's rules and the deployment ─────────────────────────────────────────────────────

def step_rules(scenario, label):
    script = r'''
echo "== rules at $(date -u +%FT%TZ): $1"
echo "-- iptables backend: $(iptables --version); Docker's firewall backend: $(docker info --format '{{json .FirewallBackend}}')"
echo "-- managed runners' network"; docker network inspect orbit-managed-runners -f 'id={{.Id}} ipv6={{.EnableIPv6}} options={{json .Options}} ipam={{json .IPAM.Config}}' 2>&1
for fam in iptables ip6tables; do
  echo "-- $fam: jumps into ORBIT-MR-* (INPUT, DOCKER-USER, FORWARD) and the chains"
  $fam -S INPUT 2>&1 | grep -E 'ORBIT|^-P' ; $fam -S FORWARD 2>&1 | head -4; $fam -S DOCKER-USER 2>&1
  $fam -S ORBIT-MR-INPUT 2>&1; $fam -S ORBIT-MR-FORWARD 2>&1
done
echo "-- nat DOCKER chain (the published port's DNAT)"; iptables -t nat -S DOCKER 2>&1
echo "-- the firewall's service"; docker ps -a --filter name=orbit-managed-runner-firewall --format '{{.Names}} {{.Status}} image={{.Image}}'
echo "-- the firewall's status file"; cat "$2"/data/managed-runners/firewall/status.json 2>&1
echo "-- the firewall's configuration"; cat "$2"/data/managed-runners/firewall/config.json 2>&1
'''
    text = sh(f"set -- {shlex.quote(label)} /work/{scenario}; " + script, check=False).stdout
    folder = EVIDENCE / scenario
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"rules-{label}.txt").write_text(text)
    print(text, flush=True)


def step_inventory(scenario, label):
    script = r'''
echo "== inventory $1 at $(date -u +%FT%TZ), checkout $(git rev-parse HEAD)"
echo "-- managed runner containers"; docker ps -a --filter label=orbit.managed-runner.kind=runner --format '{{.Names}}\t{{.State}}\t{{.Status}}\tgeneration={{.Label "orbit.managed-runner.generation"}}\t{{.Networks}}'
echo "-- the stack"; docker ps -a --format '{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Image}}' | grep -E '^orbit-'
echo "-- managed_runner rows"; docker exec orbit-postgres psql -U orbit -d orbit -AtF ' | ' -c "select u.email, m.management_state, m.desired_state, m.generation, m.pod_name, m.last_error->>'code' from managed_runner m join \"user\" u on u.id = m.owner_id order by u.email" 2>&1
echo "-- .env lines about managed runners"; grep -nE 'MANAGED|COMPOSE_PROFILES|firewall|FIREWALL' .env 2>&1
'''
    text = sh(f"set -- {shlex.quote(label)}; " + script, check=False, workdir=f"/work/{scenario}").stdout
    (EVIDENCE / scenario).mkdir(parents=True, exist_ok=True)
    (EVIDENCE / scenario / f"inventory-{label}.txt").write_text(text)
    print(text, flush=True)


def step_facts(scenario):
    script = r'''
echo "test host: $(hostname), kernel $(uname -r)"
echo "Docker: $(docker version --format '{{.Server.Version}} (API {{.Server.APIVersion}})'), $(docker compose version)"
echo "Docker info: firewall backend $(docker info --format '{{json .FirewallBackend}}'), security $(docker info --format '{{json .SecurityOptions}}'), cgroup v$(docker info --format '{{.CgroupVersion}}')"
echo "iptables: $(iptables --version); legacy tables in this namespace: [$(cat /proc/net/ip_tables_names 2>/dev/null | tr '\n' ' ')]"
echo "dockerd flags: $(cat /etc/d9/dockerd-flags 2>/dev/null || echo none)"
echo "resolv.conf: $(grep nameserver /etc/resolv.conf | tr '\n' ' ')"
'''
    text = sh(script, check=False).stdout
    record(scenario, "facts.jsonl", {"facts": text.strip().splitlines()})


def step_sleep_or_wake(scenario, which):
    token = login(scenario)
    current = status_of(token)
    body = {"idempotencyKey": f"d9-{which}-{secrets.token_hex(4)}"}
    if which == "sleep":
        body["revision"] = current.get("revision")
    status, answer = api("POST", f"/api/managed-runner/{which}", body, token=token)
    record(scenario, "steps.jsonl", {"step": f"the owner asks for {which}", "status": status, "answer": summarize(answer or {})})


def step_gate(scenario, label):
    script = r'''
echo "== the gate at $(date -u +%FT%TZ): $1"
echo "-- docker-channel: start-up and refusals"; docker logs orbit-docker-channel 2>&1 | grep -E 'firewall|FIREWALL|created and started|serving on' | tail -n 30
echo "-- managed-runner-firewall"; docker logs orbit-managed-runner-firewall 2>&1 | tail -n 30
echo "-- apiserver: managed runner lines"; docker logs orbit-apiserver 2>&1 | grep -iE 'managed|firewall' | tail -n 20
'''
    text = sh(f"set -- {shlex.quote(label)}; " + script, check=False).stdout
    (EVIDENCE / scenario).mkdir(parents=True, exist_ok=True)
    (EVIDENCE / scenario / f"gate-{label}.txt").write_text(text)
    print(text, flush=True)


def step_install_log(scenario, label, path):
    data = sh(f"cat {shlex.quote(path)}", check=False).stdout
    (EVIDENCE / scenario).mkdir(parents=True, exist_ok=True)
    with gzip.open(EVIDENCE / scenario / f"{label}.log.gz", "wt") as out:
        out.write(data)
    print(f"{len(data.splitlines())} lines -> {scenario}/{label}.log.gz")


def main(argv):
    step, scenario, rest = argv[0], (argv[1] if len(argv) > 1 else ""), argv[2:]
    if step == "addresses":
        print(json.dumps(addresses()))
    elif step == "accounts":
        step_accounts(scenario)
    elif step == "key":
        step_key(scenario)
    elif step == "follow":
        follow(scenario, rest[0], UNTIL[rest[1]], limit=int(rest[2]) if len(rest) > 2 else 900)
    elif step == "probe":
        step_probe(scenario, rest[0])
    elif step == "session":
        step_session(scenario, rest[0], int(rest[1]) if len(rest) > 1 else 240)
    elif step == "rules":
        step_rules(scenario, rest[0])
    elif step == "inventory":
        step_inventory(scenario, rest[0])
    elif step == "facts":
        step_facts(scenario)
    elif step in ("sleep", "wake"):
        step_sleep_or_wake(scenario, step)
    elif step == "gate":
        step_gate(scenario, rest[0])
    elif step == "install-log":
        step_install_log(scenario, rest[0], rest[1])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
