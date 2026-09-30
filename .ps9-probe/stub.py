#!/usr/bin/env python3
"""TEMPORARY evidence probe (shots branch only; see README.md).

The control plane the real iOS app signs in to for task ⑨ (project 34WzvgkHWbY1VwXmSPUZi, criterion
9): a stub on 127.0.0.1:8787 (the simulator shares the host's loopback) answering the reads the
project list and the project page make, over five projects that between them draw every state the
change adds:

  READY   nobody started it, and its coordinator asked 2 minutes ago  → "Needs you · Ready to start"
  OWN     nobody started it, and nobody asked                          → Open items' own "Start…"
  RUN     started, integrating on its branch since 2h ago              → How it runs, line locked
  PAUSED  started, nothing landed yet, paused 20 minutes ago           → line open, Resume project
  WIKI    started, a coordinator question 35 minutes old               → the list's other Needs you

Every write How it runs makes is recorded, body and all, in <STUB_OUT>/writes.jsonl — and applied, so
the page the app reads back is the one the write left: that file is the evidence of what the app
sends (`automatic`, never `coordinatorEnabled`; the integration door; pause/resume).

Nothing here re-implements the app: it runs unmodified, and this is only the server's side.

usage: stub.py                 serve (env STUB_OUT, STUB_PORT)
       stub.py --dump DIR      write every read, one file per fixture, for fixcheck to decode
"""
import copy
import json
import os
import socketserver
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("STUB_PORT", "8787"))
OUT = os.environ.get("STUB_OUT", os.getcwd())
T0 = datetime.now(timezone.utc)
LOCK = threading.Lock()


def iso(minutes_ago=0.0):
    """An instant `minutes_ago` before the stub started, the way the server spells one."""
    t = T0 - timedelta(minutes=minutes_ago)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def uid(n):
    return f"0195c0de-0000-7000-8000-{n:012d}"


WIKOVA, AGENT_ID, RUNNER_ID = uid(1), uid(100), uid(200)

READY = "34WvwUS8YMXfOfWbMqVuu"
OWN = "34X1TeamOwnerQm2ZkLp3a"
RUN = "34W9xKq2LmN8pQr4StUv6"
PAUSED = "34X4SheetPausedDemo7kQ"
WIKI = "34VR0RwUSIcaoO7ZZqv52"

B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def b62(u):
    """A uuid's public spelling (`PublicID.toPublic`): the 16 bytes as one base62 number."""
    n, out = int(u.replace("-", ""), 16), ""
    while n:
        n, r = divmod(n, 62)
        out = B62[r] + out
    return out or "0"


# The coordinator conversations, spelled the way the server sends ids and the app asks for them.
COORD_UUID = {READY: uid(701), OWN: uid(702), RUN: uid(703), PAUSED: uid(704), WIKI: uid(705)}
COORD = {pid: b62(u) for pid, u in COORD_UUID.items()}

AGENT = {"id": AGENT_ID, "name": "orbit", "lastProvider": "claude", "permissionMode": "default",
         "effort": "", "workDir": "~/orbit", "runnerId": RUNNER_ID, "enabled": True,
         "description": "the office"}

RUNNER = {
    "id": RUNNER_ID, "name": "wikova", "online": True, "version": "0.1.200",
    "runsAsRoot": False, "activeSessions": 2,
    "runtimeDefaultModels": {"claude": "claude-opus-5"},
    "engines": [{"engine": "claude", "installed": True, "auth": "yes", "version": "2.1.285"}],
    "modelCatalog": {"claude": [{"value": "claude-opus-5", "label": "Opus 5"}]},
}


# ── the projects ────────────────────────────────────────────────────────────────────────────

def buckets(running=0, ready=0, blocked=0, done=0, **lanes):
    b = {"running": running, "ready": ready, "blocked": blocked, "awaitingVerification": 0,
         "done": done, "failed": 0, "cancelled": 0}
    b.update(lanes)
    return b


def task(n, title, status="OPEN", dep="READY", work="READY", level=0, blocks=0, unmet=0):
    return {"id": uid(1000 + n), "title": title, "status": status, "parentTaskId": None,
            "createdAt": iso(180 - n), "updatedAt": iso(60 - n), "childCount": 0,
            "unmetCount": unmet, "blocksCount": blocks, "topoLevel": level,
            "dependencyState": dep, "workState": work,
            "integration": {"state": "NOT_APPLICABLE", "since": None, "handler": None,
                            "openItemId": None, "jobId": None, "checksRunningForMs": None},
            "landingWaitCount": 0}


