#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API a phone needs to draw the
# owner-confirmation card's REVIEW bar in each of its states (docs/owner-confirmation-review-contract.md,
# docs/mocks/owner-confirmation-review-ios.html phones ③ ④ and the second row):
#
#   s3  — phone ③: the report is still with its reviewer (UNDER_REVIEW). The row says "Under review",
#         is not counted (pendingApprovals 0), and the card is drawn and pressable.
#   s4  — phone ④: reviewed, option B's first line "1 not checked · nothing needs you".
#   s5  — option B with questions for the owner: "Needs you: …" and the answer blocks.
#   s6  — REVIEW TIMED OUT: not reviewed, no answer within 30 min.
#   s7  — THE BRANCH MOVED AFTER THE REVIEW: outdated, the old review folded away.
#   s8  — YOU CONFIRMED FIRST, THE REVIEW CAME LATER: the receipt, the problem, Reopen task.
#   s9  — the reviewer sent the report back: the card's record, and "Sent back by the reviewer".
#   s10 — the reviewer's own conversation: the "Review requested" card.
#
# Nothing is pressed: POST to the door is logged and refused, so a stray tap changes nothing. Every
# request is logged. Fixture titles and the review's words are illustrative (the mock's demo data).
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
REVIEWER = "会话间消息参数与回复设计"
SHA = "59d98153ef85c565646fede291f66f61940573c7"
MOVED = "7c1e2a0b9f3d4e5a6b7c8d9e0f1a2b3c4d5e6f70"

REPORT = (
    "All six P1 review findings are fixed and pushed to orbit/p1-1c207b at commit "
    "59d98153ef85c565646fede291f66f61940573c7. This branch also carries P0, P1 and the attribution "
    "follow-up merged onto current main. One rename: P1’s expectReply flag is now replyBy, because "
    "the deadline is what it carries. PG 2298/2298, web 1,204 files green; JS tests did not run on CI."
)
CRITERIA = (
    "1. 回复请求可以带期限，超时后发送方被唤醒并看到结局。\n"
    "2. 接收方结束会话时，未回复的请求立即以「对方已结束」收场。\n"
    "3. 署名区分自动重试、手动 Retry 与原始请求。\n"
    "4. web / iOS / macOS 的列表与会话页显示同一个请求状态。\n"
    "5. PG 规格全绿。\n"
    "6. CI 的 client 工作流通过。"
)
IF_CONFIRMED = {
    "startsTasks": [{"id": "34YnHq0SgWQ9oc4bDnqv2",
                     "title": "会话间消息署名：自动重试遇到请求、手动 Retry、计数口径三处待定", "starts": "NOW"}],
    "startsAfterLanding": False,
    "branch": {"name": "orbit/p1-1c207b", "linesAdded": 9432, "linesRemoved": 11, "files": 41, "onMain": "NO"},
    "landing": "NONE",
    "endsSession": None,
}


def reviewer():
    return {"kind": "TASK_CREATOR", "sessionId": "s10", "title": REVIEWER}


def record(needs_you=False):
    if needs_you:
        return {
            "recordId": "rec5", "recordedAt": ago(1), "reviewedSha": SHA,
            "judgment": "Everything asked for is there. The cap is a trade-off, so it’s yours.",
            "checked": [{"key": "c1", "text": "Criteria 1–6 · PG 2298/2298"}],
            "notChecked": [{"key": "x1", "text": "JS tests never ran on CI",
                            "whyNotProven": "The CI run predates the web change."}],
            "needsYou": [
                {"key": "n1", "text": "the 50/hour cap can overshoot — ship as is?",
                 "evidenceRefs": ["session-message.ts#chargeSessionMessage"],
                 "options": [{"label": "Ship as is", "description": "Overshoot is bounded by one burst."},
                             {"label": "Hold the cap exactly", "description": "Costs a row lock per message."}],
                 "recommendedOption": 0},
                {"key": "n2", "text": "Rename P1’s field now or later?",
                 "options": [{"label": "Now"}, {"label": "Later"}], "recommendedOption": 1},
            ],
            "leftOpen": [{"key": "o1", "text": "3 more optional review items"}],
        }
    return {
        "recordId": "rec4", "recordedAt": ago(1), "reviewedSha": SHA,
        "judgment": "OK to confirm. Merge after JS runs on CI.",
        "checked": [{"key": "c1", "text": "Criteria 1–6", "evidenceRefs": ["git show 59d9815 --stat"]},
                    {"key": "c2", "text": "PG 2298/2298",
                     "evidenceRefs": ["https://github.com/jianghailong-xy/orbit/actions/runs/36973057413"]}],
        "notChecked": [{"key": "x1", "text": "JS tests never ran on CI",
                        "whyNotProven": "The CI run predates the web change.",
                        "coordinatorChecked": "Ran the card's own test file locally."}],
        "needsYou": [],
        "leftOpen": [{"key": "o1", "text": "4 optional review items"}],
    }


