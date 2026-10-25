#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API a coordinator conversation reads on
# the iPhone app, for task 34dQVoIQtWgVP0Ol03o3x (docs/mocks/coordinator-question-answered/, step 4).
# Adapted from probe/coordinator-question-answered's stub. Three coordinator conversations, one project
# each:
#
#   C1 / P1  a question answered with the recommended option: its Answered card (closedQuestions), then
#            the turn that told the coordinator — carrying the `ownerAnswer` card — then the reply
#   C2 / P2  the owner's Not yet… to the coordinator's request to record the project done: the same line
#   C3 / P3  an answer still waiting on the coordinator's queue (GET /sessions/C3/turns?view=active)
#
# The turns' words are what the apiserver writes (`ownerAnswerMessage`, `doneRequestDeclineMessage`), the
# cards what `readOwnerAnswerCard` reads. Times are the mock's: "today" in Asia/Shanghai (the app is
# launched with TZ=Asia/Shanghai), asked at 08:10, answered at 08:29. Every request is logged; anything not
# served is a 404. All data is made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"

SHANGHAI = timezone(timedelta(hours=8))
TODAY = datetime.now(SHANGHAI).date()


def at(hour, minute, second=0, millis=0):
    """An instant on today's Shanghai clock, the way the server spells one."""
    local = datetime(TODAY.year, TODAY.month, TODAY.day, hour, minute, second, millis * 1000, tzinfo=SHANGHAI)
    t = local.astimezone(timezone.utc)
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
            "status": "ONLINE", "version": "0.1.232", "maxConcurrent": 8, "activeSessions": 1,
            "lastHeartbeatAt": now(), "capabilities": [],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}],
            "modelCatalog": {"claude": CLAUDE_MODELS}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


# ── the question, as the coordinator asked it (the board's) ───────────────────────────────────

RESTART = {
    "question": "灰度回退之后的收尾都做完了：\n\n"
                "- 新版本部署之后，维护任务恢复了，第一轮成功跑完，把所有锚点重新检查了一遍。\n"
                "- 灰度期间写错的结论已经清零，失败计数也归零。\n"
                "- 三处修复都已经在生产上。\n\n"
                "请批准重开灰度，做法和第一次一样：名单里仍只有你的账号，只重建两个服务。",
    "options": [
        {"label": "现在重开，接受这个代价（推荐）",
         "description": "不专门挑时间。白做的最多是当前这一轮已经跑掉的部分，下一轮会重新读到，不会丢东西。"},
        {"label": "等新一轮刚开始时再切",
         "description": "盯着下一轮维护一开始就切，浪费最少；可能要等当前这一轮跑完，最长约 2 小时。"},
        {"label": "先不重开", "description": "执行器保持现状，灰度暂停。"},
    ],
    "recommendedOption": 0, "blocksTaskIds": ["34cTask0Rollout00000001"],
    "ifUnanswered": "灰度保持暂停，执行器不动。",
}

ASKED = at(8, 10)
ANSWERED = at(8, 29, 23, 122)
DELIVERED = at(8, 29, 23, 508)


def owner_answer_message(question, option, answered_at):
    """apiserver `ownerAnswerMessage`, word for word."""
    return (f'From Orbit · owner answer: you asked "{question["question"]}". '
            f'The owner answered: {question["options"][option]["label"]} ({answered_at}).')


def done_request_decline_message(note, declined_at):
    """apiserver `doneRequestDeclineMessage`, word for word, for a request with no gaps and no warnings."""
    return "\n".join([
        "From Orbit · owner says not yet for “Is this project done?”.",
        f"What’s missing before it’s done? {note}",
        "Coordinator judgment: Every criterion is landed on main and the docs are published.",
        "Gaps the coordinator named:",
        "None recorded.",
        "Warnings on the card:",
        "None.",
        "After the missing work is complete, call project_request_done again.",
        f"Answered at {declined_at}.",
    ])


def card(item, kind, session, delivered):
    """What `readOwnerAnswerCard` records beside the turn."""
    return {"itemId": item, "kind": kind, "sessionId": session, "deliveredAt": delivered}


def closed(item, question, asked, resolved, option, delivered_to):
    return {"itemId": item, "question": question, "askedAt": asked, "resolution": "ANSWERED", "resolvedBy": "USER",
            "resolvedAt": resolved, "answer": {"option": option, "text": None},
            "delivery": {"sessionId": delivered_to, "at": resolved}, "withdrawReason": None}


def ev(seq, typ, turn, payload, ts):
    return {"seq": seq, "type": typ, "ts": ts, "turnId": turn, "payload": payload}


def exchange(seq, turn_id, ask, ask_at, reply, reply_at, ask_payload=None):
    return [ev(seq, "user", turn_id, {"text": ask, **(ask_payload or {})}, ask_at),
            ev(seq + 1, "assistant", turn_id, {"text": reply, "messageId": f"m{seq}"}, reply_at),
            ev(seq + 2, "result", turn_id, {"subtype": "success", "result": "done"}, reply_at)]


TOLD_C1 = owner_answer_message(RESTART, 0, ANSWERED)
TOLD_C3 = owner_answer_message(RESTART, 1, ANSWERED)
NOT_YET = "生产环境的迁移还没跑，跑完把最后一条验收证据贴回来。"
DECLINED = at(8, 41, 2, 310)
TOLD_C2 = done_request_decline_message(NOT_YET, DECLINED)


