#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the wiki chat reads in the iPhone and Mac apps,
# for task 34se1Wpwmw3db4PGWDHLa (C11, docs/wiki-chat-design.md §9, board docs/mocks/wiki/42-wiki-chat ⑤). Adapted
# from docs/evidence/wiki-diagram-apple/probe-harness/stub.py (a wiki document's reads) and
# docs/evidence/ask-question-card/probe-harness/stub.py (a conversation's reads).
#
# One space, `orbit`, and its document `session-runtime` (3.1, the shared fixture's, src/shared/src/wiki-docs.fixture.json),
# whose section 3 is board 42 ⑤'s own: "turn 投递与 inbox 领取", the heartbeat sentences, footnotes [5][12]. Every
# sentence carries an id (contract chat.notes.wikiContext). The stage, set with POST /__set {"stage": ...} and put back
# to `ask` by POST /__reset, decides what the chat reads say:
#
#   ask      no chat yet: the button at rest; a new chat runs in the remembered orbit-develop on HPC
#   working  the space's one chat has a turn running: the button's ring
#   card     the chat "Runner 离线判定的原因" ends on a fresh card (wiki_propose answered draftId D1): the amber 1
#   updated  D1 was applied and its rewrite of 3.1 §3 came out, one sentence added: the green check, the floating line,
#            Updated beside §3, the new sentence, and See changes
#
# C17 (task 34tCu2BUrQzPhteUu7QoR) adds four stages in which D1 is a plan card of two documents — board 42 ③'s split:
# 3.1's §3 moved into a new 3.3, 3.1's §1 covers — answered by wiki_draft:
#   plan         a fresh draft: both documents in the heading, the Moves row, each document's rows, Rewrites 3.1 · 3.3
#   planApplied  applied, the plan where its press left it: Undo and Open in Plan; the rebuild's line names both documents
#   planMoved    applied, the plan moved on since: the note, Open in Plan, no Undo
#   planUndone   undone
#
# Every request is logged; anything not served is a 404, and every write a 409 — the probe presses nothing. All data
# is made up.
import copy
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = json.load(open(os.path.join(HERE, "..", "src", "shared", "src", "wiki-docs.fixture.json"), encoding="utf-8"))
SPACE_ID = "0196f000-0000-7000-8000-000000000001"
STATE = {"stage": "ask"}


def stamp(minutes_ago=0.0):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def space():
    return {"id": SPACE_ID, "slug": "orbit", "title": "orbit", "repoUrlNorm": "github.com/jianghailong-xy/orbit",
            "rootCommitSha": "b" * 40, "settings": {"chat": {"workspaceId": "a1"}},
            "createdAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-09-01T00:00:00.000Z",
            "pendingOps": 0, "planWaiting": 0, "chatWaiting": 0, "workspaceIds": ["a1"],
            "docs": {"total": 6, "written": 6}}


# ── the document ─────────────────────────────────────────────────────────────────────────────────────

BOARD_A = "心跳机制用于控制面探测失联的 runner。"
BOARD_B = "Runner 每 30 秒发送一次心跳，控制面连续 90 秒未收到心跳即判定 runner 离线，此时 resume 功能不可用。"
BOARD_NEW = "留三次余量是为了扛住一次网关重启，一次抖动不会让 Resume 失效。"
BOARD_C = "选择 long-poll 而非 WebSocket 的原因包括：runner 仅支持出站 HTTP、网关 nginx 配置限制 WebSocket 握手。"


def sentence(sid, text, notes):
    return {"id": sid, "text": text, "status": "sourced", "notes": notes, "newTokens": [], "withdrawn": None}


