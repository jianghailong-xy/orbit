#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API a project conversation reads on the iPhone
# and Mac apps, for task 34pWyIeaPCCHGAznSK97W. Adapted from
# docs/evidence/coordinator-delivery-line/probe-harness/stub.py. Two conversations of one project:
#
#   R1  a task's run that asked to drop a criterion, then the owner's answer, REJECT, told to that run: the
#       `coordinatorDelivery` card says `toCoordinator: false`, because the project's coordinator pointer names C2
#   C2  the project's coordinator, told the owner's APPROVE of its own proposal: `toCoordinator: true`, as before
#
# Each row is shaped as the server's session list shapes it: `projectId`/`projectTitle` name the project a session
# COORDINATES (`project.coordinator_session_id`), so a task's run has none, and its project comes through
# `projectMembership` (role TASK) and its task (`taskId`, `taskTitle`).
#
# The turns' words (messages.json) are what the apiserver's own `criteriaDecisionReplyMessage` wrote; the cards are
# what `readCoordinatorDeliveryCards` reads for each conversation. Times are minutes before the stub started, and the
# app runs at TZ=Asia/Shanghai. Every request is logged; anything not served is a 404. All data is made up.
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
WORDS = json.load(open(os.path.join(HERE, "messages.json"), encoding="utf-8"))
STARTED = datetime.now(timezone.utc).replace(second=0, microsecond=0)
PROJECT = "P1"
PROJECT_TITLE = "Runner link v1: runner ↔ control plane over WebSocket"


def ago(minutes, seconds=0):
    """An instant `minutes` before the stub started, the way the server spells one."""
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
            "status": "ONLINE", "version": "0.1.242", "maxConcurrent": 8, "activeSessions": 1,
            "lastHeartbeatAt": now(), "capabilities": [],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}],
            "modelCatalog": {"claude": CLAUDE_MODELS}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


def card(kind, delivered, to_coordinator):
    """What `readCoordinatorDeliveryCards` records beside the reply turn."""
    return {"kind": kind, "task": None, "revision": None, "count": None, "deliveredAt": delivered,
            "toCoordinator": to_coordinator}


def ev(seq, typ, turn, payload, ts):
    return {"seq": seq, "type": typ, "ts": ts, "turnId": turn, "payload": payload}


def exchange(seq, turn_id, ask, ask_at, reply, reply_at, ask_payload=None):
    return [ev(seq, "user", turn_id, {"text": ask, **(ask_payload or {})}, ask_at),
            ev(seq + 1, "assistant", turn_id, {"text": reply, "messageId": f"m{seq}"}, reply_at),
            ev(seq + 2, "result", turn_id, {"subtype": "success", "result": "done"}, reply_at)]


REJECTED_AT = ago(24)
APPROVED_AT = ago(34)


def fresh_state():
    sessions = {
        "R1": {"title": "Task: Switch the runner link to WebSocket", "role": "TASK", "taskId": "34pXRunTaskSwitchLink1",
               "taskTitle": "Switch the runner link to WebSocket", "coordinates": False, "status": "AWAITING_INPUT",
               "events": exchange(1, "t1", "Switch the runner link to WebSocket, and prove it with the link test.", ago(60),
                                  "Criterion 2 asks for the link test on the C2b machine, which is not up. I asked "
                                  "the account owner to drop it (proposal 34pX0YF3mJmoTBvNxc8Kt); the rest of the "
                                  "work goes on while they decide.", ago(52))
                         + exchange(4, "t2", WORDS["rejected"], REJECTED_AT,
                                    "Understood: criterion 2 stays. I will run the link test on C2b once it is up, "
                                    "and keep the rest of the switch going until then.", ago(23),
                                    {"coordinatorDelivery": card("CRITERIA_REJECTED", REJECTED_AT, False)})},
        "C2": {"title": PROJECT_TITLE, "role": "COORDINATOR", "taskId": None, "taskTitle": None, "coordinates": True,
               "status": "AWAITING_INPUT",
               "events": exchange(1, "t1", "Criterion 3 should name the WebSocket close codes we keep.", ago(45),
                                  "I asked to change criterion 3 to name them (proposal 34pX0YF3mJmoTBvNxc8Ku); it "
                                  "needs your approval, because it changes what is measured.", ago(44))
                         + exchange(4, "t2", WORDS["approved"], APPROVED_AT,
                                    "Criterion 3 is now revision 2. I will re-read the criteria and hold the tasks "
                                    "that serve it to the new wording.", ago(33),
                                    {"coordinatorDelivery": card("CRITERIA_APPROVED", APPROVED_AT, True)})},
    }
    return {"sessions": sessions}


