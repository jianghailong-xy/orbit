#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API that the three surfaces smart
# model selection touches on a phone read and write (docs/model-routing-design.md §9):
#
#   T1  — a task on workspace a1 (smart selection ON) with a suggested tier M and the coordinator's
#         reason, every tier resolved (modelHintOptions), and three runs: run 2 RUNNING on Opus 5.5
#         high (applied, escalated: "✦ L ↑"), run 1 FAILED on Sonnet 5.5 medium (applied: "✦ M"),
#         and an older run 0 that only shadowed (applied false, level M, ran Opus 5.5 max: the
#         purple "would have picked" line).
#   S2  — run 2 of T1 as a session: taskId T1, claude, claude-opus-5-5, high, and its detail's
#         route (applied, level L, same model) — what marks the composer's model chip ✦.
#   a1  — the workspace, modelRouting true; r1 its online runner with a claude model catalogue.
#
# PATCH /tasks/T1 and PATCH /agents/a1 apply their body and answer the updated object, so a tier
# picked in the Suggested menu shows; both bodies are logged. POST /__reset puts everything back
# (each UI test calls it before launching). Every request is logged; anything not served is a 404.
# All data is made up.
import copy
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


OPUS = "claude-opus-5-5"
SONNET = "claude-sonnet-5-5"
LEVELS = ["low", "medium", "high", "max"]

AGENT0 = {
    "id": "a1", "name": "orbit", "provider": "claude", "lastProvider": "claude", "runnerId": "r1",
    "enabled": True, "modelRouting": True, "enableWorktree": True, "effort": "",
    "workDir": "/srv/orbit", "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True,
}
RUNNER = {
    "id": "r1", "name": "wikova", "displayName": "wikova", "online": True, "status": "ONLINE",
    "maxConcurrent": 4, "lastHeartbeatAt": ago(0),
    "modelCatalog": {"claude": [
        {"value": OPUS, "label": "Opus 5.5", "priority": 1, "contextWindow": 1000000,
         "reasoningLevels": LEVELS, "defaultReasoningLevel": "high"},
        {"value": SONNET, "label": "Sonnet 5.5", "priority": 2, "contextWindow": 1000000,
         "reasoningLevels": LEVELS, "defaultReasoningLevel": "medium"},
    ]},
    "runtimeDefaultModels": {"claude": OPUS},
}

TITLE = "把 run target 升到 v2 并冻结 effort"
REASON = "one service plus its spec; an acceptance command decides it"
OPTIONS = [
    {"level": "S", "provider": "claude", "model": SONNET, "label": "Sonnet 5.5", "effort": "low"},
    {"level": "M", "provider": "claude", "model": SONNET, "label": "Sonnet 5.5", "effort": "medium"},
    {"level": "L", "provider": "claude", "model": OPUS, "label": "Opus 5.5", "effort": "high"},
    {"level": "XL", "provider": "claude", "model": OPUS, "label": "Opus 5.5", "effort": "max"},
]
ROUTE_RUN2 = {
    "level": "L", "provider": "claude", "model": OPUS, "effort": "high", "applied": True, "escalated": True,
    "reasons": [
        "Tier L: one above run 1 (M), because run 1 failed its acceptance command",
        "Run 1 started at M: suggested by the coordinator — one service plus its spec",
        "Engine claude: this agent's own engine",
    ],
    "policyVersion": 1, "decidedAt": ago(18),
}
ROUTE_RUN1 = {
    "level": "M", "provider": "claude", "model": SONNET, "effort": "medium", "applied": True, "escalated": False,
    "reasons": [
        "Tier M: suggested by the coordinator — one service plus its spec",
        "Engine claude: this agent's own engine",
    ],
    "policyVersion": 1, "decidedAt": ago(55),
}
ROUTE_RUN0 = {
    "level": "M", "provider": "claude", "model": SONNET, "effort": "medium", "applied": False, "escalated": False,
    "reasons": [
        "Tier M: suggested by the coordinator — one service plus its spec",
        "Not applied: smart model selection was off for this agent, so the run kept its own model",
    ],
    "policyVersion": 1, "decidedAt": ago(26 * 60),
}


