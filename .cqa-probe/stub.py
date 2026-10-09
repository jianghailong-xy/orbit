#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API a coordinator conversation reads on
# the iPhone app, for task 34ceRLXU8u4QA1DrQF74A (docs/mocks/coordinator-question-answered/). Seven
# coordinator conversations, one project each, whose GET /api/projects/:id/open-items carries the
# questions that have ended (`closedQuestions`) in every way the board draws them:
#
#   C1 / P1  two questions answered with the recommended option, both delivered   (2-proposal ①, phone-new)
#   C2 / P2  an option and a note                                                  (3 ①, phone-new-sheet-note)
#   C3 / P3  the Other row: the owner's own words                                  (3 ②)
#   C4 / P4  a question with no options, answered in words yesterday               (3 ③)
#   C5 / P5  answered while no coordinator was bound: nobody has had it yet        (3 ④)
#   C6 / P6  withdrawn by the coordinator, with its reason                         (3 ⑤)
#   C7 / P7  a question still open, answered by the test through the app's own Send answer:
#            POST /api/projects/P7/open-items/Q8/answer moves it into closedQuestions, as the server does.
#
# Times are the mock's: "today" is 08:30 in Asia/Shanghai (the app is launched with TZ=Asia/Shanghai),
# questions asked at 08:10 and answered at 08:29. Every request is logged with its body; anything not
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


def at(hour, minute, second=0, days=0):
    """An instant on today's (or `days` earlier's) Shanghai clock, the way the server spells one."""
    local = datetime(TODAY.year, TODAY.month, TODAY.day, hour, minute, second, tzinfo=SHANGHAI) - timedelta(days=days)
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


# ── the questions, as the coordinator asked them ───────────────────────────────────────────────

