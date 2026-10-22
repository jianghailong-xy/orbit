#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API one idle conversation needs in
# the native clients — a workspace on one runner and session S1, whose short transcript holds both
# kinds of interrupt (a Stop's and the runner restart's), so both rows show on one screen. Copied
# from docs/evidence/composer-fade/probe-harness/stub.py; agents, runners and providers are the
# DeepSeek Harness probe's, which the console is known to draw. Every request is logged; anything not
# served is a 404. All data is made up except the two interrupt payloads, which are the ones session
# 34dLFOCjLz8KqyCiaECec recorded on 2026-10-13.
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
METRICS = os.path.join(os.path.dirname(os.path.abspath(LOG)), "metrics.log")


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


PRO = '["deepseek", "deepseek-v4-pro"]'
FLASH = '["deepseek", "deepseek-v4-flash"]'
DSH_CATALOG = [
    {"value": PRO, "label": "DeepSeek V4 Pro", "reasoningLevels": ["off", "low", "high", "max"],
     "defaultReasoningLevel": "max"},
    {"value": FLASH, "label": "DeepSeek V4 Flash", "reasoningLevels": ["off", "high"]},
]
CLAUDE_CATALOG = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "contextWindow": 1000000,
                   "reasoningLevels": ["low", "medium", "high", "max"]}]


def runner(rid, name):
    # Stamped per request: the clients call a machine offline once its heartbeat is 90 s old.
    return {"id": rid, "name": name, "displayName": name, "online": True, "status": "ONLINE",
            "version": "0.1.226", "maxConcurrent": 4, "lastHeartbeatAt": ago(0),
            "capabilities": ["provider:dsh", "provider:antigravity"],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"},
                        {"engine": "dsh", "installed": True, "auth": "unknown", "version": "0.2.0-rc.2",
                         "dsh": {"versionCompatible": True, "credentialPresent": False,
                                 "modelCatalogReadable": True, "requestValidation": "unknown",
                                 "sandboxEnforcement": "unknown"}}],
            "modelCatalog": {"claude": CLAUDE_CATALOG, "dsh": DSH_CATALOG},
            "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


