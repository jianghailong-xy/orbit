#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API one live turn needs in the
# native clients — a workspace on one runner and session S1, whose transcript holds six settled
# rounds (long enough to scroll, pinned at its tail) and then ONE LIVE TURN the test drives step by
# step over /__step: three stretches of thinking that each fold to their one-line summary, two tool
# calls between them the way src/runner-go/kimi_stream_order_session_test.go interleaves them
# (thinking persists BEFORE tool_use), and a final reply. The fold's geometry is logged per frame
# by diag.py's instrumentation and photographed by FoldShotTests. Agents, runners and providers
# are the DeepSeek Harness probe's (docs/evidence/deepseek-harness/p5/probe-harness/stub.py).
# Every request is logged; anything not served is a 404. All data is made up.
import json
import os
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
METRICS = os.path.join(os.path.dirname(os.path.abspath(LOG)), "metrics.log")

LOCK = threading.Lock()
CLIENTS = []          # connected SSE streams (wfile objects), guarded by LOCK
DURABLE = []          # every durable event so far (history + stepped), seq ascending
HISTORY_SEQ = 0       # the seq the history ends at; steps continue from here


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def stamp():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


PRO = '["deepseek", "deepseek-v4-pro"]'
FLASH = '["deepseek", "deepseek-v4-flash"]'
DSH_CATALOG = [
    {"value": PRO, "label": "DeepSeek V4 Pro", "reasoningLevels": ["off", "low", "high", "max"],
     "defaultReasoningLevel": "max"},
    {"value": FLASH, "label": "DeepSeek V4 Flash", "reasoningLevels": ["off", "high"]},
]
CLAUDE_CATALOG = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "contextWindow": 1000000,
                   "reasoningLevels": ["low", "medium", "high", "max"]}]


def runner(rid, name):
    # Stamped per request: the clients call a machine offline once its heartbeat is 90 s old.
    return {"id": rid, "name": name, "displayName": name, "online": True, "status": "ONLINE",
            "version": "0.1.226", "maxConcurrent": 4, "lastHeartbeatAt": ago(0),
            "capabilities": ["provider:dsh", "provider:antigravity"],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"},
                        {"engine": "dsh", "installed": True, "auth": "unknown", "version": "0.2.0-rc.2",
                         "dsh": {"versionCompatible": True, "credentialPresent": False,
                                 "modelCatalogReadable": True, "requestValidation": "unknown",
                                 "sandboxEnforcement": "unknown"}}],
            "modelCatalog": {"claude": CLAUDE_CATALOG, "dsh": DSH_CATALOG},
            "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


