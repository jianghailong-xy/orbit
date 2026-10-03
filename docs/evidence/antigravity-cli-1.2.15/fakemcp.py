#!/usr/bin/env python3
"""Minimal stdio MCP server for agy experiments: records its environment and every call."""
import json, os, sys, time
name = sys.argv[1] if len(sys.argv) > 1 else 'fake'
log = open(f'/var/tmp/agy-c0/fakemcp-{name}.log', 'a')
def w(o): log.write(json.dumps(o) + '\n'); log.flush()
w({'event': 'start', 'pid': os.getpid(), 'cwd': os.getcwd(), 'ORBIT_SESSION_ID': os.environ.get('ORBIT_SESSION_ID'), 'HOME': os.environ.get('HOME'), 'argv': sys.argv, 'env_keys': sorted(k for k in os.environ if k.startswith(('ORBIT', 'GEMINI', 'ANTIGRAVITY', 'AGY')))})
for line in sys.stdin:
    try: msg = json.loads(line)
    except Exception: continue
    w({'event': 'recv', 'msg': msg})
    mid = msg.get('id'); m = msg.get('method')
    if mid is None: continue
    if m == 'initialize':
        res = {'protocolVersion': msg['params'].get('protocolVersion', '2025-06-18'), 'capabilities': {'tools': {}}, 'serverInfo': {'name': name, 'version': '0.0.1'}}
    elif m == 'tools/list':
        res = {'tools': [{'name': 'whoami', 'description': 'Report the session id this MCP server sees', 'inputSchema': {'type': 'object', 'properties': {'note': {'type': 'string'}}}}]}
    elif m == 'tools/call':
        a = msg['params'].get('arguments') or {}
        res = {'content': [{'type': 'text', 'text': f"session={os.environ.get('ORBIT_SESSION_ID')} note={a.get('note')}"}]}
    else:
        sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32601, 'message': 'no such method'}}) + '\n'); sys.stdout.flush(); continue
    sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': mid, 'result': res}) + '\n'); sys.stdout.flush()
