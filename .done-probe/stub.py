#!/usr/bin/env python3
"""TEMPORARY evidence probe (shots branch only; see README.md).

The control plane the real iOS app signs in to for task ⑥ (project 34Y7My8sqhKLWtmCQYv1l, criterion
6 — iOS/macOS close-out): a stub on 127.0.0.1:8787 (the simulator shares the host's loopback)
answering the reads the session list, the projects list, the project page and a coordinator
conversation make, over four projects that between them draw every state the change adds:

  ASKED    every criterion met, its coordinator asked 4 minutes ago to record it done, two gaps
           → the session row's "Ready to close", the page's Ready to close + the request's row,
             "Is this project done?" in the conversation and over the page, its receipt
  WORKING  two criteria not on main, nobody on them        → "Why is this project not done?"
                                                             + Ask the coordinator to handle it
  LANDING  one criterion's landing in flight              → Why-not-done: the coordinator is on it
  DONE     recorded done by the owner, two gaps accepted   → the receipt; "recorded by you"
  ORBIT    recorded done by Orbit                          → "recorded by Orbit"

Every write a press makes is recorded, body and all, in <STUB_OUT>/writes.jsonl — and applied, so
the page the app reads back is the one the write left: that file is the evidence of what the app
sends (POST /projects/:id/done with the request's seal and gaps, the decline note, the reopen).

Nothing here re-implements the app: it runs unmodified, and this is only the server's side.

usage: stub.py                 serve (env STUB_OUT, STUB_PORT)
       stub.py --dump DIR      write every read, one file per fixture, for a decode check
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

ASKED = "34Y7Asked0CloseOutDemo1"
WORKING = "34Y7Work1NotDoneDemo2xQ"
LANDING = "34Y7Land2InFlightDemo3z"
DONE = "34Y7Done3RecordedByYou4"
ORBIT = "34Y7Orbt4RecordedByOrbit"

B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def b62(u):
    """A uuid's public spelling (`PublicID.toPublic`): the 16 bytes as one base62 number."""
    n, out = int(u.replace("-", ""), 16), ""
    while n:
        n, r = divmod(n, 62)
        out = B62[r] + out
    return out or "0"


COORD_UUID = {ASKED: uid(701), WORKING: uid(702), LANDING: uid(703), DONE: uid(704), ORBIT: uid(705)}
COORD = {pid: b62(u) for pid, u in COORD_UUID.items()}
DONE_ITEM = b62(uid(5000))

AGENT = {"id": AGENT_ID, "name": "orbit", "lastProvider": "claude", "permissionMode": "default",
         "effort": "", "workDir": "~/orbit", "runnerId": RUNNER_ID, "enabled": True,
         "description": "the office"}

RUNNER = {
    "id": RUNNER_ID, "name": "wikova", "online": True, "version": "0.1.210",
    "runsAsRoot": False, "activeSessions": 2,
    "runtimeDefaultModels": {"claude": "claude-opus-5-5"},
    "engines": [{"engine": "claude", "installed": True, "auth": "yes", "version": "2.1.290"}],
    "modelCatalog": {"claude": [{"value": "claude-opus-5-5", "label": "Opus 5.5"}]},
}

REASONS = ["IN_FLIGHT", "ON_PROJECT_BRANCH", "NOTHING_TO_LAND", "NO_RECEIPT", "CODELESS"]

# The ten criteria of the mock's project ("项目启动重做"), the last one served by a go-live task
# that made no commits.
TEN = [
    "协调者用 project_request_start 请求开工，带计划与建议的运行方式",
    "开工前 Orbit 做 ready 检查：判据都有任务服务、任务都有 runner",
    "所有者在一张卡上确认判据并开工，设置一次写入",
    "web 的 Start this project? 卡与项目页的开工行",
    "iOS/macOS 同一张卡、同一套文案",
    "How it runs 区块：集成线、Automatic、并发与 merge check",
    "协调者请求后 Ready to start 写在会话行与项目列表",
    "开工后判据被改，卡片改问 Confirm the new criteria?",
    "project-start-request 的 pg spec 全绿",
    "上线：合入 main、部署、beta，所有者走查",
]


