#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the iPhone app reads on the screens
# of the provider/engine decoupling boards iOS 1, 2, 4 and 5 (docs/mocks/provider-engine-decoupling/),
# holding the account the boards draw, the one the web's T6/T7 captures serve
# (docs/evidence/provider-engine-decoupling/t6/kit/data.mjs and t7/kit/data.mjs):
#
#   hpc        online, 3 of 16 busy: Claude Code signed in with two accounts (Default, Work), Codex,
#              Antigravity CLI on a Google account, OpenCode, DeepSeek Harness able to run; Kimi Code
#              not installed
#   old-mac    online, runner 0.1.198 (before DeepSeek Harness), Codex signed out
#   build-box  online, DeepSeek Harness not installed
#   API keys   DeepSeek and DeepSeek 2 (each on Claude Code, OpenCode and DeepSeek Harness), Gemini, Kimi
#              (Moonshot), Z.AI (GLM), and Claude Max, a Claude subscription token (Claude Code alone)
#   pool       Claude accounts, two Claude subscriptions
#   orbit      the workspace on hpc, last on Claude Code with its own sign-in
#   S1         a DeepSeek Harness session on the DeepSeek key (board iOS 5 ①)
#   S4         a DeepSeek Harness session whose key (`deepseek-harness`, the retired preset's) was deleted
#              (board iOS 5 ④)
#
# POST /__set {"keys": "nodeepseek"} takes the two DeepSeek keys away (board iOS 4: the Engine sheet with
# no DeepSeek key); POST /__reset puts everything back (every UI test calls it before launching). GET
# /api/providers is the pickers' catalogue (enabled keys, no id, no endpoint); GET /api/providers/mine the
# account's own list. Every request is logged; anything not served is a 404; a write is refused. All data
# is made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def in_hours(hours):
    return ago(-hours * 60)


PRO = '["deepseek", "deepseek-v4-pro"]'
FLASH = '["deepseek", "deepseek-v4-flash"]'
DSH_OK = {"versionCompatible": True, "credentialPresent": False, "modelCatalogReadable": True,
          "requestValidation": "unknown", "sandboxEnforcement": "unknown"}
CLAUDE_CATALOG = [
    {"value": "claude-opus-5-5", "label": "Opus 5.5", "contextWindow": 1000000,
     "reasoningLevels": ["low", "medium", "high", "max"]},
    {"value": "claude-sonnet-5-5", "label": "Sonnet 5.5", "contextWindow": 1000000,
     "reasoningLevels": ["low", "medium", "high", "max"]},
]
DSH_CATALOG = [
    {"value": PRO, "label": "DeepSeek V4 Pro", "reasoningLevels": ["off", "low", "high", "max"]},
    {"value": FLASH, "label": "DeepSeek V4 Flash", "reasoningLevels": ["off", "high"]},
]