def agents():
    return [{"id": "a1", "name": "orbit", "provider": "deepseek-harness", "lastProvider": "deepseek-harness",
             "runnerId": "r1", "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/srv/orbit",
             "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]


HARNESS = {"providerID": "p-dsh", "id": "p-dsh", "slug": "deepseek-harness", "label": "DeepSeek Harness",
           "runtime": "dsh", "models": [], "defaultModel": None, "presetSlug": "deepseek-harness",
           "modelsFromRuntime": True, "enabled": True}
DEEPSEEK = {"providerID": "p-ds", "id": "p-ds", "slug": "deepseek", "label": "DeepSeek", "runtime": "claude",
            "models": [{"value": "deepseek-v4-pro", "label": "DeepSeek V4 Pro", "contextWindow": 1000000}],
            "defaultModel": "deepseek-v4-pro", "presetSlug": "deepseek", "enabled": True}

# Six settled rounds, long enough that the transcript scrolls on an iPhone and in a Mac window.
# The last line is what the tests wait for on open.
ROUNDS = [
    ("帮我看一下 release notes 草稿，哪些段落可以合并？",
     "我读了一遍草稿，一共 7 段。第 2 段和第 5 段都在讲输入框的改动，可以合成一段；第 6 段只有一句"
     "「修了若干问题」，建议删掉，或者换成具体的条目。\n\n合并之后的顺序建议是：新功能 → 体验改进 → 修复 → "
     "已知问题。这样读者先看到最想看的部分。"),
    ("按这个顺序改，修复部分列成条目",
     "改好了。修复部分现在是 4 条：\n\n1. 会话列表在切换工作区后不再停在旧位置。\n2. 附件上传失败时会保留草稿。\n"
     "3. 深色模式下代码块的边框颜色和正文一致了。\n4. 长消息折叠后再展开不会跳动。\n\n已知问题单独放在最后，只留了"
     "一条：旧版本的 runner 不会显示新的用量环。"),
    ("第 3 条说得太技术了，换个说法",
     "换成了：「深色模式下，代码块不再带一圈突兀的亮边。」读者不需要知道是边框颜色的问题，只要知道看起来顺眼了。"
     "\n\n其他三条我也顺手读了一遍，措辞都是用户能看到的现象，没有再改。"),
    ("开头加一句总结，不超过 30 个字",
     "加在最上面了：「这一版主要让输入框和长对话读起来更顺。」一共 19 个字。\n\n如果想更具体，也可以写成"
     "「输入框重做，长对话滚动更稳，修了 4 个问题」，信息多一些，但读起来像清单。我倾向第一种。"),
    ("用第一种。再检查一遍有没有错别字",
     "检查完了，改了两处：「其它」统一成「其他」，「登陆」改成「登录」。标点也过了一遍，中英文之间都留了空格，"
     "数字和单位之间没有空格。\n\n全文现在 412 个字，比原稿少了 96 个字。"),
    ("好，导出一份给我",
     "导出好了，在 docs/release-notes.md。要我顺便生成一份英文版吗？英文版会按同样的顺序，条目一一对应。"),
]
TAIL = ROUNDS[-1][1]

# The live turn the test steps through. Three thinking stretches, each long enough to fill the
# 160pt streaming box to its cap before it folds (14 lines ≈ 210pt of aside prose). Tool calls
# carry results the way the kimi order test interleaves them: the stretch's durable `thinking`
# lands BEFORE its tool_use, so each fold happens at the tail row with the tool card appended
# right behind it. Fold 1 takes the same-publish variant (tool card in the same step, merged by
# the client's 200ms publish coalescing); folds 2 and 3 publish alone, fold 3 with the reply
# arriving only afterwards — the turn-end resting state the symptom was reported on.
ASK7 = "再核对一遍第 12 周的转化率，顺便把表格的小数位统一一下"

THINK = {
    1: ["先看 metrics 文件里第 12 周的数据在哪一段。",
        "找到了，周报表格在 docs/metrics.md 的第 8 到 21 行。",
        "第 12 周的转化率写在第 12 行，是 4.1%。",
        "第 11 周是 3.8%，第 13 周是 4.4%，先记住这三个数。",
        "再看上周的周报是不是已经写过这个数字。",
        "上周写的是 4.1%，和这里一致，没有出入。",
        "表格里小数位数不统一：有的两位，有的三位。",
        "按读者的习惯，转化率统一保留一位小数。",
        "那么 4.10% 写成 4.1%，3.83% 写成 3.8%。",
        "改之前先读一下文件确认行号没有看错。",
        "行号没错，第 12 行就是第 12 周。",
        "还需要确认「转化率」这一列的定义没有变。",
        "表头注释说分母是活跃会话数，和上周一致。",
        "可以动手改了：先读文件，再统一小数位。"],
    2: ["上一处改完了，现在检查转换率的定义有没有过期。",
        "注释写的是活跃会话数，口径没变。",
        "再 grep 一遍别的地方有没有引用第 12 周这个数字。",
        "release notes 里引了，写的是 4.1%，口径一致。",
        "汇报邮件的草稿也引了，同样是一位小数。",
        "那格式统一的工作只剩表格本身。",
        "再看表格的表头排序，周数是升序排列。",
        "升序没问题，不需要动。",
        "小数位统一后，表格里共 6 个数字要四舍五入。",
        "四舍五入到一位：3.83→3.8，4.10→4.1，2.75→2.8。",
        "其余三个本来就是一位，保持不变。",
        "改动前先想好验证方式：改完重读一遍。",
        "grep 确认没有遗漏的两位小数。",
        "范围清楚了，再跑一次 grep 收尾。"],
    3: ["最后把回复整理成读者能直接用的几句话。",
        "结论一：第 12 周转化率 4.1%，与上周持平。",
        "结论二：全表小数位已统一为一位。",
        "结论三：口径没有变化，分母仍是活跃会话数。",
        "风险提示：第 13 周的数字是 4.4%，环比仍在上行。",
        "邮件草稿里的引用不用改，已经是一位小数。",
        "release notes 也不用改。",
        "需要改的只剩表格里那两个两位小数。",
        "改法：直接编辑 metrics.md 的第 12 和 19 行。",
        "改完重读，确认渲染出来的表格对齐。",
        "如果渲染正常，这一轮的核对就完成了。",
        "再检查一遍有没有错别字。",
        "没有。整理回复。",
        "回复就写三句话，附一个改动清单。"],
}
THINK_MS = {1: 3400, 2: 2800, 3: 4100}
REPLY = "核对完了：第 12 周的转化率是 4.1%，和上周持平。表格的小数位数已经统一为一位，改了第 12 和 19 行两处；口径没有变化，分母仍是活跃会话数。"

S1_STATE = {}


def reset():
    """Rebuild the fixture: history only, no live turn, session back to idle."""
    global DURABLE, HISTORY_SEQ
    with LOCK:
        DURABLE = []
        seq = 0

        def durable_now(typ, turn, payload):
            nonlocal seq
            seq += 1
            DURABLE.append({"seq": seq, "type": typ, "ts": stamp(), "turnId": turn,
                            "payload": payload})

        for i, (ask, answer) in enumerate(ROUNDS):
            turn = "t%d" % (i + 1)
            durable_now("user", turn, {"text": ask})
            if i == len(ROUNDS) - 1:
                durable_now("tool_use", turn,
                            {"toolUseId": "c1", "name": "write_file", "kind": "edit", "status": "pending",
                             "input": {"path": "docs/release-notes.md", "content": "# Release notes\n"}})
                durable_now("tool_result", turn,
                            {"toolUseId": "c1", "status": "completed", "isError": False,
                             "content": "Wrote docs/release-notes.md (1.2 KB)"})
            durable_now("assistant", turn, {"text": answer, "messageId": "m%d" % (i + 1)})
            durable_now("result", turn, {"subtype": "success", "status": "AWAITING_INPUT"})
        HISTORY_SEQ = seq
    S1_STATE.clear()
    S1_STATE.update({"status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
                     "runState": "AWAITING_INPUT", "lastAssistantText": TAIL})


def next_seq():
    with LOCK:
        seq = (DURABLE[-1]["seq"] if DURABLE else 0) + 1
    return seq


def durable(typ, turn, payload):
    ev = {"seq": next_seq(), "type": typ, "ts": stamp(), "turnId": turn, "payload": payload}
    with LOCK:
        DURABLE.append(ev)
    broadcast(ev)   # the live stream carries the durable events too, as the real server's does
    return ev


def broadcast(ev):
    """A live-only event: written to whoever is connected right now, never replayed or paged."""
    line = ("data: %s\n\n" % json.dumps(ev, ensure_ascii=False)).encode()
    with LOCK:
        dead = []
        for c in CLIENTS:
            try:
                c.write(line)
                c.flush()
            except (BrokenPipeError, ConnectionResetError):
                dead.append(c)
        for c in dead:
            CLIENTS.remove(c)


def live(typ, turn, payload):
    broadcast({"seq": 0, "type": typ, "ts": stamp(), "turnId": turn, "payload": payload})


def tool_call(tid, name, inp, result):
    durable("tool_use", "t7", {"toolUseId": tid, "name": name, "status": "pending", "input": inp})
    time.sleep(0.6)             # the call runs a moment before its result lands
    durable("tool_result", "t7", {"toolUseId": tid, "status": "completed", "isError": False,
                                  "content": result})


# --- the stepped scenario -------------------------------------------------

def step_turn():
    durable("user", "t7", {"text": ASK7})
    durable("status", None, {"status": "RUNNING"})
    S1_STATE.update({"status": "RUNNING", "runStatus": "RUNNING", "runState": "RUNNING"})


def step_think(n):
    for line in THINK[n]:
        live("thinking_delta", "t7", {"delta": line})
        time.sleep(0.06)


def step_fold(n):
    durable("thinking", "t7", {"text": "".join(THINK[n]), "thinkingMs": THINK_MS[n]})
    if n == 1:
        # The same-publish variant: the tool card lands in the same 200ms window as the fold, the
        # composition the task calls suspect (b).
        tool_call("tc1", "read_file", {"path": "docs/metrics.md"},
                  "Read docs/metrics.md (4.1 KB)")


def step_tool2():
    tool_call("tc2", "grep", {"pattern": "conversion", "path": "docs"},
              "docs/metrics.md:12: conversion 4.1%\ndocs/metrics.md:19: conversion 3.8%")


def step_reply():
    cut = [REPLY[:28], REPLY[28:64], REPLY[64:]]
    for d in cut:
        live("text_delta", "t7", {"delta": d})
        time.sleep(0.08)
    durable("assistant", "t7", {"text": REPLY, "messageId": "m7"})
    S1_STATE["lastAssistantText"] = REPLY


def step_end():
    durable("turn_end", "t7", {"subtype": "success", "status": "AWAITING_INPUT"})
    S1_STATE.update({"status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
                     "runState": "AWAITING_INPUT"})


STEPS = {"turn": step_turn,
         "think1": lambda: step_think(1), "fold1": lambda: step_fold(1),
         "think2": lambda: step_think(2), "fold2": lambda: step_fold(2),
         "tool2": step_tool2,
         "think3": lambda: step_think(3), "fold3": lambda: step_fold(3),
         "reply": step_reply, "end": step_end}


def s1():
    return {"id": "S1", "title": "整理 release notes", "status": S1_STATE["status"],
            "runStatus": S1_STATE["runStatus"], "runState": S1_STATE["runState"],
            "lifecycleState": "OPEN", "agentId": "a1",
            "agent": {"id": "a1", "name": "a1"}, "assignedRunnerId": "r1", "provider": "deepseek-harness",
            "model": PRO, "effort": "high", "permissionMode": "default", "taskId": None, "projectId": None,
            "createdAt": ago(20), "updatedAt": ago(0), "lastTurnAt": ago(0),
            "lastAssistantText": S1_STATE["lastAssistantText"],
            "pendingApprovals": 0, "tags": [], "folderId": None, "source": "USER"}


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

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        parts = [p for p in url.path.split("/") if p]
        if parts == ["__log"]:
            try:
                with open(LOG) as f:
                    return self.send(200, {"log": f.read()})
            except OSError:
                return self.send(200, {"log": ""})
        if parts == ["api", "agents"]:
            return self.send(200, agents())
        if len(parts) == 3 and parts[:2] == ["api", "agents"]:
            found = [a for a in agents() if a["id"] == parts[2]]
            return self.send(200, found[0]) if found else self.send(404, {"error": "no agent"})
        if parts == ["api", "runners"]:
            return self.send(200, [runner("r1", "hpc")])
        if len(parts) == 3 and parts[:2] == ["api", "runners"]:
            return self.send(200, runner("r1", "hpc")) if parts[2] == "r1" else self.send(404, {"error": "no runner"})
        if parts in (["api", "providers"], ["api", "providers", "mine"]):
            return self.send(200, [HARNESS, DEEPSEEK])
        if parts in (["api", "providers", "pools"], ["api", "providers", "shared-pools"],
                     ["api", "session-tags"], ["api", "session-folders"], ["api", "task-lists"],
                     ["api", "watches"], ["api", "share-links"]):
            return self.send(200, [])
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            return self.send(200, [s1()] if view == "open" else [])
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "events":
            return self.stream(parts[2], int(query.get("sinceSeq", ["0"])[0] or 0))
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            sid, rest = parts[2], parts[3:]
            if sid != "S1":
                return self.send(404, {"error": "not in the probe"})
            if rest == []:
                return self.send(200, s1())
            if rest == ["events", "page"]:
                with LOCK:
                    page = list(DURABLE)
                return self.send(200, {"events": page, "hasMore": False, "before": None, "after": None})
            if rest in (["approvals"], ["turns"]):
                return self.send(200, [])
            if rest == ["share"]:
                return self.send(200, {"link": None, "counts": {"messages": 14, "toolCalls": 3}})
            return self.send(404, {"error": "not in the probe"})
        return self.send(404, {"error": "not in the probe"})

    def stream(self, sid, since):
        """Replay the durable events past `since` (the server's own framing), then hold the stream
        open: every /__step broadcast lands here, plus a keepalive inside the clients' 45 s
        watchdog. Deltas are never replayed — a reconnect heals from the durable events alone."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        with LOCK:
            replay = [e for e in DURABLE if e["seq"] > since]
        try:
            for e in replay:
                self.wfile.write(("data: %s\n\n" % json.dumps(e, ensure_ascii=False)).encode())
            self.wfile.flush()
            with LOCK:
                CLIENTS.append(self.wfile)
            last_ping = time.time()
            while True:
                if time.time() - last_ping > 10:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_ping = time.time()
                time.sleep(0.5)
        except (BrokenPipeError, ConnectionResetError):
            return
        finally:
            with LOCK:
                if self.wfile in CLIENTS:
                    CLIENTS.remove(self.wfile)

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode("utf-8", "replace") if n else ""
        if parts in (["__metrics"], ["__mark"], ["__scroll"]):
            with open(METRICS, "a") as f:
                f.write("%s %s %s\n" % (datetime.now().strftime("%H:%M:%S.%f")[:-3], parts[0][2:], body))
            return self.send(200, {"ok": True})
        if parts == ["__reset"]:
            reset()
            return self.send(200, {"ok": True})
        if parts == ["__step"]:
            fn = STEPS.get(body.strip())
            if fn is None:
                return self.send(404, {"error": "no such step: %r" % body})
            fn()
            return self.send(200, {"ok": True, "historySeq": HISTORY_SEQ,
                                   "maxSeq": DURABLE[-1]["seq"] if DURABLE else 0})
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    def do_PATCH(self):
        return self.send(404, {"error": "not in the probe"})

    def do_PUT(self):
        return self.send(404, {"error": "not in the probe"})

    def do_DELETE(self):
        return self.send(404, {"error": "not in the probe"})


reset()

if __name__ == "__main__":
    class LoopbackServer(ThreadingHTTPServer):
        # HTTPServer.server_bind resolves its own name (socket.getfqdn), a reverse lookup that on
        # macOS raises the "find devices on local networks" prompt over the app being photographed.
        def server_bind(self):
            import socketserver
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "localhost", self.server_address[1]

    server = LoopbackServer(("127.0.0.1", PORT), Handler)
    print("stub listening on 127.0.0.1:%d (python %s)" % (PORT, sys.version.split()[0]), flush=True)
    server.serve_forever()
