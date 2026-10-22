#!/usr/bin/env bash
# Where every piece of the D4 stack runs and what caps it: cgroup, memory.max, CPU and PID limits. Read-only.
set -euo pipefail
W=${D4_DIR:-/mnt/data/tmp/34hJ7RzpqTB13BmLR8uQv}
inst=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["instanceId"])' "$W/mr/channel.json")
cg() { local pid=$1 path; path=$(sed -n 's/^0:://p' "/proc/$pid/cgroup"); echo "cgroup=$path memory.max=$(cat "/sys/fs/cgroup$path/memory.max" 2>/dev/null) pids.max=$(cat "/sys/fs/cgroup$path/pids.max" 2>/dev/null) cpu.max=\"$(cat "/sys/fs/cgroup$path/cpu.max" 2>/dev/null)\""; }
echo "# the Orbit runner service this session runs under"
systemctl show orbit-runner-root.service -p Id -p OOMPolicy -p ControlGroup -p MemoryMax | paste -sd' '
echo "# the stack's processes outside Docker"
for unit in d4-apiserver d4-door; do
  pid=$(systemctl show -p MainPID --value "$unit")
  echo "$unit pid=$pid $(cg "$pid") $(systemctl show "$unit" -p MemoryMax -p MemorySwapMax -p CPUQuotaPerSecUSec | paste -sd' ')"
done
echo "# the stack's containers and every runner container of instance $inst"
for c in d4-pg d4-docker-channel $(docker ps -q --filter "label=orbit.managed-runner.instance=$inst"); do
  pid=$(docker inspect -f '{{.State.Pid}}' "$c")
  docker inspect -f '{{.Name}} memory={{.HostConfig.Memory}} swap={{.HostConfig.MemorySwap}} nanoCpus={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}} user={{.Config.User}} readOnlyRoot={{.HostConfig.ReadonlyRootfs}} privileged={{.HostConfig.Privileged}} capDrop={{.HostConfig.CapDrop}} network={{.HostConfig.NetworkMode}} mounts={{range .Mounts}}{{.Type}}:{{if eq .Type "volume"}}{{.Name}}{{else}}{{.Source}}{{end}}->{{.Destination}}({{if .RW}}rw{{else}}ro{{end}}) {{end}}' "$c"
  echo "    pid=$pid $(cg "$pid")"
done
