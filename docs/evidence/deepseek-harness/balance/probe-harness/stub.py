#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API that Settings -> Providers reads
# on the iPhone app, with DeepSeek keys whose account balance comes back in every state.
#
#   POST /__set {"scenario": "pair"}    Anthropic, DeepSeek and DeepSeek Harness holding ONE key (so
#                                       one balance, each naming the other), Kimi.
#   POST /__set {"scenario": "states"}  DeepSeek keys whose balance is too low (is_available=false),
#                                       rejected (401), unreachable, in two currencies, or still loading.
#
# GET /api/providers is the pickers' catalogue (no id, no endpoint, as the server de-sensitizes it);
# GET /api/providers/mine is the account's own list; GET /api/providers/mine/:id/balance answers in
# the server's shape (apiserver providers/deepseek-balance.service.ts). A refresh (?refresh=1) answers
# with a read made now, and is logged. Every request is logged; anything not served is a 404. All data
# is made up; nothing here talks to DeepSeek.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes, seconds=5 if minutes else 0)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


CLAUDE_CATALOG = [{"value": "claude-opus-4-8", "label": "Claude Opus 4.8", "contextWindow": 1000000,
                   "reasoningLevels": ["low", "medium", "high", "max"]}]
RUNNERS = [{"id": "r1", "name": "HPC", "displayName": "HPC", "online": True, "status": "ONLINE",
            "version": "0.1.215", "maxConcurrent": 4, "lastHeartbeatAt": ago(0),
            "capabilities": ["provider:dsh"],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"},
                        {"engine": "codex", "installed": True, "version": "0.80.0", "auth": "yes"},
                        {"engine": "kimi", "installed": True, "version": "1.2.0", "auth": "no"}],
            "modelCatalog": {"claude": CLAUDE_CATALOG}, "runtimeDefaultModels": {"claude": "claude-opus-4-8"}}]
