#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API one coordinator conversation reads on the
# iPhone app, for task 34yrjHbz0YEakLPGHqDJZ (docs/mocks/owner-card-ios-text, D1–D3 = A). Adapted from
# docs/evidence/coordinator-delivery-line/probe-harness/stub.py. One coordinator conversation C1 of project P1:
#
#   S1, S2  two escalated items the test sends back to the coordinator with the card's own "Ask the coordinator
#           again" (POST …/return-to-coordinator moves them to withCoordinator), so their cards become settled
#   O1      the open one: an escalated INTEGRATION_ERROR with a long CJK task title, a long check command and a
#           171-line output with ✖ lines — the board's ② and ③
#
# Times are relative to the stub's start; every request is logged; anything not served is a 404. All data is
# made up.
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
STARTED = datetime.now(timezone.utc).replace(second=0, microsecond=0)


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
            "status": "ONLINE", "version": "0.1.261", "maxConcurrent": 8, "activeSessions": 1,
            "lastHeartbeatAt": now(), "capabilities": [],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}],
            "modelCatalog": {"claude": CLAUDE_MODELS}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


def ev(seq, typ, turn, payload, ts):
    return {"seq": seq, "type": typ, "ts": ts, "turnId": turn, "payload": payload}


TITLE = "docs: 排队规则设计稿补「每条结论的来历」一节（情况 · 问题 · 修复）"
COMMAND = ("cd src/apiserver && npx tsc -p tsconfig.test.json && SPECS=$(ls build/*/*.spec.js | grep -v "
           "'\\.pg\\.spec\\.js$') && node --test --test-concurrency=4 --test-reporter=spec $SPECS")


def output():
    """171 lines of a node test run with one failing test — printed where it ran and again
    in the closing summary, as the spec reporter does."""
    lines = ["> orbit-apiserver@0.1.261 test", "> node --test --test-concurrency=4 $SPECS", ""]
    for i in range(1, 154):
        lines.append(f"✔ queue rule {i:03d} keeps its order ({i % 40 + 1}ms)")
        if len(lines) == 80:
            lines += ["\x1b[31m✖ no spec hand-rolls the $queryRaw calling conventions (158ms)\x1b[39m",
                      "  AssertionError [ERR_ASSERTION]: 3 specs hand-roll the calling convention",
                      "      at TestContext.<anonymous> (build/specs/pg-conventions.spec.js:31:12)",
                      "      at async Test.run (node:internal/test_runner/test:1062:7)"]
    lines += ["ℹ tests 152", "ℹ suites 1", "ℹ pass 151", "ℹ fail 1", "ℹ duration_ms 372004", "",
              "✖ failing tests:", "", "test at build/specs/pg-conventions.spec.js:12:3",
              "✖ no spec hand-rolls the $queryRaw calling conventions (158ms)",
              "  AssertionError [ERR_ASSERTION]: 3 specs hand-roll the calling convention"]
    return "\n".join(lines[:171])


OUTPUT = output()


def uid(kind, item_id):
    """A UUID per item and kind (1 task, 2 its session, 3 its landing): the card links only real ids."""
    return "0196f000-0000-7000-800%d-%012x" % (kind, int.from_bytes(item_id.encode(), "big"))


