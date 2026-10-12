#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the native project page reads,
# for one project — "Runner hardening" (P1) — that is an end of five declared crossings:
#
#   X1  MOVE_TASK      PENDING  Coordinator control loop (DONE) -> Runner hardening   "Wire the drain watchdog"
#   X2  MOVE_TASK      PENDING  Runner hardening -> Release train                      "Pin the runner image digest"
#   X3  FILE_TASK      PENDING  Runner hardening -> Docs site                          "Document the drain watchdog"
#   X4  FILE_TASK      APPLIED  Release train -> Runner hardening                      "Retry flaky runner boots"
#   X5  DEPEND_ON_TASK DENIED   Runner hardening -> Release train                      "Wait on the release freeze"
#
# `POST /api/projects/:id/handoffs/:handoffId/decision` answers the way the apiserver does: the
# project in the path must be an end of the crossing, the echoed `acknowledgedCrossingKey` must be
# the row's (APPROVAL_TARGET_MISMATCH otherwise), only a PENDING row takes an answer, and a yes to a
# MOVE_TASK IS the move — the row is spent (APPLIED) and the task joins the target project, which
# the next read of P1 shows. X2's task is being landed, so confirming it is refused with
# MOVE_TASK_LANDING_IN_FLIGHT and nothing changes. Every request is logged with its body; anything
# not served is a 404. All data is made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


DAY = 24 * 60
USER = {"id": "u1", "email": "hailong@example.com", "name": "Hailong", "role": "MEMBER",
        "createdAt": ago(90 * DAY), "preferences": {"theme": "system"}}