def runners():
    # Stamped when asked: a runner that is up checks in every 30 s, so a read at any moment of a long run
    # finds it online (RunnerAttention calls a machine offline once its heartbeat is 90 s old).
    hpc = {
        "id": "hpc", "name": "hpc", "displayName": "hpc", "online": True, "status": "ONLINE", "maxConcurrent": 16,
        "activeSessions": 3, "position": 0, "hostname": "hpc-01", "version": "0.1.240", "lastHeartbeatAt": ago(0.2),
        "runsAsRoot": False, "capabilities": ["provider:dsh", "provider:antigravity", "provider:opencode"],
        "engines": [
            {"engine": "claude", "installed": True, "auth": "yes", "version": "2.1.290 (Claude Code)",
             "accounts": [{"id": "default", "home": "/root/.claude", "auth": "yes"},
                          {"id": "slot-2", "name": "Work", "home": "/root/.orbit/claude-accounts/slot-2", "auth": "yes"}]},
            {"engine": "codex", "installed": True, "auth": "yes", "version": "codex-cli 0.162.0"},
            {"engine": "antigravity", "installed": True, "auth": "yes", "authSource": "google", "version": "agy 1.3.2"},
            {"engine": "kimi", "installed": False, "auth": "unknown"},
            {"engine": "opencode", "installed": True, "auth": "yes", "version": "1.18.35"},
            {"engine": "dsh", "installed": True, "auth": "unknown", "version": "0.2.0-rc.2", "dsh": DSH_OK},
        ],
        "antigravity": {"supported": True, "installed": True, "version": "agy 1.3.2", "envKeyAvailable": False,
                        "authSource": "google", "googleLogin": "available"},
        "planUsage": {
            "claude": {"provider": "claude", "fiveHour": {"utilization": 23, "resetsAt": in_hours(3)}, "fetchedAt": ago(2),
                       "accounts": {"slot-2": {"provider": "claude", "fiveHour": {"utilization": 57, "resetsAt": in_hours(4)},
                                               "fetchedAt": ago(2)}}},
            "codex": {"provider": "codex", "secondary": {"utilization": 41, "resetsAt": in_hours(80),
                                                         "windowDurationMins": 10080}, "fetchedAt": ago(2)},
        },
        "modelCatalog": {"claude": CLAUDE_CATALOG, "dsh": DSH_CATALOG,
                         "antigravity": [{"value": "gemini-3.8-flash", "label": "Gemini 3.8 Flash"}]},
        "runtimeDefaultModels": {"claude": "claude-opus-5-5", "dsh": PRO, "codex": "gpt-5.6-sol",
                                 "antigravity": "gemini-3.8-flash"},
    }
    old_mac = {
        "id": "old-mac", "name": "old-mac", "displayName": "old-mac", "online": True, "status": "ONLINE",
        "maxConcurrent": 4, "activeSessions": 1, "position": 1, "hostname": "old-mac.local", "version": "0.1.198",
        "lastHeartbeatAt": ago(0.3), "capabilities": [],
        "engines": [
            {"engine": "claude", "installed": True, "auth": "yes", "version": "2.1.280 (Claude Code)"},
            {"engine": "codex", "installed": True, "auth": "no", "version": "codex-cli 0.150.0"},
        ],
        "antigravity": {"supported": False, "installed": None, "version": None, "envKeyAvailable": False,
                        "googleLogin": "needs_update"},
    }
    build_box = {
        "id": "build-box", "name": "build-box", "displayName": "build-box", "online": True, "status": "ONLINE",
        "maxConcurrent": 4, "activeSessions": 0, "position": 2, "hostname": "build-box", "version": "0.1.240",
        "lastHeartbeatAt": ago(0.1), "capabilities": ["provider:dsh", "provider:antigravity"],
        "engines": [
            {"engine": "claude", "installed": True, "auth": "yes", "version": "2.1.290 (Claude Code)"},
            {"engine": "codex", "installed": True, "auth": "yes", "version": "codex-cli 0.162.0"},
            {"engine": "dsh", "installed": False, "auth": "unknown", "dsh": dict(DSH_OK, versionCompatible=False)},
        ],
        "antigravity": {"supported": True, "installed": False, "version": None, "envKeyAvailable": False,
                        "googleLogin": "available"},
    }
    return [hpc, old_mac, build_box]


DEEPSEEK_MODELS = [
    {"value": "deepseek-v4-pro", "label": "DeepSeek V4 Pro", "contextWindow": 1000000},
    {"value": "deepseek-v4-flash", "label": "DeepSeek V4 Flash", "contextWindow": 1000000},
]


def key(**over):
    row = {"runtime": "claude", "engines": ["claude", "opencode"], "models": [], "defaultModel": None,
           "followsPreset": True, "enabled": True, "hasApiKey": True, "poolRefusal": None}
    row.update(over)
    return row