def review(state, **more):
    base = {
        "reviewId": "rv-" + state.lower(), "state": state, "notReviewedReason": None, "outdated": None,
        "reviewer": reviewer(), "since": ago(3), "dueAt": ago(-27), "windowSeconds": 1800,
        "headline": None, "review": None, "returned": None, "problems": None,
    }
    base.update(more)
    return base


def reviews():
    return {
        "s3": review("UNDER_REVIEW"),
        "s4": review("REVIEWED", headline={"kind": "NOTHING_NEEDS_YOU", "notChecked": 1}, review=record()),
        "s5": review("REVIEWED", headline={"kind": "NEEDS_YOU", "text": "the 50/hour cap can overshoot — ship as is?",
                                           "more": 1}, review=record(needs_you=True)),
        "s6": review("NOT_REVIEWED", notReviewedReason="TIMED_OUT", since=ago(45), dueAt=ago(15)),
        "s7": review("OUTDATED", outdated={"cause": "BRANCH_MOVED", "branchSha": MOVED},
                     headline={"kind": "NOTHING_NEEDS_YOU", "notChecked": 1}, review=record()),
    }


TITLES = {
    "s3": "执行任务：会话间请求与回复：修复 P1 审查发现的问题",
    "s4": "执行任务：会话间请求与回复：P1 审查发现的问题已修复",
    "s5": "执行任务：会话间消息上限：50 条每小时",
    "s6": "执行任务：导出发票汇总表",
    "s7": "执行任务：登录跳转保留 next 参数",
    "s8": "执行任务：会话回复卡片的重发按钮",
    "s9": "执行任务：审查方退回的 P1-3 修复",
    "s10": REVIEWER,
}
TASK = {sid: "t" + sid[1:] for sid in TITLES if sid != "s10"}
REQUEST = {sid: "01920000-0000-7000-8000-0000000000" + ("%02d" % int(sid[1:])) for sid in TITLES}
# Newest first in the list: the two rows of the mock's session list lead it.
TURN_AGE = {"s4": 0, "s3": 2, "s5": 4, "s6": 5, "s7": 6, "s8": 7, "s9": 8, "s10": 9}


def session(sid):
    under = sid == "s3"
    counted = sid in ("s4", "s5", "s6", "s7")
    return {
        "id": sid, "title": TITLES[sid], "status": "AWAITING_INPUT", "runState": "AWAITING_INPUT",
        "lastAssistantText": "Reviewing the branch now." if sid == "s10" else REPORT,
        "lastTurnAt": ago(TURN_AGE[sid]), "updatedAt": ago(TURN_AGE[sid]), "createdAt": ago(90),
        "lifecycleState": "OPEN", "agentId": "a1", "agent": {"id": "a1", "name": "orbit"},
        "folderId": None, "pendingApprovals": 1 if counted else 0,
        "waitingKind": "OWNER_CONFIRMATION" if counted else None,
        "confirmationUnderReview": {
            "requestId": REQUEST["s3"], "taskId": TASK["s3"], "reviewerSessionId": "s10",
            "reviewerTitle": REVIEWER, "since": ago(3), "dueAt": ago(-27),
        } if under else None,
        "taskId": TASK.get(sid), "projectId": None, "tags": [],
    }


def return_block(problems):
    lines = "\n".join("- " + p["text"] for p in problems)
    return ('<orbit-confirmation-return task="t9" request-id="%s" reviewer-session="s10" reviewer-title="%s">\n'
            "Your report for this task was sent back by its reviewer, not by the account owner. The owner was not asked.\n"
            "Reason: Two of the six findings are not fixed on the branch.\nProblems:\n%s\n"
            "When this is fixed, declare the work finished again with task_request_confirmation.\n"
            "</orbit-confirmation-return>" % (REQUEST["s9"], REVIEWER, lines))


RETURN_PROBLEMS = [
    {"key": "p1", "text": "P1-3 still sends the reply twice", "evidenceRefs": ["SessionReplyCard.test.tsx:88"]},
    {"key": "p2", "text": "P1-5 has no test"},
]


