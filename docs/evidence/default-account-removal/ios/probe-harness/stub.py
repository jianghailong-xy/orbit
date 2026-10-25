#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the iPhone app reads for a runner's
# Codex accounts, on one machine, HPC — and the control plane's own record of a Default removed from Orbit
# (task 34jpFWOnhGsjNrBGIKi9V; server S1/S2, c0e3df734 and c971ac1c1):
#
#   Codex  Default (~/.codex), Work, Personal — each its own 5-hour and weekly windows
#
# DELETE /api/runners/hpc/accounts/codex/default removes Default from Orbit, answered `done` at once — or,
# with no other account, refused with the server's sentence. POST …/default/restore brings it back. While
# removed, the runner is served as usedRunnerEngines serves it: Default left out of `accounts`, the
# engine marked `removedDefault {home, fingerprintPrefix}`, its `auth` the first signed-in remaining
# account's, and Default's windows gone from the quota — one remaining account's entry becoming the
# snapshot's own.
#
# POST /__set {"accounts": "three" | "two" | "alone", "removed": bool, "online": bool} picks what the
# runner reports: Default with Work and Personal (the default), Default with Work, or Default alone; whether
# Default starts removed; and whether the machine is online. POST /__reset puts it all back. Every request
# is logged with its body; anything not served is a 404. All data is made up.
import json
import sys
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
WORK = "3fa91c2e"
PERSONAL = "7c21de40"


def at(minutes):
    t = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def fresh_state():
    return {"accounts": "three", "removed": False, "online": True}


STATE = fresh_state()

