# The managed runners' host firewall (README.md beside this file), as root Compose's managed-runner-firewall service
# runs it: Python's standard library, the iptables binaries of both backends (nft and legacy), iproute2's ip (the routing
# rule of a host that runs Kubernetes too) and firewall.py, nothing else. Build from the repository root:
#   docker build -f deploy/managed-runner/firewall/Dockerfile .
FROM python:3.13-alpine
RUN apk add --no-cache iptables iptables-legacy iproute2
COPY deploy/managed-runner/firewall/firewall.py /opt/orbit-managed-runner-firewall/firewall.py
ENTRYPOINT ["python3", "-I", "/opt/orbit-managed-runner-firewall/firewall.py"]
CMD ["serve"]
