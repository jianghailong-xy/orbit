#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API one conversation reads on the iPhone and Mac
# apps, for task 350Wz6vjlg4mgTMX8AYaq. Adapted from docs/evidence/criteria-reply-session-line/probe-harness/stub.py.
#
#   S1  a session queued behind a full runner (HPC, 16 of 16 slots, 6 held by background jobs): one finished round,
#       then `Why is task 6 still queued?`, which GET …/turns?view=active lists as the accepted head — the server has
#       it, no runner has echoed it. DELETE …/turns/t6 withdraws it (204) and the session goes back to awaiting input,
#       as SessionsService.cancelQueuedTurn does.
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
STARTED = datetime.now(timezone.utc).replace(second=0, microsecond=0)
WAITING = "Why is task 6 still queued?"


def ago(minutes, seconds=0):
    t = STARTED - timedelta(minutes=minutes) + timedelta(seconds=seconds)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def now():
    t = datetime.now(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


AGENTS = [{"id": "a1", "name": "orbit-develop", "provider": "claude", "lastProvider": "claude", "runnerId": "hpc",
           "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/root/orbit",
           "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]
CLAUDE_MODELS = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "reasoningLevels": ["low", "medium", "high", "max"]}]


def runner():
    return {"id": "hpc", "name": "HPC", "displayName": "HPC", "hostname": "workstation", "online": True,
            "status": "ONLINE", "version": "0.1.242", "maxConcurrent": 16, "activeSessions": 16,
            "lastHeartbeatAt": now(), "capabilities": [],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}],
            "modelCatalog": {"claude": CLAUDE_MODELS}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


def ev(seq, typ, turn, payload, ts):
    return {"seq": seq, "type": typ, "ts": ts, "turnId": turn, "payload": payload}


def fresh_state():
    return {
        "held": True,
        "events": [
            ev(1, "user", "t5", {"text": "Start tasks 5 and 6 on HPC."}, ago(30)),
            ev(2, "assistant", "t5", {"text": "Task 5 is running on HPC. Task 6 waits for a free slot.",
                                      "messageId": "m2"}, ago(29)),
            ev(3, "result", "t5", {"subtype": "success", "result": "done"}, ago(29)),
        ],
    }


STATE = fresh_state()


def session_row():
    held = STATE["held"]
    status = "PENDING" if held else "AWAITING_INPUT"
    run_state = "QUEUED" if held else "AWAITING_INPUT"
    row = {"id": "S1", "title": "Task 6 dispatch", "status": status, "runStatus": status, "runState": run_state,
           "sessionState": run_state, "lifecycleState": "OPEN", "filingState": "OPEN", "agentId": "a1",
           "agent": {"id": "a1", "name": "orbit-develop"}, "assignedRunnerId": "hpc", "provider": "claude",
           "model": "claude-opus-5-5", "effort": "high", "permissionMode": "default", "taskId": None,
           "taskTitle": None, "projectId": None, "projectTitle": None, "createdAt": ago(30), "updatedAt": ago(2),
           "lastTurnAt": ago(2), "lastAssistantText": "Task 5 is running on HPC. Task 6 waits for a free slot.",
           "pendingApprovals": 0, "tags": [], "folderId": None, "source": "USER"}
    if held:
        row.update({"queuedReason": "runner_at_capacity", "queuedActive": 16, "queuedLimit": 16,
                    "queuedHeldByJobs": 6})
    return row


def active_turns():
    if not STATE["held"]:
        return []
    return [{"turnId": "t6", "kind": "message", "placement": "accepted", "content": WAITING,
             "createdAt": ago(2), "attachments": []}]


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
        if parts == ["api", "events"]:
            return self.keepalive()
        if parts in (["api", "providers"], ["api", "providers", "mine"], ["api", "providers", "pools"],
                     ["api", "providers", "shared-pools"], ["api", "session-tags"], ["api", "session-folders"],
                     ["api", "task-lists"], ["api", "watches"], ["api", "share-links"], ["api", "projects"]):
            return self.send(200, [])
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            return self.send(200, [session_row()] if view == "open" else [])
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            if parts[2] != "S1":
                return self.send(404, {"error": "not in the probe"})
            rest = parts[3:]
            if rest == []:
                return self.send(200, session_row())
            if rest == ["events"]:
                return self.stream(int(query.get("sinceSeq", ["0"])[0] or 0))
            if rest == ["events", "page"]:
                return self.send(200, {"events": STATE["events"], "hasMore": False, "before": None, "after": None})
            if rest == ["turns"]:
                return self.send(200, active_turns())
            if rest == ["approvals"]:
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

    def stream(self, sent):
        """Replay what follows `sinceSeq` (SSE `data:` frames), then keep the stream alive inside the
        clients' 45 s watchdog. No runner ever echoes t6: that is the state under test."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        last_ping = time.time()
        try:
            while True:
                for e in STATE["events"]:
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
        self.body()
        if parts == ["__reset"]:
            STATE.clear()
            STATE.update(fresh_state())
            return self.send(200, {"ok": True})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

    def do_PATCH(self):
        self.body()
        return self.send(404, {"error": "not in the probe"})

    def do_DELETE(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        self.body()
        # SessionsService.cancelQueuedTurn: the accepted turn no runner has taken is withdrawn, and the
        # session goes back to awaiting input.
        if parts == ["api", "sessions", "S1", "turns", "t6"] and STATE["held"]:
            STATE["held"] = False
            self.send_response(204)
            self.end_headers()
            return
        return self.send(409, {"statusCode": 409, "code": "TURN_NOT_CANCELLABLE",
                               "message": "This turn has already been taken by the runner."})


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
    print("stub listening on 127.0.0.1:%d (python %s), started %s" % (PORT, sys.version.split()[0], STARTED.isoformat()),
          flush=True)
    server.serve_forever()
