# The restricted Docker channel (README.md beside this file), as root Compose's docker-channel service
# runs it: Python's standard library and channel.py, nothing else. Build from the repository root:
#   docker build -f deploy/managed-runner/docker-channel/Dockerfile .
FROM python:3.13-alpine
COPY deploy/managed-runner/docker-channel/channel.py /opt/orbit-docker-channel/channel.py
ENTRYPOINT ["python3", "-I", "/opt/orbit-docker-channel/channel.py"]
CMD ["serve", "--config", "/var/lib/orbit-managed-runners/channel.json"]
