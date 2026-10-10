#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API five idle conversations need in
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


SWIPE_Q = ("On iPad, what should a swipe right from the left edge do? Today there are two places on the iPad "
           "where the swipe does nothing: (1) the hidden sidebar only opens from the toolbar button; (2) the "
           "in-column pages with a Back button (a folder's page, a project's sessions page, a task opened over "
           "its project, a runner's engine or name page) only go back from that button. On the iPhone the same "
           "swipe opens the drawer on a list page and goes back on a pushed page.")
SWIPE = {"question": SWIPE_Q, "header": "Swipe right", "multiSelect": False, "options": [
    {"label": "Both, like the iPhone (Recommended)",
     "description": "On a list page, swiping right from the screen's left edge opens the sidebar (swiping left on "
                    "it closes it). On an in-column page with a Back button, swiping right from that column's left "
                    "edge goes back one page."},
    {"label": "Open the sidebar only",
     "description": "Swiping right from the screen's left edge opens the sidebar; going back still uses only the "
                    "Back button."},
    {"label": "Swipe back only",
     "description": "On an in-column page with a Back button, swiping right goes back; the sidebar still opens only "
                    "from the toolbar button."}]}
TOP_Q = ("When a project page is opened from the session list (or from a folder), swiping from the left edge will "
         "go back to that list. What should the top-left button be on that page?")
TOP = {"question": TOP_Q, "header": "Top-left", "multiSelect": False, "options": [
    {"label": "‹ Back (Recommended)", "description": "Standard iOS: the button and the swipe both go back to the list."},
    {"label": "Keep ☰", "description": "☰ opens the drawer and the edge swipe goes back."}]}
CLIENTS_Q = "Which clients should get the new card in this change?"
CLIENTS = {"question": CLIENTS_Q, "header": "Clients", "multiSelect": True, "options": [
    {"label": "iOS and macOS", "description": "One SwiftUI view serves both."},
    {"label": "Web", "description": "The same words, in its own component."},
    {"label": "Android", "description": "No per-tool cards there yet; this would be the first."}]}

TRAILER = (". Read the answers carefully — they may request clarification, changes, or that you not proceed "
           "— and follow what they actually say.")


def answered(*pairs):
    return "The user answered: " + ", ".join('"%s"="%s"' % p for p in pairs) + TRAILER


ASKING = ("Two places on the iPad ignore the swipe today, and on a list page they want different things from the "
          "same gesture — so I'm asking before I change either.")

# id → (title, questions, result, isError, the answer after it)
SESSIONS = {
    "Q1": ("iPad edge swipe", [SWIPE], answered((SWIPE_Q, "Both, like the iPhone (Recommended)")), False,
           "Both, then. The sidebar first: on a list page an edge swipe opens it, and a left swipe on it closes it."),
    "Q2": ("Two questions", [SWIPE, TOP],
           answered((SWIPE_Q, "Open the sidebar only"), (TOP_Q, "‹ Back (Recommended)")), False,
           "The sidebar only, and ‹ Back on a project page opened from the list. Starting with the sidebar."),
    "Q3": ("Typed answer", [SWIPE],
           answered((SWIPE_Q, "Only on list pages for now; leave going back to the button.")), False,
           "List pages only, then: the edge swipe opens the sidebar there, and Back stays a button."),
    "Q4": ("Multiple choice", [CLIENTS], answered((CLIENTS_Q, "Web,iOS and macOS")), False,
           "iOS, macOS and the web, then. Android waits until it has per-tool cards."),
    "Q5": ("Reply in chat", [SWIPE],
           "Before I pick: does the left swipe still close the sidebar once it's open?", True,
           "It does: once the sidebar is open, a left swipe anywhere on it closes it, as the drawer does on the iPhone."),
}


def events(sid):
    title, questions, result, is_error, after = SESSIONS[sid]
    out, seq = [], 0

    def add(typ, payload, minutes):
        nonlocal seq
        seq += 1
        out.append({"seq": seq, "type": typ, "ts": ago(minutes), "turnId": "t1", "payload": payload})

    add("user", {"text": "On the iPad, a swipe from the left edge does nothing."}, 6)
    add("assistant", {"text": ASKING, "messageId": "m1"}, 5)
    add("tool_use", {"id": "toolu_q", "name": "AskUserQuestion", "input": {"questions": questions}}, 5)
    add("tool_result", {"toolUseId": "toolu_q", "content": result, "isError": is_error}, 2)
    add("assistant", {"text": after, "messageId": "m2"}, 2)
    add("result", {"subtype": "success", "result": "done"}, 2)
    return out


def session(sid):
    title, _, _, _, after = SESSIONS[sid]
    return {"id": sid, "title": title, "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
            "runState": "AWAITING_INPUT", "lifecycleState": "OPEN", "agentId": "a1",
            "agent": {"id": "a1", "name": "a1"}, "assignedRunnerId": "r1", "provider": "claude",
            "model": "claude-opus-5-5", "effort": "max", "permissionMode": "default", "taskId": None,
            "projectId": None, "createdAt": ago(10), "updatedAt": ago(0), "lastTurnAt": ago(2),
            "lastAssistantText": after, "pendingApprovals": 0, "tags": [], "folderId": None, "source": "USER"}


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
            if rest in (["approvals"], ["turns"]):
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