def events(sid):
    if sid == "s10":
        block = ('<orbit-confirmation-review task="t3" request-id="%s" run-session="s3" branch="orbit/p1-1c207b" '
                 'sha="%s" due-at="%s">\nA run of the task declared its work finished and is waiting for the '
                 "account owner to confirm it (OWNER_CONFIRMED). You are its reviewer.\n</orbit-confirmation-review>"
                 % (REQUEST["s3"], SHA, ago(-27)))
        return [
            {"seq": 1, "type": "user", "ts": ago(60), "turnId": "s10-t1",
             "payload": {"text": "把会话间消息的参数和回复的设计定下来，并把 P1 的修复派出去。"}},
            {"seq": 2, "type": "assistant", "ts": ago(58), "turnId": "s10-t1",
             "payload": {"text": "Filed the P1 fix as a task; I will review its report when it declares done."}},
            {"seq": 3, "type": "user", "ts": ago(3), "turnId": "s10-t2",
             "payload": {"text": block, "controlPlaneNote": block,
                         "confirmationReviewRequest": {
                             "requestId": REQUEST["s3"], "reviewId": "rv-under_review", "taskId": "t3",
                             "title": TITLES["s3"].replace("执行任务：", ""), "runSessionId": "s3",
                             "branch": "orbit/p1-1c207b", "sha": SHA, "dueAt": ago(-27)}}},
            {"seq": 4, "type": "assistant", "ts": ago(2), "turnId": "s10-t2",
             "payload": {"text": "Reviewing the branch now."}},
        ]
    report_at = 14 if sid == "s8" else (11 if sid == "s9" else 3)
    out = [
        {"seq": 1, "type": "user", "ts": ago(40), "turnId": sid + "-t1",
         "payload": {"text": "执行任务：" + TITLES[sid].replace("执行任务：", "")}},
        {"seq": 2, "type": "assistant", "ts": ago(report_at), "turnId": sid + "-t1", "payload": {"text": REPORT}},
    ]
    if sid == "s9":
        block = return_block(RETURN_PROBLEMS)
        out += [
            {"seq": 3, "type": "user", "ts": ago(4), "turnId": "s9-t2",
             "payload": {"text": block, "controlPlaneNote": block,
                         "confirmationReturn": {
                             "requestId": REQUEST["s9"], "recordId": "ret9", "reviewerSessionId": "s10",
                             "reviewerTitle": REVIEWER,
                             "reason": "Two of the six findings are not fixed on the branch.",
                             "problems": RETURN_PROBLEMS}}},
            {"seq": 4, "type": "assistant", "ts": ago(3), "turnId": "s9-t2",
             "payload": {"text": "Fixing P1-3 and adding the P1-5 test now."}},
        ]
    return out


def owner_confirmation(task_id):
    sid = next(s for s, t in TASK.items() if t == task_id)
    view = {
        "taskId": task_id, "title": TITLES[sid].replace("执行任务：", ""), "status": "OPEN", "projectId": None,
        "completionCriterion": "OWNER_CONFIRMED", "acceptanceCriteria": CRITERIA,
        "waiting": None, "decisions": [], "ifConfirmed": None, "reviewerReturns": [],
    }
    report = {"text": REPORT, "reportedAt": ago(3)}
    if sid in reviews():
        view["waiting"] = {"requestId": REQUEST[sid], "sessionId": sid, "requestedAt": ago(3),
                           "report": report, "review": reviews()[sid]}
        view["ifConfirmed"] = IF_CONFIRMED
    elif sid == "s8":
        view["status"] = "DONE"
        view["decisions"] = [{
            "id": "d8", "decision": "CONFIRM", "note": None, "decidedAt": ago(12), "decidedByType": "USER",
            "requestId": REQUEST["s8"], "sessionId": "s8", "report": {"text": REPORT, "reportedAt": ago(14)},
            "review": review("UNDER_REVIEW", since=ago(13), dueAt=ago(-17),
                             headline={"kind": "PROBLEMS_AFTER_CONFIRM", "problems": 1},
                             problems={"recordId": "pr8", "recordedAt": ago(1), "reviewedSha": SHA,
                                       "reason": "The web tests fail on CI.",
                                       "problems": [{"key": "p1",
                                                     "text": "JS tests fail on CI: SessionReplyCard.test.tsx"}]}),
            "reviewStateAtDecision": "UNDER_REVIEW", "reviewRecordId": None, "answers": [],
        }]
    elif sid == "s9":
        view["reviewerReturns"] = [{
            "requestId": REQUEST["s9"], "sessionId": "s9", "requestedAt": ago(10),
            "review": review("RETURNED", since=ago(10), dueAt=ago(-20),
                             returned={"recordId": "ret9", "recordedAt": ago(4), "reviewedSha": SHA,
                                       "reason": "Two of the six findings are not fixed on the branch.",
                                       "problems": RETURN_PROBLEMS}),
        }]
    return view


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
            return self.send(200, [session(sid) for sid in TITLES] if view == "open" else [])
        if parts in (["api", "session-tags"], ["api", "session-folders"]):
            return self.send(200, [])
        if parts == ["api", "runners"]:
            return self.send(200, [RUNNER])
        if parts in (["api", "providers"], ["api", "providers", "pools"], ["api", "providers", "shared-pools"]):
            return self.send(200, [])
        if len(parts) == 4 and parts[:2] == ["api", "tasks"] and parts[3] == "owner-confirmation":
            if parts[2] in TASK.values():
                return self.send(200, owner_confirmation(parts[2]))
            return self.send(404, {"statusCode": 404, "message": "task not found"})
        if len(parts) == 5 and parts[:2] == ["api", "sessions"] and parts[3:] == ["events", "page"]:
            return self.send(200, {"events": events(parts[2]) if parts[2] in TITLES else [],
                                   "hasMore": False, "before": None, "after": None})
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "turns":
            return self.send(200, [])
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "share":
            return self.send(200, {"link": None, "counts": {"messages": 2, "toolCalls": 0}})
        if len(parts) == 3 and parts[:2] == ["api", "sessions"]:
            if parts[2] not in TITLES:
                return self.send(404, {"statusCode": 404, "message": "session not found"})
            return self.send(200, session(parts[2]))
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
