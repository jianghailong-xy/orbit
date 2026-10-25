#!/usr/bin/env bash
# pw.sh CTLPORT 'code' — run code against the emulator page (see emu-server.mjs).
curl -s --max-time 300 -X POST --data-binary "$2" "http://127.0.0.1:$1/pw"; echo