def document():
    doc = copy.deepcopy(SHARED["docs"]["doc"]["read"])
    doc["spaceId"] = SPACE_ID
    doc["number"] = "3.1"
    doc["category"] = {"key": "sessions", "number": 3, "title": "会话"}
    fixture = {s["key"]: s for s in doc["sections"]}
    # Every sentence of the fixture's sections gets an id; numbers 1, 2, 3, 4 in the board's order.
    out = []
    for number, (key, source) in enumerate([("s1", "s1"), ("s2", "s7"), ("s3", None), ("s4", "s9")], start=1):
        if source is None:
            section = copy.deepcopy(fixture["s1"])
            section.update({"key": "s3", "number": 3, "title": "turn 投递与 inbox 领取", "stale": False, "change": None})
            first = [sentence("34sentS3a", BOARD_A, []), sentence("34sentS3b", BOARD_B, [5, 12])]
            if STATE["stage"] == "updated":
                first.append(sentence("34sentS3n", BOARD_NEW, [13]))
                section["change"] = {"versionId": "V1", "reason": {"kind": "chat", "title": "Runner 离线判定的原因"},
                                     "at": stamp(1), "changed": 1}
            section["blocks"] = [{"kind": "paragraph", "text": None, "sentences": first},
                                 {"kind": "paragraph", "text": None, "sentences": [sentence("34sentS3c", BOARD_C, [2])]}]
        else:
            section = copy.deepcopy(fixture[source])
            section.update({"key": key, "number": number, "change": None})
            for b, block in enumerate(section.get("blocks") or []):
                for i, s in enumerate(block.get("sentences") or []):
                    s["id"] = "34sent%s%d%d" % (key, b, i)
        out.append(section)
    doc["sections"] = out
    return doc


def versions(key):
    if STATE["stage"] != "updated" or key != "s3":
        return {"spaceId": SPACE_ID, "slug": "session-runtime", "key": key, "versions": []}
    return {"spaceId": SPACE_ID, "slug": "session-runtime", "key": key, "versions": [{
        "id": "V1", "reason": {"kind": "chat", "title": "Runner 离线判定的原因"}, "at": stamp(1),
        "replacedBy": {"kind": "job", "jobId": "J1"}, "changed": 1,
        "rows": [{"op": "same", "text": BOARD_A}, {"op": "same", "text": BOARD_B}, {"op": "added", "text": BOARD_NEW},
                 {"op": "same", "text": BOARD_C}]}]}


# ── the chat ─────────────────────────────────────────────────────────────────────────────────────────

WORKSPACE = {"id": "a1", "name": "orbit-develop", "runner": "HPC", "online": True}
CHAT_TITLE = "Runner 离线判定的原因"
USER_WORDS = "这句少了原因：留三次心跳的余量，是为了扛住一次网关重启。"
AGENT_WORDS = "代码里确实是丢三次，但「为什么」库里没有，是少一条决定："


def chats():
    stage = STATE["stage"]
    fab = {"ask": (0, False, 0), "working": (0, True, 0), "card": (1, False, 0), "updated": (0, False, 1),
           "plan": (1, False, 0), "planApplied": (0, False, 0), "planMoved": (0, False, 0), "planUndone": (0, False, 0)}[stage]
    rows = [] if stage == "ask" else [{
        "sessionId": "S1", "title": CHAT_TITLE, "status": "RUNNING" if stage == "working" else "AWAITING_INPUT",
        "open": True, "createdAt": stamp(20), "updatedAt": stamp(2), "drafts": 0 if stage == "working" else 1,
        "needsYou": fab[0]}]
    return {"spaceId": SPACE_ID, "workspace": dict(WORKSPACE, eligible=True), "choices": [WORKSPACE],
            "fab": {"needsYou": fab[0], "working": fab[1], "updated": fab[2]}, "chats": rows}


PLAN_REWRITES = [{"doc": "session-runtime", "key": "s1", "where": "3.1 §1", "title": "总览"},
                 {"doc": "turn-delivery", "key": "s3", "where": "3.3 §1", "title": "turn 投递与 inbox 领取"}]
PLAN_RATIONALE = "3.1 太长：投递与心跳拆成单独一篇，3.1 写给第一次读的人。"


