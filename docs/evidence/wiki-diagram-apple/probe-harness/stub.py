#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the Wiki's document page reads on the iPhone and
# Mac apps, for task 34noHca21KQGtUeAq3gJN. Adapted from docs/evidence/criteria-reply-session-line/probe-harness/stub.py;
# the wiki half is the web's own fixture server (src/web/src/components/WikiDocPage.test.tsx `serve`): one space, its
# directory, plan and index from the shared fixture, and the fixture's document `session-runtime` (docs.doc.read) under
# three slugs, each with one diagram block spliced into its first section after its paragraph — the block's shape in
# the web test's diagram case: {kind: "diagram", text: <source>, sentences: []}.
#
#   diagram-fits    a flowchart narrower than a phone's column, as the apiserver's parseDiagram wrote it out
#   diagram-wide    one wider than any column, the same way
#   diagram-broken  a source Mermaid rejects (the server would drop it): the page must show it as code
#
# Every request is logged; anything not served is a 404, and every write a 409. All data is made up.
import copy
import json
import os
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = json.load(open(os.path.join(HERE, "..", "src", "shared", "src", "wiki-docs.fixture.json"), encoding="utf-8"))
DIAGRAMS = json.load(open(os.path.join(HERE, "diagrams.json"), encoding="utf-8"))
SPACE_ID = "0196f000-0000-7000-8000-000000000001"
SPACE = {"id": SPACE_ID, "slug": "orbit", "title": "orbit", "repoUrlNorm": "github.com/jianghailong-xy/orbit",
         "rootCommitSha": "b" * 40, "settings": {}, "createdAt": "2026-09-01T00:00:00.000Z",
         "updatedAt": "2026-09-01T00:00:00.000Z", "pendingOps": 0}
PLAN = {"spaceId": SPACE_ID, "confirmed": SHARED["plan"]["versions"]["v1"], "draft": None,
        "proposals": SHARED["plan"]["proposals"], "job": SHARED["plan"]["jobs"]["built"]}


def with_diagram(source):
    """The fixture's document with one diagram block after its first section's paragraph."""
    doc = copy.deepcopy(SHARED["docs"]["doc"]["read"])
    doc["sections"][0]["blocks"].insert(1, {"kind": "diagram", "text": source, "sentences": []})
    return doc


DOCS = {"diagram-%s" % name: with_diagram(source) for name, source in DIAGRAMS.items()}


def now():
    t = datetime.now(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


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


def wiki(rest):
    """The web test's `serve`, for the one space: (status, body)."""
    if rest == []:
        return 200, SPACE
    if rest == ["docs"]:
        return 200, SHARED["docs"]["directory"]["read"]
    if len(rest) == 2 and rest[0] == "docs":
        if rest[1] in DOCS:
            return 200, DOCS[rest[1]]
        return 404, {"message": "the confirmed plan has no such document"}
    if rest == ["doc-index"]:
        return 200, {"spaceId": SPACE_ID, "plan": SHARED["docs"]["directory"]["read"]["plan"],
                     "items": SHARED["docs"]["index"]["items"]}
    if rest == ["plan"]:
        return 200, PLAN
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
        with open(LOG, "a") as f:
            f.write("    %s %s body: %s\n" % (self.command, urlparse(self.path).path, raw.decode("utf-8", "replace")))

    def do_GET(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
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
        if parts == ["api", "wiki", "spaces"]:
            return self.send(200, [SPACE])
        if len(parts) >= 4 and parts[:3] == ["api", "wiki", "spaces"] and parts[3] == SPACE_ID:
            return self.send(*wiki(parts[4:]))
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

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        self.body()
        if parts == ["__reset"]:
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
    print("stub listening on 127.0.0.1:%d (python %s), serving %s" % (PORT, sys.version.split()[0], ", ".join(sorted(DOCS))),
          flush=True)
    server.serve_forever()