def run_ref(sid, title, state, status, minutes, model, effort, route):
    return {
        "id": sid, "title": title, "status": status, "runState": state, "endReason": None,
        "createdAt": ago(minutes), "agent": {"name": "orbit"},
        "model": model, "effort": effort, "route": route,
    }


def task0():
    return {
        "id": "T1", "title": TITLE, "status": "OPEN",
        "description": "run target 的 schema 升到 v2；effort 在派发时冻结，之后不再跟随 Agent 的设置变化。",
        "assigneeId": "a1", "listId": None, "dueDate": None, "projectId": None, "terminalReason": None,
        "completionCriterion": "EXECUTABLE", "completionPolicy": "MANUAL",
        "acceptanceCriteria": "spec 全绿；旧的 v1 run target 读得回来。",
        "acceptanceCommand": "pnpm --filter apiserver test:spec run-target", "acceptanceExpectedExitCode": 0,
        "provider": None, "model": None,
        "modelHint": "M", "modelHintReason": REASON, "modelHintOptions": copy.deepcopy(OPTIONS),
        "autoRunWhenReady": False, "creatorType": "USER", "creatorId": "u1", "creatorName": "Wikova",
        "createdAt": ago(26 * 60 + 30), "updatedAt": ago(18), "runAt": None, "labels": [],
        "attachments": [], "supersedes": [], "successorChain": [],
        "assignee": {"id": "a1", "name": "orbit", "model": None, "runnerId": "r1",
                     "runner": {"id": "r1", "name": "wikova", "displayName": "wikova", "maxConcurrent": 4}},
        "comments": [],
        "sessions": [
            run_ref("S2", "执行任务：" + TITLE, "RUNNING", "RUNNING", 18, OPUS, "high", ROUTE_RUN2),
            run_ref("S1", "执行任务：" + TITLE, "FAILED", "FAILED", 55, SONNET, "medium", ROUTE_RUN1),
            run_ref("S0", "执行任务：" + TITLE, "ENDED", "CANCELLED", 26 * 60, OPUS, "max", ROUTE_RUN0),
        ],
        "creatorSession": None, "dependsOn": [], "dependedOnBy": [],
        "running": True, "queued": False, "runningSince": ago(18), "blocked": False,
        "dependencyState": "READY", "runnable": False,
    }


STATE = {}


def reset():
    STATE["task"] = task0()
    STATE["agent"] = copy.deepcopy(AGENT0)


reset()


def task_row(task):
    row = {k: v for k, v in task.items() if k not in ("comments", "sessions", "creatorSession", "modelHintOptions")}
    row["_count"] = {"comments": 0}
    return row


def page(items):
    return {"items": items, "nextCursor": None, "total": len(items),
            "counts": {"total": len(items), "open": len(items), "inProgress": 0, "done": 0, "failed": 0,
                       "cancelled": 0, "running": len(items), "queued": 0, "runnable": 0}}


S2_SESSION = {
    "id": "S2", "title": "执行任务：" + TITLE, "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
    "runState": "AWAITING_INPUT", "lifecycleState": "OPEN", "agentId": "a1",
    "agent": {"id": "a1", "name": "orbit"}, "assignedRunnerId": "r1", "provider": "claude",
    "model": OPUS, "effort": "high", "permissionMode": "acceptEdits", "taskId": "T1", "projectId": None,
    "createdAt": ago(18), "updatedAt": ago(2), "lastTurnAt": ago(2),
    "lastAssistantText": "spec 已改到 v2 的形状，正在跑验收命令。", "pendingApprovals": 0, "tags": [],
    "folderId": None, "source": "TASK",
    # SessionDetail's half of the same payload: the decision this run was planned with.
    "route": ROUTE_RUN2,
}


def events(sid):
    if sid != "S2":
        return []
    return [
        {"seq": 1, "type": "user", "ts": ago(18), "turnId": "S2-t1",
         "payload": {"text": "执行任务：" + TITLE + "\n\n验收命令：pnpm --filter apiserver test:spec run-target"}},
        {"seq": 2, "type": "assistant", "ts": ago(2), "turnId": "S2-t1",
         "payload": {"text": "run 1 的失败在 effort 冻结：派发后 Agent 改了 effort，run 跟着变了。"
                             "已把 effort 在 claim 时写进 run，spec 已改到 v2 的形状，正在跑验收命令。"}},
    ]


