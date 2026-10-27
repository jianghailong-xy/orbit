#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API a coordinator conversation reads on
# the iPhone app, for task 34nGWN2Poh34ku8ad93Ud (docs/mocks/owner-answer-sent-card/merged.html, tone.html).
# Adapted from probe/answer-delivery-one-line's stub. One coordinator conversation per project:
#
#   C1 / P1  the coordinator was idle: the question answered with 批准三条 at 11:52, the turn that told it
#            the answer — carrying the `ownerAnswer` card — then its reply. The record of the question is in
#            the open-items read (closedQuestions), so the turn is drawn as that one Answered card.
#   C2 / P2  the owner's Not yet… to the coordinator's request to record the project done: still the line.
#   C3 / P3  the coordinator was busy: the answer (11:30) still waits on the queue behind its running turn
#            (GET /sessions/C3/turns), so the card is dashed and says it is queued.
#   C4 / P4  an answer to a question the read does not carry (older than its last 50): still the line.
#   C5 / P5  the turn that told the coordinator, echoed with its delivery failed: the card says the session
#            has not confirmed it.
#
# The question, its options and the times are the board's (docs/mocks/owner-answer-sent-card/built/), the
# turns' words what the apiserver writes (`ownerAnswerMessage`, `doneRequestDeclineMessage`), the cards what
# `readOwnerAnswerCard` reads. "Today" is the zone run.sh picks so that it is about 13:00 there when the run
# starts (PROBE_UTC_OFFSET, and the app is launched in the same zone): every time below is earlier the same
# day, wherever the runner's clock is. Every request is logged; anything not served is a 404, and every write
# a 409. All data is made up.
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"

ZONE = timezone(timedelta(hours=int(os.environ.get("PROBE_UTC_OFFSET", "8"))))
TODAY = datetime.now(ZONE).date()


def at(hour, minute, second=0, millis=0):
    """An instant on today's clock in the probe's zone, the way the server spells one."""
    local = datetime(TODAY.year, TODAY.month, TODAY.day, hour, minute, second, millis * 1000, tzinfo=ZONE)
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

APPROVE = {
    "question": "请批准 P1 在 dev 表上演练压缩编码切换。这条由我代 P1 发出：任务会话调不了 ask_owner，"
                "它从昨天下午起一直在等批准，表还没动过。\n\n"
                "表：`analytics.events_dev`（dev 表，2.1 TiB，最后写入 09-20，没有其他写入方）。原始 schema 已存档。\n\n"
                "按顺序执行三条：① apply → ② rollback（同一批列改回原编码）→ ③ 再 apply。"
                "每步之后逐列回读，③ 之后观察 1 小时。",
    "options": [
        {"label": "批准三条", "description": "按 ① → ② → ③ 执行，每步之后逐列回读。"},
        {"label": "只批准 ①", "description": "先 apply，回滚和再 apply 等看过结果再说。"},
        {"label": "先不动", "description": "P1 继续等，表保持现状。"},
    ],
    "recommendedOption": 0, "blocksTaskIds": ["34cTaskP1Compression0001"],
    "ifUnanswered": "P1 继续等，表不动。",
}

ASKED = at(11, 20)


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


ASK_P1 = "P1 的压缩编码切换在等批准，它自己调不了 ask_owner。你替它问我。"
ASKED_REPLY = "我代它把批准请求发给你。问题已经发出，你在卡片上选就行。答复回来之前，我不动 P1。"

ANSWERED_C1 = at(11, 52, 0, 0)
TOLD_AT_C1 = at(11, 52, 0, 412)
TOLD_C1 = owner_answer_message(APPROVE, 0, ANSWERED_C1)
REPLY_C1 = "收到：批准三条。我把批准转给 P1，并让它每步之后逐列回读。\n\nP1 已开始 ①。它每步回读完我会看一眼结果，有异常再找你。"

ANSWERED_C3 = at(11, 30, 0, 0)
TOLD_C3 = owner_answer_message(APPROVE, 0, ANSWERED_C3)

NOT_YET = "生产环境的迁移还没跑，跑完把最后一条验收证据贴回来。"
DECLINED = at(11, 41, 2, 310)
TOLD_C2 = done_request_decline_message(NOT_YET, DECLINED)