STATE = fresh_state()


def session_row(sid, s):
    said = [e for e in s["events"] if e["type"] == "assistant"]
    last = said[-1] if said else s["events"][-1]
    status = s["status"]
    return {"id": sid, "title": s["title"], "status": status, "runStatus": status,
            "runState": status, "sessionState": status, "lifecycleState": "OPEN",
            "filingState": "OPEN", "agentId": "a1", "agent": {"id": "a1", "name": "orbit-develop"},
            "assignedRunnerId": "hpc", "provider": "claude", "model": "claude-opus-5-5", "effort": "high",
            "permissionMode": "default", "taskId": s["taskId"], "taskTitle": s["taskTitle"],
            "projectId": PROJECT if s["coordinates"] else None,
            "projectTitle": PROJECT_TITLE if s["coordinates"] else None,
            "projectMembership": {"projectId": PROJECT, "projectTitle": PROJECT_TITLE, "projectStatus": "OPEN",
                                  "role": s["role"]},
            "titleManagedByProject": s["coordinates"], "createdAt": s["events"][0]["ts"], "updatedAt": last["ts"],
            "lastTurnAt": last["ts"], "lastAssistantText": last["payload"].get("text", ""), "pendingApprovals": 0,
            "tags": [], "folderId": None, "source": "USER"}


def open_items():
    return {"needsYou": [], "withCoordinator": [], "settled": [], "startRequest": None,
            "doneRequest": None, "closedQuestions": []}


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
                     ["api", "task-lists"], ["api", "watches"], ["api", "share-links"]):
            return self.send(200, [])
        if parts == ["api", "projects"]:
            return self.send(200, [])
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            rows = [session_row(sid, s) for sid, s in STATE["sessions"].items()]
            return self.send(200, rows if view == "open" else [])
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            s = STATE["sessions"].get(parts[2])
            if s is None:
                return self.send(404, {"error": "not in the probe"})
            rest = parts[3:]
            if rest == []:
                return self.send(200, session_row(parts[2], s))
            if rest == ["events"]:
                return self.stream(s, int(query.get("sinceSeq", ["0"])[0] or 0))
            if rest == ["events", "page"]:
                return self.send(200, {"events": s["events"], "hasMore": False, "before": None, "after": None})
            if rest == ["turns"]:
                return self.send(200, [])
            if rest == ["approvals"]:
                return self.send(200, [])
            return self.send(404, {"error": "not in the probe"})
        if len(parts) >= 3 and parts[:2] == ["api", "projects"] and parts[2] == PROJECT:
            rest = parts[3:]
            if rest == ["open-items"]:
                return self.send(200, open_items())
            if rest == ["promotions", "current"]:
                return self.send(200, None)
            if rest == ["promotions", "merged"]:
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
        """Replay what follows `sinceSeq` (SSE `data:` frames, the server's framing), then keep the
        stream alive inside the clients' 45 s watchdog."""
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
        self.body()
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
    print("stub listening on 127.0.0.1:%d (python %s), started %s" % (PORT, sys.version.split()[0], STARTED.isoformat()),
          flush=True)
    server.serve_forever()
