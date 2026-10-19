#!/bin/bash
# Inside the D9 test host, after every start of it: what a deployer's host has around a deployment.
#   host-fixtures.sh <fake-model.py>
#  - Services of the host itself, as sshd and rpcbind are on the HPC host: TCP listeners on every address (2222), on
#    loopback only (2223), on the host's own eth0 address only (2224) and on IPv6's every address (2225), and a UDP
#    echo on every address (2226). They accept and close; nothing is served.
#  - "lan", a network namespace behind the host (10.77.0.0/24 on a veth pair, the host at 10.77.0.1), standing for the
#    deployer's private network: an internal model endpoint at 10.77.0.2:18080, scripts/managed-runner/lab/fake-model.py
#    behind a TCP relay (it listens on its loopback only). Its requests go to /evidence/fake-model.jsonl.
set -euo pipefail
FAKE_MODEL="$1"
pkill -f d9-host-listeners 2>/dev/null || true
ETH0="$(ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1)"
nohup python3 - d9-host-listeners "$ETH0" >/evidence/host-listeners.log 2>&1 <<'PY' &
import socket, sys, threading, time
eth0 = sys.argv[2]
def tcp(family, host, port, v6only=False):
    s = socket.socket(family, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if v6only:
        s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    s.bind((host, port)); s.listen(64)
    while True:
        conn, peer = s.accept(); print(time.strftime("%FT%TZ", time.gmtime()), "tcp", host, port, "from", peer[0], flush=True); conn.close()
def udp():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("0.0.0.0", 2226))
    while True:
        data, peer = s.recvfrom(512); print(time.strftime("%FT%TZ", time.gmtime()), "udp 2226 from", peer[0], flush=True); s.sendto(data, peer)
for args in ((socket.AF_INET, "0.0.0.0", 2222), (socket.AF_INET, "127.0.0.1", 2223), (socket.AF_INET, eth0, 2224),
             (socket.AF_INET6, "::", 2225, True)):
    threading.Thread(target=tcp, args=args, daemon=True).start()
threading.Thread(target=udp, daemon=True).start()
while True:
    time.sleep(3600)
PY
if ! ip netns list | grep -qw lan; then
  ip netns add lan
  ip link add veth-lan type veth peer name veth-lan-ns
  ip link set veth-lan-ns netns lan
  ip addr add 10.77.0.1/24 dev veth-lan
  ip link set veth-lan up
  ip netns exec lan ip addr add 10.77.0.2/24 dev veth-lan-ns
  ip netns exec lan ip link set veth-lan-ns up
  ip netns exec lan ip link set lo up
fi
pkill -f 'fake-model.py 18081' 2>/dev/null || true
pkill -f 'TCP-LISTEN:18080' 2>/dev/null || true
nohup ip netns exec lan python3 "$FAKE_MODEL" 18081 /evidence/fake-model.jsonl >/evidence/fake-model.log 2>&1 &
nohup ip netns exec lan socat TCP-LISTEN:18080,bind=10.77.0.2,fork,reuseaddr TCP:127.0.0.1:18081 >/evidence/fake-model-relay.log 2>&1 &
sleep 1
echo "host listeners on 0.0.0.0:2222, 127.0.0.1:2223, $ETH0:2224, [::]:2225, udp 0.0.0.0:2226; internal model endpoint 10.77.0.2:18080"
