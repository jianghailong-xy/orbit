#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the iOS and macOS apps read for
# the prompt optimizer (board docs/mocks/prompt-optimizer/01-board.png). A mode the UI test sets
# before each launch decides the account and what POST /prompt-optimizations answers:
#
#   off          the switch off, the server able (frame 1)
#   unavailable  the server has no DeepSeek key (frame 1b)
#   ok           the switch on, Translation on (Chinese); an optimization answers after HOLD s with
#                the board's frame 4 prompt, its gloss and four "Used:" sources
#   fail         the switch on; an optimization answers 422 PROMPT_OPTIMIZATION_FAILED (frame 6)
#
# Every request is logged; anything not served is a 404 and lands in not-served.txt. All data is
# made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
HOLD = 9


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


MODE = {"name": "ok"}
PREFS = {}


def user():
    mode = MODE["name"]
    prefs = {"theme": "system", "promptSuggestions": True}
    if mode in ("ok", "fail"):
        prefs.update(promptOptimizer=True, translationEnabled=True, translationLanguage="zh-Hans")
    if mode == "off":
        prefs.update(promptOptimizer=False)
    prefs.update(PREFS)
    return {"id": "u1", "email": "owner@example.com", "name": "Owner", "role": "MEMBER",
            "createdAt": ago(90 * 24 * 60), "preferences": prefs,
            "translationAvailable": mode != "unavailable",
            "promptOptimizerAvailable": mode != "unavailable"}