def mark(t):
    return {"kind": "TASK", "id": t["id"], "taskId": t["id"], "title": t["title"],
            "status": t["status"], "parentTaskId": None, "workState": t["workState"],
            "verificationState": None, "running": t["workState"] == "RUNNING", "queued": False}


_criteria = iter(range(3000, 4000))


def criterion(n, text, method):
    return {"id": uid(next(_criteria)), "ordinal": n, "text": text, "revision": 1, "satisfied": False,
            "unmet": [], "landing": "UNKNOWN", "verificationMethod": method}


READY_TASKS = [
    task(1, "A · 页面结构与数据读模型（apiserver）", blocks=2),
    task(2, "B · web 页面：两栏布局与登录提醒", dep="BLOCKED", work="BLOCKED", level=1, blocks=1, unmet=1),
    task(3, "C · iOS 页面：同结构、同文案", dep="BLOCKED", work="BLOCKED", level=1, blocks=1, unmet=1),
    task(4, "D · macOS 真窗口与设置 sheet", dep="BLOCKED", work="BLOCKED", level=2, blocks=1, unmet=1),
    task(5, "E · 截图对照效果图并排走查", dep="BLOCKED", work="BLOCKED", level=3, unmet=2),
]
READY_EDGES = [(0, 1), (0, 2), (1, 3), (2, 4), (3, 4)]

OWN_TASKS = [
    task(11, "A · 个人 Team id = user.id 的迁移"),
    task(12, "B · Team 成员页（web + iOS）"),
]

RUN_TASKS = [
    task(21, "证据先投协调者：投递与回执", status="IN_PROGRESS", dep="READY", work="RUNNING"),
    task(22, "协调者判完成的 MCP 工具与说明", status="IN_PROGRESS", dep="READY", work="RUNNING"),
    task(23, "web 决策条：协调者已判 / 等 owner", status="IN_PROGRESS", dep="READY", work="RUNNING"),
    task(24, "iOS 决策条同结构", dep="BLOCKED", work="BLOCKED", level=1, unmet=1),
    task(25, "上线与走查", dep="BLOCKED", work="BLOCKED", level=2, unmet=1),
]

PAUSED_TASKS = [
    task(31, "设置 sheet：iPhone 与 iPad 的入口", status="DONE", dep="READY", work="DONE"),
    task(32, "设置 sheet：Providers 分组与文案对齐 web"),
    task(33, "macOS 保留整页表单的回归测试", dep="BLOCKED", work="BLOCKED", level=1, unmet=1),
]

READY_CRITERIA = [
    criterion(1, "iOS 与 web 的 Runner 页结构一一对应：引擎、账号、会话、更新四块同顺序。",
              "client.yml 在含改动的提交上 macOS 与 iOS 两个 job 为 success。"),
    criterion(2, "signed out 只在有工作区依赖本机登录时才提醒。",
              "RunnerPageCopyParityTests 与 web 的 RunnerPage.test.tsx 都通过。"),
    criterion(3, "macOS 用真窗口截图对照效果图。", "截图与效果图并排贴在任务评论里。"),
    criterion(4, "上线：web 部署、iOS/macOS 发一个 beta。", "线上 bundle 能搜到新文案；TestFlight 与 DMG job success。"),
]

OWN_CRITERIA = [
    criterion(1, "个人 Team 的 id 等于 user.id，已有数据迁移后不丢。", "迁移 pg spec 跑绿。"),
    criterion(2, "Team 成员页 web 与 iOS 同结构、同文案。", "TeamMembersCopyParityTests 通过。"),
]


def project(pid, title, status, started, paused, automatic, max_tasks, revision, tasks, criteria,
            line, ref, locked, line_since, check, escalation, goal):
    return {
        "id": pid, "title": title, "status": status, "goal": goal, "instructions": None,
        "createdAt": iso(600), "updatedAt": iso(2),
        "coordinatorEnabled": automatic, "configRevision": str(revision),
        "coordinatorSessionId": COORD[pid], "maxConcurrentTasks": max_tasks,
        "startedAt": started, "pausedAt": paused, "pausedReason": "OWNER" if paused else None,
        "_count": {"tasks": len(tasks)},
        "tasksByStatus": {s: sum(1 for t in tasks if t["status"] == s)
                          for s in {t["status"] for t in tasks}},
        "acceptanceCriteriaItems": criteria,
        "integration": None if line is None else {
            "line": line, "lineAbsentReason": None, "ref": ref, "upstreamRef": "main",
            "source": "EXPLICIT", "locked": locked, "startedAt": line_since,
            "mergeCheckCommand": check,
            "mergeCheckCommandAbsentReason": None if check else "NOT_CONFIGURED",
            "mergeCheckTimeoutSeconds": None, "escalationSeconds": escalation},
        "blockers": {"open": [], "recentlyResolved": []},
    }


