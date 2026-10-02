#!/usr/bin/env python3
# TEMPORARY evidence probe (see ../README.md): the slice of the Orbit API the session list and its
# Move panel read and write, from fixtures — one workspace, its sessions per tab, its folders, and the
# folder doors: list and create folders (a name the workspace already has is a 409, as the server's
# UNIQUE (workspace_id, name) answers) and move a session between them. Moves and new folders are
# kept in memory until POST /__reset, which each UI test calls before it launches the app. Everything
# else is a 404, which the app treats as an older server. Every request is logged.
import copy
import json
import sys
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"


def ago(hours):
    t = datetime.now(timezone.utc) - timedelta(hours=hours)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


AGENT = {"id": "a1", "name": "orbit", "provider": "claude", "runnerId": "r1", "enabled": True}


def session(sid, title, preview, hours, state, folder=None, tags=()):
    return {
        "id": sid, "title": title, "status": "SUCCEEDED", "lastAssistantText": preview,
        "lastTurnAt": ago(hours), "updatedAt": ago(hours), "createdAt": ago(hours + 1),
        "lifecycleState": state, "agentId": "a1", "agent": {"id": "a1", "name": "orbit"},
        "folderId": folder,
        "tags": [{"id": f"{sid}-t{i}", "name": name, "color": color, "isSystem": False, "position": i}
                 for i, (name, color) in enumerate(tags)],
    }


FIXTURE_SESSIONS = {
    "open": [
        session("s1", "iOS 会话列表左滑按钮", "正在梳理代码：左滑按钮在 SessionRowActions 里。", 0.04, "OPEN",
                tags=[("iOS", "#0A84FF")]),
        session("s2", "审查导入逻辑避免侵入用户身份", "已确认：后续默认直接合入 main。", 0.3, "OPEN"),
        session("s3", "滑动按钮圆形设计", "收到，做 B。先摸清现有代码和约束。", 0.6, "OPEN", folder="f2",
                tags=[("iOS", "#0A84FF")]),
        session("s4", "审查工具调用报错渲染", "对，原生 iOS 也会使用这套改动。", 26, "OPEN", folder="f1",
                tags=[("前端问题", "#FF9500"), ("代码审查", "#FF9500")]),
        session("s5", "Wiki 审核模式文案对齐", "三处文案已统一为 Review mode。", 27, "OPEN", folder="f1",
                tags=[("Wiki", "#AF52DE")]),
        session("s6", "发布 0.1.172", "TestFlight 构建已上传。", 28, "OPEN", folder="f2", tags=[("发布", "#34C759")]),
    ],
    "completed": [
        session("c1", "发布 0.1.171", "TestFlight 构建已上传，release notes 已更新。", 30, "COMPLETED",
                folder="f1", tags=[("发布", "#34C759")]),
        session("c2", "修复登录后的跳转", "已修复：登录后回到原来的页面。", 50, "COMPLETED"),
        session("c3", "整理设置页文案", "已合入 main。", 52, "COMPLETED"),
    ],
    "trash": [
        session("t1", "临时调试：通知不弹出", "复现不了，先放进回收站。", 40, "TRASH"),
        session("t2", "实验：换一种列表分组", "这个方向不做了。", 60, "TRASH"),
    ],
}

# Two folders in this workspace, and one in another that the panel must not offer.
FIXTURE_FOLDERS = [
    {"id": "f1", "workspaceId": "a1", "name": "Release"},
    {"id": "f2", "workspaceId": "a1", "name": "iOS polish"},
    {"id": "f9", "workspaceId": "a9", "name": "Elsewhere"},
]

STATE = {}


def reset():
    STATE["sessions"] = copy.deepcopy(FIXTURE_SESSIONS)
    STATE["folders"] = copy.deepcopy(FIXTURE_FOLDERS)


reset()


def find_session(sid):
    for rows in STATE["sessions"].values():
        for row in rows:
            if row["id"] == sid:
                return row
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        with open(LOG, "a") as f:
            f.write("    body: %s\n" % raw.decode("utf-8", "replace"))
        return json.loads(raw) if raw else {}

    def send(self, status, body=None):
        data = b"" if body is None else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        parts = [p for p in url.path.split("/") if p]
        if parts == ["api", "agents"]:
            return self.send(200, [AGENT])
        if parts == ["api", "sessions"]:
            view = parse_qs(url.query).get("view", ["open"])[0]
            return self.send(200, STATE["sessions"].get(view, []))
        if parts == ["api", "session-tags"]:
            return self.send(200, [])
        if parts == ["api", "session-folders"]:
            return self.send(200, sorted(STATE["folders"], key=lambda f: (f["name"], f["id"])))
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "share":
            return self.send(200, {"link": None, "counts": {"messages": 42, "toolCalls": 118}})
        return self.send(404, {"error": "not in the probe"})

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if parts == ["__reset"]:
            reset()
            return self.send(200, {"ok": True})
        if parts == ["api", "session-folders"]:
            dto = self.body()
            name = (dto.get("name") or "").strip()
            workspace = dto.get("workspaceId")
            if not name or len(name) > 60:
                return self.send(400, {"statusCode": 400, "message": ["name must be 1-60 characters"],
                                       "error": "Bad Request"})
            if any(f["workspaceId"] == workspace and f["name"] == name for f in STATE["folders"]):
                return self.send(409, {"statusCode": 409,
                                       "message": "a folder with that name already exists in this workspace",
                                       "error": "Conflict"})
            folder = {"id": "f-" + uuid.uuid4().hex[:8], "workspaceId": workspace, "name": name}
            STATE["folders"].append(folder)
            return self.send(201, folder)
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "move":
            dto = self.body()
            row = find_session(parts[2])
            if row is None:
                return self.send(404, {"statusCode": 404, "message": "session not found"})
            if row["lifecycleState"] == "TRASH":
                return self.send(409, {"statusCode": 409,
                                       "message": "this session is in Trash; restore it before moving it"})
            folder_id = dto.get("folderId")
            if folder_id and not any(f["id"] == folder_id and f["workspaceId"] == "a1" for f in STATE["folders"]):
                return self.send(400, {"statusCode": 400,
                                       "message": "folderId must be a folder of this session's workspace"})
            row["folderId"] = folder_id
            return self.send(201, {"id": row["id"], "workspaceId": "a1", "folderId": folder_id})
        return self.send(404, {"error": "not in the probe"})

    def do_PUT(self):
        return self.send(404, {"error": "not in the probe"})

    def do_DELETE(self):
        return self.send(204)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