AGENTS = [{"id": "a1", "name": "orbit", "provider": "claude", "lastProvider": "claude", "runnerId": "r1",
           "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/srv/orbit",
           "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]

DEEPSEEK_MODELS = [{"value": "deepseek-v4-pro", "label": "DeepSeek V4 Pro", "contextWindow": 1000000},
                   {"value": "deepseek-v4-flash", "label": "DeepSeek V4 Flash", "contextWindow": 1000000}]
ANTHROPIC_BASE = "https://api.anthropic.com"
DEEPSEEK_BASE = "https://api.deepseek.com/anthropic"


def key(pid, slug, label, runtime, preset, base, default, models=()):
    return {"id": pid, "slug": slug, "label": label, "runtime": runtime, "presetSlug": preset, "baseUrl": base,
            "models": list(models), "defaultModel": default, "followsPreset": preset is not None, "enabled": True,
            "hasApiKey": True, "poolRefusal": None}


ANTHROPIC = key("p-claude", "anthropic", "Anthropic (Claude)", "claude", "anthropic", ANTHROPIC_BASE,
                "claude-opus-4-8", CLAUDE_CATALOG)
DEEPSEEK = key("p-ds", "deepseek", "DeepSeek", "claude", "deepseek", DEEPSEEK_BASE, "deepseek-v4-pro",
               DEEPSEEK_MODELS)
HARNESS = key("p-dsh", "deepseek-harness", "DeepSeek Harness", "dsh", "deepseek-harness", DEEPSEEK_BASE, "")
KIMI = key("p-kimi", "moonshot", "Kimi (Moonshot)", "kimi", "moonshot", "https://api.moonshot.ai/v1",
           "kimi-k2.7-code", [{"value": "kimi-k2.7-code", "label": "Kimi K2.7 Code"}])
TEAM = key("p-low", "deepseek-2", "DeepSeek Team", "claude", "deepseek", DEEPSEEK_BASE, "deepseek-v4-pro",
           DEEPSEEK_MODELS)
OLD = key("p-old", "deepseek-3", "DeepSeek Old key", "claude", "deepseek", DEEPSEEK_BASE, "deepseek-v4-pro",
          DEEPSEEK_MODELS)
# A custom provider (no preset) on DeepSeek's own host is a DeepSeek key too.
DIRECT = key("p-net", "deepseek-direct", "DeepSeek Direct", "claude", None, DEEPSEEK_BASE, "deepseek-v4-flash",
             DEEPSEEK_MODELS)
INTL = key("p-usd", "deepseek-4", "DeepSeek Intl", "claude", "deepseek", DEEPSEEK_BASE, "deepseek-v4-pro",
           DEEPSEEK_MODELS)
SLOW = key("p-slow", "deepseek-5", "DeepSeek Slow", "claude", "deepseek", DEEPSEEK_BASE, "deepseek-v4-pro",
           DEEPSEEK_MODELS)

SCENARIOS = {"pair": [ANTHROPIC, DEEPSEEK, HARNESS, KIMI],
             "states": [TEAM, OLD, DIRECT, INTL, SLOW]}

CNY = {"currency": "CNY", "totalBalance": "110.00", "grantedBalance": "10.00", "toppedUpBalance": "100.00"}
USD = {"currency": "USD", "totalBalance": "5.00", "grantedBalance": "0.00", "toppedUpBalance": "5.00"}
LOW = {"currency": "CNY", "totalBalance": "0.42", "grantedBalance": "0.00", "toppedUpBalance": "0.42"}


def ok(balances, available, minutes, shared=()):
    return lambda fetched: {"ok": True, "balances": balances, "isAvailable": available,
                            "fetchedAt": fetched or ago(minutes),
                            "sharedWith": [{"id": i, "publicId": i, "label": l} for i, l in shared]}


def failed(reason, message, minutes):
    return lambda fetched: {"ok": False, "reason": reason, "message": message, "fetchedAt": fetched or ago(minutes),
                            "sharedWith": []}


# One key behind DeepSeek and DeepSeek Harness: the server keeps one read for it, so a refresh of
# either is the other's too.
SAME_KEY = {"p-ds": "k1", "p-dsh": "k1"}
BALANCES = {
    "p-ds": ok([CNY], True, 2, [("p-dsh", "DeepSeek Harness")]),
    "p-dsh": ok([CNY], True, 2, [("p-ds", "DeepSeek")]),
    "p-low": ok([LOW], False, 0),
    "p-old": failed("KEY_REJECTED", "DeepSeek rejected this API key (401 Authentication Fails).", 0),
    "p-net": failed("NETWORK", "Couldn't reach api.deepseek.com — the request timed out after 10 s. "
                               "The key itself wasn't checked.", 1),
    "p-usd": ok([CNY, USD], True, 2),
}
STATE = {}


def reset():
    STATE.update(scenario="pair", refreshed={})


reset()


def catalogue(row):
    """A row as GET /providers serves it: no id, no endpoint, no key flag."""
    out = {k: v for k, v in row.items() if k not in ("id", "baseUrl", "hasApiKey", "poolRefusal", "enabled",
                                                       "followsPreset")}
    out.update(planUsage=None, runsOnOpenCode=False, modelsFromRuntime=row["runtime"] == "dsh" or None)
    return out


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
            return json.loads(raw.decode("utf-8", "replace")) if raw else {}
        except ValueError:
            return {}

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        parts = [p for p in url.path.split("/") if p]
        rows = SCENARIOS[STATE["scenario"]]
        if parts == ["api", "agents"]:
            return self.send(200, AGENTS)
        if parts == ["api", "runners"]:
            return self.send(200, RUNNERS)
        if parts == ["api", "providers"]:
            return self.send(200, [catalogue(r) for r in rows])
        if parts == ["api", "providers", "mine"]:
            return self.send(200, rows)
        if len(parts) == 5 and parts[:3] == ["api", "providers", "mine"] and parts[4] == "balance":
            pid = parts[3]
            if pid == "p-slow":
                time.sleep(600)  # still asking: the page has nothing but "Checking balance…" to show
                return self.send(504, {"message": "the probe never answers this one"})
            if pid not in BALANCES:
                return self.send(400, {"message": "only a DeepSeek key has an account balance"})
            if query.get("refresh") == ["1"]:
                now = ago(0)
                for other, k in SAME_KEY.items():
                    if other == pid or (k and k == SAME_KEY.get(pid)):
                        STATE["refreshed"][other] = now
                STATE["refreshed"][pid] = now
            return self.send(200, BALANCES[pid](STATE["refreshed"].get(pid)))
        if parts in (["api", "providers", "pools"], ["api", "providers", "shared-pools"], ["api", "sessions"],
                     ["api", "session-tags"], ["api", "session-folders"], ["api", "task-lists"],
                     ["api", "watches"], ["api", "share-links"], ["api", "projects"]):
            return self.send(200, [])
        return self.send(404, {"error": "not in the probe"})

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self.body()
        if parts == ["__reset"]:
            reset()
            return self.send(200, {"ok": True})
        if parts == ["__set"]:
            if body.get("scenario") in SCENARIOS:
                STATE["scenario"] = body["scenario"]
            return self.send(200, {"scenario": STATE["scenario"]})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

    def do_PATCH(self):
        self.body()
        return self.send(404, {"error": "not in the probe"})

    def do_DELETE(self):
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