def owner_confirmation(task):
    return {"taskId": task["id"], "title": task["title"], "status": task["status"], "projectId": None,
            "completionCriterion": task["completionCriterion"], "acceptanceCriteria": task["acceptanceCriteria"],
            "waiting": None, "decisions": [], "ifConfirmed": None, "reviewerReturns": []}


def attribution(task):
    # The server's own absence codes (TaskDetailCopy.absentReason words them).
    return {"taskId": task["id"], "owning": None, "owningAbsentReason": "FILED_UNDER_NO_PROJECT",
            "discovery": {"recorded": False, "absentReason": "NO_DISCOVERY_RECORDED", "authority": "EVIDENCE_ONLY"},
            "crossing": None, "crossingAbsentReason": "NO_CROSSING_DECLARED",
            "blocker": None, "blockerAbsentReason": "NOTHING_BLOCKING_ATTRIBUTION"}


def apply_patch(target, body):
    for key, value in body.items():
        target[key] = value
    return target


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
        task = STATE["task"]
        if parts == ["api", "agents"]:
            return self.send(200, [STATE["agent"]])
        if parts == ["api", "agents", "a1"]:
            return self.send(200, STATE["agent"])
        if parts == ["api", "runners"]:
            return self.send(200, [RUNNER])
        if parts == ["api", "runners", "r1"]:
            return self.send(200, RUNNER)
        if parts in (["api", "providers"], ["api", "providers", "pools"], ["api", "providers", "shared-pools"],
                     ["api", "session-tags"], ["api", "session-folders"], ["api", "task-lists"],
                     ["api", "watches"], ["api", "share-links"]):
            return self.send(200, [])
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            return self.send(200, [S2_SESSION] if view == "open" else [])
        # The task list's reads: T1 in the every-task scope; nothing for a session's own tasks.
        if parts == ["api", "tasks", "page"]:
            if "creatorSessionId" in query:
                return self.send(200, page([]))
            return self.send(200, page([task_row(task)]))
        if parts == ["api", "tasks", "counts"]:
            return self.send(200, page([task_row(task)])["counts"])
        if parts == ["api", "tasks", "active"]:
            return self.send(200, {"items": [task_row(task)], "total": 1, "truncated": False})
        if parts == ["api", "tasks", "labels"]:
            return self.send(200, {"items": [], "labelTotal": 0, "truncated": False})
        if parts == ["api", "tasks"]:
            return self.send(200, [task_row(task)])
        if len(parts) >= 3 and parts[:2] == ["api", "tasks"] and parts[2] == "T1":
            rest = parts[3:]
            if rest == []:
                return self.send(200, task)
            if rest == ["row"]:
                return self.send(200, task_row(task))
            if rest == ["owner-confirmation"]:
                return self.send(200, owner_confirmation(task))
            if rest == ["attribution"]:
                return self.send(200, attribution(task))
            if rest == ["share"]:
                return self.send(200, {"link": None, "counts": None})
            return self.send(404, {"error": "not in the probe"})
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            sid, rest = parts[2], parts[3:]
            if rest == ["events", "page"]:
                return self.send(200, {"events": events(sid), "hasMore": False, "before": None, "after": None})
            if rest == ["turns"]:
                return self.send(200, [])
            if rest == ["share"]:
                return self.send(200, {"link": None, "counts": {"messages": 2, "toolCalls": 0}})
            if rest == [] and sid == "S2":
                return self.send(200, S2_SESSION)
            return self.send(404, {"error": "not in the probe"})
        return self.send(404, {"error": "not in the probe"})

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        self.body()
        if parts == ["__reset"]:
            reset()
            return self.send(200, {"ok": True})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    def do_PATCH(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self.body()
        if parts == ["api", "tasks", "T1"]:
            task = apply_patch(STATE["task"], body)
            task["updatedAt"] = ago(0)
            return self.send(200, task)
        if parts == ["api", "agents", "a1"]:
            return self.send(200, apply_patch(STATE["agent"], body))
        return self.send(404, {"error": "not in the probe"})

    def do_PUT(self):
        self.body()
        return self.send(404, {"error": "not in the probe"})

    def do_DELETE(self):
        return self.send(404, {"error": "not in the probe"})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
