# The k3s lab of task 34wdoShyYD41lQoGgRxPv: one docker:dind machine on a private bridge of the HPC host running Docker
# and single-node k3s v1.37.2+k3s1 together (flannel, kube-router network policy, kube-proxy in iptables mode: k3s'
# defaults), as 10.66.0.3 does, with the channel-host kit installed. Not production, not 10.66.0.3. Sourced by every
# script here.
export K=/mnt/data/tmp/34wdoS
export NET=mrk3s-net
export SUBNET=172.31.92.0/24
export M=mrk3s
export M_IP=172.31.92.20
export PEER_IP=172.31.92.10
export LOCK=/mnt/data/tmp/34bc-hpc-heavy.lock
export GATE=/mnt/data/tmp/34pU4gEG3FAw3gYn5ZTtY/bin/gate-then.sh
export DIND_IMAGE=docker:29.8.2-dind
export KUBECONFIG_IN=/etc/rancher/k3s/k3s.yaml
