#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API a coordinator conversation reads on the
# iPhone and Mac apps, for task 34pVGFQvGcjxSppunCWTK (docs/mocks/coordinator-delivery-line/). Adapted from
# docs/evidence/answer-delivery-one-line/probe-harness/stub.py. Four coordinator conversations, one project each:
#
#   C1 / P1  the owner's question and the coordinator's answer; then a fact Orbit told the coordinator (revision 1 of
#            a task's completion evidence, carrying the `coordinatorDelivery` card) and the coordinator's long reply,
#            long enough that the line has scrolled past the top when the conversation opens at its end
#   C2 / P2  a task that can start now, told to a coordinator whose run never confirmed it (the runner's
#            `user_delivery` failed report): the line says so, and offers nothing to put back in the composer
#   C3 / P3  a fact still waiting on the coordinator's queue (GET /sessions/C3/turns?view=active) behind a running turn
#   C4 / P4  C1's delivery with a short reply, so the whole line fits a Mac window with nothing to scroll
#
# The turns' words (messages.json) are what the apiserver's own `buildCoordinatorDeliveryMessage` wrote for these
# facts; the cards are what `readCoordinatorDeliveryCards` reads. Times are minutes before the stub started, and
# the app runs at TZ=Asia/Shanghai. Every request is logged; anything not served is a 404. All data is made up.
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
            "status": "ONLINE", "version": "0.1.241", "maxConcurrent": 8, "activeSessions": 1,
            "lastHeartbeatAt": now(), "capabilities": [],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}],
            "modelCatalog": {"claude": CLAUDE_MODELS}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


EVIDENCE_TITLE = "Wiki model queue: one claim can take more requests than the concurrency room"
READY_TITLE = "Switch the runner link to WebSocket"


def card(kind, delivered, task=None, revision=None, count=None):
    """What `readCoordinatorDeliveryCards` records beside the turn."""
    return {"kind": kind, "task": task, "revision": revision, "count": count, "deliveredAt": delivered}


def ev(seq, typ, turn, payload, ts):
    return {"seq": seq, "type": typ, "ts": ts, "turnId": turn, "payload": payload}


def exchange(seq, turn_id, ask, ask_at, reply, reply_at, ask_payload=None):
    return [ev(seq, "user", turn_id, {"text": ask, **(ask_payload or {})}, ask_at),
            ev(seq + 1, "assistant", turn_id, {"text": reply, "messageId": f"m{seq}"}, reply_at),
            ev(seq + 2, "result", turn_id, {"subtype": "success", "result": "done"}, reply_at)]


LONG_REPLY = "\n".join([
    "I have read revision 1 of the evidence. Checked point by point:",
    "",
    "1. The new pg spec makes `claimWikiModelRequests` take the rescanning plan: EXPLAIN ANALYZE shows the subquery "
    "with loops > 1, and before the fix one claim took more than the room.",
    "2. After the fix the candidate rows are read once, and the same planner settings never take more than the room.",
    "3. The `maxInFlightPerJob` case passes: no job has more requests in flight than its limit.",
    "4. `wiki-model-queue.pg.spec.ts` passes in full.",
    "5. `reclaimExpiredWikiModelRequests` and `failWikiModelRequestsPastWaitLimit` have no limit on concurrency, and "
    "the evidence says why that is safe.",
    "6. The statements of the same shape in `wiki-jobs.ts` and `wiki-repo-ops.ts` are listed one by one; the ones that "
    "cap concurrency are fixed.",
    "7. The `db-write-inventory` notes match the changed statements.",
    "8. The apiserver tests pass, and the full pg spec run's differences are written into the gaps.",
    "9. The project branch was merged before delivery, with no conflict against origin/main.",
    "10. All 16 cited records resolve.",
    "",
    "What the evidence does not cover, and why that does not hold the decision back:",
    "",
    "- The production database was not touched: the pg spec runs on an isolated cluster, which is the criterion's "
    "own wording.",
    "- The watch module's two statements are written the same way, but they belong to another task; I will file it "
    "once this one is decided.",
    "- The planner settings in production can differ from the spec's; the fix does not depend on them, because the "
    "candidate rows are now read once whatever plan is chosen.",
    "",
    "The evidence is enough to prove the criterion: CONFIRM, and the task becomes DONE.",
    "",
    "What I will do next, in order:",
    "",
    "1. File the watch module's two statements as their own task, with the same pg spec shape as this one.",
    "2. Ask the runner owner for the C2b machine, and start the link test there once it is up.",
    "3. Land the three tasks that serve criterion 4, then merge the project branch into main.",
    "4. Record the merge with a receipt, so the criterion reads as landed.",
    "5. Re-read the derived Done once the receipt is in, and ask you to confirm the criteria if nothing is held back.",
    "",
    "Next up is C2b, which is still waiting for you to start the machine. I will carry on with it once it is up.",
])

EV_DELIVERED = ago(38)
READY_DELIVERED = ago(30)
UNLANDED_DELIVERED = ago(6)


