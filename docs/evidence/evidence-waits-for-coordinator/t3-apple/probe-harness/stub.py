#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API a coordinator conversation reads on
# the iPhone app, for task 34cypwBO5kaUgiNSZIGQP (docs/mocks/evidence-waits-for-coordinator/). One
# coordinator conversation C1, coordinating project P1:
#
#   stage "queued"  The coordinator stopped on Claude's weekly limit 1 h 51 min ago: run FAILED, the
#                   runtime's own sentence as its error, a retry armed for the reset three days out. A
#                   task submitted revision 1 of its evidence just now, and it waits for the coordinator
#                   (`waitingOnCoordinator`). Nothing is counted: `pendingApprovals` is 0.
#   stage "sent"    POST /__set {"stage": "sent"}: the coordinator is back. The platform handed it the
#                   waiting revision (the delivery message, with T1's sentence), it is reading it, and
#                   the revision is in `sentToCoordinator`, delivered now.
#
# POST /api/tasks/:id/evidence/decision records the owner's answer as the door does; the read then lists
# it under `decided`. Times are real: "now" is this stub's clock in Asia/Shanghai (the app is launched
# with TZ=Asia/Shanghai). Every request is logged with its body; anything not served is a 404. All data
# is made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"

SHANGHAI = timezone(timedelta(hours=8))


def iso(t):
    t = t.astimezone(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def now():
    return datetime.now(timezone.utc)


AGENTS = [{"id": "a1", "name": "orbit-develop", "provider": "claude", "lastProvider": "claude", "runnerId": "hpc",
           "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/root/orbit",
           "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]
CLAUDE_MODELS = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "reasoningLevels": ["low", "medium", "high", "max"]}]


def runner():
    return {"id": "hpc", "name": "HPC", "displayName": "HPC", "hostname": "workstation", "online": True,
            "status": "ONLINE", "version": "0.1.232", "maxConcurrent": 8, "activeSessions": 1,
            "lastHeartbeatAt": iso(now()), "capabilities": [],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}],
            "modelCatalog": {"claude": CLAUDE_MODELS}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


# ── the project, its coordinator and the revision that waits ────────────────────────────────────

PROJECT = "P1"
SESSION = "C1"
PROJECT_TITLE = "Tablet 客户端：与 iOS 体验对齐"
TASK = "34dB07cTabletCardsRev01"
TASK_TITLE = "B07c · 卡片增量与会话提醒条（B07-1/2/3/4/5/6/7/8/9/11）"
EARLIER_TITLE = "B05c · 导航与会话目录增量（B05-1/2/3）"
CRITERION = {"key": "7ltHYVUfWyfgtp1Etv0ym",
             "text": "Tablet 的审批、询问、确认及任务 / 项目操作卡片，与 iOS 提供相同的业务操作和最终结果。"}
GAPS = [
    "设备旅程跑在受控的 HTTP fixture 和单台模拟器（API 36，720×1280@320dpi）上；真实服务端只覆盖了两张卡；没有在实体机上跑。",
    "设备轮次用的是倒数第二个提交的安装包；最后一个提交只改了两个脚本，不进安装包，门禁已在末端重跑。",
    "与基线相同的三个既有红：和本任务无关，基线上同样失败，已列出名字和失败行。",
    "横屏只截了审批卡和确认卡，其余七张只在竖屏上看过。",
    "TalkBack 只走了提问卡，其余卡片的读屏顺序没有逐张核对。",
    "深色模式只截了四张卡。",
    "大字号（200%）下只看了审批卡。",
    "网络中断后的重试只在提问卡上模拟过。",
    "会话提醒条的计数只对照了 Web，没有对照 iOS 的同一个会话。",
]
CLAIM = ("B07 的九张卡在平板上与 iOS 对齐：审批、询问、确认、任务与项目操作的按钮、文案和最终结果逐张对照过，"
         "设备旅程的截图和请求日志都在任务证据里；会话提醒条的计数与 Web 一致。")


def delivery_text(title, revision, waited_since=None):
    text = (f"[Project “{PROJECT_TITLE}” has evidence waiting for your judgment] Task “{title}” submitted "
            f"revision {revision} of its completion evidence.")
    if waited_since:
        text += (f" This revision was submitted at {iso(waited_since)} while you were unavailable. "
                 "It waited for you; nobody has decided it yet.")
    return text