def criteria_items(texts, base):
    return [{"id": uid(base + i), "key": uid(base + i), "ordinal": i + 1, "text": t, "revision": 1,
             "satisfied": True, "unmet": [], "landing": "LANDED",
             "verificationMethod": "client.yml 双端 success；截图与效果图并排。"}
            for i, t in enumerate(texts)]


def answer(item, satisfied=True, landing="LANDED", reason=None, withheld=()):
    return {"definitionId": item["id"], "satisfied": satisfied, "landing": landing,
            "independence": "INDEPENDENT", "conflicts": [], "remedy": None,
            "landingReason": reason, "withheld": list(withheld)}


def counts(answers):
    by = {r: 0 for r in REASONS}
    for a in answers:
        if a["landingReason"]:
            by[a["landingReason"]] += 1
    landed = sum(1 for a in answers if a["landing"] == "LANDED" or a["landingReason"] == "NOTHING_TO_LAND")
    return {"criteria": len(answers), "met": sum(1 for a in answers if a["satisfied"]),
            "landed": landed, "onMain": sum(1 for a in answers if a["landingReason"] is None),
            "byReason": by}


def derived(answers):
    withheld = sorted({w for a in answers for w in a["withheld"]})
    done = not withheld
    return {"status": "DONE" if done else "OPEN", "done": done, "withheld": withheld,
            "criteria": answers, "confirmation": "CONFIRMED", "counts": counts(answers)}


def project(pid, title, status, items, answers, goal, done_by=None, done_at=None, gaps=()):
    return {
        "id": pid, "title": title, "status": status, "goal": goal, "instructions": None,
        "createdAt": iso(4 * 24 * 60), "updatedAt": iso(2),
        "coordinatorEnabled": True, "configRevision": "3",
        "coordinatorSessionId": COORD[pid], "maxConcurrentTasks": 3,
        "startedAt": iso(3 * 24 * 60), "pausedAt": None, "pausedReason": None,
        "_count": {"tasks": 12},
        "tasksByStatus": {"DONE": 11, "CANCELLED": 1},
        "acceptanceCriteriaItems": items,
        "integration": {"line": "PROJECT_BRANCH", "lineAbsentReason": None, "ref": f"project/{pid}",
                        "upstreamRef": "main", "source": "EXPLICIT", "locked": True,
                        "startedAt": iso(2 * 24 * 60),
                        "mergeCheckCommand": "npm test", "mergeCheckCommandAbsentReason": None,
                        "mergeCheckTimeoutSeconds": None, "escalationSeconds": 7200},
        "blockers": {"open": [], "recentlyResolved": []},
        "derivedDone": derived(answers),
        "doneBy": done_by, "doneAt": done_at, "doneCriteriaDigest": "d" * 64 if done_by else None,
        "acceptedGaps": list(gaps),
    }


GAPS = [
    {"criterionKey": None, "title": "Go-live has nothing to land",
     "whyNotProven": "Its task made no commits — it checked the deploy, the release and ran the "
                     "walkthrough — so there is no merge to hold a receipt for.",
     "coordinatorChecked": "main contains all 15 files this project added or changed",
     "evidenceRefs": ["34Y4xlxE"]},
    {"criterionKey": None, "title": "Shipped by other sessions",
     "whyNotProven": "The deploy (Sep 30 15:24) and beta.144 were cut by other sessions. This project "
                     "made no runner release of its own — its runner change went out in 0.1.198.",
     "coordinatorChecked": "the live web has all 7 new strings · beta.144 TestFlight and DMG succeeded",
     "evidenceRefs": ["walkthrough log"]},
]

JUDGMENT = ("The goal is met. All 10 criteria hold and the work is on main. Two things Orbit can’t "
            "prove by itself — I checked both, below.")


