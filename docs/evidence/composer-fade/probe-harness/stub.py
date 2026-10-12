#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API one idle conversation needs in
# the native clients — a workspace on one runner and session S1, whose transcript is long enough to
# scroll, so the edge between the transcript and the composer can be photographed at its tail and
# scrolled up. Agents, runners and providers are the DeepSeek Harness probe's
# (docs/evidence/deepseek-harness/p5/probe-harness/stub.py), which the console is known to draw.
# Every request is logged; anything not served is a 404. All data is made up.
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
METRICS = os.path.join(os.path.dirname(os.path.abspath(LOG)), "metrics.log")


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


def runner(rid, name):
    # Stamped per request: the clients call a machine offline once its heartbeat is 90 s old.
    return {"id": rid, "name": name, "displayName": name, "online": True, "status": "ONLINE",
            "version": "0.1.226", "maxConcurrent": 4, "lastHeartbeatAt": ago(0),
            "capabilities": ["provider:dsh", "provider:antigravity"],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"},
                        {"engine": "dsh", "installed": True, "auth": "unknown", "version": "0.2.0-rc.2",
                         "dsh": {"versionCompatible": True, "credentialPresent": False,
                                 "modelCatalogReadable": True, "requestValidation": "unknown",
                                 "sandboxEnforcement": "unknown"}}],
            "modelCatalog": {"claude": CLAUDE_CATALOG, "dsh": DSH_CATALOG},
            "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