RUNNER = {"id": "r1", "name": "hpc", "displayName": "hpc", "online": True, "status": "ONLINE",
          "version": "0.1.219", "maxConcurrent": 4, "lastHeartbeatAt": ago(0), "capabilities": [],
          "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}]}
AGENT = {"id": "a1", "name": "orbit-develop", "provider": "claude", "lastProvider": "claude", "runnerId": "r1",
         "enabled": True, "enableWorktree": True, "effort": "", "workDir": "/srv/orbit",
         "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}

TITLES = {"P0": "Coordinator control loop", "P1": "Runner hardening", "P2": "Release train", "P3": "Docs site"}
STATUSES = {"P0": "DONE", "P1": "OPEN", "P2": "OPEN", "P3": "OPEN"}

KEY = {"X1": "8f3c1d2e" * 8, "X2": "51ab9e07" * 8, "X3": "c40de1f2" * 8, "X4": "0d9e8a71" * 8,
       "X5": "77b2c3d4" * 8}


def summary(pid, done, total):
    return {"id": pid, "publicId": pid, "title": TITLES[pid], "status": STATUSES[pid],
            "goal": "Probe goal for " + TITLES[pid] + ".", "createdAt": ago(20 * DAY), "updatedAt": ago(30),
            "lastActivityAt": ago(30), "_count": {"tasks": total}, "startedAt": ago(19 * DAY),
            "taskCounts": {"done": done, "failed": 0, "total": total}}


def task(tid, title, status, level=0):
    return {"id": tid, "publicId": tid, "title": title, "status": status, "parentTaskId": None, "childCount": 0,
            "unmetCount": 0, "blocksCount": 0, "topoLevel": level, "dependencyState": "READY",
            "workState": "IDLE", "completionPolicy": "MANUAL", "autoRunWhenReady": True}


def criterion(cid, ordinal, text):
    return {"id": cid, "publicId": cid, "key": cid, "ordinal": ordinal, "text": text, "satisfied": False,
            "unmet": [], "landing": "UNKNOWN", "verificationMethod": "A pg spec and a screenshot."}


STATE = {}


def reset():
    STATE.clear()
    STATE.update(
        rows={
            "X1": dict(kind="MOVE_TASK", frm="P0", to="P1", subject="T9", state="PENDING",
                       title="Watchdog for wedged drains", reason="the watchdog belongs to the runner goal",
                       requestedAt=ago(3 * 60), requested=("34bCrit1", "A wedged drain restarts within a minute."),
                       withdrawn=None),
            "X2": dict(kind="MOVE_TASK", frm="P1", to="P2", subject="T4", state="PENDING",
                       title="Pin the runner image digest", reason="the release train owns image pins",
                       requestedAt=ago(2 * 60), requested=("34bCrit7", "Every release names its image digest."),
                       withdrawn=("34bCrit2", "Runner images are reproducible.")),
            "X3": dict(kind="FILE_TASK", frm="P1", to="P3", subject=None, state="PENDING",
                       title="Document the drain watchdog", reason="operators need the runbook",
                       requestedAt=ago(60), requested=None, withdrawn=None),
            "X4": dict(kind="FILE_TASK", frm="P2", to="P1", subject=None, state="APPLIED",
                       title="Retry flaky runner boots", reason=None, requestedAt=ago(2 * DAY),
                       requested=None, withdrawn=None, decidedAt=ago(2 * DAY - 30)),
            "X5": dict(kind="DEPEND_ON_TASK", frm="P1", to="P2", subject="T7", state="DENIED",
                       title="Wait on the release freeze", reason=None, requestedAt=ago(DAY),
                       requested=None, withdrawn=None, decidedAt=ago(DAY - 20)),
        },
        tasks={
            "P1": [task("T1", "Restart wedged drains", "DONE"), task("T2", "Bound the drain queue", "OPEN"),
                   task("T4", "Pin the runner image digest", "OPEN", 1)],
        },
        subjects={"T9": "Wire the drain watchdog", "T4": "Pin the runner image digest", "T7": "Freeze window"},
        decisions=[],
    )


reset()


def row_json(hid):
    r = STATE["rows"][hid]
    subject = r["subject"]
    out = {
        "id": hid, "publicId": hid, "ownerId": "u1", "ownerPublicId": "u1",
        "fromProjectId": r["frm"], "fromProjectPublicId": r["frm"],
        "toProjectId": r["to"], "toProjectPublicId": r["to"],
        "kind": r["kind"], "subjectTaskId": subject, "payloadDigest": "d" * 64,
        "crossingKey": KEY[hid], "state": r["state"], "title": r["title"], "reason": r["reason"],
        "requestedBySessionId": "S1", "requestedBySessionPublicId": "S1", "requestedAt": r["requestedAt"],
        "decidedBy": "USER" if r.get("decidedAt") else None, "decidedByUserId": None,
        "decidedAt": r.get("decidedAt"), "expiresAt": None, "appliedTaskId": None, "appliedAt": None,
        "requestedCriterionDefinitionId": r["requested"][0] if r["requested"] else None,
        "fromProject": {"title": TITLES[r["frm"]], "status": STATUSES[r["frm"]]},
        "toProject": {"title": TITLES[r["to"]], "status": STATUSES[r["to"]]},
        "subjectTask": {"id": subject, "publicId": subject, "title": STATE["subjects"][subject]} if subject else None,
        "requestedBySession": {"id": "S1", "publicId": "S1", "title": "Coordinate " + TITLES[r["to"]]},
        "requestedCriterion": {"key": r["requested"][0], "text": r["requested"][1]} if r["requested"] else None,
        "withdrawnCriterion": {"key": r["withdrawn"][0], "text": r["withdrawn"][1]} if r["withdrawn"] else None,
    }
    if subject:
        out["subjectTaskPublicId"] = subject
    return out


def document(pid):
    tasks = STATE["tasks"].get(pid, [])
    by_status = {}
    for t in tasks:
        by_status[t["status"]] = by_status.get(t["status"], 0) + 1
    return {"id": pid, "publicId": pid, "title": TITLES[pid], "status": STATUSES[pid],
            "goal": "Runners stay healthy on their own: a wedged drain restarts, images are pinned, and "
                    "every failure leaves a runbook entry.",
            "instructions": "Probe instructions.", "createdAt": ago(20 * DAY), "updatedAt": ago(30),
            "coordinatorEnabled": True, "configRevision": "1", "coordinatorSessionId": None,
            "_count": {"tasks": len(tasks)}, "tasksByStatus": by_status,
            "acceptanceCriteriaItems": [criterion("34bCrit1", 1, "A wedged drain restarts within a minute."),
                                        criterion("34bCrit2", 2, "Runner images are reproducible.")],
            "blockers": {"open": [], "resolved": [], "resolvedCount": 0},
            "startedAt": ago(19 * DAY), "pausedAt": None, "maxConcurrentTasks": 3}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    def note(self, line):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S"), line))

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
            return raw.decode(), json.loads(raw.decode() or "{}")
        except ValueError:
            return raw.decode(errors="replace"), {}

    def do_GET(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if parts == ["__log"]:
            try:
                data = open(LOG, "rb").read()
            except OSError:
                data = b""
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if parts == ["api", "events"]:
            return self.stream()
        if parts == ["api", "users", "me"]:
            return self.send(200, USER)
        if parts == ["api", "agents"]:
            return self.send(200, [AGENT])
        if parts == ["api", "agents", "a1"]:
            return self.send(200, AGENT)
        if parts == ["api", "runners"]:
            return self.send(200, [RUNNER])
        if parts == ["api", "runners", "r1"]:
            return self.send(200, RUNNER)
        if parts in (["api", "sessions"], ["api", "providers"], ["api", "providers", "mine"],
                     ["api", "providers", "pools"], ["api", "providers", "shared-pools"], ["api", "session-tags"],
                     ["api", "session-folders"], ["api", "task-lists"], ["api", "watches"]):
            return self.send(200, [])
        if parts == ["api", "projects"]:
            return self.send(200, [summary("P1", 1, len(STATE["tasks"]["P1"])), summary("P2", 4, 9),
                                   summary("P3", 0, 2), summary("P0", 6, 6)])
        if parts == ["api", "projects", "sidebar"]:
            return self.send(200, [summary("P1", 1, len(STATE["tasks"]["P1"])), summary("P2", 4, 9),
                                   summary("P3", 0, 2)])
        if len(parts) >= 3 and parts[:2] == ["api", "projects"] and parts[2] in TITLES:
            pid, rest = parts[2], parts[3:]
            if rest == []:
                return self.send(200, document(pid))
            if rest == ["tasks", "page"]:
                return self.send(200, {"items": STATE["tasks"].get(pid, []), "nextCursor": None})
            if rest == ["handoffs"]:
                rows = [row_json(h) for h, r in STATE["rows"].items() if pid in (r["frm"], r["to"])]
                rows.sort(key=lambda r: r["requestedAt"], reverse=True)
                return self.send(200, rows)
            if rest == ["open-items"]:
                return self.send(200, {"needsYou": [], "withCoordinator": []})
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})

    def stream(self):
        """A control stream with nothing to say: keepalives inside the clients' watchdog."""
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

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        raw, body = self.body()
        if parts == ["__reset"]:
            reset()
            return self.send(200, {"ok": True})
        self.note("BODY %s %s" % (self.path, raw))
        if len(parts) == 6 and parts[:2] == ["api", "projects"] and parts[3] == "handoffs" and parts[5] == "decision":
            return self.decide(parts[2], parts[4], body)
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    def decide(self, pid, hid, body):
        r = STATE["rows"].get(hid)
        if r is None:
            return self.send(404, {"statusCode": 404, "message": "handoff approval not found"})
        if pid not in (r["frm"], r["to"]):
            return self.send(400, {"statusCode": 400, "message": "that crossing does not touch this project"})
        decision = body.get("decision")
        if decision not in ("APPROVE", "DENY"):
            return self.send(400, {"statusCode": 400, "message": ["decision must be one of the following values: APPROVE, DENY"]})
        if "acknowledgedCrossingKey" in body and body["acknowledgedCrossingKey"] != KEY[hid]:
            return self.send(409, {"statusCode": 409, "error": "Conflict", "code": "APPROVAL_TARGET_MISMATCH",
                                   "message": "that answer names a different crossing than the one at this id — "
                                              "re-read the queue and answer what it says now"})
        if r["state"] != "PENDING":
            return self.send(409, {"statusCode": 409, "error": "Conflict",
                                   "message": "handoff approval %s is %s and cannot be %sD" % (hid, r["state"], decision)})
        if decision == "APPROVE" and hid == "X2":
            return self.send(409, {"statusCode": 409, "error": "Conflict", "code": "MOVE_TASK_LANDING_IN_FLIGHT",
                                   "requiredAction": "WAIT_FOR_THE_LANDING", "taskId": "T4", "jobId": "J4",
                                   "handoffId": hid, "handoffState": "PENDING",
                                   "message": "task T4 is being landed (LAND_TASK J4 is RUNNING), and a landing belongs "
                                              "to the project the task is in — nothing was written and the request is "
                                              "still waiting. Confirm it again once that job has ended, or deny it."})
        STATE["decisions"].append({"handoffId": hid, "decision": decision, "body": body})
        r["decidedAt"] = ago(0)
        if decision == "DENY":
            r["state"] = "DENIED"
        elif r["kind"] == "MOVE_TASK":
            # Confirming is the move: the task joins the target project and the request is spent.
            r["state"] = "APPLIED"
            moved = task(r["subject"], STATE["subjects"][r["subject"]], "OPEN")
            for tasks in STATE["tasks"].values():
                tasks[:] = [t for t in tasks if t["id"] != r["subject"]]
            STATE["tasks"].setdefault(r["to"], []).append(moved)
        else:
            r["state"] = "APPROVED"
        return self.send(201, {"row": {k: v for k, v in row_json(hid).items()
                                       if k not in ("fromProject", "toProject", "subjectTask", "requestedBySession",
                                                    "requestedCriterion", "withdrawnCriterion")},
                               "filed": False})

    def refuse(self):
        self.body()
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    do_PATCH = refuse
    do_PUT = refuse
    do_DELETE = refuse


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
