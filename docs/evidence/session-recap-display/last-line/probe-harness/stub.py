#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API a conversation at rest reads on the iPhone and
# Mac apps, for the recap card's one ⋯ at the end of its last line (docs/mocks/session-recap-display/07-last-line,
# the owner's B, 2026-11-02). Adapted from docs/evidence/coordinator-delivery-line/probe-harness/stub.py. Three
# conversations, each parked on the agent's answer with a recap the server wrote:
#
#   R1  a long recap, as long as the one on the owner's screenshot: three lines on an iPhone either way
#   R2  a medium recap: two lines on an iPhone now that the words run the full width
#   R3  an English recap, for the Mac window's narrow console
#
# The account's preferences are not served, so Session recaps reads on, its default. Times are minutes before the
# stub started, and the app runs at TZ=Asia/Shanghai. Every request is logged; anything not served is a 404, and
# every write a 409. All data is made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
STARTED = datetime.now(timezone.utc).replace(second=0, microsecond=0)


def ago(minutes, seconds=0):
    """An instant `minutes` before the stub started, the way the server spells one."""
    t = STARTED - timedelta(minutes=minutes) + timedelta(seconds=seconds)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def now():
    t = datetime.now(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


AGENTS = [{"id": "a1", "name": "orbit-develop", "provider": "claude", "lastProvider": "claude", "runnerId": "hpc",
           "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/root/orbit",
           "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]
CLAUDE_MODELS = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "reasoningLevels": ["low", "medium", "high", "max"]}]


def runner():
    return {"id": "hpc", "name": "HPC", "displayName": "HPC", "hostname": "workstation", "online": True,
            "status": "ONLINE", "version": "0.1.241", "maxConcurrent": 8, "activeSessions": 1,
            "lastHeartbeatAt": now(), "capabilities": [],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}],
            "modelCatalog": {"claude": CLAUDE_MODELS}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


def ev(seq, typ, turn, payload, ts):
    return {"seq": seq, "type": typ, "ts": ts, "turnId": turn, "payload": payload}


def exchange(seq, turn_id, ask, ask_at, reply, reply_at):
    return [ev(seq, "user", turn_id, {"text": ask}, ask_at),
            ev(seq + 1, "assistant", turn_id, {"text": reply, "messageId": f"m{seq}"}, reply_at),
            ev(seq + 2, "result", turn_id, {"subtype": "success", "result": "done"}, reply_at)]


SESSIONS = {
    "R1": {"title": "Disk cleanup",
           "recap": "已删10个旧模型仓库，释放258G，剩余319G；保留的3个模型和vLLM服务复核正常，下一步清164个worktree。",
           "events": exchange(1, "t1", "磁盘快满了，旧模型仓库能删的先删。", ago(24),
                              "已删 10 个旧模型仓库，释放 258G，剩余 319G。保留的 3 个模型和 vLLM 服务我都复核过，运行正常。"
                              "\n\n另外 164 个 worktree 里有 120 个对应的任务早已完成，这一批还没动。"
                              "\n\n下一步：要不要我先把这 120 个 worktree 列个清单给你确认，再删？", ago(20))},
    "R2": {"title": "Worktree cleanup",
           "recap": "120 个已完成任务的 worktree 已删，释放 41G；剩下 44 个还在用，清单已发你确认。",
           "events": exchange(1, "t1", "可以，先删那 120 个。", ago(14),
                              "删掉 120 个 worktree，释放 41G；剩下 44 个都还有会话在用。"
                              "\n\n下一步：这 44 个的清单在上面，哪些可以一起清，你定。", ago(11))},
    "R3": {"title": "Login redirect",
           "recap": "Fixed the login redirect after sign-in; the web and iOS tests pass, and the fix now waits for you.",
           "events": exchange(1, "t1", "Signing in drops me on the home page instead of where I was.", ago(9),
                              "Fixed: the sign-in page now keeps the page you came from and sends you back to it. "
                              "The web and iOS tests pass.\n\nNext: review the change when you have a minute.", ago(6))},
}


def session_row(sid, s):
    last = [e for e in s["events"] if e["type"] == "assistant"][-1]
    return {"id": sid, "title": s["title"], "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
            "runState": "AWAITING_INPUT", "sessionState": "AWAITING_INPUT", "lifecycleState": "OPEN",
            "filingState": "OPEN", "agentId": "a1", "agent": {"id": "a1", "name": "orbit-develop"},
            "assignedRunnerId": "hpc", "provider": "claude", "model": "claude-opus-5-5", "effort": "high",
            "permissionMode": "default", "taskId": None, "projectId": None,
            "createdAt": s["events"][0]["ts"], "updatedAt": last["ts"], "lastTurnAt": last["ts"],
            "lastAssistantText": last["payload"]["text"], "recapText": s["recap"], "recapAt": ago(4),
            "pendingApprovals": 0, "tags": [], "folderId": None, "source": "USER"}


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
        with open(LOG, "a") as f:
            f.write("    %s %s body: %s\n" % (self.command, urlparse(self.path).path, raw.decode("utf-8", "replace")))

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
            return self.send(200, [session_row(sid, s) for sid, s in SESSIONS.items()] if view == "open" else [])
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"] and parts[2] in SESSIONS:
            sid, s = parts[2], SESSIONS[parts[2]]
            rest = parts[3:]
            if rest == []:
                return self.send(200, session_row(sid, s))
            if rest == ["events"]:
                return self.stream(s, int(query.get("sinceSeq", ["0"])[0] or 0))
            if rest == ["events", "page"]:
                return self.send(200, {"events": s["events"], "hasMore": False, "before": None, "after": None})
            if rest in (["turns"], ["approvals"]):
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

    def stream(self, s, sent):
        """Replay what follows `sinceSeq` (SSE `data:` frames, the server's framing), then keep the
        stream alive inside the clients' 45 s watchdog."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            for e in s["events"]:
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
    print("stub listening on 127.0.0.1:%d (python %s), started %s" % (PORT, sys.version.split()[0], STARTED.isoformat()),
          flush=True)
    server.serve_forever()
