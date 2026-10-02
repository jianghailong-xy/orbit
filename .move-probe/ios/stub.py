#!/usr/bin/env python3
# TEMPORARY evidence probe (see ../README.md): the slice of the Orbit API the session list and its
# Move panel read and write, from fixtures — six workspaces (one of them the list's), the list's
# sessions per tab, their folders, and the doors a move to another workspace uses:
# `GET /sessions/:id/move-targets` (answered as the server's session-move.ts rules would for these
# fixtures), `POST /sessions/:id/end` (the session ends a few seconds later, as a runner finishing its
# commit would — except one that never does), `GET /sessions/:id` (what End and Move polls), and
# `POST /sessions/:id/move` with a `workspaceId` (409 for a session not ended, or a workspace disabled
# since the panel was drawn). Everything is kept in memory until POST /__reset, which each UI test
# calls before it launches the app. Anything else is a 404, which the app treats as an older server.
# Every request is logged.
import copy
import json
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
TERMINAL = ("SUCCEEDED", "FAILED", "CANCELLED")
# How long a runner takes to end a session once asked (its closing commit).
END_SECONDS = 3.0


def ago(hours):
    t = datetime.now(timezone.utc) - timedelta(hours=hours)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


RUNNERS = {
    "r1": {"name": "wikova", "online": True, "engines": ("claude", "codex"), "move": True},
    "r2": {"name": "mac-mini", "online": True, "engines": ("claude",), "move": True},
    "r3": {"name": "studio", "online": False, "engines": ("claude", "codex"), "move": True},
    "r4": {"name": "build-box", "online": True, "engines": ("claude", "codex"), "move": False},
}

WORKSPACES = [
    {"id": "a1", "name": "orbit", "lastProvider": "claude", "runnerId": "r1", "enabled": True,
     "workDir": "/srv/orbit"},
    {"id": "a2", "name": "wikova-develop", "lastProvider": "codex", "runnerId": "r1", "enabled": True,
     "workDir": "/srv/wikova-develop"},
    {"id": "a3", "name": "site", "lastProvider": "claude", "runnerId": "r2", "enabled": True,
     "workDir": "/Users/me/site"},
    {"id": "a4", "name": "wikids", "lastProvider": "claude", "runnerId": "r3", "enabled": True,
     "workDir": "/Users/me/wikids"},
    {"id": "a5", "name": "docs", "lastProvider": "claude", "runnerId": "r4", "enabled": True,
     "workDir": "/srv/docs"},
    {"id": "a6", "name": "archive", "lastProvider": "claude", "runnerId": "r4", "enabled": False,
     "workDir": "/srv/archive"},
]

RUNTIME = {"claude": "Claude", "codex": "Codex"}


def session(sid, title, preview, hours, state, status="SUCCEEDED", folder=None, tags=(), provider="claude",
            branch=None, changed=0, unmerged=0):
    return {
        "id": sid, "title": title, "status": status, "runStatus": status, "lastAssistantText": preview,
        "lastTurnAt": ago(hours), "updatedAt": ago(hours), "createdAt": ago(hours + 1),
        "lifecycleState": state, "agentId": "a1", "agent": {"id": "a1", "name": "orbit"},
        "provider": provider, "folderId": folder, "branch": branch,
        "_changed": changed, "_unmerged": unmerged,
        "tags": [{"id": f"{sid}-t{i}", "name": name, "color": color, "isSystem": False, "position": i}
                 for i, (name, color) in enumerate(tags)],
    }