def integration_view(doc, ahead=None, synced=None, tip="UNKNOWN"):
    s = doc["integration"] or {}
    return {"line": s.get("line"), "ref": s.get("ref"), "upstreamRef": s.get("upstreamRef"),
            "locked": s.get("locked", False), "startedAt": s.get("startedAt"),
            "mergeCheckCommand": s.get("mergeCheckCommand"),
            "escalationSeconds": s.get("escalationSeconds", 7200),
            "commitsAheadOfUpstream": ahead, "lastUpstreamSyncAt": synced,
            "integratingCount": 0, "queuedCount": 0, "mergeCheckOnTip": tip, "inFlight": None}


def coordinator(pid, title, active_minutes, working):
    return {
        "projectId": pid, "readAt": iso(0), "state": "LIVE",
        "coordination": {
            "sessionId": COORD[pid], "sessionIdAbsentReason": None,
            "session": {"id": COORD[pid], "title": title, "runStatus": "RUNNING" if working else "AWAITING_INPUT",
                        "runState": "RUNNING" if working else "AWAITING_INPUT",
                        "lifecycleState": "OPEN", "filingState": "OPEN", "endReason": None,
                        "startedAt": iso(600), "finishedAt": None, "completedAt": None,
                        "deletedAt": None, "engineTurnActive": working, "pendingApprovals": 0,
                        "lastTurnAt": iso(active_minutes), "lastTurnAtAbsentReason": None},
            "sessionAbsentReason": None, "coordinatorGeneration": "0", "workspaceId": AGENT_ID,
            "workspaceIdAbsentReason": None, "workspaceName": "orbit", "agentId": AGENT_ID,
            "agentName": "orbit", "wakeups": {"state": "DELIVERED", "at": iso(active_minutes)},
            "fuse": {"selfStartedToday": 2, "limit": 30, "paused": False, "episodeId": None}},
        "openability": {"canOpen": True, "willCreate": False, "refusalCode": None,
                        "refusalDetail": None, "refusalCodeAbsentReason": "NOTHING_REFUSES",
                        "requiredAction": None, "landing": {"workspaceId": None, "workspaceName": None}},
    }


def start_request_row(pid):
    return {
        "itemId": uid(5000), "kind": "START_REQUEST", "title": "Start this project?", "detailLine": "",
        "assignee": "OWNER", "assigneeReason": "DEFAULT", "waitingSince": iso(2),
        "escalateAt": None, "escalatedAt": None, "taskId": None, "sessionId": COORD[pid],
        "promotionId": None, "fuseEpisodeId": None,
        "delivery": {"state": "NOT_REQUIRED", "sessionId": None, "at": None},
        "actions": [], "question": None, "facts": None,
        "startRequest": {
            "settings": {"line": "PROJECT_BRANCH", "projectBranchName": f"refs/heads/project/{pid}",
                         "automatic": True, "maxConcurrentTasks": 3, "mergeCheckCommand": None},
            "why": "B and C build on A, and E needs both — they should land together on a branch first.",
            "criteriaDigest": "c2b4e16c4b5981aa07d3", "planDigest": "5f0e2d1c",
            "repository": "git@github.com:jianghailong-xy/orbit.git",
            "warnings": [{"severity": "WARN", "code": "START_NO_MERGE_CHECK",
                          "message": "Automatic is on and the project lands on a branch, with no merge check.",
                          "requiredAction": "Set a merge check.", "criterion": None, "tasks": []}]},
    }


def graph(tasks, edges=()):
    return {"marks": [mark(t) for t in tasks],
            "edges": [{"sourceMarkId": tasks[a]["id"], "targetMarkId": tasks[b]["id"]} for a, b in edges],
            "taskCount": len(tasks), "folded": False, "truncated": False,
            "limits": {"maxTasks": 500, "maxMarks": 300}}


