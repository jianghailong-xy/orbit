# The real stack of the landing-measured web captures: this worktree's apiserver and web build, a throwaway
# Postgres, and a gateway. Ports are loopback only. Paths derive from this file's location.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export WT="$(cd "$HERE/../../../../.." && pwd)"
export PGPORT_LM=47121 API_PORT=47991 WEB_PORT=47135
export DATABASE_URL="postgresql://postgres:pg@127.0.0.1:${PGPORT_LM}/orbit"
export JWT_SECRET=landing-measured-jwt-0123456789abcdef0123456789
export PROVIDER_SECRET_KEY=landing-measured-provider-key-0123456789abcdef
export PORT=$API_PORT PUBLIC_ORIGIN=http://127.0.0.1:$WEB_PORT CORS_ORIGINS=http://127.0.0.1:$WEB_PORT
export OWNER_EMAIL=owner@orbit.test OWNER_PASSWORD=landing-measured-pass-1
