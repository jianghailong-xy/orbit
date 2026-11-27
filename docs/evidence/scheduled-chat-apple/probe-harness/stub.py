#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the Scheduled page and its chat read in the iPhone,
# iPad and Mac apps, for task 354CXjOML0uOFkSP36f4M (docs/scheduled-chat-design.md §6, board
# docs/mocks/scheduled-chat/01-board-4.png). Shapes follow src/web/src/test/scheduledChatFixtures.ts (recorded from a
# real apiserver) and OrbitKit's decoders. Adapted from docs/evidence/wiki-chat-ios/probe-harness/stub.py.
#
# Board 4's account: four schedules — Codex stable check and Nightly dependency audit active, the two changelog watches
# paused — and one Scheduled chat, "Move the audit", whose first turn moved the audit to weekdays at 07:00 (a change line
# with Undo) and whose second turn offers Run now for the Codex check. The stage, set with POST /__set {"stage": ...}
# and put back to `chat` by POST /__reset:
#
#   chat   the chat above exists and is the account's open one
#   new    no chat yet: the button opens a new one on Orbit's opening, Runs in dev-box
#
# Every request is logged; anything not served is a 404, and every write a 409 — the probe presses nothing. All data
# is made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
STATE = {"stage": "chat"}


def stamp(minutes_ago=0.0):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def ahead(days, hour, minute=0):
    t = (datetime.now(timezone.utc) + timedelta(days=days)).replace(hour=hour, minute=minute, second=0, microsecond=0)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


USER = {"id": "u1", "email": "probe@example.com", "name": "Probe", "role": "USER", "createdAt": "2026-09-01T00:00:00.000Z"}

AGENTS = [
    {"id": "a1", "name": "dev-box", "provider": "claude", "lastProvider": "claude", "runnerId": "mini", "enabled": True,
     "enableWorktree": True, "effort": "", "workDir": "/Users/probe/orbit", "appendSystemPrompt": "",
     "workDirExists": True, "workDirIsGit": True},
    {"id": "a2", "name": "orbit-ws01", "provider": "claude", "lastProvider": "claude", "runnerId": "ws01",
     "enabled": True, "enableWorktree": True, "effort": "", "workDir": "/root/orbit", "appendSystemPrompt": "",
     "workDirExists": True, "workDirIsGit": True},
]
CLAUDE_MODELS = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "reasoningLevels": ["low", "medium", "high", "max"]}]


