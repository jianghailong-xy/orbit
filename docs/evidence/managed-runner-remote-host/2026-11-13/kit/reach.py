# Run inside a managed runner's container, as its own user: what it reaches. One line per target, JSON.
# TCP targets: "refused" is the firewall answering (EHOSTUNREACH, "No route to host"); ECONNREFUSED or CONNECTED would
# mean the packet reached that host's stack. HTTPS targets: a real TLS request and its status.
import errno, json, socket, ssl, sys, time, urllib.request

def tcp(label, host, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(5)
    started = time.monotonic()
    try:
        s.connect((host, port))
        result = "CONNECTED"
    except OSError as e:
        result = errno.errorcode.get(e.errno, str(e)) if e.errno else type(e).__name__
    finally:
        s.close()
    print(json.dumps({"target": label, "to": f"{host}:{port}", "result": result, "ms": round((time.monotonic() - started) * 1000)}))

def https(label, url):
    started = time.monotonic()
    try:
        with urllib.request.urlopen(url, timeout=15, context=ssl.create_default_context()) as r:
            result = f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        result = f"HTTP {e.code}"
    except Exception as e:
        result = f"{type(e).__name__}: {e}"
    print(json.dumps({"target": label, "to": url, "result": result, "ms": round((time.monotonic() - started) * 1000)}))

targets = json.loads(sys.argv[1])
for t in targets:
    if t[0] == "tcp":
        tcp(t[1], t[2], t[3])
    else:
        https(t[1], t[2])
