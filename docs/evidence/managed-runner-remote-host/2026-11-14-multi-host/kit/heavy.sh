#!/usr/bin/env bash
# The lab's heavy builds in one hold of the shared lock: the server's images on the HPC host, then each channel
# machine's real kit install (its runner image build).
set -uo pipefail
source /mnt/data/tmp/34w2jFb/kit/env.sh
SHA=$1
L=$K/logs
echo "==> $(date -Is) lock held"
$K/kit/build-server-images.sh $SHA > $L/build-server-images.txt 2>&1; echo "server images: exit $?"
docker exec -w /work/orbit $CHAN_A deploy/managed-runner/remote-host/remote-host.sh install --listen $CHAN_A_IP --allow-peer $SERVER_IP --instance $INST_A > $L/kit-install-a.txt 2>&1; echo "kit install A: exit $?"
docker exec -w /work/orbit $CHAN_B deploy/managed-runner/remote-host/remote-host.sh install --listen $CHAN_B_IP --allow-peer $SERVER_IP --instance $INST_B > $L/kit-install-b.txt 2>&1; echo "kit install B: exit $?"
echo "==> $(date -Is) heavy done"
