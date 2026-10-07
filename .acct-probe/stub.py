#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the engine page reads on the iPhone
# app, holding one machine, Mac Studio, whose Claude Code keeps four accounts:
#
#   alex@example.com       Default, signed in, 96% of its week spent
#   alex.rd@example.com    signed in, its login lapsing in two days (loginExpiresAt)
#   alex.lab@example.com   signed out — until the probe signs it in through the relay
#   alex.ops@example.com   signed in, paused for two hours
#
# and whose Codex has one account, signed out. The sign-in relay is the runner's, played here:
# POST .../login starts it (pending for 3 s, then claude's paste-back page or codex's device code);
# a code POSTed to .../login/code is "checked" for 3 s and then lands, and the account it was for
# reads signed in from then on (a renewal moves its lapse a month on). A pause POST is kept. Every
# request is logged; anything not served is a 404. All data is made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"


def at(minutes):
    t = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def fresh_state():
    return {
        "login": None,       # {"engine", "account", "t0", "code_at"}
        "signed_in": set(),  # accounts the relay signed in
        "renewed": set(),    # signed-in accounts the relay signed in again
        "paused": {"3fa91c2e": at(120)},
    }


STATE = fresh_state()

CLAUDE_MODELS = [{"value": "claude-opus-4-8", "label": "Claude Opus 4.8"}]

AGENTS = [{"id": "a1", "name": "orbit", "provider": "claude", "lastProvider": "claude", "runnerId": "mac",
           "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/Users/alex/orbit",
           "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]


def window(utilization, resets_in, minutes=None):
    w = {"utilization": utilization, "resetsAt": at(resets_in)}
    if minutes:
        w["windowDurationMins"] = minutes
    return w


def claude_accounts():
    lab_in = "b93d5a17" in STATE["signed_in"]
    rd_lapses = at(30 * 24 * 60) if "7c41e0b2" in STATE["renewed"] else at(2 * 24 * 60 - 30)
    accounts = [
        {"id": "default", "name": "alex@example.com", "auth": "yes", "home": "/Users/alex/.claude"},
        {"id": "7c41e0b2", "name": "alex.rd@example.com", "auth": "yes",
         "home": "/Users/alex/.orbit/claude-accounts/7c41e0b2", "loginExpiresAt": rd_lapses},
        {"id": "b93d5a17", "name": "alex.lab@example.com", "auth": "yes" if lab_in else "no",
         "home": "/Users/alex/.orbit/claude-accounts/b93d5a17"},
        {"id": "3fa91c2e", "name": "alex.ops@example.com", "auth": "yes",
         "home": "/Users/alex/.orbit/claude-accounts/3fa91c2e"},
    ]
    if lab_in:
        accounts[2]["loginExpiresAt"] = at(30 * 24 * 60)
    for account in accounts:
        until = STATE["paused"].get(account["id"])
        if until:
            account["pausedUntil"] = until
    return accounts


def plan_usage():
    accounts = {
        "7c41e0b2": {"provider": "claude", "fiveHour": window(100, 128, 300), "sevenDay": window(74, 5 * 24 * 60)},
        "3fa91c2e": {"provider": "claude", "fiveHour": window(48, 258, 300), "sevenDay": window(25, 6 * 24 * 60)},
    }
    if "b93d5a17" in STATE["signed_in"]:
        accounts["b93d5a17"] = {"provider": "claude", "fiveHour": window(0, 300, 300), "sevenDay": window(31, 6 * 24 * 60)}
    return {"claude": {"provider": "claude", "fiveHour": window(0, 208, 300), "sevenDay": window(96, 2 * 24 * 60 - 120),
                       "fetchedAt": at(-1), "accounts": accounts}}


def runners():
    return [{
        "id": "mac", "name": "Mac Studio", "displayName": "Mac Studio", "hostname": "mac-studio.local",
        "online": True, "status": "ONLINE", "version": "0.1.240", "maxConcurrent": 4, "activeSessions": 1,
        "lastHeartbeatAt": at(-0.2), "planUsage": plan_usage(),
        "modelCatalog": {"claude": CLAUDE_MODELS}, "runtimeDefaultModels": {"claude": "claude-opus-4-8"},
        "engines": [
            {"engine": "claude", "installed": True, "version": "2.1.292 (Claude Code)", "auth": "yes",
             "accounts": claude_accounts()},
            {"engine": "codex", "installed": True, "version": "codex-cli 0.160.0", "auth": "no",
             "accounts": [{"id": "default", "auth": "no", "home": "/Users/alex/.codex", "codexHome": "/Users/alex/.codex"}]},
            {"engine": "kimi", "installed": False, "auth": "unknown"},
        ],
    }]


def login_state():
    """What GET /runners/mac/login answers now, from when the relay was started and a code sent."""
    login = STATE["login"]
    if not login:
        return {"status": None, "engine": None, "url": None, "userCode": None, "message": None, "account": None}
    base = {"engine": login["engine"], "account": login["account"], "message": None, "url": None, "userCode": None}
    now = time.time()
    if now - login["t0"] < 3:
        return {**base, "status": "pending"}
    if login["engine"] == "codex":
        return {**base, "status": "awaiting_approval", "url": "https://auth.openai.com/codex/device",
                "userCode": "K7QX-29PM"}
    if login.get("code_at") and now - login["code_at"] >= 3:
        account = login["account"]
        if account == "7c41e0b2":
            STATE["renewed"].add(account)
        elif account:
            STATE["signed_in"].add(account)
        return {**base, "status": "done"}
    return {**base, "status": "awaiting_code",
            "url": "https://claude.ai/oauth/authorize?code=true&client_id=probe&state=probe"}


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
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}

    def do_GET(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if parts == ["api", "agents"]:
            return self.send(200, AGENTS)
        if parts == ["api", "runners"]:
            return self.send(200, runners())
        if parts == ["api", "runners", "mac", "login"]:
            return self.send(200, login_state())
        if parts in (["api", "providers"], ["api", "providers", "mine"], ["api", "providers", "pools"],
                     ["api", "providers", "shared-pools"], ["api", "sessions"], ["api", "session-tags"],
                     ["api", "session-folders"], ["api", "task-lists"], ["api", "watches"],
                     ["api", "share-links"], ["api", "projects"]):
            return self.send(200, [])
        return self.send(404, {"error": "not in the probe"})

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self.body()
        if parts == ["__reset"]:
            STATE.clear()
            STATE.update(fresh_state())
            return self.send(200, {"ok": True})
        if parts == ["api", "runners", "mac", "login"]:
            STATE["login"] = {"engine": body.get("engine"), "account": body.get("account"), "t0": time.time()}
            return self.send(201, login_state())
        if parts == ["api", "runners", "mac", "login", "code"] and STATE["login"]:
            STATE["login"]["code_at"] = time.time()
            return self.send(201, login_state())
        if len(parts) == 7 and parts[:3] == ["api", "runners", "mac"] and parts[3] == "accounts" and parts[6] == "pause":
            minutes = body.get("durationMinutes")
            if minutes:
                STATE["paused"][parts[5]] = at(minutes)
            else:
                STATE["paused"].pop(parts[5], None)
            return self.send(204)
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

    def do_DELETE(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if parts == ["api", "runners", "mac", "login"]:
            STATE["login"] = None
            return self.send(200, login_state())
        return self.send(404, {"error": "not in the probe"})

    def do_PATCH(self):
        return self.send(404, {"error": "not in the probe"})


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