FIXTURE_SESSIONS = {
    "open": [
        session("s1", "iOS 会话列表左滑按钮", "正在梳理代码：左滑按钮在 SessionRowActions 里。", 0.04, "OPEN",
                status="RUNNING", tags=[("iOS", "#0A84FF")]),
        session("s2", "审查导入逻辑避免侵入用户身份", "已确认：后续默认直接合入 main。", 0.3, "OPEN",
                status="AWAITING_INPUT", branch="orbit/review-import-3fa21c", changed=3, unmerged=3),
        session("s7", "排查推送延迟", "日志已经收集好，等你看一下。", 0.5, "OPEN", status="AWAITING_INPUT",
                branch="orbit/push-latency-9c01d2", changed=1, unmerged=1),
        session("s3", "滑动按钮圆形设计", "收到，做 B。先摸清现有代码和约束。", 0.6, "OPEN", folder="f2",
                tags=[("iOS", "#0A84FF")]),
        session("s6", "发布 0.1.172", "TestFlight 构建已上传。", 20, "OPEN", status="AWAITING_INPUT",
                provider="codex", tags=[("发布", "#34C759")]),
        session("s4", "审查工具调用报错渲染", "对，原生 iOS 也会使用这套改动。", 26, "OPEN", folder="f1",
                tags=[("前端问题", "#FF9500"), ("代码审查", "#FF9500")]),
        session("s5", "Wiki 审核模式文案对齐", "三处文案已统一为 Review mode。", 27, "OPEN", folder="f1",
                tags=[("Wiki", "#AF52DE")]),
    ],
    "completed": [
        session("c1", "发布 0.1.171", "TestFlight 构建已上传，release notes 已更新。", 30, "COMPLETED",
                folder="f1", tags=[("发布", "#34C759")]),
        session("c2", "修复登录后的跳转", "已修复：登录后回到原来的页面。", 50, "COMPLETED",
                branch="orbit/fix-login-redirect", changed=2, unmerged=0),
        session("c3", "整理设置页文案", "已合入 main。", 52, "COMPLETED"),
    ],
    "trash": [
        session("t1", "临时调试：通知不弹出", "复现不了，先放进回收站。", 40, "TRASH"),
    ],
}

FIXTURE_FOLDERS = [
    {"id": "f1", "workspaceId": "a1", "name": "Release"},
    {"id": "f2", "workspaceId": "a1", "name": "iOS polish"},
    {"id": "f3", "workspaceId": "a2", "name": "Bugs"},
    {"id": "f4", "workspaceId": "a2", "name": "Infra"},
]
# What the other workspaces' folders hold, which the fixture's own sessions don't account for.
FOLDER_COUNTS = {"f3": 12, "f4": 3}

STATE = {}


def reset():
    STATE["sessions"] = copy.deepcopy(FIXTURE_SESSIONS)
    STATE["folders"] = copy.deepcopy(FIXTURE_FOLDERS)
    STATE["workspaces"] = copy.deepcopy(WORKSPACES)


reset()


def find_session(sid):
    for rows in STATE["sessions"].values():
        for row in rows:
            if row["id"] == sid:
                return row
    return None


def workspace(wid):
    return next((w for w in STATE["workspaces"] if w["id"] == wid), None)


def status_of(row):
    """The run status as it stands now: an asked end lands END_SECONDS later, except on s7."""
    end_at = row.get("_endAt")
    if end_at is not None and time.time() >= end_at:
        row["status"] = row["runStatus"] = "SUCCEEDED"
        row.pop("_endAt", None)
    return row["status"]


def public(row):
    status_of(row)
    return {k: v for k, v in row.items() if not k.startswith("_")}


def folder_count(fid):
    filed = sum(1 for rows in STATE["sessions"].values() for r in rows
                if r.get("folderId") == fid and r["lifecycleState"] != "TRASH")
    return FOLDER_COUNTS.get(fid, 0) + filed


def folders_of(wid):
    return [{"id": f["id"], "name": f["name"], "sessionCount": folder_count(f["id"])}
            for f in sorted(STATE["folders"], key=lambda f: (f["name"], f["id"])) if f["workspaceId"] == wid]


def verdict(row):
    """sessionMoveVerdict for the fixture's cases."""
    status = status_of(row)
    if row["lifecycleState"] == "TRASH":
        return "Restore the session from Trash first.", False
    if status in TERMINAL:
        return None, False
    if row.get("_ending") or row.get("_endAt"):
        return "The session is ending. Try again in a moment.", False
    if status in ("RUNNING", "PENDING"):
        return "Stop the session first.", False
    return None, True


def refusal(row, target):
    """moveTargetRefusal for the fixture's cases."""
    if not target["enabled"]:
        return "This workspace is disabled."
    runner = RUNNERS[target["runnerId"]]
    runtime = row.get("provider", "claude")
    if runtime not in runner["engines"]:
        return f"{runner['name']} can't run {RUNTIME[runtime]}"
    source = workspace(row["agentId"])["runnerId"]
    if runtime == "codex" and target["runnerId"] != source:
        return f"Codex keeps this conversation on {RUNNERS[source]['name']}"
    if not runner["move"]:
        return f"Update {runner['name']} to move sessions here"
    return None


