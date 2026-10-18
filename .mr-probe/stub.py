#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API a session's console reads on the
# iPhone and Mac apps, for task 34hJZLqBD1zEjaKfPn6YW (C1 of project 34hIv3wbdtsxpc5RzDlOk; board
# docs/mocks/merge-recovery-repair-loop-ios.html). Nine idle conversations, each with a merge held for
# target recovery and a repair session on it, one per state of the board:
#
#   S1  ① the repair session is running; the last check (14m ago) found two conflicts
#   S2  ② the repair stopped; the server's check of it is under way (mergeStatus pending, action preview)
#   S3  ③ the check after the repair passed: READY, the push's four commits
#   S4  ④ the check found one conflict left: origin/main moved after the repair, which was carried
#   S5  ⑤ the repair stopped with a file unresolved (REPAIR_IN_PROGRESS) and asked the owner something
#   S6  ⑥ every commit of the session is already on origin/main (ALREADY_LANDED) — the board's real data
#   S7  the repair session failed
#   S8  the repair session failed, and the server is checking the recovery after that round
#   S9  ④ with two files left: the footnote's plural, and the Mac drawing it whole
#
# Its data is the board's: the branch, the files, the commits and the local main 2 ahead of origin/main.
# Times are relative to the moment of each request, so "14m ago", "just now" and "2m ago" read as the
# board's. Nothing is pressed: every POST is refused. Every request is logged; anything not served is a 404.
import hashlib
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def ago(seconds):
    return iso(datetime.now(timezone.utc) - timedelta(seconds=seconds))


def whole(seconds):
    """The runner stamps checkedAt in whole seconds (RFC 3339)."""
    t = datetime.now(timezone.utc) - timedelta(seconds=seconds)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def sha(prefix):
    """A full sha that starts with the board's short one."""
    return (prefix + hashlib.sha1(prefix.encode()).hexdigest())[:40]


AGENTS = [{"id": "a1", "name": "orbit-develop", "provider": "claude", "lastProvider": "claude", "runnerId": "hpc",
           "enabled": True, "enableWorktree": True, "effort": "", "workDir": "/root/orbit",
           "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]
CLAUDE_MODELS = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "reasoningLevels": ["low", "medium", "high", "max"]}]


