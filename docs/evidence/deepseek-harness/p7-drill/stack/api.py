#!/usr/bin/env python3
"""Tiny client for the isolated stack (127.0.0.1:2886). api.py METHOD PATH [json-body]"""
import json, sys, urllib.request, urllib.error
BASE = 'http://127.0.0.1:2886/api'
def token():
    return json.load(open('/var/tmp/p7-stack/bootstrap.json'))['accessToken']
def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={'authorization': 'Bearer ' + token(), 'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        return {'httpError': e.code, 'body': e.read().decode()[:800]}
if __name__ == '__main__':
    m, p = sys.argv[1], sys.argv[2]
    b = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None
    print(json.dumps(api(m, p, b), ensure_ascii=False, indent=1))