def panorama(b, count, edges, depth, form):
    return {"buckets": b, "shape": {"taskCount": count, "edgeCount": edges,
                                    "ratio": round(edges / max(count, 1), 2), "maxDepth": depth, "form": form}}


def ready_queue(tasks):
    ready = [t for t in tasks if t["workState"] == "READY" and t["status"] == "OPEN"]
    return {"readyCount": len(ready), "queuedCount": 0, "runningCount": 0, "pausedCount": 0,
            "impactTruncated": None,
            "items": [{"taskId": t["id"], "title": t["title"], "status": "OPEN", "runState": "READY",
                       "sessionId": None, "pausedList": None, "downstreamBlocked": t["blocksCount"]}
                      for t in ready]}


def summary(doc, b, last_active, attention, integration=None):
    return {"id": doc["id"], "title": doc["title"], "status": doc["status"], "goal": doc["goal"],
            "createdAt": doc["createdAt"], "updatedAt": doc["updatedAt"],
            "coordinatorAgentId": AGENT_ID, "coordinatorGeneration": "0",
            "_count": doc["_count"], "buckets": b, "lastActivityAt": iso(last_active),
            "attention": dict({"userBlockers": 0, "coordinatorBlockers": 0, "systemBlockers": 0,
                               "maxSeverity": None, "attentionSinceAt": None, "nextCheckAt": None,
                               "ownerItems": [], "coordinatorItems": None}, **attention),
            "integration": integration}


def build():
    """Every project's reads, as the server answers them now."""
    s = {}
    run_ref = f"project/{RUN}"
    paused_ref = f"project/{PAUSED}"
    s["docs"] = {
        READY: project(READY, "Runner 页整页改版（iOS/macOS + web）", "OPEN", None, None, True, 3, 1,
                       READY_TASKS, READY_CRITERIA, None, None, False, None, None, 7200,
                       "Runner 页 iOS 与 web 同结构；signed out 只在有工作区依赖本机登录时才提醒。"),
        OWN: project(OWN, "Team 功能：个人 Team 当 owner", "OPEN", None, None, True, 2, 1,
                     OWN_TASKS, OWN_CRITERIA, None, None, False, None, None, 7200,
                     "Team 当 owner、个人 Team id = user.id。"),
        RUN: project(RUN, "Automatic 项目里由协调者判任务完成", "OPEN", iso(26 * 60), None, True, 3, 4,
                     RUN_TASKS, OWN_CRITERIA[:1], "PROJECT_BRANCH", run_ref, True, iso(120),
                     "cd src/web && npx tsc -b && npx vitest run", 7200,
                     "证据先投协调者，协调者判完成。"),
        PAUSED: project(PAUSED, "iOS 设置 sheet 改版", "OPEN", iso(70), iso(20), True, 2, 2,
                        PAUSED_TASKS, OWN_CRITERIA[1:], "PROJECT_BRANCH", paused_ref, False, None,
                        None, 3600, "iOS/iPad 设置改用 sheet，macOS 保留整页表单。"),
        WIKI: project(WIKI, "Orbit Wiki · 阶段 2：从 Orbit 记录里长出 wiki", "OPEN", iso(3000), None, True, 3, 9,
                      READY_TASKS[:3], OWN_CRITERIA[:1], "PROJECT_BRANCH", f"project/{WIKI}", True,
                      iso(2000), "npm test", 7200, "wiki 阶段 2。"),
    }
    s["tasks"] = {READY: READY_TASKS, OWN: OWN_TASKS, RUN: RUN_TASKS, PAUSED: PAUSED_TASKS,
                  WIKI: READY_TASKS[:3]}
    s["graph"] = {READY: graph(READY_TASKS, READY_EDGES), OWN: graph(OWN_TASKS),
                  RUN: graph(RUN_TASKS, [(0, 3), (3, 4)]), PAUSED: graph(PAUSED_TASKS, [(0, 2)]),
                  WIKI: graph(READY_TASKS[:3])}
    s["panorama"] = {
        READY: panorama(buckets(ready=1, blocked=4), 5, 5, 3, "mesh"),
        OWN: panorama(buckets(ready=2), 2, 0, 0, "flat"),
        RUN: panorama(buckets(running=3, blocked=2, integrating=0, onIntegrationLine=2, onUpstream=3,
                              doneNotIntegrated=0, waitingForLanding=0, done=5), 10, 7, 2, "mesh"),
        PAUSED: panorama(buckets(ready=1, blocked=1, done=1), 3, 1, 1, "chain"),
        WIKI: panorama(buckets(running=1, ready=1, blocked=1), 3, 2, 1, "chain"),
    }
    s["coordinator"] = {
        READY: coordinator(READY, "Runner 页整页改版", 1, False),
        OWN: coordinator(OWN, "Team 功能", 50, False),
        RUN: coordinator(RUN, "Automatic 项目里由协调者判任务完成", 4, True),
        PAUSED: coordinator(PAUSED, "iOS 设置 sheet 改版", 21, False),
        WIKI: coordinator(WIKI, "Orbit Wiki · 阶段 2", 35, False),
    }
    s["open"] = {pid: {"needsYou": [], "withCoordinator": [], "startRequest": None} for pid in s["docs"]}
    s["open"][READY]["startRequest"] = start_request_row(READY)
    s["integration_extra"] = {RUN: {"ahead": 4, "synced": iso(40), "tip": "PASSING"}}
    s["confirmation"] = {
        pid: {"state": "UNCONFIRMED", "confirmed": False,
              "currentVersion": {"digest": "7d1e03a9c2f4b8a01e55" if pid == OWN else "c2b4e16c4b5981aa07d3",
                                 "material": [{"definitionId": c["id"], "revision": 1, "contentHash": f"h{c['ordinal']}"}
                                              for c in s["docs"][pid]["acceptanceCriteriaItems"]]},
              "confirmation": None}
        for pid in s["docs"]}
    return s


