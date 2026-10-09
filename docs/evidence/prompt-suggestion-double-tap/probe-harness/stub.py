#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the iPhone app reads to open one
# Claude session, S1, whose last turn ended with the engine's guess at the next message
# (prompt_suggestion), on one machine, HPC. POST /__set {"suggestion": "..."} changes the guess;
# POST /__reset puts everything back. Every request is logged with its body; anything not served is a
# 404. All data is made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
SUGGESTION = "合并并部署"


def at(minutes):
    t = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def fresh_state():
    return {"suggestion": SUGGESTION}


STATE = fresh_state()

AGENTS = [{"id": "a1", "name": "orbit-develop", "provider": "claude", "lastProvider": "claude", "runnerId": "hpc",
           "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/root/orbit",
           "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]

CLAUDE_MODELS = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "reasoningLevels": ["low", "medium", "high", "max"]}]


def window(utilization, resets_in, minutes=None):
    w = {"utilization": utilization, "resetsAt": at(resets_in)}
    if minutes:
        w["windowDurationMins"] = minutes
    return w


def runner():
    return {
        "id": "hpc", "name": "HPC", "displayName": "HPC", "hostname": "workstation", "online": True,
        "status": "ONLINE", "version": "0.1.232", "maxConcurrent": 8, "activeSessions": 1,
        # Stamped now: a once-stamped heartbeat would grey the machine out within the run.
        "lastHeartbeatAt": at(-0.2),
        "planUsage": {"claude": {"provider": "claude", "fetchedAt": at(-1), "fiveHour": window(22, 200, 300),
                                 "sevenDay": window(41, 4 * 24 * 60)}},
        "capabilities": [],
        "engines": [{"engine": "claude", "installed": True, "version": "2.1.294 (Claude Code)", "auth": "yes",
                     "update": {"status": "ok", "at": at(-4), "okAt": at(-4)}}],
        "modelCatalog": {"claude": CLAUDE_MODELS},
        "runtimeDefaultModels": {"claude": "claude-opus-5-5"},
    }


def ev(seq, typ, turn, payload, minutes=0):
    return {"seq": seq, "type": typ, "ts": at(-minutes), "turnId": turn, "payload": payload}


def s1_events():
    return [
        ev(1, "user", "t1", {"text": "把 web 全量测试跑一遍，再看下 iOS 构建。"}, 6),
        ev(2, "assistant", "t1", {"text": "web 全量测试全绿，iOS 也构建过了。分支已经 rebase 到最新的 main，可以合并部署了。",
                                  "messageId": "m1"}, 2),
        ev(3, "turn_end", "t1", {"subtype": "success", "numTurns": 1}, 2),
        ev(4, "prompt_suggestion", "t1", {"text": STATE["suggestion"], "source": "engine"}, 2),
    ]


def s1():
    return {"id": "S1", "title": "合并前的全量测试", "status": "AWAITING_INPUT",
            "runStatus": "AWAITING_INPUT", "runState": "AWAITING_INPUT", "lifecycleState": "OPEN",
            "agentId": "a1", "agent": {"id": "a1", "name": "orbit-develop"}, "assignedRunnerId": "hpc",
            "provider": "claude", "model": "claude-opus-5-5", "effort": "max", "permissionMode": "default",
            "taskId": None, "projectId": None, "createdAt": at(-10), "updatedAt": at(0), "lastTurnAt": at(-2),
            "lastAssistantText": "可以合并部署了。", "pendingApprovals": 0,
            "tags": [], "folderId": None, "source": "USER"}


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
        url = urlparse(self.path)
        query = parse_qs(url.query)
        parts = [p for p in url.path.split("/") if p]
        if parts == ["api", "agents"]:
            return self.send(200, AGENTS)
        if parts == ["api", "agents", "a1"]:
            return self.send(200, AGENTS[0])
        if parts == ["api", "runners"]:
            return self.send(200, [runner()])
        if parts == ["api", "runners", "hpc"]:
            return self.send(200, runner())
        if parts in (["api", "providers"], ["api", "providers", "mine"], ["api", "providers", "pools"],
                     ["api", "providers", "shared-pools"], ["api", "session-tags"], ["api", "session-folders"],
                     ["api", "task-lists"], ["api", "watches"], ["api", "share-links"], ["api", "projects"]):
            return self.send(200, [])
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            return self.send(200, [s1()] if view == "open" else [])
        if parts == ["api", "sessions", "S1", "events"]:
            return self.stream(int(query.get("sinceSeq", ["0"])[0] or 0))
        if parts == ["api", "sessions", "S1"]:
            return self.send(200, s1())
        if parts == ["api", "sessions", "S1", "events", "page"]:
            return self.send(200, {"events": s1_events(), "hasMore": False, "before": None, "after": None})
        if parts in (["api", "sessions", "S1", "approvals"], ["api", "sessions", "S1", "turns"]):
            return self.send(200, [])
        return self.send(404, {"error": "not in the probe"})

    def stream(self, sent):
        """Replay what follows `sinceSeq` (SSE `data:` frames, the server's framing), then keep the
        stream open with a keepalive inside the clients' 45 s watchdog."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        last_ping = time.time()
        try:
            while True:
                for e in s1_events():
                    if e["seq"] > sent:
                        self.wfile.write(("data: %s\n\n" % json.dumps(e, ensure_ascii=False)).encode())
                        sent = e["seq"]
                if time.time() - last_ping > 10:
                    self.wfile.write(b": ping\n\n")
                    last_ping = time.time()
                self.wfile.flush()
                time.sleep(0.5)
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self.body()
        if parts == ["__reset"]:
            STATE.clear()
            STATE.update(fresh_state())
            return self.send(200, {"ok": True})
        if parts == ["__diag"]:
            return self.send(200, {"ok": True})
        if parts == ["__set"]:
            if "suggestion" in body:
                STATE["suggestion"] = body["suggestion"]
            return self.send(200, STATE)
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