def item(item_id, minutes_waiting, minutes_escalated, task_title, kind="INTEGRATION_ERROR", facts=True):
    row = {"itemId": item_id, "kind": kind, "title": "Integration error",
           "detailLine": "the landing failed its merge check", "assignee": "OWNER", "assigneeReason": "ESCALATED",
           "waitingSince": ago(minutes_waiting), "escalatedAt": ago(minutes_escalated),
           "taskId": uid(1, item_id), "sessionId": uid(2, item_id), "landingSessionId": uid(3, item_id),
           "actions": ["ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "RETRY", "OPEN_LANDING", "CANCEL_TASK"],
           "facts": {"task": {"id": uid(1, item_id), "title": task_title},
                     "targetRef": "project/queue-rules", "files": [], "nothingLanded": True}}
    if facts:
        row["facts"]["check"] = {"name": "MERGE_CHECK", "command": COMMAND, "expectedExitCode": 0, "exitCode": 1,
                                 "timedOut": False, "durationMs": 372000, "outputTail": OUTPUT}
    return row


def fresh_state():
    return {
        "needsYou": [
            item("s1", 23 * 60 + 40, 21 * 60 + 40, "Landing: retry budget per project"),
            item("s2", 23 * 60 + 20, 21 * 60 + 20, "Landing: one slot per runner"),
            item("o1", 23 * 60, 21 * 60, TITLE),
        ],
        "withCoordinator": [],
        "events": [ev(1, "user", "t1", {"text": "Land the queue-rules docs once the check passes."}, ago(26 * 60)),
                   ev(2, "assistant", "t1", {"text": "Landing it now; I will tell you if the check fails.",
                                             "messageId": "m2"}, ago(26 * 60 - 1)),
                   ev(3, "result", "t1", {"subtype": "success", "result": "done"}, ago(26 * 60 - 1))],
    }


STATE = fresh_state()


def session_row():
    last = STATE["events"][1]
    return {"id": "C1", "title": "Queue rules", "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
            "runState": "AWAITING_INPUT", "sessionState": "AWAITING_INPUT", "lifecycleState": "OPEN",
            "filingState": "OPEN", "agentId": "a1", "agent": {"id": "a1", "name": "orbit-develop"},
            "assignedRunnerId": "hpc", "provider": "claude", "model": "claude-opus-5-5", "effort": "high",
            "permissionMode": "default", "taskId": None, "projectId": "P1", "projectTitle": "Queue rules",
            "projectMembership": {"projectId": "P1", "projectTitle": "Queue rules", "projectStatus": "OPEN",
                                  "role": "COORDINATOR"},
            "titleManagedByProject": True, "createdAt": STATE["events"][0]["ts"], "updatedAt": last["ts"],
            "lastTurnAt": last["ts"], "lastAssistantText": last["payload"]["text"], "pendingApprovals": 0,
            "tags": [], "folderId": None, "source": "USER"}


def open_items():
    return {"needsYou": STATE["needsYou"], "withCoordinator": STATE["withCoordinator"], "settled": [],
            "startRequest": None, "doneRequest": None, "closedQuestions": []}


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
            return self.send(200, [session_row()] if view == "open" else [])
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            if parts[2] != "C1":
                return self.send(404, {"error": "not in the probe"})
            p = STATE
            rest = parts[3:]
            if rest == []:
                return self.send(200, session_row())
            if rest == ["events"]:
                return self.stream(p, int(query.get("sinceSeq", ["0"])[0] or 0))
            if rest == ["events", "page"]:
                return self.send(200, {"events": p["events"], "hasMore": False, "before": None, "after": None})
            if rest == ["turns"]:
                return self.send(200, [])
            if rest == ["approvals"]:
                return self.send(200, [])
            return self.send(404, {"error": "not in the probe"})
        if len(parts) >= 3 and parts[:2] == ["api", "projects"] and parts[2] == "P1":
            rest = parts[3:]
            if rest == ["open-items"]:
                return self.send(200, open_items())
            if rest == []:
                return self.send(200, {"id": "P1", "title": "Queue rules", "status": "OPEN",
                                       "coordinatorSessionId": "C1", "exceptionEscalationSeconds": 7200,
                                       "acceptanceCriteriaItems": [], "acceptedGaps": []})
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

    def stream(self, p, sent):
        """Replay what follows `sinceSeq` (SSE `data:` frames, the server's framing), then keep the
        stream alive inside the clients' 45 s watchdog."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        last_ping = time.time()
        try:
            while True:
                for e in p["events"]:
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
        # "Ask the coordinator again": the item goes back to the coordinator with a fresh clock.
        if (len(parts) == 6 and parts[:4] == ["api", "projects", "P1", "open-items"]
                and parts[5] == "return-to-coordinator"):
            moved = [r for r in STATE["needsYou"] if r["itemId"] == parts[4]]
            if not moved:
                return self.send(404, {"statusCode": 404, "message": "no such open item"})
            STATE["needsYou"] = [r for r in STATE["needsYou"] if r["itemId"] != parts[4]]
            back = dict(moved[0], assignee="COORDINATOR", assigneeReason="DEFAULT", waitingSince=now(),
                        escalatedAt=None)
            STATE["withCoordinator"].append(back)
            return self.send(200, {"itemId": parts[4], "assignee": "COORDINATOR", "waitingSince": back["waitingSince"],
                                   "escalateAt": None})
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