STATE = build()


def integration_of(pid):
    extra = STATE["integration_extra"].get(pid, {})
    return integration_view(STATE["docs"][pid], extra.get("ahead"), extra.get("synced"), extra.get("tip", "UNKNOWN"))


def summaries():
    d = STATE["docs"]
    line = lambda pid: ({"line": d[pid]["integration"]["line"], "ref": d[pid]["integration"]["ref"]}
                        if d[pid]["integration"] else None)
    return [
        summary(d[READY], STATE["panorama"][READY]["buckets"], 2, {"startRequest": {"waitingSince": iso(2)}}),
        summary(d[WIKI], STATE["panorama"][WIKI]["buckets"], 35,
                {"ownerItems": [{"kind": "COORDINATOR_QUESTION", "count": 1, "oldestWaitingSince": iso(35)}]},
                line(WIKI)),
        summary(d[RUN], STATE["panorama"][RUN]["buckets"], 0, {}, line(RUN)),
        summary(d[PAUSED], STATE["panorama"][PAUSED]["buckets"], 20, {}, line(PAUSED)),
        summary(d[OWN], STATE["panorama"][OWN]["buckets"], 50, {}),
    ]


def coordinator_session(pid):
    doc = STATE["docs"][pid]
    return {"id": COORD[pid], "title": doc["title"], "status": "AWAITING_INPUT",
            "runStatus": "AWAITING_INPUT", "sessionState": "AWAITING_INPUT", "runState": "AWAITING_INPUT",
            "lifecycleState": "OPEN", "filingState": "OPEN", "agentId": AGENT_ID,
            "agent": {"id": AGENT_ID, "name": "orbit"}, "assignedRunnerId": RUNNER_ID,
            "provider": "claude", "model": "claude-opus-5", "projectId": pid, "taskId": None,
            "createdAt": iso(600), "updatedAt": iso(2), "lastTurnAt": iso(2)}


def coordinator_events(pid):
    """The conversation the start card lands in: the coordinator's last word before it asked."""
    text = ("The plan is ready: five tasks, four criteria. B and C build on A, and E needs both, so I "
            "suggest they land together on a project branch. I've asked you to start the project.")
    return {"events": [
        {"seq": 1, "type": "user", "ts": iso(30), "turnId": "t1",
         "payload": {"text": "Plan the Runner page redesign and ask me to start it when it's ready."}},
        {"seq": 2, "type": "assistant", "ts": iso(2.2), "turnId": "t1", "payload": {"text": text}},
        {"seq": 3, "type": "result", "ts": iso(2.1), "turnId": "t1", "payload": {"subtype": "success"}},
    ], "hasMore": False}