def fresh_state():
    projects = {
        "P1": {"title": "Wiki 服务端执行", "session": "C1", "status": "AWAITING_INPUT",
               "closed": [closed("Q1", RESTART, ASKED, ANSWERED, 0, "C1")],
               "queued": [],
               "events": exchange(1, "t1", "灰度回退之后的收尾做完了吗？做完了就问我什么时候重开灰度。", at(8, 2),
                                  "收尾都做完了。我用 ask_owner 问你什么时候重开灰度，你答复之前我不动生产。", ASKED)
                         + exchange(4, "t2", TOLD_C1, DELIVERED,
                                    "收到：现在重开灰度。我先切流量，再盯第一轮维护跑完。", at(8, 29, 58),
                                    {"ownerAnswer": card("Q1", "COORDINATOR_QUESTION", "C1", DELIVERED)})},
        "P2": {"title": "Wiki 服务端执行：收尾", "session": "C2", "status": "AWAITING_INPUT",
               "closed": [], "queued": [],
               "events": exchange(1, "t1", "都做完了吗？做完了就请我把项目记成完成。", at(8, 35),
                                  "每条验收标准都已落到 main，文档也发布了。我已经请你把项目记成完成。", at(8, 38))
                         + exchange(4, "t2", TOLD_C2, at(8, 41, 2, 640),
                                    "收到，还差生产迁移。我去跑迁移，跑完把验收证据贴回来，再请你确认。", at(8, 41, 30),
                                    {"ownerAnswer": card("D1", "DONE_REQUEST", "C2", at(8, 41, 2, 640))})},
        "P3": {"title": "灰度重开（答复排队中）", "session": "C3", "status": "RUNNING",
               "closed": [closed("Q3", RESTART, ASKED, ANSWERED, 1, "C3")],
               "queued": [{"turnId": "tq1", "kind": "message", "placement": "queued", "content": TOLD_C3,
                           "createdAt": DELIVERED, "attachments": [],
                           "ownerAnswer": card("Q3", "COORDINATOR_QUESTION", "C3", DELIVERED),
                           "authoredByOrbit": True}],
               "events": exchange(1, "t1", "先把灰度的监控面板整理一下，然后问我什么时候重开。", at(8, 2),
                                  "好，我先整理监控面板；重开的时机我已经提成问题给你了。", ASKED)},
    }
    return {"projects": projects}


STATE = fresh_state()


def project_of(session):
    for pid, p in STATE["projects"].items():
        if p["session"] == session:
            return pid, p
    return None, None


def session_row(pid, p):
    last = [e for e in p["events"] if e["type"] == "assistant"][-1]
    status = p["status"]
    return {"id": p["session"], "title": p["title"], "status": status, "runStatus": status,
            "runState": status, "sessionState": status, "lifecycleState": "OPEN",
            "filingState": "OPEN", "agentId": "a1", "agent": {"id": "a1", "name": "orbit-develop"},
            "assignedRunnerId": "hpc", "provider": "claude", "model": "claude-opus-5-5", "effort": "high",
            "permissionMode": "default", "taskId": None, "projectId": pid, "projectTitle": p["title"],
            "projectMembership": {"projectId": pid, "projectTitle": p["title"], "projectStatus": "OPEN",
                                  "role": "COORDINATOR"},
            "titleManagedByProject": True, "createdAt": p["events"][0]["ts"], "updatedAt": last["ts"],
            "lastTurnAt": last["ts"], "lastAssistantText": last["payload"]["text"], "pendingApprovals": 0,
            "tags": [], "folderId": None, "source": "USER"}


def open_items(p):
    return {"needsYou": [], "withCoordinator": [], "settled": [], "startRequest": None,
            "doneRequest": None, "closedQuestions": sorted(p["closed"], key=lambda r: r["resolvedAt"], reverse=True)}


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
                     ["api", "task-lists"], ["api", "watches"], ["api", "share-links"]):
            return self.send(200, [])
        if parts == ["api", "projects"]:
            return self.send(200, [])
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            rows = [session_row(pid, p) for pid, p in STATE["projects"].items()]
            return self.send(200, rows if view == "open" else [])
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            pid, p = project_of(parts[2])
            if p is None:
                return self.send(404, {"error": "not in the probe"})
            rest = parts[3:]
            if rest == []:
                return self.send(200, session_row(pid, p))
            if rest == ["events"]:
                return self.stream(p, int(query.get("sinceSeq", ["0"])[0] or 0))
            if rest == ["events", "page"]:
                return self.send(200, {"events": p["events"], "hasMore": False, "before": None, "after": None})
            if rest == ["turns"]:
                return self.send(200, p["queued"])
            if rest == ["approvals"]:
                return self.send(200, [])
            return self.send(404, {"error": "not in the probe"})
        if len(parts) >= 3 and parts[:2] == ["api", "projects"] and parts[2] in STATE["projects"]:
            p = STATE["projects"][parts[2]]
            rest = parts[3:]
            if rest == ["open-items"]:
                return self.send(200, open_items(p))
            if rest == ["promotions", "current"]:
                return self.send(200, None)
            if rest == ["promotions", "merged"]:
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

    def stream(self, p, sent):
        """Replay what follows `sinceSeq` (SSE `data:` frames, the server's framing), then keep the
        stream alive inside the clients' 45 s watchdog."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        last_ping = time.time()
        try:
            while True:
                for e in p["events"]:
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
        self.body()
        if parts == ["__reset"]:
            STATE.clear()
            STATE.update(fresh_state())
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
    print("stub listening on 127.0.0.1:%d (python %s), today %s in Shanghai" % (PORT, sys.version.split()[0], TODAY),
          flush=True)
    server.serve_forever()