def build():
    s = {}
    asked_items = criteria_items(TEN, 3000)
    gaps = [dict(g, criterionKey=asked_items[9]["key"]) for g in GAPS]
    asked_answers = [answer(i) for i in asked_items[:9]] + [
        answer(asked_items[9], landing="UNKNOWN", reason="NOTHING_TO_LAND", withheld=["CRITERION_UNLANDED"])]

    work_items = criteria_items([
        "web 与 iOS 的 Runner 页结构一一对应：引擎、账号、会话、更新四块同顺序。",
        "signed out 只在有工作区依赖本机登录时才提醒。",
        "上线：合入 main、部署、iOS/macOS 发一个 beta。",
        "web：项目页与项目列表写 Ready to start / How it runs。",
        "iOS/macOS：Runner 页与 web 同结构，文案逐字一致。",
    ], 3100)
    work_answers = [answer(work_items[0]), answer(work_items[1]),
                    answer(work_items[2], landing="UNKNOWN", reason="NO_RECEIPT", withheld=["CRITERION_UNLANDED"]),
                    answer(work_items[3], landing="ON_INTEGRATION_LINE", reason="ON_PROJECT_BRANCH",
                           withheld=["CRITERION_UNLANDED"]),
                    # Still being worked on: its task's branch has no receipt yet, which the landing
                    # lane calls NO_RECEIPT — the row must say "Not met yet", not "Merged outside Orbit".
                    answer(work_items[4], satisfied=False, landing="UNKNOWN", reason="NO_RECEIPT",
                           withheld=["CRITERION_UNSATISFIED", "CRITERION_UNLANDED"])]

    land_items = criteria_items([
        "证据先投协调者：投递与回执。",
        "协调者判完成的 MCP 工具与说明。",
        "web 决策条：协调者已判 / 等 owner。",
    ], 3200)
    land_answers = [answer(land_items[0]), answer(land_items[1]),
                    answer(land_items[2], landing="ON_INTEGRATION_LINE", reason="IN_FLIGHT",
                           withheld=["CRITERION_UNLANDED"])]

    done_items = criteria_items(TEN[:4], 3300)
    done_answers = [answer(i) for i in done_items[:3]] + [
        answer(done_items[3], landing="UNKNOWN", reason="NO_RECEIPT", withheld=["CRITERION_UNLANDED"])]
    done_gaps = [dict(g, criterionKey=done_items[3]["key"]) for g in GAPS]

    orbit_items = criteria_items(TEN[:3], 3400)
    orbit_answers = [answer(i) for i in orbit_items]

    s["docs"] = {
        ASKED: project(ASKED, "项目启动重做：协调者请求启动，一张卡定判据、集成分支与 Automatic", "OPEN",
                       asked_items, asked_answers, "开工改成协调者请求、所有者在一张卡上确认一次。"),
        WORKING: project(WORKING, "Runner 页整页改版（iOS/macOS + web）", "OPEN", work_items, work_answers,
                         "Runner 页 iOS 与 web 同结构。"),
        LANDING: project(LANDING, "Automatic 项目里由协调者判任务完成", "OPEN", land_items, land_answers,
                         "证据先投协调者，协调者判完成。"),
        DONE: project(DONE, "项目进度改版：判据、落地与例外一页看全", "DONE", done_items, done_answers,
                      "项目页一页看全。", "OWNER", "2026-10-01T01:40:00.000Z", done_gaps),
        ORBIT: project(ORBIT, "iOS 设置 sheet 改版", "DONE", orbit_items, orbit_answers,
                       "iOS/iPad 设置改用 sheet。", "DERIVED", "2026-09-30T18:12:00.000Z"),
    }
    s["open"] = {pid: {"needsYou": [], "withCoordinator": [], "startRequest": None, "doneRequest": None}
                 for pid in s["docs"]}
    s["open"][ASKED]["doneRequest"] = {
        "itemId": DONE_ITEM, "kind": "DONE_REQUEST", "title": "Is this project done?", "detailLine": "",
        "assignee": "OWNER", "assigneeReason": "DEFAULT", "waitingSince": iso(4),
        "escalateAt": None, "escalatedAt": None, "taskId": None, "sessionId": COORD[ASKED],
        "promotionId": None, "fuseEpisodeId": None,
        "delivery": {"state": "NOT_REQUIRED", "sessionId": None, "at": None},
        "actions": ["REVIEW"], "question": None, "facts": None,
        "doneRequest": {"criteriaDigest": "c" * 64, "judgment": JUDGMENT, "gaps": gaps,
                        "stateDigest": "s" * 64,
                        "warnings": [{"severity": "WARN", "code": "DONE_CRITERION_UNLANDED",
                                      "message": "Criterion 10 is not LANDED: nothing to land.",
                                      "requiredAction": "Say why in a gap.", "criterion": None,
                                      "reason": "NOTHING_TO_LAND", "tasks": [], "items": [], "jobs": []}]},
    }
    s["waiting"] = {ASKED: "DONE_REQUEST"}
    s["confirmation"] = {
        pid: {"state": "CONFIRMED", "confirmed": True,
              "currentVersion": {"digest": "c" * 64,
                                 "material": [{"definitionId": c["id"], "revision": 1,
                                               "contentHash": f"h{c['ordinal']}"}
                                              for c in s["docs"][pid]["acceptanceCriteriaItems"]]},
              "confirmation": {"criteriaDigest": "c" * 64,
                               "criteriaMaterial": [{"definitionId": c["id"], "revision": 1,
                                                     "contentHash": f"h{c['ordinal']}"}
                                                    for c in s["docs"][pid]["acceptanceCriteriaItems"]],
                               "confirmedAt": "2026-09-29T08:26:00.000Z", "confirmedById": WIKOVA}}
        for pid in s["docs"]}
    return s