def dump(directory):
    os.makedirs(directory, exist_ok=True)
    def put(name, body):
        with open(os.path.join(directory, name), "w") as fh:
            json.dump(body, fh, ensure_ascii=False, indent=1)
    put("projects.json", summaries())
    for pid in STATE["docs"]:
        put(f"{pid}.document.json", STATE["docs"][pid])
        put(f"{pid}.panorama.json", STATE["panorama"][pid])
        put(f"{pid}.integration.json", integration_of(pid))
        put(f"{pid}.open-items.json", STATE["open"][pid])
        put(f"{pid}.coordinator.json", STATE["coordinator"][pid])
        put(f"{pid}.graph.json", STATE["graph"][pid])
        put(f"{pid}.ready.json", ready_queue(STATE["tasks"][pid]))
        put(f"{pid}.tasks.json", {"items": STATE["tasks"][pid], "nextCursor": None})
        put(f"{pid}.confirmation.json", STATE["confirmation"][pid])


# ── the writes ──────────────────────────────────────────────────────────────────────────────

def record(method, path, body):
    line = json.dumps({"at": datetime.now(timezone.utc).isoformat(), "method": method, "path": path,
                       "body": body}, ensure_ascii=False)
    with open(os.path.join(OUT, "writes.jsonl"), "a") as fh:
        fh.write(line + "\n")
    print(f"==> {method} {path} {json.dumps(body, ensure_ascii=False)}", flush=True)


def patch_project(pid, body):
    doc = STATE["docs"][pid]
    if "automatic" in body:
        doc["coordinatorEnabled"] = bool(body["automatic"])
    if "maxConcurrentTasks" in body:
        doc["maxConcurrentTasks"] = int(body["maxConcurrentTasks"])
    if "automatic" in body or "maxConcurrentTasks" in body:
        doc["configRevision"] = str(int(doc["configRevision"]) + 1)
    if "status" in body:
        doc["status"] = body["status"]
    return doc


