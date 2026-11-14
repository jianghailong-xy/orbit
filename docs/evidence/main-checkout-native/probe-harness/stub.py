#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged), task 34vZvzdK0NZaSo0JNQ2ES: the slice of the Orbit API the iPhone and Mac
# apps read for the main checkout card, bar, review sheet, result lines and worktree isolation dialogs
# (docs/main-checkout-git-contract.md, docs/mocks/main-checkout-git/). Adapted from the coordinator-delivery-line
# probe's stub. The result lines and the changed card are the shared fixture's own
# (src/shared/src/main-checkout-git.fixture.json), so the lines on screen are the ones the server writes.
#
#   a1 "orbit"         worktree isolation on, its main checkout /root/orbit dirty (3 files), runner can act
#   a2 "orbit-shared"  worktree isolation off, /root/shared dirty (3 files): the Shared bar and dialog A
#   W1 (a1)  "Fix retry backoff": a worktree turn, then the main-checkout-changed card
#   R1 (a1)  "Bump eslint to 9": four success lines (move, commit, push, rescue)
#   R2 (a1)  "Migrate settings table": refusal lines (stale, conflict, push rejected, auth, blocked, waiting)
#   S1 (a2)  "Tidy the README": a Shared session
# Writes are logged and answered as accepted (pending); nothing changes. Anything not served is a 404.
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
FIX = json.load(open(os.path.join(HERE, "..", "src", "shared", "src", "main-checkout-git.fixture.json"), encoding="utf-8"))
STARTED = datetime.now(timezone.utc).replace(second=0, microsecond=0)


def ago(minutes, seconds=0):
    t = STARTED - timedelta(minutes=minutes) + timedelta(seconds=seconds)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def now(minus_seconds=0):
    t = datetime.now(timezone.utc) - timedelta(seconds=minus_seconds)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


HEAD = "62325fb4a1c0d3e5f6a7b8c9d0e1f2a3b4c5d6e7"
FP = FIX["changedNotice"]["fingerprint"]
FILES = [
    {"path": "src/api/client.ts", "status": "M", "contentHash": "2b87b8036e28de13d83f3972f3dc8e469e723903", "additions": 12, "deletions": 3},
    {"path": "src/api/retry.test.ts", "status": "A", "contentHash": "7f1c0e2d1b3a4c5d6e7f8091a2b3c4d5e6f70812", "untracked": True, "additions": 58, "deletions": 0},
    {"path": "src/api/retry.ts", "status": "A", "contentHash": "9a8b7c6d5e4f30211203f4e5d6c7b8a9f0e1d2c3", "untracked": True, "additions": 41, "deletions": 0},
]
PATCHES = {
    "src/api/client.ts": "@@ -18,9 +18,18 @@ export async function request(path, init) {\n   const url = new URL(path, base);\n"
                         "-  for (let i = 0; i < 5; i++) {\n-    const res = await fetch(url, init);\n-    if (res.status !== 429) return res;\n"
                         "+  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {\n+    const res = await fetch(url, init);\n"
                         "+    if (res.status !== 429) return res;\n+    await sleep(backoff(attempt, res.headers.get('retry-after')));\n"
                         "   }\n   throw new RateLimitError(url);\n",
    "src/api/retry.ts": "@@ -0,0 +1,6 @@\n+export const MAX_ATTEMPTS = 6;\n+\n+export function backoff(attempt: number, retryAfter?: string | null) {\n"
                        "+  const base = retryAfter ? Number(retryAfter) * 1000 : 250 * 2 ** attempt;\n+  return base + Math.random() * 100;\n+}\n",
    "src/api/retry.test.ts": "@@ -0,0 +1,4 @@\n+import { backoff } from './retry';\n+\n+test('backs off', () => expect(backoff(2)).toBeGreaterThan(999));\n+\n",
}


def health(root, files, ahead):
    return {"root": root, "branch": "main", "state": "dirty" if files else "clean", "paths": [f["path"] for f in FILES][:files],
            "head": HEAD, "upstream": "origin/main", "ahead": ahead, "behind": 0, "fileCount": files,
            "truncated": False, "fingerprint": FP}


