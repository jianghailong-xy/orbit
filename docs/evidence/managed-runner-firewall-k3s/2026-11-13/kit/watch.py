# Run inside a runner container: connect to each target again and again for SECONDS (every INTERVAL s, each attempt
# with a short timeout), and say how each attempt ended. Every connect that succeeds and every UDP answer is printed with
# its time as it happens; at the end one summary line per target. A refusal is EHOSTUNREACH (the firewall's answer);
# TIMEOUT is no answer at all (the kernel limits how many ICMP errors it sends a host each second); CONNECTED/ANSWERED
# is the runner reaching the target.
import errno, json, socket, sys, time
from collections import Counter

def dns_query():
    labels = b"".join(bytes([len(p)]) + p.encode() for p in "kubernetes.default.svc.cluster.local".split(".")) + b"\0"
    return b"\x57\x41\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00" + labels + b"\x00\x01\x00\x01"

def attempt(kind, host, port, timeout):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM if kind == "tcp" else socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        if kind == "udp":
            s.send(dns_query())
            s.recv(512)
            return "ANSWERED"
        return "CONNECTED"
    except socket.timeout:
        return "TIMEOUT"
    except OSError as e:
        return errno.errorcode.get(e.errno, str(e)) if e.errno else type(e).__name__
    finally:
        s.close()

seconds, interval, targets = float(sys.argv[1]), float(sys.argv[2]), json.loads(sys.argv[3])
counts = {f"{k} {h}:{p}": Counter() for k, h, p in targets}
end = time.time() + seconds
print(json.dumps({"start": time.strftime("%H:%M:%S", time.gmtime()), "seconds": seconds, "every": interval}), flush=True)
while time.time() < end:
    started = time.time()
    for kind, host, port in targets:
        result = attempt(kind, host, port, 0.4)
        counts[f"{kind} {host}:{port}"][result] += 1
        if result in ("CONNECTED", "ANSWERED"):
            print(json.dumps({"at": time.strftime("%H:%M:%S", time.gmtime()), "reached": f"{kind} {host}:{port}"}), flush=True)
    time.sleep(max(0, interval - (time.time() - started)))
reached = 0
for target, counter in counts.items():
    reached += counter["CONNECTED"] + counter["ANSWERED"]
    print(json.dumps({"target": target, "attempts": sum(counter.values()), **dict(sorted(counter.items()))}), flush=True)
print(json.dumps({"end": time.strftime("%H:%M:%S", time.gmtime()), "reached": reached}), flush=True)
sys.exit(1 if reached else 0)
