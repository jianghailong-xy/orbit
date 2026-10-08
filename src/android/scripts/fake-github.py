#!/usr/bin/env python3
"""A stand-in for the parts of GitHub that the Android updater and github-release.py read, for an update
rehearsal: GET /repos/<owner>/<repo>/releases, /repos/<owner>/<repo>/releases/tags/<tag> and release
downloads /<owner>/<repo>/releases/download/<tag>/<name>. Everything comes from a state directory the
rehearsal edits as release.yml would publish (releases.json; files/<tag>/<name>), read on every request.
Every request is appended to requests.jsonl. It listens on 127.0.0.1 only; adb reverse brings it to a device."""
import argparse
import datetime
import http.server
import json
import pathlib
import re
import threading
import urllib.parse

LOCK = threading.Lock()


def handler(state):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - http.server's naming
            status, body = self.route(urllib.parse.urlsplit(self.path).path)
            self.send_response(status)
            self.send_header('Content-Type', 'application/json' if body[:1] in (b'[', b'{') else 'application/octet-stream')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            line = json.dumps(dict(at=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds'),
                                   client=self.client_address[0], target=self.path, status=status, bytes=len(body),
                                   userAgent=self.headers.get('User-Agent', '')))
            with LOCK, open(state / 'requests.jsonl', 'a', encoding='utf-8') as log:
                log.write(line + '\n')

        def route(self, path):
            releases = json.loads((state / 'releases.json').read_text())
            if re.fullmatch(r'/repos/[^/]+/[^/]+/releases', path):
                return 200, json.dumps(releases).encode()
            tagged = re.fullmatch(r'/repos/[^/]+/[^/]+/releases/tags/([^/]+)', path)
            if tagged:
                tag = urllib.parse.unquote(tagged[1])
                found = next((r for r in releases if r['tag_name'] == tag and not r['draft']), None)
                return (200, json.dumps(found).encode()) if found else (404, b'{"message":"Not Found"}')
            download = re.fullmatch(r'/[^/]+/[^/]+/releases/download/([^/]+)/([^/]+)', path)
            if download:
                file = state / 'files' / urllib.parse.unquote(download[1]) / urllib.parse.unquote(download[2])
                if file.is_file():
                    return 200, file.read_bytes()
            return 404, b'{"message":"Not Found"}'

        def log_message(self, *args):
            pass

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, type=pathlib.Path)
    parser.add_argument('--port', required=True, type=int)
    args = parser.parse_args()
    state = args.state.resolve()
    if not (state / 'releases.json').is_file():
        (state / 'releases.json').write_text('[]\n')
    server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), handler(state))
    print(f'fake GitHub on http://127.0.0.1:{args.port} from {state}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