AGENTS = [
    {"id": "a1", "name": "orbit", "provider": "claude", "lastProvider": "claude", "runnerId": "hpc", "enabled": True,
     "enableWorktree": True, "effort": "", "workDir": "/root/orbit", "appendSystemPrompt": "", "workDirExists": True,
     "workDirIsGit": True, "repoHealth": health("/root/orbit", 3, 0), "mainCheckoutActions": True},
    {"id": "a2", "name": "orbit-shared", "provider": "claude", "lastProvider": "claude", "runnerId": "hpc",
     "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/root/shared", "appendSystemPrompt": "",
     "workDirExists": True, "workDirIsGit": True, "repoHealth": health("/root/shared", 3, 0), "mainCheckoutActions": True},
]
CLAUDE_MODELS = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "reasoningLevels": ["low", "medium", "high", "max"]}]


def runner():
    return {"id": "hpc", "name": "orbit-hpc", "displayName": "orbit-hpc", "hostname": "workstation", "online": True,
            "status": "ONLINE", "version": "0.1.249", "maxConcurrent": 8, "activeSessions": 0,
            "lastHeartbeatAt": now(), "capabilities": ["main-checkout-git/v1"],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}],
            "modelCatalog": {"claude": CLAUDE_MODELS}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


def ev(seq, typ, turn, payload, ts):
    return {"seq": seq, "type": typ, "ts": ts, "turnId": turn, "payload": payload}


def exchange(seq, turn, ask, ask_at, reply, reply_at):
    return [ev(seq, "user", turn, {"text": ask}, ask_at),
            ev(seq + 1, "assistant", turn, {"text": reply, "messageId": f"m{seq}"}, reply_at),
            ev(seq + 2, "result", turn, {"subtype": "success", "result": "done"}, reply_at)]


def result_line(seq, name, ts, session):
    sample = next(r for r in FIX["results"] if r["name"] == name)
    result = dict(sample["result"])
    if result.get("targetSessionId"):
        result["targetSessionId"] = session
    return ev(seq, "system", None, {"noticeKind": "main-checkout-action-result", "notice": sample["text"], "result": result}, ts)


SESSIONS = {
    "W1": {"title": "Fix retry backoff", "agent": "a1", "branch": "orbit/fix-retry-backoff", "iso": "worktree",
           "events": exchange(1, "t1", "The retry loop hammers the API after a 429 — give it real backoff.", ago(9),
                              "Added exponential backoff with jitter to the client and a test for the 429 path.", ago(6))
           + [ev(4, "system", None, FIX["changedNotice"], ago(6))]},
    "R1": {"title": "Bump eslint to 9", "agent": "a1", "branch": "orbit/bump-eslint", "iso": "worktree",
           "events": exchange(1, "t1", "Bump eslint to 9 and fix what it flags.", ago(40), "Done: eslint 9, flat config, two fixes.", ago(35))
           + [result_line(4, "move done", ago(30), "R1"), result_line(5, "commit done", ago(25), "R1"),
              result_line(6, "push done", ago(20), "R1"), result_line(7, "rescue done", ago(15), "R1")]},
    "R2": {"title": "Migrate settings table", "agent": "a1", "branch": "orbit/settings-v2", "iso": "worktree",
           "events": exchange(1, "t1", "Move the settings table to v2.", ago(50), "Migration written and tested.", ago(45))
           + [result_line(4, "FINGERPRINT_STALE", ago(30), "R2"), result_line(5, "MOVE_CONFLICT", ago(26), "R2"),
              result_line(6, "PUSH_REJECTED", ago(22), "R2"), result_line(7, "PUSH_AUTH_FAILED", ago(18), "R2"),
              result_line(8, "CHECKOUT_BLOCKED", ago(14), "R2"), result_line(9, "RUNNER_OFFLINE", ago(10), "R2")]},
    "S1": {"title": "Tidy the README", "agent": "a2", "branch": None, "iso": None,
           "events": exchange(1, "t1", "Tidy the README's install section.", ago(20), "Rewrote the install section and fixed two links.", ago(18))},
}


