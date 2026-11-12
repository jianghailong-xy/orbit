#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged), task 34vcF5ruSIhVT0TeMblMY (Translation X3), adapted from task M's
# .tm-probe/stub.py. The conversation T1 is NOT made up: recorded/events-page.json and recorded/turns-active.json are
# what the real apiserver of the project branch (f55897697) answered for a real translated session, driven by a fake
# engine and a stubbed DeepSeek translator (see README.md). This stub replays them, and adds:
#   POST /api/sessions/T1/events/:seq/translation/retry -> {of, lang}, then the live seq-0 `translation` event the
#     server pushes, with the Chinese the real server wrote after its own Retry;
#   POST /__set {"streaming": true} -> the session RUNNING and a live reply streaming (text_delta) under a translated
#     message, as the runner streams one (2A).
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
STARTED = datetime.now(timezone.utc).replace(second=0, microsecond=0)


def ago(minutes, seconds=0):
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
            "status": "ONLINE", "version": "0.1.250", "maxConcurrent": 8, "activeSessions": 1,
            "lastHeartbeatAt": now(), "capabilities": [],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.322", "auth": "yes"}],
            "modelCatalog": {"claude": CLAUDE_MODELS}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


def me():
    return {"id": "u1", "email": "alex@example.com", "name": "Alex", "role": "MEMBER", "createdAt": ago(90 * 24 * 60),
            "preferences": {"theme": "system", "defaultPermissionMode": "auto", "enableOrchestration": True,
                            "translationEnabled": True, "translationLanguage": "zh-Hans"},
            "translationAvailable": STATE["available"]}


def done(original):
    return {"state": "DONE", "from": "zh-Hans", "original": original}


def zh(text):
    return {"lang": "zh-Hans", "text": text}


def ev(seq, typ, turn, payload, ts):
    return {"seq": seq, "type": typ, "ts": ts, "turnId": turn, "payload": payload}


RECORDED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recorded")
EVENTS = json.load(open(os.path.join(RECORDED, "events-page.json"), encoding="utf-8"))["events"]
HELD = json.load(open(os.path.join(RECORDED, "turns-active.json"), encoding="utf-8"))
RETRIED_ZH = "改好了。现在点击会同步打开弹窗，`LoginPage.safari.test.tsx` 覆盖了这个场景。"
STREAM_TURN = "tS"
STREAM_USER = {"seq": 14, "type": "user", "ts": None, "turnId": STREAM_TURN,
               "payload": {"text": "Then merge it into main.",
                           "translation": {"state": "DONE", "from": "zh-Hans", "original": "然后合并到 main"}}}
STREAM_TEXT = "Merging the branch into main now; I'll report when the checks are green."

_UNUSED_FOUND_EN = ("Found it: Safari blocks popups that aren't opened directly by a click. The button calls "
            "`signInWithPopup` only after `await loadGoogleScript()`, which no longer counts as a user gesture.\n\n"
            "Fix: load the script on page load and open the popup synchronously on click. Want me to make the change?")
_UNUSED_FOUND_ZH = ("原因找到了：Safari 会拦截不是由点击直接触发的弹窗。按钮在 `await loadGoogleScript()` 之后才调用 "
            "`signInWithPopup`，这时已经不算用户手势了。\n\n修法：页面加载时预先加载脚本，点击时同步打开弹窗。要我直接改吗？")




def fresh_state():
    return {"available": True, "retried": [], "streaming": False}


STATE = fresh_state()


def run_status():
    return "RUNNING" if STATE.get("streaming") else "AWAITING_INPUT"


def events():
    # A retried reply is stored with its translation, as the real server writes it into the event's payload.
    out = [dict(e, payload=dict(e["payload"], translation={"lang": "zh-Hans", "text": RETRIED_ZH}))
           if e["seq"] in STATE["retried"] else e for e in EVENTS]
    if STATE.get("streaming"):
        out.append(dict(STREAM_USER, ts=now()))
    return out


