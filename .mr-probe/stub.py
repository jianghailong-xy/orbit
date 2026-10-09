#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the native clients read about a
# managed runner — the capability, the status, one managed workspace ("Default", a1) on the managed
# runner (orbit-managed, r1) and one conversation on it (S1). Every status comes from
# src/shared/src/managed-runner-states.fixture.json, the server state samples all three clients are
# tested against, with the runner and workspace renamed to r1 and a1. The UI test picks the scenario
# with POST /__set {"scenario": ...} before each launch. Every request is logged; anything not served
# is a 404. All data is made up.
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = json.load(open(os.path.join(HERE, "..", "src", "shared", "src", "managed-runner-states.fixture.json")))
STATES = {c["name"]: c["status"] for c in FIXTURE["states"]}
CAPABILITIES = {c["name"]: c for c in FIXTURE["capabilities"]}

ON = "switched on"
# scenario -> (capability, status sample, runner online, the account has a workspace and a runner)
SCENARIOS = {
    "capability-missing": ("a server from before the feature", None, False, True),
    "capability-off": ("switched off", None, False, True),
    "preparing": (ON, "preparing: starting", False, True),
    "waiting-capacity": (ON, "waiting for capacity before the first start", False, True),
    "available": (ON, "available", True, True),
    "sleeping": (ON, "sleeping", False, True),
    "waking": (ON, "waking: a message asked the sleeping runner", False, True),
    "failed-retry": (ON, "failed: retryable", False, True),
    "model-unavailable": (ON, "model unavailable: started without a signed-in runtime", True, True),
    "not-eligible": (ON, "no mapping, account not eligible", False, False),
    "set-up": (ON, "no mapping, offered", False, False),
    "removed": (ON, "removed", False, True),
}
current = {"scenario": "available", "answered": None}


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def status_named(name):
    status = json.loads(json.dumps(STATES[name]))
    if status.get("runnerId"):
        status["runnerId"] = status["runnerPublicId"] = "r1"
    if status.get("workspaceId"):
        status["workspaceId"] = status["workspacePublicId"] = "a1"
    return status


def scenario():
    return SCENARIOS[current["scenario"]]


CLAUDE_CATALOG = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "contextWindow": 1000000,
                   "reasoningLevels": ["low", "medium", "high", "max"]}]


def runner():
    online = scenario()[2]
    # Stamped per request: the clients call a machine offline once its heartbeat is 90 s old.
    return {"id": "r1", "name": "orbit-managed", "displayName": "orbit-managed", "online": online,
            "status": "ONLINE" if online else "OFFLINE", "version": "0.1.228", "maxConcurrent": 4,
            "lastHeartbeatAt": ago(0) if online else ago(120), "capabilities": [],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290",
                         "auth": "yes" if current["scenario"] != "model-unavailable" else "no"}],
            "modelCatalog": {"claude": CLAUDE_CATALOG}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


def agents():
    if not scenario()[3]:
        return []
    return [{"id": "a1", "name": "Default", "provider": "claude", "lastProvider": "claude", "runnerId": "r1",
             "targetRunnerId": "r1", "enabled": True, "enableWorktree": True, "effort": "",
             "workDir": "/var/lib/orbit/home/orbit-repos/default", "appendSystemPrompt": "",
             "workDirExists": True, "workDirIsGit": True}]


ROUNDS = [
    ("Tidy the release notes draft: which paragraphs can be merged?",
     "Paragraphs 2 and 5 both describe the composer change, so they can become one. Paragraph 6 only "
     "says \"fixed some issues\": either drop it or list the fixes.\n\nSuggested order: new features, "
     "improvements, fixes, known issues."),
    ("Use that order and list the fixes",
     "Done. The fixes section is now four items, and the known issues keep a single line at the end. "
     "The notes are in docs/release-notes.md."),
]
TAIL = ROUNDS[-1][1]


