#!/usr/bin/env bash
# Both of the lab's heavy builds in one hold of the shared lock: the server's images on the HPC host, then the channel
# machine's real kit install (its runner image build).
set -uo pipefail
L=/mnt/data/tmp/34w2jF/logs
/mnt/data/tmp/34w2jF/kit/build-server-images.sh 18a0285c6 > $L/build-server-images.txt 2>&1; echo "server images: exit $?"
docker exec -w /work/orbit mrrh-channel deploy/managed-runner/remote-host/remote-host.sh install --listen 172.31.91.20 --allow-peer 172.31.91.10 --instance orbit-lab-chan > $L/kit-install.txt 2>&1; echo "kit install: exit $?"