def held():
    return [t for t in HELD if not (STATE.get("streaming") and t["content"] == "然后合并到 main")]


def session_row():
    return {"id": "T1", "title": "Safari Google 登录", "status": run_status(), "runStatus": run_status(),
            "runState": run_status(), "sessionState": run_status(), "lifecycleState": "OPEN",
            "filingState": "OPEN", "agentId": "a1", "agent": {"id": "a1", "name": "orbit-develop"},
            "assignedRunnerId": "hpc", "provider": "claude", "model": "claude-opus-5-5", "effort": "high",
            "permissionMode": "default", "taskId": None, "taskTitle": None, "projectId": None, "projectTitle": None,
            "createdAt": EVENTS[0]["ts"], "updatedAt": EVENTS[-1]["ts"], "lastTurnAt": EVENTS[-1]["ts"],
            "lastAssistantText": EVENTS[-1]["payload"]["text"], "pendingApprovals": 0, "tags": [], "folderId": None,
            "source": "USER"}


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
        if parts == ["__log"]:
            data = open(LOG, encoding="utf-8").read().encode() if os.path.exists(LOG) else b""
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if parts == ["api", "users", "me"]:
            return self.send(200, me())
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
                     ["api", "task-lists"], ["api", "watches"], ["api", "share-links"], ["api", "projects"],
                     ["api", "users", "me", "tokens"], ["api", "access-tokens"]):
            return self.send(200, [])
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            return self.send(200, [session_row()] if view == "open" else [])
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            if parts[2] != "T1":
                return self.send(404, {"error": "not in the probe"})
            rest = parts[3:]
            if rest == []:
                return self.send(200, session_row())
            if rest == ["events"]:
                return self.stream(int(query.get("sinceSeq", ["0"])[0] or 0))
            if rest == ["events", "page"]:
                return self.send(200, {"events": events(), "hasMore": False})
            if rest == ["turns"]:
                return self.send(200, held())
            if rest in (["approvals"], ["background"]):
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

    def stream(self, sent):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        last_ping = time.time()
        pushed = len(STATE["retried"])
        streamed = 0
        try:
            while True:
                for e in events():
                    if e["seq"] > sent:
                        self.wfile.write(("data: %s\n\n" % json.dumps(e, ensure_ascii=False)).encode())
                        sent = e["seq"]
                for of in STATE["retried"][pushed:]:
                    live = {"seq": 0, "type": "translation", "ts": now(), "turnId": None,
                            "payload": {"of": of, "lang": "zh-Hans", "text": RETRIED_ZH}}
                    self.wfile.write(("data: %s\n\n" % json.dumps(live, ensure_ascii=False)).encode())
                pushed = len(STATE["retried"])
                if STATE.get("streaming") and streamed < len(STREAM_TEXT):
                    chunk = STREAM_TEXT[streamed:streamed + 12]
                    streamed += len(chunk)
                    delta = {"seq": 0, "type": "text_delta", "ts": now(), "turnId": STREAM_TURN, "payload": {"text": chunk}}
                    self.wfile.write(("data: %s\n\n" % json.dumps(delta, ensure_ascii=False)).encode())
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
            STATE.clear()
            STATE.update(fresh_state())
            return self.send(200, {"ok": True})
        if parts == ["__set"]:
            STATE.update(body)
            return self.send(200, STATE)
        if (len(parts) == 7 and parts[:4] == ["api", "sessions", "T1", "events"]
                and parts[5:] == ["translation", "retry"]):
            seq = int(parts[4])
            # The failed reply's Retry: answered at once; its translation follows on the stream (live, seq 0).
            STATE["retried"].append(seq)
            return self.send(201, {"of": seq, "lang": "zh-Hans"})
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

        def server_bind(self):
            import socketserver
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "localhost", self.server_address[1]

    server = LoopbackServer(("127.0.0.1", PORT), Handler)
    print("stub listening on 127.0.0.1:%d (python %s), started %s" % (PORT, sys.version.split()[0], STARTED.isoformat()),
          flush=True)
    server.serve_forever()
