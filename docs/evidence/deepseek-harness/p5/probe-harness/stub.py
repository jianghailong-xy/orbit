#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API a DeepSeek Harness session
# touches in the native clients, as a state machine the REAL app drives with its own requests:
#
#   POST /api/sessions                       -> S1 exists, running, one file-write approval pending
#   POST /api/sessions/S1/approvals/ap1/...  -> approved: the write's result, a command and its output
#   POST /api/sessions/S1/interrupt          -> stopped: an `interrupt`, the session waits for input
#   POST /api/sessions/S1/turns              -> resumed: the follow-up and the agent's reply
#
# The events are the shapes the runner's dshEventMapper emits (one event per committed ACP block,
# `messageId` on text/thinking, `toolCallId` on tools) — but nothing here is a real runner or model:
# the stub appends canned events when the app's request arrives. Unavailable states:
#   S3 invalid key (error event), S4 queued on an old runner (session.error), S5 not installed,
#   S6 no key; workspaces a2 (runner r2: no provider:dsh capability) and a3 (runner r3: dsh not
#   installed); POST /__set {"keys":"none"} removes the Harness key (the picker's connect row).
# Every request is logged; anything not served is a 404. All data is made up.
import copy
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


PRO = '["deepseek", "deepseek-v4-pro"]'
FLASH = '["deepseek", "deepseek-v4-flash"]'
DSH_CATALOG = [
    {"value": PRO, "label": "DeepSeek V4 Pro", "reasoningLevels": ["off", "low", "high", "max"],
     "defaultReasoningLevel": "max"},
    {"value": FLASH, "label": "DeepSeek V4 Flash", "reasoningLevels": ["off", "high"]},
]
CLAUDE_CATALOG = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "contextWindow": 1000000,
                   "reasoningLevels": ["low", "medium", "high", "max"]}]


def dsh_health(installed=True, error=None):
    h = {"engine": "dsh", "installed": installed, "auth": "unknown",
         "dsh": {"versionCompatible": True, "credentialPresent": False, "modelCatalogReadable": installed,
                 "requestValidation": "unknown", "sandboxEnforcement": "unknown"}}
    if installed:
        h["version"] = "0.2.0-rc.2"
    if error:
        h["installationError"] = error
    return h


def runner(rid, name, caps, engines):
    return {"id": rid, "name": name, "displayName": name, "online": True, "status": "ONLINE",
            "version": "0.1.212" if caps else "0.1.198", "maxConcurrent": 4, "lastHeartbeatAt": ago(0),
            "capabilities": caps,
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}] + engines,
            "modelCatalog": {"claude": CLAUDE_CATALOG, **({"dsh": DSH_CATALOG} if caps else {})},
            "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


RUNNERS = [
    runner("r1", "hpc", ["provider:dsh", "provider:antigravity"], [dsh_health()]),
    runner("r2", "old-mac", [], []),
    runner("r3", "build-box", ["provider:dsh"], [dsh_health(installed=False)]),
]


