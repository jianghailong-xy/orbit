#!/bin/bash
# Wait (up to $1 seconds) until the test host's dockerd answers and the deployment's API is up.
end=$((SECONDS + ${1:-300}))
until docker exec d5-dind docker info >/dev/null 2>&1 && curl -fsS -o /dev/null http://127.0.0.1:14086/api/auth/setup-status; do
  [ $SECONDS -lt $end ] || { echo "not up after $1 s"; exit 1; }
  sleep 3
done
echo "up after $SECONDS s"