def fresh_state():
    t0 = now()
    reset = datetime.combine((t0.astimezone(SHANGHAI) + timedelta(days=3)).date(),
                             datetime.min.time(), SHANGHAI).replace(hour=19)
    limit = f"You've hit your weekly limit · resets {reset.strftime('%b')} {reset.day}, 7pm (Asia/Shanghai)"
    hit = t0 - timedelta(hours=1, minutes=51)
    events = [
        {"seq": 1, "type": "user", "ts": iso(hit - timedelta(seconds=2)), "turnId": "t1",
         "payload": {"text": delivery_text(EARLIER_TITLE, 2)}},
        {"seq": 2, "type": "assistant", "ts": iso(hit), "turnId": "t1",
         "payload": {"text": limit, "messageId": "m2"}},
        {"seq": 3, "type": "result", "ts": iso(hit), "turnId": "t1",
         "payload": {"subtype": "success", "result": limit}},
    ]
    return {"stage": "queued", "limit": limit, "resets": reset, "hit": hit, "events": events,
            "submitted": t0 - timedelta(seconds=20), "delivered": None, "decided": None}


STATE = fresh_state()


def evidence_row():
    submitted = STATE["submitted"]
    return {"taskId": TASK, "title": TASK_TITLE, "status": "OPEN", "projectId": PROJECT, "ownerCard": None,
            "criterion": CRITERION, "evidenceRevision": "1", "submittedAt": iso(submitted),
            "ageSeconds": max(0, int((now() - submitted).total_seconds())), "claim": CLAIM, "gaps": GAPS,
            "citations": [
                {"kind": "TOOL_CALL", "ref": "bgj_7f3a90c1d2e4", "resolved": True, "reason": None,
                 "label": "Bash · bash src/android/scripts/cards-device-test.sh"},
                {"kind": "TOOL_CALL", "ref": "toolu_01B07cGradle", "resolved": True, "reason": None,
                 "label": "Bash · ./gradlew :app:testDebugUnitTest"},
                {"kind": "COMMIT", "ref": "3c9d2e1a7", "resolved": True, "reason": None, "label": None}],
            "decidability": {"decidable": True, "refusal": None, "requiredAction": None},
            "independence": {"independent": True, "disqualification": None, "requiredAction": None}}


def pending():
    waiting, sent = [], []
    if STATE["decided"] is None:
        if STATE["stage"] == "queued":
            waiting = [evidence_row()]
        else:
            sent = [{"taskId": TASK, "title": TASK_TITLE, "projectId": PROJECT, "evidenceRevision": "1",
                     "deliveredAt": iso(STATE["delivered"])}]
    return {"readAt": iso(now()), "decidingSessionId": SESSION, "count": 0, "oldestAgeSeconds": None,
            "pending": [], "waitingOnYou": [], "decided": [STATE["decided"]] if STATE["decided"] else [],
            "waitingOnCoordinator": waiting, "sentToCoordinator": sent}


def session_row():
    events = STATE["events"]
    last = events[-1]
    replies = [e for e in events if e["type"] == "assistant"]
    paused = STATE["stage"] == "queued"
    status = "FAILED" if paused else "AWAITING_INPUT"
    return {"id": SESSION, "title": PROJECT_TITLE, "status": status, "runStatus": status, "runState": status,
            "lifecycleState": "OPEN", "filingState": "OPEN",
            "agentId": "a1", "agent": {"id": "a1", "name": "orbit-develop"},
            "assignedRunnerId": "hpc", "provider": "claude", "model": "claude-opus-5-5", "effort": "max",
            "permissionMode": "default", "taskId": None, "projectId": PROJECT, "projectTitle": PROJECT_TITLE,
            "projectMembership": {"projectId": PROJECT, "projectTitle": PROJECT_TITLE, "projectStatus": "OPEN",
                                  "role": "COORDINATOR"},
            "titleManagedByProject": True, "createdAt": events[0]["ts"], "updatedAt": last["ts"],
            "lastTurnAt": last["ts"], "lastAssistantText": replies[-1]["payload"]["text"] if replies else None,
            "pendingApprovals": 0, "tags": [], "folderId": None, "source": "USER",
            "error": STATE["limit"] if paused else None,
            "retryAt": iso(STATE["resets"]) if paused else None, "retryAttempts": 1 if paused else 0}


