#!/usr/bin/env python3
"""Talk to the lab VM's QEMU monitor (QMP) on its unix socket.

  qmp.py SOCKET powerdown       ACPI power button: the guest shuts down cleanly
  qmp.py SOCKET status          run state of the VM
  qmp.py SOCKET balloon-stats   guest memory statistics reported through virtio-balloon
"""

import json
import socket
import sys
import time


class Monitor:
    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(10)
        self.sock.connect(path)
        self.stream = self.sock.makefile("rw")
        self.read()  # greeting
        self.call("qmp_capabilities")

    def read(self):
        while True:
            message = json.loads(self.stream.readline())
            if "event" not in message:
                return message

    def call(self, command, **arguments):
        request = {"execute": command}
        if arguments:
            request["arguments"] = arguments
        self.stream.write(json.dumps(request) + "\n")
        self.stream.flush()
        reply = self.read()
        if "error" in reply:
            raise RuntimeError(f"{command}: {reply['error'].get('desc')}")
        return reply.get("return")


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in ("powerdown", "status", "balloon-stats"):
        sys.exit(__doc__)
    monitor = Monitor(sys.argv[1])
    if sys.argv[2] == "powerdown":
        monitor.call("system_powerdown")
        print("powerdown requested")
    elif sys.argv[2] == "status":
        print(json.dumps(monitor.call("query-status")))
    else:
        path = "/machine/peripheral/balloon0"
        monitor.call("qom-set", path=path, property="guest-stats-polling-interval", value=2)
        time.sleep(3)
        stats = monitor.call("qom-get", path=path, property="guest-stats")
        mib = {name: round(value / 1048576) for name, value in stats["stats"].items()
               if value >= 0 and name in ("stat-total-memory", "stat-free-memory",
                                          "stat-available-memory", "stat-disk-caches")}
        print(json.dumps({"guestMiB": mib, "lastUpdate": stats.get("last-update")}))


if __name__ == "__main__":
    main()
