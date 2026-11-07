#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged), task 34tDf8rxHzhwoGyK6r0kj: the slice of the Orbit API that Wiki Review and
# an entry's page read on the iPhone and Mac apps, answered from what a real apiserver built from this tree answered
# (data/, recorded 2026-11-07): one space, one changeset with four pending `challenge` ops, the four entries they name.
# Adapted from docs/evidence/wiki-diagram-apple/probe-harness/stub.py.
#
# Stateful the way the server was: POST /api/wiki/changesets/:id/decide takes the op out of `pending` — Keep
# (`reconfirm`) records it `accepted` and clears the entry's `challenged`; Retire retires the entry (status, validTo,
# retiredAt) with the decision's `note` as its reason, and records the op `withdrawn`
# (data/decide-reconfirm.json, data/decide-retire.json, data/api-after-two/) — and answers
# with the changeset as it now stands, in the decide answer's shape (its ops carry no `entryTitle`). The next reads
# (GET /wiki/review, /wiki/spaces' pendingOps, /wiki/entries/:id, the space's entries) show it decided.
#
# Every request is logged with the host clock (wall time and epoch ms); anything not served is a 404, and any other
# write a 409. POST /__reset puts everything back as recorded.
import copy
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
HERE = os.path.dirname(os.path.abspath(__file__))
BEFORE = os.path.join(HERE, "data", "api-before")
LOCK = threading.Lock()


def load(name):
    with open(os.path.join(BEFORE, name), encoding="utf-8") as f:
        return json.load(f)


IDS = load("ids.json")
SPACE_ID = IDS["spaceId"]
# The entries' ids in this data, each read from the file recorded under its production id.
ENTRY_FILES = {data_id: "wiki-entry-%s.json" % prod for prod, data_id in IDS["entryIds"].items()}


def recorded():
    return {
        "me": load("users-me.json"),
        "spaces": load("wiki-spaces.json"),
        "space": load("wiki-space.json"),
        "list": load("wiki-space-entries.json"),
        "review": load("wiki-review.json"),
        "entries": {data_id: load(name) for data_id, name in ENTRY_FILES.items()},
    }


STATE = recorded()
# The retirements a challenge's Retire wrote, with the reason the server would record for each.
RETIREMENTS = []


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def now():
    return iso(datetime.now(timezone.utc))


def same(one, key):
    return key is not None and key in (one.get("id"), one.get("publicId"))


