#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the iPhone app reads to draw one
# workspace's session list and a conversation, for task 34tKGg8Mi2jmMzS3l3yeY (F3n-1,
# docs/feishu-bot-design.md §8.2). Adapted from probe/answer-delivery-one-line's stub. Three sessions:
#
#   F1  a Feishu group member's request, still running: the row carries lastUserText and
#       lastUserFromExternal {FEISHU, Li Lei}; the conversation's user event carries externalSender
#   F2  the same, but Feishu gave no name: {FEISHU, null}
#   S1  the owner's own message, still running: no sender ("You:")
#   O1  a message Orbit wrote itself, still running: lastUserFromOrbit ("Orbit:"), as main's
#       session-list-projects §3.5 gives it
#
# Every request is logged; anything not served is a 404. All data is made up.
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
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


AGENTS = [{"id": "a1", "name": "orbit-develop", "provider": "claude", "lastProvider": "claude", "runnerId": "hpc",
           "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/root/orbit",
           "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]
CLAUDE_MODELS = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "reasoningLevels": ["low", "medium", "high", "max"]}]


def runner():
    return {"id": "hpc", "name": "HPC", "displayName": "HPC", "hostname": "workstation", "online": True,
            "status": "ONLINE", "version": "0.1.240", "maxConcurrent": 8, "activeSessions": 2,
            "lastHeartbeatAt": ago(0), "capabilities": [],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.300", "auth": "yes"}],
            "modelCatalog": {"claude": CLAUDE_MODELS}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


def ev(seq, typ, turn, payload, ts):
    return {"seq": seq, "type": typ, "ts": ts, "turnId": turn, "payload": payload}


EARLIER = "Add a retry to the nightly export job."
EARLIER_REPLY = "Done: the export job retries three times with backoff."
F1_ASK = "Can you also check why the export **failed last night**?"
F2_ASK = "Please rerun the export for October."
S1_ASK = "Bump the runner to 0.1.240 and tag it."
O1_ASK = "Your background job finished: nightly export dry run (exit 0).\nRead its output with bg_output."


def session(sid, title, ask, sender, minutes, orbit=None):
    """A running session whose last message is not answered yet."""
    events = [ev(1, "user", "t1", {"text": EARLIER}, ago(minutes + 30)),
              ev(2, "assistant", "t1", {"text": EARLIER_REPLY, "messageId": "m1"}, ago(minutes + 29)),
              ev(3, "result", "t1", {"subtype": "success", "result": "done"}, ago(minutes + 29)),
              ev(4, "user", "t2", {"text": ask, **({"externalSender": sender} if sender else {})}, ago(minutes))]
    return {"id": sid, "title": title, "ask": ask, "sender": sender, "orbit": orbit, "events": events}


SESSIONS = [
    session("F1", "Nightly export (Feishu group)", F1_ASK, {"source": "FEISHU", "name": "Li Lei"}, 1),
    session("F2", "October export rerun", F2_ASK, {"source": "FEISHU", "name": None}, 3),
    session("S1", "Runner release", S1_ASK, None, 5),
    session("O1", "Export dry run", O1_ASK, None, 7, orbit={"coordinatorDelivery": None}),
]


def find(sid):
    return next((s for s in SESSIONS if s["id"] == sid), None)


def row(s):
    last = s["events"][-1]
    return {"id": s["id"], "title": s["title"], "status": "RUNNING", "runStatus": "RUNNING",
            "runState": "RUNNING", "sessionState": "RUNNING", "lifecycleState": "OPEN", "filingState": "OPEN",
            "agentId": "a1", "agent": {"id": "a1", "name": "orbit-develop"}, "assignedRunnerId": "hpc",
            "provider": "claude", "model": "claude-opus-5-5", "effort": "high", "permissionMode": "default",
            "taskId": None, "projectId": None, "createdAt": s["events"][0]["ts"], "updatedAt": last["ts"],
            "lastTurnAt": last["ts"], "currentTurnStartedAt": last["ts"], "lastAssistantText": EARLIER_REPLY,
            "lastUserText": s["ask"], "lastUserFrom": None, "lastUserFromExternal": s["sender"], "lastUserFromOrbit": s["orbit"],
            "pendingApprovals": 0, "tags": [], "folderId": None, "source": "USER", "engineTurnActive": True}


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
        if parts == ["api", "events"]:
            return self.keepalive()
        if parts in (["api", "providers"], ["api", "providers", "mine"], ["api", "providers", "pools"],
                     ["api", "providers", "shared-pools"], ["api", "session-tags"], ["api", "session-folders"],
                     ["api", "task-lists"], ["api", "watches"], ["api", "share-links"], ["api", "projects"]):
            return self.send(200, [])
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            return self.send(200, [row(s) for s in SESSIONS] if view == "open" else [])
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            s = find(parts[2])
            if s is None:
                return self.send(404, {"error": "not in the probe"})
            rest = parts[3:]
            if rest == []:
                return self.send(200, row(s))
            if rest == ["events"]:
                return self.stream(s, int(query.get("sinceSeq", ["0"])[0] or 0))
            if rest == ["events", "page"]:
                return self.send(200, {"events": s["events"], "hasMore": False, "before": None, "after": None})
            if rest in (["turns"], ["approvals"]):
                return self.send(200, [])
            return self.send(404, {"error": "not in the probe"})
        return self.send(404, {"error": "not in the probe"})

    def keepalive(self):
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

    def stream(self, s, sent):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        last_ping = time.time()
        try:
            while True:
                for e in s["events"]:
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
        if parts == ["__reset"]:
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

        def server_bind(self):
            import socketserver
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "localhost", self.server_address[1]

    server = LoopbackServer(("127.0.0.1", PORT), Handler)
    print("stub listening on 127.0.0.1:%d" % PORT, flush=True)
    server.serve_forever()