def session_row(sid):
    s = SESSIONS[sid]
    said = [e for e in s["events"] if e["type"] == "assistant"]
    last = said[-1]
    agent = next(a for a in AGENTS if a["id"] == s["agent"])
    return {"id": sid, "title": s["title"], "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
            "runState": "AWAITING_INPUT", "sessionState": "AWAITING_INPUT", "lifecycleState": "OPEN",
            "filingState": "OPEN", "agentId": s["agent"], "agent": {"id": s["agent"], "name": agent["name"]},
            "workspace": {"id": s["agent"]}, "assignedRunnerId": "hpc", "provider": "claude",
            "model": "claude-opus-5-5", "effort": "high", "permissionMode": "default", "taskId": None,
            "projectId": None, "branch": s["branch"], "isolationStatus": s["iso"], "changedFiles": [],
            "worktreeDirty": False, "createdAt": s["events"][0]["ts"], "updatedAt": last["ts"],
            "lastTurnAt": last["ts"], "lastAssistantText": last["payload"].get("text", ""), "pendingApprovals": 0,
            "tags": [], "folderId": None, "source": "USER"}


def main_checkout(ws, diffs):
    agent = next(a for a in AGENTS if a["id"] == ws)
    root = agent["workDir"]
    snapshot = {"root": root, "branch": "main", "head": HEAD, "state": "dirty", "upstream": "origin/main",
                "ahead": 0, "behind": 0, "files": FILES, "fileCount": 3, "truncated": False,
                "fingerprint": FP, "checkedAt": now(12)}
    return {"snapshot": snapshot,
            "diffs": [{"path": p, "binary": False, "patch": PATCHES[p]} for p in diffs if p in PATCHES],
            "actionsSupported": True,
            "managedBranch": {"projectId": "P1", "projectTitle": "Runner link v1", "role": "landing-target"} if ws == "a1" else None,
            "inFlight": None}


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
        if parts in (["api", "agents"], ["api", "workspaces"]):
            return self.send(200, AGENTS)
        if len(parts) == 3 and parts[:2] in (["api", "agents"], ["api", "workspaces"]):
            a = next((a for a in AGENTS if a["id"] == parts[2]), None)
            return self.send(200, a) if a else self.send(404, {"error": "no"})
        if len(parts) == 4 and parts[:2] in (["api", "agents"], ["api", "workspaces"]) and parts[3] == "main-checkout":
            return self.send(200, main_checkout(parts[2], query.get("diff", [])))
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
            agent = query.get("agentId", [None])[0]
            rows = [session_row(s) for s in SESSIONS if agent in (None, SESSIONS[s]["agent"])]
            return self.send(200, rows if view == "open" else [])
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"] and parts[2] in SESSIONS:
            s = SESSIONS[parts[2]]
            rest = parts[3:]
            if rest == []:
                return self.send(200, session_row(parts[2]))
            if rest == ["events"]:
                return self.stream(s, int(query.get("sinceSeq", ["0"])[0] or 0))
            if rest == ["events", "page"]:
                return self.send(200, {"events": s["events"], "hasMore": False, "before": None, "after": None})
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

    def stream(self, s, sent):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        last_ping = time.time()
        try:
            while True:
                for e in s["events"]:
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
        body = self.body()
        if parts == ["__reset"]:
            return self.send(200, {"ok": True})
        if len(parts) >= 5 and parts[3] == "main-checkout" and parts[4] == "actions":
            return self.send(200, {"requestId": body.get("requestId", parts[-2] if len(parts) > 5 else "r"), "status": "pending"})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING", "message": "the probe does not change anything"})

    def do_PATCH(self):
        body = self.body()
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if len(parts) == 3 and parts[:2] in (["api", "agents"], ["api", "workspaces"]):
            a = next((a for a in AGENTS if a["id"] == parts[2]), None)
            if a:
                return self.send(200, a)
        return self.send(404, {"error": "not in the probe"})

    def do_DELETE(self):
        self.body()
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING", "message": "the probe does not change anything"})


if __name__ == "__main__":
    class LoopbackServer(ThreadingHTTPServer):
        daemon_threads = True

        def server_bind(self):
            import socketserver
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "localhost", self.server_address[1]

    server = LoopbackServer(("127.0.0.1", PORT), Handler)
    print("stub listening on 127.0.0.1:%d, started %s" % (PORT, STARTED.isoformat()), flush=True)
    server.serve_forever()
