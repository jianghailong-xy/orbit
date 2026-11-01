#!/usr/bin/env bash
# The kernel's TCP counters in each container's own network namespace (/proc/<pid>/net/netstat, /net/snmp), as one JSON
# line: label, time, and per container the counters that say who reset what (task C2b, coordinator point 5).
label="$1"; P=orbit-link-c2b
line="{\"label\":\"$label\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
for s in $(docker ps --format '{{.Names}}' | sed -n "s/^$P-\(apiserver.*\|gateway\|link-gateway\)$/\1/p" | sort); do
  pid=$(docker inspect -f '{{.State.Pid}}' $P-$s)
  vals=$(sudo -n cat /proc/$pid/net/netstat /proc/$pid/net/snmp 2>/dev/null | python3 -I -c "
import sys, json
L = sys.stdin.read().splitlines(); v = {}
for i in range(0, len(L) - 1, 2):
    h, x = L[i].split(), L[i + 1].split()
    if h[0] == x[0]:
        for k, n in zip(h[1:], x[1:]): v[h[0].rstrip(':') + '.' + k] = int(n)
keys = ['TcpExt.TCPAbortOnClose', 'TcpExt.TCPAbortOnData', 'TcpExt.ListenOverflows', 'TcpExt.ListenDrops', 'Tcp.OutRsts', 'Tcp.EstabResets', 'Tcp.PassiveOpens', 'Tcp.ActiveOpens']
print(json.dumps({k.split('.')[1]: v.get(k) for k in keys}))")
  line+=",\"$s\":{\"started\":\"$(docker inspect -f '{{.State.StartedAt}}' $P-$s)\",\"counters\":$vals}"
done
echo "$line}"