def plan_card():
    """D1 as a plan card of two documents (contract chat.drafts.read, change; C17), in the stage's state."""
    stage = STATE["stage"]
    applied = stage in ("planApplied", "planMoved", "planUndone")
    change = {
        "baseVersion": 1, "version": 2 if applied else None,
        "docs": [
            {"slug": "session-runtime", "title": "会话运行模型与长连接", "number": "3.1", "added": False,
             "category": {"key": "sessions", "title": "会话", "opens": False}, "fields": [],
             "sections": [{"key": "s1", "title": "总览", "number": 1, "edit": "changed", "fields": ["covers"],
                           "covers": "写给第一次读的人：先讲模型，再讲参数。"}]},
            {"slug": "turn-delivery", "title": "turn 投递与心跳", "number": "3.3", "added": True,
             "category": {"key": "sessions", "title": "会话", "opens": False}, "fields": [], "sections": []},
        ],
        "moves": [{"title": "turn 投递与 inbox 领取", "from": {"doc": "session-runtime", "number": "3.1", "key": "s3", "section": 3},
                   "to": {"doc": "turn-delivery", "number": "3.3", "key": "s3", "section": 1}, "fields": [], "covers": None}],
    }
    rewrite = None
    if applied:
        rewrite = {"jobId": "B2", "result": "updated", "reason": None, "sha": "7f3e2a1c9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f",
                   "seen": True, "settledAt": stamp(1),
                   "sections": [{"doc": "session-runtime", "key": "s1", "where": "3.1 §1", "result": "updated", "changed": 1, "versionId": "V9"},
                                {"doc": "turn-delivery", "key": "s3", "where": "3.3 §1", "result": "updated", "changed": 4, "versionId": None}]}
    state = {"plan": "draft", "planApplied": "applied", "planMoved": "applied", "planUndone": "undone"}[stage]
    return {"id": "D1", "sessionId": "S1", "kind": "plan", "state": state, "label": "Plan change", "rationale": PLAN_RATIONALE,
            "ops": [], "sections": PLAN_REWRITES, "rewrites": PLAN_REWRITES, "similar": [], "tainted": False,
            "replaces": None, "replacedBy": None, "decision": "applied" if applied else None,
            "decidedAt": stamp(6) if applied else None, "undoneAt": stamp(1) if stage == "planUndone" else None,
            "undoable": stage == "planApplied", "changesetId": None, "rewrite": rewrite, "change": change, "createdAt": stamp(8)}


def card():
    if STATE["stage"].startswith("plan"):
        return plan_card()
    applied = STATE["stage"] == "updated"
    op = {"seq": 0, "op": "add", "entryId": "E1" if applied else None, "baseRevision": None,
          "payload": {"op": "add",
                      "entry": {"kind": "decision", "title": "Runner 离线判定留三次心跳的余量",
                                "summary": "连续丢三次心跳才判离线，以扛住一次网关重启。",
                                "fields": {"decision": "连续丢三次心跳才判离线。",
                                           "context": "要扛住一次网关重启，一次抖动不该让 Resume 失效。"}},
                      "sources": [{"kind": "turn", "session": "self", "quote": "留三次心跳的余量，是为了扛住一次网关重启"},
                                  {"kind": "commit", "ref": "99cd3c4e1f2a3b4c5d6e7f8091a2b3c4d5e6f708",
                                   "locator": {"path": "runner-presence.ts", "lines": "30–31"}}]},
          "similar": [], "tainted": False, "entry": None, "decision": "accepted" if applied else None}
    rewrite = None
    if applied:
        rewrite = {"jobId": "J1", "result": "updated", "reason": None, "sha": "7f3e2a1c9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f",
                   "seen": False, "settledAt": stamp(1),
                   "sections": [{"doc": "session-runtime", "key": "s3", "where": "3.1 §3", "result": "updated",
                                 "changed": 1, "versionId": "V1"}]}
    return {"id": "D1", "sessionId": "S1", "kind": "entry", "state": "applied" if applied else "draft",
            "label": "Add decision", "rationale": "要扛住一次网关重启，一次抖动不该让 Resume 失效。",
            "ops": [op], "sections": [],
            "rewrites": [{"doc": "session-runtime", "key": "s3", "where": "3.1 §3", "title": "turn 投递与 inbox 领取"},
                         {"doc": "wiki-runtime", "key": "presence", "where": "7.1 §2", "title": None}],
            "similar": [], "tainted": False, "replaces": None, "replacedBy": None,
            "decision": "applied" if applied else None, "decidedAt": stamp(3) if applied else None, "undoneAt": None,
            "undoable": applied, "changesetId": "C1" if applied else None, "rewrite": rewrite, "createdAt": stamp(6)}