AGENTS = [{"id": "a1", "name": "orbit-develop", "provider": "codex", "lastProvider": "codex", "runnerId": "hpc",
           "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/root/orbit",
           "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]

DEFAULT = {"id": "default", "auth": "yes", "home": "/root/.codex", "codexHome": "/root/.codex",
           "fingerprintPrefix": "cxa1_2b7e9013"}
ADDED = {
    WORK: {"id": WORK, "name": "Work", "auth": "yes", "home": "/root/.orbit/codex-accounts/" + WORK,
           "codexHome": "/root/.orbit/codex-accounts/" + WORK, "fingerprintPrefix": "cxa1_9f3a41c7"},
    PERSONAL: {"id": PERSONAL, "name": "Personal", "auth": "yes", "home": "/root/.orbit/codex-accounts/" + PERSONAL,
               "codexHome": "/root/.orbit/codex-accounts/" + PERSONAL, "fingerprintPrefix": "cxa1_4d5c8b26"},
}


def window(utilization, resets_in, minutes):
    return {"utilization": utilization, "resetsAt": at(resets_in), "windowDurationMins": minutes}


# Each login's own: 5 hours, then the week.
USAGE = {
    "default": {"provider": "codex", "primary": window(62, 130, 300), "secondary": window(18, 4 * 24 * 60, 10080)},
    WORK: {"provider": "codex", "primary": window(8, 200, 300), "secondary": window(41, 2 * 24 * 60, 10080)},
    PERSONAL: {"provider": "codex", "primary": window(30, 90, 300), "secondary": window(55, 5 * 24 * 60, 10080)},
}


def reported():
    """The accounts the runner reports, Default first."""
    others = {"three": [WORK, PERSONAL], "two": [WORK], "alone": []}[STATE["accounts"]]
    return [dict(DEFAULT)] + [dict(ADDED[i]) for i in others]


def removed_now():
    """Default is left out only while the runner reports another account (usedRunnerEngines)."""
    return STATE["removed"] and len(reported()) > 1


def codex_engine():
    accounts = reported()
    engine = {"engine": "codex", "installed": True, "version": "codex-cli 0.161.0", "auth": "yes",
              "update": {"status": "ok", "at": at(-6), "okAt": at(-6)}, "accounts": accounts}
    if removed_now():
        remaining = accounts[1:]
        speaks = next((a for a in remaining if a["auth"] == "yes"), remaining[0])
        engine.update({"accounts": remaining, "auth": speaks["auth"],
                       "removedDefault": {"home": DEFAULT["home"], "fingerprintPrefix": DEFAULT["fingerprintPrefix"]}})
    return engine


def codex_usage():
    accounts = reported()
    entries = {a["id"]: USAGE[a["id"]] for a in accounts[1:]}
    if not removed_now():
        usage = dict(USAGE["default"])
        if entries:
            usage["accounts"] = entries
        return usage
    # withoutDefaultUsage: one remaining account's entry becomes the snapshot's own; with more, none.
    remaining = accounts[1:]
    own = dict(USAGE[remaining[0]["id"]]) if len(remaining) == 1 else {"provider": "codex"}
    own["accounts"] = entries
    return own


def runner():
    online = STATE["online"]
    return {
        "id": "hpc", "name": "HPC", "displayName": "HPC", "hostname": "workstation", "online": online,
        "status": "ONLINE" if online else "OFFLINE", "version": "0.1.236", "maxConcurrent": 8,
        "activeSessions": 1 if online else 0,
        # Stamped now: a once-stamped heartbeat would grey the machine out within the run.
        "lastHeartbeatAt": at(-0.2) if online else at(-180),
        "planUsage": {"claude": {"provider": "claude", "fiveHour": window(12, 200, 300),
                                 "sevenDay": window(30, 3 * 24 * 60, 10080)},
                      "codex": codex_usage()},
        "capabilities": ["codex-account-move/v1", "claude-account-move/v1"],
        "engines": [
            {"engine": "claude", "installed": True, "version": "2.1.296 (Claude Code)", "auth": "yes",
             "update": {"status": "ok", "at": at(-6), "okAt": at(-6)}},
            codex_engine(),
        ],
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    def send(self, status, body=None):
        data = b"" if body is None else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        text = raw.decode("utf-8", "replace")
        with open(LOG, "a") as f:
            f.write("    %s %s body: %s\n" % (self.command, urlparse(self.path).path, text))
        try:
            return json.loads(text) if text else {}
        except ValueError:
            return {}

    def do_GET(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if parts == ["api", "agents"]:
            return self.send(200, AGENTS)
        if parts == ["api", "agents", "a1"]:
            return self.send(200, AGENTS[0])
        if parts == ["api", "runners"]:
            return self.send(200, [runner()])
        if parts == ["api", "runners", "hpc"]:
            return self.send(200, runner())
        if parts == ["api", "runners", "hpc", "login"]:
            return self.send(200, {"status": None, "engine": None, "url": None, "userCode": None,
                                   "message": None, "account": None})
        if parts in (["api", "providers"], ["api", "providers", "mine"], ["api", "providers", "pools"],
                     ["api", "providers", "shared-pools"], ["api", "session-tags"], ["api", "session-folders"],
                     ["api", "task-lists"], ["api", "watches"], ["api", "share-links"], ["api", "projects"],
                     ["api", "sessions"]):
            return self.send(200, [])
        if parts == ["api", "sessions", "counts"]:
            return self.send(200, [])
        return self.send(404, {"error": "not in the probe"})

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self.body()
        if parts == ["__reset"]:
            STATE.clear()
            STATE.update(fresh_state())
            return self.send(200, {"ok": True})
        if parts == ["__set"]:
            for key in ("accounts", "removed", "online"):
                if key in body:
                    STATE[key] = body[key]
            return self.send(200, STATE)
        if parts == ["api", "runners", "hpc", "accounts", "codex", "default", "restore"]:
            # Orbit's own record: idempotent, and the machine takes no part, online or not.
            STATE["removed"] = False
            return self.send(201, {"ok": True})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

    def do_DELETE(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        self.body()
        if parts == ["api", "runners", "hpc", "accounts", "codex", "default"]:
            if len(reported()) < 2:
                return self.send(400, {"statusCode": 400, "error": "Bad Request",
                                       "message": "Add another Codex account to this machine before removing Default."})
            STATE["removed"] = True
            return self.send(200, {"engine": "codex", "account": "default", "status": "done", "message": None})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})


if __name__ == "__main__":
    class LoopbackServer(ThreadingHTTPServer):
        daemon_threads = True

        # HTTPServer.server_bind resolves its own name (socket.getfqdn), a reverse lookup that on
        # macOS can raise the "find devices on local networks" prompt.
        def server_bind(self):
            import socketserver
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "localhost", self.server_address[1]

    server = LoopbackServer(("127.0.0.1", PORT), Handler)
    print("stub listening on 127.0.0.1:%d (python %s)" % (PORT, sys.version.split()[0]), flush=True)
    server.serve_forever()
