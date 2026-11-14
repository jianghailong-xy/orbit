# The two-host lab of task 34w2jF2t5FFJzkQ15RMyF (channel-host kit). Two docker:dind machines on a private bridge of the
# HPC host, as orbit-prod and 10.66.0.3 are on wg1: the server machine runs the Orbit stack, the channel machine runs the
# channel-host kit and every managed runner. Neither is production or 10.66.0.3. Sourced by every script here.
export K=/mnt/data/tmp/34w2jF
export NET=mrrh-net
export SUBNET=172.31.91.0/24
export SERVER=mrrh-server
export SERVER_IP=172.31.91.10
export CHAN=mrrh-channel
export CHAN_IP=172.31.91.20
export CHAN_PORT=7300
export FAKE_PORT=18089
export LOCK=/mnt/data/tmp/34bc-hpc-heavy.lock
export GATE=/mnt/data/tmp/34pU4gEG3FAw3gYn5ZTtY/bin/gate-then.sh
export DIND_IMAGE=docker:29.8.2-dind