def patch_integration(pid, body):
    doc = STATE["docs"][pid]
    s = doc["integration"] or {"line": None, "ref": None, "upstreamRef": "main", "source": "EXPLICIT",
                               "locked": False, "startedAt": None, "mergeCheckCommand": None,
                               "escalationSeconds": 7200}
    if "line" in body:
        s["line"] = body["line"]
        s["ref"] = f"project/{pid}" if body["line"] == "PROJECT_BRANCH" else "main"
    if "mergeCheckCommand" in body:
        s["mergeCheckCommand"] = body["mergeCheckCommand"]
    if "exceptionEscalationSeconds" in body:
        s["escalationSeconds"] = int(body["exceptionEscalationSeconds"])
    doc["integration"] = s
    return integration_of(pid)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, body, status=200):
        data = json.dumps(body, ensure_ascii=False).encode()
        try:
            with open(os.path.join(OUT, "requests.log"), "a") as fh:
                shape = type(body).__name__ + (f"[{len(body)}]" if isinstance(body, (list, dict)) else "")
                fh.write(f"{datetime.now(timezone.utc).strftime('%H:%M:%S')} {self.command} {self.path} -> {status} {shape}\n")
        except OSError:
            pass
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}

    def _project_read(self, parts):
        pid = parts[2]
        if pid not in STATE["docs"]:
            return self._send({"message": "Project not found"}, 404)
        rest = "/".join(parts[3:])
        reads = {
            "": lambda: STATE["docs"][pid],
            "panorama": lambda: STATE["panorama"][pid],
            "panorama/ready": lambda: ready_queue(STATE["tasks"][pid]),
            "integration": lambda: integration_of(pid),
            "open-items": lambda: STATE["open"][pid],
            "coordinator/status": lambda: STATE["coordinator"][pid],
            "dependency-graph": lambda: STATE["graph"][pid],
            "tasks/page": lambda: {"items": STATE["tasks"][pid], "nextCursor": None},
            "acceptance/confirmation": lambda: STATE["confirmation"][pid],
            "acceptance/criteria-decisions/pending": lambda: {"pending": [], "settled": []},
            "promotions/current": lambda: None,
            "promotions/merged": lambda: [],
            "criteria": lambda: {"id": pid, "title": STATE["docs"][pid]["title"],
                                 "status": "OPEN", "startedAt": STATE["docs"][pid]["startedAt"],
                                 "_count": STATE["docs"][pid]["_count"],
                                 "acceptanceCriteriaItems": [
                                     {"id": c["id"], "ordinal": c["ordinal"], "text": c["text"]}
                                     for c in STATE["docs"][pid]["acceptanceCriteriaItems"]]},
        }
        if rest in reads:
            with LOCK:
                return self._send(reads[rest]())
        return self._send([])

    def do_GET(self):
        path = self.path.split("?")[0]
        parts = path.strip("/").split("/")
        if path.endswith("/api/events"):
            return self._sse()
        if path in ("/api/projects", "/api/projects/"):
            with LOCK:
                return self._send(summaries())
        if len(parts) >= 3 and parts[:2] == ["api", "projects"]:
            return self._project_read(parts)
        for pid in COORD:
            for sid in (COORD[pid], COORD_UUID[pid]):
                if path == f"/api/sessions/{sid}":
                    return self._send(coordinator_session(pid))
                if path == f"/api/sessions/{sid}/events/page":
                    return self._send(coordinator_events(pid))
        routes = {
            "/api/users/me": {"id": WIKOVA, "email": "wikova@example.com", "name": "Wikova",
                              "role": "ADMIN", "createdAt": "2026-01-01T00:00:00.000Z"},
            "/api/agents": [AGENT],
            "/api/runners": [RUNNER],
            "/api/sessions": [],
            "/api/session-tags": [],
        }
        if path in routes:
            return self._send(routes[path])
        if path.startswith("/api/agents/"):
            return self._send(AGENT)
        if path.startswith("/api/runners/"):
            return self._send(RUNNER)
        return self._send([])

    def do_POST(self):
        path = self.path.split("?")[0]
        parts = path.strip("/").split("/")
        body = self._body()
        if path == "/api/__probe/reset":
            # Between two passes of the same walk (light, then dark): the first pass's presses are
            # undone, so the second photographs the same states.
            global STATE, T0
            with LOCK:
                T0 = datetime.now(timezone.utc)
                STATE = build()
            return self._send({"reset": True})
        if path == "/api/auth/login":
            return self._send({"accessToken": "probe-access-token", "refreshToken": "probe-refresh-token",
                               "user": {"id": WIKOVA, "email": body.get("email") or "wikova@example.com",
                                        "name": "Wikova", "role": "ADMIN"}})
        if len(parts) >= 4 and parts[:2] == ["api", "projects"] and parts[2] in STATE["docs"]:
            pid, door = parts[2], "/".join(parts[3:])
            record("POST", path, body)
            with LOCK:
                doc = STATE["docs"][pid]
                if door == "pause":
                    doc["pausedAt"], doc["pausedReason"] = iso(0), "OWNER"
                    return self._send({"projectId": pid, "startedAt": doc["startedAt"],
                                       "pausedAt": doc["pausedAt"], "pausedReason": "OWNER"}, 201)
                if door == "resume":
                    doc["pausedAt"], doc["pausedReason"] = None, None
                    return self._send({"projectId": pid, "startedAt": doc["startedAt"],
                                       "pausedAt": None, "pausedReason": None}, 201)
                if door == "coordinator":
                    return self._send({"sessionId": COORD[pid], "created": False, "workspaceId": AGENT_ID}, 201)
                if door == "start":
                    doc["startedAt"] = iso(0)
                    STATE["open"][pid]["startRequest"] = None
                    return self._send({"projectId": pid, "startedAt": doc["startedAt"]}, 201)
            return self._send({}, 201)
        return self._send({})

    def do_PATCH(self):
        path = self.path.split("?")[0]
        parts = path.strip("/").split("/")
        body = self._body()
        if len(parts) >= 3 and parts[:2] == ["api", "projects"] and parts[2] in STATE["docs"]:
            record("PATCH", path, body)
            with LOCK:
                if len(parts) == 4 and parts[3] == "integration":
                    return self._send(patch_integration(parts[2], body))
                return self._send(patch_project(parts[2], body))
        return self._send({})

    def do_PUT(self):
        self._body()
        self._send({})

    def do_DELETE(self):
        self._send({})

    def _sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            while True:
                self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
                time.sleep(10)
        except Exception:
            return


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    # http.server's own server_bind calls getfqdn(), which on macOS 26 raises the "allow Python to
    # find devices on your local network" prompt — over the very screenshots this is for.
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = "127.0.0.1"
        self.server_port = self.server_address[1]


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--dump":
        dump(sys.argv[2])
        sys.exit(0)
    print(f"stub control plane on 127.0.0.1:{PORT}, writing to {OUT}", flush=True)
    Server(("127.0.0.1", PORT), Handler).serve_forever()