STATE = build()


def buckets(pid):
    doc = STATE["docs"][pid]
    return {"running": 0, "ready": 0, "blocked": 0, "awaitingVerification": 0, "done": 11,
            "failed": 0, "cancelled": 1}


def summary(pid, last_active):
    doc = STATE["docs"][pid]
    attention = {"userBlockers": 0, "coordinatorBlockers": 0, "systemBlockers": 0, "maxSeverity": None,
                 "attentionSinceAt": None, "nextCheckAt": None, "ownerItems": [], "coordinatorItems": None,
                 "startRequest": None,
                 "doneRequest": ({"waitingSince": STATE["open"][pid]["doneRequest"]["waitingSince"]}
                                 if STATE["open"][pid]["doneRequest"] else None)}
    return {"id": pid, "title": doc["title"], "status": doc["status"], "goal": doc["goal"],
            "doneBy": doc["doneBy"], "doneAt": doc["doneAt"], "acceptedGaps": doc["acceptedGaps"],
            "createdAt": doc["createdAt"], "updatedAt": doc["updatedAt"],
            "coordinatorAgentId": AGENT_ID, "coordinatorGeneration": "0",
            "_count": doc["_count"], "buckets": buckets(pid), "lastActivityAt": iso(last_active),
            "attention": attention,
            "integration": {"line": "PROJECT_BRANCH", "ref": f"project/{pid}"}}


def summaries():
    return [summary(ASKED, 4), summary(WORKING, 30), summary(LANDING, 3), summary(DONE, 3 * 24 * 60),
            summary(ORBIT, 4 * 24 * 60)]


def panorama():
    return {"buckets": {"running": 0, "ready": 0, "blocked": 0, "awaitingVerification": 0, "done": 11,
                        "failed": 0, "cancelled": 1, "integrating": 0, "onIntegrationLine": 0,
                        "onUpstream": 11, "doneNotIntegrated": 0, "waitingForLanding": 0},
            "shape": {"taskCount": 12, "edgeCount": 0, "ratio": 0, "maxDepth": 0, "form": "flat"}}


def integration_view(pid):
    s = STATE["docs"][pid]["integration"]
    return {"line": s["line"], "ref": s["ref"], "upstreamRef": "main", "locked": True,
            "startedAt": s["startedAt"], "mergeCheckCommand": s["mergeCheckCommand"],
            "escalationSeconds": 7200, "commitsAheadOfUpstream": 0, "lastUpstreamSyncAt": iso(20),
            "integratingCount": 0, "queuedCount": 0, "mergeCheckOnTip": "PASSING", "inFlight": None}