RUNNER = {"id": "r1", "name": "wikova", "displayName": "wikova", "online": True, "status": "ONLINE",
          "version": "0.1.262", "maxConcurrent": 4, "lastHeartbeatAt": ago(0), "capabilities": [],
          "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}]}
AGENT = {"id": "a1", "name": "orbit-web", "provider": "claude", "lastProvider": "claude",
         "runnerId": "r1", "enabled": True, "enableWorktree": True, "effort": "high",
         "lastModel": "claude-opus-5-5",
         "workDir": "/srv/orbit", "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}
C1 = {"id": "C1", "publicId": "C1", "title": "Login redirect fix", "status": "AWAITING_INPUT",
      "runStatus": "AWAITING_INPUT", "runState": "AWAITING_INPUT", "sessionState": "AWAITING_INPUT",
      "agentId": "a1", "assignedRunnerId": "r1", "provider": "claude", "model": "claude-opus-5-5",
      "effort": "high", "permissionMode": "default",
      "createdAt": ago(60), "updatedAt": ago(2), "lastTurnAt": ago(2)}

# Board frame 4: what was added from context is `added`.
OPTIMIZATION = {
    "segments": [
        {"text": "After signing in, users land on the wrong page instead of the page they started from. ",
         "added": False},
        {"text": "The redirect target is meant to come from the `returnTo` query parameter (the session's "
                 "last turn touched `src/web/src/auth/LoginPage.tsx`).", "added": True},
        {"text": "\n\n1. Reproduce: open a protected page signed out, sign in, and note where you land.\n"
                 "2. Find where the post-login redirect is chosen and fix it so it returns to the original page.\n"
                 "3. ", "added": False},
        {"text": "Keep the existing rule that an external `returnTo` URL is refused.", "added": True},
        {"text": "\n4. Add a test that covers the redirect, and run the web tests.", "added": False},
    ],
    "language": "en",
    "gloss": "登录后，用户落在了错误的页面，而不是他们开始时所在的页面。重定向目标应当来自 `returnTo` 查询参数"
             "（本会话上一轮改过 `src/web/src/auth/LoginPage.tsx`）。\n\n"
             "1. 复现：未登录时打开一个受保护页面，登录，记下落在哪里。\n"
             "2. 找到登录后重定向的选择位置并修复，使其回到原页面。\n"
             "3. 保留现有规则：外部的 `returnTo` URL 会被拒绝。\n"
             "4. 添加覆盖该重定向的测试，并运行 web 测试。",
    "contextUsed": [{"kind": "TURNS", "count": 6}, {"kind": "RECAP"},
                    {"kind": "PROJECT", "title": "Auth cleanup"}, {"kind": "WIKI", "count": 2}],
}
OPTIMIZATION["text"] = "".join(s["text"] for s in OPTIMIZATION["segments"])

EMPTY = ["providers", "providers/mine", "providers/pools", "providers/shared-pools", "session-tags",
         "session-folders", "task-lists", "watches", "tasks/active", "tasks/counts", "notifications",
         "wiki/spaces", "projects", "projects/sidebar", "users/me/access-tokens", "terminals",
         "shared-links"]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S.%f")[:-3], fmt % args))

    def note(self, line):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S.%f")[:-3], line))

    def send(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        self.note("BODY %s %s" % (self.path, raw.decode("utf-8", "replace")))
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}

    def do_GET(self):
        path = urlparse(self.path)
        parts = [p for p in path.path.split("/") if p]
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
        if len(parts) == 2 and parts[0] == "__mode":
            MODE["name"] = parts[1]
            PREFS.clear()
            self.note("MODE %s" % parts[1])
            return self.send(200, {"mode": parts[1]})
        if parts == ["api", "events"]:
            return self.stream()
        if parts == ["api", "users", "me"]:
            return self.send(200, user())
        if parts == ["api", "agents"]:
            return self.send(200, [AGENT])
        if parts == ["api", "agents", "a1"]:
            return self.send(200, AGENT)
        if parts == ["api", "runners"]:
            return self.send(200, [RUNNER])
        if parts == ["api", "runners", "r1"]:
            return self.send(200, RUNNER)
        if parts == ["api", "sessions"]:
            return self.send(200, [C1])
        if len(parts) >= 3 and parts[:3] == ["api", "sessions", "C1"]:
            more = parts[3:]
            if more == []:
                return self.send(200, C1)
            if more == ["events", "page"]:
                return self.send(200, {"events": [], "hasMore": False})
            if more == ["events"]:
                return self.send(200, {"items": [], "nextCursor": None, "events": []})
            if more and more[0] in ("retry-message", "capabilities", "owner-confirmation", "watches",
                                    "owner-items", "attribution", "created-tasks", "turns", "approvals",
                                    "background"):
                body = {}
                if more[0] == "owner-items":
                    body = {"needsYou": [], "withCoordinator": []}
                if more[0] in ("turns", "approvals", "background", "watches"):
                    body = []
                return self.send(200, body)
        if parts[:1] == ["api"] and len(parts) >= 2 and "/".join(parts[1:]) in EMPTY:
            return self.send(200, [])
        self.note("NOT SERVED %s" % self.path)
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})

    def stream(self):
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

    def do_PATCH(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self.body()
        if parts == ["api", "users", "me", "preferences"]:
            PREFS.update(body)
            return self.send(200, user())
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if parts == ["__reset"]:
            PREFS.clear()
            return self.send(200, {"ok": True})
        body = self.body()
        if parts == ["api", "prompt-optimizations"]:
            self.note("OPTIMIZE %s" % json.dumps(body, ensure_ascii=False))
            if MODE["name"] == "fail":
                time.sleep(2)
                return self.send(422, {"statusCode": 422, "code": "PROMPT_OPTIMIZATION_FAILED",
                                       "reason": "TIMEOUT", "message": "DeepSeek did not answer in time"})
            time.sleep(HOLD)
            self.note("OPTIMIZE ANSWERED")
            return self.send(200, OPTIMIZATION)
        self.note("NOT A PRESS %s" % self.path)
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe sends nothing"})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def server_bind(self):
        import socketserver
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "localhost", self.server_address[1]


if __name__ == "__main__":
    Server(("127.0.0.1", PORT), Handler).serve_forever()