DRAFT_ANSWER = {"status": "draft", "draftId": "D1", "replayed": False,
                "ops": [{"seq": 0, "status": "draft", "entryId": None, "similar": []}], "similar": [],
                "rewrites": [{"doc": "session-runtime", "key": "s3", "where": "3.1 §3", "title": "turn 投递与 inbox 领取"},
                             {"doc": "wiki-runtime", "key": "presence", "where": "7.1 §2", "title": None}]}


def events():
    out, seq = [], 0

    def add(typ, payload, minutes):
        nonlocal seq
        seq += 1
        out.append({"seq": seq, "type": typ, "ts": stamp(minutes), "turnId": "t1", "payload": payload})

    add("user", {"text": USER_WORDS}, 8)
    if STATE["stage"] == "working":
        add("assistant", {"text": "先看代码里离线是怎么判的。", "messageId": "m1"}, 7)
        return out
    if STATE["stage"].startswith("plan"):
        answer = {"status": "draft", "draftId": "D1", "kind": "plan", "replayed": False, "rewrites": PLAN_REWRITES}
        add("assistant", {"text": "拆成一张卡：§3 移到新开的一篇，3.1 的总览写给第一次读的人。", "messageId": "m1"}, 7)
        add("tool_use", {"id": "toolu_p", "name": "mcp__orbit__wiki_draft",
                         "input": {"kind": "plan", "reason": PLAN_RATIONALE, "idempotencyKey": "split-17"}}, 6)
        add("tool_result", {"toolUseId": "toolu_p", "content": json.dumps(answer, ensure_ascii=False), "isError": False}, 6)
        add("result", {"subtype": "success", "result": "done"}, 6)
        return out
    add("assistant", {"text": AGENT_WORDS, "messageId": "m1"}, 7)
    add("tool_use", {"id": "toolu_w", "name": "mcp__orbit__wiki_propose",
                     "input": {"ops": [{"op": "add", "entry": {"kind": "decision",
                                                               "title": "Runner 离线判定留三次心跳的余量"}}],
                               "rationale": "代码里确实是丢三次，但「为什么」库里没有，是少一条决定。"}}, 6)
    add("tool_result", {"toolUseId": "toolu_w", "content": json.dumps(DRAFT_ANSWER, ensure_ascii=False),
                        "isError": False}, 6)
    add("result", {"subtype": "success", "result": "done"}, 6)
    return out


def session():
    running = STATE["stage"] == "working"
    return {"id": "S1", "title": CHAT_TITLE, "status": "RUNNING" if running else "AWAITING_INPUT",
            "runStatus": "RUNNING" if running else "AWAITING_INPUT", "runState": "RUNNING" if running else "AWAITING_INPUT",
            "lifecycleState": "OPEN", "agentId": "a1", "agent": {"id": "a1", "name": "orbit-develop"},
            "assignedRunnerId": "hpc", "provider": "claude", "model": "claude-opus-5-5", "effort": "max",
            "permissionMode": "default", "taskId": None, "projectId": None, "createdAt": stamp(20), "updatedAt": stamp(2),
            "lastTurnAt": stamp(6), "lastAssistantText": AGENT_WORDS, "pendingApprovals": 0, "tags": [],
            "folderId": None, "source": "USER"}


# ── the account around it ─────────────────────────────────────────────────────────────────────────────

AGENTS = [{"id": "a1", "name": "orbit-develop", "provider": "claude", "lastProvider": "claude", "runnerId": "hpc",
           "enabled": True, "enableWorktree": True, "effort": "", "workDir": "/root/orbit",
           "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]
CLAUDE_MODELS = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "reasoningLevels": ["low", "medium", "high", "max"]}]


def runner():
    return {"id": "hpc", "name": "HPC", "displayName": "HPC", "hostname": "workstation", "online": True,
            "status": "ONLINE", "version": "0.1.242", "maxConcurrent": 8, "activeSessions": 0,
            "lastHeartbeatAt": stamp(0), "capabilities": [],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}],
            "modelCatalog": {"claude": CLAUDE_MODELS}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


