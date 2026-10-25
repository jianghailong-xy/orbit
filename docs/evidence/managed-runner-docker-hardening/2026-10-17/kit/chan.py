#!/usr/bin/env python3
"""One request to the test deployment's Docker channel, as the holder of its token, inside the D8 test host:
    python3 chan.py METHOD PATH [JSON body]
The token is read from the deployment's own file and never printed; a credential in an answer is printed as its
length only. Prints one JSON line: the request, the status and the body.
"""
import http.client
import json
import socket
import sys

DIR = "/work/orbit/data/managed-runners"


class Unix(http.client.HTTPConnection):
    def __init__(self):
        super().__init__("localhost", timeout=300)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(f"{DIR}/channel.sock")


def redact(value):
    if isinstance(value, dict):
        return {k: (f"<{len(v)} characters>" if k == "token" and isinstance(v, str) else redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


token = open(f"{DIR}/token").read().strip()
method, path = sys.argv[1], sys.argv[2]
body = sys.argv[3].encode() if len(sys.argv) > 3 else None
headers = {"Authorization": f"Bearer {token}"}
if body is not None:
    headers["Content-Type"] = "application/json"
connection = Unix()
connection.request(method, path, body=body, headers=headers)
response = connection.getresponse()
data = response.read()
try:
    answer = json.loads(data) if data else None
except ValueError:
    answer = data.decode("utf-8", "replace")
sent = redact(json.loads(body)) if body else None
print(json.dumps({"request": f"{method} {path}", "sent": sent, "status": response.status, "body": redact(answer)}, sort_keys=True))
