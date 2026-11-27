# The restricted Docker channel (README.md beside this file), as root Compose's docker-channel service
# runs it. The filesystem tools are used when an operator enables ext4-backed volumes. Build from the repository root:
#   docker build -f deploy/managed-runner/docker-channel/Dockerfile .
FROM python:3.13-alpine
RUN apk add --no-cache e2fsprogs util-linux
COPY deploy/managed-runner/docker-channel/channel.py /opt/orbit-docker-channel/channel.py
ENTRYPOINT ["python3", "-I", "/opt/orbit-docker-channel/channel.py"]
CMD ["serve", "--config", "/var/lib/orbit-cloud-runners/channel.json"]
