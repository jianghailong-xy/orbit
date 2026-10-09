# TEMPORARY (probe branch, never merged; task 34ckUsDB9IxmvzLjTCxWI). A stand-in control plane for a
# runner under test: /dl/* comes from the directory given, and every /api/* call is answered 200 {}
# (no sessions to reclaim, nothing to claim), so a runner that updated itself stays up afterwards.
# The release question gets 404, as from a control plane older than it: the runner takes the latest.
import http.server
import sys
import time
from functools import partial


class Handler(http.server.SimpleHTTPRequestHandler):
    def _api(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        if self.path.startswith("/api/runner/release"):
            self.send_error(404)
            return
        if self.path.startswith(("/api/runner/wake", "/api/runner/sessions/claim")):
            time.sleep(1)  # a long poll with nothing to say, not a busy loop
        body = b"{}"
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self._api()
        return super().do_GET()

    def do_POST(self):
        return self._api()

    do_PUT = do_POST
    do_PATCH = do_POST
    do_DELETE = do_POST


class Server(http.server.ThreadingHTTPServer):
    # HTTPServer.server_bind looks the host up (getfqdn), which can raise a macOS local-network prompt.
    def server_bind(self):
        self.socket.bind(self.server_address)
        self.server_name, self.server_port = self.server_address[:2]


if __name__ == "__main__":
    directory, port = sys.argv[1], int(sys.argv[2])
    Server(("127.0.0.1", port), partial(Handler, directory=directory)).serve_forever()
