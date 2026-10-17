#!/bin/bash
set -a; . /var/tmp/p7-stack/secrets.env; set +a
for v in $(env | cut -d= -f1 | grep -E '^(ORBIT_|CLAUDE|ANTHROPIC_)'); do unset "$v"; done
export DATABASE_URL=postgresql://orbit:orbit@127.0.0.1:5986/orbit PORT=3886
export PUBLIC_ORIGIN=http://127.0.0.1:2886 CORS_ORIGINS=http://127.0.0.1:2886
cd /var/tmp/p7-stack/src && exec node src/apiserver/dist/main.js