def runner(rid, name):
    return {"id": rid, "name": name, "displayName": name, "hostname": name, "online": True, "status": "ONLINE",
            "version": "0.1.261", "maxConcurrent": 8, "activeSessions": 0, "lastHeartbeatAt": stamp(0),
            "capabilities": [], "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}],
            "modelCatalog": {"claude": CLAUDE_MODELS}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


RUNNERS = [runner("mini", "Mac mini"), runner("ws01", "orbit-ws01")]

# ── the schedules (board 4 ①) ───────────────────────────────────────────────────────────────────────────

WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI"]


def schedule(sid, title, rule, access, state, ws="a1", ws_name="dev-box", next_due=None, paused_at=None, revision=1):
    return {"id": sid, "title": title, "intent": title, "prompt": title, "rule": rule, "timezone": "UTC",
            "workspaceId": ws, "workspaceName": ws_name, "agentId": ws, "agentName": ws_name, "accessLevel": access,
            "runLimitMinutes": 30, "runsPerWeek": 7,
            "envelope": {"workspaceId": ws, "accessLevel": access, "runsPerWeek": 7, "runLimitMinutes": 30},
            "state": state, "heldReason": None, "endedReason": None, "note": None, "revision": revision,
            "startAt": None, "endAt": None, "maxRuns": None, "runsLeft": None, "nextDueAt": next_due,
            "consecutiveFailures": 0, "createdFromSessionId": None, "createdAt": "2026-11-12T09:00:00.000Z",
            "endedAt": None, "lastRun": None, "pausedAt": paused_at}


def schedules():
    return [
        schedule("sch1", "Codex stable check", {"kind": "DAILY", "time": "06:00"}, "CHECK_ONLY", "ACTIVE",
                 ws="a2", ws_name="orbit-ws01", next_due=ahead(1, 6)),
        schedule("sch2", "Nightly dependency audit", {"kind": "WEEKLY", "time": "07:00", "weekdays": WEEKDAYS},
                 "OPEN_PR", "ACTIVE", next_due=ahead(1, 7), revision=2),
        schedule("sch3", "Changelog watch (docs)", {"kind": "DAILY", "time": "09:00"}, "CHECK_ONLY", "PAUSED",
                 paused_at="2026-11-17T10:00:00.000Z"),
        schedule("sch4", "Changelog watch (API)", {"kind": "DAILY", "time": "23:46"}, "CHECK_ONLY", "PAUSED",
                 paused_at="2026-11-17T10:00:00.000Z"),
    ]


def find(sid):
    return next((s for s in schedules() if s["id"] == sid), None)


# ── the chat (board 4 ②) ────────────────────────────────────────────────────────────────────────────────

CHAT_TITLE = "Move the audit"
ASK_1 = "Move the audit to 07:00, weekdays only."
ANSWER_1 = "Done. Its next run is Monday at 07:00."
ASK_2 = "Can you run the Codex check now?"
ANSWER_2 = ("I don't press Run now for you: it's yours, and it counts toward no budget.\n\n"
            "[Run now](orbit-run-now:sch1)")


def record():
    """The change the first turn made: Nightly dependency audit, every day 06:00 → weekdays 07:00, with Undo."""
    return {"scheduleId": "sch2", "title": "Nightly dependency audit", "revision": 2, "changedBy": "USER",
            "sessionId": "S1", "before": {"rule": {"kind": "DAILY", "time": "06:00"}},
            "after": {"rule": {"kind": "WEEKLY", "time": "07:00", "weekdays": WEEKDAYS}},
            "undoOfRevision": None, "undoneByRevision": None, "askedText": ASK_1, "createdAt": stamp(9.5),
            "undo": {"path": "/api/schedules/sch2/undo", "body": {"revision": 2}}}


def created_record():
    return {"scheduleId": "sch2", "title": "Nightly dependency audit", "revision": 1, "changedBy": "USER",
            "sessionId": None, "before": None, "after": {"state": "ACTIVE"}, "undoOfRevision": None,
            "undoneByRevision": None, "askedText": None, "createdAt": "2026-11-12T09:00:00.000Z", "undo": None}


def events():
    out, seq = [], 0

    def add(typ, payload, minutes, turn):
        nonlocal seq
        seq += 1
        out.append({"seq": seq, "type": typ, "ts": stamp(minutes), "turnId": turn, "payload": payload})

    add("user", {"text": ASK_1}, 10, "t1")
    add("assistant", {"text": ANSWER_1, "messageId": "m1"}, 9, "t1")
    add("result", {"subtype": "success", "result": "done"}, 9, "t1")
    add("user", {"text": ASK_2}, 4, "t2")
    add("assistant", {"text": ANSWER_2, "messageId": "m2"}, 3, "t2")
    add("result", {"subtype": "success", "result": "done"}, 3, "t2")
    return out


def session():
    return {"id": "S1", "title": CHAT_TITLE, "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
            "runState": "AWAITING_INPUT", "sessionState": "AWAITING_INPUT", "lifecycleState": "OPEN",
            "phase": "IDLE", "released": False, "agentId": "a1", "agent": {"id": "a1", "name": "dev-box"},
            "assignedRunnerId": "mini", "provider": "claude", "engine": "claude", "model": "claude-opus-5-5",
            "effort": "high", "permissionMode": "default", "taskId": None, "projectId": None,
            "createdAt": stamp(11), "updatedAt": stamp(3), "lastTurnAt": stamp(3), "listedAt": stamp(3),
            "lastAssistantText": "Run now is yours.", "pendingApprovals": 0, "tags": [], "folderId": None,
            "source": "user", "runSource": "MANUAL", "chatOrigin": "SCHEDULE_CHAT", "numTurns": 2,
            "capabilities": {"canSend": True, "canResume": True, "canComplete": True, "canArchive": True,
                             "canRestore": False}}


def plain_session():
    return {"id": "P1", "title": "Fix the login redirect", "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
            "runState": "AWAITING_INPUT", "lifecycleState": "OPEN", "phase": "IDLE", "agentId": "a1",
            "agent": {"id": "a1", "name": "dev-box"}, "assignedRunnerId": "mini", "provider": "claude",
            "createdAt": stamp(90), "updatedAt": stamp(60), "lastTurnAt": stamp(60), "listedAt": stamp(60),
            "lastAssistantText": "The redirect now keeps the page.", "pendingApprovals": 0, "tags": [],
            "folderId": None, "source": "user", "runSource": "MANUAL", "chatOrigin": None}


OPENING = {
    "counts": {"total": 4, "active": 2, "paused": 2, "held": 0, "failing": 0},
    "next": {"scheduleId": "sch1", "title": "Codex stable check", "at": ahead(1, 6), "timezone": "UTC",
             "workspaceId": "a2", "workspaceName": "orbit-ws01"},
    "summary": "You have 4 scheduled tasks: 2 active, 2 paused, none failing.",
    "nextText": "Next: Codex stable check, tomorrow at 06:00 on orbit-ws01.",
    "examplesLead": "Ask about them, or tell me what to change. For example:",
    "examples": ["Pause everything on my laptop until Monday", "Why did the last run take so long?",
                 "Every weekday at 09:00, check a changelog and tell me what's new"],
    "closing": "Moving a time, rewording what a task checks or how it reports applies at once, and you can undo it. "
               "More runs, longer runs, more access or another workspace need your Allow.",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        with open(LOG, "a") as f:
            f.write("%s [%s] %s\n" % (datetime.now().strftime("%H:%M:%S.%f")[:-3], STATE["stage"], fmt % args))

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
        with open(LOG, "a") as f:
            f.write("    %s %s body: %s\n" % (self.command, urlparse(self.path).path, raw.decode("utf-8", "replace")))
        return raw

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        parts = [p for p in url.path.split("/") if p]
        has_chat = STATE["stage"] == "chat"
        if parts == ["api", "users", "me"]:
            return self.send(200, USER)
        if parts == ["api", "agents"]:
            return self.send(200, AGENTS)
        if len(parts) == 3 and parts[:2] == ["api", "agents"]:
            agent = next((a for a in AGENTS if a["id"] == parts[2]), None)
            return self.send(200, agent) if agent else self.send(404, {"error": "no such agent"})
        if parts == ["api", "runners"]:
            return self.send(200, RUNNERS)
        if len(parts) == 3 and parts[:2] == ["api", "runners"]:
            found = next((r for r in RUNNERS if r["id"] == parts[2]), None)
            return self.send(200, found) if found else self.send(404, {"error": "no such runner"})
        if parts == ["api", "events"]:
            return self.keepalive()
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            if view != "open":
                return self.send(200, [])
            return self.send(200, ([session()] if has_chat else []) + [plain_session()])
        if len(parts) == 4 and parts[:3] == ["api", "sessions", "S1"] and parts[3] == "events" and has_chat:
            return self.stream(int(query.get("sinceSeq", ["0"])[0] or 0))
        if len(parts) >= 3 and parts[:3] == ["api", "sessions", "S1"] and has_chat:
            rest = parts[3:]
            if rest == []:
                return self.send(200, session())
            if rest == ["events", "page"]:
                return self.send(200, {"events": events(), "hasMore": False, "before": None, "after": None})
            if rest == ["schedule-cards"]:
                return self.send(200, {"run": None, "cards": [], "records": [record()], "change": None})
            if rest in (["approvals"], ["turns"]):
                return self.send(200, [])
            return self.send(404, {"error": "not in the probe"})
        if parts == ["api", "schedules"]:
            return self.send(200, {"schedules": schedules(), "runs": [], "waitingTasks": []})
        if parts == ["api", "schedules", "drafts"]:
            return self.send(200, {"drafts": []})
        if parts == ["api", "schedules", "chat"]:
            return self.send(200, {"sessionId": "S1" if has_chat else None, "opening": OPENING})
        if len(parts) == 3 and parts[:2] == ["api", "schedules"]:
            found = find(parts[2])
            if not found:
                return self.send(404, {"error": "no such schedule"})
            history = [record(), created_record()] if found["id"] == "sch2" else []
            return self.send(200, {"schedule": found, "readBack": None, "lastRun": None, "recentRuns": [],
                                   "findings": [], "usage": None, "history": history, "pendingCards": []})
        if len(parts) == 4 and parts[:2] == ["api", "schedules"] and parts[3] == "runs":
            return self.send(200, {"runs": []})
        if parts in (["api", "providers"], ["api", "providers", "mine"], ["api", "providers", "pools"],
                     ["api", "providers", "shared-pools"], ["api", "session-tags"], ["api", "session-folders"],
                     ["api", "task-lists"], ["api", "watches"], ["api", "share-links"], ["api", "projects"],
                     ["api", "workspaces"], ["api", "owner-requests"], ["api", "conditions"]):
            return self.send(200, [])
        if parts == ["api", "wiki", "spaces"]:
            return self.send(200, [])
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
        """Replay what follows `sinceSeq`, then hold the stream open inside the clients' 45 s watchdog."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        last_ping = time.time()
        try:
            for e in events():
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
        raw = self.body()
        if parts == ["__reset"]:
            STATE["stage"] = "chat"
            return self.send(200, {"ok": True})
        if parts == ["__set"]:
            try:
                STATE["stage"] = json.loads(raw or b"{}").get("stage", STATE["stage"])
            except ValueError:
                return self.send(400, {"error": "not JSON"})
            return self.send(200, {"stage": STATE["stage"]})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

    def do_PATCH(self):
        self.body()
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

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
    print("stub listening on 127.0.0.1:%d (python %s)" % (PORT, sys.version.split()[0]), flush=True)
    server.serve_forever()