def agent(aid, name, rid):
    return {"id": aid, "name": name, "provider": "deepseek-harness", "lastProvider": "deepseek-harness",
            "runnerId": rid, "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/srv/" + name,
            "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}


AGENTS = [agent("a1", "orbit", "r1"), agent("a2", "legacy", "r2"), agent("a3", "builds", "r3")]
HARNESS = {"providerID": "p-dsh", "id": "p-dsh", "slug": "deepseek-harness", "label": "DeepSeek Harness",
           "runtime": "dsh", "models": [], "defaultModel": None, "presetSlug": "deepseek-harness",
           "modelsFromRuntime": True, "enabled": True}
DEEPSEEK = {"providerID": "p-ds", "id": "p-ds", "slug": "deepseek", "label": "DeepSeek", "runtime": "claude",
            "models": [{"value": "deepseek-v4-pro", "label": "DeepSeek V4 Pro", "contextWindow": 1000000}],
            "defaultModel": "deepseek-v4-pro", "presetSlug": "deepseek", "enabled": True}


def session(sid, title, aid, rid, status, minutes, **extra):
    s = {"id": sid, "title": title, "status": status, "runStatus": status, "runState": status,
         "lifecycleState": "OPEN", "agentId": aid, "agent": {"id": aid, "name": aid}, "assignedRunnerId": rid,
         "provider": "deepseek-harness", "model": PRO, "effort": "high", "permissionMode": "default",
         "taskId": None, "projectId": None, "createdAt": ago(minutes), "updatedAt": ago(0),
         "lastTurnAt": ago(0), "lastAssistantText": None, "pendingApprovals": 0, "tags": [], "folderId": None,
         "source": "USER"}
    s.update(extra)
    return s


PROMPT_DEFAULT = "列出仓库根目录，并加一个 NOTES.md 记下你看到了什么"
STATE = {}


def reset():
    STATE.update(stage=None, keys="harness", prompt=PROMPT_DEFAULT, followup="继续：把 NOTES.md 再补一行测试命令",
                 created=None)


reset()


def ev(seq, typ, turn, payload, minutes=0):
    return {"seq": seq, "type": typ, "ts": ago(minutes), "turnId": turn, "payload": payload}


def s1_events():
    stage = STATE["stage"]
    if stage is None:
        return []
    out = [
        ev(1, "user", "t1", {"text": STATE["prompt"]}, 4),
        ev(2, "thinking", "t1", {"text": "先看根目录有什么，再写 NOTES.md。写文件需要征得同意（Default 模式下文件只读）。",
                                  "messageId": "m1"}, 4),
        ev(3, "assistant", "t1", {"text": "我先列一下仓库根目录。", "messageId": "m2"}, 4),
        ev(4, "tool_use", "t1", {"id": "c1", "toolCallId": "c1", "name": "bash", "input": {"command": "ls"},
                                 "kind": "execute", "status": "pending"}, 4),
        ev(5, "tool_result", "t1", {"toolUseId": "c1", "toolCallId": "c1", "status": "completed",
                                    "content": "AGENTS.md\nREADME.md\ndocs\nsrc", "isError": False}, 4),
        ev(6, "assistant", "t1", {"text": "根目录有 AGENTS.md、README.md、docs 和 src。现在写 NOTES.md。",
                                  "messageId": "m3"}, 3),
        ev(7, "tool_use", "t1", {"id": "c2", "toolCallId": "c2", "name": "write_file",
                                 "input": {"path": "NOTES.md", "content": "# Notes\n\nRoot: AGENTS.md, README.md, docs, src\n"},
                                 "kind": "edit", "status": "pending"}, 3),
    ]
    if stage in ("allowed", "stopped", "resumed"):
        out += [
            ev(8, "tool_result", "t1", {"toolUseId": "c2", "toolCallId": "c2", "status": "completed",
                                        "content": "Wrote NOTES.md (52 bytes)", "isError": False}, 2),
            ev(9, "thinking", "t1", {"text": "写好了。顺手跑一下测试确认没有破坏什么。", "messageId": "m4"}, 2),
            ev(10, "tool_use", "t1", {"id": "c3", "toolCallId": "c3", "name": "bash",
                                      "input": {"command": "npm test -w @orbit/shared"}, "kind": "execute",
                                      "status": "in_progress"}, 2),
        ]
    if stage in ("stopped", "resumed"):
        out += [
            ev(11, "tool_result", "t1", {"toolUseId": "c3", "toolCallId": "c3", "status": "failed",
                                         "content": "Interrupted", "isError": True}, 1),
            ev(12, "interrupt", "t1", {}, 1),
        ]
    if stage == "resumed":
        out += [
            ev(13, "user", "t2", {"text": STATE["followup"]}, 0),
            ev(14, "thinking", "t2", {"text": "上一轮在跑测试时被停下；NOTES.md 已写好，只需追加一行。", "messageId": "m5"}, 0),
            ev(15, "assistant", "t2", {"text": "已在 NOTES.md 末尾加上测试命令 `npm test -w @orbit/shared`。上一轮的测试被你停止了，没有重跑。",
                                       "messageId": "m6"}, 0),
            ev(16, "result", "t2", {"subtype": "success", "result": "done"}, 0),
        ]
    return out


def s1():
    stage = STATE["stage"]
    status = {"approval": "RUNNING", "allowed": "RUNNING"}.get(stage, "AWAITING_INPUT")
    return session("S1", "列出仓库并写 NOTES.md", "a1", "r1", status, 4,
                   permissionMode=(STATE["created"] or {}).get("permissionMode") or "default",
                   pendingApprovals=1 if stage == "approval" else 0,
                   lastAssistantText="根目录有 AGENTS.md、README.md、docs 和 src。")


OTHERS = {
    "S3": (session("S3", "Invalid key", "a1", "r1", "FAILED", 30, permissionMode="auto"), [
        ev(1, "user", "t1", {"text": "总结一下 README"}, 30),
        ev(2, "error", "t1", {"message": "dsh session/prompt (-32603): Invalid API key (status 401 authentication_error)"}, 30),
    ]),
    "S4": (session("S4", "Old runner", "a2", "r2", "PENDING", 20, permissionMode="dontAsk",
                   error="DeepSeek Harness requires a newer Orbit runner with dsh support; update this runner first"), []),
    "S5": (session("S5", "Not installed", "a3", "r3", "FAILED", 15), [
        ev(1, "user", "t1", {"text": "跑一下构建"}, 15),
        ev(2, "error", "t1", {"message": "DSH_NOT_INSTALLED: DeepSeek Harness 0.2.0-rc.2 is not installed in Orbit's version directory; automatic engine installation is not authorized — install it from Orbit or run `orbit doctor` on this runner"}, 15),
    ]),
    "S6": (session("S6", "No key", "a1", "r1", "FAILED", 10), [
        ev(1, "user", "t1", {"text": "看看 CI 为什么红"}, 10),
        ev(2, "error", "t1", {"message": "DSH_CREDENTIAL_MISSING: configure a DeepSeek Harness API key for this session; runner and workspace .env credentials are not used"}, 10),
    ]),
}


def sessions_list():
    out = [s1()] if STATE["stage"] else []
    return out + [s for s, _ in OTHERS.values()]


def providers():
    return [DEEPSEEK] if STATE["keys"] == "none" else [HARNESS, DEEPSEEK]


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
        if len(parts) == 3 and parts[:2] == ["api", "agents"]:
            found = [a for a in AGENTS if a["id"] == parts[2]]
            return self.send(200, found[0]) if found else self.send(404, {"error": "no agent"})
        if parts == ["api", "runners"]:
            return self.send(200, RUNNERS)
        if len(parts) == 3 and parts[:2] == ["api", "runners"]:
            found = [r for r in RUNNERS if r["id"] == parts[2]]
            return self.send(200, found[0]) if found else self.send(404, {"error": "no runner"})
        if parts in (["api", "providers"], ["api", "providers", "mine"]):
            return self.send(200, providers())
        if parts in (["api", "providers", "pools"], ["api", "providers", "shared-pools"],
                     ["api", "session-tags"], ["api", "session-folders"], ["api", "task-lists"],
                     ["api", "watches"], ["api", "share-links"]):
            return self.send(200, [])
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            return self.send(200, sessions_list() if view == "open" else [])
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "events":
            return self.stream(parts[2], int(query.get("sinceSeq", ["0"])[0] or 0))
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            sid, rest = parts[2], parts[3:]
            known = sid == "S1" and STATE["stage"]
            row, events = (s1(), s1_events()) if known else OTHERS.get(sid, (None, []))
            if row is None:
                return self.send(404, {"error": "not in the probe"})
            if rest == []:
                return self.send(200, row)
            if rest == ["events", "page"]:
                return self.send(200, {"events": events, "hasMore": False, "before": None, "after": None})
            if rest == ["approvals"]:
                pending = sid == "S1" and STATE["stage"] == "approval"
                return self.send(200, [{"id": "ap1", "toolName": "write_file", "status": "PENDING",
                                        "input": {"path": "NOTES.md",
                                                  "content": "# Notes\n\nRoot: AGENTS.md, README.md, docs, src\n"}}]
                                 if pending else [])
            if rest == ["turns"]:
                return self.send(200, [])
            if rest == ["share"]:
                return self.send(200, {"link": None, "counts": {"messages": 2, "toolCalls": 0}})
            return self.send(404, {"error": "not in the probe"})
        return self.send(404, {"error": "not in the probe"})

    def stream(self, sid, sent):
        """Replay what follows `sinceSeq`, then push each event the state machine adds (SSE `data:`
        frames, the server's own framing), with a keepalive inside the clients' 45 s watchdog."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        last_ping = time.time()
        try:
            while True:
                events = s1_events() if sid == "S1" and STATE["stage"] else OTHERS.get(sid, (None, []))[1]
                for e in events:
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
            reset()
            return self.send(200, {"ok": True})
        if parts == ["__set"]:
            for key in ("stage", "keys"):
                if key in body:
                    STATE[key] = body[key]
            return self.send(200, STATE)
        if parts == ["api", "sessions"]:
            STATE["stage"] = "approval"
            STATE["created"] = body
            if body.get("prompt"):
                STATE["prompt"] = body["prompt"]
            return self.send(201, s1())
        if parts[:3] == ["api", "sessions", "S1"]:
            rest = parts[3:]
            if rest == ["approvals", "ap1", "decision"]:
                if body.get("decision", body.get("behavior", "allow")) in ("allow", "approve", "ALLOW", "APPROVE"):
                    STATE["stage"] = "allowed"
                return self.send(200, {"ok": True})
            if rest == ["interrupt"]:
                STATE["stage"] = "stopped"
                return self.send(200, {"ok": True})
            if rest == ["turns"]:
                STATE["stage"] = "resumed"
                if body.get("content"):
                    STATE["followup"] = body["content"]
                return self.send(201, {"turnId": "t2", "seq": 13, "status": "PENDING", "kind": "message"})
        if len(parts) == 4 and parts[:2] == ["api", "runners"] and parts[3] == "install":
            return self.send(201, {"status": "pending", "engine": body.get("engine"), "command": None,
                                   "message": None, "mode": "install"})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    def do_PATCH(self):
        self.body()
        return self.send(404, {"error": "not in the probe"})

    def do_PUT(self):
        self.body()
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
