#!/bin/bash
. "$(dirname "$0")/env.sh"
cd "$WT/src/apiserver"
exec env -u ORBIT_SESSION_ID -u ORBIT_HOME -u ORBIT_TASK_ID node dist/main.js
