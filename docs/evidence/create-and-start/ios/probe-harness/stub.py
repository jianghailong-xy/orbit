#!/usr/bin/env python3
# Evidence probe (task 34o9etf0IZ0t5oPbYGDz9; never merged, see ../README.md): the slice of the Orbit API
# a native conversation reads, for one conversation, C1, whose agent filed two single tasks and waits on
# both cards (approval toolName `orbit_task_create`). Each card's input is the body the runner will send
# plus the server's forecast for its one task (`input.preview`, the batch card's shape, computed as
# `TasksService.previewBatch` does) and `acceptsStartAfterCreate: true`, the server's word that the
# runner which filed it acts on Create and start:
#
#   ap1  "Fix the date column in the CSV export", filed with startNow, so its runAt is already due: the
#        forecast says it starts running within the minute (startingNow 1), and the card has one yes
#   ap2  "Write the 2.5 release notes", in no project and with no prerequisites: nothing would start it
#        (needsManualStart 1), so Create and start sits beside Create it
#
# `POST /api/sessions/C1/approvals/:id/decision` records what it was sent and takes the card off the
# pending list, as the control plane does. `POST /__reset` puts both cards back; `GET /__log` is the
# request log, each written body as JSON with sorted keys (BODY) and as the bytes that came (RAW).
# Anything not served is a 404. All data is made up.
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
USER = {"id": "u1", "email": "owner@example.com", "name": "Owner", "role": "MEMBER",
        "createdAt": ago(90 * DAY), "preferences": {"theme": "system"}}
RUNNER = {"id": "r1", "name": "hpc", "displayName": "hpc", "online": True, "status": "ONLINE",
          "version": "0.1.230", "maxConcurrent": 4, "lastHeartbeatAt": ago(0), "capabilities": [],
          "engines": [{"engine": "claude", "installed": True, "version": "2.1.312", "auth": "yes"}]}