def fresh_state():
    evidence_card = card("EVIDENCE_SUBMITTED", EV_DELIVERED, {"id": "34nmQgDgyywHNIUtjb9TD", "title": EVIDENCE_TITLE}, 1)
    projects = {
        "P1": {"title": "Runner link v1", "session": "C1", "status": "AWAITING_INPUT", "queued": [],
               "events": exchange(1, "t1", "How is the review of the wiki model queue going?", ago(70),
                                  "The watch module's `watch-delivery.service.ts` and `watch-evaluator.service.ts` "
                                  "are written the same way. Their LIMIT caps no concurrency, so it is not urgent, "
                                  "but past it the work can outlast the 60-second lease. That is outside this task's "
                                  "scope: once the evidence is decided I will file it as its own task.\n\nThe full pg "
                                  "run is going; I will decide once the evidence is in.", ago(62))
                         + exchange(4, "t2", WORDS["evidence"], EV_DELIVERED, LONG_REPLY, ago(37),
                                    {"coordinatorDelivery": evidence_card})},
        "P2": {"title": "Runner link v1: dispatch", "session": "C2", "status": "AWAITING_INPUT", "queued": [],
               "events": exchange(1, "t1", "Start whatever is ready once its prerequisites land.", ago(45),
                                  "I will. Nothing is ready yet: the prerequisites are still landing.", ago(44))
                         + [ev(4, "user", "t2", {"text": WORDS["ready"],
                                                 "coordinatorDelivery": card("DEPENDENT_READY", READY_DELIVERED,
                                                                             {"id": "34pVVKDohkOa6db1Z4vFF",
                                                                              "title": READY_TITLE})},
                               READY_DELIVERED),
                            ev(5, "user_delivery", "t2", {"turnId": "t2", "delivery": "failed",
                                                          "reason": "the run ended before the engine read it"},
                               ago(29))]},
        "P3": {"title": "Runner link v1: landing", "session": "C3", "status": "RUNNING",
               "queued": [{"turnId": "tq1", "kind": "message", "placement": "queued", "content": WORDS["unlanded"],
                           "createdAt": UNLANDED_DELIVERED, "attachments": [],
                           "coordinatorDelivery": card("CRITERION_UNLANDED", UNLANDED_DELIVERED, count=3),
                           "authoredByOrbit": True}],
               "events": [ev(1, "user", "t1", {"text": "Land the three tasks that serve criterion 4, then merge."},
                             ago(12)),
                          ev(2, "assistant", "t1", {"text": "Landing them now. The first merge check is running.",
                                                    "messageId": "m2"}, ago(11))]},
        "P4": {"title": "Runner link v1 (Mac)", "session": "C4", "status": "AWAITING_INPUT", "queued": [],
               "events": exchange(1, "t1", "How is the review of the wiki model queue going?", ago(70),
                                  "The full pg run is going; I will decide once the evidence is in.", ago(62))
                         + exchange(4, "t2", WORDS["evidence"], EV_DELIVERED,
                                    "Revision 1 proves the criterion: CONFIRM, and the task becomes DONE.", ago(37),
                                    {"coordinatorDelivery": evidence_card})},
    }
    return {"projects": projects}


STATE = fresh_state()


def project_of(session):
    for pid, p in STATE["projects"].items():
        if p["session"] == session:
            return pid, p
    return None, None


def session_row(pid, p):
    said = [e for e in p["events"] if e["type"] == "assistant"]
    last = said[-1] if said else p["events"][-1]
    status = p["status"]
    return {"id": p["session"], "title": p["title"], "status": status, "runStatus": status,
            "runState": status, "sessionState": status, "lifecycleState": "OPEN",
            "filingState": "OPEN", "agentId": "a1", "agent": {"id": "a1", "name": "orbit-develop"},
            "assignedRunnerId": "hpc", "provider": "claude", "model": "claude-opus-5-5", "effort": "high",
            "permissionMode": "default", "taskId": None, "projectId": pid, "projectTitle": p["title"],
            "projectMembership": {"projectId": pid, "projectTitle": p["title"], "projectStatus": "OPEN",
                                  "role": "COORDINATOR"},
            "titleManagedByProject": True, "createdAt": p["events"][0]["ts"], "updatedAt": last["ts"],
            "lastTurnAt": last["ts"], "lastAssistantText": last["payload"].get("text", ""), "pendingApprovals": 0,
            "tags": [], "folderId": None, "source": "USER"}


def open_items(p):
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
            rows = [session_row(pid, p) for pid, p in STATE["projects"].items()]
            return self.send(200, rows if view == "open" else [])
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            pid, p = project_of(parts[2])
            if p is None:
                return self.send(404, {"error": "not in the probe"})
            rest = parts[3:]
            if rest == []:
                return self.send(200, session_row(pid, p))
            if rest == ["events"]:
                return self.stream(p, int(query.get("sinceSeq", ["0"])[0] or 0))
            if rest == ["events", "page"]:
                return self.send(200, {"events": p["events"], "hasMore": False, "before": None, "after": None})
            if rest == ["turns"]:
                return self.send(200, p["queued"])
            if rest == ["approvals"]:
                return self.send(200, [])
            return self.send(404, {"error": "not in the probe"})
        if len(parts) >= 3 and parts[:2] == ["api", "projects"] and parts[2] in STATE["projects"]:
            p = STATE["projects"][parts[2]]
            rest = parts[3:]
            if rest == ["open-items"]:
                return self.send(200, open_items(p))
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