def wiki(rest):
    if rest == []:
        return 200, space()
    if rest == ["docs"]:
        return 200, SHARED["docs"]["directory"]["read"]
    if rest == ["docs", "session-runtime"]:
        return 200, document()
    if len(rest) == 5 and rest[:2] == ["docs", "session-runtime"] and rest[2] == "sections" and rest[4] == "versions":
        return 200, versions(rest[3])
    if len(rest) == 2 and rest[0] == "docs":
        return 404, {"message": "the confirmed plan has no such document"}
    if rest == ["doc-index"]:
        return 200, {"spaceId": SPACE_ID, "plan": SHARED["docs"]["directory"]["read"]["plan"],
                     "items": SHARED["docs"]["index"]["items"]}
    if rest == ["chats"]:
        return 200, chats()
    if rest == ["plan"]:
        return 200, {"spaceId": SPACE_ID, "confirmed": SHARED["plan"]["versions"]["v1"], "draft": None,
                     "proposals": [], "job": SHARED["plan"]["jobs"]["built"]}
    if rest == ["plan", "versions"]:
        return 200, {"spaceId": SPACE_ID, "versions": []}
    if rest == ["articles"]:
        return 200, {"spaceId": SPACE_ID, "categories": [], "uncategorized": []}
    if rest == ["entries"]:
        return 200, []
    if rest == ["timeline"]:
        return 200, {"items": []}
    return 404, {"message": "not in the probe"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        with open(LOG, "a") as f:
            f.write("%s [%s] %s\n" % (datetime.now().strftime("%H:%M:%S.%f")[:-3], STATE["stage"], fmt % args))

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
        with open(LOG, "a") as f:
            f.write("    %s %s body: %s\n" % (self.command, urlparse(self.path).path, raw.decode("utf-8", "replace")))
        return raw

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        parts = [p for p in url.path.split("/") if p]
        has_chat = STATE["stage"] != "ask"
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
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            return self.send(200, [session()] if has_chat and view == "open" else [])
        if len(parts) == 4 and parts[:3] == ["api", "sessions", "S1"] and parts[3] == "events" and has_chat:
            return self.stream(int(query.get("sinceSeq", ["0"])[0] or 0))
        if len(parts) >= 3 and parts[:3] == ["api", "sessions", "S1"] and has_chat:
            rest = parts[3:]
            if rest == []:
                return self.send(200, session())
            if rest == ["events", "page"]:
                return self.send(200, {"events": events(), "hasMore": False, "before": None, "after": None})
            if rest in (["approvals"], ["turns"]):
                return self.send(200, [])
            return self.send(404, {"error": "not in the probe"})
        if parts in (["api", "providers"], ["api", "providers", "mine"], ["api", "providers", "pools"],
                     ["api", "providers", "shared-pools"], ["api", "session-tags"], ["api", "session-folders"],
                     ["api", "task-lists"], ["api", "watches"], ["api", "share-links"], ["api", "projects"],
                     ["api", "workspaces"]):
            return self.send(200, [])
        if parts == ["api", "wiki", "spaces"]:
            return self.send(200, [space()])
        if len(parts) >= 4 and parts[:3] == ["api", "wiki", "spaces"] and parts[3] == SPACE_ID:
            return self.send(*wiki(parts[4:]))
        if parts == ["api", "wiki", "chats", "S1", "drafts"] and has_chat:
            return self.send(200, {"sessionId": "S1", "drafts": [] if STATE["stage"] == "working" else [card()]})
        if parts == ["api", "wiki", "chat-drafts", "D1"] and has_chat:
            return self.send(200, card())
        if parts[:3] == ["api", "wiki", "review"]:
            return self.send(200, [])
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
        """Replay what follows `sinceSeq`, then hold the stream open inside the clients' 45 s watchdog."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        last_ping = time.time()
        try:
            for e in events():
                if e["seq"] > sent:
                    self.wfile.write(("data: %s\n\n" % json.dumps(e, ensure_ascii=False)).encode())
            self.wfile.flush()
            while True:
                if time.time() - last_ping > 10:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_ping = time.time()
                time.sleep(0.5)
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        raw = self.body()
        if parts == ["__reset"]:
            STATE["stage"] = "ask"
            return self.send(200, {"ok": True})
        if parts == ["__set"]:
            try:
                STATE["stage"] = json.loads(raw or b"{}").get("stage", STATE["stage"])
            except ValueError:
                return self.send(400, {"error": "not JSON"})
            return self.send(200, {"stage": STATE["stage"]})
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
    print("stub listening on 127.0.0.1:%d (python %s)" % (PORT, sys.version.split()[0]), flush=True)
    server.serve_forever()
