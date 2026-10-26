#!/usr/bin/env python3
"""Persistent A10 controlled authority for separate instrumentation processes; never FCM.

Inherits the fixed A08 session/card HTTP fixture without editing it. Adds only the
Android push registration contract and canonical directory reminder count.
--bundle-id io.orbitd.android serves the release-package FCM check; tokens are kept
only as a SHA-256 prefix, a length and whether they have the FCM shape.
"""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import re
import sys
import uuid
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse

source = pathlib.Path(__file__).with_name('cards-fixture.py')
spec = importlib.util.spec_from_file_location('a10_cards_fixture', source)
cards = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cards)
original_snapshot = cards.snapshot


def snapshot():
    value = original_snapshot()
    value['detail']['pendingApprovals'] = len(value['approvals'])
    value['detail']['ownerItems'] = value['standing']['openItems']['needsYou']
    return value


cards.snapshot = snapshot
BUNDLE_ID = 'io.orbitd.android.debug'


def reset():
    with cards.LOCK:
        cards.state.clear()
        cards.state.update(case='a1', pending=True, denied=False, mode='', assignment=None,
                           journal=[], final=None, push={'registerCount': 0, 'unregisterCount': 0})


reset()


class Handler(cards.Handler):
    def log_request(self, code='-', size='-'):
        # Method, path and status only: no header or body reaches the log.
        sys.stderr.write(f'{datetime.now(timezone.utc).isoformat(timespec="milliseconds")} {self.command} {urlparse(self.path).path} {code}\n')

    def do_POST(self):
        path = urlparse(self.path).path
        if path == '/__push_reset':
            self.rfile.read(int(self.headers.get('Content-Length', 0)))
            reset()
            return self.reply({'ok': True})
        if path not in ('/api/push/register', '/api/push/unregister'):
            return super().do_POST()
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        if self.headers.get('Authorization') != 'Bearer a08-fixture-access':
            return self.reply({}, 401)
        with cards.LOCK:
            push = cards.state['push']
            if path.endswith('/register'):
                if (body.get('platform') != 'android' or body.get('environment') != 'production'
                        or body.get('bundleId') != BUNDLE_ID or not body.get('token')):
                    return self.reply({'message': 'Invalid Android registration'}, 400)
                try:
                    if uuid.UUID(body['installationId']).version != 4:
                        raise ValueError()
                except (KeyError, ValueError, AttributeError):
                    return self.reply({'message': 'Invalid installation'}, 400)
                push.update(installationId=body['installationId'], bundleId=body['bundleId'],
                            platform='android', environment='production', registrationKey=str(uuid.uuid4()))
                push['registerCount'] += 1
                token = body['token']
                push.setdefault('tokens', []).append(dict(
                    sha256=hashlib.sha256(token.encode()).hexdigest()[:16], length=len(token),
                    fcmShape=re.fullmatch(r'[A-Za-z0-9_-]+:APA91b[A-Za-z0-9_-]+', token) is not None))
                return self.reply({'ok': True, 'registrationKey': push['registrationKey']})
            push['unregisterCount'] += 1
            if body.get('registrationKey') == push.get('registrationKey'):
                push.pop('registrationKey', None)
            return self.reply({'ok': True})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=18770)
    parser.add_argument('--bundle-id', default=BUNDLE_ID)
    args = parser.parse_args()
    BUNDLE_ID = args.bundle_id
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
