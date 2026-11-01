snap () 
{ 
    id=$(docker inspect -f '{{.Id}}' orbit-link-c2b-postgres);
    G=/sys/fs/cgroup/system.slice/docker-$id.scope;
    printf '{"label":"%s","at":"%s","currentBytes":%s,"maxBytes":%s,"events":{%s},"stat":{%s}}\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(cat $G/memory.current)" "$(cat $G/memory.max)" "$(awk '{printf "%s\"%s\":%s", (NR>1?",":""), $1, $2}' $G/memory.events)" "$(grep -E '^(anon|file|shmem|active_file|inactive_file|pgscan|pgsteal|workingset_refault_file|pgmajfault) ' $G/memory.stat | awk '{printf "%s\"%s\":%s", (NR>1?",":""), $1, $2}')"
}