KEYS = [
    key(id="p-ds", slug="deepseek", label="DeepSeek", engines=["claude", "opencode", "dsh"],
        baseUrl="https://api.deepseek.com/anthropic", models=DEEPSEEK_MODELS, defaultModel="deepseek-v4-pro",
        presetSlug="deepseek"),
    key(id="p-ds2", slug="deepseek-2", label="DeepSeek 2", engines=["claude", "opencode", "dsh"],
        baseUrl="https://api.deepseek.com/anthropic", models=DEEPSEEK_MODELS, defaultModel="deepseek-v4-pro",
        presetSlug="deepseek"),
    key(id="p-gem", slug="gemini", label="Gemini", runtime="antigravity", engines=["antigravity", "opencode"],
        baseUrl="https://generativelanguage.googleapis.com",
        models=[{"value": "gemini-3.8-flash", "label": "Gemini 3.8 Flash"}], defaultModel="gemini-3.8-flash",
        presetSlug="gemini"),
    key(id="p-kimi", slug="moonshot", label="Kimi (Moonshot)", runtime="kimi", engines=["kimi", "opencode"],
        baseUrl="https://api.moonshot.ai/v1", models=[{"value": "kimi-k2.7-code", "label": "Kimi K2.7 Code"}],
        defaultModel="kimi-k2.7-code", presetSlug="moonshot"),
    key(id="p-glm", slug="glm", label="Z.AI (GLM)", baseUrl="https://api.z.ai/api/anthropic",
        models=[{"value": "glm-5.2", "label": "GLM-5.2"}, {"value": "glm-4.7", "label": "GLM-4.7"}],
        defaultModel="glm-5.2", presetSlug="glm"),
    # A Claude subscription token: the server says it runs on Claude Code alone.
    key(id="p-max", slug="anthropic", label="Claude Max", engines=["claude"], baseUrl="https://api.anthropic.com",
        models=[{"value": "claude-opus-5-5", "label": "Claude Opus 5.5"},
                {"value": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5"}],
        defaultModel="claude-opus-5-5", presetSlug="anthropic"),
]

BALANCES = {
    "p-ds": {"currency": "CNY", "totalBalance": "110.00", "grantedBalance": "10.00", "toppedUpBalance": "100.00"},
    "p-ds2": {"currency": "CNY", "totalBalance": "36.20", "grantedBalance": "0.00", "toppedUpBalance": "36.20"},
}


def member(pid, label, nxt):
    return {"id": pid, "slug": label.lower().replace(" ", "-"), "label": label, "presetSlug": "anthropic",
            "enabled": True, "planUsage": None, "state": "NO_QUOTA", "resetsAt": None, "next": nxt}


POOLS = [{"id": "pool-1", "slug": "claude-accounts", "label": "Claude accounts", "engine": "claude",
          "resetsAt": None, "unavailable": None,
          "members": [member("pool-a", "Claude Team A", True), member("pool-b", "Claude Team B", False)]}]

AGENTS = [
    {"id": "a1", "name": "orbit", "provider": None, "lastEngine": "claude", "lastProvider": "claude",
     "runnerId": "hpc", "enabled": True, "enableWorktree": True, "effort": "", "workDir": "/root/orbit",
     "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True},
]

STATE = {}


def reset():
    STATE.update(keys="all")


reset()


def own_keys():
    if STATE["keys"] == "nodeepseek":
        return [k for k in KEYS if "dsh" not in k["engines"]]
    return KEYS


def catalogue():
    """GET /providers (ProvidersService.listPublic): the enabled keys, keyless and endpointless."""
    return [{"slug": k["slug"], "label": k["label"], "runtime": k["runtime"], "models": k["models"],
             "defaultModel": k["defaultModel"], "presetSlug": k["presetSlug"], "engines": k["engines"],
             "planUsage": None, "runsOnOpenCode": "opencode" in k["engines"]}
            for k in own_keys() if k["enabled"]]


def session(sid, title, **over):
    row = {"id": sid, "title": title, "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
           "runState": "AWAITING_INPUT", "lifecycleState": "OPEN", "agentId": "a1",
           "agent": {"id": "a1", "name": "orbit"}, "assignedRunnerId": "hpc", "engine": "dsh", "provider": "deepseek",
           "model": PRO, "effort": None, "permissionMode": "default", "taskId": None, "projectId": None,
           "createdAt": ago(40), "updatedAt": ago(2), "lastTurnAt": ago(2), "pendingApprovals": 0, "tags": [],
           "folderId": None, "source": "USER", "lastAssistantText": None}
    row.update(over)
    return row


SESSIONS = {
    "S1": (session("S1", "Tidy the release notes",
                   lastAssistantText="Done: the notes are grouped by area, and the two duplicate entries are gone."), [
        ("user", "Tidy the release notes for 0.1.240."),
        ("assistant", "Done: the notes are grouped by area, and the two duplicate entries are gone."),
    ]),
    # Its key was deleted after it ran: `deepseek-harness`, the retired Harness preset's slug.
    "S4": (session("S4", "Fix the flaky worktree test", provider="deepseek-harness",
                   lastAssistantText="It races the cleanup of the previous run. A fix is on the branch."), [
        ("user", "The worktree test fails one run in ten. Find out why."),
        ("assistant", "It races the cleanup of the previous run. A fix is on the branch."),
    ]),
}


def events(sid):
    _, said = SESSIONS.get(sid, (None, []))
    out, seq = [], 0
    for kind, text in said:
        seq += 1
        out.append({"seq": seq, "type": kind, "ts": ago(14 - seq), "turnId": sid + "-t1", "payload": {"text": text}})
    seq += 1
    out.append({"seq": seq, "type": "turn_end", "ts": ago(12), "turnId": sid + "-t1", "payload": {}})
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S.%f")[:-3], fmt % args))

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
        if text:
            with open(LOG, "a") as f:
                f.write("    %s %s body: %s\n" % (self.command, urlparse(self.path).path, text))
        try:
            return json.loads(text) if text else {}
        except ValueError:
            return {}

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        parts = [p for p in url.path.split("/") if p]
        if parts == ["api", "agents"]:
            return self.send(200, AGENTS)
        if len(parts) == 3 and parts[:2] == ["api", "agents"]:
            found = [a for a in AGENTS if a["id"] == parts[2]]
            return self.send(200, found[0]) if found else self.send(404, {"error": "no workspace"})
        if parts == ["api", "runners"]:
            return self.send(200, runners())
        if len(parts) == 3 and parts[:2] == ["api", "runners"]:
            found = [r for r in runners() if r["id"] == parts[2]]
            return self.send(200, found[0]) if found else self.send(404, {"error": "no runner"})
        if parts == ["api", "providers"]:
            return self.send(200, catalogue())
        if parts == ["api", "providers", "mine"]:
            return self.send(200, own_keys())
        if len(parts) == 5 and parts[:3] == ["api", "providers", "mine"] and parts[4] == "balance":
            pid = parts[3]
            if pid not in BALANCES:
                return self.send(404, {"error": "no balance"})
            return self.send(200, {"ok": True, "providerId": pid, "balances": [BALANCES[pid]], "isAvailable": True,
                                   "fetchedAt": ago(2), "sharedWith": []})
        if parts == ["api", "providers", "pools"]:
            return self.send(200, POOLS)
        if parts in (["api", "providers", "shared-pools"], ["api", "session-tags"], ["api", "session-folders"],
                     ["api", "task-lists"], ["api", "watches"], ["api", "share-links"], ["api", "projects"]):
            return self.send(200, [])
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            return self.send(200, [row for row, _ in SESSIONS.values()] if view == "open" else [])
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "events":
            return self.stream(parts[2])
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            sid, rest = parts[2], parts[3:]
            row, _ = SESSIONS.get(sid, (None, None))
            if row is None:
                return self.send(404, {"error": "not in the probe"})
            if rest == []:
                return self.send(200, row)
            if rest == ["events", "page"]:
                return self.send(200, {"events": events(sid), "hasMore": False, "before": None, "after": None})
            if rest in (["approvals"], ["turns"]):
                return self.send(200, [])
            if rest == ["share"]:
                return self.send(200, {"link": None, "counts": {"messages": 2, "toolCalls": 0}})
            return self.send(404, {"error": "not in the probe"})
        return self.send(404, {"error": "not in the probe"})

    def stream(self, sid):
        """The session's events after the page the console read: none — a keepalive inside the clients'
        45 s watchdog, so the console stays connected rather than retrying."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            while True:
                self.wfile.write(b": ping\n\n")
                self.wfile.flush()
                time.sleep(10)
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self.body()
        if parts == ["__reset"]:
            reset()
            return self.send(200, {"ok": True})
        if parts == ["__set"]:
            if "keys" in body:
                STATE["keys"] = body["keys"]
            return self.send(200, STATE)
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

    def do_PATCH(self):
        self.body()
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

    def do_PUT(self):
        self.body()
        return self.send(404, {"error": "not in the probe"})

    def do_DELETE(self):
        return self.send(404, {"error": "not in the probe"})


if __name__ == "__main__":
    class LoopbackServer(ThreadingHTTPServer):
        daemon_threads = True

        # HTTPServer.server_bind resolves its own name (socket.getfqdn), a reverse lookup that on macOS
        # can raise the "find devices on local networks" prompt.
        def server_bind(self):
            import socketserver
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "localhost", self.server_address[1]

    server = LoopbackServer(("127.0.0.1", PORT), Handler)
    print("stub listening on 127.0.0.1:%d (python %s)" % (PORT, sys.version.split()[0]), flush=True)
    server.serve_forever()