AGENT = {"id": "a1", "name": "billing-api", "provider": "claude", "lastProvider": "claude", "runnerId": "r1",
         "enabled": True, "enableWorktree": True, "effort": "", "workDir": "/srv/billing-api",
         "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}

FILED = 6  # minutes ago: when the agent called task_create, twice

# What the agent sent (the tool calls' own input), and what the runner put on each card: the create's
# body, with startNow turned into a due runAt and the assignee defaulted to the calling agent.
FIX_ARGS = {
    "title": "Fix the date column in the CSV export",
    "description": "The CSV export writes each entry's date in the server's time zone, so an account in "
                   "UTC+8 sees entries made after 16:00 UTC under the next day.\n\n"
                   "- Format the date in the account's own time zone (`account.timeZone`).\n"
                   "- Cover an entry on each side of midnight in the export spec.",
    "acceptanceCriteria": "An export for an account in UTC+8 shows every entry under its local date, and "
                          "the export spec covers entries on both sides of midnight.",
    "completionCriterion": "EXECUTABLE",
    "acceptanceCommand": "npm test -w billing -- export",
    "startNow": True,
}
NOTES_ARGS = {
    "title": "Write the 2.5 release notes",
    "description": "Collect the changes merged since 2.4 from the changelog and write the 2.5 release "
                   "notes for the docs site: what changed, what to do on upgrade, and the CSV date fix.",
    "acceptanceCriteria": "The 2.5 notes are on the docs site, linked from the changelog, and name every "
                          "change merged since 2.4.",
    "completionCriterion": "EVIDENCE_JUDGMENT",
}


def body(args, run_at=None):
    out = {k: v for k, v in args.items() if k != "startNow"}
    if run_at:
        out["runAt"] = run_at
    out["assigneeId"] = "a1"
    return out


def preview(title, **counts):
    """`previewBatch` for a batch of one: every count named, the one that applies at 1."""
    p = {"taskCount": 1, "startingNow": 0, "blocked": 0, "needsManualStart": 0, "notDispatchable": 0,
         "scheduled": 0, "awaitingProjectStart": 0, "internalEdges": 0, "externalEdges": 0, "lists": [],
         "assignees": [{"id": "a1", "name": "billing-api", "hasRunner": True}],
         "tasks": [{"title": title, "listId": None, "dependsOnRefs": [], "dependsOnTaskIds": [], "ref": None}],
         "titlesTruncated": 0}
    p.update(counts)
    return p


def card(aid, tool_use, args, run_at, **counts):
    # acceptsStartAfterCreate is what the server writes beside the forecast when the runner that filed
    # the card acts on the choice. Both cards carry it, so ap1 goes without the button by its forecast.
    return {"id": aid, "sessionId": "C1", "toolName": "orbit_task_create", "toolUseId": tool_use,
            "status": "PENDING", "createdAt": ago(FILED),
            "input": dict(body(args, run_at), preview=preview(args["title"], **counts),
                          acceptsStartAfterCreate=True)}


def cards():
    return [card("ap1", "toolu_fix", FIX_ARGS, ago(FILED), startingNow=1),
            card("ap2", "toolu_notes", NOTES_ARGS, None, needsManualStart=1)]


def transcript(lines):
    return [{"seq": i + 1, "type": typ, "ts": ago(minutes), "turnId": "t1", "payload": payload}
            for i, (typ, payload, minutes) in enumerate(lines)]


# The turn is still running: both calls wait on their cards, so neither has a result yet.
EVENTS = transcript([
    ("user", {"text": "Two follow-ups from the export review: get the CSV date column fixed now, and file "
                      "the 2.5 release notes as a task."}, FILED + 1),
    ("assistant", {"text": "Filing both: the date-column fix with startNow, so it runs as soon as you say yes, "
                           "and the release notes as a task of its own.", "messageId": "m1"}, FILED),
    ("tool_use", {"id": "toolu_fix", "name": "mcp__orbit__task_create", "input": FIX_ARGS}, FILED),
    ("tool_use", {"id": "toolu_notes", "name": "mcp__orbit__task_create", "input": NOTES_ARGS}, FILED),
])

STATE = {}


def reset():
    STATE.clear()
    STATE.update(pending=cards())


reset()


def session():
    return {"id": "C1", "title": "Follow-ups from the export review", "status": "RUNNING",
            "runStatus": "RUNNING", "runState": "RUNNING", "lifecycleState": "OPEN", "agentId": "a1",
            "agent": {"id": "a1", "name": "billing-api"}, "assignedRunnerId": "r1", "provider": "claude",
            "model": "claude-opus-5-5", "effort": "max", "permissionMode": "default", "taskId": None,
            "createdAt": ago(40), "updatedAt": EVENTS[-1]["ts"], "lastTurnAt": EVENTS[-1]["ts"],
            "lastAssistantText": EVENTS[1]["payload"]["text"], "pendingApprovals": len(STATE["pending"]),
            "engineTurnActive": True, "tags": [], "folderId": None, "source": "USER"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    def note(self, line):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S"), line))

    def send(self, status, payload=None):
        data = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode()
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
        parsed = urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]
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
            return self.stream([])
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
        if parts == ["api", "sessions"]:
            query = parsed.query
            if "view=open" in query or query == "" or "agentId" in query and "view=" not in query:
                return self.send(200, [session()])
            return self.send(200, [])
        if len(parts) >= 3 and parts[:3] == ["api", "sessions", "C1"]:
            rest = parts[3:]
            if rest == []:
                return self.send(200, session())
            if rest == ["events"]:
                return self.stream(EVENTS)
            if rest == ["events", "page"]:
                return self.send(200, {"events": EVENTS, "hasMore": False, "before": None, "after": None})
            if rest == ["approvals"]:
                return self.send(200, STATE["pending"])
            if rest == ["turns"]:
                return self.send(200, [])
        if parts in (["api", "providers"], ["api", "providers", "mine"], ["api", "providers", "pools"],
                     ["api", "providers", "shared-pools"], ["api", "session-tags"], ["api", "session-folders"],
                     ["api", "task-lists"], ["api", "watches"], ["api", "projects"], ["api", "projects", "sidebar"]):
            return self.send(200, [])
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})

    def stream(self, events):
        """A session's events as SSE `data:` frames (the server's own framing), then keepalives inside
        the clients' 45 s watchdog. Nothing new ever arrives."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            for e in events:
                self.wfile.write(("data: %s\n\n" % json.dumps(e, ensure_ascii=False)).encode())
            self.wfile.flush()
            while True:
                self.wfile.write(b": ping\n\n")
                self.wfile.flush()
                time.sleep(10)
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        raw, payload = self.body()
        if parts == ["__reset"]:
            reset()
            return self.send(200, {"ok": True})
        self.note("BODY %s %s" % (self.path, json.dumps(payload, sort_keys=True, ensure_ascii=False)))
        self.note("RAW %s %s" % (self.path, raw))
        if len(parts) == 6 and parts[:3] == ["api", "sessions", "C1"] and parts[3] == "approvals" \
                and parts[5] == "decision":
            return self.decide(parts[4], payload)
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    def decide(self, aid, payload):
        pending = [a for a in STATE["pending"] if a["id"] == aid]
        if not pending:
            return self.send(409, {"statusCode": 409, "message": "this approval is no longer pending"})
        STATE["pending"] = [a for a in STATE["pending"] if a["id"] != aid]
        status = "ALLOWED" if payload.get("behavior") == "allow" else "DENIED"
        return self.send(201, {"id": aid, "status": status})

    def refuse(self):
        self.body()
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    do_PUT = refuse
    do_PATCH = refuse
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