def move_targets(row):
    reason, needs_end = verdict(row)
    source = workspace(row["agentId"])
    return {
        "workspaceId": source["id"], "folderId": row.get("folderId"),
        "folders": folders_of(source["id"]),
        "reason": reason, "needsEnd": needs_end,
        "branch": row.get("branch"), "changedFiles": row["_changed"],
        "unmergedFiles": row["_unmerged"], "mergeTarget": "main" if row.get("branch") else None,
        "targets": [{
            "workspaceId": w["id"], "name": w["name"], "provider": w["lastProvider"],
            "runnerId": w["runnerId"], "runnerName": RUNNERS[w["runnerId"]]["name"],
            "runnerOnline": RUNNERS[w["runnerId"]]["online"], "workDir": w["workDir"],
            "reason": refusal(row, w),
            "conversation": "continues" if w["runnerId"] == source["runnerId"] else "rebuilt",
            "folders": folders_of(w["id"]),
        } for w in STATE["workspaces"] if w["id"] != source["id"]],
    }


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

    def refuse(self, status, message):
        return self.send(status, {"statusCode": status, "message": message})

    def do_GET(self):
        url = urlparse(self.path)
        parts = [p for p in url.path.split("/") if p]
        if parts == ["api", "agents"]:
            return self.send(200, STATE["workspaces"])
        if parts == ["api", "sessions"]:
            view = parse_qs(url.query).get("view", ["open"])[0]
            return self.send(200, [public(r) for r in STATE["sessions"].get(view, [])])
        if parts == ["api", "session-tags"]:
            return self.send(200, [])
        if parts == ["api", "session-folders"]:
            return self.send(200, sorted(STATE["folders"], key=lambda f: (f["name"], f["id"])))
        if len(parts) == 3 and parts[:2] == ["api", "sessions"]:
            row = find_session(parts[2])
            return self.send(200, public(row)) if row else self.refuse(404, "session not found")
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "move-targets":
            row = find_session(parts[2])
            return self.send(200, move_targets(row)) if row else self.refuse(404, "session not found")
        return self.send(404, {"error": "not in the probe"})

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if parts == ["__reset"]:
            reset()
            return self.send(200, {"ok": True})
        if parts == ["api", "session-folders"]:
            dto = self.body()
            name = (dto.get("name") or "").strip()
            wid = dto.get("workspaceId")
            if not name or len(name) > 60:
                return self.refuse(400, ["name must be 1-60 characters"])
            if any(f["workspaceId"] == wid and f["name"] == name for f in STATE["folders"]):
                return self.refuse(409, "a folder with that name already exists in this workspace")
            folder = {"id": "f-" + uuid.uuid4().hex[:8], "workspaceId": wid, "name": name}
            STATE["folders"].append(folder)
            return self.send(201, folder)
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "end":
            self.body()
            row = find_session(parts[2])
            if row is None:
                return self.refuse(404, "session not found")
            if status_of(row) in TERMINAL or row.get("_ending") or row.get("_endAt"):
                return self.refuse(409, "the session has ended")
            if row["id"] == "s7":
                # Its runner never gets the session ended: End and Move gives up and says so.
                row["_ending"] = True
            else:
                row["_endAt"] = time.time() + END_SECONDS
            return self.send(201, {"ok": True})
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "move":
            dto = self.body()
            row = find_session(parts[2])
            if row is None:
                return self.refuse(404, "session not found")
            if row["lifecycleState"] == "TRASH":
                return self.refuse(409, "this session is in Trash; restore it before moving it")
            folder_id = dto.get("folderId")
            wid = dto.get("workspaceId") or row["agentId"]
            if wid != row["agentId"]:
                target = workspace(wid)
                if target is None:
                    return self.refuse(409, "Workspace not found.")
                if row["id"] == "c3" and wid == "a3":
                    # The workspace was disabled after the panel was drawn: the move asks again.
                    target["enabled"] = False
                reason, needs_end = verdict(row)
                if reason:
                    return self.refuse(409, reason)
                if needs_end:
                    return self.refuse(409, "End the session first.")
                why = refusal(row, target)
                if why:
                    return self.refuse(409, why)
            if folder_id and not any(f["id"] == folder_id and f["workspaceId"] == wid for f in STATE["folders"]):
                return self.refuse(400, "folderId must be a folder of the workspace the session moves to")
            row["agentId"] = wid
            row["agent"] = {"id": wid, "name": workspace(wid)["name"]}
            row["folderId"] = folder_id
            return self.send(201, {"id": row["id"], "workspaceId": wid, "folderId": folder_id})
        return self.send(404, {"error": "not in the probe"})

    def do_PUT(self):
        return self.send(404, {"error": "not in the probe"})

    def do_DELETE(self):
        return self.send(204)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
