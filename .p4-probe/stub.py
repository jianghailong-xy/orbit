#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API that Settings -> Infrastructure reads
# on the iPhone app, holding the account of docs/mocks/infrastructure-page/03-ios.png:
#
#   Mac Studio  online, 2 of 4 slots busy, two Claude accounts signed in, Codex signed out, no Kimi
#   HPC         online, 5 of 8 busy, Claude, two Codex accounts and Kimi signed in
#   ThinkPad    offline since yesterday, its Codex signed out when it was last seen
#   Claude keys an account pool of two Anthropic keys, one of them spent
#   API keys    Anthropic (Claude), DeepSeek (runs on Claude Code), and an OpenAI key switched off
#
# GET /api/providers is the pickers' catalogue (enabled keys, no id); GET /api/providers/mine is the
# account's own list, disabled ones included. Every request is logged; anything not served is a 404; a
# write is refused. All data is made up.
import json
import sys
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"


def at(minutes):
    t = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


CLAUDE_MODELS = [{"value": "claude-opus-4-8", "label": "Claude Opus 4.8"},
                 {"value": "claude-sonnet-4-8", "label": "Claude Sonnet 4.8"}]


def machine(rid, name, online, active, slots, seen, engines, host):
    """`seen`: minutes before now of the last heartbeat, stamped when asked — a runner that is up checks
    in every 30 s, so a list read at any moment of a long run says so."""
    return {"id": rid, "name": name, "displayName": name, "hostname": host, "online": online,
            "status": "ONLINE" if online else "OFFLINE", "version": "0.1.240", "maxConcurrent": slots,
            "activeSessions": active, "lastHeartbeatAt": seen, "engines": engines,
            "modelCatalog": {"claude": CLAUDE_MODELS}, "runtimeDefaultModels": {"claude": "claude-opus-4-8"}}


def runners():
    return [
    machine("mac", "Mac Studio", True, 2, 4, at(-0.2), [
        {"engine": "claude", "installed": True, "version": "2.1.4 (Claude Code)", "auth": "yes",
         "accounts": [{"id": "default", "name": "Personal Max", "auth": "yes", "home": "/Users/me/.claude"},
                      {"id": "slot-2", "name": "Work", "auth": "yes", "home": "/Users/me/.orbit/claude-2"}]},
        {"engine": "codex", "installed": True, "version": "codex-cli 0.160.0", "auth": "no"},
        {"engine": "kimi", "installed": False, "auth": "unknown"},
    ], "mac-studio.local"),
    machine("hpc", "HPC", True, 5, 8, at(-0.2), [
        {"engine": "claude", "installed": True, "version": "2.1.4 (Claude Code)", "auth": "yes"},
        {"engine": "codex", "installed": True, "version": "codex-cli 0.160.0", "auth": "yes",
         "accounts": [{"id": "default", "auth": "yes", "codexHome": "/root/.codex"},
                      {"id": "slot-2", "name": "Team", "auth": "yes", "codexHome": "/root/.orbit/codex-2"}]},
        {"engine": "kimi", "installed": True, "version": "1.2.0", "auth": "yes"},
    ], "workstation"),
    machine("thinkpad", "ThinkPad", False, 0, 4, at(-25 * 60), [
        {"engine": "claude", "installed": True, "version": "2.1.2 (Claude Code)", "auth": "yes"},
        {"engine": "codex", "installed": True, "version": "codex-cli 0.150.0", "auth": "no"},
    ], "thinkpad"),
    ]


AGENTS = [{"id": "a1", "name": "orbit", "provider": "claude", "lastProvider": "claude", "runnerId": "mac",
           "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/Users/me/orbit",
           "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]


def key(pid, slug, label, runtime, preset, default, models, enabled=True):
    return {"id": pid, "slug": slug, "label": label, "runtime": runtime, "presetSlug": preset,
            "baseUrl": "https://example.invalid", "models": models, "defaultModel": default,
            "followsPreset": True, "enabled": enabled, "hasApiKey": True, "poolRefusal": None}


KEYS = [
    key("p-claude", "anthropic", "Anthropic (Claude)", "claude", "anthropic", "claude-opus-4-8", CLAUDE_MODELS),
    key("p-work", "anthropic-2", "Anthropic · Work", "claude", "anthropic", "claude-sonnet-4-8", CLAUDE_MODELS),
    key("p-ds", "deepseek", "DeepSeek", "claude", "deepseek", "deepseek-v4-pro",
        [{"value": "deepseek-v4-pro", "label": "DeepSeek V4 Pro"}]),
    key("p-openai", "openai", "OpenAI", "codex", "openai", "gpt-5.6-sol",
        [{"value": "gpt-5.6-sol", "label": "GPT-5.6 Sol"}], enabled=False),
]


def member(pid, slug, label, state, nxt, resets=None):
    return {"id": pid, "slug": slug, "label": label, "presetSlug": "anthropic", "enabled": True,
            "planUsage": None, "state": state, "resetsAt": resets, "next": nxt}


POOLS = [{"id": "pool-1", "slug": "claude-keys", "label": "Claude keys", "engine": "claude", "resetsAt": None,
          "unavailable": None,
          "members": [member("p-claude", "anthropic", "Anthropic (Claude)", "AVAILABLE", True),
                      member("p-work", "anthropic-2", "Anthropic · Work", "SPENT", False, at(90))]}]


def catalogue(row):
    """A row as GET /providers serves it: enabled keys only, no id, no endpoint, no key flag."""
    out = {k: v for k, v in row.items() if k not in ("id", "baseUrl", "hasApiKey", "poolRefusal", "enabled",
                                                       "followsPreset")}
    out.update(planUsage=None, runsOnOpenCode=False)
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

    def do_GET(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if parts == ["api", "agents"]:
            return self.send(200, AGENTS)
        if parts == ["api", "runners"]:
            return self.send(200, runners())
        if parts == ["api", "providers"]:
            return self.send(200, [catalogue(k) for k in KEYS if k["enabled"]])
        if parts == ["api", "providers", "mine"]:
            return self.send(200, KEYS)
        if parts == ["api", "providers", "pools"]:
            return self.send(200, POOLS)
        if parts in (["api", "providers", "shared-pools"], ["api", "sessions"], ["api", "session-tags"],
                     ["api", "session-folders"], ["api", "task-lists"], ["api", "watches"],
                     ["api", "share-links"], ["api", "projects"]):
            return self.send(200, [])
        return self.send(404, {"error": "not in the probe"})

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)
        if parts in (["__reset"], ["__set"]):
            return self.send(200, {"ok": True})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

    def do_PATCH(self):
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
