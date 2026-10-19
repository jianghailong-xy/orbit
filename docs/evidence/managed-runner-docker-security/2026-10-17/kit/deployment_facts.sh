#!/bin/sh
# D5 (task 34hJ7S9C3isVnzIDDfSHD): the facts of a default Compose deployment's managed runner wiring that its
# security rests on, read inside its Docker host (here the d5-dind test host):
#   docker exec -i d5-dind sh -s < deployment_facts.sh
# Prints no secret: the token and .env values are described by mode and size, never shown.
cd /work/orbit || exit 1
MR=data/managed-runners
echo "== deployment facts at $(date -u +%FT%TZ), checkout $(git rev-parse HEAD)"
echo "-- .env (mode $(stat -c %a .env)): the managed runner lines"
grep -E '^(ORBIT_MANAGED_RUNNERS_[A-Z_]*|COMPOSE_PROFILES)=' .env
echo "-- $MR: owner, mode, size"
stat -c '%A %U:%G %s %n' "$MR" "$MR"/* "$MR"/state "$MR"/state/* 2>/dev/null
echo "-- $MR/channel.json"; cat "$MR/channel.json"
echo "-- $MR/profile.json"; cat "$MR/profile.json"
echo "-- the managed runners' network"
docker network inspect orbit-managed-runners --format 'name={{.Name}} driver={{.Driver}} internal={{.Internal}} enable_icc={{index .Options "com.docker.network.bridge.enable_icc"}} subnet={{range .IPAM.Config}}{{.Subnet}} gateway={{.Gateway}} {{end}}'
gateway=$(docker network inspect orbit-managed-runners --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}' | tr ' ' '\n' | grep -m1 '\.')
server=$(sed -n 's/.*"serverUrl": *"\([^"]*\)".*/\1/p' "$MR/profile.json")
echo "runner.serverUrl=$server; the network's IPv4 gateway=$gateway; serverUrl names that gateway: $( [ "$server" = "http://$gateway:2086" ] && echo yes || echo NO)"
echo "-- who publishes what on this host"
docker ps --format '{{.Names}}\t{{.Ports}}' | sort
echo "-- which containers are given a Docker socket (any mount whose source ends in docker.sock)"
for c in $(docker ps -aq); do
  docker inspect "$c" --format '{{.Name}} {{range .Mounts}}{{if or (eq .Source "/var/run/docker.sock") (eq .Source "/run/docker.sock")}}DOCKER-SOCKET:{{.Source}}->{{.Destination}} {{end}}{{end}}'
done | sort
echo "-- docker-channel: how it runs"
docker inspect orbit-docker-channel --format 'network={{.HostConfig.NetworkMode}} user="{{.Config.User}}" privileged={{.HostConfig.Privileged}} capAdd={{.HostConfig.CapAdd}} readonlyRootfs={{.HostConfig.ReadonlyRootfs}} ports={{json .HostConfig.PortBindings}} exposed={{json .Config.ExposedPorts}} restart={{.HostConfig.RestartPolicy.Name}}'
docker inspect orbit-docker-channel --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}} rw={{.RW}}{{println}}{{end}}'
echo "-- docker-channel: its network namespace (interfaces, listening TCP/UDP sockets, listening unix sockets)"
docker exec orbit-docker-channel sh -c 'ls /sys/class/net; echo "tcp listeners:"; awk "FNR>1 && \$4==\"0A\"" /proc/net/tcp /proc/net/tcp6; echo "udp sockets:"; awk "FNR>1" /proc/net/udp /proc/net/udp6; echo "listening unix sockets:"; awk "FNR>1 && \$6==\"01\" && \$4==\"00010000\" {print \$8}" /proc/net/unix'
echo "-- docker-channel: processes"
docker exec orbit-docker-channel ps -o pid,user,args
echo "-- apiserver: how it reaches the channel"
docker inspect orbit-apiserver --format 'user="{{.Config.User}}" networks={{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'
docker inspect orbit-apiserver --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}} rw={{.RW}}{{println}}{{end}}'
docker inspect orbit-apiserver --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^ORBIT_MANAGED'
echo "-- this test host's own dockerd (an artifact of the Docker-in-Docker host, not of the deployment)"
tr '\0' ' ' < /proc/1/cmdline | sed 's/--tlskey [^ ]*/--tlskey <path>/'; echo
