# Run inside a managed runner's container (tcp, udp: a DNS question, https), as its own user: what it reaches. One line per target, JSON.
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

def dns_query(name):
    """A DNS question for NAME's A record, as bytes."""
    labels = b"".join(bytes([len(part)]) + part.encode() for part in name.split(".")) + b"\0"
    return b"\x4f\x52\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00" + labels + b"\x00\x01\x00\x01"

def udp(label, host, port, timeout=3):
    """A DNS question over UDP on a connected socket, so an ICMP error comes back as an errno: ANSWERED (any reply),
    TIMEOUT, or the errno's name."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    started = time.monotonic()
    try:
        s.connect((host, port))
        s.send(dns_query("kubernetes.default.svc.cluster.local"))
        s.recv(512)
        result = "ANSWERED"
    except socket.timeout:
        result = "TIMEOUT"
    except OSError as e:
        result = errno.errorcode.get(e.errno, str(e)) if e.errno else type(e).__name__
    finally:
        s.close()
    print(json.dumps({"target": label, "to": f"udp {host}:{port}", "result": result, "ms": round((time.monotonic() - started) * 1000)}))

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
    elif t[0] == "udp":
        udp(t[1], t[2], t[3])
    else:
        https(t[1], t[2])
