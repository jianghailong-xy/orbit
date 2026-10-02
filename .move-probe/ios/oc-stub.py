#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API a phone needs to open a task
# run's session and draw its owner-confirmation card — one workspace, two sessions waiting on their
# owner, their events, and GET /tasks/:id/owner-confirmation with `ifConfirmed`.
#
#   s1 — the mock's own data (docs/mocks/owner-confirmation-review-ios.html, phone ②): one task starts
#        now, the branch orbit/p1-1c207b is not on main (+9,432), nothing lands, six criteria.
#   s2 — a project task with every row: a dependent that starts once the work lands, the branch, the
#        integration line, and the run with two background jobs.
#
# Nothing is pressed: POST to the door is logged and refused, so a stray tap changes nothing. Every
# request is logged. Fixture titles and criteria are illustrative.
import json
import sys
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


AGENT = {"id": "a1", "name": "orbit", "provider": "claude", "runnerId": "r1", "enabled": True}
RUNNER = {"id": "r1", "name": "wikova", "displayName": "wikova", "online": True, "status": "ONLINE"}

REPORT_1 = (
    "All six P1 review findings are fixed and pushed to orbit/p1-1c207b at commit "
    "59d98153ef85c565646fede291f66f61940573c7. This branch also carries P0, P1 and the attribution "
    "follow-up merged onto current main. One rename: P1’s expectReply flag is now replyBy, because "
    "the deadline is what it carries. PG 2298/2298, web 1,204 files green; JS tests did not run on CI."
)
CRITERIA_1 = (
    "1. 回复请求可以带期限，超时后发送方被唤醒并看到结局。\n"
    "2. 接收方结束会话时，未回复的请求立即以「对方已结束」收场。\n"
    "3. 署名区分自动重试、手动 Retry 与原始请求。\n"
    "4. web / iOS / macOS 的列表与会话页显示同一个请求状态。\n"
    "5. PG 规格全绿。\n"
    "6. CI 的 client 工作流通过。"
)
REPORT_2 = (
    "The card draws ifConfirmed on all three clients: If you confirm sits right above Confirm done, "
    "what counts as done folds to one row, and the words come from one shared fixture."
)
CRITERIA_2 = (
    "1. web、iOS、macOS 卡片按效果图第②台手机排版。\n"
    "2. 三端文案逐字一致。\n"
    "3. CI probe 拍出的 iOS 截图附在证据里。"
)

TASKS = {
    "34YlGb8ou0rxjIZJ8kx5u": {
        "session": "s1",
        "title": "会话间请求与回复：修复 P1 审查发现的问题",
        "projectId": None,
        "acceptanceCriteria": CRITERIA_1,
        "report": REPORT_1,
        "ifConfirmed": {
            "startsTasks": [
                {"id": "34YnHq0SgWQ9oc4bDnqv2", "title": "会话间消息署名：自动重试遇到请求、手动 Retry、计数口径三处待定",
                 "starts": "NOW"},
            ],
            "startsAfterLanding": False,
            "branch": {"name": "orbit/p1-1c207b", "linesAdded": 9432, "linesRemoved": 11, "files": 41,
                       "onMain": "NO"},
            "landing": "NONE",
            "endsSession": None,
        },
    },
    "34Z35ujH0aejOiDNxcONf": {
        "session": "s2",
        "title": "确认卡「If you confirm」三端（web / iOS / macOS）",
        "projectId": "34Z2usxH1u0wBMagUPqlM",
        "acceptanceCriteria": CRITERIA_2,
        "report": REPORT_2,
        "ifConfirmed": {
            "startsTasks": [
                {"id": "34Z35v1nS4l48MjxDIDXX", "title": "先审后呈：审查栏、Under review 与回执（三端）",
                 "starts": "NOW"},
            ],
            "startsAfterLanding": True,
            "branch": {"name": "orbit/if-you-confirm-web-ios-macos-e62fb5", "linesAdded": 812,
                       "linesRemoved": 64, "files": 9, "onMain": "NO"},
            "landing": "LINE_THEN_OWNER",
            "endsSession": {"sessionId": "s2", "runningBgJobs": 2},
        },
    },
}


