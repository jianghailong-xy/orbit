#!/usr/bin/env python3
"""TEMPORARY evidence probe: the owner's share-link routes the Share panel reads and writes
(docs/share-links-design.md §5), answered for the roots the probes open:

  GET | PUT | DELETE /api/{sessions|tasks|projects}/:id/share

The project and its counts are the ones docs/mocks/share-links/07-mobile ③ draws (12 tasks,
29 comments, 13 runs and the coordinator, viewed 14 times, last 2h ago), so the capture can sit
beside the mock. The task's link expires in a week; session `live` is shared, session `new` is not.
"""
import datetime
import json
import socketserver
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KINDS = {"sessions": "SESSION", "tasks": "TASK", "projects": "PROJECT"}
DEFAULTS = {
    "SESSION": {"toolOutput": True},
    "TASK": {"commentsAndFiles": False, "conversations": False, "toolOutput": True},
    "PROJECT": {"taskPages": True, "commentsAndFiles": False, "conversations": False, "toolOutput": True},
}


def iso(seconds_from_now):
    t = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=seconds_from_now)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


ROOTS = {
    ("projects", "34UonbgOiq9ajX8aH3JPz"): {
        "title": "Claude 账号池：按订阅配额均衡派发", "status": "OPEN",
        "counts": {"tasks": 12, "comments": 29, "files": 0, "runs": 13, "transcripts": 14},
        "link": {"token": "Qm4kT9vR2mT7wLp4sYb8nZc1eHf6uJaB",
                 "include": {"taskPages": True, "commentsAndFiles": False, "conversations": False,
                             "toolOutput": True},
                 "viewCount": 14, "lastViewedAt": -2 * 3600, "expiresAt": None},
    },
    ("tasks", "34UozoiaJIsxCZj728bfe"): {
        "title": "T6 安全边界：跨 owner、准入与凭据不外泄的回归断言", "status": "DONE",
        "counts": {"comments": 3, "files": 1, "transcripts": 2},
        "link": {"token": "Hs2Lq8Vn0bXw3tPz6KcR1mY7uDe4JfAa",
                 "include": {"commentsAndFiles": True, "conversations": False, "toolOutput": True},
                 "viewCount": 3, "lastViewedAt": -12 * 60, "expiresAt": 7 * 86400},
    },
    ("sessions", "live"): {
        "title": "Share links · T8", "status": "COMPLETED",
        "counts": {"messages": 77, "toolCalls": 120},
        "link": {"token": "Zp3nW8qL1vR6tY0bXc4mKd7sEf2gHj5A", "include": {"toolOutput": True},
                 "viewCount": 1, "lastViewedAt": -40 * 60, "expiresAt": None},
    },
    ("sessions", "new"): {
        "title": "Share links · T8", "status": "COMPLETED",
        "counts": {"messages": 12, "toolCalls": 9},
        "link": None,
    },
}
FRESH_TOKEN = "Nw7cB2xK9pQ4rT1vM6zL3sH8dF5gJ0aE"


def link_json(segment, root_id, root):
    link = root["link"]
    if link is None:
        return None
    rel = lambda v: None if v is None else iso(v)
    return {
        "id": f"L-{root_id}", "kind": KINDS[segment], "token": link["token"], "include": link["include"],
        "expiresAt": rel(link["expiresAt"]), "revokedAt": None, "viewCount": link["viewCount"],
        "lastViewedAt": rel(link["lastViewedAt"]), "createdAt": iso(-3 * 86400), "updatedAt": iso(-60),
        "state": "ACTIVE", "stateReason": None,
        "root": {"id": root_id, "title": root["title"], "status": root["status"]},
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body=None):
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _root(self):
        parts = self.path.split("?")[0].strip("/").split("/")
        if len(parts) == 4 and parts[0] == "api" and parts[1] in KINDS and parts[3] == "share":
            key = (parts[1], parts[2])
            if key in ROOTS:
                return parts[1], parts[2], ROOTS[key]
        return None

    def do_GET(self):
        found = self._root()
        if not found:
            return self._send(404, {"message": "not found"})
        segment, root_id, root = found
        self._send(200, {"link": link_json(segment, root_id, root), "counts": root["counts"]})

    def do_PUT(self):
        found = self._root()
        if not found:
            return self._send(404, {"message": "not found"})
        segment, root_id, root = found
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if root["link"] is None:
            root["link"] = {"token": FRESH_TOKEN, "include": dict(DEFAULTS[KINDS[segment]]),
                            "viewCount": 0, "lastViewedAt": None, "expiresAt": None}
        link = root["link"]
        link["include"].update(body.get("include") or {})
        if "expiresAt" in body:
            at = body["expiresAt"]
            link["expiresAt"] = None if at is None else (
                datetime.datetime.fromisoformat(at.replace("Z", "+00:00"))
                - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
        self._send(200, link_json(segment, root_id, root))

    def do_DELETE(self):
        found = self._root()
        if not found:
            return self._send(404, {"message": "not found"})
        found[2]["link"] = None
        self._send(200)

    def log_message(self, fmt, *args):
        print("stub:", self.command, self.path, flush=True)


class Server(ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer.server_bind asks getfqdn() for a name, which on macOS goes looking on the local
        # network and puts a privacy alert over the window being photographed. A name isn't needed.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "127.0.0.1", self.server_address[1]


if __name__ == "__main__":
    Server(("127.0.0.1", 8787), Handler).serve_forever()