def runner():
    return {"id": "hpc", "name": "workstation-gpu", "displayName": "workstation-gpu", "hostname": "workstation",
            "online": True, "status": "ONLINE", "version": "0.1.240", "maxConcurrent": 8, "activeSessions": 1,
            "lastHeartbeatAt": ago(3), "capabilities": ["session-merge-recovery-v1"],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.300", "auth": "yes"}],
            "modelCatalog": {"claude": CLAUDE_MODELS}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


BRANCH = "orbit/ios-workspace-switch-stale-callbacks-workspace-d0afa0"
SESSION_TITLE = "Switch workspaces without stale session-list callbacks"
REPAIR_TITLE = "解决 main 分支合并恢复"
AGENTS_MODEL = "src/macos/OrbitApp/Sources/OrbitApp/AgentsModel.swift"
WIRING_TESTS = "src/macos/OrbitKit/Tests/OrbitKitTests/SessionListSwitchWiringTests.swift"
WORKTREE = "/home/orbit/.orbit/worktrees/recovery-5971c0de"


def commit(short, subject, author, seconds_ago=None, date=None, merge=None, source=None):
    c = {"sha": sha(short), "subject": subject, "author": author, "date": date or ago(seconds_ago)}
    if merge is not None:
        c["merge"] = merge
    if source:
        c["sourceSha"] = sha(source)
    return c


def local_commits():
    return [commit("749188d8", "feat(suggestions): server-written next-message guess for non-Claude engines",
                   "coordinator", 3 * 3600),
            commit("8a954110", "feat(composer): “Double-tap to use” stays, the learned flag goes",
                   "coordinator", 4 * 3600)]


def remote_commits(n=1):
    pool = [commit("c41d2e07", "Project sessions page: keep the merge row in view", "coordinator", 5 * 3600),
            commit("d2a91f30", "Runner: reclaim superseded recovery checkouts", "coordinator", 50 * 60),
            commit("e7b3c514", "Web: hand Continue repair to the same session", "coordinator", 40 * 60),
            commit("f09d6a21", "Wiki: keep the daily limit exempt set positive", "coordinator", 30 * 60)]
    return pool[:n]


def recovery(code, checked_ago, preview, **extra):
    r = {"code": code, "targetBranch": "main", "repoRoot": "/home/orbit/orbit", "previewId": preview,
         "sourceSha": sha("0032a5e"), "localSha": sha("749188d8"), "remoteSha": sha("c41d2e07"),
         "repairBranch": "orbit/recovery/" + preview, "repairWorktree": WORKTREE,
         "phase": "SOURCE_REPLAY", "localCommits": local_commits(), "remoteCommits": remote_commits(1),
         "checkedAt": whole(checked_ago), "patch": ""}
    r.update(extra)
    return {k: v for k, v in r.items() if v is not None}


def repair(status, last_turn_ago, said=None, error=None):
    return {"id": "R" + status[:3], "title": REPAIR_TITLE, "status": status, "runStatus": status, "runState": status,
            "sessionState": status, "lifecycleState": "OPEN", "error": error, "completedAt": None,
            "lastTurnAt": ago(last_turn_ago), "finishedAt": None, "lastAssistantText": said}


PATCH = """diff --git a/src/macos/OrbitApp/Sources/OrbitApp/AgentsModel.swift b/src/macos/OrbitApp/Sources/OrbitApp/AgentsModel.swift
index 1111111..2222222 100644
--- a/src/macos/OrbitApp/Sources/OrbitApp/AgentsModel.swift
+++ b/src/macos/OrbitApp/Sources/OrbitApp/AgentsModel.swift
@@ -10,3 +10,4 @@
 final class AgentsModel {
-    var onSwitch: () -> Void = {}
+    /// Rebound on every switch, so a stale list never answers.
+    var onSwitch: @MainActor () -> Void = {}
 }
"""


def states():
    """What each parent session's detail says, built at the moment it is read."""
    conflicted = dict(conflicts=[AGENTS_MODEL, WIRING_TESTS])
    return {
        "S1": {"label": "① repair running", "mergeStatus": "error",
               "mergeError": "resolve the SOURCE_REPLAY conflict in the saved repair worktree",
               "recovery": recovery("CONFLICT", 14 * 60, "a1b2c3d4e5f60718293a4b5c6d7e8f90", **conflicted),
               "repair": repair("RUNNING", 3 * 60)},
        "S2": {"label": "② repair stopped, checking", "mergeStatus": "pending", "mergeRecoveryAction": "preview",
               "mergeError": "resolve the SOURCE_REPLAY conflict in the saved repair worktree",
               "recovery": recovery("CONFLICT", 14 * 60, "a1b2c3d4e5f60718293a4b5c6d7e8f90", **conflicted),
               "repair": repair("AWAITING_INPUT", 8)},
        "S3": {"label": "③ check passed", "mergeStatus": "error",
               "mergeError": "review the extra local commits and complete candidate diff before syncing and merging",
               "recovery": recovery("READY", 10, "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
                                    repairBranch="orbit/recovery/a1b2c3d4e5f60718293a4b5c6d7e8f90",
                                    candidateSha=sha("5e6f7a8b"), candidateTreeSha=sha("7a0b1c2d"),
                                    addsMergeCommit=True, patch=PATCH, check={"status": "unconfigured"},
                                    pushCommits=local_commits() + [
                                        commit("5e6f7a8b", "Merge origin/main into main", "Orbit Runner", 10, merge=True),
                                        commit("9f2c1a7e", SESSION_TITLE, "coordinator", 2 * 3600, merge=False)]),
               "repair": repair("AWAITING_INPUT", 40)},
        "S4": {"label": "④ one conflict left", "mergeStatus": "error",
               "mergeError": "resolve the TARGET_SYNC conflict in the saved repair worktree",
               "recovery": recovery("CONFLICT", 10, "b7c8d9e0f1a2b3c4d5e6f708192a3b4c", phase="TARGET_SYNC",
                                    repairBranch="orbit/recovery/a1b2c3d4e5f60718293a4b5c6d7e8f90",
                                    conflicts=[AGENTS_MODEL], remoteCommits=remote_commits(4)),
               "repair": repair("AWAITING_INPUT", 40)},
        "S5": {"label": "⑤ waiting for your reply", "mergeStatus": "error",
               "mergeError": "finish and commit the repair before checking again",
               "recovery": recovery("REPAIR_IN_PROGRESS", 10, "c3d4e5f60718293a4b5c6d7e8f90a1b2",
                                    repairBranch="orbit/recovery/a1b2c3d4e5f60718293a4b5c6d7e8f90",
                                    conflicts=[WIRING_TESTS]),
               "repair": repair("AWAITING_INPUT", 2 * 60 + 5, said="Keep the target’s version?")},
        "S6": {"label": "⑥ already on origin/main", "mergeStatus": "error",
               "mergeError": "every commit of this session is already on origin/main — nothing is left to merge",
               "recovery": recovery("ALREADY_LANDED", 10, "5d1c0ffee5d1c0ffee5d1c0ffee5d1c0", repairBranch=None,
                                    repairWorktree=None, phase=None, patch=None, landedCommits=[
                                        commit("bba5d7b3", "Explicit self in the session-list currency closure",
                                               "coordinator", date="2026-10-11T10:34:12Z", source="0032a5e"),
                                        commit("99cd5459", "Update AgentsModel.swift, SessionListSwitchWiringTests.swift",
                                               "coordinator", date="2026-10-11T09:36:40Z", source="e4b9d0e")]),
               "repair": repair("AWAITING_INPUT", 26 * 3600)},
        "S7": {"label": "repair failed", "mergeStatus": "error",
               "mergeError": "resolve the SOURCE_REPLAY conflict in the saved repair worktree",
               "recovery": recovery("CONFLICT", 6 * 60, "a1b2c3d4e5f60718293a4b5c6d7e8f90", **conflicted),
               "repair": repair("FAILED", 5 * 60, error="The model provider rejected the request")},
        "S8": {"label": "repair failed, checking", "mergeStatus": "pending", "mergeRecoveryAction": "preview",
               "mergeError": "resolve the SOURCE_REPLAY conflict in the saved repair worktree",
               "recovery": recovery("CONFLICT", 6 * 60, "a1b2c3d4e5f60718293a4b5c6d7e8f90", **conflicted),
               "repair": repair("FAILED", 8, error="The model provider rejected the request")},
        "S9": {"label": "④ two conflicts left", "mergeStatus": "error",
               "mergeError": "resolve the TARGET_SYNC conflict in the saved repair worktree",
               "recovery": recovery("CONFLICT", 10, "b7c8d9e0f1a2b3c4d5e6f708192a3b4c", phase="TARGET_SYNC",
                                    repairBranch="orbit/recovery/a1b2c3d4e5f60718293a4b5c6d7e8f90",
                                    conflicts=[AGENTS_MODEL, WIRING_TESTS], remoteCommits=remote_commits(4)),
               "repair": repair("AWAITING_INPUT", 40)},
    }


EVENTS = [
    {"seq": 1, "type": "user", "turnId": "t1", "payload": {"text": "Merge this into main."}},
    {"seq": 2, "type": "assistant", "turnId": "t1",
     "payload": {"text": "The merge is held for target recovery: open the review on the branch bar.", "messageId": "m1"}},
    {"seq": 3, "type": "result", "turnId": "t1", "payload": {"subtype": "success", "result": "done"}},
]


def events():
    stamped = []
    for i, e in enumerate(EVENTS):
        stamped.append(dict(e, ts=ago(3 * 3600 - i)))
    return stamped


def session_row(sid):
    return {"id": sid, "title": SESSION_TITLE, "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
            "runState": "AWAITING_INPUT", "sessionState": "AWAITING_INPUT", "lifecycleState": "OPEN",
            "filingState": "OPEN", "agentId": "a1", "agent": {"id": "a1", "name": "orbit-develop"},
            "assignedRunnerId": "hpc", "provider": "claude", "model": "claude-opus-5-5", "effort": "high",
            "permissionMode": "default", "taskId": None, "projectId": None, "projectTitle": None,
            "projectMembership": None, "createdAt": ago(5 * 3600), "updatedAt": ago(3 * 3600),
            "lastTurnAt": ago(3 * 3600), "lastAssistantText": EVENTS[1]["payload"]["text"], "pendingApprovals": 0,
            "tags": [], "folderId": None, "source": "USER", "branch": BRANCH}


def detail(sid):
    s = states()[sid]
    d = session_row(sid)
    d.update({"isolationStatus": "worktree", "branch": BRANCH, "worktreeBranch": BRANCH, "changedFiles": [],
              "worktreeDirty": False, "mergeStatus": s["mergeStatus"], "mergeError": s["mergeError"],
              "mergeTarget": "main", "mergeTargets": ["main"], "mergeRecovery": s["recovery"],
              "mergeRecoverySupported": True, "mergeRecoveryAction": s.get("mergeRecoveryAction"),
              "mergeRepairTurnEndedAt": None, "mergeRepairSession": s["repair"],
              "workspace": {"id": "a1", "defaultMergeTarget": None}, "agent": {"id": "a1"}, "branchMerged": False,
              "capabilities": None})
    return d


SESSIONS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

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
            f.write("    %s %s BODY %s\n" % (self.command, urlparse(self.path).path, text))
        return text

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        parts = [p for p in url.path.split("/") if p]
        if parts == ["__log"]:
            try:
                text = open(LOG).read()
            except OSError:
                text = ""
            data = text.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if parts == ["__states"]:
            return self.send(200, {sid: detail(sid) for sid in SESSIONS})
        if parts == ["api", "users", "me"]:
            return self.send(200, {"id": "u1", "email": "owner@example.com", "name": "Owner"})
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
            return self.send(200, [session_row(sid) for sid in SESSIONS] if view == "open" else [])
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"] and parts[2] in SESSIONS:
            sid, rest = parts[2], parts[3:]
            if rest == []:
                return self.send(200, detail(sid))
            if rest == ["events"]:
                return self.stream(int(query.get("sinceSeq", ["0"])[0] or 0))
            if rest == ["events", "page"]:
                return self.send(200, {"events": events(), "hasMore": False, "before": None, "after": None})
            if rest in (["turns"], ["approvals"]):
                return self.send(200, [])
            if rest == ["diff"]:
                return self.send(200, {"patches": []})
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

    def stream(self, sent):
        """Replay what follows `sinceSeq` (SSE `data:` frames), then keep the stream alive inside the
        clients' 45 s watchdog."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            for e in events():
                if e["seq"] > sent:
                    self.wfile.write(("data: %s\n\n" % json.dumps(e, ensure_ascii=False)).encode())
            self.wfile.flush()
            while True:
                time.sleep(10)
                self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        self.body()
        if parts == ["__reset"]:
            return self.send(200, {"ok": True})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

    def do_PATCH(self):
        self.body()
        return self.send(404, {"error": "not in the probe"})

    def do_DELETE(self):
        return self.send(404, {"error": "not in the probe"})


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