def session(sid, task_id, title):
    return {
        "id": sid, "title": title, "status": "AWAITING_INPUT", "lastAssistantText": TASKS[task_id]["report"],
        "lastTurnAt": ago(6), "updatedAt": ago(5), "createdAt": ago(90),
        "lifecycleState": "OPEN", "agentId": "a1", "agent": {"id": "a1", "name": "orbit"},
        "folderId": None, "pendingApprovals": 1, "waitingKind": "OWNER_CONFIRMATION",
        "runState": "AWAITING_INPUT", "taskId": task_id, "projectId": None, "tags": [],
    }


SESSIONS = [
    session("s1", "34YlGb8ou0rxjIZJ8kx5u", "执行任务：会话间请求与回复：修复 P1 审查发现的问题"),
    session("s2", "34Z35ujH0aejOiDNxcONf", "执行任务：确认卡「If you confirm」三端（web / iOS / macOS）"),
]


def events(sid):
    task = next(t for t in TASKS.values() if t["session"] == sid)
    return [
        {"seq": 1, "type": "user", "ts": ago(40), "turnId": f"{sid}-turn",
         "payload": {"text": "执行任务：" + task["title"]}},
        {"seq": 2, "type": "assistant", "ts": ago(6), "turnId": f"{sid}-turn",
         "payload": {"text": task["report"]}},
    ]


def owner_confirmation(task_id):
    task = TASKS[task_id]
    return {
        "taskId": task_id, "title": task["title"], "status": "OPEN", "projectId": task["projectId"],
        "completionCriterion": "OWNER_CONFIRMED", "acceptanceCriteria": task["acceptanceCriteria"],
        "waiting": {
            "requestId": "01920000-0000-7000-8000-0000000000" + task["session"].replace("s", "f"),
            "sessionId": task["session"], "requestedAt": ago(5),
            "report": {"text": task["report"], "reportedAt": ago(6)},
        },
        "decisions": [],
        "ifConfirmed": task["ifConfirmed"],
    }


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

    def do_GET(self):
        url = urlparse(self.path)
        parts = [p for p in url.path.split("/") if p]
        if parts == ["api", "agents"]:
            return self.send(200, [AGENT])
        if parts == ["api", "sessions"]:
            view = parse_qs(url.query).get("view", ["open"])[0]
            return self.send(200, SESSIONS if view == "open" else [])
        if parts in (["api", "session-tags"], ["api", "session-folders"]):
            return self.send(200, [])
        if parts == ["api", "runners"]:
            return self.send(200, [RUNNER])
        if parts in (["api", "providers"], ["api", "providers", "pools"], ["api", "providers", "shared-pools"]):
            return self.send(200, [])
        if len(parts) == 4 and parts[:2] == ["api", "tasks"] and parts[3] == "owner-confirmation":
            if parts[2] in TASKS:
                return self.send(200, owner_confirmation(parts[2]))
            return self.send(404, {"statusCode": 404, "message": "task not found"})
        if len(parts) == 5 and parts[:2] == ["api", "sessions"] and parts[3:] == ["events", "page"]:
            return self.send(200, {"events": events(parts[2]) if parts[2] in ("s1", "s2") else [],
                                   "hasMore": False, "before": None, "after": None})
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "share":
            return self.send(200, {"link": None, "counts": {"messages": 2, "toolCalls": 0}})
        if len(parts) == 3 and parts[:2] == ["api", "sessions"]:
            row = next((s for s in SESSIONS if s["id"] == parts[2]), None)
            if row is None:
                return self.send(404, {"statusCode": 404, "message": "session not found"})
            return self.send(200, row)
        return self.send(404, {"error": "not in the probe"})

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        with open(LOG, "a") as f:
            f.write("    body: %s\n" % raw.decode("utf-8", "replace"))
        if parts == ["__reset"]:
            return self.send(200, {"ok": True})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not record decisions"})

    def do_PATCH(self):
        return self.send(404, {"error": "not in the probe"})

    def do_PUT(self):
        return self.send(404, {"error": "not in the probe"})

    def do_DELETE(self):
        return self.send(404, {"error": "not in the probe"})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