def agents():
    return [{"id": "a1", "name": "orbit", "provider": "deepseek-harness", "lastProvider": "deepseek-harness",
             "runnerId": "r1", "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/srv/orbit",
             "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]


HARNESS = {"providerID": "p-dsh", "id": "p-dsh", "slug": "deepseek-harness", "label": "DeepSeek Harness",
           "runtime": "dsh", "models": [], "defaultModel": None, "presetSlug": "deepseek-harness",
           "modelsFromRuntime": True, "enabled": True}
DEEPSEEK = {"providerID": "p-ds", "id": "p-ds", "slug": "deepseek", "label": "DeepSeek", "runtime": "claude",
            "models": [{"value": "deepseek-v4-pro", "label": "DeepSeek V4 Pro", "contextWindow": 1000000}],
            "defaultModel": "deepseek-v4-pro", "presetSlug": "deepseek", "enabled": True}

# Six rounds about a release note, long enough that the transcript scrolls on an iPhone and in a Mac
# window alike. The last line is what the tests wait for.
ROUNDS = [
    ("帮我看一下 release notes 草稿，哪些段落可以合并？",
     "我读了一遍草稿，一共 7 段。第 2 段和第 5 段都在讲输入框的改动，可以合成一段；第 6 段只有一句"
     "「修了若干问题」，建议删掉，或者换成具体的条目。\n\n合并之后的顺序建议是：新功能 → 体验改进 → 修复 → "
     "已知问题。这样读者先看到最想看的部分。"),
    ("按这个顺序改，修复部分列成条目",
     "改好了。修复部分现在是 4 条：\n\n1. 会话列表在切换工作区后不再停在旧位置。\n2. 附件上传失败时会保留草稿。\n"
     "3. 深色模式下代码块的边框颜色和正文一致了。\n4. 长消息折叠后再展开不会跳动。\n\n已知问题单独放在最后，只留了"
     "一条：旧版本的 runner 不会显示新的用量环。"),
    ("第 3 条说得太技术了，换个说法",
     "换成了：「深色模式下，代码块不再带一圈突兀的亮边。」读者不需要知道是边框颜色的问题，只要知道看起来顺眼了。"
     "\n\n其他三条我也顺手读了一遍，措辞都是用户能看到的现象，没有再改。"),
    ("开头加一句总结，不超过 30 个字",
     "加在最上面了：「这一版主要让输入框和长对话读起来更顺。」一共 19 个字。\n\n如果想更具体，也可以写成"
     "「输入框重做，长对话滚动更稳，修了 4 个问题」，信息多一些，但读起来像清单。我倾向第一种。"),
    ("用第一种。再检查一遍有没有错别字",
     "检查完了，改了两处：「其它」统一成「其他」，「登陆」改成「登录」。标点也过了一遍，中英文之间都留了空格，"
     "数字和单位之间没有空格。\n\n全文现在 412 个字，比原稿少了 96 个字。"),
    ("好，导出一份给我",
     "导出好了，在 docs/release-notes.md。要我顺便生成一份英文版吗？英文版会按同样的顺序，条目一一对应。"),
]
TAIL = ROUNDS[-1][1]


def s1_events():
    out, seq = [], 0

    def add(typ, turn, payload, minutes):
        nonlocal seq
        seq += 1
        out.append({"seq": seq, "type": typ, "ts": ago(minutes), "turnId": turn, "payload": payload})

    for i, (ask, answer) in enumerate(ROUNDS):
        turn, minutes = "t%d" % (i + 1), (len(ROUNDS) - i) * 3
        add("user", turn, {"text": ask}, minutes)
        if i == len(ROUNDS) - 1:
            add("tool_use", turn, {"id": "c1", "toolCallId": "c1", "name": "write_file",
                                   "input": {"path": "docs/release-notes.md", "content": "# Release notes\n"},
                                   "kind": "edit", "status": "pending"}, minutes)
            add("tool_result", turn, {"toolUseId": "c1", "toolCallId": "c1", "status": "completed",
                                      "content": "Wrote docs/release-notes.md (1.2 KB)", "isError": False}, minutes)
        add("assistant", turn, {"text": answer, "messageId": "m%d" % (i + 1)}, minutes)
        add("result", turn, {"subtype": "success", "result": "done"}, minutes)
    return out


def s1():
    return {"id": "S1", "title": "整理 release notes", "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
            "runState": "AWAITING_INPUT", "lifecycleState": "OPEN", "agentId": "a1",
            "agent": {"id": "a1", "name": "a1"}, "assignedRunnerId": "r1", "provider": "deepseek-harness",
            "model": PRO, "effort": "high", "permissionMode": "default", "taskId": None, "projectId": None,
            "createdAt": ago(20), "updatedAt": ago(0), "lastTurnAt": ago(0), "lastAssistantText": TAIL,
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

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        parts = [p for p in url.path.split("/") if p]
        if parts == ["__log"]:
            try:
                with open(LOG) as f:
                    return self.send(200, {"log": f.read()})
            except OSError:
                return self.send(200, {"log": ""})
        if parts == ["api", "agents"]:
            return self.send(200, agents())
        if len(parts) == 3 and parts[:2] == ["api", "agents"]:
            found = [a for a in agents() if a["id"] == parts[2]]
            return self.send(200, found[0]) if found else self.send(404, {"error": "no agent"})
        if parts == ["api", "runners"]:
            return self.send(200, [runner("r1", "hpc")])
        if len(parts) == 3 and parts[:2] == ["api", "runners"]:
            return self.send(200, runner("r1", "hpc")) if parts[2] == "r1" else self.send(404, {"error": "no runner"})
        if parts in (["api", "providers"], ["api", "providers", "mine"]):
            return self.send(200, [HARNESS, DEEPSEEK])
        if parts in (["api", "providers", "pools"], ["api", "providers", "shared-pools"],
                     ["api", "session-tags"], ["api", "session-folders"], ["api", "task-lists"],
                     ["api", "watches"], ["api", "share-links"]):
            return self.send(200, [])
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            return self.send(200, [s1()] if view == "open" else [])
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "events":
            return self.stream(parts[2], int(query.get("sinceSeq", ["0"])[0] or 0))
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            sid, rest = parts[2], parts[3:]
            if sid != "S1":
                return self.send(404, {"error": "not in the probe"})
            if rest == []:
                return self.send(200, s1())
            if rest == ["events", "page"]:
                return self.send(200, {"events": s1_events(), "hasMore": False, "before": None, "after": None})
            if rest in (["approvals"], ["turns"]):
                return self.send(200, [])
            if rest == ["share"]:
                return self.send(200, {"link": None, "counts": {"messages": 12, "toolCalls": 1}})
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
            for e in (s1_events() if sid == "S1" else []):
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
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode("utf-8", "replace") if n else ""
        if parts in (["__metrics"], ["__mark"]):
            with open(METRICS, "a") as f:
                f.write("%s %s %s\n" % (datetime.now().strftime("%H:%M:%S.%f")[:-3], parts[0][2:], body))
            return self.send(200, {"ok": True})
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
