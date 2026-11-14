#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged), from the ask-question-card probe: the slice of the Orbit API a
# project row waiting on you needs in the iPhone app. Original header:
# the slice of the Orbit API five idle conversations need in
# the native clients, each ending on an answered AskUserQuestion — one question (the 10:14 screenshot's,
# word for word), two questions, words typed instead of an option, a multi-select question, and a reply
# given with Chat about this (the call's error). Agents, runners and providers are the composer-fade
# probe's (docs/evidence/composer-fade/probe-harness/stub.py), which the console is known to draw.
# Every request is logged; anything not served is a 404.
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


CLAUDE_CATALOG = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "contextWindow": 1000000,
                   "reasoningLevels": ["low", "medium", "high", "max"]}]


def runner(rid, name):
    # Stamped per request: the clients call a machine offline once its heartbeat is 90 s old.
    return {"id": rid, "name": name, "displayName": name, "online": True, "status": "ONLINE",
            "version": "0.1.226", "maxConcurrent": 4, "lastHeartbeatAt": ago(0), "capabilities": [],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.296", "auth": "yes"}],
            "modelCatalog": {"claude": CLAUDE_CATALOG}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


def agents():
    return [{"id": "a1", "name": "orbit", "provider": "claude", "lastProvider": "claude", "runnerId": "r1",
             "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/srv/orbit",
             "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]



# The board's project (owner 2026-11-14): a coordinator, P0 waiting on you with a question card taller
# than the screen, P1 at rest, and a loose session beside them.
PROJECT = {"projectId": "p1", "projectTitle": "GitHub-backed workspaces", "projectStatus": "OPEN"}

CARD_TITLE = "Which GitHub App should workspaces sign in with?"
OWNER_REQUEST = {
    "id": "or_p0_app", "kind": "DECISION", "state": "PENDING", "title": CARD_TITLE,
    "why": ("P0 registers the App and stores its key on the server; P1–P4 clone and push through it. The choice "
            "decides who can revoke the key, which webhook deliveries the server sees, and whether CI and "
            "workspaces share one rate-limit budget. A new App needs its own permissions screen, a private key "
            "kept by the server, a webhook secret, and an installation on every organisation that holds a "
            "workspace repository."),
    "blocksTaskIds": [], "ifUnanswered": "P1–P4 stay blocked.",
    "options": [
        {"label": "Register a new App for Orbit",
         "description": "Its own permissions and webhook; nothing shared with CI. One more registration to keep, one "
                        "more private key on the server, and an installation per organisation; in exchange a "
                        "workspace push is its own entry in the audit log and can be revoked alone."},
        {"label": "Reuse the CI App",
         "description": "No new App, but CI and workspaces share one key, one webhook and one rate-limit budget. A "
                        "busy afternoon of workspace pushes can starve the CI checks of their API calls."},
        {"label": "A personal access token per workspace",
         "description": "No App at all: each workspace keeps a token of its owner's. Simple to start, but the token "
                        "carries the owner's whole account and expires on the owner's schedule, not the server's."},
        {"label": "Decide after P1 has cloned once",
         "description": "P0 stays blocked; P1 clones with a temporary token so the choice can be made on a real "
                        "repository's numbers. Nothing ships until the App is chosen."}],
    "recommendedOption": 0, "askedBySessionId": "P0", "projectId": "p1", "createdAt": None,
}


def owner_request():
    return dict(OWNER_REQUEST, createdAt=ago(2))


SESSIONS = {
    "C1": {"title": "GitHub-backed workspaces", "role": "COORDINATOR", "minutes": 3, "approvals": 0,
           "reply": "P0 is waiting on your answer about the GitHub App; P1–P4 start once it lands."},
    "P0": {"title": "GitHub workspaces P0: GitHub App credentials", "role": "TASK", "minutes": 1, "approvals": 1,
           "reply": "I need one decision before I register anything."},
    "P1": {"title": "GitHub workspaces P1: clone over the App", "role": "TASK", "minutes": 2, "approvals": 0,
           "reply": "Waiting for P0's App before cloning."},
    "L1": {"title": "Session list review", "role": None, "minutes": 30, "approvals": 0,
           "reply": "Both boards are drawn; pick one when you can."},
}

STEPS = ["Read the server's credential store and how a runner asks it for a token.",
         "Listed every call the workspace clone and push paths make to GitHub today.",
         "Checked which of them the CI App's permissions already cover, and which they do not.",
         "Drafted the App's permission set: contents read/write, metadata read, pull requests read.",
         "Wrote down what a revoked key does to a workspace in the middle of a push."]


def events(sid):
    out, seq = [], 0

    def add(typ, payload, minutes):
        nonlocal seq
        seq += 1
        out.append({"seq": seq, "type": typ, "ts": ago(minutes), "turnId": "t1", "payload": payload})

    meta = SESSIONS[sid]
    add("user", {"text": "Start " + meta["title"] + "."}, 40)
    for i, step in enumerate(STEPS if sid == "P0" else STEPS[:1]):
        add("assistant", {"text": step + " " + ("The notes are in the task's comments. " * 3), "messageId": "m%d" % i},
            39 - i)
    if sid == "P0":
        add("assistant", {"text": "I need one decision before I register anything.", "messageId": "mq"}, 3)
        add("result", {"subtype": "success", "result": "asked"}, 3)
        return out
    add("assistant", {"text": meta["reply"], "messageId": "mz"}, meta["minutes"])
    add("result", {"subtype": "success", "result": "done"}, meta["minutes"])
    return out


def session(sid):
    meta = SESSIONS[sid]
    membership = dict(PROJECT, role=meta["role"]) if meta["role"] else None
    return {"id": sid, "title": meta["title"], "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
            "runState": "AWAITING_INPUT", "lifecycleState": "OPEN", "agentId": "a1",
            "agent": {"id": "a1", "name": "a1"}, "assignedRunnerId": "r1", "provider": "claude",
            "model": "claude-opus-5-5", "effort": "max", "permissionMode": "default", "taskId": None,
            "projectId": "p1" if meta["role"] == "COORDINATOR" else None,
            "projectTitle": PROJECT["projectTitle"] if meta["role"] == "COORDINATOR" else None,
            "projectMembership": membership,
            "createdAt": ago(60), "updatedAt": ago(0), "lastTurnAt": ago(meta["minutes"]),
            "lastAssistantText": meta["reply"], "pendingApprovals": meta["approvals"], "tags": [],
            "waitingKind": "OWNER_REQUEST" if meta["approvals"] else None,
            "folderId": None, "source": "USER"}


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

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        parts = [p for p in url.path.split("/") if p]
        if parts == ["api", "agents"]:
            return self.send(200, agents())
        if len(parts) == 3 and parts[:2] == ["api", "agents"]:
            found = [a for a in agents() if a["id"] == parts[2]]
            return self.send(200, found[0]) if found else self.send(404, {"error": "no agent"})
        if parts == ["api", "runners"]:
            return self.send(200, [runner("r1", "hpc")])
        if len(parts) == 3 and parts[:2] == ["api", "runners"]:
            return self.send(200, runner("r1", "hpc")) if parts[2] == "r1" else self.send(404, {"error": "no runner"})
        if parts in (["api", "providers"], ["api", "providers", "mine"], ["api", "providers", "pools"],
                     ["api", "providers", "shared-pools"], ["api", "session-tags"], ["api", "session-folders"],
                     ["api", "task-lists"], ["api", "watches"], ["api", "share-links"]):
            return self.send(200, [])
        if parts == ["api", "owner-requests"]:
            state = query.get("state", ["open"])[0]
            return self.send(200, {"requests": [owner_request()] if state in ("open", "all", "pending") else []})
        if len(parts) == 3 and parts[:2] == ["api", "owner-requests"]:
            return self.send(200, owner_request()) if parts[2] == "or_p0_app" else self.send(404, {"error": "no request"})
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            return self.send(200, [session(s) for s in SESSIONS] if view == "open" else [])
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "events":
            return self.stream(parts[2], int(query.get("sinceSeq", ["0"])[0] or 0))
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            sid, rest = parts[2], parts[3:]
            if sid not in SESSIONS:
                return self.send(404, {"error": "not in the probe"})
            if rest == []:
                return self.send(200, session(sid))
            if rest == ["events", "page"]:
                return self.send(200, {"events": events(sid), "hasMore": False, "before": None, "after": None})
            if rest == ["approvals"]:
                return self.send(200, [])
            if rest == ["turns"]:
                return self.send(200, [])
            return self.send(404, {"error": "not in the probe"})
        return self.send(404, {"error": "not in the probe"})

    def stream(self, sid, sent):
        """Replay what follows `sinceSeq` (SSE `data:` frames, the server's own framing), then hold the
        stream open with a keepalive inside the clients' 45 s watchdog. Nothing new ever arrives."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        last_ping = time.time()
        try:
            for e in (events(sid) if sid in SESSIONS else []):
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
        if parts == ["__reset"]:
            return self.send(200, {"ok": True})
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