def s1_events():
    out, seq = [], 0

    def add(typ, turn, payload, minutes):
        nonlocal seq
        seq += 1
        out.append({"seq": seq, "type": typ, "ts": ago(minutes), "turnId": turn, "payload": payload})

    for i, (ask, answer) in enumerate(ROUNDS):
        turn, minutes = "t%d" % (i + 1), (len(ROUNDS) - i) * 30
        add("user", turn, {"text": ask}, minutes)
        add("assistant", turn, {"text": answer, "messageId": "m%d" % (i + 1)}, minutes)
        add("result", turn, {"subtype": "success", "result": "done"}, minutes)
    return out


def s1():
    return {"id": "S1", "title": "Tidy the release notes", "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
            "runState": "AWAITING_INPUT", "lifecycleState": "OPEN", "agentId": "a1",
            "agent": {"id": "a1", "name": "Default"}, "assignedRunnerId": "r1", "provider": "claude",
            "model": "claude-opus-5-5", "effort": "high", "permissionMode": "default", "taskId": None,
            "projectId": None, "createdAt": ago(70), "updatedAt": ago(30), "lastTurnAt": ago(30),
            "lastAssistantText": TAIL, "pendingApprovals": 0, "tags": [], "folderId": None, "source": "USER",
            "capabilities": {"canSend": True, "canResume": False, "resumeBlockedReason": "NOT_TERMINAL",
                             "canComplete": True, "canRestore": False}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        with open(LOG, "a") as f:
            f.write("%s [%s] %s\n" % (datetime.now().strftime("%H:%M:%S.%f")[:-3], current["scenario"], fmt % args))

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
        if parts == ["api", "auth", "capabilities"]:
            capability = CAPABILITIES[scenario()[0]]
            return self.send(capability["httpStatus"], capability["body"])
        if parts == ["api", "managed-runner"]:
            name = current["answered"] or scenario()[1]
            if name is None:
                # A client with the capability missing or off never asks; say so loudly if one does.
                return self.send(500, {"message": "the probe's client read a status it must not read"})
            return self.send(200, status_named(name))
        if parts == ["api", "agents"]:
            return self.send(200, agents())
        if len(parts) == 3 and parts[:2] == ["api", "agents"]:
            found = [a for a in agents() if a["id"] == parts[2]]
            return self.send(200, found[0]) if found else self.send(404, {"error": "no agent"})
        if parts == ["api", "runners"]:
            return self.send(200, [runner()] if scenario()[3] else [])
        if len(parts) == 3 and parts[:2] == ["api", "runners"]:
            return self.send(200, runner()) if parts[2] == "r1" and scenario()[3] else self.send(404, {"error": "no runner"})
        if parts in (["api", "providers"], ["api", "providers", "mine"], ["api", "providers", "pools"],
                     ["api", "providers", "shared-pools"], ["api", "session-tags"], ["api", "session-folders"],
                     ["api", "task-lists"], ["api", "watches"], ["api", "share-links"]):
            return self.send(200, [])
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            return self.send(200, [s1()] if view == "open" and scenario()[3] else [])
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
            return self.send(404, {"error": "not in the probe"})
        return self.send(404, {"error": "not in the probe"})

    def stream(self, sid, sent):
        """Replay what follows `sinceSeq`, then hold the stream open with a keepalive."""
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
        if parts == ["__set"]:
            asked = json.loads(body or "{}").get("scenario", "available")
            if asked not in SCENARIOS:
                return self.send(400, {"error": "no such scenario", "scenario": asked})
            current.update(scenario=asked, answered=None)
            return self.send(200, {"ok": True, "scenario": asked})
        if parts == ["__reset"]:
            current.update(scenario="available", answered=None)
            return self.send(200, {"ok": True})
        if parts == ["__mark"]:
            with open(LOG, "a") as f:
                f.write("%s [%s] MARK %s\n" % (datetime.now().strftime("%H:%M:%S.%f")[:-3], current["scenario"], body))
            return self.send(200, {"ok": True})
        if parts in (["api", "managed-runner", "retry"], ["api", "managed-runner", "ensure"]):
            with open(LOG, "a") as f:
                f.write("%s [%s] BODY %s %s\n" % (datetime.now().strftime("%H:%M:%S.%f")[:-3], current["scenario"],
                                                   parts[-1], body))
            # As the server answers an accepted write: 202 with the status, which reads REQUESTED now.
            current["answered"] = "preparing: requested"
            return self.send(202, status_named("preparing: requested"))
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