def flip_to_sent():
    """The coordinator is back: the platform hands it the revision that waited, and it starts reading."""
    if STATE["stage"] == "sent":
        return
    t = now()
    STATE["stage"] = "sent"
    STATE["delivered"] = t
    n = STATE["events"][-1]["seq"]
    STATE["events"] += [
        {"seq": n + 1, "type": "user", "ts": iso(t), "turnId": "t2",
         "payload": {"text": delivery_text(TASK_TITLE, 1, STATE["submitted"])}},
        {"seq": n + 2, "type": "assistant", "ts": iso(t + timedelta(seconds=4)), "turnId": "t2",
         "payload": {"text": "收到。我先对照判据读这一版证据，读完给出判定。", "messageId": f"m{n + 2}"}},
        {"seq": n + 3, "type": "result", "ts": iso(t + timedelta(seconds=4)), "turnId": "t2",
         "payload": {"subtype": "success", "result": "done"}},
    ]


def decide(task, body):
    if task != TASK:
        return 404, {"statusCode": 404, "message": "no such task in the probe"}
    if STATE["decided"] is not None:
        return 409, {"statusCode": 409, "code": "EVIDENCE_JUDGMENT_ALREADY_DECIDED",
                     "message": "this revision has already been decided."}
    if body.get("decidingSessionId") != SESSION or body.get("evidenceRevision") != "1" \
            or body.get("decision") not in ("CONFIRM", "SEND_BACK"):
        return 400, {"statusCode": 400, "message": "the probe expects C1, revision 1, CONFIRM or SEND_BACK"}
    at = iso(now())
    note = body.get("note")
    STATE["decided"] = {"taskId": TASK, "title": TASK_TITLE, "projectId": PROJECT, "evidenceRevision": "1",
                        "decision": body["decision"], "note": note, "decidedAt": at, "decidedByType": "USER"}
    return 201, {"taskId": TASK, "evidenceRevision": "1", "decision": body["decision"], "note": note,
                 "decidedAt": at}


def open_items():
    return {"needsYou": [], "withCoordinator": [], "settled": [], "startRequest": None, "doneRequest": None,
            "closedQuestions": []}


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
        if parts == ["api", "tasks", "evidence-decisions", "pending"]:
            return self.send(200, pending())
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            return self.send(200, [session_row()] if view == "open" else [])
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            if parts[2] != SESSION:
                return self.send(404, {"error": "not in the probe"})
            rest = parts[3:]
            if rest == []:
                return self.send(200, session_row())
            if rest == ["events"]:
                return self.stream(int(query.get("sinceSeq", ["0"])[0] or 0))
            if rest == ["events", "page"]:
                return self.send(200, {"events": STATE["events"], "hasMore": False, "before": None, "after": None})
            if rest in (["approvals"], ["turns"]):
                return self.send(200, [])
            return self.send(404, {"error": "not in the probe"})
        if len(parts) >= 3 and parts[:2] == ["api", "projects"] and parts[2] == PROJECT:
            rest = parts[3:]
            if rest == ["open-items"]:
                return self.send(200, open_items())
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

    def stream(self, sent):
        """Replay what follows `sinceSeq` (SSE `data:` frames, the server's framing) and whatever the stage
        adds later, keeping the stream alive inside the clients' 45 s watchdog."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        last_ping = time.time()
        try:
            while True:
                for e in STATE["events"]:
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
        if parts == ["__set"]:
            if body.get("stage") == "sent":
                flip_to_sent()
            return self.send(200, {"ok": True, "stage": STATE["stage"]})
        if len(parts) == 5 and parts[:2] == ["api", "tasks"] and parts[3:] == ["evidence", "decision"]:
            status, out = decide(parts[2], body)
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
    print("stub listening on 127.0.0.1:%d (python %s), now %s in Shanghai"
          % (PORT, sys.version.split()[0], datetime.now(SHANGHAI).isoformat(timespec="seconds")), flush=True)
    server.serve_forever()
