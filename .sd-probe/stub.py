#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the iPhone and Mac session lists and one
# conversation read, for task 353SkITm4HyfRI5bDGMlh (project 353SgnUjvamRr06Sho0EZ). Adapted from
# docs/evidence/criteria-reply-session-line/probe-harness/stub.py.
#
# The rows are the board's (docs/mocks/session-display-three-states): the comparison rig's fixture payloads, one per
# case, in the board's order, with the board's titles, preview lines and times. `POST /__set {"facts": false}` serves
# each case's facts-absent twin instead (the older server), which must draw exactly what the app drew before.
# Every request is logged; anything not served is a 404; every write is refused. All data is made up.
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
FIXTURE = json.load(open(os.path.join(HERE, "..", "docs", "mocks", "session-display-three-states", "fixture.json"),
                         encoding="utf-8"))
BY_ROW = {r["row"]: r for r in FIXTURE}
STARTED = datetime.now(timezone.utc).replace(second=0, microsecond=0)

CASES = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35]
TITLES = {
    1: 'Translate the help pages', 3: 'Fix the login redirect', 5: 'Tidy the settings page', 7: 'Sketch the onboarding flow',
    9: 'Task: Add the export button', 11: 'Upgrade the date library', 13: 'Draft the release notes', 15: 'Run the full test suite',
    17: 'Clean up old branches', 19: 'Index the wiki', 21: 'Profile the slow query', 23: 'Rename the CLI flags',
    25: 'Review the API errors', 27: 'Nightly build report', 29: 'Split the settings module', 31: 'Watch the nightly build',
    33: 'Old runner session', 35: 'Old runner session (released)',
}
# What the person last said (shown as "You: ...") or what the agent last replied.
USER_LINES = {7: 'Add a step for the invite.', 11: 'Upgrade it and run the tests.', 25: 'Check the 4xx mapping.'}
REPLIES = {
    5: 'Done: the three toggles now share one switch.', 9: 'The export button is in, with its test.',
    13: 'The notes are in docs/releases.', 21: 'The slow part is the join on tags.',
    23: 'Renamed, and the old names still work.', 33: 'The cache is warm now.', 35: 'The cache is warm now.',
}
MINUTES = [0, 1, 2, 4, 6, 9, 15, 22, 30, 36, 45, 50, 60, 120, 180, 300, 1440, 2880]


def ago(minutes):
    t = STARTED - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def now():
    t = datetime.now(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


AGENTS = [{"id": "a1", "name": "orbit-ws01", "provider": "claude", "lastProvider": "claude", "runnerId": "hpc",
           "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/root/orbit",
           "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]
CLAUDE_MODELS = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "reasoningLevels": ["low", "medium", "high", "max"]}]


def runner():
    return {"id": "hpc", "name": "HPC", "displayName": "HPC", "hostname": "workstation", "online": True,
            "status": "ONLINE", "version": "0.1.242", "maxConcurrent": 8, "activeSessions": 1,
            "lastHeartbeatAt": now(), "capabilities": [],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}],
            "modelCatalog": {"claude": CLAUDE_MODELS}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


STATE = {"facts": True}


def session_row(case):
    i = CASES.index(case)
    payload = dict(BY_ROW[case if STATE["facts"] else case + 1]["payload"])
    at = ago(MINUTES[i])
    payload.update({
        "id": "S%02d" % case, "title": TITLES[case], "agentId": "a1", "agent": {"id": "a1", "name": "orbit-ws01"},
        "assignedRunnerId": "hpc", "provider": "claude", "model": "claude-opus-5-5", "effort": "high",
        "permissionMode": "default", "createdAt": ago(MINUTES[i] + 5), "updatedAt": at, "lastTurnAt": at,
        "lastAssistantText": REPLIES.get(case), "lastUserText": USER_LINES.get(case),
        "pendingApprovals": payload.get("pendingApprovals", 0), "tags": [], "folderId": None, "source": "USER",
        "lifecycleState": payload.get("lifecycleState", "OPEN"),
    })
    if case == 9:
        payload.update({"taskId": "T09", "taskTitle": "Add the export button"})
    return payload


def by_id(sid):
    for case in CASES:
        if "S%02d" % case == sid:
            return case
    return None


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
                     ["api", "task-lists"], ["api", "watches"], ["api", "share-links"], ["api", "projects"]):
            return self.send(200, [])
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            rows = [session_row(c) for c in CASES]
            return self.send(200, rows if view == "open" else [])
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            case = by_id(parts[2])
            if case is None:
                return self.send(404, {"error": "not in the probe"})
            rest = parts[3:]
            if rest == []:
                return self.send(200, session_row(case))
            if rest == ["events"]:
                return self.keepalive()
            if rest == ["events", "page"]:
                return self.send(200, {"events": [], "hasMore": False, "before": None, "after": None})
            if rest in (["turns"], ["approvals"]):
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

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self.body()
        if parts == ["__reset"]:
            STATE.clear()
            STATE.update({"facts": True})
            return self.send(200, {"ok": True})
        if parts == ["__set"]:
            STATE.update(body)
            return self.send(200, STATE)
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

        def server_bind(self):
            import socketserver
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "localhost", self.server_address[1]

    server = LoopbackServer(("127.0.0.1", PORT), Handler)
    print("stub listening on 127.0.0.1:%d (python %s), started %s" % (PORT, sys.version.split()[0], STARTED.isoformat()),
          flush=True)
    server.serve_forever()