def coordinator(pid):
    waiting = STATE["waiting"].get(pid)
    return {
        "projectId": pid, "readAt": iso(0), "state": "LIVE",
        "coordination": {
            "sessionId": COORD[pid], "sessionIdAbsentReason": None,
            "session": {"id": COORD[pid], "title": STATE["docs"][pid]["title"], "runStatus": "AWAITING_INPUT",
                        "runState": "AWAITING_INPUT", "lifecycleState": "OPEN", "filingState": "OPEN",
                        "endReason": None, "startedAt": iso(600), "finishedAt": None, "completedAt": None,
                        "deletedAt": None, "engineTurnActive": False, "pendingApprovals": 1 if waiting else 0,
                        "lastTurnAt": iso(4), "lastTurnAtAbsentReason": None},
            "sessionAbsentReason": None, "coordinatorGeneration": "0", "workspaceId": AGENT_ID,
            "workspaceIdAbsentReason": None, "workspaceName": "orbit", "agentId": AGENT_ID,
            "agentName": "orbit", "wakeups": {"state": "DELIVERED", "at": iso(4)},
            "fuse": {"selfStartedToday": 2, "limit": 30, "paused": False, "episodeId": None}},
        "openability": {"canOpen": True, "willCreate": False, "refusalCode": None,
                        "refusalDetail": None, "refusalCodeAbsentReason": "NOTHING_REFUSES",
                        "requiredAction": None, "landing": {"workspaceId": None, "workspaceName": None}},
    }


def coordinator_session(pid):
    doc = STATE["docs"][pid]
    waiting = STATE["waiting"].get(pid)
    return {"id": COORD[pid], "title": doc["title"], "status": "AWAITING_INPUT",
            "runStatus": "AWAITING_INPUT", "sessionState": "AWAITING_INPUT", "runState": "AWAITING_INPUT",
            "lifecycleState": "OPEN", "filingState": "OPEN", "agentId": AGENT_ID,
            "agent": {"id": AGENT_ID, "name": "orbit"}, "assignedRunnerId": RUNNER_ID,
            "provider": "claude", "model": "claude-opus-5-5", "projectId": pid, "projectTitle": doc["title"],
            "projectMembership": {"projectId": pid, "projectTitle": doc["title"], "projectStatus": doc["status"],
                                  "role": "COORDINATOR"},
            "taskId": None, "pendingApprovals": 1 if waiting else 0, "waitingKind": waiting,
            "lastAssistantText": LAST_WORD.get(pid, "Working through the plan."),
            "createdAt": iso(600), "updatedAt": iso(4), "lastTurnAt": iso(4)}


LAST_WORD = {
    ASKED: ("10 条判据都满足，代码都在 main 上。⑩ 是上线走查任务，没有提交，Orbit 证明不了它「落地」——"
            "我核过 main，证据在卡上。我请求收尾，你看一眼两条缺口，按一次就行。"),
    WORKING: "判据 3 的合并在 Orbit 之外做的，判据 4 还在项目分支上等 merge check。",
    LANDING: "判据 3 正在合进 main，merge check 跑完我再看。",
    DONE: "项目已记为完成。",
    ORBIT: "所有判据都落地了，Orbit 已自己记为完成。",
}


def coordinator_events(pid):
    return {"events": [
        {"seq": 1, "type": "user", "ts": iso(40), "turnId": "t1",
         "payload": {"text": "收尾前把每条判据和证据核一遍。"}},
        {"seq": 2, "type": "assistant", "ts": iso(4.2), "turnId": "t1", "payload": {"text": LAST_WORD[pid]}},
        {"seq": 3, "type": "result", "ts": iso(4.1), "turnId": "t1", "payload": {"subtype": "success"}},
    ], "hasMore": False}


def dump(directory):
    os.makedirs(directory, exist_ok=True)

    def put(name, body):
        with open(os.path.join(directory, name), "w") as fh:
            json.dump(body, fh, ensure_ascii=False, indent=1)
    put("projects.json", summaries())
    put("sessions.json", [coordinator_session(pid) for pid in COORD])
    for pid in STATE["docs"]:
        put(f"{pid}.document.json", STATE["docs"][pid])
        put(f"{pid}.open-items.json", STATE["open"][pid])
        put(f"{pid}.confirmation.json", STATE["confirmation"][pid])


# ── the writes ──────────────────────────────────────────────────────────────────────────────

