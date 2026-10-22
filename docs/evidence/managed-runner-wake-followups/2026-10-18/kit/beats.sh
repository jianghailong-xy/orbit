#!/usr/bin/env bash
# T06b's sampler of the LAB's test database (orbit-mr-lab-pg, test-server-t06b), not of Orbit itself:
# every 0.5 s, each managed runner mapping's state with when it was entered, its runner's last
# heartbeat as the test server stamped it, and every lab session of that runner with its last claim.
# All three are the test server's own clocks; a heartbeat's stamp outlives the 0.5 s, so no first beat
# is missed while beats are 2 s or more apart. One JSON line per sample; changes are found afterwards.
QUERY='select json_build_object(
  '"'"'at'"'"', clock_timestamp(),
  '"'"'m'"'"', coalesce((select json_agg(json_build_object(
      '"'"'owner'"'"', split_part(u.email, '"'"'@'"'"', 1), '"'"'state'"'"', m.management_state, '"'"'entered'"'"', m.state_entered_at,
      '"'"'gen'"'"', m.generation, '"'"'pod'"'"', left(m.pod_uid::text, 8), '"'"'reason'"'"', m.last_error->>'"'"'code'"'"', '"'"'status'"'"', r.status,
      '"'"'beat'"'"', r.last_heartbeat_at,
      '"'"'claims'"'"', (select json_agg(json_build_object('"'"'s'"'"', left(s.id::text, 8), '"'"'claimed'"'"', s.run_claimed_at, '"'"'st'"'"', s.status) order by s.created_at)
                     from session s where s.assigned_runner_id = m.runner_id)) order by m.created_at)
    from managed_runner m join "user" u on u.id = m.owner_id join runner r on r.id = m.runner_id), '"'"'[]'"'"'::json))'
export QUERY
exec docker exec -e QUERY orbit-mr-lab-pg sh -c 'while true; do psql -U orbit -d orbit -At -c "$QUERY"; sleep 0.5; done'