def fresh_state():
    projects = {
        "P1": {"title": "压缩编码切换演练", "session": "C1", "status": "AWAITING_INPUT",
               "closed": [closed("Q1", APPROVE, ASKED, ANSWERED_C1, 0, "C1")],
               "queued": [],
               "events": exchange(1, "t1", ASK_P1, at(11, 18), ASKED_REPLY, ASKED)
                         + exchange(4, "t2", TOLD_C1, TOLD_AT_C1, REPLY_C1, at(11, 53, 28),
                                    {"ownerAnswer": card("Q1", "COORDINATOR_QUESTION", "C1", TOLD_AT_C1)})},
        "P2": {"title": "Wiki 服务端执行：收尾", "session": "C2", "status": "AWAITING_INPUT",
               "closed": [], "queued": [],
               "events": exchange(1, "t1", "都做完了吗？做完了就请我把项目记成完成。", at(11, 35),
                                  "每条验收标准都已落到 main，文档也发布了。我已经请你把项目记成完成。", at(11, 38))
                         + exchange(4, "t2", TOLD_C2, at(11, 41, 2, 640),
                                    "收到，还差生产迁移。我去跑迁移，跑完把验收证据贴回来，再请你确认。", at(11, 41, 30),
                                    {"ownerAnswer": card("D1", "DONE_REQUEST", "C2", at(11, 41, 2, 640))})},
        "P3": {"title": "P2 合并检查排查", "session": "C3", "status": "RUNNING",
               "closed": [closed("Q3", APPROVE, ASKED, ANSWERED_C3, 0, "C3")],
               "queued": [{"turnId": "tq1", "kind": "message", "placement": "queued", "content": TOLD_C3,
                           "createdAt": ANSWERED_C3, "attachments": [],
                           "ownerAnswer": card("Q3", "COORDINATOR_QUESTION", "C3", ANSWERED_C3),
                           "authoredByOrbit": True}],
               "events": [ev(1, "user", "t1", {"text": "P2 的合并检查红了，查一下是不是它的问题。"}, at(11, 6)),
                          ev(2, "assistant", "t1", {"text": "我先拉 P2 最近一次合并检查的日志。", "messageId": "m2"},
                             at(11, 25)),
                          ev(3, "assistant", "t1",
                             {"text": "是 web 套件里一个时区相关的用例，和 P2 的改动无关；我在主干上复现一遍确认。",
                              "messageId": "m3"}, at(11, 31))]},
        "P4": {"title": "压缩编码切换演练（旧问题）", "session": "C4", "status": "AWAITING_INPUT",
               "closed": [], "queued": [],
               "events": exchange(1, "t1", ASK_P1, at(11, 18), ASKED_REPLY, ASKED)
                         + exchange(4, "t2", TOLD_C1, TOLD_AT_C1, REPLY_C1, at(11, 53, 28),
                                    {"ownerAnswer": card("Q4", "COORDINATOR_QUESTION", "C4", TOLD_AT_C1)})},
        "P5": {"title": "压缩编码切换演练（未确认）", "session": "C5", "status": "AWAITING_INPUT",
               "closed": [closed("Q5", APPROVE, ASKED, ANSWERED_C1, 0, "C5")],
               "queued": [],
               "events": exchange(1, "t1", ASK_P1, at(11, 18), ASKED_REPLY, ASKED)
                         + [ev(4, "user", "t2", {"text": TOLD_C1, "delivery": "failed",
                                                 "ownerAnswer": card("Q5", "COORDINATOR_QUESTION", "C5", TOLD_AT_C1)},
                               TOLD_AT_C1)]},
    }
    return {"projects": projects}


STATE = fresh_state()


def project_of(session):
    for pid, p in STATE["projects"].items():
        if p["session"] == session:
            return pid, p
    return None, None


def session_row(pid, p):
    said = [e for e in p["events"] if e["type"] == "assistant"][-1]
    last = p["events"][-1]
    status = p["status"]
    return {"id": p["session"], "title": p["title"], "status": status, "runStatus": status,
            "runState": status, "sessionState": status, "lifecycleState": "OPEN",
            "filingState": "OPEN", "agentId": "a1", "agent": {"id": "a1", "name": "orbit-develop"},
            "assignedRunnerId": "hpc", "provider": "claude", "model": "claude-opus-5-5", "effort": "high",
            "permissionMode": "default", "taskId": None, "projectId": pid, "projectTitle": p["title"],
            "projectMembership": {"projectId": pid, "projectTitle": p["title"], "projectStatus": "OPEN",
                                  "role": "COORDINATOR"},
            "titleManagedByProject": True, "createdAt": p["events"][0]["ts"], "updatedAt": last["ts"],
            "lastTurnAt": last["ts"], "lastAssistantText": said["payload"]["text"], "pendingApprovals": 0,
            "tags": [], "folderId": None, "source": "USER"}


def open_items(p):
    return {"needsYou": [], "withCoordinator": [], "settled": [], "startRequest": None,
            "doneRequest": None, "closedQuestions": sorted(p["closed"], key=lambda r: r["resolvedAt"], reverse=True)}


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
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})

    def do_DELETE(self):
        self.body()
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not change anything"})


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
    print("stub listening on 127.0.0.1:%d (python %s), today %s at UTC%+d" % (PORT, sys.version.split()[0], TODAY,
                                                                          int(os.environ.get("PROBE_UTC_OFFSET", "8"))),
          flush=True)
    server.serve_forever()
