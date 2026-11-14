#!/usr/bin/env python3
# Evidence probe for the native guest view (see ../README.md). The slice of the Orbit API the iPhone
# and Mac apps read when signed in as a GUEST: the account's own (one workspace, nothing else) and the
# guest door (`/api/guest-sessions…`) for four sessions somebody else owns. All data is made up.
#
#   G1  running — the agent is working. It is NOT the account's own: `GET /api/sessions/G1` is the
#       owner door's 404, so opening it by id exercises the guest-door fallback.
#   G2  waiting on its owner — a permission card pending (`waitingOnOwner`).
#   G3  ended — a message restarts it on the owner's machine.
#   G4  no longer shared — the door's one 404. Not in Shared with me.
#
# A message (`POST /api/guest-sessions/:id/turns`) is appended as the guest's own `user` event, headed
# with the guest's name as the server records it (`ORBIT_GUEST`), followed by the agent's reply.
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
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


DAY = 24 * 60
GUEST_NAME = "Sam Lee"
OWNER = "Ana Ruiz"
USER = {"id": "u1", "email": "sam@example.com", "name": GUEST_NAME, "role": "MEMBER",
        "createdAt": ago(90 * DAY), "preferences": {"theme": "system"}}
RUNNER = {"id": "r1", "name": "sam-laptop", "displayName": "sam-laptop",
          "online": True, "status": "ONLINE", "version": "0.1.256", "maxConcurrent": 4,
          "lastHeartbeatAt": ago(0), "capabilities": [],
          "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}]}
AGENT = {"id": "a1", "name": "notes", "provider": "claude", "lastProvider": "claude", "runnerId": "r1",
         "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/Users/sam/notes",
         "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}


def ev(seq, typ, payload, turn, minutes):
    return {"seq": seq, "type": typ, "payload": payload, "turnId": turn, "ts": ago(minutes)}


def guest(text):
    return {"text": text, "externalSender": {"source": "ORBIT_GUEST", "name": GUEST_NAME}}


def conversation(last_minutes):
    """The owner asked, the guest followed up, the agent read and answered."""
    m = last_minutes
    return [
        ev(1, "user", {"text": "The login redirect test fails about one run in five. Can you find out why?"}, "t1", m + 30),
        ev(2, "assistant", {"text": "I'll start with the test and the redirect handler."}, "t1", m + 29),
        ev(3, "tool_use", {"toolUseId": "tu1", "name": "Bash",
                           "input": {"command": "npm test -- login-redirect --repeat 20"}}, "t1", m + 29),
        ev(4, "tool_result", {"toolUseId": "tu1",
                              "content": "Tests: 4 failed, 16 passed, 20 total\nlogin-redirect › keeps the next= target"},
           "t1", m + 27),
        ev(5, "assistant", {"text": "The redirect races the session cookie: when the cookie lands after the "
                                    "navigation, `next=` is dropped. I can make the handler wait for it."}, "t1", m + 26),
        ev(6, "turn_end", {}, "t1", m + 26),
        ev(7, "user", guest("Thanks! Could you also check the logout redirect for the same race?"), "t2", m + 5),
        ev(8, "assistant", {"text": "Looking at the logout handler now."}, "t2", m + 4),
    ]


def head(sid):
    s = SESSIONS[sid]
    return {"title": s["title"], "workspaceName": "web", "status": s["status"], "runStatus": s["status"],
            "sessionState": s["runState"], "runState": s["runState"], "lifecycleState": s["lifecycle"],
            "filingState": s["lifecycle"], "createdAt": ago(60)}


def initial():
    return {
        "G1": {"title": "Fix the flaky login redirect test", "status": "RUNNING", "runState": "RUNNING",
               "lifecycle": "OPEN", "waiting": False, "events": conversation(1), "lastTurnAt": ago(5),
               "addedAt": ago(3 * 60)},
        "G2": {"title": "Upgrade the payments SDK to v5", "status": "AWAITING_INPUT", "runState": "AWAITING_INPUT",
               "lifecycle": "OPEN", "waiting": True,
               "events": conversation(2)[:6] + [
                   ev(7, "user", guest("Go ahead and bump it — the changelog looks safe."), "t2", 10),
                   ev(8, "assistant", {"text": "I need to run the migration script, which asks for approval."}, "t2", 9),
                   ev(9, "tool_use", {"toolUseId": "tu2", "name": "Bash",
                                      "input": {"command": "./scripts/migrate-payments.sh --apply"}}, "t2", 9),
               ], "lastTurnAt": ago(9), "addedAt": ago(DAY)},
        "G3": {"title": "Draft the Q4 release notes", "status": "CANCELLED", "runState": "ENDED",
               "lifecycle": "OPEN", "waiting": False, "events": conversation(60)[:6], "lastTurnAt": ago(2 * DAY),
               "addedAt": ago(3 * DAY)},
    }


SESSIONS = {}


def reset():
    SESSIONS.clear()
    SESSIONS.update(initial())


reset()


def summary(sid):
    s = SESSIONS[sid]
    return {"id": sid, "title": s["title"], "ownerName": OWNER, "status": s["status"], "sessionState": s["runState"],
            "lifecycleState": s["lifecycle"], "addedAt": s["addedAt"], "lastTurnAt": s["lastTurnAt"]}


EMPTY = ["providers", "providers/mine", "providers/pools", "providers/shared-pools", "session-tags",
         "session-folders", "task-lists", "watches", "tasks/active", "tasks/counts", "notifications",
         "projects", "projects/sidebar", "wiki/spaces"]


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

    def not_shared(self):
        return self.send(404, {"statusCode": 404, "code": "GUEST_SESSION_NOT_SHARED",
                               "message": "This session is not shared with you."})

    def do_GET(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        parts = [p for p in url.path.split("/") if p]
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
        if parts == ["api", "sessions"]:
            return self.send(200, [])
        # The owner's door knows none of these: this account owns no session.
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            return self.send(404, {"statusCode": 404, "message": "Session not found"})
        if parts == ["api", "guest-sessions"]:
            return self.send(200, {"sessions": [summary(s) for s in ("G1", "G2", "G3")]})
        if len(parts) >= 3 and parts[:2] == ["api", "guest-sessions"]:
            sid = parts[2]
            if sid not in SESSIONS:
                return self.not_shared()
            s = SESSIONS[sid]
            if len(parts) == 3:
                limit = int(q.get("limit", "200"))
                events = s["events"][-limit:]
                return self.send(200, {**head(sid), "events": events, "hasMore": len(s["events"]) > limit,
                                       "ownerName": OWNER, "waitingOnOwner": s["waiting"]})
            if parts[3:] == ["events"]:
                if "after" in q:
                    after = int(q["after"])
                    newer = [e for e in s["events"] if e["seq"] > after]
                    return self.send(200, {**head(sid), "events": newer, "after": None,
                                           "waitingOnOwner": s["waiting"]})
                before = int(q.get("before", "0"))
                older = [e for e in s["events"] if e["seq"] < before]
                return self.send(200, {"events": older, "hasMore": False})
            if len(parts) == 5 and parts[3] == "events":
                found = [e for e in s["events"] if str(e["seq"]) == parts[4]]
                return self.send(200, found[0]) if found else self.send(404, {"statusCode": 404})
        if parts[:1] == ["api"] and "/".join(parts[1:]) in EMPTY:
            return self.send(200, [])
        if len(parts) >= 2 and parts[:2] == ["api", "tasks"]:
            return self.send(200, {"items": [], "nextCursor": None} if parts[2:] == ["page"] else [])
        self.note("NOT SERVED %s" % self.path)
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
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode() if n else ""
        if parts == ["__reset"]:
            reset()
            return self.send(200, {"ok": True})
        self.note("BODY %s %s" % (self.path, raw))
        if len(parts) == 4 and parts[:2] == ["api", "guest-sessions"] and parts[3] == "turns":
            sid = parts[2]
            if sid not in SESSIONS:
                return self.not_shared()
            body = json.loads(raw or "{}")
            extra = set(body) - {"clientTurnId", "content"}
            if extra:
                return self.send(400, {"statusCode": 400, "message": "A guest's message takes text only (%s)" % ", ".join(sorted(extra))})
            s = SESSIONS[sid]
            seq = s["events"][-1]["seq"] + 1
            revived = s["runState"] == "ENDED"
            s["events"] += [ev(seq, "user", guest(body["content"]), "t9", 0),
                            ev(seq + 1, "assistant", {"text": "Got it — I'll take that on next."}, "t9", 0)]
            s.update(status="RUNNING", runState="RUNNING", lastTurnAt=ago(0))
            return self.send(201, {"turnId": "t9", "revived": revived})
        return self.send(409, {"statusCode": 409, "message": "the probe does not run anything"})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    # A reverse lookup of its own name raises macOS's local-network prompt over the app being
    # photographed (the source-refused probe's note).
    def server_bind(self):
        import socketserver
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "localhost", self.server_address[1]


if __name__ == "__main__":
    Server(("127.0.0.1", PORT), Handler).serve_forever()