def agents():
    return [{"id": "a1", "name": "orbit", "provider": "deepseek-harness", "lastProvider": "deepseek-harness",
             "runnerId": "r1", "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/srv/orbit",
             "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]


HARNESS = {"providerID": "p-dsh", "id": "p-dsh", "slug": "deepseek-harness", "label": "DeepSeek Harness",
           "runtime": "dsh", "models": [], "defaultModel": None, "presetSlug": "deepseek-harness",
           "modelsFromRuntime": True, "enabled": True}
DEEPSEEK = {"providerID": "p-ds", "id": "p-ds", "slug": "deepseek", "label": "DeepSeek", "runtime": "claude",
            "models": [{"value": "deepseek-v4-pro", "label": "DeepSeek V4 Pro", "contextWindow": 1000000}],
            "defaultModel": "deepseek-v4-pro", "presetSlug": "deepseek", "enabled": True}

# Two turns, each cut short: the first by the owner's Stop (claude's interrupt carries the Stop's
# requestId), the second by the runner restarting under it (watchShutdownDrain marks it
# `reason: runner_restart` before tearing the turn down). The second answer is what the tests wait for.
ASK_1 = "Why did my message go out twice?"
ANSWER_1 = "Reading the delivery path first: the composer retries a send whose POST timed out."
ASK_2 = "Keep going: check what the server does with that retry."
ANSWER_2 = "The turns table has no unique key on the client's turn id, so the retry became a second turn."
TAIL = ANSWER_2


def s1_events():
    out, seq = [], 0

    def add(typ, turn, payload, minutes):
        nonlocal seq
        seq += 1
        out.append({"seq": seq, "type": typ, "ts": ago(minutes), "turnId": turn, "payload": payload})

    add("user", "t1", {"text": ASK_1}, 16)
    add("assistant", "t1", {"text": ANSWER_1, "messageId": "m1"}, 16)
    add("interrupt", "t1", {"requestId": "req-22-1"}, 15)
    add("turn_end", "t1", {"subtype": "interrupted"}, 15)
    add("user", "t2", {"text": ASK_2}, 3)
    add("assistant", "t2", {"text": ANSWER_2, "messageId": "m2"}, 1)
    add("interrupt", "t2", {"reason": "runner_restart"}, 0)
    return out


def s1():
    return {"id": "S1", "title": "Duplicate send", "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
            "runState": "AWAITING_INPUT", "lifecycleState": "OPEN", "agentId": "a1",
            "agent": {"id": "a1", "name": "a1"}, "assignedRunnerId": "r1", "provider": "deepseek-harness",
            "model": PRO, "effort": "high", "permissionMode": "default", "taskId": None, "projectId": None,
            "createdAt": ago(20), "updatedAt": ago(0), "lastTurnAt": ago(0), "lastAssistantText": TAIL,
            "pendingApprovals": 0, "tags": [], "folderId": None, "source": "USER"}


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

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        parts = [p for p in url.path.split("/") if p]
        if parts == ["__log"]:
            try:
                with open(LOG) as f:
                    return self.send(200, {"log": f.read()})
            except OSError:
                return self.send(200, {"log": ""})
        if parts == ["api", "agents"]:
            return self.send(200, agents())
        if len(parts) == 3 and parts[:2] == ["api", "agents"]:
            found = [a for a in agents() if a["id"] == parts[2]]
            return self.send(200, found[0]) if found else self.send(404, {"error": "no agent"})
        if parts == ["api", "runners"]:
            return self.send(200, [runner("r1", "hpc")])
        if len(parts) == 3 and parts[:2] == ["api", "runners"]:
            return self.send(200, runner("r1", "hpc")) if parts[2] == "r1" else self.send(404, {"error": "no runner"})
        if parts in (["api", "providers"], ["api", "providers", "mine"]):
            return self.send(200, [HARNESS, DEEPSEEK])
        if parts in (["api", "providers", "pools"], ["api", "providers", "shared-pools"],
                     ["api", "session-tags"], ["api", "session-folders"], ["api", "task-lists"],
                     ["api", "watches"], ["api", "share-links"]):
            return self.send(200, [])
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            return self.send(200, [s1()] if view == "open" else [])
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "events":
            return self.stream(parts[2], int(query.get("sinceSeq", ["0"])[0] or 0))
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            sid, rest = parts[2], parts[3:]
            if sid != "S1":
                return self.send(404, {"error": "not in the probe"})
            if rest == []:
                return self.send(200, s1())
            if rest == ["events", "page"]:
                return self.send(200, {"events": s1_events(), "hasMore": False, "before": None, "after": None})
            if rest in (["approvals"], ["turns"]):
                return self.send(200, [])
            if rest == ["share"]:
                return self.send(200, {"link": None, "counts": {"messages": 4, "toolCalls": 0}})
            return self.send(404, {"error": "not in the probe"})
        return self.send(404, {"error": "not in the probe"})

    def stream(self, sid, sent):
        """Replay what follows `sinceSeq` (SSE `data:` frames, the server's own framing), then hold the
        stream open with a keepalive inside the clients' 45 s watchdog. Nothing new ever arrives."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        last_ping = time.time()
        try:
            for e in (s1_events() if sid == "S1" else []):
                if e["seq"] > sent:
                    self.wfile.write(("data: %s\n\n" % json.dumps(e, ensure_ascii=False)).encode())
            self.wfile.flush()
            while True:
                if time.time() - last_ping > 10:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_ping = time.time()
                time.sleep(0.5)
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode("utf-8", "replace") if n else ""
        if parts in (["__metrics"], ["__mark"]):
            with open(METRICS, "a") as f:
                f.write("%s %s %s\n" % (datetime.now().strftime("%H:%M:%S.%f")[:-3], parts[0][2:], body))
            return self.send(200, {"ok": True})
        if parts == ["__reset"]:
            return self.send(200, {"ok": True})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    def do_PATCH(self):
        return self.send(404, {"error": "not in the probe"})

    def do_PUT(self):
        return self.send(404, {"error": "not in the probe"})

    def do_DELETE(self):
        return self.send(404, {"error": "not in the probe"})


if __name__ == "__main__":
    class LoopbackServer(ThreadingHTTPServer):
        # HTTPServer.server_bind resolves its own name (socket.getfqdn), a reverse lookup that on
        # macOS raises the "find devices on local networks" prompt over the app being photographed.
        def server_bind(self):
            import socketserver
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "localhost", self.server_address[1]

    server = LoopbackServer(("127.0.0.1", PORT), Handler)
    print("stub listening on 127.0.0.1:%d (python %s)" % (PORT, sys.version.split()[0]), flush=True)
    server.serve_forever()
