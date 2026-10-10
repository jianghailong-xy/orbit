#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the iPad's three-column shell
# reads to draw a workspace's session list beside a conversation, the sidebar (the phone's drawer),
# a folder's page and a project's sessions page in the list column, and a machine's record with an
# engine's page over it in the detail column. Read-only: every write is refused. Every request is
# logged; anything not served is a 404. All data is made up.
#
# Workspaces: orbit (HPC) holds the conversation S1, loose sessions, two folders (Release, iOS
# polish) and project P1's coordinator and a member; orbit-macos (Mac Studio) and wikova (HPC) hold
# a session each; lfs sits on ThinkPad, which is offline.
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


CLAUDE_MODELS = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "contextWindow": 1000000,
                  "reasoningLevels": ["low", "medium", "high", "max"]},
                 {"value": "claude-sonnet-5-5", "label": "Sonnet 5.5", "contextWindow": 1000000,
                  "reasoningLevels": ["low", "medium", "high", "max"]}]


def machine(rid, name, online, active, slots, seen_minutes, engines, host):
    # Stamped per request: the clients call a machine offline once its heartbeat is 90 s old, and a
    # UI run lasts minutes.
    return {"id": rid, "name": name, "displayName": name, "hostname": host, "online": online,
            "status": "ONLINE" if online else "OFFLINE", "version": "0.1.240", "maxConcurrent": slots,
            "activeSessions": active, "lastHeartbeatAt": ago(seen_minutes), "capabilities": [],
            "engines": engines, "modelCatalog": {"claude": CLAUDE_MODELS},
            "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


def runners():
    return [
        machine("mac", "Mac Studio", True, 2, 4, 0.1, [
            {"engine": "claude", "installed": True, "version": "2.1.4 (Claude Code)", "auth": "yes",
             "accounts": [{"id": "default", "name": "Personal Max", "auth": "yes", "home": "/Users/me/.claude"},
                          {"id": "slot-2", "name": "Work", "auth": "yes", "home": "/Users/me/.orbit/claude-2"}]},
            {"engine": "codex", "installed": True, "version": "codex-cli 0.160.0", "auth": "no"},
        ], "mac-studio.local"),
        machine("hpc", "HPC", True, 5, 8, 0.1, [
            {"engine": "claude", "installed": True, "version": "2.1.4 (Claude Code)", "auth": "yes"},
            {"engine": "codex", "installed": True, "version": "codex-cli 0.160.0", "auth": "yes"},
        ], "workstation"),
        machine("thinkpad", "ThinkPad", False, 0, 4, 25 * 60, [
            {"engine": "claude", "installed": True, "version": "2.1.2 (Claude Code)", "auth": "yes"},
        ], "thinkpad"),
    ]


def agent(aid, name, rid):
    return {"id": aid, "name": name, "provider": "claude", "lastProvider": "claude", "runnerId": rid,
            "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/srv/" + name,
            "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}


AGENTS = [agent("a1", "orbit", "hpc"), agent("a2", "orbit-macos", "mac"), agent("a3", "wikova", "hpc"),
          agent("a4", "lfs", "thinkpad")]
NAMES = {a["id"]: (a["name"], a["runnerId"]) for a in AGENTS}
PROVIDERS = [{"slug": "anthropic", "label": "Anthropic (Claude)", "runtime": "claude", "presetSlug": "anthropic",
              "models": CLAUDE_MODELS, "defaultModel": "claude-opus-5-5", "planUsage": None,
              "runsOnOpenCode": False}]

P1_TITLE = "Runner 自动升级与回滚"
P2_TITLE = "Orbit Wiki · 阶段 2"


def session(sid, title, minutes, text, aid="a1", folder=None, tags=(), run="AWAITING_INPUT", approvals=0,
            role=None, project=None, pinned=False):
    name, rid = NAMES[aid]
    s = {"id": sid, "title": title, "status": run, "runStatus": run, "runState": run, "lifecycleState": "OPEN",
         "agentId": aid, "agent": {"id": aid, "name": name}, "assignedRunnerId": rid, "provider": "claude",
         "model": "claude-opus-5-5", "effort": "high", "permissionMode": "default", "taskId": None,
         "projectId": None, "createdAt": ago(minutes + 30), "updatedAt": ago(minutes), "lastTurnAt": ago(minutes),
         "lastAssistantText": text, "pendingApprovals": approvals, "folderId": folder, "source": "USER",
         "pinnedAt": ago(60 * 24) if pinned else None,
         "tags": [{"id": "%s-t%d" % (sid, i), "name": n, "color": c, "isSystem": False, "position": i}
                  for i, (n, c) in enumerate(tags)]}
    if role:
        s["projectMembership"] = {"projectId": project, "projectTitle": P1_TITLE if project == "P1" else P2_TITLE,
                                  "projectStatus": "OPEN", "role": role}
    return s


SESSIONS = [
    session("S1", "整理 release notes", 2, "导出好了，在 docs/release-notes.md。要我顺便生成一份英文版吗？",
            tags=[("发布", "#34C759")], pinned=True),
    session("s2", "iPad 侧栏复用 iPhone 抽屉", 1, "正在改 MainView 的第一栏。", run="RUNNING",
            tags=[("iOS", "#0A84FF"), ("交互设计", "#FF9500")]),
    session("s3", "会话列表左滑按钮", 4, "左滑按钮在 SessionRowActions 里，改成圆形。", tags=[("iOS", "#0A84FF")]),
    session("s4", "修复 Codex 生成行问题", 23, "我前面把原因归到 Codex 的调用写法上了。", tags=[("功能缺陷", "#FF3B30")]),
    session("C1", "协调：" + P1_TITLE, 3, "Watching 2 targets · 1 watch", role="COORDINATOR", project="P1"),
    session("M1", "执行任务：Runner 升级失败时回滚", 9, "回滚脚本写好了，正在跑测试。", role="TASK", project="P1",
            run="RUNNING"),
    session("s5", "审查工具调用报错渲染", 26 * 60, "对，原生 iOS 也会使用这套改动。", folder="f1", approvals=1,
            tags=[("前端问题", "#FF9500"), ("代码审查", "#FF9500")]),
    session("s6", "Wiki 审核模式文案对齐", 27 * 60, "三处文案已统一为 Review mode。", folder="f1",
            tags=[("Wiki", "#AF52DE")]),
    session("s7", "发布 0.1.172", 28 * 60, "TestFlight 构建已上传。", folder="f2", tags=[("发布", "#34C759")]),
    session("s8", "聊天框撑开页面问题", 30 * 60, "修复后的效果图在 docs/mocks 里。", tags=[("样式调整", "#FF9500")]),
    session("s9", "整理设置页文案", 50 * 60, "已合入 main。"),
    session("s10", "红色报错展示验证", 52 * 60, "已定位：截图中的错误走的是原始日志。", tags=[("前端问题", "#FF9500")]),
    session("L2", "菜单栏图标在深色模式下发灰", 6, "换成模板图片了。", aid="a2"),
    session("L3", "Wiki 首页目录排序", 40, "按最近修改排序。", aid="a3"),
]
FOLDERS = [{"id": "f1", "workspaceId": "a1", "name": "Release"},
           {"id": "f2", "workspaceId": "a1", "name": "iOS polish"}]
PROJECTS = [
    {"id": "P1", "title": P1_TITLE, "status": "OPEN", "goal": "升级失败时自动回滚到上一个版本。",
     "createdAt": ago(600), "updatedAt": ago(3), "lastActivityAt": ago(3), "_count": {"tasks": 5},
     "taskCounts": {"done": 2, "failed": 0, "total": 5}, "startedAt": ago(500)},
    {"id": "P2", "title": P2_TITLE, "status": "OPEN", "goal": "从 Orbit 记录生成 wiki。",
     "createdAt": ago(3000), "updatedAt": ago(42), "lastActivityAt": ago(42), "_count": {"tasks": 9},
     "taskCounts": {"done": 6, "failed": 0, "total": 9}, "startedAt": ago(2900)},
]

# S1's conversation (the composer-fade probe's): long enough to fill the detail column.
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


def find(sid):
    return next((s for s in SESSIONS if s["id"] == sid), None)


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
            return self.send(200, AGENTS)
        if len(parts) == 3 and parts[:2] == ["api", "agents"]:
            found = [a for a in AGENTS if a["id"] == parts[2]]
            return self.send(200, found[0]) if found else self.send(404, {"error": "no agent"})
        if parts == ["api", "runners"]:
            return self.send(200, runners())
        if len(parts) == 3 and parts[:2] == ["api", "runners"]:
            found = [r for r in runners() if r["id"] == parts[2]]
            return self.send(200, found[0]) if found else self.send(404, {"error": "no runner"})
        if parts == ["api", "providers"]:
            return self.send(200, PROVIDERS)
        if parts in (["api", "providers", "mine"], ["api", "providers", "pools"],
                     ["api", "providers", "shared-pools"], ["api", "session-tags"], ["api", "task-lists"],
                     ["api", "watches"], ["api", "share-links"]):
            return self.send(200, [])
        if parts == ["api", "session-folders"]:
            return self.send(200, FOLDERS)
        if parts in (["api", "projects"], ["api", "projects", "sidebar"]):
            return self.send(200, PROJECTS)
        if parts == ["api", "sessions", "search"]:
            return self.send(200, {"hits": [], "q": query.get("q", [""])[0], "contentSearched": True})
        if parts == ["api", "sessions"]:
            if query.get("view", ["open"])[0] != "open":
                return self.send(200, [])
            project = query.get("projectId", [None])[0]
            if project:
                return self.send(200, [s for s in SESSIONS
                                       if s.get("projectMembership", {}).get("projectId") == project])
            return self.send(200, SESSIONS)
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "events":
            return self.stream(parts[2], int(query.get("sinceSeq", ["0"])[0] or 0))
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            row, rest = find(parts[2]), parts[3:]
            if row is None:
                return self.send(404, {"error": "not in the probe"})
            if rest == []:
                return self.send(200, row)
            if rest == ["events", "page"]:
                events = s1_events() if row["id"] == "S1" else []
                return self.send(200, {"events": events, "hasMore": False, "before": None, "after": None})
            if rest in (["approvals"], ["turns"]):
                return self.send(200, [])
            if rest == ["share"]:
                return self.send(200, {"link": None, "counts": {"messages": 12, "toolCalls": 1}})
            return self.send(404, {"error": "not in the probe"})
        return self.send(404, {"error": "not in the probe"})

    def stream(self, sid, sent):
        """Replay what follows `sinceSeq` (the server's SSE `data:` framing), then hold the stream open
        with a keepalive inside the clients' 45 s watchdog. Nothing new ever arrives."""
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

    def refuse(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        with open(LOG, "a") as f:
            f.write("    body: %s\n" % raw.decode("utf-8", "replace"))
        if urlparse(self.path).path == "/__reset":
            return self.send(200, {"ok": True})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

    do_POST = refuse
    do_PATCH = refuse
    do_PUT = refuse
    do_DELETE = refuse


if __name__ == "__main__":
    class LoopbackServer(ThreadingHTTPServer):
        daemon_threads = True

        # HTTPServer.server_bind resolves its own name (socket.getfqdn), a reverse lookup that on
        # macOS can raise the "find devices on local networks" prompt over the app being photographed.
        def server_bind(self):
            import socketserver
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "localhost", self.server_address[1]

    server = LoopbackServer(("127.0.0.1", PORT), Handler)
    print("stub listening on 127.0.0.1:%d (python %s)" % (PORT, sys.version.split()[0]), flush=True)
    server.serve_forever()
