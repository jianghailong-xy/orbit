# The multi-host lab of task 34w2jFbstazPkmD2XCDCe: three docker:dind machines on a private bridge of the HPC host, as
# orbit-prod and its channel hosts are on wg1. The server machine runs the Orbit stack; channel machines A and B each run
# the channel-host kit and their own managed runners. None is production or 10.66.0.3. Sourced by every script here.
export K=/mnt/data/tmp/34w2jFb
export NET=mrmh-net
export SUBNET=172.31.92.0/24
export SERVER=mrmh-server
export SERVER_IP=172.31.92.10
export CHAN_A=mrmh-chan-a CHAN_A_IP=172.31.92.20 INST_A=orbit-lab-a
export CHAN_B=mrmh-chan-b CHAN_B_IP=172.31.92.30 INST_B=orbit-lab-b
export CHAN_PORT=7300
export FAKE_PORT=18089
export LOCK=/mnt/data/tmp/34bc-hpc-heavy.lock
export GATE=/mnt/data/tmp/34pU4gEG3FAw3gYn5ZTtY/bin/gate-then.sh
export DIND_IMAGE=docker:29.8.2-dind
