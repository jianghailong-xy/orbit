#!/usr/bin/env python3
"""TLS-intercepting recorder for agy's outbound HTTPS (scratch). Answers every request itself; never forwards."""
import socket, ssl, threading, sys, json, gzip, time, os, base64
D = os.path.dirname(os.path.abspath(__file__))
port = int(sys.argv[1]); logp = sys.argv[2]
lock = threading.Lock()
def log(e):
    with lock:
        open(logp, 'a').write(json.dumps(e) + '\n')
def read_http(f):
    line = f.readline()
    if not line: return None
    method, path, _ = line.decode('latin1').split(' ', 2)
    headers = {}
    while True:
        h = f.readline().decode('latin1')
        if h in ('\r\n', '\n', ''): break
        k, v = h.split(':', 1); headers[k.strip().lower()] = v.strip()
    body = b''
    if 'content-length' in headers:
        body = f.read(int(headers['content-length']))
    elif headers.get('transfer-encoding', '').lower() == 'chunked':
        while True:
            n = int(f.readline().strip(), 16)
            if n == 0: f.readline(); break
            body += f.read(n); f.readline()
    return method, path, headers, body
def handle(c):
    try:
        f = c.makefile('rb')
        first = read_http(f)
        if not first: return
        method, target, headers, _ = first
        if method != 'CONNECT':
            log({'t': time.time(), 'plain': method + ' ' + target}); c.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return
        host = target.split(':')[0]
        if not os.path.exists(os.path.join(D, host + '.pem')):
            log({'t': time.time(), 'connect_refused': target}); c.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return
        c.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(os.path.join(D, host + '.pem'), os.path.join(D, host + '.key'))
        ctx.set_alpn_protocols(['http/1.1'])
        s = ctx.wrap_socket(c, server_side=True)
        sf = s.makefile('rb')
        while True:
            req = read_http(sf)
            if not req: break
            m, p, h, b = req
            raw = b
            if h.get('content-encoding') == 'gzip':
                try: raw = gzip.decompress(b)
                except Exception: pass
            log({'t': time.time(), 'host': host, 'method': m, 'path': p, 'headers': h, 'len': len(b), 'body_b64': base64.b64encode(raw).decode()})
            resp = b'{}' if 'unleash' not in host else b'{"version":1,"features":[]}'
            s.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s' % (len(resp), resp))
    except Exception as ex:
        log({'t': time.time(), 'error': repr(ex)})
    finally:
        try: c.close()
        except Exception: pass
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('127.0.0.1', port)); srv.listen(64)
while True:
    c, _ = srv.accept(); threading.Thread(target=handle, args=(c,), daemon=True).start()
