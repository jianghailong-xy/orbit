# The machine scripts/install-sh-e2e.sh runs src/web/public/install.sh on: Debian 12 with sudo and
# zsh and two accounts, alice with passwordless sudo and bob with no sudo right at all. There is no
# systemd: install.sh only looks for the runner template's file, which the harness puts in place for
# a machine that is set up. The container's own process is the stub install.sh downloads from,
# python3's http.server on 127.0.0.1:8000, so the containers need no network.
# Not scripts/hostd-e2e's image, which must have no sudo at all.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends sudo zsh curl gzip python3 coreutils \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash alice \
 && useradd -m -s /bin/bash bob \
 && echo 'alice ALL=(ALL) NOPASSWD: ALL' >/etc/sudoers.d/alice \
 && chmod 0440 /etc/sudoers.d/alice \
 && mkdir -p /etc/systemd/system
COPY orbit-stub /opt/install-sh-e2e/orbit-stub
COPY shim/sudo /opt/install-sh-e2e/shim/sudo
# R1: the file alice plants at ~/.orbit/bin/orbit, the agent of hers that keeps it there, and the
# log both write to, whoever runs them.
COPY planted-orbit keep-planted /opt/install-sh-e2e/
# The release the stub serves: orbit-stub gzipped under the name install.sh asks for on this
# machine's architecture, and no other, so a wrong name fails the download.
RUN chmod 0755 /opt/install-sh-e2e/orbit-stub /opt/install-sh-e2e/shim/sudo \
      /opt/install-sh-e2e/planted-orbit /opt/install-sh-e2e/keep-planted \
 && install -m 0666 /dev/null /var/log/install-sh-e2e-sudo.log \
 && install -m 0666 /dev/null /var/log/install-sh-e2e-planted.log \
 && case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) exit 1 ;; esac \
 && mkdir -p /srv/stub/dl \
 && gzip -n -c /opt/install-sh-e2e/orbit-stub >"/srv/stub/dl/orbit-linux-$arch.gz"
CMD ["python3", "-m", "http.server", "8000", "--bind", "127.0.0.1", "--directory", "/srv/stub"]