RESTART = {
    "question": "灰度回退之后的收尾都做完了：\n\n"
                "- 新版本部署之后，维护任务恢复了，第一轮成功跑完，把所有锚点重新检查了一遍。\n"
                "- 灰度期间写错的结论已经清零，失败计数也归零。\n"
                "- 三处修复都已经在生产上。\n\n"
                "请批准重开灰度，做法和第一次一样：名单里仍只有你的账号，只重建两个服务。\n\n"
                "有一个代价：切换那一刻如果正好有一轮维护在跑，这一轮会在下次自检时被拒，已经做的就白做了"
                "（上次约 20 分钟）。现在一轮要 2 小时左右，很难等到空档。",
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
EXPORT = {
    "question": "灰度跑完之后，要用真实数据对照一次新旧两条路径的结果：在只读事务里导出模型请求、回答和结论，"
                "约 100 条，跟旧路径逐条比对。\n\n导出要从生产库取文件，有三种做法。",
    "options": [
        {"label": "批准经现有 SSH 取文件（推荐）", "description": "走已有的运维 SSH 通道，只读，导出后立即删除。"},
        {"label": "改用任务评论传", "description": "把导出结果贴进任务评论，量大时要分段。"},
        {"label": "不做真实数据对照", "description": "只用测试数据比对，可能漏掉真实分布里的边角。"},
    ],
    "recommendedOption": 0, "blocksTaskIds": [], "ifUnanswered": None,
}
NIGHT = {
    "question": "文章重写排在夜里还是白天？夜里不占你白天的额度，但出问题要到第二天早上才有人看。你有偏好的时段吗？",
    "options": [], "recommendedOption": None, "blocksTaskIds": [], "ifUnanswered": None,
}


def closed(item, question, asked, resolved, option=None, text=None, delivered_to=None, withdrawn=None,
           by="USER"):
    return {"itemId": item, "question": question, "askedAt": asked,
            "resolution": "WITHDRAWN" if withdrawn else "ANSWERED", "resolvedBy": by, "resolvedAt": resolved,
            "answer": None if withdrawn else {"option": option, "text": text},
            "delivery": {"sessionId": delivered_to, "at": resolved} if delivered_to else None,
            "withdrawReason": withdrawn}


def open_row(item, question, asked):
    return {"itemId": item, "kind": "COORDINATOR_QUESTION", "title": "Coordinator asks: " + question["question"],
            "detailLine": "Blocks 1 task · If you don’t answer: 灰度保持暂停，执行器不动。",
            "assignee": "OWNER", "assigneeReason": "DEFAULT", "waitingSince": asked, "escalateAt": None,
            "escalatedAt": None, "taskId": None, "sessionId": None, "promotionId": None, "fuseEpisodeId": None,
            "delivery": {"state": "NOT_REQUIRED", "sessionId": None, "at": None}, "actions": ["ANSWER"],
            "primaryAction": "ANSWER", "requiredAction": "Answer the coordinator's question.",
            "question": question, "startRequest": None, "doneRequest": None, "facts": None,
            "handling": None, "outcome": None,
            "chat": {"sessionId": "C7", "stage": "WITH_OWNER", "refusal": None}}


def ev(seq, typ, turn, payload, ts):
    return {"seq": seq, "type": typ, "ts": ts, "turnId": turn, "payload": payload}


def turn(seq, turn_id, ask, ask_at, reply, reply_at):
    return [ev(seq, "user", turn_id, {"text": ask}, ask_at),
            ev(seq + 1, "assistant", turn_id, {"text": reply, "messageId": f"m{seq}"}, reply_at),
            ev(seq + 2, "result", turn_id, {"subtype": "success", "result": "done"}, reply_at)]


ASKED = at(8, 10)
ANSWERED = at(8, 29, 23)


def fresh_state():
    projects = {
        "P1": {"title": "Wiki 服务端执行", "session": "C1",
               "closed": [closed("Q1", RESTART, ASKED, ANSWERED, option=0, delivered_to="C1"),
                          closed("Q2", EXPORT, ASKED, at(8, 29, 36), option=0, delivered_to="C1")],
               "open": [],
               "events": turn(1, "t1", "灰度回退之后的收尾做完了吗？做完了就把重开灰度和真实数据对照一起问我。", at(8, 2),
                              "收尾都做完了。我用 ask_owner 提了两个问题：什么时候重开灰度，和真实数据对照怎么取文件。"
                              "你答复之前我不动生产。", ASKED)
                         + turn(4, "t2", "From Orbit · owner answer: 两个问题都已答复。", at(8, 29, 40),
                                "收到。现在重开灰度，经现有 SSH 取文件做对照。我先切流量，再开始导出。", at(8, 29, 58))},
        "P2": {"title": "灰度重开：挑切换时机", "session": "C2",
               "closed": [closed("Q3", RESTART, ASKED, ANSWERED, option=1,
                                 text="今晚 22 点以后再切，白天有人在用。", delivered_to="C2")],
               "open": [],
               "events": turn(1, "t1", "灰度什么时候能重开？", at(8, 2),
                              "收尾做完了，我把重开的时机提成问题给你。", ASKED)},
        "P3": {"title": "真实数据对照", "session": "C3",
               "closed": [closed("Q4", EXPORT, ASKED, ANSWERED, text="先别取文件，等我明天看过导出脚本再说。",
                                 delivered_to="C3")],
               "open": [],
               "events": turn(1, "t1", "对照的数据从哪儿来？", at(8, 2),
                              "要从生产库导出，取法有三种，我提成问题给你。", ASKED)},
        "P4": {"title": "文章重写排期", "session": "C4",
               "closed": [closed("Q5", NIGHT, at(21, 40, days=1), at(22, 5, days=1),
                                 text="夜里跑，出了问题等我早上看。", delivered_to="C4")],
               "open": [],
               "events": turn(1, "t1", "文章重写什么时候开始？", at(21, 30, days=1),
                              "排期要你定一下时段，我问你一句。", at(21, 40, days=1))
                         + turn(4, "t2", "今晚的重写开始了吗？", at(8, 12),
                                "开始了，第一批 40 篇在跑，目前都正常。", at(8, 13))},
        "P5": {"title": "灰度重开（等下一个协调者）", "session": "C5",
               "closed": [closed("Q6", RESTART, ASKED, ANSWERED, option=0)],
               "open": [],
               "events": turn(1, "t1", "灰度什么时候能重开？", at(8, 2),
                              "收尾做完了，我把重开灰度提成问题给你。", ASKED)},
        "P6": {"title": "导出对照（已撤回）", "session": "C6",
               "closed": [closed("Q7", EXPORT, ASKED, at(8, 40), withdrawn="灰度已经回退，这一步不需要了。",
                                 by="COORDINATOR")],
               "open": [],
               "events": turn(1, "t1", "对照的数据从哪儿来？", at(8, 2),
                              "要从生产库导出，取法有三种，我提成问题给你。", ASKED)
                         + turn(4, "t2", "灰度回退了，对照还做吗？", at(8, 38),
                                "不用做了，我把那个问题撤回。", at(8, 39))},
        "P7": {"title": "现场作答", "session": "C7",
               "closed": [],
               "open": [open_row("Q8", RESTART, ASKED)],
               "events": turn(1, "t1", "灰度什么时候能重开？", at(8, 2),
                              "收尾做完了，我把重开灰度提成问题给你，你答复之前我不动生产。", ASKED)},
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
    return {"id": p["session"], "title": p["title"], "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
            "runState": "AWAITING_INPUT", "sessionState": "AWAITING_INPUT", "lifecycleState": "OPEN",
            "filingState": "OPEN", "agentId": "a1", "agent": {"id": "a1", "name": "orbit-develop"},
            "assignedRunnerId": "hpc", "provider": "claude", "model": "claude-opus-5-5", "effort": "high",
            "permissionMode": "default", "taskId": None, "projectId": pid, "projectTitle": p["title"],
            "projectMembership": {"projectId": pid, "projectTitle": p["title"], "projectStatus": "OPEN",
                                  "role": "COORDINATOR"},
            "titleManagedByProject": True, "createdAt": p["events"][0]["ts"], "updatedAt": last["ts"],
            "lastTurnAt": last["ts"], "lastAssistantText": last["payload"]["text"], "pendingApprovals": 0,
            "tags": [], "folderId": None, "source": "USER"}


def open_items(p):
    return {"needsYou": p["open"], "withCoordinator": [], "settled": [], "startRequest": None,
            "doneRequest": None, "closedQuestions": sorted(p["closed"], key=lambda r: r["resolvedAt"], reverse=True)}


def answer(pid, p, item, body):
    row = next((r for r in p["open"] if r["itemId"] == item), None)
    if row is None:
        return 409, {"statusCode": 409, "code": "OPEN_ITEM_NOT_OPEN", "message": "this question is no longer open."}
    option = body.get("option")
    text = (body.get("text") or "").strip() or None
    resolved = now()
    p["open"].remove(row)
    p["closed"].append(closed(item, row["question"], row["waitingSince"], resolved, option=option, text=text,
                              delivered_to=p["session"]))
    return 201, {"itemId": item, "state": "RESOLVED", "resolution": "ANSWERED",
                 "delivery": {"sessionId": p["session"], "turnId": "turn-answer-" + item}}


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
            if rest in (["approvals"], ["turns"]):
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
        body = self.body()
        if parts == ["__reset"]:
            STATE.clear()
            STATE.update(fresh_state())
            return self.send(200, {"ok": True})
        if (len(parts) == 6 and parts[:2] == ["api", "projects"] and parts[3] == "open-items"
                and parts[5] == "answer" and parts[2] in STATE["projects"]):
            status, out = answer(parts[2], STATE["projects"][parts[2]], parts[4], body)
            return self.send(status, out)
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything else"})

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
