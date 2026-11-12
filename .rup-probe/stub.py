#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the iPhone/Mac session list and
# console read, for two sessions queued behind their runner's self-update (queuedReason
# runner_updating, board 5 of docs/mocks/runner-update-drain):
#
#   Q1  queued, EMPTY transcript       -> the console's queued page (title, explanation, Waiting 38 min)
#   Q2  queued, one user message + one assistant reply
#                                      -> the user message's foot row: Queued · runner updating
#   T1, T2  the two running turns the update waits for (named in queuedRunnerUpdate.turns)
#
# The runner is studio-mac. `since` is stamped at every request (now - 38 min), so the wait reads
# 38 min however late the test runs. Every request is logged; anything not served is a 404 and is
# counted in not-served.txt. All data is made up.
import json
import os
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


def runner():
    return {"id": "r1", "name": "studio-mac", "displayName": "studio-mac",
            "online": True, "status": "ONLINE", "version": "0.1.253", "maxConcurrent": 2,
            "lastHeartbeatAt": ago(0), "capabilities": [],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}]}


AGENT = {"id": "a1", "name": "orbit", "provider": "claude", "lastProvider": "claude", "runnerId": "r1",
         "enabled": True, "enableWorktree": True, "effort": "", "workDir": "/srv/orbit",
         "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}


def session(sid, title, minutes_ago, **extra):
    row = {"id": sid, "publicId": sid, "title": title,
           "agentId": "a1", "agent": {"id": "a1", "name": "orbit"},
           "assignedRunnerId": "r1", "provider": "claude",
           "taskId": None, "projectId": None, "projectTitle": None,
           "createdAt": ago(minutes_ago + 5), "updatedAt": ago(minutes_ago),
           "lastTurnAt": ago(minutes_ago)}
    row.update(extra)
    return row


def queued(sid, title, minutes_ago, **extra):
    return session(sid, title, minutes_ago, status="PENDING", runState="QUEUED",
                   queuedReason="runner_updating", queuedActive=2, queuedLimit=None,
                   queuedRunnerUpdate={"targetVersion": "0.1.254", "since": ago(38),
                                       "turns": [{"id": "T1", "title": "Backfill missing shard rows"},
                                                 {"id": "T2", "title": "Why are 11-08 metrics zero"}]},
                   **extra)


def running(sid, title, minutes_ago):
    return session(sid, title, minutes_ago, status="RUNNING", runState="RUNNING")


REPLY = "Done: the notes now list 0.1.253's three fixes."


def sessions():
    """Stamped at each read: `since` and the heartbeat stay current through a long run."""
    return {
        "Q1": queued("Q1", "Why is the send stuck", 2),
        "Q2": queued("Q2", "Tidy the release notes", 6, lastAssistantText=REPLY),
        "T1": running("T1", "Backfill missing shard rows", 1),
        "T2": running("T2", "Why are 11-08 metrics zero", 3),
    }


def ev(seq, typ, turn, payload, minutes):
    return {"seq": seq, "type": typ, "ts": ago(minutes), "turnId": turn, "payload": payload}


def events(sid):
    if sid == "Q2":
        return [
            ev(1, "user", "t1", {"text": "Tidy the release notes for 0.1.253 into three short lines."}, 9),
            ev(2, "assistant", "t1", {"text": REPLY, "messageId": "m1"}, 8),
        ]
    return []


EMPTY = ["providers", "providers/mine", "providers/pools", "providers/shared-pools", "session-tags",
         "session-folders", "task-lists", "watches", "tasks/active", "tasks/counts", "notifications",
         "projects", "projects/sidebar", "tasks", "skills"]


def log(line):
    with open(LOG, "a") as f:
        f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S.%f")[:-3], line))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log(fmt % args)

    def send(self, status, body=None):
        data = b"" if body is None else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

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
            return self.stream(None)
        if parts == ["api", "users", "me"]:
            return self.send(200, USER)
        if parts == ["api", "agents"]:
            return self.send(200, [AGENT])
        if parts == ["api", "agents", "a1"]:
            return self.send(200, AGENT)
        if parts == ["api", "runners"]:
            return self.send(200, [runner()])
        if parts == ["api", "runners", "r1"]:
            return self.send(200, runner())
        if len(parts) >= 2 and parts[:2] == ["api", "sessions"]:
            rest = parts[2:]
            rows = sessions()
            if rest == []:
                return self.send(200, list(rows.values()))
            if rest[0] in rows:
                sid, more = rest[0], rest[1:]
                if more == []:
                    return self.send(200, rows[sid])
                if more == ["events"]:
                    return self.stream(sid)
                if more == ["events", "page"]:
                    return self.send(200, {"events": events(sid), "hasMore": False,
                                           "before": None, "after": None})
                if more in (["turns"], ["approvals"], ["background-tasks"]):
                    return self.send(200, [])
                if more[0] in ("retry-message", "capabilities", "owner-confirmation", "watches",
                               "attribution", "created-tasks"):
                    return self.send(200, {})
                if more[0] == "owner-items":
                    return self.send(200, {"needsYou": [], "withCoordinator": []})
        if parts == ["api", "wiki", "spaces"]:
            return self.send(200, [])
        if len(parts) >= 2 and parts[:2] == ["api", "share-links"]:
            return self.send(200, {"links": []})
        if parts == ["api", "access-tokens"]:
            return self.send(200, {"tokens": []})
        if parts[:1] == ["api"] and len(parts) >= 2 and "/".join(parts[1:]) in EMPTY:
            return self.send(200, [])
        if len(parts) >= 2 and parts[:2] == ["api", "tasks"] and parts[2:] == ["page"]:
            return self.send(200, {"items": [], "nextCursor": None})
        log("NOT SERVED %s" % self.path)
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})

    def stream(self, sid):
        """SSE: the session's events once (the server's `data:` framing), then keepalives."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            if sid:
                for e in events(sid):
                    self.wfile.write(("data: %s\n\n" % json.dumps(e, ensure_ascii=False)).encode())
            while True:
                self.wfile.write(b": ping\n\n")
                self.wfile.flush()
                time.sleep(10)
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode(errors="replace") if n else ""
        if parts == ["__reset"]:
            log("RESET")
            return self.send(200, {"ok": True})
        log("BODY %s %s" % (self.path, raw))
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    do_PATCH = do_POST
    do_DELETE = do_POST


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    # No reverse lookup of our own name: on macOS it raises a local-network prompt over the app.
    def server_bind(self):
        import socketserver
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "localhost", self.server_address[1]


if __name__ == "__main__":
    log("stub on :%d pid=%d" % (PORT, os.getpid()))
    Server(("127.0.0.1", PORT), Handler).serve_forever()
