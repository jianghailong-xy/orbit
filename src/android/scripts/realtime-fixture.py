"""Loopback-only controlled REST/SSE server for the A04 device probe. No production accounts."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


def event(seq, text):
    return {"seq": seq, "type": "assistant", "payload": {"text": text}}


class Fixture:
    def __init__(self):
        self.condition = threading.Condition()
        self.rows = [event(1, "你好，缓存中的会话"), event(2, "initial reply")]
        self.pending = True
        self.control = []
        self.live = []
        self.generation = 0
        self.stats = {"controlConnections": 0, "sessionConnections": 0, "activeControl": 0,
                      "activeSession": 0, "sinceSeqs": [], "reads": [], "errors": []}

    def advance(self, seq, text):
        with self.condition:
            row = event(seq, text)
            self.rows.append(row)
            self.live.append(row)
            self.pending = False
            self.control.append({"type": "session.updated", "sessionId": "s1", "data": {}})
            self.live.append({"type": "queued_turns_changed", "seq": 0, "payload": {}})
            self.condition.notify_all()

    def drop(self):
        with self.condition:
            self.generation += 1
            self.condition.notify_all()

    def resync(self):
        with self.condition:
            self.rows = [event(seq, f"tail {seq}") for seq in range(1001, 1211)]
            self.live.append({"seq": 0, "type": "resync", "payload": {}})
            self.condition.notify_all()

    def server(self):
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass  # Headers/bodies (especially fixture credentials) never go into logs.

            def respond(self, value, status=200):
                body = json.dumps(value, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if self.path == "/api/auth/login":
                    self.respond({"accessToken": "a04-fixture-access", "refreshToken": "a04-fixture-refresh",
                                  "user": {"id": "u1", "email": "realtime@example.test", "name": "Fixture"}})
                elif self.path == "/api/auth/logout":
                    self.respond({})
                else:
                    self.respond({}, 404)

            def do_GET(self):
                parsed = urlparse(self.path)
                query = parse_qs(parsed.query)
                path = parsed.path.removeprefix("/api/")
                if self.headers.get("Authorization") != "Bearer a04-fixture-access":
                    fixture.stats["errors"].append("missing bearer")
                    return self.respond({}, 401)
                if not self.headers.get("X-Orbit-Client", "").startswith("android/"):
                    fixture.stats["errors"].append("missing client identity")
                    return self.respond({}, 400)
                if path in ("events", "sessions/s1/events"):
                    return self.stream(path == "events", int(query.get("sinceSeq", [0])[0]))
                with fixture.condition:
                    fixture.stats["reads"].append(path)
                    pending = fixture.pending
                    rows = list(fixture.rows)
                if path in ("workspaces", "runners", "session-folders", "session-tags"):
                    return self.respond([])
                if path == "sessions":
                    return self.respond([{"id": "s1", "status": "RUNNING", "title": "Realtime fixture",
                                          "capabilities": {"canSend": True}}])
                if path == "sessions/s1":
                    return self.respond({"id": "s1", "status": "RUNNING"})
                if path == "sessions/s1/events/page":
                    if "after" in query:
                        selected = [row for row in rows if row["seq"] > int(query["after"][0])]
                        limit = int(query.get("limit", [500])[0])
                        return self.respond({"events": selected[:limit], "hasMore": True,
                                             "after": selected[limit - 1]["seq"] if len(selected) > limit else None})
                    return self.respond({"events": rows[-200:], "hasMore": len(rows) > 200})
                if path in ("sessions/s1/approvals", "sessions/s1/turns", "sessions/s1/background"):
                    return self.respond([{"id": "pending-fixture", "status": "PENDING"}] if pending else [])
                if path == "tasks/evidence-decisions/pending":
                    return self.respond({"pending": []})
                fixture.stats["errors"].append("unexpected path: " + path)
                return self.respond({}, 404)

            def stream(self, control, since):
                total = "controlConnections" if control else "sessionConnections"
                active = "activeControl" if control else "activeSession"
                with fixture.condition:
                    fixture.stats[total] += 1
                    fixture.stats[active] += 1
                    generation = fixture.generation
                    offset = len(fixture.control if control else fixture.live)
                    replay = [] if control else [row for row in fixture.rows if row["seq"] > since]
                    if not control:
                        fixture.stats["sinceSeqs"].append(since)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True

                def write(row):
                    self.wfile.write(("data: " + json.dumps(row, ensure_ascii=False) + "\n\n").encode())
                    self.wfile.flush()

                try:
                    write({"type": "ping"})
                    for row in replay:
                        write(row)
                    while True:
                        with fixture.condition:
                            if generation != fixture.generation:
                                break
                            source = fixture.control if control else fixture.live
                            batch = list(source[offset:])
                            offset = len(source)
                        for row in batch:
                            write(row)
                        write({"type": "ping"})
                        with fixture.condition:
                            fixture.condition.wait(0.25)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    with fixture.condition:
                        fixture.stats[active] -= 1

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server