def record(method, path, body):
    line = json.dumps({"at": datetime.now(timezone.utc).isoformat(), "method": method, "path": path,
                       "body": body}, ensure_ascii=False)
    with open(os.path.join(OUT, "writes.jsonl"), "a") as fh:
        fh.write(line + "\n")
    print(f"==> {method} {path} {json.dumps(body, ensure_ascii=False)}", flush=True)


def record_done(pid, body):
    doc = STATE["docs"][pid]
    now = iso(0)
    doc.update(status="DONE", doneBy="OWNER", doneAt=now, doneCriteriaDigest=body.get("criteriaDigest"),
               acceptedGaps=body.get("acceptedGaps") or [])
    STATE["open"][pid]["doneRequest"] = None
    STATE["waiting"].pop(pid, None)
    return {"projectId": pid, "status": "DONE", "doneBy": "OWNER", "doneAt": now,
            "criteriaDigest": body.get("criteriaDigest"), "acceptedGaps": doc["acceptedGaps"],
            "requestId": body.get("requestId")}


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
            "panorama": panorama,
            "panorama/ready": lambda: {"readyCount": 0, "queuedCount": 0, "runningCount": 0,
                                       "pausedCount": 0, "impactTruncated": None, "items": []},
            "integration": lambda: integration_view(pid),
            "open-items": lambda: STATE["open"][pid],
            "coordinator/status": lambda: coordinator(pid),
            "dependency-graph": lambda: {"marks": [], "edges": [], "taskCount": 0, "folded": False,
                                         "truncated": False, "limits": {"maxTasks": 500, "maxMarks": 300}},
            "tasks/page": lambda: {"items": [], "nextCursor": None},
            "acceptance/confirmation": lambda: STATE["confirmation"][pid],
            "acceptance/criteria-decisions/pending": lambda: {"pending": [], "settled": []},
            "promotions/current": lambda: None,
            "promotions/merged": lambda: [],
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
        if path == "/api/projects/sidebar":
            with LOCK:
                return self._send([s for s in summaries() if s["status"] == "OPEN"])
        if len(parts) >= 3 and parts[:2] == ["api", "projects"]:
            return self._project_read(parts)
        if path == "/api/sessions":
            with LOCK:
                return self._send([coordinator_session(pid) for pid in (ASKED, WORKING, LANDING, DONE, ORBIT)])
        for pid in COORD:
            for sid in (COORD[pid], COORD_UUID[pid]):
                if path == f"/api/sessions/{sid}":
                    with LOCK:
                        return self._send(coordinator_session(pid))
                if path == f"/api/sessions/{sid}/events/page":
                    return self._send(coordinator_events(pid))
        routes = {
            "/api/users/me": {"id": WIKOVA, "email": "wikova@example.com", "name": "Wikova",
                              "role": "ADMIN", "createdAt": "2026-01-01T00:00:00.000Z"},
            "/api/agents": [AGENT],
            "/api/runners": [RUNNER],
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
                if door == "done":
                    return self._send(record_done(pid, body), 201)
                if door.startswith("done-requests/") and door.endswith("/decline"):
                    STATE["open"][pid]["doneRequest"] = None
                    STATE["waiting"].pop(pid, None)
                    return self._send({"itemId": parts[4], "state": "RESOLVED", "resolution": "DECLINED",
                                       "note": body.get("note", ""), "delivery": None}, 201)
                if door == "coordinator":
                    return self._send({"sessionId": COORD[pid], "created": False, "workspaceId": AGENT_ID}, 201)
            return self._send({}, 201)
        if len(parts) >= 4 and parts[:2] == ["api", "sessions"]:
            record("POST", path, body)
        return self._send({})

    def do_PATCH(self):
        path = self.path.split("?")[0]
        parts = path.strip("/").split("/")
        body = self._body()
        if len(parts) == 3 and parts[:2] == ["api", "projects"] and parts[2] in STATE["docs"]:
            record("PATCH", path, body)
            with LOCK:
                doc = STATE["docs"][parts[2]]
                if body.get("status") == "OPEN":
                    doc.update(status="OPEN", doneBy=None, doneAt=None, acceptedGaps=[])
                elif "status" in body:
                    doc["status"] = body["status"]
                return self._send(doc)
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