AGENTS = [{"id": "a1", "name": "orbit-develop", "provider": "claude", "lastProvider": "claude", "runnerId": "hpc",
           "enabled": True, "enableWorktree": False, "effort": "", "workDir": "/root/orbit",
           "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}]
CLAUDE_MODELS = [{"value": "claude-opus-5-5", "label": "Opus 5.5", "reasoningLevels": ["low", "medium", "high", "max"]}]


def runner():
    return {"id": "hpc", "name": "HPC", "displayName": "HPC", "hostname": "workstation", "online": True,
            "status": "ONLINE", "version": "0.1.242", "maxConcurrent": 8, "activeSessions": 0,
            "lastHeartbeatAt": now(), "capabilities": [],
            "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}],
            "modelCatalog": {"claude": CLAUDE_MODELS}, "runtimeDefaultModels": {"claude": "claude-opus-5-5"}}


# MARK: the wiki, as recorded and as the decisions so far left it

def pending_ops():
    return sum(1 for cs in STATE["review"] for op in cs.get("ops", []) if op.get("decision") == "pending")


def review():
    """GET /wiki/review: the changesets with an op still waiting; their decided ops ride along."""
    return [cs for cs in STATE["review"] if any(op.get("decision") == "pending" for op in cs.get("ops", []))]


def spaces():
    out = copy.deepcopy(STATE["spaces"])
    for space in out:
        if same(space, SPACE_ID):
            space["pendingOps"] = pending_ops()
    return out


def entry_changed(entry_id, **fields):
    """The same change on the entry's own read and on its row in the space's list."""
    for key, entry in STATE["entries"].items():
        if same(entry, entry_id) or key == entry_id:
            entry.update(fields)
    for row in STATE["list"]:
        if same(row, entry_id):
            row.update(fields)


def decide(changeset_id, body):
    """POST /wiki/changesets/:id/decide, as the recorded answers show the server doing it."""
    changeset = next((cs for cs in STATE["review"] if same(cs, changeset_id)), None)
    if changeset is None:
        return 404, {"statusCode": 404, "message": "no such changeset in the probe"}
    for decision in body.get("decisions", []):
        op = next((one for one in changeset.get("ops", []) if same(one, decision.get("opId"))), None)
        if op is None:
            return 400, {"statusCode": 400, "message": "no such op in the changeset"}
        action = decision.get("action")
        at = datetime.now(timezone.utc)
        if action == "reconfirm":
            op["decision"] = "accepted"
            op["decidedAt"] = iso(at)
            entry_changed(op["entryId"], challenged=False)
        elif action == "retire":
            # The server retires the entry through the owner's own write, its reason the decision's note (or, with
            # none, "Retired in answer to a challenge: <the challenge's reason>"), and the retire withdraws the
            # challenge, whose own decisionNote stays null (wiki.service.ts answerChallenge).
            note = (decision.get("note") or "").strip()
            reason = note or "Retired in answer to a challenge: %s" % ((op.get("payload") or {}).get("reason") or "")
            RETIREMENTS.append({"entryId": op["entryId"], "reason": reason, "at": iso(at)})
            with open(LOG, "a") as f:
                f.write("    [%d] stub: retired %s, reason: %s\n" % (int(time.time() * 1000), op["entryId"], reason))
            entry_changed(op["entryId"], status="retired", challenged=False, validTo=iso(at), retiredAt=iso(at))
            op["decision"] = "withdrawn"
            op["decisionNote"] = None
            op["decidedAt"] = iso(at + timedelta(milliseconds=1))
        else:
            return 409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                         "message": "the probe answers Re-confirm and Retire only"}
    answer = copy.deepcopy(changeset)
    for op in answer.get("ops", []):
        op.pop("entryTitle", None)
    return 200, answer


def entries_of_space(query):
    rows = STATE["list"]
    kind = (query.get("kind") or [None])[0]
    if kind:
        rows = [row for row in rows if row.get("kind") == kind]
    return rows


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        stamp = time.time()
        with open(LOG, "a") as f:
            f.write("%s [%d] %s\n" % (datetime.fromtimestamp(stamp).strftime("%H:%M:%S.%f")[:-3], int(stamp * 1000),
                                     fmt % args))

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
        stamp = time.time()
        with open(LOG, "a") as f:
            f.write("    [%d] %s %s body: %s\n" % (int(stamp * 1000), self.command, urlparse(self.path).path,
                                                  raw.decode("utf-8", "replace")))
        return raw

    def do_GET(self):
        url = urlparse(self.path)
        parts = [p for p in url.path.split("/") if p]
        query = parse_qs(url.query)
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
                     ["api", "task-lists"], ["api", "watches"], ["api", "share-links"], ["api", "projects"],
                     ["api", "sessions"], ["api", "workspaces"]):
            return self.send(200, [])
        with LOCK:
            if parts == ["api", "users", "me"]:
                return self.send(200, STATE["me"])
            if parts == ["api", "wiki", "spaces"]:
                return self.send(200, spaces())
            if parts == ["api", "wiki", "review"]:
                return self.send(200, review())
            if len(parts) == 4 and parts[:3] == ["api", "wiki", "entries"]:
                entry = STATE["entries"].get(parts[3]) or next(
                    (one for one in STATE["entries"].values() if same(one, parts[3])), None)
                if entry is None:
                    return self.send(404, {"statusCode": 404, "message": "no such entry in the probe"})
                return self.send(200, entry)
            if len(parts) >= 4 and parts[:3] == ["api", "wiki", "spaces"] and parts[3] == SPACE_ID:
                if len(parts) == 4:
                    return self.send(200, STATE["space"])
                if parts[4:] == ["entries"]:
                    return self.send(200, entries_of_space(query))
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

    def do_POST(self):
        global STATE
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        raw = self.body()
        with LOCK:
            if parts == ["__reset"]:
                STATE = recorded()
                RETIREMENTS.clear()
                return self.send(200, {"ok": True})
            if len(parts) == 5 and parts[:3] == ["api", "wiki", "changesets"] and parts[4] == "decide":
                try:
                    body = json.loads(raw or b"{}")
                except ValueError:
                    return self.send(400, {"statusCode": 400, "message": "not JSON"})
                return self.send(*decide(parts[3], body))
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
    print("stub listening on 127.0.0.1:%d (python %s): space %s, %d pending ops" % (
        PORT, sys.version.split()[0], SPACE_ID, pending_ops()), flush=True)
    server.serve_forever()
