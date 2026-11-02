# The machine scripts/hostd-e2e.sh provisions: Debian 12 with systemd as PID 1 and,
# deliberately, no sudo. Nothing after `orbit host setup` is supposed to need it, so a path
# that still reaches for sudo has to fail here rather than pass quietly on a dev box.
# dbus is the system bus an account's own `systemctl status` reaches systemd over, as on any
# server (docs/self-hosting.md, "Register each account's runner").
FROM debian:bookworm-slim
ENV container=docker
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus \
 && rm -rf /var/lib/apt/lists/* \
 && if command -v sudo; then echo "sudo must not be installed in this image" >&2; exit 1; fi
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
